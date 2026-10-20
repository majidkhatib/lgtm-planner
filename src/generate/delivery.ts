import { stringify } from "yaml";
import { CLOUDS } from "../catalog/clouds";
import { ADDON_CHARTS, CHARTS, HELM_REPOS, type ChartRef } from "../catalog/versions";
import type { ComponentId, PlannerConfig } from "../model/types";
import { regionInfo } from "../model/regions";
import { centralWorkloads, designComponents, groupOf, isCentral, isRemote, NS, remoteClusters, remoteGroups, type CentralCluster, type GeneratedFile, type RemoteGroup } from "./common";

export interface Release {
  name: string;
  chart: ChartRef;
  namespace: string;
  /** value files relative to the repo root, in order */
  valueFiles: string[];
  /** deploy order: add-ons first */
  wave: number;
  inline?: Record<string, unknown>;
}

const repoUrl = (cfg: PlannerConfig) => cfg.delivery.repoUrl.trim() || "https://<git-host>/<org>/observability-platform.git";

function chartFor(cfg: PlannerConfig, id: ComponentId): ChartRef | null {
  switch (id) {
    case "mimir": return CHARTS.mimir;
    case "loki": return CHARTS.loki;
    case "tempo": return cfg.components.tempo.options.mode === "distributed" ? CHARTS.tempoDistributed : CHARTS.tempoMonolithic;
    case "pyroscope": return CHARTS.pyroscope;
    case "grafana": return CHARTS.grafana;
    case "alertmanager": return cfg.components.alertmanager.options.type === "mimir" ? null : CHARTS.alertmanager;
    case "robusta": return CHARTS.robusta;
    case "langfuse": return CHARTS.langfuse;
    case "prometheus": return cfg.components.prometheus.options.collector === "alloy" ? CHARTS.alloy : CHARTS.prometheus;
    case "kube-state-metrics": return CHARTS.kubeStateMetrics;
    case "node-exporter": return CHARTS.nodeExporter;
    case "trace-collector": return cfg.components["trace-collector"].options.collector === "otel" ? CHARTS.otelCollector : CHARTS.alloy;
    case "alloy-logs":
    case "alloy-events":
    case "alloy-profiles":
    case "beyla":
    case "cloud-logs":
      return CHARTS.alloy;
    default:
      return null;
  }
}

function usesAutoscaler(cfg: PlannerConfig, c: CentralCluster, kind: "keda" | "vpa"): boolean {
  return designComponents(cfg).some((comp) =>
    centralWorkloads(c, comp.id).some((w) => w.autoscaler === kind || (kind === "vpa" && cfg.components[comp.id].workloads?.[w.def.id]?.vpaAdvice)),
  );
}

/** Cluster add-ons the chosen design depends on. */
function addonReleases(cfg: PlannerConfig, c: CentralCluster | null): Release[] {
  const out: Release[] = [];
  const dir = c ? `helm/addons/${c.dir}` : "helm/addons/remote";
  const add = (name: string, chart: ChartRef, namespace: string, inline?: Record<string, unknown>) =>
    out.push({ name, chart, namespace, valueFiles: inline ? [`${dir}/${name}/values.yaml`] : [], wave: -2, inline });
  if (cfg.connectivity.secrets === "eso") add("external-secrets", ADDON_CHARTS.externalSecrets, "external-secrets", { installCRDs: true, serviceAccount: { name: "external-secrets" } });
  if (!c) return out; // remote clusters only need secrets
  if (cfg.connectivity.tls === "cert-manager") add("cert-manager", ADDON_CHARTS.certManager, "cert-manager", { crds: { enabled: true }, config: { enableGatewayAPI: true } });
  if (cfg.connectivity.externalDns) add("external-dns", ADDON_CHARTS.externalDns, "external-dns", { provider: { name: cfg.platform.cloud === "azure" ? "azure" : cfg.platform.cloud === "aws" ? "aws" : "google" }, policy: "sync", txtOwnerId: c.name, sources: ["service", "ingress", "gateway-httproute"], domainFilters: [cfg.connectivity.baseDomain] });
  const ing = cfg.connectivity.ingress;
  if (ing === "envoy-gateway") add("envoy-gateway", ADDON_CHARTS.envoyGateway, "envoy-gateway-system");
  if (ing === "haproxy") add("haproxy-ingress", ADDON_CHARTS.haproxy, "haproxy-ingress");
  if (ing === "traefik") add("traefik", ADDON_CHARTS.traefik, "traefik");
  if (usesAutoscaler(cfg, c, "keda")) add("keda", ADDON_CHARTS.keda, "keda");
  if (usesAutoscaler(cfg, c, "vpa") && cfg.platform.cloud === "aws") add("vpa", ADDON_CHARTS.vpa, "kube-system");
  if (cfg.components.kafka.enabled && cfg.components.kafka.options.provider === "strimzi") add("strimzi", ADDON_CHARTS.strimzi, "strimzi", { watchNamespaces: [NS] });
  if (cfg.components.langfuse.enabled && cfg.components.langfuse.options.clickhouse === "operator") add("clickhouse-operator", ADDON_CHARTS.clickhouseOperator, "clickhouse-operator");
  return out;
}

