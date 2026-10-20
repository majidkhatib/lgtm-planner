import { CLOUDS } from "../catalog/clouds";
import { COMPONENT_BY_ID } from "../catalog/components";
import type { PlannerConfig } from "../model/types";
import { effectiveReplication, isMultiRegion, regionInfo, secondRegion } from "../model/regions";
import { centralWorkloads, designComponents, isCentral, isRemote, NS, remoteClusters, remoteWorkloads, type CentralCluster, type GeneratedFile } from "./common";
import { recommendNodePools } from "./nodepools";

const DELIVERY: Record<string, string> = {
  argocd: "Argo CD",
  flux: "Flux",
  "azure-devops": "Azure DevOps Pipelines",
  "github-actions": "GitHub Actions",
  "gitlab-ci": "GitLab CI/CD",
  helm: "Helm scripts",
};

function deploySteps(cfg: PlannerConfig, central: CentralCluster[]): string {
  const m = cfg.delivery.method;
  const first = central[0].name;
  const terraform = `1. **Cloud resources**: \`cd terraform/${first} && terraform init && terraform apply\` (one folder per central cluster).`;
  const azure = cfg.platform.cloud === "azure" ? `\n   Copy each \`*_client_id\` output into the \`azure.workload.identity/client-id\` annotation in \`helm/central/<env>/<component>/values.yaml\`.` : "";
  const secrets = `2. **Secrets**: create the entries listed below in ${CLOUDS[cfg.platform.cloud].secretStore}. They are synced into the clusters; nothing secret is stored in Git.`;
  if (m === "argocd")
    return `${terraform}${azure}\n${secrets}\n3. **Argo CD**: install Argo CD on each central cluster and register the remote clusters with the labels \`environment=<env>\` and \`role=remote\`.\n4. **Bootstrap**: \`kubectl apply -f argocd/bootstrap/<central-cluster>.yaml\`. Argo CD then deploys add-ons (wave -2), manifests (wave -1) and components (wave 0).`;
  if (m === "flux")
    return `${terraform}${azure}\n${secrets}\n3. **Flux**: on every cluster run \`flux bootstrap <git-provider> --path=flux/clusters/<cluster-name>\`.`;
  if (m === "helm") return `${terraform}${azure}\n${secrets}\n3. **Deploy**: \`./scripts/deploy-<central-cluster>.sh\` with kubectl pointing at the central cluster, then \`./scripts/deploy-remote-<env>.sh <cluster>\` for every remote cluster.`;
  return `${terraform}${azure}\n${secrets}\n3. **Pipeline**: commit the repository; the ${DELIVERY[m]} pipeline runs the scripts in \`scripts/\` per cluster (central first, then remote).`;
}

