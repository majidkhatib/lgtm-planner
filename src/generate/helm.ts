import { stringify } from "yaml";
import { limitRows, nestKeys, tenantOverrides } from "../limits/limits";
import { commonValues, mergeValues, probeCluster, valuesDiff } from "./split";
import { ROBUSTA_PLAYBOOK_GROUPS } from "../catalog/components";
import { multiValues } from "../catalog/questions";
import type { ComponentId, OptionValue, PlannerConfig } from "../model/types";
import type { SizedWorkload } from "../sizing/engine";
import { autoscalingSnippet } from "./autoscaling";
import {
  azureStorageAccount,
  bucketName,
  centralWorkloads,
  NS,
  remoteClusters,
  remoteGroups,
  resources,
  tenantOfRemote,
  storageClassOf,
  tenantsFor,
  type CentralCluster,
  type GeneratedFile,
} from "./common";
import { alloyValues, cloudLogsValues, prometheusAgentValues, prometheusClusterValues, remoteAlertmanagerValues } from "./collectors";

type Values = Record<string, unknown>;

const yamlFile = (path: string, header: string, values: Values): GeneratedFile => ({
  path,
  content: `# ${header}\n` + stringify(values, { lineWidth: 0 }),
});

const byId = (ws: SizedWorkload[]) => Object.fromEntries(ws.map((w) => [w.def.id, w]));

// ------------------------------------------------------------------ tenant limits
function clusterLimits(c: CentralCluster, id: ComponentId): { defaults: Record<string, OptionValue>; tenants: Record<string, Record<string, OptionValue>> } {
  const defaults = Object.fromEntries(limitRows(c.cfg, id, c.env).map((r) => [r.def.key, r.value]));
  const tenants: Record<string, Record<string, OptionValue>> = {};
  for (const env of new Set([...c.serves, c.env])) Object.assign(tenants, tenantOverrides(c.global, id, env));
  return { defaults, tenants };
}

// ------------------------------------------------------------------ object storage per cloud
function cloudIdentityNote(cfg: PlannerConfig): string {
  return cfg.platform.cloud === "azure"
    ? "Azure Workload Identity: fill client-id from `terraform output` (see README)."
    : cfg.platform.cloud === "aws"
      ? "EKS Pod Identity: the IAM role is associated with this service account by Terraform; no annotation needed."
      : "GKE Workload Identity Federation: IAM is granted to this Kubernetes service account directly; no annotation needed.";
}

function serviceAccount(cfg: PlannerConfig, id: ComponentId, env: string): Values {
  const sa: Values = { create: true, name: id };
  if (cfg.platform.cloud === "azure") sa.annotations = { "azure.workload.identity/client-id": `<terraform output ${id}_client_id (${env})>` };
  return sa;
}

const azurePodLabels = (cfg: PlannerConfig) => (cfg.platform.cloud === "azure" ? { "azure.workload.identity/use": "true" } : undefined);

