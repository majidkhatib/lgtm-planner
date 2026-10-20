import type { ComponentId, OptionValue } from "../model/types";

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Managed";
/** vpa = Vertical Pod Autoscaler in recommendation-only mode */
export type Autoscaler = "none" | "hpa" | "keda" | "vpa";

export interface WorkloadDef {
  id: string;
  name: string;
  kind: WorkloadKind;
  role: string;
  why: string;
  /** Set for optional workloads: when it is safe to leave it out */
  skip?: string;
  required: boolean;
  defaultEnabled?: boolean;
  pvc?: boolean;
  /** Autoscalers the official chart supports for this workload ("none" always allowed) */
  autoscalers: Autoscaler[];
  defaultAutoscaler?: Autoscaler;
}

export const AUTOSCALER_INFO: Record<Autoscaler, { label: string; text: string }> = {
  none: { label: "Fixed", text: "Replica count stays as sized. Predictable; you scale by changing the number." },
  hpa: { label: "HPA", text: "Horizontal Pod Autoscaler: adds/removes pods based on CPU or memory use. Built into Kubernetes." },
  keda: {
    label: "KEDA",
    text: "Scales on application metrics (e.g. query queue length, inflight requests) instead of CPU. Reacts before pods are overloaded. Needs the KEDA operator.",
  },
  vpa: {
    label: "VPA (advice)",
    text: "Vertical Pod Autoscaler in recommendation mode: suggests CPU/memory requests from real usage without restarting pods. Safe for every workload.",
  },
};

export const KIND_SCALING_NOTE: Record<WorkloadKind, string> = {
  Deployment: "Stateless: pods can be added or removed at any time, so horizontal autoscaling is safe.",
  StatefulSet:
    "Stateful with a disk: before a pod is removed it has to flush or hand off in-memory data, and its PVC stays behind. Scaling down automatically can lose data or leave orphaned disks, so these are scaled deliberately (Mimir uses the rollout-operator for safe ingester scale-down).",
  DaemonSet: "One pod per node: scales with the number of nodes automatically.",
  Managed: "Runs as a cloud service outside the cluster.",
};

const STATEFUL = { kind: "StatefulSet" as const, pvc: true, autoscalers: ["none", "vpa"] as Autoscaler[] };
const cache = (id: string, name: string, role: string): WorkloadDef => ({
  id,
  name,
  kind: "StatefulSet",
  role,
  why: "Avoids repeating expensive work and reduces object-storage read requests, which are billed per request.",
  skip: "Small installs where dashboards are already fast; you can add caches later without data migration.",
  required: false,
  defaultEnabled: true,
  autoscalers: ["none", "vpa"],
});
const gateway = (backend: string): WorkloadDef => ({
  id: "gateway",
  name: "Gateway (NGINX)",
  kind: "Deployment",
  role: `Single entry point that routes writes and queries to the right ${backend} component and can check basic auth.`,
  why: "Remote clusters and Grafana need one address instead of one per component. Required for per-tenant basic auth at the edge.",
  skip: "If your Ingress/Gateway controller routes paths to the components directly and handles auth itself.",
  required: false,
  defaultEnabled: true,
  autoscalers: ["none", "hpa", "vpa"],
  defaultAutoscaler: "hpa",
});

