import type { ComponentId, PlannerConfig } from "../model/types";
import { effectiveReplication, isMultiRegion, regionInfo, secondRegion } from "../model/regions";
import { azureStorageAccount, bucketName, designComponents, keyVaultName, namePrefix, NS, STORES, type CentralCluster, type GeneratedFile } from "./common";
import { recommendNodePools } from "./nodepools";

// Terraform for the cloud resources around the clusters: object storage, pod identities,
// secret store, optional central cluster and managed databases. One root module per central cluster.

const PROVIDERS = {
  azure: `    azurerm = {\n      source  = "hashicorp/azurerm"\n      version = "~> 4.0"\n    }`,
  aws: `    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 6.0"\n    }`,
  gcp: `    google = {\n      source  = "hashicorp/google"\n      version = "~> 7.0"\n    }`,
};

/** Components that read/write object storage, and the Kubernetes service account they use. */
function storageUsers(cfg: PlannerConfig): { id: ComponentId; stores: string[]; namespace: string; sa: string }[] {
  return designComponents(cfg)
    .filter((c) => STORES[c.id] && !(c.id === "langfuse" && cfg.components.langfuse.options.objectStorage === "bundled"))
    .map((c) => ({ id: c.id, stores: STORES[c.id]!, namespace: NS, sa: c.id }));
}

const hcl = (s: string) => s.replace(/^\n/, "");

const slug = (dir: string) => dir.replace(/\//g, "-");

/** The primary-region cluster of a standby cluster (same environment). */
function primaryOf(central: CentralCluster[], c: CentralCluster): CentralCluster {
  return central.find((x) => x.role === "active" && x.env === c.env) ?? central[0];
}

/** Longest retention of the stored signals, + 7 days margin (used for replica lifecycle rules). */
function maxRetentionDays(cfg: PlannerConfig): number {
  const r = Object.values(cfg.volumes).flatMap((v) => [v.retentionDays.metrics, v.retentionDays.logs, v.retentionDays.traces, v.retentionDays.profiles]);
  return Math.max(...r) + 7;
}

const standbyModel = (cfg: PlannerConfig) => isMultiRegion(cfg) && cfg.multiRegion.model === "standby";

// ------------------------------------------------------------------ Azure
function azureStorage(cfg: PlannerConfig, c: CentralCluster, central: CentralCluster[], containers: string[]): string {
  const env = c.env;
  const method = effectiveReplication(cfg);
  const zrs = cfg.topology.zones > 1;
  const containerList = containers.map((x) => `"${x}"`).join(", ");
  if (c.role === "standby") {
    const primary = primaryOf(central, c);
    const name = azureStorageAccount(c.cfg, env);
    return `# STANDBY: no storage of its own. It reads the ${method === "geo" ? "geo-replicated account (after an account failover it is writable in this region)" : "replica account, filled by object replication from the primary region"}.
data "azurerm_storage_account" "obs" {
  name                = "${name}"
  resource_group_name = "rg-\${var.name_prefix}-${slug(primary.dir)}"
}

locals {
  storage_id = data.azurerm_storage_account.obs.id
}`;
  }
  const replicate = standbyModel(cfg);
  const second = replicate ? secondRegion(cfg)! : "";
  const replica = replicate && method === "object" ? azureStorageAccount(c.cfg, env, second) : "";
  return `# Object storage: one storage account per environment, one container per data type.
resource "azurerm_storage_account" "obs" {
  name                     = "${azureStorageAccount(c.cfg, env)}"
  resource_group_name      = azurerm_resource_group.obs.name
  location                 = azurerm_resource_group.obs.location
  account_tier             = "Standard"
  account_replication_type = "${replicate && method === "geo" ? (zrs ? "RAGZRS" : "RAGRS") : zrs ? "ZRS" : "LRS"}"${replicate && method === "geo" ? " # geo-replicated to the paired region " + second : ""}
  min_tls_version          = "TLS1_2"
  allow_nested_items_to_be_public = false
${
  replica
    ? `
  # Object replication needs versioning and the change feed on the source account.
  blob_properties {
    versioning_enabled  = true
    change_feed_enabled = true
  }
`
    : ""
}}

resource "azurerm_storage_container" "obs" {
  for_each           = toset([${containerList}])
  name               = each.value
  storage_account_id = azurerm_storage_account.obs.id
}

locals {
  storage_id = azurerm_storage_account.obs.id
}
${
  replica
    ? `
# STANDBY REGION (${second}): replica account, filled by object replication.
resource "azurerm_storage_account" "replica" {
  name                     = "${replica}"
  resource_group_name      = azurerm_resource_group.obs.name
  location                 = "${second}"
  account_tier             = "Standard"
  account_replication_type = "${zrs ? "ZRS" : "LRS"}"
  min_tls_version          = "TLS1_2"
  allow_nested_items_to_be_public = false

  blob_properties {
    versioning_enabled = true
  }
}

resource "azurerm_storage_container" "replica" {
  for_each           = toset([${containerList}])
  name               = each.value
  storage_account_id = azurerm_storage_account.replica.id
}

resource "azurerm_storage_object_replication" "standby" {
  source_storage_account_id      = azurerm_storage_account.obs.id
  destination_storage_account_id = azurerm_storage_account.replica.id

  dynamic "rules" {
    for_each = toset([${containerList}])
    content {
      source_container_name      = rules.value
      destination_container_name = rules.value
      copy_blobs_created_after   = "OnlyNewObjects"
    }
  }

  depends_on = [azurerm_storage_container.obs, azurerm_storage_container.replica]
}

# Object replication doesn't copy deletions (compaction, retention): expire old blobs on the replica.
resource "azurerm_storage_management_policy" "replica" {
  storage_account_id = azurerm_storage_account.replica.id
  rule {
    name    = "expire-after-retention"
    enabled = true
    filters {
      blob_types = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = ${maxRetentionDays(cfg)}
      }
      version {
        delete_after_days_since_creation = 7
      }
    }
  }
}
`
    : ""
}`;
}

