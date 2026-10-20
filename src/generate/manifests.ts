import { stringify } from "yaml";
import { STORAGE_CLASSES } from "../catalog/storage";
import type { ComponentId, PlannerConfig } from "../model/types";
import { vpaSnippet } from "./autoscaling";
import {
  centralClusters,
  centralWorkloads,
  keyVaultName,
  designComponents,
  hostOf,
  isCentral,
  isRemote,
  NS,
  remoteClusters,
  remoteWorkloads,
  storageClassOf,
  tenantOfRemote,
  tenantsFor,
  type CentralCluster,
  type GeneratedFile,
} from "./common";

type Doc = Record<string, unknown>;
const docs = (header: string, ...items: Doc[]): string => `# ${header}\n` + items.map((d) => stringify(d, { lineWidth: 0 })).join("---\n");

// ------------------------------------------------------------------ storage classes
function storageClassDoc(cfg: PlannerConfig, name: string): Doc | null {
  const info = STORAGE_CLASSES[cfg.platform.cloud].find((s) => s.name === name);
  if (!info || info.builtIn) return null;
  const base = { apiVersion: "storage.k8s.io/v1", kind: "StorageClass", metadata: { name }, volumeBindingMode: "WaitForFirstConsumer", allowVolumeExpansion: true, reclaimPolicy: "Delete" };
  const azureSku: Record<string, string> = {
    "premium-ssd-v2": "PremiumV2_LRS",
    "managed-csi-premium-zrs": "Premium_ZRS",
    "managed-csi-standard-zrs": "StandardSSD_ZRS",
    "ultra-disk": "UltraSSD_LRS",
    "managed-csi-hdd": "Standard_LRS",
  };
  const awsType: Record<string, string> = { gp3: "gp3", io2: "io2", io1: "io1", st1: "st1", sc1: "sc1" };
  const gcpType: Record<string, Record<string, string>> = {
    "hyperdisk-balanced": { type: "hyperdisk-balanced" },
    "hyperdisk-balanced-ha": { type: "hyperdisk-balanced-high-availability", "replication-type": "regional-pd" },
    "regional-pd-ssd": { type: "pd-ssd", "replication-type": "regional-pd" },
    "hyperdisk-extreme": { type: "hyperdisk-extreme" },
    "hyperdisk-throughput": { type: "hyperdisk-throughput" },
  };
  if (cfg.platform.cloud === "azure" && azureSku[name]) return { ...base, provisioner: "disk.csi.azure.com", parameters: { skuName: azureSku[name], cachingMode: name === "premium-ssd-v2" || name === "ultra-disk" ? "None" : "ReadOnly" } };
  if (cfg.platform.cloud === "aws" && awsType[name]) return { ...base, provisioner: "ebs.csi.aws.com", parameters: { type: awsType[name], encrypted: "true", ...(name === "io2" || name === "io1" ? { iopsPerGB: "50" } : {}) } };
  if (cfg.platform.cloud === "aws" && name === "efs-sc") return { ...base, provisioner: "efs.csi.aws.com", parameters: { provisioningMode: "efs-ap", fileSystemId: "<efs-file-system-id>", directoryPerms: "700" } };
  if (cfg.platform.cloud === "gcp" && gcpType[name]) return { ...base, provisioner: "pd.csi.storage.gke.io", parameters: gcpType[name] };
  if (name === "local-nvme" || name === "local-ssd")
    return { ...base, provisioner: "kubernetes.io/no-provisioner", reclaimPolicy: "Retain", metadata: { name, annotations: { "note": "Local disks need a local volume provisioner (e.g. local-static-provisioner) on nodes with NVMe." } } };
  return null;
}

// ------------------------------------------------------------------ routes (Gateway API or Ingress)
interface Route {
  id: ComponentId;
  host: string;
  rules: { path: string; service: string; port: number }[];
}