// ------------------------------------------------------------------ Mimir
function mimirValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const o = cfg.components.mimir.options;
  const w = byId(centralWorkloads(c, "mimir"));
  const env = c.env;
  const sc = storageClassOf(cfg, "mimir");
  const zoneAware = Boolean(o.zoneAware);
  const kafkaOn = o.architecture === "ingest";
  const kafkaProvider = cfg.components.kafka.options.provider;

  const storage: Values =
    cfg.platform.cloud === "azure"
      ? { backend: "azure", azure: { account_name: azureStorageAccount(cfg, env) } }
      : cfg.platform.cloud === "aws"
        ? { backend: "s3", s3: { endpoint: `s3.${cfg.platform.region}.amazonaws.com`, region: cfg.platform.region } }
        : { backend: "gcs" };
  const bucketKey = cfg.platform.cloud === "azure" ? "container_name" : "bucket_name";
  const cloudKey = cfg.platform.cloud === "azure" ? "azure" : cfg.platform.cloud === "aws" ? "s3" : "gcs";
  const bucket = (store: string) => (cfg.platform.cloud === "azure" ? store : bucketName(cfg, env, store));

  const mimirLimits = clusterLimits(c, "mimir");
  const structured: Values = {
    common: { storage },
    blocks_storage: { [cloudKey]: { [bucketKey]: bucket("mimir-blocks") } },
    ruler_storage: { [cloudKey]: { [bucketKey]: bucket("mimir-ruler") } },
    alertmanager_storage: { [cloudKey]: { [bucketKey]: bucket("mimir-alertmanager") } },
    // Default limits for every tenant, calculated from the volumes (see "Tenant limits" in the planner)
    limits: mimirLimits.defaults,
  };
  if (cfg.tenancy.enabled && cfg.tenancy.crossTenantQuery) structured.tenant_federation = { enabled: true };
  if (!cfg.tenancy.enabled) structured.multitenancy_enabled = false;
  if (!kafkaOn) {
    structured.ingest_storage = { enabled: false };
    structured.ingester = { push_grpc_method_enabled: true };
  } else if (kafkaProvider !== "bundled") {
    structured.ingest_storage = { kafka: { address: kafkaAddress(cfg), topic: "mimir-ingest", auto_create_topic_default_partitions: Math.max(w.ingester?.final.replicas ?? 3, 3) } };
  }

  const comp = (id: string, key: string, extra: Values = {}): [string, Values] | null => {
    const x = w[id];
    if (!x) return null;
    const v: Values = { replicas: x.final.replicas, resources: resources(x), ...extra };
    if (x.def.pvc) v.persistentVolume = { enabled: true, size: `${x.final.pvcGi}Gi`, storageClass: sc };
    if (zoneAware && ["ingester", "store-gateway", "alertmanager"].includes(id)) v.zoneAwareReplication = { enabled: true };
    return [key, v];
  };
  const overlay: Values = {
    mimir: { structuredConfig: structured },
    // Per-tenant overrides (runtime config: changes apply without restarts)
    ...(Object.keys(mimirLimits.tenants).length ? { runtimeConfig: { overrides: mimirLimits.tenants } } : {}),
    serviceAccount: serviceAccount(cfg, "mimir", env),
    kafka: { enabled: kafkaOn && kafkaProvider === "bundled" },
  };
  for (const pair of [
    comp("distributor", "distributor"),
    comp("ingester", "ingester"),
    comp("querier", "querier"),
    comp("query-frontend", "query_frontend"),
    comp("store-gateway", "store_gateway"),
    comp("compactor", "compactor"),
  ]) {
    if (pair) overlay[pair[0]] = pair[1];
  }
  for (const [id, key] of [
    ["query-scheduler", "query_scheduler"],
    ["ruler", "ruler"],
    ["alertmanager", "alertmanager"],
    ["overrides-exporter", "overrides_exporter"],
  ] as const) {
    const pair = comp(id, key);
    overlay[key] = pair ? { enabled: true, ...pair[1] } : { enabled: false };
  }
  overlay.gateway = w.gateway
    ? {
        enabled: true,
        replicas: w.gateway.final.replicas,
        resources: resources(w.gateway),
        ...(cfg.connectivity.auth === "basic" ? { nginx: { basicAuth: { enabled: true, existingSecret: "gateway-htpasswd" } } } : {}),
      }
    : { enabled: false };
  for (const cache of ["results-cache", "index-cache", "chunks-cache", "metadata-cache"]) {
    const x = w[cache];
    overlay[cache] = x ? { enabled: true, replicas: x.final.replicas, allocatedMemory: Math.round(x.final.memoryGi * 1024 * 0.85) } : { enabled: false };
  }
  mergeAutoscaling(overlay, cfg, c, "mimir");

  const base: Values = {
    fullnameOverride: "mimir",
    global: azurePodLabels(cfg) ? { podLabels: azurePodLabels(cfg) } : {},
    minio: { enabled: false },
    rollout_operator: { enabled: zoneAware },
  };
  return { base, overlay };
}

export function kafkaAddress(cfg: PlannerConfig): string {
  const p = cfg.components.kafka.options.provider;
  if (p === "strimzi") return `kafka-kafka-bootstrap.${NS}.svc:9092`;
  return cfg.platform.cloud === "azure"
    ? "<event-hubs-namespace>.servicebus.windows.net:9093"
    : cfg.platform.cloud === "aws"
      ? "<msk-bootstrap-brokers>:9098"
      : "<managed-kafka-bootstrap>:9092";
}