// ------------------------------------------------------------------ Mimir
const MIMIR_DISTRIBUTED = (opts: Record<string, OptionValue>, mimirAlertmanager: boolean): WorkloadDef[] => [
  {
    id: "distributor",
    name: "Distributor",
    kind: "Deployment",
    role: "Stateless entry point of the write path: validates incoming series, enforces tenant limits and shards data to ingesters" + (opts.architecture === "ingest" ? " (writes to Kafka)." : "."),
    why: "Every sample passes through it; without it nothing is written.",
    required: true,
    autoscalers: ["none", "keda", "vpa"],
    defaultAutoscaler: "keda",
  },
  {
    id: "ingester",
    name: "Ingester",
    ...STATEFUL,
    role: "Keeps recent series in memory (TSDB head), writes a WAL to its disk and ships compressed 2-hour blocks to object storage.",
    why: "Holds the last ~2 hours of data that isn't in object storage yet. The biggest memory consumer.",
    required: true,
  },
  {
    id: "querier",
    name: "Querier",
    kind: "Deployment",
    role: "Executes PromQL: reads recent data from ingesters and older data from store-gateways.",
    why: "Every dashboard panel and alert rule is a query that runs here.",
    required: true,
    autoscalers: ["none", "keda", "vpa"],
    defaultAutoscaler: "keda",
  },
  {
    id: "query-frontend",
    name: "Query-frontend",
    kind: "Deployment",
    role: "Splits long or heavy queries into smaller ones, runs them in parallel and caches results.",
    why: "Makes long time ranges fast and protects queriers from single huge queries.",
    required: true,
    autoscalers: ["none", "keda", "vpa"],
  },
  {
    id: "query-scheduler",
    name: "Query-scheduler",
    kind: "Deployment",
    role: "Queues queries fairly per tenant and hands them to free queriers.",
    why: "Stops one tenant's heavy queries from starving everyone else; lets queriers scale independently of query-frontends.",
    skip: "Single-tenant, low query load: query-frontends can queue queries themselves.",
    required: false,
    defaultEnabled: true,
    autoscalers: ["none", "vpa"],
  },
  {
    id: "store-gateway",
    name: "Store-gateway",
    ...STATEFUL,
    role: "Serves data older than ~2 hours from object storage, keeping index headers of the blocks on its disk.",
    why: "Without it only the last hours are queryable.",
    required: true,
  },
  {
    id: "compactor",
    name: "Compactor",
    ...STATEFUL,
    role: "Merges and deduplicates blocks in object storage and deletes data older than the retention.",
    why: "Without compaction, queries get slower every day and retention isn't enforced (storage grows forever).",
    required: true,
  },
  {
    id: "ruler",
    name: "Ruler",
    kind: "Deployment",
    role: "Evaluates recording and alerting rules on a schedule and sends firing alerts to Alertmanager.",
    why: "Needed for alerts and recording rules evaluated centrally on Mimir data.",
    skip: "If alerting rules are evaluated elsewhere (e.g. Grafana-managed alerts only).",
    required: false,
    defaultEnabled: true,
    autoscalers: ["none", "keda", "vpa"],
  },
  ...(mimirAlertmanager
    ? [
        {
          id: "alertmanager",
          name: "Alertmanager (Mimir)",
          ...STATEFUL,
          role: "Multi-tenant Alertmanager built into Mimir: routes, groups and silences alerts per tenant.",
          why: "You chose Mimir's built-in Alertmanager in the Alertmanager step.",
          required: true,
        } satisfies WorkloadDef,
      ]
    : []),
  {
    id: "overrides-exporter",
    name: "Overrides-exporter",
    kind: "Deployment",
    role: "Exposes per-tenant limits as metrics.",
    why: "Lets you alert before a tenant hits its limits (e.g. 90 % of max series).",
    skip: "If you don't need dashboards/alerts on tenant limits.",
    required: false,
    defaultEnabled: false,
    autoscalers: ["none"],
  },
  gateway("Mimir"),
  cache("results-cache", "Results cache (memcached)", "Caches query results for the query-frontend."),
  cache("index-cache", "Index cache (memcached)", "Caches block index lookups for store-gateways."),
  cache("chunks-cache", "Chunks cache (memcached)", "Caches chunk data read from object storage."),
  cache("metadata-cache", "Metadata cache (memcached)", "Caches bucket listings and block metadata."),
];