function routesFor(cfg: PlannerConfig, c: CentralCluster): Route[] {
  const ids = designComponents(cfg).map((d) => d.id);
  const has = (id: ComponentId, wl: string) => centralWorkloads(c, id).some((w) => w.def.id === wl);
  const routes: Route[] = [];
  if (ids.includes("grafana")) routes.push({ id: "grafana", host: hostOf(cfg, "grafana"), rules: [{ path: "/", service: "grafana", port: 80 }] });
  if (ids.includes("mimir"))
    routes.push({
      id: "mimir",
      host: hostOf(cfg, "mimir"),
      rules: has("mimir", "gateway")
        ? [{ path: "/", service: "mimir-gateway", port: 80 }]
        : [
            { path: "/api/v1/push", service: "mimir-distributor", port: 8080 },
            { path: "/prometheus", service: "mimir-query-frontend", port: 8080 },
          ],
    });
  if (ids.includes("loki"))
    routes.push({
      id: "loki",
      host: hostOf(cfg, "loki"),
      rules: has("loki", "gateway")
        ? [{ path: "/", service: "loki-gateway", port: 80 }]
        : cfg.components.loki.options.mode === "distributed"
          ? [
              { path: "/loki/api/v1/push", service: "loki-distributor", port: 3100 },
              { path: "/loki/api", service: "loki-query-frontend", port: 3100 },
            ]
          : [{ path: "/", service: cfg.components.loki.options.mode === "monolithic" ? "loki" : "loki-write", port: 3100 }],
    });
  if (ids.includes("tempo")) {
    const distributed = cfg.components.tempo.options.mode === "distributed";
    routes.push({
      id: "tempo",
      host: hostOf(cfg, "tempo"),
      rules:
        distributed && has("tempo", "gateway")
          ? [{ path: "/", service: "tempo-gateway", port: 80 }]
          : [{ path: "/v1/traces", service: distributed ? "tempo-distributor" : "tempo", port: 4318 }],
    });
  }
  if (ids.includes("pyroscope"))
    routes.push({ id: "pyroscope", host: hostOf(cfg, "pyroscope"), rules: [{ path: "/", service: cfg.components.pyroscope.options.mode === "distributed" ? "pyroscope-distributor" : "pyroscope", port: 4040 }] });
  if (ids.includes("langfuse")) routes.push({ id: "langfuse", host: hostOf(cfg, "langfuse"), rules: [{ path: "/", service: "langfuse-web", port: 3000 }] });
  return routes;
}

function gatewayClass(cfg: PlannerConfig): string | null {
  const ing = cfg.connectivity.ingress;
  if (ing === "envoy-gateway") return "envoy";
  if (ing === "istio") return "istio";
  if (ing === "cloud-native" && cfg.platform.cloud === "azure") return "azure-alb-external";
  if (ing === "cloud-native" && cfg.platform.cloud === "gcp") return cfg.connectivity.path === "private" ? "gke-l7-rilb" : "gke-l7-global-external-managed";
  return null;
}

function ingressClass(cfg: PlannerConfig): string {
  const ing = cfg.connectivity.ingress;
  return ing === "haproxy" ? "haproxy" : ing === "traefik" ? "traefik" : ing === "ingress-nginx" ? "nginx" : "alb";
}