function multiRegionSection(cfg: PlannerConfig, central: CentralCluster[]): string {
  if (!isMultiRegion(cfg)) return "";
  const cloud = CLOUDS[cfg.platform.cloud];
  const model = cfg.multiRegion.model;
  const list = central.map((c) => `| \`${c.name}\` | ${regionInfo(cfg, c.region).name} | ${c.role === "standby" ? "standby (not deployed)" : "active"} |`).join("\n");
  let body = `## Regions\n\n| Cluster | Region | Role |\n|---|---|---|\n${list}\n\n`;
  if (model === "regional") body += "Each region is independent: remote clusters write to the stack of their region (hostnames contain the region code, e.g. `mimir.<code>.<domain>`).\n\n";
  if (model === "active-active") body += "Collectors write every signal to both regions (two endpoints in every collector). Either region can serve all data on its own.\n\n";
  if (model === "standby") {
    const method = effectiveReplication(cfg);
    const second = secondRegion(cfg)!;
    const standby = central.find((c) => c.role === "standby");
    const how =
      method === "geo"
        ? `The storage account is geo-redundant (RA-GZRS) to the paired region ${second}.`
        : method === "object"
          ? `Object replication copies every new blob to the replica account in ${second}; a lifecycle rule removes blobs older than the retention there.`
          : method === "crr"
            ? `S3 Cross-Region Replication copies every object and delete marker to the replica buckets in ${second}.`
            : `The buckets are dual-region (${cfg.platform.region} + ${second}) with turbo replication.`;
    const start =
      cfg.delivery.method === "argocd"
        ? `Bootstrap Argo CD on the standby cluster (\`kubectl apply -f argocd/bootstrap/${standby?.name}.yaml\`), then sync: \`argocd app sync -l standby=${standby?.name}\`.`
        : cfg.delivery.method === "flux"
          ? "Bootstrap Flux on the standby cluster, then `flux resume helmrelease --all -A`."
          : cfg.delivery.method === "helm"
            ? `Run \`./scripts/deploy-${standby?.name}.sh\`.`
            : "Run the failover pipeline (type FAILOVER to confirm).";
    const storageFailover = method === "geo" ? `\n   Then fail over the storage account so it becomes writable in ${second}: \`az storage account failover --name <account> --resource-group <rg>\`.` : "";
    body += [
      "### Failover runbook (standby region)",
      "",
      `${how} The standby cluster's values already point at the replicated storage.`,
      "",
      "1. **Confirm** the primary region is down (cloud status page, meta-monitoring alerts).",
      `2. **Create the standby cluster** if it doesn't exist yet: \`terraform apply\` in \`terraform/${standby?.name}/\`.${storageFailover}`,
      `3. **Secrets**: make sure the same secrets exist in the standby region's ${cloud.secretStore}.`,
      `4. **Deploy**: ${start}`,
      `5. **DNS**: point the hostnames to the standby gateway (${cloud.dnsFailover}). With external-dns, stop it on the primary (if reachable) so the standby takes over the records.`,
      "6. **Collectors** on the remote clusters keep the same hostnames; they reconnect automatically once DNS has switched.",
      `7. **Expect a gap** of up to ~2 hours of data that was in the primary's ingesters but not yet in object storage${cfg.multiRegion.mirrorKafka ? " (smaller with Kafka replication: the standby replays it from the mirrored topics)" : ""}.`,
      "",
      "Fail back the same way once the primary region is healthy, with replication set up in the other direction.",
      "",
      "",
    ].join("\n");
  }
  return body;
}