export function centralReleases(cfg: PlannerConfig, c: CentralCluster): Release[] {
  const comps = designComponents(cfg).filter((x) => isCentral(x.id, cfg));
  const rel: Release[] = addonReleases(cfg, c);
  for (const comp of comps) {
    const chart = chartFor(cfg, comp.id);
    if (!chart) continue;
    const both = comp.runsOn === "both" || comp.id === "cloud-logs";
    rel.push({
      name: comp.id,
      chart,
      namespace: NS,
      valueFiles: both ? [`helm/central/${c.dir}/${comp.id}/values.yaml`] : [`helm/base/${comp.id}/values.yaml`, `helm/central/${c.dir}/${comp.id}/values.yaml`],
      wave: 0,
    });
  }
  return rel;
}

export function remoteReleases(cfg: PlannerConfig, g: RemoteGroup, cluster?: string): Release[] {
  const rel: Release[] = addonReleases(cfg, null);
  for (const comp of designComponents(cfg).filter((x) => isRemote(x.id, cfg))) {
    const chart = chartFor(cfg, comp.id);
    if (!chart) continue;
    const files = [`helm/remote/${g.dir}/${comp.id}/values.yaml`];
    if (comp.id === "prometheus" && cfg.components.prometheus.options.collector !== "alloy") files.push(`helm/remote/${g.dir}/clusters/${cluster ?? "{{name}}"}/prometheus.yaml`);
    rel.push({ name: comp.id, chart, namespace: NS, valueFiles: files, wave: 0 });
  }
  return rel;
}

const y = (header: string, ...docs: Record<string, unknown>[]) => `# ${header}\n` + docs.map((d) => stringify(d, { lineWidth: 0 })).join("---\n");
const isOci = (r: Release) => HELM_REPOS[r.chart.repo].startsWith("oci://");

// ------------------------------------------------------------------ Argo CD
function argoApplication(cfg: PlannerConfig, r: Release, project: string, server: string, appName: string, manual = false): Record<string, unknown> {
  const repo = HELM_REPOS[r.chart.repo];
  const helm: Record<string, unknown> = { releaseName: r.name };
  if (r.valueFiles.length) {
    helm.valueFiles = r.valueFiles.map((f) => `$values/${f}`);
    helm.ignoreMissingValueFiles = true;
  }
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: appName, namespace: "argocd", annotations: { "argocd.argoproj.io/sync-wave": String(r.wave) } },
    spec: {
      project,
      sources: [
        { repoURL: isOci(r) ? repo.replace("oci://", "") : repo, chart: r.chart.chart, targetRevision: r.chart.version, helm },
        { repoURL: repoUrl(cfg), targetRevision: "main", ref: "values" },
      ],
      destination: { server, namespace: r.namespace },
      syncPolicy: manual ? { syncOptions: ["CreateNamespace=true", "ServerSideApply=true"] } : { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true", "ServerSideApply=true"] },
    },
  };
}