function routeDocs(cfg: PlannerConfig, c: CentralCluster): Doc[] {
  const routes = routesFor(cfg, c);
  const tls = cfg.connectivity.tls;
  const secretFor = (r: Route) => (tls === "existing" ? "wildcard-tls" : `${r.id}-tls`);
  const out: Doc[] = [];
  const gc = gatewayClass(cfg);

  if (tls === "cert-manager")
    out.push({
      apiVersion: "cert-manager.io/v1",
      kind: "ClusterIssuer",
      metadata: { name: "letsencrypt" },
      spec: {
        acme: {
          server: "https://acme-v02.api.letsencrypt.org/directory",
          email: "<your-email>",
          privateKeySecretRef: { name: "letsencrypt-account" },
          solvers: [gc ? { http01: { gatewayHTTPRoute: { parentRefs: [{ name: "observability", namespace: NS, kind: "Gateway" }] } } } : { http01: { ingress: { ingressClassName: ingressClass(cfg) } } }],
        },
      },
    });

  if (gc) {
    const terminateInCluster = tls !== "edge-managed";
    out.push({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "Gateway",
      metadata: { name: "observability", namespace: NS, annotations: tls === "cert-manager" ? { "cert-manager.io/cluster-issuer": "letsencrypt" } : undefined },
      spec: {
        gatewayClassName: gc,
        listeners: routes.map((r) =>
          terminateInCluster
            ? { name: r.id, hostname: r.host, port: 443, protocol: "HTTPS", tls: { mode: "Terminate", certificateRefs: [{ name: secretFor(r) }] }, allowedRoutes: { namespaces: { from: "Same" } } }
            : { name: r.id, hostname: r.host, port: 80, protocol: "HTTP", allowedRoutes: { namespaces: { from: "Same" } } },
        ),
      },
    });
    for (const r of routes)
      out.push({
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "HTTPRoute",
        metadata: { name: r.id, namespace: NS },
        spec: {
          parentRefs: [{ name: "observability", sectionName: r.id }],
          hostnames: [r.host],
          rules: r.rules.map((x) => ({ matches: [{ path: { type: "PathPrefix", value: x.path } }], backendRefs: [{ name: x.service, port: x.port }] })),
        },
      });
    if (cfg.connectivity.auth === "mtls" && cfg.connectivity.ingress === "envoy-gateway")
      out.push({
        apiVersion: "gateway.envoyproxy.io/v1alpha1",
        kind: "ClientTrafficPolicy",
        metadata: { name: "remote-clusters-mtls", namespace: NS },
        spec: { targetRefs: [{ group: "gateway.networking.k8s.io", kind: "Gateway", name: "observability" }], tls: { clientValidation: { caCertificateRefs: [{ kind: "Secret", name: "remote-clusters-ca" }] } } },
      });
    return out;
  }

  // Ingress-based controllers
  const albAnnotations =
    cfg.connectivity.ingress === "cloud-native"
      ? {
          "alb.ingress.kubernetes.io/scheme": cfg.connectivity.path === "private" ? "internal" : "internet-facing",
          "alb.ingress.kubernetes.io/target-type": "ip",
          "alb.ingress.kubernetes.io/group.name": "observability",
          ...(tls === "edge-managed" ? { "alb.ingress.kubernetes.io/certificate-arn": "<acm-certificate-arn>", "alb.ingress.kubernetes.io/listen-ports": '[{"HTTPS":443}]' } : {}),
        }
      : {};
  for (const r of routes)
    out.push({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: r.id, namespace: NS, annotations: { ...(tls === "cert-manager" ? { "cert-manager.io/cluster-issuer": "letsencrypt" } : {}), ...albAnnotations } },
      spec: {
        ingressClassName: ingressClass(cfg),
        tls: tls === "edge-managed" ? undefined : [{ hosts: [r.host], secretName: secretFor(r) }],
        rules: [{ host: r.host, http: { paths: r.rules.map((x) => ({ path: x.path, pathType: "Prefix", backend: { service: { name: x.service, port: { number: x.port } } } })) } }],
      },
    });
  return out;
}

// ------------------------------------------------------------------ secrets
interface SecretSpec {
  name: string;
  keys: string[];
  namespace?: string;
  note: string;
}

function centralSecrets(cfg: PlannerConfig, c: CentralCluster): SecretSpec[] {
  const ids = designComponents(cfg).map((d) => d.id);
  const s: SecretSpec[] = [];
  if (ids.includes("grafana")) {
    s.push({ name: "grafana-admin", keys: ["admin-user", "admin-password"], note: "Grafana admin login" });
    const env: string[] = [];
    if (cfg.components.grafana.options.ha === "ha") env.push("GF_DATABASE_HOST", "GF_DATABASE_USER", "GF_DATABASE_PASSWORD");
    if (cfg.components.grafana.options.auth === "oidc") env.push("GF_OIDC_CLIENT_ID", "GF_OIDC_CLIENT_SECRET");
    if (env.length) s.push({ name: "grafana-env", keys: env, note: "Grafana database and SSO settings" });
  }
  if (cfg.connectivity.auth === "basic") s.push({ name: "gateway-htpasswd", keys: [".htpasswd"], note: `htpasswd with one user per tenant (${tenantsFor(cfg, c).slice(0, 3).join(", ")}…)` });
  if (cfg.connectivity.auth === "mtls") s.push({ name: "remote-clusters-ca", keys: ["ca.crt"], note: "CA that signed the remote clusters' client certificates" });
  if (cfg.connectivity.tls === "existing") s.push({ name: "wildcard-tls", keys: ["tls.crt", "tls.key"], note: "Existing wildcard certificate" });
  if (ids.includes("langfuse")) {
    const o = cfg.components.langfuse.options;
    s.push({ name: "langfuse", keys: ["salt", "nextauth-secret", "encryption-key"], note: "Langfuse application secrets" });
    if (o.postgres === "managed") s.push({ name: "langfuse-db", keys: ["password"], note: "Langfuse PostgreSQL password" });
    if (o.redis === "managed") s.push({ name: "langfuse-redis", keys: ["password"], note: "Langfuse Redis password" });
    if (o.clickhouse !== "bundled") s.push({ name: "langfuse-clickhouse", keys: ["password"], note: "Langfuse ClickHouse password" });
  }
  if (ids.includes("robusta")) s.push({ name: "robusta", keys: ["signing-key", "llm-api-key"], note: "Robusta signing key and LLM API key" });
  return s;
}