// ------------------------------------------------------------------ Loki
function lokiValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const o = cfg.components.loki.options;
  const w = byId(centralWorkloads(c, "loki"));
  const env = c.env;
  const sc = storageClassOf(cfg, "loki");
  const mode = o.mode === "distributed" ? "Distributed" : o.mode === "simple-scalable" ? "SimpleScalable" : "Monolithic";
  const type = cfg.platform.cloud === "azure" ? "azure" : cfg.platform.cloud === "aws" ? "s3" : "gcs";
  const bucket = (store: string) => (cfg.platform.cloud === "azure" ? store : bucketName(cfg, env, store));

  const storage: Values = {
    type,
    bucketNames: { chunks: bucket("loki-chunks"), ruler: bucket("loki-ruler"), admin: bucket("loki-admin") },
  };
  if (type === "azure") storage.azure = { accountName: azureStorageAccount(cfg, env), useFederatedToken: true };
  if (type === "s3") storage.s3 = { region: cfg.platform.region };

  const lokiLimits = clusterLimits(c, "loki");
  const loki: Values = {
    auth_enabled: cfg.tenancy.enabled,
    schemaConfig: { configs: [{ from: "2025-01-01", store: "tsdb", object_store: type, schema: "v13", index: { prefix: "index_", period: "24h" } }] },
    storage,
    limits_config: lokiLimits.defaults,
    ...(Object.keys(lokiLimits.tenants).length ? { runtimeConfig: { overrides: lokiLimits.tenants } } : {}),
    compactor: { retention_enabled: true, delete_request_store: type },
  };
  if (cfg.tenancy.enabled && cfg.tenancy.crossTenantQuery) loki.querier = { multi_tenant_queries_enabled: true };

  const overlay: Values = { deploymentMode: mode, loki, serviceAccount: serviceAccount(cfg, "loki", env), minio: { enabled: false } };
  const zoneAware = Boolean(o.zoneAware);
  const simple = (id: string, key: string, persistence?: "claims" | "simple" | "volumeClaims") => {
    const x = w[id];
    if (!x) {
      overlay[key] = { replicas: 0 };
      return;
    }
    const v: Values = { replicas: x.final.replicas, resources: resources(x) };
    if (persistence === "claims") v.persistence = { enabled: true, claims: [{ name: "data", size: `${x.final.pvcGi}Gi`, storageClass: sc }] };
    if (persistence === "simple") v.persistence = { enabled: true, size: `${x.final.pvcGi}Gi`, storageClass: sc };
    if (persistence === "volumeClaims") v.persistence = { volumeClaimsEnabled: true, size: `${x.final.pvcGi}Gi`, storageClass: sc };
    if (id === "ingester") v.zoneAwareReplication = { enabled: zoneAware };
    overlay[key] = v;
  };

  if (mode === "Distributed") {
    simple("distributor", "distributor");
    simple("ingester", "ingester", "claims");
    simple("querier", "querier");
    simple("query-frontend", "queryFrontend");
    simple("query-scheduler", "queryScheduler");
    simple("index-gateway", "indexGateway", "simple");
    simple("compactor", "compactor", "claims");
    simple("ruler", "ruler", "simple");
    if (!w.ruler) overlay.ruler = { enabled: false, replicas: 0 };
    simple("pattern-ingester", "patternIngester", "claims");
    overlay.singleBinary = { replicas: 0 };
    overlay.write = { replicas: 0 };
    overlay.read = { replicas: 0 };
    overlay.backend = { replicas: 0 };
  } else if (mode === "SimpleScalable") {
    simple("write", "write", "volumeClaims");
    simple("read", "read");
    simple("backend", "backend", "volumeClaims");
    overlay.singleBinary = { replicas: 0 };
  } else {
    simple("single-binary", "singleBinary", "simple");
    overlay.write = { replicas: 0 };
    overlay.read = { replicas: 0 };
    overlay.backend = { replicas: 0 };
  }
  overlay.gateway = w.gateway
    ? {
        enabled: true,
        replicas: w.gateway.final.replicas,
        resources: resources(w.gateway),
        ...(cfg.connectivity.auth === "basic" ? { basicAuth: { enabled: true, existingSecret: "gateway-htpasswd" } } : {}),
      }
    : { enabled: false };
  overlay.chunksCache = w["chunks-cache"] ? { enabled: true, replicas: w["chunks-cache"].final.replicas, allocatedMemory: Math.round(w["chunks-cache"].final.memoryGi * 1024 * 0.85) } : { enabled: false };
  overlay.resultsCache = w["results-cache"] ? { enabled: true, replicas: w["results-cache"].final.replicas, allocatedMemory: Math.round(w["results-cache"].final.memoryGi * 1024 * 0.85) } : { enabled: false };
  mergeAutoscaling(overlay, cfg, c, "loki");

  const base: Values = {
    fullnameOverride: "loki",
    ...(azurePodLabels(cfg) ? { podLabels: azurePodLabels(cfg) } : {}),
    lokiCanary: { enabled: false },
    test: { enabled: false },
  };
  return { base, overlay };
}

// ------------------------------------------------------------------ Tempo
function tempoStorage(cfg: PlannerConfig, env: string): Values {
  if (cfg.platform.cloud === "azure") return { backend: "azure", azure: { container_name: "tempo-traces", storage_account_name: azureStorageAccount(cfg, env), use_federated_token: true } };
  if (cfg.platform.cloud === "aws") return { backend: "s3", s3: { bucket: bucketName(cfg, env, "tempo-traces"), endpoint: `s3.${cfg.platform.region}.amazonaws.com`, region: cfg.platform.region } };
  return { backend: "gcs", gcs: { bucket_name: bucketName(cfg, env, "tempo-traces") } };
}

function tempoValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const o = cfg.components.tempo.options;
  const w = byId(centralWorkloads(c, "tempo"));
  const env = c.env;
  const sc = storageClassOf(cfg, "tempo");
  const tl = clusterLimits(c, "tempo");
  // The global retention follows the default tenant limit (per-tenant retention comes from the overrides).
  const retentionH = String(tl.defaults["compaction.block_retention"] ?? `${c.cfg.volumes[env].retentionDays.traces * 24}h`);
  const tempoDefaults: Record<string, OptionValue | string[]> = { ...tl.defaults };
  // The metrics-generator only produces metrics for the processors enabled in the overrides.
  const generator = Boolean(o.metricsGenerator) && cfg.components.mimir.enabled;
  const withProcessors = (x: Record<string, unknown>) => (generator ? { ...x, metrics_generator: { processors: ["service-graphs", "span-metrics"] } } : x);
  const tempoOverrides = withProcessors(nestKeys(tempoDefaults as Record<string, OptionValue>));
  // Tempo needs complete blocks per tenant, so every override contains all default values too.
  const tempoPerTenant = Object.fromEntries(Object.entries(tl.tenants).map(([t, v]) => [t, withProcessors(nestKeys({ ...tl.defaults, ...v }))]));
  const remoteWrite = cfg.components.mimir.enabled ? [{ url: `http://mimir-gateway.${NS}.svc/api/v1/push`, headers: { "X-Scope-OrgID": "tempo-metrics" } }] : [];

  if (o.mode !== "distributed") {
    const x = w.tempo;
    return {
      base: { fullnameOverride: "tempo", ...(azurePodLabels(cfg) ? { podLabels: azurePodLabels(cfg) } : {}) },
      overlay: {
        serviceAccount: serviceAccount(cfg, "tempo", env),
        resources: x ? resources(x) : undefined,
        persistence: { enabled: true, size: `${x?.final.pvcGi ?? 10}Gi`, storageClassName: sc },
        tempo: {
          multitenancyEnabled: cfg.tenancy.enabled,
          retention: retentionH,
          storage: { trace: tempoStorage(cfg, env) },
          metricsGenerator: o.metricsGenerator && remoteWrite.length ? { enabled: true, remoteWriteUrl: remoteWrite[0].url } : { enabled: false },
          receivers: { otlp: { protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } } },
          overrides: { defaults: tempoOverrides },
          ...(Object.keys(tempoPerTenant).length ? { per_tenant_overrides: tempoPerTenant } : {}),
        },
      },
    };
  }

  const comp = (id: string, extra: Values = {}): Values | undefined => {
    const x = w[id];
    if (!x) return undefined;
    const v: Values = { replicas: x.final.replicas, resources: resources(x), ...extra };
    if (x.def.pvc) v.persistence = { enabled: true, size: `${x.final.pvcGi}Gi`, storageClass: sc };
    return v;
  };
  const overlay: Values = {
    multitenancyEnabled: cfg.tenancy.enabled,
    serviceAccount: serviceAccount(cfg, "tempo", env),
    storage: { trace: tempoStorage(cfg, env) },
    ingest: { kafka: { address: kafkaAddress(cfg), topic: "tempo-traces", auto_create_topic_default_partitions: w["live-store"]?.final.replicas ?? 3 } },
    distributor: comp("distributor"),
    liveStore: comp("live-store"),
    blockBuilder: comp("block-builder"),
    querier: comp("querier"),
    queryFrontend: comp("query-frontend"),
    backendScheduler: { ...comp("backend-scheduler"), config: { provider: { compaction: { compaction: { block_retention: retentionH } } } } },
    backendWorker: comp("backend-worker"),
    metricsGenerator: w["metrics-generator"] ? { enabled: true, ...comp("metrics-generator"), config: { storage: { remote_write: remoteWrite } } } : { enabled: false },
    gateway: w.gateway
      ? {
          enabled: true,
          replicas: w.gateway.final.replicas,
          ...(cfg.connectivity.auth === "basic" ? { basicAuth: { enabled: true, htpasswd: "<content of the gateway-htpasswd secret, see README>" } } : {}),
        }
      : { enabled: false },
    memcached: w.memcached ? { enabled: true, replicas: w.memcached.final.replicas } : { enabled: false },
    traces: { otlp: { grpc: { enabled: true }, http: { enabled: true } } },
    overrides: { defaults: tempoOverrides },
    ...(Object.keys(tempoPerTenant).length ? { per_tenant_overrides: tempoPerTenant } : {}),
  };
  mergeAutoscaling(overlay, cfg, c, "tempo");
  return { base: { fullnameOverride: "tempo", ...(azurePodLabels(cfg) ? { global: { podLabels: azurePodLabels(cfg) } } : {}) }, overlay };
}