export function docFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const comps = designComponents(cfg);
  const cloud = CLOUDS[cfg.platform.cloud];
  const remotes = remoteClusters(cfg);

  const readme = `# Observability platform: Grafana LGTM on ${cloud.short}

Generated by [LGTM Planner](https://m-shahidi.com/lgtm-planner/). Architecture: [docs/architecture.svg](docs/architecture.svg) · Sizing: [docs/SIZING.md](docs/SIZING.md)

| | |
|---|---|
| Cloud | ${cloud.name}, ${cfg.platform.region} |
| Delivery | ${DELIVERY[cfg.delivery.method]} |
| Central cluster(s) | ${central.map((c) => `\`${c.name}\``).join(", ")} |
| Remote clusters | ${remotes.length ? remotes.map((r) => `\`${r.name}\``).join(", ") : "none"} |
| Namespace | \`${NS}\` |
| Multi-tenancy | ${cfg.tenancy.enabled ? `on, tenant = ${cfg.tenancy.key}${cfg.tenancy.crossTenantQuery ? ", cross-tenant queries in Grafana" : ""}` : "off"} |

## Components

| Component | Runs on |
|---|---|
${comps.map((c) => `| ${c.name} | ${c.runsOn === "central" ? "central" : c.runsOn === "remote" ? "remote" : "central + remote"} |`).join("\n")}

## Repository layout

\`\`\`
helm/base/<component>/values.yaml            settings shared by all environments
helm/central/<env>/<component>/values.yaml   sizing, storage, retention per central cluster
helm/remote/<env>/<component>/values.yaml    collectors on the remote clusters
manifests/                                   namespace, storage classes, routes, secrets, operator resources
terraform/<central-cluster>/                 object storage, identities, secret store${cfg.topology.createCentralCluster ? ", cluster" : ""}
${cfg.delivery.method === "argocd" ? "argocd/                                      projects, applications, application sets, bootstrap" : cfg.delivery.method === "flux" ? "flux/clusters/<cluster>/                     Flux entry point per cluster" : "scripts/ + pipeline                          deploy scripts per cluster"}
\`\`\`

## Deploy

${deploySteps(cfg, central)}

${multiRegionSection(cfg, central)}## Secrets to create

Names in the secret store are \`<cluster>--<secret>--<key>\`.

- Every central cluster: ${["grafana-admin (admin-user, admin-password)", cfg.connectivity.auth === "basic" ? "gateway-htpasswd (.htpasswd: one line per tenant, created with `htpasswd -nbB <tenant> <password>`)" : "", cfg.connectivity.auth === "mtls" ? "remote-clusters-ca (ca.crt)" : "", cfg.connectivity.tls === "existing" ? "wildcard-tls (tls.crt, tls.key)" : "", cfg.components.langfuse.enabled ? "langfuse (salt, nextauth-secret, encryption-key: `openssl rand -hex 32`)" : "", cfg.components.robusta.enabled ? "robusta (signing-key, llm-api-key)" : ""].filter(Boolean).join("; ")}
- Every remote cluster: remote-write (cluster, tenant${cfg.connectivity.auth === "basic" ? ", password" : ""})${cfg.connectivity.auth === "mtls" ? "; remote-write-mtls (tls.crt, tls.key, ca.crt)" : ""}

## Placeholders to fill

Search the repository for \`<\` placeholders, e.g. \`grep -rn "<" --include=*.yaml .\`:
${[
  cfg.platform.cloud === "azure" ? "- Workload Identity client IDs (from `terraform output`)" : "",
  cfg.delivery.repoUrl ? "" : "- Git repository URL in the GitOps manifests",
  cfg.components.kafka.enabled && cfg.components.kafka.options.provider === "managed" ? `- ${cloud.managedKafka} bootstrap address (create it with your network setup; Mimir/Tempo values reference it)` : "",
  cfg.components.grafana.options.auth === "oidc" ? "- Identity provider URLs in Grafana's `grafana.ini` (auth.generic_oauth)" : "",
  cfg.tenancy.enabled && !["cluster", "environment"].includes(cfg.tenancy.key) ? "- Tenant names: label-based tenancy needs one tenant per label value; extend the Grafana data source header and the gateway htpasswd accordingly" : "",
  cfg.components["cloud-logs"].enabled ? "- Cloud log stream names (Event Hub / Firehose / Pub/Sub subscription) in helm/central/<env>/cloud-logs" : "",
]
  .filter(Boolean)
  .join("\n")}

Chart versions are pinned to the latest stable releases at generation time; keep them current with Renovate or Dependabot.
`;

  const sizing = central
    .map((c) => {
      const rows = comps
        .filter((x) => isCentral(x.id, cfg))
        .flatMap((comp) =>
          centralWorkloads(c, comp.id)
            .filter((w) => w.def.kind !== "Managed")
            .map((w) => `| ${comp.name} | ${w.def.name} | ${w.def.kind} | ${w.final.replicas} | ${w.final.cpu} | ${w.final.memoryGi} Gi | ${w.final.pvcGi ? `${w.final.pvcGi} Gi` : "–"} | ${w.autoscaler} |`),
        );
      const pools = recommendNodePools(c)
        .map((p) => `| ${p.name} | ${p.vm.name} (${p.vm.vcpu} vCPU, ${p.vm.memoryGi} GiB) | ${p.nodes} | ${p.basis} |`)
        .join("\n");
      return `## ${c.name}\n\n| Component | Workload | Type | Replicas | CPU/pod | Memory/pod | Disk/pod | Scaling |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\n### Node pools\n\n| Pool | VM | Nodes | Based on |\n|---|---|---|---|\n${pools}\n`;
    })
    .join("\n");

  const remoteSizing = cfg.environments
    .filter((e) => remotes.some((r) => r.env === e))
    .map((e) => {
      const rows = comps
        .filter((x) => isRemote(x.id, cfg))
        .flatMap((comp) => remoteWorkloads(cfg, e, comp.id).map((w) => `| ${COMPONENT_BY_ID[comp.id].name} | ${w.def.kind} | ${w.def.kind === "DaemonSet" ? "1 per node" : w.final.replicas} | ${w.final.cpu} | ${w.final.memoryGi} Gi |`));
      return `## Remote clusters (${e}), per cluster\n\n| Component | Type | Replicas | CPU/pod | Memory/pod |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
    })
    .join("\n");

  return [
    { path: "README.md", content: readme },
    { path: "docs/SIZING.md", content: `# Sizing\n\nCalculated by LGTM Planner from Grafana's official capacity-planning guides where they exist; other values are starting points. Re-check after a week of real traffic.\n\n${sizing}\n${remoteSizing}` },
  ];
}