/** Name of the secret in the cloud secret store. */
const remoteKey = (cluster: string, name: string, key: string) => `${cluster}--${name}--${key}`.replace(/[^a-zA-Z0-9-]/g, "-");

function secretStoreDoc(cfg: PlannerConfig, vault: string): Doc {
  const provider =
    cfg.platform.cloud === "azure"
      ? { azurekv: { authType: "WorkloadIdentity", vaultUrl: `https://${vault}.vault.azure.net`, serviceAccountRef: { name: "external-secrets", namespace: "external-secrets" } } }
      : cfg.platform.cloud === "aws"
        ? { aws: { service: "SecretsManager", region: cfg.platform.region } }
        : { gcpsm: { projectID: "<gcp-project-id>" } };
  return { apiVersion: "external-secrets.io/v1", kind: "ClusterSecretStore", metadata: { name: "cloud-secrets" }, spec: { provider } };
}

function externalSecretDocs(cluster: string, specs: SecretSpec[]): Doc[] {
  return specs.map((sp) => ({
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: { name: sp.name, namespace: sp.namespace ?? NS, annotations: { description: sp.note } },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: { kind: "ClusterSecretStore", name: "cloud-secrets" },
      target: { name: sp.name },
      data: sp.keys.map((k) => ({ secretKey: k, remoteRef: { key: remoteKey(cluster, sp.name, k) } })),
    },
  }));
}

function csiDocs(cfg: PlannerConfig, cluster: string, specs: SecretSpec[], vault: string): Doc[] {
  const provider = cfg.platform.cloud === "azure" ? "azure" : cfg.platform.cloud === "aws" ? "aws" : "gcp";
  return specs.map((sp) => {
    const objects = sp.keys.map((k) => remoteKey(cluster, sp.name, k));
    const parameters =
      provider === "azure"
        ? { keyvaultName: vault, clientID: "<terraform output secrets_client_id>", tenantId: "<tenant-id>", objects: stringify({ array: objects.map((o) => stringify({ objectName: o, objectType: "secret" })) }) }
        : provider === "aws"
          ? { objects: stringify(objects.map((o) => ({ objectName: o, objectType: "secretsmanager" }))) }
          : { secrets: stringify(objects.map((o) => ({ resourceName: `projects/<gcp-project-id>/secrets/${o}/versions/latest`, path: o }))) };
    return {
      apiVersion: "secrets-store.csi.x-k8s.io/v1",
      kind: "SecretProviderClass",
      metadata: { name: sp.name, namespace: sp.namespace ?? NS },
      spec: { provider, parameters, secretObjects: [{ secretName: sp.name, type: "Opaque", data: sp.keys.map((k, i) => ({ key: k, objectName: objects[i] })) }] },
    };
  });
}

function secretDocs(cfg: PlannerConfig, cluster: string, specs: SecretSpec[], vault: string): Doc[] {
  return cfg.connectivity.secrets === "eso" ? externalSecretDocs(cluster, specs) : csiDocs(cfg, cluster, specs, vault);
}

// ------------------------------------------------------------------ Kafka (Strimzi) and ClickHouse (Altinity)
function strimziDocs(c: CentralCluster): Doc[] {
  const ws = centralWorkloads(c, "kafka");
  const broker = ws.find((w) => w.def.id === "kafka-broker");
  const ctrl = ws.find((w) => w.def.id === "kafka-controller");
  if (!broker) return [];
  const pool = (name: string, role: string, w: typeof broker) => ({
    apiVersion: "kafka.strimzi.io/v1",
    kind: "KafkaNodePool",
    metadata: { name, namespace: NS, labels: { "strimzi.io/cluster": "kafka" } },
    spec: {
      replicas: w.final.replicas,
      roles: [role],
      storage: { type: "jbod", volumes: [{ id: 0, type: "persistent-claim", size: `${w.final.pvcGi}Gi`, class: storageClassOf(c.cfg, "kafka"), deleteClaim: false, kraftMetadata: "shared" }] },
      resources: { requests: { cpu: String(w.final.cpu), memory: `${w.final.memoryGi}Gi` } },
    },
  });
  return [
    pool("controller", "controller", ctrl ?? broker),
    pool("broker", "broker", broker),
    {
      apiVersion: "kafka.strimzi.io/v1",
      kind: "Kafka",
      metadata: { name: "kafka", namespace: NS },
      spec: {
        kafka: {
          listeners: [{ name: "plain", port: 9092, type: "internal", tls: false }],
          config: {
            "offsets.topic.replication.factor": 3,
            "default.replication.factor": 3,
            "min.insync.replicas": 2,
            "log.retention.hours": 24,
          },
        },
        entityOperator: { topicOperator: {} },
      },
    },
  ];
}