// ------------------------------------------------------------------ Pyroscope
function pyroscopeValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const o = cfg.components.pyroscope.options;
  const w = byId(centralWorkloads(c, "pyroscope"));
  const env = c.env;
  const sc = storageClassOf(cfg, "pyroscope");
  const bucketCfg: Values =
    cfg.platform.cloud === "azure"
      ? { backend: "azure", azure: { account_name: azureStorageAccount(cfg, env), container_name: "pyroscope-profiles" } }
      : cfg.platform.cloud === "aws"
        ? { backend: "s3", s3: { bucket_name: bucketName(cfg, env, "pyroscope-profiles"), region: cfg.platform.region, endpoint: `s3.${cfg.platform.region}.amazonaws.com` } }
        : { backend: "gcs", gcs: { bucket_name: bucketName(cfg, env, "pyroscope-profiles") } };
  const single = w.pyroscope;
  const pyroLimits = clusterLimits(c, "pyroscope");
  const pyroscope: Values = {
    structuredConfig: { storage: bucketCfg, limits: pyroLimits.defaults },
    ...(Object.keys(pyroLimits.tenants).length ? { tenantOverrides: pyroLimits.tenants } : {}),
    serviceAccount: serviceAccount(cfg, "pyroscope", env),
  };
  if (single) {
    pyroscope.replicaCount = single.final.replicas;
    pyroscope.resources = resources(single);
    pyroscope.persistence = { enabled: true, size: `${single.final.pvcGi}Gi`, storageClassName: sc };
  }
  const overlay: Values = { pyroscope, minio: { enabled: false }, alloy: { enabled: false } };
  if (o.mode === "distributed") {
    const v2: Values = {};
    for (const x of Object.values(w)) v2[x.def.id] = { replicaCount: x.final.replicas, resources: resources(x) };
    overlay.architecture = { microservices: { enabled: true, v2 } };
  }
  return { base: { fullnameOverride: "pyroscope" }, overlay };
}

// ------------------------------------------------------------------ Grafana
function grafanaValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const w = byId(centralWorkloads(c, "grafana"));
  const x = w.grafana;
  const tenants = tenantsFor(cfg, c);
  const header = cfg.tenancy.enabled ? (cfg.tenancy.crossTenantQuery ? tenants.join("|") : tenants[0]) : undefined;
  const withTenant = (ds: Values): Values =>
    header ? { ...ds, jsonData: { ...(ds.jsonData as Values), httpHeaderName1: "X-Scope-OrgID" }, secureJsonData: { httpHeaderValue1: header } } : ds;

  const datasources: Values[] = [];
  if (cfg.components.mimir.enabled) datasources.push(withTenant({ name: "Mimir", uid: "mimir", type: "prometheus", url: `http://mimir-gateway.${NS}.svc/prometheus`, isDefault: true, jsonData: { prometheusType: "Mimir", timeInterval: "30s" } }));
  if (cfg.components.loki.enabled) datasources.push(withTenant({ name: "Loki", uid: "loki", type: "loki", url: `http://loki-gateway.${NS}.svc`, jsonData: { derivedFields: [{ name: "TraceID", matcherRegex: "traceID=(\\w+)", datasourceUid: "tempo", url: "$${__value.raw}" }] } }));
  if (cfg.components.tempo.enabled) {
    const url = cfg.components.tempo.options.mode === "distributed" ? `http://tempo-query-frontend.${NS}.svc:3200` : `http://tempo.${NS}.svc:3200`;
    datasources.push(withTenant({ name: "Tempo", uid: "tempo", type: "tempo", url, jsonData: { tracesToLogsV2: { datasourceUid: "loki" }, serviceMap: { datasourceUid: "mimir" }, nodeGraph: { enabled: true } } }));
  }
  if (cfg.components.pyroscope.enabled) datasources.push(withTenant({ name: "Pyroscope", uid: "pyroscope", type: "grafana-pyroscope-datasource", url: `http://pyroscope.${NS}.svc:4040` }));
  if (cfg.components.alertmanager.enabled) {
    const mimirAm = cfg.components.alertmanager.options.type === "mimir";
    datasources.push({ name: "Alertmanager", uid: "alertmanager", type: "alertmanager", url: mimirAm ? `http://mimir-gateway.${NS}.svc` : `http://alertmanager.${NS}.svc:9093`, jsonData: { implementation: mimirAm ? "mimir" : "prometheus" } });
  }

  const ha = cfg.components.grafana.options.ha === "ha";
  const ini: Values = { server: { root_url: `https://${String(cfg.components.grafana.options.host || `grafana.${cfg.connectivity.baseDomain}`)}` } };
  if (ha) ini.database = { type: "postgres", host: "$__env{GF_DATABASE_HOST}", name: "grafana", user: "$__env{GF_DATABASE_USER}", password: "$__env{GF_DATABASE_PASSWORD}", ssl_mode: "require" };
  if (cfg.components.grafana.options.auth === "oidc")
    ini["auth.generic_oauth"] = { enabled: true, name: "SSO", client_id: "$__env{GF_OIDC_CLIENT_ID}", client_secret: "$__env{GF_OIDC_CLIENT_SECRET}", scopes: "openid profile email", auth_url: "<idp>/authorize", token_url: "<idp>/token", api_url: "<idp>/userinfo" };

  return {
    base: { fullnameOverride: "grafana", admin: { existingSecret: "grafana-admin", userKey: "admin-user", passwordKey: "admin-password" } },
    overlay: {
      replicas: x?.final.replicas ?? 1,
      resources: x ? resources(x) : undefined,
      persistence: ha ? { enabled: false } : { enabled: true, size: "10Gi", storageClassName: storageClassOf(cfg, "grafana") },
      envFromSecret: "grafana-env",
      "grafana.ini": ini,
      datasources: { "datasources.yaml": { apiVersion: 1, datasources } },
    },
  };
}