// ------------------------------------------------------------------ Loki
const LOKI_DISTRIBUTED: WorkloadDef[] = [
  {
    id: "distributor",
    name: "Distributor",
    kind: "Deployment",
    role: "Receives log pushes, validates them, applies rate limits and sends each stream to the right ingesters.",
    why: "Entry point of every log line.",
    required: true,
    autoscalers: ["none", "hpa", "keda", "vpa"],
    defaultAutoscaler: "hpa",
  },
  {
    id: "ingester",
    name: "Ingester",
    ...STATEFUL,
    role: "Builds compressed chunks in memory, writes a WAL and flushes chunks to object storage.",
    why: "Holds recent logs until they're flushed; serves the most recent data to queries.",
    required: true,
  },
  {
    id: "querier",
    name: "Querier",
    kind: "Deployment",
    role: "Runs LogQL: reads from ingesters (recent) and object storage (older).",
    why: "Every Explore search and log panel runs here. Query cost varies a lot, so this is the main thing to scale.",
    required: true,
    autoscalers: ["none", "hpa", "keda", "vpa"],
    defaultAutoscaler: "keda",
  },
  {
    id: "query-frontend",
    name: "Query-frontend",
    kind: "Deployment",
    role: "Splits queries by time and shards, retries and caches results.",
    why: "Makes large time ranges usable and prevents single queries from overloading queriers.",
    required: true,
    autoscalers: ["none", "hpa", "keda", "vpa"],
  },
  {
    id: "query-scheduler",
    name: "Query-scheduler",
    kind: "Deployment",
    role: "Fair per-tenant query queue between query-frontends and queriers.",
    why: "Keeps one tenant from monopolising queriers; lets queriers scale freely.",
    skip: "Single tenant with light query load.",
    required: false,
    defaultEnabled: true,
    autoscalers: ["none", "vpa"],
  },
  {
    id: "index-gateway",
    name: "Index gateway",
    ...STATEFUL,
    role: "Serves the TSDB index from object storage to queriers.",
    why: "Queriers don't each have to download the index; faster queries and fewer storage reads.",
    required: true,
  },
  {
    id: "compactor",
    name: "Compactor",
    ...STATEFUL,
    role: "Compacts index files and applies retention/deletion (singleton).",
    why: "Without it the index keeps growing and retention is never enforced.",
    required: true,
  },
  {
    id: "ruler",
    name: "Ruler",
    ...STATEFUL,
    role: "Evaluates LogQL alerting and recording rules.",
    why: "Needed for alerts based on log content (e.g. error rate in logs).",
    skip: "If you don't alert on logs.",
    required: false,
    defaultEnabled: true,
  },
  {
    id: "pattern-ingester",
    name: "Pattern ingester",
    ...STATEFUL,
    role: "Detects recurring log patterns for the Logs Drilldown app in Grafana.",
    why: "Makes it easy to spot new or spiking log patterns without writing queries.",
    skip: "If you don't use Grafana Logs Drilldown; it adds CPU and memory.",
    required: false,
    defaultEnabled: false,
  },
  gateway("Loki"),
  cache("chunks-cache", "Chunks cache (memcached)", "Caches log chunks read from object storage."),
  cache("results-cache", "Results cache (memcached)", "Caches query results in the query-frontend."),
];

const LOKI_SIMPLE_SCALABLE: WorkloadDef[] = [
  { id: "write", name: "Write", ...STATEFUL, role: "Distributor + ingester combined.", why: "Receives and stores incoming logs.", required: true },
  { id: "read", name: "Read", kind: "Deployment", role: "Query-frontend + querier combined.", why: "Serves all queries.", required: true, autoscalers: ["none", "hpa", "keda", "vpa"], defaultAutoscaler: "hpa" },
  { id: "backend", name: "Backend", ...STATEFUL, role: "Compactor, index gateway, query scheduler and ruler combined.", why: "Background work and index serving.", required: true },
  gateway("Loki"),
  cache("chunks-cache", "Chunks cache (memcached)", "Caches log chunks read from object storage."),
  cache("results-cache", "Results cache (memcached)", "Caches query results."),
];

const LOKI_MONOLITHIC: WorkloadDef[] = [
  { id: "single-binary", name: "Loki (single binary)", ...STATEFUL, role: "All Loki components in one process.", why: "Simplest deployment for small volumes.", required: true },
  gateway("Loki"),
];

