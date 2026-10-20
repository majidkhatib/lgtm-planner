import type { ComponentId, PlannerConfig } from "../model/types";
import { hostOf, NS, remoteWorkloads, resources, storageClassOf } from "./common";

type Values = Record<string, unknown>;

// Remote clusters push to the central hostnames. The tenant is set per cluster at deploy time
// through the CLUSTER_NAME / TENANT environment variables (from the per-cluster secret).

const authBlock = (cfg: PlannerConfig, indent: string): string => {
  if (cfg.connectivity.auth === "basic")
    return `${indent}basic_auth {\n${indent}  username = sys.env("TENANT")\n${indent}  password = sys.env("REMOTE_WRITE_PASSWORD")\n${indent}}\n`;
  if (cfg.connectivity.auth === "mtls")
    return `${indent}tls_config {\n${indent}  cert_file = "/etc/remote-write-mtls/tls.crt"\n${indent}  key_file  = "/etc/remote-write-mtls/tls.key"\n${indent}  ca_file   = "/etc/remote-write-mtls/ca.crt"\n${indent}}\n`;
  return "";
};

const tenantLine = (cfg: PlannerConfig, indent: string) => (cfg.tenancy.enabled ? `${indent}tenant_id = sys.env("TENANT")\n` : "");

/** Target regions: collectors write to every region in the list (two for active-active). */
type Targets = string[];

const lokiWrite = (cfg: PlannerConfig, t: Targets) =>
  `loki.write "central" {\n${t
    .map((r) => `  endpoint {\n    url = "https://${hostOf(cfg, "loki", r)}/loki/api/v1/push"\n${tenantLine(cfg, "    ")}${authBlock(cfg, "    ")}  }\n`)
    .join("")}  external_labels = { cluster = sys.env("CLUSTER_NAME") }\n}\n`;

const secretEnv = (cfg: PlannerConfig) => [
  { name: "CLUSTER_NAME", valueFrom: { secretKeyRef: { name: "remote-write", key: "cluster" } } },
  { name: "TENANT", valueFrom: { secretKeyRef: { name: "remote-write", key: "tenant" } } },
  ...(cfg.connectivity.auth === "basic" ? [{ name: "REMOTE_WRITE_PASSWORD", valueFrom: { secretKeyRef: { name: "remote-write", key: "password" } } }] : []),
];

const mtlsMount = (cfg: PlannerConfig) =>
  cfg.connectivity.auth === "mtls" ? { extra: [{ name: "remote-write-mtls", mountPath: "/etc/remote-write-mtls", readOnly: true }] } : undefined;

function alloyChart(cfg: PlannerConfig, env: string, id: ComponentId, controller: Values, config: string, extraAlloy: Values = {}): Values {
  const w = remoteWorkloads(cfg, env, id)[0];
  return {
    fullnameOverride: id,
    controller,
    alloy: {
      configMap: { content: config },
      extraEnv: secretEnv(cfg),
      resources: w ? resources(w) : undefined,
      ...(mtlsMount(cfg) ? { mounts: mtlsMount(cfg) } : {}),
      ...extraAlloy,
    },
  };
}

// ------------------------------------------------------------------ logs
function podLogsConfig(cfg: PlannerConfig, t: Targets): string {
  const dropDebug = Boolean(cfg.components["alloy-logs"].options.dropDebug);
  return `// Pod logs from every node, labelled with Kubernetes metadata.
discovery.kubernetes "pods" {
  role = "pod"
  selectors {
    role  = "pod"
    field = "spec.nodeName=" + sys.env("HOSTNAME")
  }
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name", "__meta_kubernetes_pod_label_app"]
    regex         = "^;*([^;]+)(;.*)?$"
    target_label  = "app"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.process.pods.receiver]
}

loki.process "pods" {
  stage.cri {}
${dropDebug ? `  // Dropping debug lines at the source is the cheapest log optimisation.\n  stage.drop {\n    expression = "(?i)level=(debug|trace)"\n  }\n` : ""}  forward_to = [loki.write.central.receiver]
}

${lokiWrite(cfg, t)}`;
}

const eventsConfig = (cfg: PlannerConfig, t: Targets) => `// Kubernetes events (OOMKilled, FailedScheduling, BackOff…) kept in Loki.
loki.source.kubernetes_events "events" {
  log_format = "logfmt"
  forward_to = [loki.write.central.receiver]
}