// ------------------------------------------------------------------ Alertmanager, Robusta, Langfuse
function alertmanagerValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const x = byId(centralWorkloads(c, "alertmanager")).alertmanager;
  return {
    base: { fullnameOverride: "alertmanager", configmapReload: { enabled: true } },
    overlay: {
      replicaCount: x?.final.replicas ?? 2,
      resources: x ? resources(x) : undefined,
      persistence: { enabled: true, size: `${x?.final.pvcGi ?? 1}Gi`, storageClass: storageClassOf(cfg, "alertmanager") },
      config: {
        route: { receiver: "default", group_by: ["alertname", "cluster", "namespace"], group_wait: "30s", group_interval: "5m", repeat_interval: "4h" },
        receivers: [{ name: "default" }],
      },
    },
  };
}

function robustaValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const llm = String(cfg.components.robusta.options.llm);
  const model: Record<string, string> = {
    "azure-openai": "azure/<deployment-name>",
    bedrock: "bedrock/<model-id>",
    vertex: "vertex_ai/<model-name>",
    openai: "<model-name>",
    "self-hosted": "openai/<model-name>",
  };
  const o = cfg.components.robusta.options;
  const secretEnv = (name: string, key: string) => ({ name, valueFrom: { secretKeyRef: { name: "robusta", key } } });
  const sink = String(o.sink);
  const sinkName = sink === "slack" ? "main_slack_sink" : "main_ms_teams_sink";
  const sinksConfig =
    sink === "slack"
      ? [{ slack_sink: { name: sinkName, api_key: "{{ env.SLACK_API_KEY }}", slack_channel: String(o.slackChannel || "<slack-channel>") } }]
      : sink === "msteams"
        ? [{ ms_teams_sink: { name: sinkName, webhook_url: "{{ env.MSTEAMS_WEBHOOK_URL }}" } }]
        : [];
  // Built-in playbooks: the groups the user didn't select are disabled by name.
  const selected = multiValues(o.playbooks);
  const disabledPlaybooks = ROBUSTA_PLAYBOOK_GROUPS.filter((g) => !selected.includes(g.id)).flatMap((g) => g.playbooks);
  const extras = multiValues(o.extraPlaybooks);
  const weekly = { on_schedule: { fixed_delay_repeat: { repeat: -1, seconds_delay: 604800 } } };
  const toSink = sinksConfig.length ? { sinks: [sinkName] } : {};
  const namedCustomPlaybooks: Values = {
    ...(extras.includes("krr") ? { "weekly-krr": { triggers: [weekly], actions: [{ krr_scan: {} }], ...toSink } } : {}),
    ...(extras.includes("popeye") ? { "weekly-popeye": { triggers: [weekly], actions: [{ popeye_scan: {} }], ...toSink } } : {}),
    ...(extras.includes("changes")
      ? {
          "change-tracking": {
            triggers: [{ on_deployment_all_changes: {} }, { on_statefulset_all_changes: {} }, { on_daemonset_all_changes: {} }],
            actions: [{ resource_babysitter: {} }],
            ...toSink,
          },
        }
      : {}),
  };
  return {
    base: {
      enableHolmesGPT: true,
      enablePrometheusStack: false,
      globalConfig: { signing_key: "{{ env.ROBUSTA_SIGNING_KEY }}", account_id: "{{ env.ROBUSTA_ACCOUNT_ID }}", prometheus_url: `http://mimir-gateway.${NS}.svc/prometheus` },
      sinksConfig,
      disabledPlaybooks,
      namedCustomPlaybooks,
      runner: {
        additional_env_vars: [
          secretEnv("ROBUSTA_SIGNING_KEY", "signing-key"),
          ...(sink === "slack" ? [secretEnv("SLACK_API_KEY", "slack-api-key")] : sink === "msteams" ? [secretEnv("MSTEAMS_WEBHOOK_URL", "msteams-webhook-url")] : []),
        ],
      },
      holmes: { additional_env_vars: [{ name: "MODEL", value: model[llm] }, secretEnv("LLM_API_KEY", "llm-api-key")] },
    },
    overlay: { clusterName: c.name },
  };
}

