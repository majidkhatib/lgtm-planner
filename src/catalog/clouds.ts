import type { CloudId } from "../model/types";
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS } from "./regions.data";

export interface CloudInfo {
  id: CloudId;
  name: string;
  short: string;
  kubernetes: string;
  objectStorage: string;
  podIdentity: string;
  secretStore: string;
  blockStorage: string;
  dns: string;
  nativeL7: string;
  privateLink: string;
  managedDb: string;
  managedKafka: string;
  managedRedis: string;
  edgeCertificate: string;
  llm: string;
  /** How object storage is copied to a second region */
  storageReplication: string;
  /** DNS-based failover between regions */
  dnsFailover: string;
  /** Kafka replication to a second region */
  kafkaReplication: string;
  regions: RegionInfo[];
}

/** Region preselected when a cloud is chosen. */
export const DEFAULT_REGION: Record<CloudId, string> = { azure: "germanywestcentral", aws: "eu-central-1", gcp: "europe-west3" };

const CONTINENT_ORDER = ["europe", "america", "asia", "middle-east", "africa"];

/** Regions for a select box: grouped by continent, with restricted / opt-in regions marked. */
export function regionOptions(cloud: CloudId, filter: (r: RegionInfo) => boolean = () => true): { value: string; label: string }[] {
  return [...CLOUDS[cloud].regions]
    .filter(filter)
    .sort((a, b) => CONTINENT_ORDER.indexOf(a.continent) - CONTINENT_ORDER.indexOf(b.continent) || a.name.localeCompare(b.name))
    .map((r) => ({ value: r.id, label: `${r.name}${r.restricted ? " — restricted (access request needed)" : r.optIn ? " — opt-in region" : ""}` }));
}

export interface RegionInfo {
  id: string;
  name: string;
  /** Short code used in cluster, bucket and storage-account names */
  short: string;
  continent: "europe" | "america" | "asia" | "middle-east" | "africa";
  /** Azure only: the region's fixed geo-replication pair */
  paired?: string;
  /** Azure: needs an access request before compute can be deployed */
  restricted?: boolean;
  /** AWS: must be enabled (opted in) in the account first */
  optIn?: boolean;
}

export const CLOUDS: Record<CloudId, CloudInfo> = {
  azure: {
    id: "azure",
    name: "Microsoft Azure",
    short: "Azure",
    kubernetes: "AKS",
    objectStorage: "Azure Blob Storage",
    podIdentity: "Azure Workload Identity",
    secretStore: "Azure Key Vault",
    blockStorage: "Premium SSD v2 / Premium SSD (ZRS optional)",
    dns: "Azure DNS",
    nativeL7: "Application Gateway for Containers",
    privateLink: "Private Link / VNet peering",
    managedDb: "Azure Database for PostgreSQL Flexible Server",
    managedKafka: "Event Hubs (Kafka endpoint)",
    managedRedis: "Azure Managed Redis",
    edgeCertificate: "Application Gateway / Front Door with a certificate from Key Vault",
    llm: "Azure OpenAI",
    storageReplication: "Object replication to a storage account in any region, or GZRS / RA-GZRS geo-replication to the fixed paired region",
    dnsFailover: "Azure Front Door or Traffic Manager",
    kafkaReplication: "Event Hubs geo-replication (Premium / Dedicated)",
    regions: AZURE_REGIONS,
  },
  aws: {
    id: "aws",
    name: "Amazon Web Services",
    short: "AWS",
    kubernetes: "EKS",
    objectStorage: "Amazon S3",
    podIdentity: "EKS Pod Identity (IRSA alternative)",
    secretStore: "AWS Secrets Manager",
    blockStorage: "EBS gp3",
    dns: "Route 53",
    nativeL7: "AWS Load Balancer Controller (ALB)",
    privateLink: "PrivateLink / VPC peering",
    managedDb: "Amazon RDS for PostgreSQL",
    managedKafka: "Amazon MSK",
    managedRedis: "Amazon ElastiCache (Valkey)",
    edgeCertificate: "AWS Certificate Manager (ACM) on the load balancer",
    llm: "Amazon Bedrock",
    storageReplication: "S3 Cross-Region Replication (CRR)",
    dnsFailover: "Route 53 failover records with health checks",
    kafkaReplication: "MSK Replicator",
    regions: AWS_REGIONS,
  },
  gcp: {
    id: "gcp",
    name: "Google Cloud",
    short: "GCP",
    kubernetes: "GKE",
    objectStorage: "Cloud Storage",
    podIdentity: "GKE Workload Identity Federation",
    secretStore: "Secret Manager",
    blockStorage: "Hyperdisk Balanced / pd-balanced",
    dns: "Cloud DNS",
    nativeL7: "GKE Gateway controller",
    privateLink: "Private Service Connect / VPC peering",
    managedDb: "Cloud SQL for PostgreSQL",
    managedKafka: "Managed Service for Apache Kafka",
    managedRedis: "Memorystore for Valkey",
    edgeCertificate: "Google-managed certificate (Certificate Manager) on the load balancer",
    llm: "Vertex AI",
    storageReplication: "Dual-region bucket (one bucket stored in two regions of the same continent)",
    dnsFailover: "Cloud DNS routing policies / global external load balancer",
    kafkaReplication: "MirrorMaker 2 (Managed Service for Apache Kafka has no built-in cross-region replication)",
    regions: GCP_REGIONS,
  },
};