function azure(cfg: PlannerConfig, c: CentralCluster, central: CentralCluster[]): GeneratedFile[] {
  const env = c.env;
  const users = storageUsers(cfg);
  const pools = recommendNodePools(c);
  const zones = Array.from({ length: cfg.topology.zones }, (_, i) => `"${i + 1}"`).join(", ");
  const create = cfg.topology.createCentralCluster;
  const containers = users.flatMap((u) => u.stores);
  const needsDb = cfg.components.grafana.enabled && cfg.components.grafana.options.ha === "ha";
  const needsLfDb = cfg.components.langfuse.enabled && cfg.components.langfuse.options.postgres === "managed";
  const dir = `terraform/${c.name}`;

  const main = hcl(`
resource "azurerm_resource_group" "obs" {
  name     = "rg-\${var.name_prefix}-${slug(c.dir)}"
  location = var.location
}

${
  create
    ? `# Central AKS cluster with OIDC issuer + Workload Identity, node pools sized by the planner.
resource "azurerm_kubernetes_cluster" "central" {
  name                      = "${c.name}"
  location                  = azurerm_resource_group.obs.location
  resource_group_name       = azurerm_resource_group.obs.name
  dns_prefix                = "${c.name}"
  sku_tier                  = "Standard"
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  default_node_pool {
    name                         = "system"
    vm_size                      = "${pools[0].vm.name}"
    node_count                   = ${pools[0].nodes}
    zones                        = [${zones}]
    only_critical_addons_enabled = true
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "observability" {
  name                  = "obs"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.central.id
  vm_size               = "${pools[1].vm.name}"
  node_count            = ${pools[1].nodes}
  zones                 = [${zones}]
}

locals {
  oidc_issuer_url = azurerm_kubernetes_cluster.central.oidc_issuer_url
}`
    : `# Existing cluster: pass its OIDC issuer URL (az aks show --query oidcIssuerProfile.issuerUrl).
locals {
  oidc_issuer_url = var.oidc_issuer_url
}`
}

${azureStorage(cfg, c, central, containers)}

# One user-assigned identity per component, federated with its Kubernetes service account.
module "identity" {
  source   = "../modules/azure-workload-identity"
  for_each = toset([${users.map((u) => `"${u.sa}"`).join(", ")}])

  name                = "id-\${var.name_prefix}-${slug(c.dir)}-\${each.value}"
  resource_group_name = azurerm_resource_group.obs.name
  location            = azurerm_resource_group.obs.location
  oidc_issuer_url     = local.oidc_issuer_url
  subject             = "system:serviceaccount:${NS}:\${each.value}"
  role_scope          = local.storage_id
  role                = "Storage Blob Data Contributor"
}

# Secret store: Key Vault (RBAC) read by External Secrets / CSI through workload identity.
resource "azurerm_key_vault" "obs" {
  name                       = "${keyVaultName(c.cfg, env)}"
  location                   = azurerm_resource_group.obs.location
  resource_group_name        = azurerm_resource_group.obs.name
  tenant_id                  = var.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
}

module "secrets_identity" {
  source              = "../modules/azure-workload-identity"
  name                = "id-\${var.name_prefix}-${slug(c.dir)}-secrets"
  resource_group_name = azurerm_resource_group.obs.name
  location            = azurerm_resource_group.obs.location
  oidc_issuer_url     = local.oidc_issuer_url
  subject             = "${cfg.connectivity.secrets === "eso" ? "system:serviceaccount:external-secrets:external-secrets" : `system:serviceaccount:${NS}:default`}"
  role_scope          = azurerm_key_vault.obs.id
  role                = "Key Vault Secrets User"
}
${
  needsDb || needsLfDb
    ? `
# Managed PostgreSQL for ${[needsDb ? "Grafana (HA)" : "", needsLfDb ? "Langfuse" : ""].filter(Boolean).join(" and ")}.
resource "azurerm_postgresql_flexible_server" "obs" {
  name                          = "psql-\${var.name_prefix}-${env}"
  resource_group_name           = azurerm_resource_group.obs.name
  location                      = azurerm_resource_group.obs.location
  version                       = "17"
  sku_name                      = "${cfg.components.langfuse.options.postgresTier === "general" ? "GP_Standard_D2ds_v5" : "B_Standard_B2s"}"
  storage_mb                    = 32768
  administrator_login           = "obsadmin"
  administrator_password        = var.postgres_admin_password
  public_network_access_enabled = false
  zone                          = "1"
${cfg.components.langfuse.options.postgresHa ? `  high_availability {\n    mode                      = "ZoneRedundant"\n    standby_availability_zone = "2"\n  }\n` : ""}}
`
    : ""
}`);

  const variables = hcl(`
variable "name_prefix" {
  type    = string
  default = "${namePrefix(cfg)}"
}

variable "location" {
  type    = string
  default = "${cfg.platform.region}"
}

variable "tenant_id" {
  type        = string
  description = "Microsoft Entra tenant ID"
}
${create ? "" : `\nvariable "oidc_issuer_url" {\n  type        = string\n  description = "OIDC issuer URL of the existing central AKS cluster"\n}\n`}${needsDb || needsLfDb ? `\nvariable "postgres_admin_password" {\n  type      = string\n  sensitive = true\n}\n` : ""}`);

  const outputs = users.map((u) => `output "${u.sa.replace(/-/g, "_")}_client_id" {\n  description = "Put into helm/central/${env}/${u.id}/values.yaml (serviceAccount annotation)"\n  value       = module.identity["${u.sa}"].client_id\n}\n`).join("\n") + `\noutput "secrets_client_id" {\n  value = module.secrets_identity.client_id\n}\n`;

  return [
    { path: `${dir}/versions.tf`, content: `terraform {\n  required_version = ">= 1.10"\n  required_providers {\n${PROVIDERS.azure}\n  }\n  backend "azurerm" {}\n}\n\nprovider "azurerm" {\n  features {}\n}\n` },
    { path: `${dir}/main.tf`, content: main },
    { path: `${dir}/variables.tf`, content: variables },
    { path: `${dir}/outputs.tf`, content: outputs },
  ];
}

const AZURE_MODULE: GeneratedFile = {
  path: "terraform/modules/azure-workload-identity/main.tf",
  content: hcl(`
# User-assigned identity + federated credential for one Kubernetes service account, with one role assignment.
variable "name" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "oidc_issuer_url" { type = string }
variable "subject" { type = string }
variable "role_scope" { type = string }
variable "role" { type = string }

resource "azurerm_user_assigned_identity" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "this" {
  name                = "kubernetes"
  resource_group_name = var.resource_group_name
  parent_id           = azurerm_user_assigned_identity.this.id
  issuer              = var.oidc_issuer_url
  subject             = var.subject
  audience            = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "this" {
  scope                = var.role_scope
  role_definition_name = var.role
  principal_id         = azurerm_user_assigned_identity.this.principal_id
}

output "client_id" {
  value = azurerm_user_assigned_identity.this.client_id
}
`),
};

// ------------------------------------------------------------------ AWS
function awsStorage(cfg: PlannerConfig, c: CentralCluster, buckets: string[]): string {
  const list = buckets.map((b) => `"${b}"`).join(", ");
  if (c.role === "standby")
    return `# STANDBY: no buckets of its own. It reads the replica buckets, filled by S3 Cross-Region Replication from the primary region.`;
  const base = `# Object storage: one bucket per data type.
resource "aws_s3_bucket" "obs" {
  for_each = toset([${list}])
  bucket   = each.value
}

resource "aws_s3_bucket_public_access_block" "obs" {
  for_each                = aws_s3_bucket.obs
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}`;
  if (!standbyModel(cfg)) return base;
  const second = secondRegion(cfg)!;
  const fromTag = `-${regionInfo(cfg, cfg.platform.region).short}-`;
  const toTag = `-${regionInfo(cfg, second).short}-`;
  const pairs = buckets.map((b) => `    "${b}" = "${b.replace(fromTag, toTag)}"`).join("\n");
  return `${base}

# STANDBY REGION (${second}): replica buckets, filled by S3 Cross-Region Replication (CRR).
locals {
  replicas = {
${pairs}
  }
}

resource "aws_s3_bucket_versioning" "obs" {
  for_each = aws_s3_bucket.obs
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket" "replica" {
  provider = aws.standby
  for_each = local.replicas
  bucket   = each.value
}

resource "aws_s3_bucket_versioning" "replica" {
  provider = aws.standby
  for_each = aws_s3_bucket.replica
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Deleted objects leave old versions behind on the replica: remove them after 7 days.
resource "aws_s3_bucket_lifecycle_configuration" "replica" {
  provider = aws.standby
  for_each = aws_s3_bucket.replica
  bucket   = each.value.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

data "aws_iam_policy_document" "replication_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = "\${var.name_prefix}-${slug(c.dir)}-s3-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_trust.json
}

resource "aws_iam_role_policy" "replication" {
  role = aws_iam_role.replication.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = [for b in keys(local.replicas) : "arn:aws:s3:::\${b}"] },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = [for b in keys(local.replicas) : "arn:aws:s3:::\${b}/*"] },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = [for b in values(local.replicas) : "arn:aws:s3:::\${b}/*"] },
    ]
  })
}

# Deletes made by compaction and retention are replicated as delete markers.
resource "aws_s3_bucket_replication_configuration" "standby" {
  for_each = local.replicas
  bucket   = aws_s3_bucket.obs[each.key].id
  role     = aws_iam_role.replication.arn

  rule {
    id     = "to-standby"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket = aws_s3_bucket.replica[each.key].arn
    }
  }

  depends_on = [aws_s3_bucket_versioning.obs, aws_s3_bucket_versioning.replica]
}`;
}

function aws(cfg: PlannerConfig, c: CentralCluster): GeneratedFile[] {
  const env = c.env;
  const users = storageUsers(cfg);
  const pools = recommendNodePools(c);
  const create = cfg.topology.createCentralCluster;
  const dir = `terraform/${c.name}`;
  const buckets = users.flatMap((u) => u.stores.map((s) => bucketName(cfg, env, s)));
  const needsDb = (cfg.components.grafana.enabled && cfg.components.grafana.options.ha === "ha") || (cfg.components.langfuse.enabled && cfg.components.langfuse.options.postgres === "managed");

  const main = hcl(`
${
  create
    ? `# Central EKS cluster (community module) with Pod Identity and the EBS CSI driver.
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = "${c.name}"
  kubernetes_version = var.kubernetes_version
  vpc_id             = var.vpc_id
  subnet_ids         = var.private_subnet_ids

  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns                = {}
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
    eks-pod-identity-agent = { before_compute = true }
    aws-ebs-csi-driver     = {}
  }

  eks_managed_node_groups = {
    system = {
      instance_types = ["${pools[0].vm.name}"]
      min_size       = ${pools[0].nodes}
      max_size       = ${pools[0].nodes + 2}
      desired_size   = ${pools[0].nodes}
      labels         = { role = "system" }
    }
    observability = {
      instance_types = ["${pools[1].vm.name}"]
      min_size       = ${pools[1].nodes}
      max_size       = ${pools[1].nodes * 2}
      desired_size   = ${pools[1].nodes}
    }
  }
}

locals {
  cluster_name = module.eks.cluster_name
}`
    : `locals {
  cluster_name = var.cluster_name
}`
}

${awsStorage(cfg, c, buckets)}

# EKS Pod Identity: one IAM role per component, bound to its Kubernetes service account.
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

locals {
  storage_users = {
${users.map((u) => `    "${u.sa}" = [${u.stores.map((s) => `"${bucketName(cfg, env, s)}"`).join(", ")}]`).join("\n")}
  }
}

resource "aws_iam_role" "component" {
  for_each           = local.storage_users
  name               = "\${var.name_prefix}-${slug(c.dir)}-\${each.key}"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "component" {
  for_each = local.storage_users
  role     = aws_iam_role.component[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = flatten([for b in each.value : ["arn:aws:s3:::\${b}", "arn:aws:s3:::\${b}/*"]])
    }]
  })
}

resource "aws_eks_pod_identity_association" "component" {
  for_each        = local.storage_users
  cluster_name    = local.cluster_name
  namespace       = "${NS}"
  service_account = each.key
  role_arn        = aws_iam_role.component[each.key].arn
}

# External Secrets reads Secrets Manager entries prefixed with the cluster name.
resource "aws_iam_role" "external_secrets" {
  name               = "\${var.name_prefix}-${slug(c.dir)}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "external_secrets" {
  role = aws_iam_role.external_secrets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = "arn:aws:secretsmanager:${cfg.platform.region}:*:secret:*"
    }]
  })
}

resource "aws_eks_pod_identity_association" "external_secrets" {
  cluster_name    = local.cluster_name
  namespace       = "external-secrets"
  service_account = "external-secrets"
  role_arn        = aws_iam_role.external_secrets.arn
}
${
  needsDb
    ? `
resource "aws_db_instance" "obs" {
  identifier              = "\${var.name_prefix}-${slug(c.dir)}"
  engine                  = "postgres"
  engine_version          = "17"
  instance_class          = "${cfg.components.langfuse.options.postgresTier === "general" ? "db.m7g.large" : "db.t4g.medium"}"
  allocated_storage       = 32
  username                = "obsadmin"
  password                = var.postgres_admin_password
  multi_az                = ${cfg.components.langfuse.options.postgresHa ? "true" : "false"}
  db_subnet_group_name    = var.db_subnet_group_name
  storage_encrypted       = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "\${var.name_prefix}-${slug(c.dir)}-final"
}
`
    : ""
}`);

  const variables = hcl(`
variable "name_prefix" {
  type    = string
  default = "${namePrefix(cfg)}"
}
${create ? `\nvariable "kubernetes_version" {\n  type    = string\n  default = "1.34"\n}\n\nvariable "vpc_id" {\n  type = string\n}\n\nvariable "private_subnet_ids" {\n  type = list(string)\n}\n` : `\nvariable "cluster_name" {\n  type        = string\n  description = "Name of the existing central EKS cluster (needs the eks-pod-identity-agent add-on)"\n}\n`}${needsDb ? `\nvariable "postgres_admin_password" {\n  type      = string\n  sensitive = true\n}\n\nvariable "db_subnet_group_name" {\n  type = string\n}\n` : ""}`);

  return [
    { path: `${dir}/versions.tf`, content: `terraform {\n  required_version = ">= 1.10"\n  required_providers {\n${PROVIDERS.aws}\n  }\n  backend "s3" {}\n}\n\nprovider "aws" {\n  region = "${cfg.platform.region}"\n}\n${c.role === "active" && standbyModel(cfg) ? `\n# Standby region: replica buckets\nprovider "aws" {\n  alias  = "standby"\n  region = "${secondRegion(cfg)}"\n}\n` : ""}` },
    { path: `${dir}/main.tf`, content: main },
    { path: `${dir}/variables.tf`, content: variables },
    { path: `${dir}/outputs.tf`, content: `output "buckets" {\n  value = [for b in aws_s3_bucket.obs : b.bucket]\n}\n` },
  ];
}

// ------------------------------------------------------------------ GCP
function gcp(cfg: PlannerConfig, c: CentralCluster): GeneratedFile[] {
  const env = c.env;
  const users = storageUsers(cfg);
  const pools = recommendNodePools(c);
  const create = cfg.topology.createCentralCluster;
  const dir = `terraform/${c.name}`;
  const needsDb = (cfg.components.grafana.enabled && cfg.components.grafana.options.ha === "ha") || (cfg.components.langfuse.enabled && cfg.components.langfuse.options.postgres === "managed");
  const zoneList = ["a", "b", "c"].slice(0, cfg.topology.zones).map((z) => `"${cfg.platform.region}-${z}"`).join(", ");
  const principal = (sa: string, ns = NS) => `principal://iam.googleapis.com/projects/\${data.google_project.this.number}/locations/global/workloadIdentityPools/\${var.project_id}.svc.id.goog/subject/ns/${ns}/sa/${sa}`;

  const main = hcl(`
data "google_project" "this" {
  project_id = var.project_id
}

${
  create
    ? `# Regional GKE cluster with Workload Identity Federation; node pools sized by the planner.
resource "google_container_cluster" "central" {
  name                     = "${c.name}"
  location                 = "${cfg.platform.region}"
  node_locations           = [${zoneList}]
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = true

  workload_identity_config {
    workload_pool = "\${var.project_id}.svc.id.goog"
  }
}

resource "google_container_node_pool" "system" {
  name       = "system"
  cluster    = google_container_cluster.central.id
  node_count = ${Math.max(1, Math.round(pools[0].nodes / cfg.topology.zones))}
  node_config {
    machine_type = "${pools[0].vm.name}"
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

resource "google_container_node_pool" "observability" {
  name       = "observability"
  cluster    = google_container_cluster.central.id
  node_count = ${Math.max(1, Math.round(pools[1].nodes / cfg.topology.zones))} # per zone
  node_config {
    machine_type = "${pools[1].vm.name}"
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}`
    : "# Existing cluster: Workload Identity Federation must be enabled on it."
}

# Object storage: one bucket per data type, access granted directly to the Kubernetes service accounts.
locals {
  buckets = {
${users.flatMap((u) => u.stores.map((s) => `    "${bucketName(cfg, env, s)}" = "${u.sa}"`)).join("\n")}
  }
}

${
  c.role === "standby"
    ? "# STANDBY: the buckets are dual-region (created by the primary region); only access is granted here."
    : `resource "google_storage_bucket" "obs" {
  for_each                    = local.buckets
  name                        = each.key
${
  standbyModel(cfg)
    ? `  # Dual-region: every object is stored in ${cfg.platform.region} and ${secondRegion(cfg)}.
  location                    = "${({ europe: "EU", america: "US", asia: "ASIA" } as Record<string, string>)[regionInfo(cfg, cfg.platform.region).continent] ?? "EU"}"
  custom_placement_config {
    data_locations = ["${cfg.platform.region.toUpperCase()}", "${String(secondRegion(cfg)).toUpperCase()}"]
  }
  rpo                         = "ASYNC_TURBO" # turbo replication: objects in both regions within 15 minutes`
    : `  location                    = "${cfg.platform.region.toUpperCase()}"`
}
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
}`
}

resource "google_storage_bucket_iam_member" "obs" {
  for_each = local.buckets
  bucket   = ${c.role === "standby" ? "each.key" : "google_storage_bucket.obs[each.key].name"}
  role     = "roles/storage.objectAdmin"
  member   = "${principal("${each.value}")}"
}

# External Secrets reads Secret Manager.
resource "google_project_iam_member" "external_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "${principal("external-secrets", "external-secrets")}"
}
${
  needsDb
    ? `
resource "google_sql_database_instance" "obs" {
  name             = "\${var.name_prefix}-${env}"
  database_version = "POSTGRES_17"
  region           = "${cfg.platform.region}"
  settings {
    tier              = "${cfg.components.langfuse.options.postgresTier === "general" ? "db-custom-2-8192" : "db-g1-small"}"
    availability_type = "${cfg.components.langfuse.options.postgresHa ? "REGIONAL" : "ZONAL"}"
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }
  }
  deletion_protection = true
}
`
    : ""
}`);

  const variables = hcl(`
variable "project_id" {
  type = string
}

variable "name_prefix" {
  type    = string
  default = "${namePrefix(cfg)}"
}
${needsDb ? `\nvariable "network_id" {\n  type = string\n}\n` : ""}`);

  return [
    { path: `${dir}/versions.tf`, content: `terraform {\n  required_version = ">= 1.10"\n  required_providers {\n${PROVIDERS.gcp}\n  }\n  backend "gcs" {}\n}\n\nprovider "google" {\n  project = var.project_id\n  region  = "${cfg.platform.region}"\n}\n` },
    { path: `${dir}/main.tf`, content: main },
    { path: `${dir}/variables.tf`, content: variables },
    { path: `${dir}/outputs.tf`, content: `output "buckets" {\n  value = keys(local.buckets)\n}\n` },
  ];
}

export function terraformFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const c of central) {
    if (cfg.platform.cloud === "azure") files.push(...azure(c.cfg, c, central));
    else if (cfg.platform.cloud === "aws") files.push(...aws(c.cfg, c));
    else files.push(...gcp(c.cfg, c));
  }
  if (cfg.platform.cloud === "azure") files.push(AZURE_MODULE);
  return files;
}