${lokiWrite(cfg, t)}`;

// ------------------------------------------------------------------ traces
function tracesConfig(cfg: PlannerConfig, t: Targets): string {
  const o = cfg.components["trace-collector"].options;
  const pct = Number(o.samplingPercent) || 100;
  const sampler =
    o.sampling === "tail"
      ? `// Tail sampling: keep every error and every slow trace, plus ${pct} % of the rest.
otelcol.processor.tail_sampling "default" {
  decision_wait = "10s"
  policy {
    name = "errors"
    type = "status_code"
    status_code { status_codes = ["ERROR"] }
  }
  policy {
    name = "slow"
    type = "latency"
    latency { threshold_ms = 2000 }
  }
  policy {
    name = "sample-rest"
    type = "probabilistic"
    probabilistic { sampling_percentage = ${pct} }
  }
  output { traces = [otelcol.processor.batch.default.input] }
}
`
      : o.sampling === "head"
        ? `// Head sampling: keep ${pct} % of traces, decided when a trace starts.
otelcol.processor.probabilistic_sampler "default" {
  sampling_percentage = ${pct}
  output { traces = [otelcol.processor.batch.default.input] }
}
`
        : "";
  const next = o.sampling === "tail" ? "otelcol.processor.tail_sampling.default.input" : o.sampling === "head" ? "otelcol.processor.probabilistic_sampler.default.input" : "otelcol.processor.batch.default.input";
  return `// Applications send OTLP to this collector (gRPC 4317, HTTP 4318).
otelcol.receiver.otlp "default" {
  grpc {}
  http {}
  output { traces = [otelcol.processor.k8sattributes.default.input] }
}

otelcol.processor.k8sattributes "default" {
  output { traces = [${next}] }
}

${sampler}otelcol.processor.batch "default" {
  output { traces = [${t.map((_, i) => `otelcol.exporter.otlphttp.tempo_${i}.input`).join(", ")}] }
}