// ------------------------------------------------------------------ Tempo
const TEMPO_DISTRIBUTED: WorkloadDef[] = [
  {
    id: "distributor",
    name: "Distributor",
    kind: "Deployment",
    role: "Receives spans (OTLP, Jaeger, Zipkin) and writes them to Kafka, partitioned by trace ID.",
    why: "Entry point of every span.",
    required: true,
    autoscalers: ["none", "hpa", "vpa"],
    defaultAutoscaler: "hpa",
  },
  {
    id: "live-store",
    name: "Live-store",
    ...STATEFUL,
    role: "Consumes recent spans from Kafka and makes them searchable within seconds (replaces the Tempo 2 ingester).",
    why: "Without it, traces only become visible after block-builders have written them to storage.",
    required: true,
  },
  {
    id: "block-builder",
    name: "Block-builder",
    kind: "StatefulSet",
    role: "Consumes Kafka partitions and writes Parquet blocks to object storage. One replica per partition.",
    why: "This is what persists traces long-term.",
    required: true,
    autoscalers: ["none", "vpa"],
  },
  {
    id: "querier",
    name: "Querier",
    kind: "Deployment",
    role: "Finds traces by ID and runs TraceQL searches over live-stores and object storage.",
    why: "Every trace lookup and search runs here.",
    required: true,
    autoscalers: ["none", "hpa", "vpa"],
    defaultAutoscaler: "hpa",
  },
  {
    id: "query-frontend",
    name: "Query-frontend",
    kind: "Deployment",
    role: "Shards searches across queriers and assembles results.",
    why: "Makes TraceQL searches over long ranges feasible.",
    required: true,
    autoscalers: ["none", "hpa", "vpa"],
  },
  {
    id: "backend-scheduler",
    name: "Backend scheduler",
    ...STATEFUL,
    role: "Plans compaction and retention jobs (exactly one replica).",
    why: "Coordinates backend-workers; without it blocks are never compacted or deleted.",
    required: true,
  },
  {
    id: "backend-worker",
    name: "Backend worker",
    kind: "StatefulSet",
    role: "Executes compaction and retention jobs from the scheduler.",
    why: "Keeps the number of blocks low (faster searches) and deletes expired traces.",
    required: true,
    autoscalers: ["none", "hpa", "vpa"],
  },
  {
    id: "metrics-generator",
    name: "Metrics-generator",
    kind: "Deployment",
    autoscalers: ["none", "vpa"],
    role: "Derives service-graph and RED metrics from spans and remote-writes them to Mimir.",
    why: "Gives request rate, errors and latency per service without extra instrumentation.",
    skip: "If you don't need span-derived metrics; it adds series to Mimir.",
    required: false,
    defaultEnabled: true,
  },
  gateway("Tempo"),
  cache("memcached", "Cache (memcached)", "Caches bloom filters, Parquet footers and search results."),
];

const TEMPO_MONOLITHIC: WorkloadDef[] = [
  { id: "tempo", name: "Tempo (single binary)", ...STATEFUL, role: "All Tempo components in one process.", why: "Simplest deployment for low trace volume.", required: true },
];

// ------------------------------------------------------------------ Pyroscope
const PYROSCOPE_MONOLITHIC: WorkloadDef[] = [
  { id: "pyroscope", name: "Pyroscope (single binary)", ...STATEFUL, role: "All Pyroscope components in one process.", why: "Enough for most profiling volumes.", required: true },
];
// Pyroscope 2.x microservices (v2 storage architecture), as defined in the official chart.
const PYROSCOPE_DISTRIBUTED: WorkloadDef[] = [
  { id: "distributor", name: "Distributor", kind: "Deployment", role: "Receives profiles and routes them to segment-writers.", why: "Entry point of every profile.", required: true, autoscalers: ["none", "hpa", "vpa"] },
  { id: "segment-writer", name: "Segment-writer", ...STATEFUL, role: "Batches incoming profiles into small segments and writes them to object storage.", why: "The write path of the v2 storage architecture.", required: true },
  { id: "metastore", name: "Metastore", ...STATEFUL, role: "Raft-replicated index of all blocks and segments (3 replicas).", why: "Queries and compaction look up blocks here.", required: true },
  { id: "compaction-worker", name: "Compaction worker", ...STATEFUL, role: "Merges small segments into larger blocks and applies retention.", why: "Keeps storage and queries efficient.", required: true },
  { id: "query-frontend", name: "Query-frontend", kind: "Deployment", role: "Receives profile queries and plans them.", why: "Entry point of the read path.", required: true, autoscalers: ["none", "hpa", "vpa"] },
  { id: "query-backend", name: "Query-backend", kind: "Deployment", role: "Reads blocks from object storage and builds flame graphs.", why: "Every profile query runs here.", required: true, autoscalers: ["none", "hpa", "vpa"] },
  { id: "tenant-settings", name: "Tenant settings", kind: "Deployment", role: "Stores per-tenant settings (e.g. recording rules for profiles).", why: "Used by the Grafana Profiles Drilldown app.", required: true, autoscalers: ["none"] },
];