const slug = (dir: string) => dir.replace(/\//g, "-");

/** Central cluster whose Argo CD / pipeline manages a group of remote clusters (never a standby). */
function managerOf(cfg: PlannerConfig, central: CentralCluster[], g: RemoteGroup): CentralCluster | undefined {
  return central.find((c) => c.role === "active" && c.serves.includes(g.env) && (cfg.multiRegion.model === "regional" ? c.region === g.region : c.region === cfg.platform.region));
}

function argoFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const c of central) {
    const project = c.name;
    files.push({
      path: `argocd/projects/${project}.yaml`,
      content: y(`Argo CD project for ${c.name} and its remote clusters`, {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "AppProject",
        metadata: { name: project, namespace: "argocd" },
        spec: {
          sourceRepos: [repoUrl(cfg), ...new Set(Object.values(HELM_REPOS).map((u) => u.replace("oci://", "")))],
          destinations: [{ server: "*", namespace: "*" }],
          clusterResourceWhitelist: [{ group: "*", kind: "*" }],
        },
      }),
    });
    const standby = c.role === "standby";
    const standbyNote = standby ? " STANDBY: no automated sync; on failover run `argocd app sync -l standby=" + c.name + "` or enable automated sync." : "";
    for (const r of centralReleases(cfg, c)) {
      const app = argoApplication(cfg, r, project, "https://kubernetes.default.svc", `${r.name}-${c.name}`, standby) as { metadata: Record<string, unknown> };
      if (standby) app.metadata.labels = { standby: c.name };
      files.push({ path: `argocd/apps/${c.name}/${r.name}.yaml`, content: y(`${r.name} on ${c.name}.${standbyNote}`, app) });
    }
    files.push({
      path: `argocd/apps/${c.name}/manifests.yaml`,
      content: y(`Plain manifests (routes, secrets, storage classes, operators' resources) for ${c.name}`, {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: { name: `manifests-${c.name}`, namespace: "argocd", annotations: { "argocd.argoproj.io/sync-wave": "-1" }, ...(standby ? { labels: { standby: c.name } } : {}) },
        spec: {
          project,
          source: { repoURL: repoUrl(cfg), targetRevision: "main", path: `manifests/central/${c.dir}`, directory: { recurse: true } },
          destination: { server: "https://kubernetes.default.svc", namespace: NS },
          syncPolicy: standby ? { syncOptions: ["CreateNamespace=true", "ServerSideApply=true"] } : { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true", "ServerSideApply=true"] },
        },
      }),
    });

    // Remote clusters: one ApplicationSet per release and group. Register clusters in Argo CD with the
    // labels environment=<env>, role=remote (and region=<code> for regional stacks).
    const groups = remoteGroups(cfg).filter((g) => managerOf(cfg, central, g) === c);
    for (const g of groups) {
      const labels: Record<string, string> = { environment: g.env, role: "remote", ...(cfg.multiRegion.model === "regional" ? { region: regionInfo(cfg, g.region).short } : {}) };
      const selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(", ");
      for (const r of remoteReleases(cfg, g)) {
        const app = argoApplication(cfg, r, project, "{{server}}", `${r.name}-{{name}}`) as { metadata: unknown; spec: unknown };
        files.push({
          path: `argocd/applicationsets/${slug(g.dir)}-remote-${r.name}.yaml`,
          content: y(`${r.name} on every ${g.dir} remote cluster (Argo CD cluster labels: ${selector})`, {
            apiVersion: "argoproj.io/v1alpha1",
            kind: "ApplicationSet",
            metadata: { name: `${slug(g.dir)}-remote-${r.name}`, namespace: "argocd" },
            spec: {
              goTemplate: false,
              generators: [{ clusters: { selector: { matchLabels: labels } } }],
              template: { metadata: app.metadata, spec: app.spec },
            },
          }),
        });
      }
      files.push({
        path: `argocd/applicationsets/${slug(g.dir)}-remote-manifests.yaml`,
        content: y(`Per-cluster credentials for every ${g.dir} remote cluster`, {
          apiVersion: "argoproj.io/v1alpha1",
          kind: "ApplicationSet",
          metadata: { name: `${slug(g.dir)}-remote-manifests`, namespace: "argocd" },
          spec: {
            generators: [{ clusters: { selector: { matchLabels: labels } } }],
            template: {
              metadata: { name: "manifests-{{name}}", annotations: { "argocd.argoproj.io/sync-wave": "-1" } },
              spec: {
                project,
                source: { repoURL: repoUrl(cfg), targetRevision: "main", path: `manifests/remote/${g.env}/clusters/{{name}}` },
                destination: { server: "{{server}}", namespace: NS },
                syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true"] },
              },
            },
          },
        }),
      });
    }

    files.push({
      path: `argocd/bootstrap/${c.name}.yaml`,
      content: y(`App of apps: apply once with kubectl on ${c.name}; Argo CD manages everything else`, {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: { name: `bootstrap-${c.name}`, namespace: "argocd" },
        spec: {
          project: "default",
          source: { repoURL: repoUrl(cfg), targetRevision: "main", path: "argocd", directory: { recurse: true, include: `{projects/${project}.yaml,apps/${c.name}/*.yaml${groups.length ? `,applicationsets/{${groups.map((g) => slug(g.dir)).join(",")}}-remote-*.yaml` : ""}}` } },
          destination: { server: "https://kubernetes.default.svc", namespace: "argocd" },
          syncPolicy: { automated: { prune: true, selfHeal: true } },
        },
      }),
    });
  }
  return files;
}