${tempoExporters(cfg, t)}`;
}

/** OTLP exporters to Tempo (one per target region), with the basic-auth extension when needed. */
function tempoExporters(cfg: PlannerConfig, t: Targets): string {
  const auth =
    cfg.connectivity.auth === "basic"
      ? `otelcol.auth.basic "central" {\n  username = sys.env("TENANT")\n  password = sys.env("REMOTE_WRITE_PASSWORD")\n}\n\n`
      : "";
  return `${auth}${t
    .map(
      (r, i) => `otelcol.exporter.otlphttp "tempo_${i}" {
  client {
    endpoint = "https://${hostOf(cfg, "tempo", r)}"
${cfg.tenancy.enabled ? `    headers  = { "X-Scope-OrgID" = sys.env("TENANT") }\n` : ""}${cfg.connectivity.auth === "basic" ? "    auth     = otelcol.auth.basic.central.handler\n" : ""}${cfg.connectivity.auth === "mtls" ? `    tls {\n      cert_file = "/etc/remote-write-mtls/tls.crt"\n      key_file  = "/etc/remote-write-mtls/tls.key"\n      ca_file   = "/etc/remote-write-mtls/ca.crt"\n    }\n` : ""}  }
}
`,
    )
    .join("\n")}`;
}

// ------------------------------------------------------------------ Beyla (eBPF auto-instrumentation)
const SYSTEM_NAMESPACES = ["kube-system", "kube-public", "kube-node-lease", NS, "cert-manager", "external-secrets", "external-dns", "keda", "argocd", "flux-system", "gatekeeper-system", "calico-system", "tigera-operator"];

function beylaConfig(cfg: PlannerConfig, t: Targets): string {
  const o = cfg.components.beyla.options;
  const metrics = cfg.signals.metrics && cfg.components.mimir.enabled && o.exports !== "traces";
  const traces = cfg.signals.traces && cfg.components.tempo.enabled && o.exports !== "metrics";
  const exportsList = [metrics ? `"metrics"` : "", traces ? `"traces"` : ""].filter(Boolean).join(", ");
  const namespaces =
    o.scope === "namespaces"
      ? String(o.namespaces ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : ["*"];
  const [labelKey, labelValue = "true"] = String(o.optInLabel || "beyla.instrument=true").split("=").map((s) => s.trim());
  const selectors =
    o.scope === "label"
      ? [`pod_labels = { "${labelKey}" = "${labelValue}" }`]
      : (namespaces.length ? namespaces : ["*"]).map((ns) => `namespace = "${ns}"`);
  const instrument = selectors.map((sel) => `    instrument {\n      kubernetes {\n        ${sel}\n      }\n      exports = [${exportsList}]\n    }\n`).join("");
  // One glob for all system namespaces ({a,b,c} matches any of them).
  const exclude = `    exclude_instrument {\n      kubernetes {\n        namespace = "{${SYSTEM_NAMESPACES.join(",")}}"\n      }\n    }\n`;
  const features = ["application", "application_service_graph", ...(o.network ? ["network"] : []), ...(o.processMetrics ? ["application_process"] : [])];
  const list = (v: unknown) =>
    String(v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const quote = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");
  const PROTOCOLS: Record<string, string[]> = { "http-grpc": ["http", "grpc"], "http-grpc-sql": ["http", "grpc", "sql"], all: ["*"] };
  const ignored = [...(o.ignoreHealth === false ? [] : ["/health", "/healthz", "/ready", "/readyz", "/live", "/livez", "/ping", "/metrics"]), ...list(o.ignoredPaths)];
  const patterns = list(o.routePatterns);
  // Route grouping: decides how many series Beyla creates per service.
  const routes = `
  routes {
    unmatched = "${metrics ? String(o.routes || "heuristic") : "heuristic"}"
${patterns.length ? `    patterns  = [${quote(patterns)}]\n` : ""}${ignored.length ? `    ignored_patterns = [${quote(ignored)}]\n    ignore_mode      = "all"\n` : ""}  }
`;
  // With a local trace collector, Beyla's spans go through it (same sampling and batching as SDK traces).
  const localCollector = cfg.components["trace-collector"].enabled;
  const traceTarget = localCollector ? "otelcol.exporter.otlp.local.input" : "otelcol.processor.batch.beyla.input";
  return `// Beyla: metrics and traces for every application pod on this node, created with eBPF.
// No code changes or restarts are needed in the applications.
beyla.ebpf "default" {
  attributes {
    kubernetes {
      enable       = "true"
      cluster_name = sys.env("CLUSTER_NAME")
    }
  }

  discovery {
${instrument}${exclude}  }
${routes}${metrics ? `
  metrics {
    features         = [${quote(features)}]
    instrumentations = [${quote(PROTOCOLS[String(o.metricProtocols)] ?? ["*"])}]
    exemplar_filter  = "trace_based"
  }
` : ""}${traces ? `
  traces {
    instrumentations = [${quote(PROTOCOLS[String(o.traceProtocols)] ?? ["http", "grpc"])}]
  }
` : ""}
  // Required block; without a traces destination, spans are dropped.
  output {
${traces ? `    traces = [${traceTarget}]\n` : ""}  }
}
${metrics ? `
prometheus.scrape "beyla" {
  targets      = beyla.ebpf.default.targets
  honor_labels = true
  forward_to   = [prometheus.remote_write.central.receiver]
}

prometheus.remote_write "central" {
${t.map((r) => `  endpoint {\n    url = "https://${hostOf(cfg, "mimir", r)}/api/v1/push"\n${cfg.tenancy.enabled ? `    headers = { "X-Scope-OrgID" = sys.env("TENANT") }\n` : ""}${authBlock(cfg, "    ")}  }\n`).join("")}  external_labels = { cluster = sys.env("CLUSTER_NAME") }
}
` : ""}${traces ? (localCollector ? `
// Spans go to the trace collector on this cluster, which samples and forwards them to Tempo.
otelcol.exporter.otlp "local" {
  client {
    endpoint = "trace-collector.${NS}.svc:4317"
    tls { insecure = true }
  }
}
` : `
otelcol.processor.batch "beyla" {
  output { traces = [${t.map((_, i) => `otelcol.exporter.otlphttp.tempo_${i}.input`).join(", ")}] }
}

${tempoExporters(cfg, t)}`) : ""}`;
}

// ------------------------------------------------------------------ profiles
const profilesConfig = (cfg: PlannerConfig, t: Targets) => `// Continuous profiling with eBPF for every process on the node.
discovery.kubernetes "pods" {
  role = "pod"
  selectors {
    role  = "pod"
    field = "spec.nodeName=" + sys.env("HOSTNAME")
  }
}