// ------------------------------------------------------------------ others
const SIMPLE: Partial<Record<ComponentId, WorkloadDef[]>> = {
  prometheus: [],
  "kube-state-metrics": [
    { id: "kube-state-metrics", name: "kube-state-metrics", kind: "Deployment", role: "Exports Kubernetes object state as metrics.", why: "Required for workload health dashboards and alerts.", required: true, autoscalers: ["none", "vpa"] },
  ],
  "node-exporter": [
    { id: "node-exporter", name: "Node exporter", kind: "DaemonSet", role: "One pod per node exposing host metrics.", why: "Node CPU, memory, disk and network.", required: true, autoscalers: ["none", "vpa"] },
  ],
  "alloy-logs": [
    { id: "alloy-logs", name: "Alloy (logs)", kind: "DaemonSet", role: "Tails container logs on each node.", why: "Ships pod logs to Loki.", required: true, autoscalers: ["none", "vpa"] },
  ],
  "alloy-events": [
    { id: "alloy-events", name: "Alloy (events)", kind: "Deployment", role: "Watches the Kubernetes API for events (1 replica).", why: "Stores cluster events in Loki.", required: true, autoscalers: ["none", "vpa"] },
  ],
  "cloud-logs": [
    { id: "alloy-cloud-logs", name: "Alloy (cloud logs)", kind: "Deployment", role: "Consumes the cloud log stream and pushes to Loki.", why: "Brings cloud platform logs into Loki.", required: true, autoscalers: ["none", "hpa", "vpa"] },
  ],
  "trace-collector": [
    { id: "trace-collector", name: "Trace collector", kind: "Deployment", role: "OTLP receiver, batching and sampling.", why: "Local endpoint for applications.", required: true, autoscalers: ["none", "hpa", "vpa"], defaultAutoscaler: "hpa" },
  ],
  "alloy-profiles": [
    { id: "alloy-profiles", name: "Alloy (profiles)", kind: "DaemonSet", role: "eBPF / pull-based profile collection on each node.", why: "Sends profiles to Pyroscope.", required: true, autoscalers: ["none", "vpa"] },
  ],
  beyla: [
    { id: "beyla", name: "Alloy (Beyla eBPF)", kind: "DaemonSet", role: "eBPF auto-instrumentation of every app pod on the node.", why: "Creates RED metrics and traces without code changes.", required: true, autoscalers: ["none", "vpa"] },
  ],
  grafana: [
    { id: "grafana", name: "Grafana", kind: "Deployment", role: "The UI.", why: "Dashboards and Explore.", required: true, autoscalers: ["none", "hpa", "vpa"] },
  ],
  alertmanager: [
    { id: "alertmanager", name: "Alertmanager", ...STATEFUL, role: "Clustered Alertmanager with silences/notification log on disk.", why: "Routes notifications.", required: true },
  ],
  robusta: [
    { id: "runner", name: "Robusta runner", kind: "Deployment", role: "Receives alerts, runs enrichment playbooks.", why: "Core of Robusta.", required: true, autoscalers: ["none", "vpa"] },
    { id: "forwarder", name: "Robusta forwarder", kind: "Deployment", role: "Watches Kubernetes changes and forwards them to the runner.", why: "Adds 'what changed' context to alerts.", required: true, autoscalers: ["none", "vpa"] },
    { id: "holmes", name: "HolmesGPT", kind: "Deployment", role: "AI agent that investigates alerts using the chosen LLM.", why: "Root-cause suggestions in the alert.", required: true, autoscalers: ["none", "hpa", "vpa"] },
  ],
};