function langfuseValues(cfg: PlannerConfig, c: CentralCluster): { base: Values; overlay: Values } {
  const o = cfg.components.langfuse.options;
  const w = byId(centralWorkloads(c, "langfuse"));
  const env = c.env;
  const sc = storageClassOf(cfg, "langfuse");
  const ch = String(o.clickhouse);
  const chNs = String(o.clickhouseNamespace || "clickhouse");
  const overlay: Values = {
    langfuse: {
      salt: { secretKeyRef: { name: "langfuse", key: "salt" } },
      nextauth: { url: `https://${String(o.host || `langfuse.${cfg.connectivity.baseDomain}`)}`, secret: { secretKeyRef: { name: "langfuse", key: "nextauth-secret" } } },
      encryptionKey: { secretKeyRef: { name: "langfuse", key: "encryption-key" } },
      web: { replicas: w.web?.final.replicas, resources: w.web ? resources(w.web) : undefined },
      worker: { replicas: w.worker?.final.replicas, resources: w.worker ? resources(w.worker) : undefined },
    },
    postgresql:
      o.postgres === "bundled"
        ? { deploy: true, primary: { persistence: { size: `${w.postgresql?.final.pvcGi ?? 10}Gi`, storageClass: sc } } }
        : { deploy: false, host: "<managed postgres host from terraform output>", auth: { username: "langfuse", existingSecret: "langfuse-db", secretKeys: { userPasswordKey: "password" } } },
    redis: o.redis === "bundled" ? { deploy: true } : { deploy: false, host: "<managed redis host>", auth: { existingSecret: "langfuse-redis", existingSecretPasswordKey: "password" } },
    clickhouse:
      ch === "bundled"
        ? { deploy: true, replicaCount: w.clickhouse?.final.replicas ?? 1, resources: w.clickhouse ? resources(w.clickhouse) : undefined, persistence: { size: `${w.clickhouse?.final.pvcGi ?? 20}Gi`, storageClass: sc } }
        : {
            deploy: false,
            host: ch === "operator" ? `clickhouse-langfuse.${chNs}.svc` : "<external clickhouse host>",
            clusterEnabled: Boolean(o.clickhouseReplicated),
            auth: { username: "langfuse", existingSecret: "langfuse-clickhouse", existingSecretKey: "password" },
          },
    s3:
      o.objectStorage === "bundled"
        ? { deploy: true }
        : {
            deploy: false,
            storageProvider: cfg.platform.cloud === "azure" ? "azure" : cfg.platform.cloud === "aws" ? "s3" : "gcs",
            bucket: cfg.platform.cloud === "azure" ? "langfuse-events" : bucketName(cfg, env, "langfuse-events"),
            region: cfg.platform.cloud === "aws" ? cfg.platform.region : undefined,
          },
  };
  mergeAutoscaling(overlay, cfg, c, "langfuse");
  return { base: { fullnameOverride: "langfuse" }, overlay };
}

// ------------------------------------------------------------------ autoscaling into values
function deepMerge(target: Values, src: Values) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") deepMerge(target[k] as Values, v as Values);
    else target[k] = v;
  }
}

/** Adds the chosen HPA/KEDA settings (the same snippet the UI shows) to the values. */
function mergeAutoscaling(overlay: Values, cfg: PlannerConfig, c: CentralCluster, id: ComponentId) {
  for (const w of centralWorkloads(c, id)) {
    if (w.autoscaler !== "hpa" && w.autoscaler !== "keda") continue;
    const wc = cfg.components[id].workloads?.[w.def.id] ?? {};
    const sn = autoscalingSnippet(c.cfg, id, w, c.dir, {
      min: wc.minReplicas ?? w.final.replicas,
      max: wc.maxReplicas ?? Math.max(w.final.replicas * 3, w.final.replicas + 1),
      targetCpu: wc.targetCpuPercent ?? (w.autoscaler === "keda" && id === "mimir" ? 100 : 70),
      vpaMode: wc.vpaMode ?? "Off",
    });
    if (!sn || !sn.file.endsWith("values.yaml")) continue;
    const parsed = parseSimpleYaml(sn.yaml);
    deepMerge(overlay, parsed);
  }
}