pyroscope.ebpf "default" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [pyroscope.write.central.receiver]
}

pyroscope.write "central" {
${t.map((r) => `  endpoint {\n    url = "https://${hostOf(cfg, "pyroscope", r)}"\n${cfg.tenancy.enabled ? `    headers = { "X-Scope-OrgID" = sys.env("TENANT") }\n` : ""}${authBlock(cfg, "    ")}  }\n`).join("")}  external_labels = { cluster = sys.env("CLUSTER_NAME") }
}
`;

// ------------------------------------------------------------------ metrics via Alloy (alternative to Prometheus)
const alloyMetricsConfig = (cfg: PlannerConfig, t: Targets) => `// Metrics scraping shared across replicas (clustering).
discovery.kubernetes "pods" {
  role = "pod"
}

prometheus.scrape "pods" {
  targets         = discovery.kubernetes.pods.targets
  scrape_interval = "${Number(cfg.components.prometheus.options.scrapeInterval) || 30}s"
  clustering { enabled = true }
  forward_to      = [prometheus.remote_write.central.receiver]
}

prometheus.remote_write "central" {
${t.map((r) => `  endpoint {\n    url = "https://${hostOf(cfg, "mimir", r)}/api/v1/push"\n${cfg.tenancy.enabled ? `    headers = { "X-Scope-OrgID" = sys.env("TENANT") }\n` : ""}${authBlock(cfg, "    ")}  }\n`).join("")}  external_labels = { cluster = sys.env("CLUSTER_NAME") }
}
`;

// ------------------------------------------------------------------ public builders
export function prometheusAgentValues(cfg: PlannerConfig, env: string, t: Targets = [cfg.platform.region]): Values | null {
  if (!cfg.components.prometheus.enabled) return null;
  if (cfg.components.prometheus.options.collector === "alloy") {
    const w = remoteWorkloads(cfg, env, "prometheus")[0];
    return alloyChart(cfg, env, "prometheus", { type: "statefulset", replicas: w?.final.replicas ?? 1 }, alloyMetricsConfig(cfg, t), { clustering: { enabled: true } });
  }
  const w = remoteWorkloads(cfg, env, "prometheus")[0];
  const scrape = `${Number(cfg.components.prometheus.options.scrapeInterval) || 30}s`;
  const server = cfg.components.prometheus.options.mode === "server";
  const localAm = cfg.components.alertmanager.enabled && cfg.components.alertmanager.options.placement === "both";
  return {
    fullnameOverride: "prometheus",
    server: {
      // Agent mode: scrape and forward only. Server mode: also keeps local data and evaluates alert rules here.
      extraFlags: server ? ["web.enable-lifecycle"] : ["agent", "web.enable-lifecycle"],
      ...(server ? { retention: `${Number(cfg.components.prometheus.options.localRetentionDays) || 2}d` } : {}),
      statefulSet: { enabled: true },
      global: { scrape_interval: scrape, external_labels: { environment: env } },
      resources: w ? resources(w) : undefined,
      persistentVolume: { enabled: true, size: `${w?.final.pvcGi ?? 10}Gi`, storageClass: storageClassOf(cfg, "prometheus") },
      extraSecretMounts: [
        ...(cfg.connectivity.auth === "basic" ? [{ name: "remote-write", secretName: "remote-write", mountPath: "/etc/remote-write", readOnly: true }] : []),
        ...(cfg.connectivity.auth === "mtls" ? [{ name: "remote-write-mtls", secretName: "remote-write-mtls", mountPath: "/etc/remote-write-mtls", readOnly: true }] : []),
      ],
    },
    serverFiles: server
      ? {
          // Local alert rules go to the Alertmanager on this cluster.
          ...(localAm ? { "prometheus.yml": { alerting: { alertmanagers: [{ static_configs: [{ targets: [`alertmanager.${NS}.svc:9093`] }] }] } } } : {}),
        }
      : // Agent mode doesn't evaluate rules: drop the chart's default rule files.
        { "prometheus.yml": { rule_files: [] } },
    alertmanager: { enabled: false },
    "prometheus-pushgateway": { enabled: false },
    // Deployed as separate releases (own steps in the planner).
    "kube-state-metrics": { enabled: false },
    "prometheus-node-exporter": { enabled: false },
  };
}

/**
 * Per-cluster part of the Prometheus values: Prometheus can't read the tenant from an environment
 * variable in remote_write, so each remote cluster gets its own small values file.
 */
export function prometheusClusterValues(cfg: PlannerConfig, env: string, cluster: string, tenant: string, t: Targets = [cfg.platform.region]): Values | null {
  if (!cfg.components.prometheus.enabled || cfg.components.prometheus.options.collector === "alloy") return null;
  // One remote_write per target region (two for active-active: the same data goes to both).
  const remoteWrite = t.map((r) => {
    const rw: Values = {
      url: `https://${hostOf(cfg, "mimir", r)}/api/v1/push`,
      queue_config: { max_samples_per_send: 2000, max_shards: 50, retry_on_http_429: true },
    };
    if (cfg.tenancy.enabled) rw.headers = { "X-Scope-OrgID": tenant };
    if (cfg.connectivity.auth === "basic") rw.basic_auth = { username: tenant, password_file: "/etc/remote-write/password" };
    if (cfg.connectivity.auth === "mtls") rw.tls_config = { cert_file: "/etc/remote-write-mtls/tls.crt", key_file: "/etc/remote-write-mtls/tls.key", ca_file: "/etc/remote-write-mtls/ca.crt" };
    return rw;
  });
  return { server: { global: { external_labels: { cluster, environment: env } }, remoteWrite } };
}