// ------------------------------------------------------------------ Flux
function fluxClusterFiles(cfg: PlannerConfig, clusterName: string, releases: Release[], manifestsPath: string, suspend = false): GeneratedFile[] {
  const dir = `flux/clusters/${clusterName}`;
  const repos = [...new Set(releases.map((r) => r.chart.repo))];
  const sources = [
    { apiVersion: "source.toolkit.fluxcd.io/v1", kind: "GitRepository", metadata: { name: "platform", namespace: "flux-system" }, spec: { interval: "5m", url: repoUrl(cfg), ref: { branch: "main" } } },
    ...repos.map((id) => {
      const url = HELM_REPOS[id];
      return { apiVersion: "source.toolkit.fluxcd.io/v1", kind: "HelmRepository", metadata: { name: id, namespace: "flux-system" }, spec: { interval: "1h", url, ...(url.startsWith("oci://") ? { type: "oci" } : {}) } };
    }),
  ];
  const cmName = (r: Release, i: number) => `${r.name}-values-${i}`;
  const helmReleases = releases.map((r) => ({
    apiVersion: "helm.toolkit.fluxcd.io/v2",
    kind: "HelmRelease",
    metadata: { name: r.name, namespace: r.namespace },
    spec: {
      interval: "10m",
      ...(suspend ? { suspend: true } : {}),
      releaseName: r.name,
      chart: { spec: { chart: r.chart.chart, version: r.chart.version, sourceRef: { kind: "HelmRepository", name: r.chart.repo, namespace: "flux-system" } } },
      install: { createNamespace: true, crds: "CreateReplace" },
      upgrade: { crds: "CreateReplace" },
      valuesFrom: r.valueFiles.map((_, i) => ({ kind: "ConfigMap", name: cmName(r, i), valuesKey: "values.yaml" })),
    },
  }));
  const kustomization = {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    resources: ["sources.yaml", "releases.yaml", `../../../${manifestsPath}`],
    configMapGenerator: releases.flatMap((r) =>
      r.valueFiles.map((f, i) => ({ name: cmName(r, i), namespace: r.namespace, files: [`values.yaml=../../../${f}`], options: { disableNameSuffixHash: true } })),
    ),
  };
  return [
    { path: `${dir}/sources.yaml`, content: y(`Git and Helm sources for ${clusterName}`, ...sources) },
    { path: `${dir}/releases.yaml`, content: y(`Helm releases on ${clusterName}${suspend ? ". STANDBY: suspended; on failover run `flux resume helmrelease --all -A`" : ""}`, ...helmReleases) },
    { path: `${dir}/kustomization.yaml`, content: y(`Entry point for Flux on ${clusterName} (flux bootstrap --path=${dir})`, kustomization) },
  ];
}

function fluxFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const c of central) files.push(...fluxClusterFiles(cfg, c.name, centralReleases(cfg, c), `manifests/central/${c.dir}`, c.role === "standby"));
  for (const r of remoteClusters(cfg)) files.push(...fluxClusterFiles(cfg, r.name, remoteReleases(cfg, groupOf(cfg, r), r.name), `manifests/remote/${r.env}/clusters/${r.name}`));
  return files;
}