function clickhouseDocs(cfg: PlannerConfig, c: CentralCluster): Doc[] {
  const o = cfg.components.langfuse.options;
  if (o.clickhouse !== "operator") return [];
  const ns = String(o.clickhouseNamespace || "clickhouse");
  const ws = centralWorkloads(c, "langfuse");
  const ch = ws.find((w) => w.def.id === "clickhouse");
  const keeper = ws.find((w) => w.def.id === "clickhouse-keeper");
  const sc = storageClassOf(cfg, "langfuse");
  const out: Doc[] = [{ apiVersion: "v1", kind: "Namespace", metadata: { name: ns } }];
  if (keeper)
    out.push({
      apiVersion: "clickhouse-keeper.altinity.com/v1",
      kind: "ClickHouseKeeperInstallation",
      metadata: { name: "keeper", namespace: ns },
      spec: {
        configuration: { clusters: [{ name: "keeper", layout: { replicasCount: keeper.final.replicas } }] },
        defaults: { templates: { podTemplate: "keeper", dataVolumeClaimTemplate: "keeper-data" } },
        templates: {
          podTemplates: [{ name: "keeper", spec: { containers: [{ name: "clickhouse-keeper", resources: { requests: { cpu: String(keeper.final.cpu), memory: `${keeper.final.memoryGi}Gi` } } }] } }],
          volumeClaimTemplates: [{ name: "keeper-data", spec: { storageClassName: sc, accessModes: ["ReadWriteOnce"], resources: { requests: { storage: `${keeper.final.pvcGi}Gi` } } } }],
        },
      },
    });
  if (ch)
    out.push({
      apiVersion: "clickhouse.altinity.com/v1",
      kind: "ClickHouseInstallation",
      metadata: { name: "langfuse", namespace: ns },
      spec: {
        configuration: {
          ...(keeper ? { zookeeper: { nodes: [{ host: `keeper-keeper.${ns}.svc`, port: 2181 }] } } : {}),
          users: { "langfuse/k8s_secret_password": `${ns}/langfuse-clickhouse/password`, "langfuse/networks/ip": ["0.0.0.0/0"] },
          clusters: [{ name: "default", layout: { shardsCount: 1, replicasCount: ch.final.replicas } }],
        },
        defaults: { templates: { podTemplate: "clickhouse", dataVolumeClaimTemplate: "data" } },
        templates: {
          podTemplates: [{ name: "clickhouse", spec: { containers: [{ name: "clickhouse", image: "clickhouse/clickhouse-server:25.8", resources: { requests: { cpu: String(ch.final.cpu), memory: `${ch.final.memoryGi}Gi` } } }] } }],
          volumeClaimTemplates: [{ name: "data", spec: { storageClassName: sc, accessModes: ["ReadWriteOnce"], resources: { requests: { storage: `${ch.final.pvcGi}Gi` } } } }],
        },
      },
    });
  return out;
}