export function alloyValues(cfg: PlannerConfig, env: string, id: ComponentId, t: Targets = [cfg.platform.region]): Values | null {
  if (!cfg.components[id]?.enabled) return null;
  const w = remoteWorkloads(cfg, env, id)[0];
  switch (id) {
    case "alloy-logs":
      return alloyChart(cfg, env, id, { type: "daemonset" }, podLogsConfig(cfg, t), { mounts: { varlog: true, ...(mtlsMount(cfg) ?? {}) } });
    case "alloy-events":
      return alloyChart(cfg, env, id, { type: "deployment", replicas: 1 }, eventsConfig(cfg, t));
    case "trace-collector":
      if (cfg.components["trace-collector"].options.collector === "otel") return otelCollectorValues(cfg, env, t);
      return alloyChart(cfg, env, id, { type: "deployment", replicas: w?.final.replicas ?? 2 }, tracesConfig(cfg, t), {
        extraPorts: [
          { name: "otlp-grpc", port: 4317, targetPort: 4317, protocol: "TCP" },
          { name: "otlp-http", port: 4318, targetPort: 4318, protocol: "TCP" },
        ],
      });
    case "alloy-profiles":
      return alloyChart(cfg, env, id, { type: "daemonset", hostPID: true }, profilesConfig(cfg, t), { securityContext: { privileged: true, runAsUser: 0 } });
    case "beyla":
      // eBPF needs the host PID namespace and extra capabilities; not fully privileged (keeps seccomp/AppArmor).
      return alloyChart(cfg, env, id, { type: "daemonset", hostPID: true }, beylaConfig(cfg, t), {
        stabilityLevel: "public-preview",
        securityContext: {
          runAsUser: 0,
          privileged: false,
          allowPrivilegeEscalation: true,
          appArmorProfile: { type: "Unconfined" },
          capabilities: { add: ["BPF", "NET_ADMIN", "NET_RAW", "PERFMON", "DAC_READ_SEARCH", "SYS_PTRACE", "CHECKPOINT_RESTORE", "SYS_RESOURCE"] },
        },
      });
    case "kube-state-metrics":
      return { fullnameOverride: "kube-state-metrics", resources: w ? resources(w) : undefined, prometheusScrape: true };
    case "node-exporter":
      return { fullnameOverride: "node-exporter", resources: w ? resources(w) : undefined, service: { annotations: { "prometheus.io/scrape": "true" } } };
    default:
      return null;
  }
}