// ------------------------------------------------------------------ scripts + pipelines
function helmCommands(rels: Release[]): string {
  const repos = [...new Set(rels.filter((r) => !isOci(r)).map((r) => r.chart.repo))];
  const lines = repos.map((id) => `helm repo add ${id} ${HELM_REPOS[id]} --force-update`);
  lines.push("helm repo update");
  for (const r of rels) {
    const ref = isOci(r) ? `${HELM_REPOS[r.chart.repo]}/${r.chart.chart}` : `${r.chart.repo}/${r.chart.chart}`;
    const f = r.valueFiles.map((v) => `-f ${v}`).join(" ");
    lines.push(`helm upgrade --install ${r.name} ${ref} --version ${r.chart.version} -n ${r.namespace} --create-namespace ${f} --wait --timeout 15m`.replace(/\s+/g, " ").trim());
  }
  return lines.join("\n");
}

function scriptFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const c of central) {
    const rels = centralReleases(cfg, c);
    const addons = rels.filter((r) => r.wave < 0);
    const comps = rels.filter((r) => r.wave >= 0);
    files.push({
      path: `scripts/deploy-${c.name}.sh`,
      content: `#!/usr/bin/env bash
# Deploys everything on ${c.name}. Run with kubectl pointing at that cluster.${c.role === "standby" ? "\n# STANDBY region: run this only on failover (see README, 'Failover runbook')." : ""}
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Add-ons (CRDs and operators the rest depends on)
${helmCommands(addons) || "# none"}

# 2. Plain manifests: namespace, storage classes, secrets, routes, Kafka/ClickHouse resources
kubectl apply --server-side -R -f manifests/central/${c.dir}/

# 3. Observability components
${helmCommands(comps)}
`,
    });
  }
  for (const g of remoteGroups(cfg)) {
    const rels = remoteReleases(cfg, g, "${CLUSTER}");
    files.push({
      path: `scripts/deploy-remote-${slug(g.dir)}.sh`,
      content: `#!/usr/bin/env bash
# Deploys the collectors on one ${g.dir} remote cluster: ./deploy-remote-${slug(g.dir)}.sh <cluster-name>
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER="\${1:?usage: $0 <cluster-name>}"

kubectl apply --server-side -R -f "manifests/remote/${g.env}/clusters/\${CLUSTER}/"
${helmCommands(rels)}
`,
    });
  }
  return files;
}

function cloudLoginSteps(cfg: PlannerConfig, kind: "github" | "azure-devops" | "gitlab", cluster: string): string {
  const cloud = cfg.platform.cloud;
  if (kind === "github") {
    if (cloud === "azure")
      return `      - uses: azure/login@v2\n        with:\n          client-id: \${{ vars.AZURE_CLIENT_ID }}\n          tenant-id: \${{ vars.AZURE_TENANT_ID }}\n          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}\n      - run: az aks get-credentials -g \${{ vars.RESOURCE_GROUP }} -n ${cluster} && kubelogin convert-kubeconfig -l azurecli`;
    if (cloud === "aws")
      return `      - uses: aws-actions/configure-aws-credentials@v6\n        with:\n          role-to-assume: \${{ vars.AWS_DEPLOY_ROLE_ARN }}\n          aws-region: ${cfg.platform.region}\n      - run: aws eks update-kubeconfig --name ${cluster} --region ${cfg.platform.region}`;
    return `      - uses: google-github-actions/auth@v3\n        with:\n          workload_identity_provider: \${{ vars.GCP_WIF_PROVIDER }}\n          service_account: \${{ vars.GCP_DEPLOY_SA }}\n      - uses: google-github-actions/get-gke-credentials@v3\n        with:\n          cluster_name: ${cluster}\n          location: ${cfg.platform.region}`;
  }
  if (kind === "gitlab") {
    if (cloud === "azure") return `    - az login --service-principal -u "$AZURE_CLIENT_ID" -t "$AZURE_TENANT_ID" --federated-token "$GITLAB_OIDC_TOKEN"\n    - az aks get-credentials -g "$RESOURCE_GROUP" -n ${cluster}`;
    if (cloud === "aws") return `    - export $(aws sts assume-role-with-web-identity --role-arn "$AWS_DEPLOY_ROLE_ARN" --role-session-name gitlab --web-identity-token "$GITLAB_OIDC_TOKEN" --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text | awk '{print "AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3}')\n    - aws eks update-kubeconfig --name ${cluster} --region ${cfg.platform.region}`;
    return `    - echo "$GITLAB_OIDC_TOKEN" > token.txt && gcloud iam workload-identity-pools create-cred-config "$GCP_WIF_PROVIDER" --service-account="$GCP_DEPLOY_SA" --credential-source-file=token.txt --output-file=cred.json && gcloud auth login --cred-file=cred.json\n    - gcloud container clusters get-credentials ${cluster} --region ${cfg.platform.region}`;
  }
  // Azure DevOps
  if (cloud === "azure") return `AzureCLI@2`;
  return "";
}

function pipelineFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const method = cfg.delivery.method;
  const targets = [
    ...central.filter((c) => c.role === "active").map((c) => ({ cluster: c.name, env: c.env === "shared" ? cfg.environments[cfg.environments.length - 1] : c.env, script: `./scripts/deploy-${c.name}.sh`, central: true })),
    ...remoteClusters(cfg).map((r) => ({ cluster: r.name, env: r.env, script: `./scripts/deploy-remote-${slug(groupOf(cfg, r).dir)}.sh ${r.name}`, central: false })),
  ];

  if (method === "github-actions") {
    const jobs = targets
      .map((t) => {
        const id = t.cluster.replace(/[^a-z0-9-]/g, "-");
        const needs = t.central ? "" : `\n    needs: [${central.find((c) => c.serves.includes(t.env))?.name}]`;
        return `  ${id}:${needs}\n    runs-on: ubuntu-latest\n    environment: ${t.env}\n    permissions: { id-token: write, contents: read }\n    steps:\n      - uses: actions/checkout@v7\n      - uses: azure/setup-helm@v5\n${cloudLoginSteps(cfg, "github", t.cluster)}\n      - run: ${t.script}`;
      })
      .join("\n\n");
    return [{ path: ".github/workflows/deploy.yml", content: `# Deploys the observability platform. Protect production with required reviewers on the "${cfg.environments[cfg.environments.length - 1]}" environment.\nname: Deploy observability\non:\n  push:\n    branches: [main]\n  workflow_dispatch: {}\n\njobs:\n${jobs}\n` }];
  }

  if (method === "gitlab-ci") {
    const jobs = targets
      .map((t) => `deploy:${t.cluster}:\n  stage: ${t.central ? "central" : "remote"}\n  image: alpine/k8s:1.34.1\n  environment: ${t.env}\n  id_tokens:\n    GITLAB_OIDC_TOKEN:\n      aud: ${cfg.platform.cloud === "aws" ? "sts.amazonaws.com" : "https://gitlab.com"}\n${/prod/.test(t.env) ? "  when: manual\n" : ""}  script:\n${cloudLoginSteps(cfg, "gitlab", t.cluster)}\n    - ${t.script}`)
      .join("\n\n");
    return [{ path: ".gitlab-ci.yml", content: `# Deploys the observability platform; production jobs need a manual start.\nstages: [central, remote]\n\n${jobs}\n` }];
  }

  if (method === "azure-devops") {
    const svc = cfg.platform.cloud === "azure" ? "AzureRM service connection" : `${CLOUDS[cfg.platform.cloud].short} credentials`;
    const stages = cfg.environments
      .map((env) => {
        const ts = targets.filter((t) => t.env === env);
        const jobs = ts
          .map(
            (t) =>
              `      - deployment: ${t.cluster.replace(/[^a-zA-Z0-9_]/g, "_")}\n        environment: ${env}\n        strategy:\n          runOnce:\n            deploy:\n              steps:\n                - checkout: self\n                - task: HelmInstaller@1\n${
                cfg.platform.cloud === "azure"
                  ? `                - task: AzureCLI@2\n                  inputs:\n                    azureSubscription: $(SERVICE_CONNECTION)\n                    scriptType: bash\n                    scriptLocation: inlineScript\n                    inlineScript: |\n                      az aks get-credentials -g $(RESOURCE_GROUP) -n ${t.cluster}\n                      ${t.script}`
                  : `                - bash: |\n                    # log in to ${CLOUDS[cfg.platform.cloud].short} with the ${svc} and fetch the kubeconfig of ${t.cluster}\n                    ${t.script}`
              }`,
          )
          .join("\n");
        return `  - stage: ${env.replace(/[^a-zA-Z0-9_]/g, "_")}\n    jobs:\n${jobs}`;
      })
      .join("\n");
    return [{ path: "pipelines/azure-pipelines.yml", content: `# Deploys the observability platform, one stage per environment. Add approvals on the Azure DevOps environments.\ntrigger:\n  branches:\n    include: [main]\n\nvariables:\n  SERVICE_CONNECTION: <service-connection-name>\n  RESOURCE_GROUP: <resource-group>\n\nstages:\n${stages}\n` }];
  }
  return [];
}

/** Values files for the add-ons (cert-manager, external-dns, …). */
function addonValueFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files = new Map<string, GeneratedFile>();
  const all = [...central.flatMap((c) => addonReleases(cfg, c)), ...addonReleases(cfg, null)];
  for (const r of all) if (r.inline) files.set(r.valueFiles[0], { path: r.valueFiles[0], content: y(`${r.name} add-on settings`, r.inline) });
  return [...files.values()];
}