// The snippets are generated by us, so a tiny indentation-based parser is enough here.
function parseSimpleYaml(text: string): Values {
  const root: Values = {};
  const stack: { indent: number; obj: Values }[] = [{ indent: -1, obj: root }];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const [key, ...rest] = raw.trim().split(":");
    const value = rest.join(":").trim();
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      parent[key] = parent[key] ?? {};
      stack.push({ indent, obj: parent[key] as Values });
    } else {
      const clean = value.replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1");
      parent[key] = clean === "true" ? true : clean === "false" ? false : /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : clean;
    }
  }
  return root;
}

// ------------------------------------------------------------------ assemble
const BUILDERS: Partial<Record<ComponentId, (cfg: PlannerConfig, c: CentralCluster) => { base: Values; overlay: Values }>> = {
  mimir: mimirValues,
  loki: lokiValues,
  tempo: tempoValues,
  pyroscope: pyroscopeValues,
  grafana: grafanaValues,
  alertmanager: alertmanagerValues,
  robusta: robustaValues,
  langfuse: langfuseValues,
};

const DROP_UNDEFINED = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

export function helmFiles(cfg: PlannerConfig, central: CentralCluster[], ids: ComponentId[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const id of ids) {
    const build = BUILDERS[id];
    if (!build || !central.length) continue;
    if (id === "alertmanager" && cfg.components.alertmanager.options.type === "mimir") continue;
    // c.cfg is each cluster's view: its region, its storage names, its share of the volumes.
    const full = (c: CentralCluster) => {
      const { base, overlay } = build(c.cfg, c);
      return DROP_UNDEFINED(mergeValues(base, overlay)) as Values;
    };
    const fulls = central.map(full);
    // Everything that doesn't depend on the environment goes to helm/base (see split.ts).
    let probe: Values[] = [];
    try {
      probe = [full(probeCluster(central[0]))];
    } catch {
      /* fall back to comparing the real clusters only */
    }
    const base = commonValues([...fulls, ...probe]);
    files.push(yamlFile(`helm/base/${id}/values.yaml`, `${id}: settings shared by every environment and region (the cluster files below only add what differs)`, base));
    central.forEach((c, i) => {
      const standbyNote = c.role === "standby" ? " STANDBY: reads the replicated storage; deployed only on failover." : "";
      files.push(
        yamlFile(
          `helm/central/${c.dir}/${id}/values.yaml`,
          `${id} on ${c.name}: sizing, storage and environment-specific settings (applied on top of helm/base/${id}).${standbyNote} ${["mimir", "loki", "tempo", "pyroscope"].includes(id) ? cloudIdentityNote(cfg) : ""}`,
          valuesDiff(fulls[i], base),
        ),
      );
    });
  }

  // Remote clusters: collectors, one overlay per group (same environment and region).
  for (const g of remoteGroups(cfg)) {
    const where = g.targets.length > 1 ? ` (writes to ${g.targets.length} regions)` : "";
    for (const id of ids) {
      const values =
        id === "prometheus" ? prometheusAgentValues(cfg, g.env, g.targets) : id === "alertmanager" ? remoteAlertmanagerValues(cfg, g.env) : alloyValues(cfg, g.env, id, g.targets);
      if (!values) continue;
      files.push(yamlFile(`helm/remote/${g.dir}/${id}/values.yaml`, `${id} on the ${g.dir} remote clusters${where}`, DROP_UNDEFINED(values) as Values));
    }
    for (const r of remoteClusters(cfg).filter((x) => x.env === g.env && x.region === g.region)) {
      const pv = ids.includes("prometheus") ? prometheusClusterValues(cfg, g.env, r.name, tenantOfRemote(cfg, r), g.targets) : null;
      if (pv) files.push(yamlFile(`helm/remote/${g.dir}/clusters/${r.name}/prometheus.yaml`, `Prometheus on ${r.name}: cluster label and tenant`, pv));
    }
  }

  // Components that also run on the central cluster (self-monitoring and cloud logs).
  for (const c of central) {
    for (const id of ids) {
      if (id === "kube-state-metrics" || id === "node-exporter") {
        const v = alloyValues(c.cfg, c.env === "shared" ? c.cfg.environments[0] : c.env, id);
        if (v) files.push(yamlFile(`helm/central/${c.dir}/${id}/values.yaml`, `${id} on ${c.name} (self-monitoring)`, DROP_UNDEFINED(v) as Values));
      }
      if (id === "cloud-logs") {
        const r = centralWorkloads(c, "cloud-logs")[0];
        files.push(yamlFile(`helm/central/${c.dir}/cloud-logs/values.yaml`, `Cloud platform logs pulled on ${c.name}`, cloudLogsValues(c.cfg, r?.final.replicas ?? 1)));
      }
    }
  }
  return files;
}