function otelCollectorValues(cfg: PlannerConfig, env: string, t: Targets): Values {
  const o = cfg.components["trace-collector"].options;
  const w = remoteWorkloads(cfg, env, "trace-collector")[0];
  const pct = Number(o.samplingPercent) || 100;
  const processors: Values = { batch: {}, k8sattributes: {} };
  const pipeline = ["k8sattributes"];
  if (o.sampling === "tail") {
    processors.tail_sampling = {
      decision_wait: "10s",
      policies: [
        { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } },
        { name: "slow", type: "latency", latency: { threshold_ms: 2000 } },
        { name: "sample-rest", type: "probabilistic", probabilistic: { sampling_percentage: pct } },
      ],
    };
    pipeline.push("tail_sampling");
  } else if (o.sampling === "head") {
    processors.probabilistic_sampler = { sampling_percentage: pct };
    pipeline.push("probabilistic_sampler");
  }
  pipeline.push("batch");
  return {
    fullnameOverride: "trace-collector",
    mode: "deployment",
    image: { repository: "otel/opentelemetry-collector-k8s" },
    replicaCount: w?.final.replicas ?? 2,
    resources: w ? resources(w) : undefined,
    extraEnvs: secretEnv(cfg),
    config: {
      receivers: { otlp: { protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } } },
      processors,
      exporters: Object.fromEntries(
        t.map((r, i) => [
          `otlphttp/tempo${i}`,
          { endpoint: `https://${hostOf(cfg, "tempo", r)}`, headers: cfg.tenancy.enabled ? { "X-Scope-OrgID": "${env:TENANT}" } : undefined },
        ]),
      ),
      service: { pipelines: { traces: { receivers: ["otlp"], processors: pipeline, exporters: t.map((_, i) => `otlphttp/tempo${i}`) } } },
    },
  };
}

/** Alertmanager on a remote cluster (placement "both"), receiving alerts from the local Prometheus. */
export function remoteAlertmanagerValues(cfg: PlannerConfig, env: string): Values | null {
  const am = cfg.components.alertmanager;
  if (!am.enabled || am.options.placement !== "both") return null;
  const w = remoteWorkloads(cfg, env, "alertmanager")[0];
  return {
    fullnameOverride: "alertmanager",
    replicaCount: w?.final.replicas ?? 2,
    resources: w ? resources(w) : undefined,
    persistence: { enabled: true, size: `${w?.final.pvcGi ?? 1}Gi`, storageClass: storageClassOf(cfg, "alertmanager") },
    config: {
      route: { receiver: "default", group_by: ["alertname", "namespace"], group_wait: "30s", group_interval: "5m", repeat_interval: "4h" },
      receivers: [{ name: "default" }],
    },
  };
}

/** Cloud platform logs are pulled on the central cluster. */
export function cloudLogsValues(cfg: PlannerConfig, replicas: number): Values {
  const src = String(cfg.components["cloud-logs"].options.source);
  const source =
    src === "event-hubs"
      ? `loki.source.azure_event_hubs "cloud" {\n  fully_qualified_namespace = "<event-hubs-namespace>.servicebus.windows.net:9093"\n  event_hubs                = ["<event-hub-name>"]\n  authentication {\n    mechanism = "oauth"\n  }\n  forward_to = [loki.write.local.receiver]\n}\n`
      : src === "firehose"
        ? `loki.source.awsfirehose "cloud" {\n  http { listen_address = "0.0.0.0" listen_port = 8080 }\n  forward_to = [loki.write.local.receiver]\n}\n`
        : `loki.source.gcplog "cloud" {\n  pull {\n    project_id   = "<project-id>"\n    subscription = "<log-sink-subscription>"\n  }\n  forward_to = [loki.write.local.receiver]\n}\n`;
  return {
    fullnameOverride: "cloud-logs",
    controller: { type: "deployment", replicas },
    alloy: {
      configMap: {
        content: `// Cloud platform logs, pulled on the central cluster and written to the local Loki.\n${source}\nloki.write "local" {\n  endpoint {\n    url = "http://loki-gateway.${NS}.svc/loki/api/v1/push"\n${cfg.tenancy.enabled ? `    tenant_id = "cloud-platform"\n` : ""}  }\n}\n`,
      },
    },
  };
}