export function deliveryFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files = [...scriptFiles(cfg, central), ...addonValueFiles(cfg, central)];
  if (cfg.delivery.method === "argocd") files.push(...argoFiles(cfg, central));
  else if (cfg.delivery.method === "flux") files.push(...fluxFiles(cfg, central));
  else files.push(...pipelineFiles(cfg, central), ...failoverPipelineFiles(cfg, central));
  return files;
}

/** Pipelines only run when started by hand: they deploy the standby region on failover. */
function failoverPipelineFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const standby = central.filter((c) => c.role === "standby");
  if (!standby.length) return [];
  const method = cfg.delivery.method;
  if (method === "github-actions") {
    const jobs = standby
      .map((c) => `  ${c.name}:\n    if: inputs.confirm == 'FAILOVER'\n    runs-on: ubuntu-latest\n    environment: failover\n    permissions: { id-token: write, contents: read }\n    steps:\n      - uses: actions/checkout@v7\n      - uses: azure/setup-helm@v5\n${cloudLoginSteps(c.cfg, "github", c.name)}\n      - run: ./scripts/deploy-${c.name}.sh`)
      .join("\n\n");
    return [{ path: ".github/workflows/failover.yml", content: `# FAILOVER: deploys the standby region. Start it by hand (Actions → Failover → Run workflow) only when the primary region is down.\nname: Failover to standby region\non:\n  workflow_dispatch:\n    inputs:\n      confirm:\n        description: Type FAILOVER to confirm\n        required: true\n\njobs:\n${jobs}\n` }];
  }
  if (method === "gitlab-ci") {
    const jobs = standby
      .map((c) => `failover:${c.name}:\n  stage: failover\n  image: alpine/k8s:1.34.1\n  environment: failover\n  when: manual\n  id_tokens:\n    GITLAB_OIDC_TOKEN:\n      aud: ${cfg.platform.cloud === "aws" ? "sts.amazonaws.com" : "https://gitlab.com"}\n  script:\n${cloudLoginSteps(c.cfg, "gitlab", c.name)}\n    - ./scripts/deploy-${c.name}.sh`)
      .join("\n\n");
    return [{ path: "ci/failover.gitlab-ci.yml", content: `# FAILOVER jobs (manual). Include from .gitlab-ci.yml (include: ci/failover.gitlab-ci.yml) and add "failover" to stages.\n${jobs}\n` }];
  }
  if (method === "azure-devops") {
    const steps = standby
      .map((c) => `      - deployment: ${c.name.replace(/[^a-zA-Z0-9_]/g, "_")}\n        environment: failover\n        strategy:\n          runOnce:\n            deploy:\n              steps:\n                - checkout: self\n                - task: HelmInstaller@1\n                - bash: |\n                    # log in and fetch the kubeconfig of ${c.name} (region ${c.region}) first\n                    ./scripts/deploy-${c.name}.sh`)
      .join("\n");
    return [{ path: "pipelines/failover-pipelines.yml", content: `# FAILOVER: deploys the standby region. Run manually only when the primary region is down; add an approval on the "failover" environment.\ntrigger: none\n\nstages:\n  - stage: failover\n    jobs:\n${steps}\n` }];
  }
  return [];
}