// ------------------------------------------------------------------ assemble
export function manifestFiles(cfg: PlannerConfig, central: CentralCluster[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const comps = designComponents(cfg);

  for (const c of central) {
    const dir = `manifests/central/${c.dir}`;
    const vault = keyVaultName(c.cfg, c.env);
    files.push({ path: `${dir}/namespace.yaml`, content: docs("Namespace for all observability components", { apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }) });

    const classes = [...new Set(comps.filter((x) => isCentral(x.id, cfg)).map((x) => storageClassOf(cfg, x.id)))]
      .map((n) => storageClassDoc(cfg, n))
      .filter((d): d is Doc => d !== null);
    if (classes.length) files.push({ path: `${dir}/storage-classes.yaml`, content: docs("Storage classes chosen in the planner that the cluster doesn't have built in", ...classes) });

    const routeDocsList = routeDocs(c.cfg, c);
    if (routeDocsList.length) files.push({ path: `${dir}/routes.yaml`, content: docs(`Hostnames, TLS and routing (${cfg.connectivity.ingress})`, ...routeDocsList) });

    const specs = centralSecrets(cfg, c);
    const storeDoc = cfg.connectivity.secrets === "eso" ? [secretStoreDoc(cfg, vault)] : [];
    if (specs.length) files.push({ path: `${dir}/secrets.yaml`, content: docs(`Secrets read from the cloud secret store (${cfg.connectivity.secrets === "eso" ? "External Secrets Operator" : "Secrets Store CSI driver"}). No secret values in Git.`, ...storeDoc, ...secretDocs(cfg, c.name, specs, vault)) });

    if (cfg.components.kafka.enabled && cfg.components.kafka.options.provider === "strimzi") {
      const k = strimziDocs(c);
      if (k.length) files.push({ path: `${dir}/kafka.yaml`, content: docs("Kafka (Strimzi, KRaft mode) for the ingest pipeline", ...k) });
    }
    if (cfg.components.langfuse.enabled) {
      const chDocs = clickhouseDocs(cfg, c);
      if (chDocs.length) files.push({ path: `${dir}/clickhouse.yaml`, content: docs("ClickHouse for Langfuse, managed by the Altinity operator in its own namespace", ...chDocs) });
    }

    // VPAs (as shown in the planner)
    for (const comp of comps.filter((x) => isCentral(x.id, cfg))) {
      for (const w of centralWorkloads(c, comp.id)) {
        const wc = cfg.components[comp.id].workloads?.[w.def.id] ?? {};
        const wantVpa = w.autoscaler === "vpa" || ((w.autoscaler === "hpa" || w.autoscaler === "keda") && wc.vpaAdvice);
        if (!wantVpa || !w.def.autoscalers.includes("vpa")) continue;
        const sn = vpaSnippet(c.cfg, comp.id, w, c.dir, w.autoscaler === "vpa" ? (wc.vpaMode ?? "Off") : "Off");
        if (!sn.file.endsWith("values.yaml")) files.push({ path: sn.file, content: `# ${sn.notes[1] ?? ""}\n${sn.yaml}\n` });
      }
    }
  }

  // Remote clusters: per-cluster credentials and storage classes
  for (const r of remoteClusters(cfg)) {
    // Remote clusters read their credentials from the vault of the central cluster they report to.
    const home = centralClusters(cfg).find((c) => c.role === "active" && c.serves.includes(r.env) && (cfg.multiRegion.model !== "regional" || c.region === r.region)) ?? centralClusters(cfg)[0];
    const vault = keyVaultName(home.cfg, home.env);
    const dir = `manifests/remote/${r.env}/clusters/${r.name}`;
    const keys = ["cluster", "tenant", ...(cfg.connectivity.auth === "basic" ? ["password"] : [])];
    const specs: SecretSpec[] = [{ name: "remote-write", keys, note: `Identity of ${r.name} (tenant ${tenantOfRemote(cfg, r)}) towards the central cluster` }];
    if (cfg.connectivity.auth === "mtls") specs.push({ name: "remote-write-mtls", keys: ["tls.crt", "tls.key", "ca.crt"], note: "Client certificate of this cluster" });
    files.push({
      path: `${dir}/secrets.yaml`,
      content: docs(`Credentials of ${r.name}`, { apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }, ...(cfg.connectivity.secrets === "eso" ? [secretStoreDoc(cfg, vault)] : []), ...secretDocs(cfg, r.name, specs, vault)),
    });
  }
  for (const env of cfg.environments) {
    const remoteComps = comps.filter((x) => isRemote(x.id, cfg) && remoteWorkloads(cfg, env, x.id).some((w) => w.def.pvc));
    const classes = [...new Set(remoteComps.map((x) => storageClassOf(cfg, x.id)))].map((n) => storageClassDoc(cfg, n)).filter((d): d is Doc => d !== null);
    if (classes.length && remoteClusters(cfg).some((r) => r.env === env)) files.push({ path: `manifests/remote/${env}/storage-classes.yaml`, content: docs("Storage classes for collectors with disks", ...classes) });
  }
  return files;
}

export { routesFor };