/** Workloads that make up a component for the current options. */
export function workloadsFor(id: ComponentId, opts: Record<string, OptionValue>, ctx: { mimirAlertmanager: boolean }): WorkloadDef[] {
  switch (id) {
    case "mimir":
      return opts.mode === "distributed"
        ? MIMIR_DISTRIBUTED(opts, ctx.mimirAlertmanager)
        : [
            { id: "mimir", name: "Mimir (monolithic)", ...STATEFUL, role: "All Mimir components in one process, scaled as identical replicas.", why: "Simplest deployment for up to a few million series.", required: true },
            gateway("Mimir"),
          ];
    case "loki":
      return opts.mode === "distributed" ? LOKI_DISTRIBUTED : opts.mode === "simple-scalable" ? LOKI_SIMPLE_SCALABLE : LOKI_MONOLITHIC;
    case "tempo":
      return opts.mode === "distributed" ? TEMPO_DISTRIBUTED : TEMPO_MONOLITHIC;
    case "pyroscope":
      return opts.mode === "distributed" ? PYROSCOPE_DISTRIBUTED : PYROSCOPE_MONOLITHIC;
    case "prometheus":
      return opts.collector === "alloy"
        ? [{ id: "alloy-metrics", name: "Alloy (metrics, clustered)", kind: "StatefulSet", pvc: true, role: "Scrapes targets, shared across replicas via clustering.", why: "Collects and forwards metrics.", required: true, autoscalers: ["none", "hpa", "vpa"] }]
        : opts.mode === "server"
          ? [{ id: "prometheus-agent", name: "Prometheus (server mode)", ...STATEFUL, role: "Scrapes targets, keeps the last days locally, evaluates local alert rules and remote-writes to Mimir.", why: "Collects and forwards metrics; alerts locally.", required: true }]
          : [{ id: "prometheus-agent", name: "Prometheus (agent mode)", ...STATEFUL, role: "Scrapes targets and remote-writes to Mimir; keeps only a WAL on disk.", why: "Collects and forwards metrics.", required: true }];
    case "kafka":
      return opts.provider === "managed"
        ? [{ id: "kafka", name: "Managed Kafka", kind: "Managed", role: "Cloud-managed Kafka cluster.", why: "Durable write pipeline.", required: true, autoscalers: ["none"] }]
        : opts.provider === "strimzi"
          ? [
              { id: "kafka-broker", name: "Kafka broker (Strimzi)", ...STATEFUL, role: "Stores partitions of the ingest topics.", why: "Durable write pipeline, replicated 3×.", required: true },
              { id: "kafka-controller", name: "KRaft controller (Strimzi)", ...STATEFUL, role: "Kafka cluster metadata (replaces ZooKeeper).", why: "Required by Kafka.", required: true },
            ]
          : [{ id: "kafka-broker", name: "Kafka broker (bundled)", ...STATEFUL, role: "Single broker, no replication.", why: "Dev/test only.", required: true }];
    case "langfuse": {
      const list: WorkloadDef[] = [
        { id: "web", name: "Langfuse web", kind: "Deployment", role: "UI and public API, including the OTLP ingest endpoint.", why: "Receives traces from LLM apps and serves the UI.", required: true, autoscalers: ["none", "hpa", "keda", "vpa"], defaultAutoscaler: "hpa" },
        { id: "worker", name: "Langfuse worker", kind: "Deployment", role: "Processes the ingestion queue and writes to ClickHouse.", why: "Without it, traces are accepted but never stored.", required: true, autoscalers: ["none", "hpa", "keda", "vpa"], defaultAutoscaler: "hpa" },
      ];
      if (opts.clickhouse === "bundled" || opts.clickhouse === "operator") {
        const where = opts.clickhouse === "operator" ? ` (namespace ${String(opts.clickhouseNamespace || "clickhouse")})` : "";
        list.push({ id: "clickhouse", name: `ClickHouse${where}`, ...STATEFUL, role: "Stores traces, observations and scores.", why: "Langfuse's analytical database.", required: true });
        if (opts.clickhouseReplicated)
          list.push({ id: "clickhouse-keeper", name: `ClickHouse Keeper${where}`, ...STATEFUL, role: "Coordinates replication between ClickHouse replicas (Raft, replaces ZooKeeper).", why: "Required for replicated ClickHouse tables.", required: true });
        if (opts.clickhouse === "operator")
          list.push({ id: "clickhouse-operator", name: "Altinity ClickHouse Operator", kind: "Deployment", role: "Watches ClickHouseInstallation resources and manages the ClickHouse StatefulSets, config and upgrades.", why: "Runs ClickHouse as a separate, operator-managed installation.", required: true, autoscalers: ["none"] });
      }
      if (opts.postgres === "bundled") list.push({ id: "postgresql", name: "PostgreSQL (in cluster)", ...STATEFUL, role: "Users, projects, prompts, API keys.", why: "Langfuse's transactional database.", required: true });
      if (opts.redis === "bundled") list.push({ id: "redis", name: "Redis / Valkey (in cluster)", ...STATEFUL, role: "Ingestion queue and cache.", why: "Decouples the web from the worker.", required: true });
      if (opts.objectStorage === "bundled") list.push({ id: "seaweedfs", name: "SeaweedFS (S3-compatible)", ...STATEFUL, role: "Stores raw events and media.", why: "Object storage inside the cluster.", required: true });
      return list;
    }
    default:
      return SIMPLE[id] ?? [];
  }
}
