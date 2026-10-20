import type { ComponentId, OptionValue, PlannerConfig, SignalId } from "../model/types";
import { CLOUDS } from "./clouds";
import type { Question } from "./questions";
import { CHARTS, type ChartRef } from "./versions";

export type ComponentGroup = "metrics" | "logs" | "traces" | "profiles" | "ai" | "visualisation" | "alerting" | "aiops" | "pipeline";

export interface ComponentDef {
  id: ComponentId;
  name: string;
  group: ComponentGroup;
  runsOn: "central" | "remote" | "both";
  /** Only offered when this signal is enabled */
  signal?: SignalId;
  charts: ChartRef[];
  what: string;
  why: string;
  skip: string;
  /** Default answer for the Yes/No question */
  recommended: (cfg: PlannerConfig) => boolean;
  /** Extra condition for showing the component at all */
  isRelevant?: (cfg: PlannerConfig) => boolean;
  /** Extra remark shown while the component is enabled */
  enabledNote?: (cfg: PlannerConfig) => string | undefined;
  /** What changes elsewhere in the design when this component is skipped */
  skipEffect?: (cfg: PlannerConfig) => string[];
  questions: Question[];
  defaults: (cfg: PlannerConfig) => Record<string, OptionValue>;
}

const on = (cfg: PlannerConfig, id: ComponentId) => cfg.components[id]?.enabled === true;
const opt = (cfg: PlannerConfig, id: ComponentId, key: string) => cfg.components[id]?.options[key];

export function kafkaNeeded(cfg: PlannerConfig): boolean {
  return (
    (cfg.signals.metrics && on(cfg, "mimir") && opt(cfg, "mimir", "mode") === "distributed" && opt(cfg, "mimir", "architecture") === "ingest") ||
    (cfg.signals.traces && on(cfg, "tempo") && opt(cfg, "tempo", "mode") === "distributed")
  );
}

const zoneAwareQuestion: Question = {
  kind: "toggle",
  id: "zoneAware",
  label: "Spread replicas across availability zones",
  help: "Places replicas of the stateful parts in different zones, so losing a whole zone doesn't lose data or availability. Needs a cluster that spans zones.",
  visibleIf: (cfg, o) => cfg.topology.zones > 1 && o.mode === "distributed",
};

const ingressQuestion = (service: string): Question => ({
  kind: "text",
  id: "host",
  label: `Hostname for ${service}`,
  help: `Leave empty to use ${service.toLowerCase()}.<your base domain>.`,
  placeholder: `${service.toLowerCase()}.observability.example.com`,
});

export const COMPONENTS: ComponentDef[] = [
  // ---------------------------------------------------------------- metrics
  {
    id: "prometheus",
    name: "Metrics collector",
    group: "metrics",
    runsOn: "remote",
    signal: "metrics",
    charts: [CHARTS.prometheus],
    what: "Scrapes metrics from pods, nodes and Kubernetes on every remote cluster and forwards them to Mimir with remote_write.",
    why: "Something has to collect metrics where the workloads run. In agent mode Prometheus keeps no long-term data locally: just a small write-ahead log, so it's light and the central Mimir is the single source of truth.",
    skip: "Only if you collect metrics with another agent (e.g. Alloy or the OpenTelemetry Collector) — choose that below instead of skipping.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "collector",
        label: "Metrics collector on remote clusters",
        layout: "cards",
        options: [
          { value: "prometheus", label: "Prometheus", badge: "Recommended", description: "Familiar config (scrape_configs, ServiceMonitor-style), easy to debug." },
          { value: "alloy", label: "Grafana Alloy", description: "One agent for metrics, logs, traces and profiles. Fewer moving parts if you already run Alloy for logs." },
        ],
      },
      {
        kind: "choice",
        id: "mode",
        label: "Prometheus mode",
        layout: "cards",
        visibleIf: (_c, o) => o.collector === "prometheus",
        options: [
          {
            value: "agent",
            label: "Agent mode",
            badge: "Recommended",
            description: "Scrapes and forwards to Mimir; keeps only a small write-ahead log. Lightest option. All alert rules run centrally (Mimir ruler).",
          },
          {
            value: "server",
            label: "Server mode (local storage + local alerting)",
            description:
              "Also keeps the last days of data on the remote cluster and evaluates alert rules there, so alerts still fire when the link to the central cluster is down. Needs more memory and a bigger disk.",
          },
        ],
      },
      {
        kind: "number",
        id: "localRetentionDays",
        label: "Local retention on each remote cluster",
        unit: "days",
        min: 1,
        max: 30,
        help: "Only for server mode: how long data stays on the remote cluster's own disk (long-term data is in Mimir anyway). 2–3 days covers a weekend outage of the central cluster.",
        visibleIf: (_c, o) => o.collector === "prometheus" && o.mode === "server",
      },
      { kind: "number", id: "scrapeInterval", label: "Scrape interval", unit: "seconds", min: 10, max: 120, step: 5, help: "How often targets are scraped. 30 s is a good balance; 15 s doubles the samples (and cost)." },
    ],
    defaults: () => ({ collector: "prometheus", mode: "agent", localRetentionDays: 2, scrapeInterval: 30 }),
  },
  {
    id: "kube-state-metrics",
    name: "kube-state-metrics",
    group: "metrics",
    runsOn: "both",
    signal: "metrics",
    charts: [CHARTS.kubeStateMetrics],
    what: "Turns the state of Kubernetes objects (deployments, pods, jobs, PVCs, nodes) into metrics.",
    why: "Without it you can't alert on things like 'deployment has 0 available replicas', crash loops or pending pods. Almost every Kubernetes dashboard depends on it.",
    skip: "If your clusters already run it (e.g. installed by another stack) — running two copies duplicates series.",
    recommended: () => true,
    questions: [],
    defaults: () => ({}),
  },
  {
    id: "node-exporter",
    name: "Node exporter",
    group: "metrics",
    runsOn: "both",
    signal: "metrics",
    charts: [CHARTS.nodeExporter],
    what: "A DaemonSet that exposes host metrics of every node: CPU, memory, disk, filesystem, network.",
    why: "Needed to see node pressure, full disks and noisy neighbours — the most common causes of 'random' pod failures.",
    skip: "If node metrics already come from elsewhere (e.g. a cloud agent you want to keep).",
    recommended: () => true,
    questions: [],
    defaults: () => ({}),
  },
  // ---------------------------------------------------------------- pipeline
  {
    id: "kafka",
    name: "Kafka (write buffer)",
    group: "pipeline",
    runsOn: "central",
    charts: [],
    what: "Optional. Apache Kafka is a durable message queue. When it's on, incoming metrics and traces are written to Kafka first, and Mimir and Tempo read them from there at their own pace. One Kafka serves both: Mimir and Tempo each get their own topic. It isn't a separate Kubernetes cluster: it's either a managed cloud service (no servers for you to run) or 3 Kafka pods inside the central cluster, run by the Strimzi operator.",
    why: "If Mimir or Tempo restarts, is upgraded or is busy answering heavy queries, nothing is lost or slowed down: data waits safely in Kafka. It's Grafana's preferred design for Mimir 3 at scale, and distributed Tempo 3 is built on it.",
    skip: "Most setups do fine without it, and it adds cost (a managed Kafka or 3 more brokers). Without Kafka, Mimir uses its classic architecture and Tempo runs in monolithic mode, because distributed Tempo 3 needs Kafka.",
    recommended: () => false,
    isRelevant: (cfg) => cfg.signals.metrics || cfg.signals.traces,
    enabledNote: (cfg) =>
      kafkaNeeded(cfg)
        ? undefined
        : "Nothing uses Kafka with your current choices. It's used when Mimir is distributed with the ingest storage architecture, or Tempo is distributed. Otherwise you can skip it.",
    skipEffect: (cfg) => {
      const effects: string[] = [];
      if (cfg.signals.metrics && cfg.components.mimir?.enabled !== false) effects.push("Mimir uses the classic architecture (ingesters receive writes directly).");
      if (cfg.signals.traces && cfg.components.tempo?.enabled !== false) effects.push("Tempo runs in monolithic mode (distributed Tempo 3 needs Kafka).");
      return effects;
    },
    questions: [
      {
        kind: "choice",
        id: "provider",
        label: "Where should Kafka run?",
        help: "Either way it's one Kafka for the whole central cluster, shared by Mimir and Tempo (one topic each). Remote clusters never talk to Kafka: they keep sending to the Mimir/Tempo gateways as before.",
        layout: "cards",
        options: (cfg) => [
          { value: "managed", label: CLOUDS[cfg.platform.cloud].managedKafka, badge: "Least operations", description: "A Kafka service run by the cloud provider, outside your Kubernetes cluster. Mimir and Tempo connect to its endpoint. You pay per broker or throughput; upgrades, disks and replication are handled for you." },
          { value: "strimzi", label: "Strimzi operator (self-hosted)", description: "Kafka runs as pods inside the central cluster (3 brokers with their own disks, in the central node pool), managed by the Strimzi operator. Usually cheaper, but you handle upgrades, disk space and broker failures." },
          {
            value: "bundled",
            label: "Bundled single broker (Mimir chart default)",
            description: "The broker that ships with the Mimir chart.",
            warning: "Single broker, no replication: only for dev/test.",
          },
        ],
      },
    ],
    defaults: () => ({ provider: "managed" }),
  },

  {
    id: "mimir",
    name: "Grafana Mimir",
    group: "metrics",
    runsOn: "central",
    signal: "metrics",
    charts: [CHARTS.mimir],
    what: "Horizontally scalable, multi-tenant long-term storage for Prometheus metrics, keeping data in object storage.",
    why: "Prometheus alone keeps data on one disk in one cluster. Mimir gives all clusters one place to query, long retention at object-storage prices, high availability and tenant isolation.",
    skip: "Only if you send metrics to another backend. Without Mimir there are no central metrics.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "architecture",
        label: "Write path architecture",
        help: "The official Mimir Helm chart deploys Mimir as microservices (there is no monolithic mode). For small installs the planner simply uses minimum replicas.",
        layout: "cards",
        options: (cfg) => [
          {
            value: "ingest",
            label: "Ingest storage (Kafka)",
            badge: "Preferred by Grafana",
            description: "Writes go through Kafka; reads and writes are decoupled, so heavy queries can't slow ingestion. Needs Kafka (asked in the Kafka step).",
            warning: cfg.components.kafka?.enabled !== true ? "Kafka is off, so the classic architecture is used. Turn Kafka on in the Kafka step to use this." : undefined,
          },
          { value: "classic", label: "Classic", description: "Ingesters receive writes directly and keep a local WAL. No Kafka to run, but reads and writes share the ingesters." },
        ],
      },
      zoneAwareQuestion,
      ingressQuestion("Mimir"),
    ],
    defaults: (cfg) => ({ mode: "distributed", architecture: cfg.components.kafka?.enabled === true ? "ingest" : "classic", zoneAware: cfg.topology.zones > 1 }),
  },

  // ---------------------------------------------------------------- logs
  {
    id: "alloy-logs",
    name: "Alloy — pod logs",
    group: "logs",
    runsOn: "remote",
    signal: "logs",
    charts: [CHARTS.alloy],
    what: "Grafana Alloy running as a DaemonSet that tails container logs on every node and ships them to Loki.",
    why: "Collects logs where they're written, adds Kubernetes labels (namespace, pod, app) and can drop noisy lines before they cost you storage. Promtail, the old shipper, is deprecated in favour of Alloy.",
    skip: "If logs are already shipped by another agent (Fluent Bit, Vector…) that can write to Loki.",
    recommended: () => true,
    questions: [
      { kind: "toggle", id: "dropDebug", label: "Drop debug-level logs at the source", help: "Often 30–60 % of all log volume. Dropping them on the node is the cheapest optimisation there is." },
    ],
    defaults: () => ({ dropDebug: false }),
  },
  {
    id: "alloy-events",
    name: "Alloy — Kubernetes events",
    group: "logs",
    runsOn: "remote",
    signal: "logs",
    charts: [CHARTS.alloy],
    what: "A single Alloy instance per cluster that stores Kubernetes events (OOMKilled, FailedScheduling, BackOff…) in Loki.",
    why: "Kubernetes keeps events for only about an hour. Storing them in Loki lets you see why a pod died last night.",
    skip: "If you don't need history of cluster events.",
    recommended: () => true,
    questions: [],
    defaults: () => ({}),
  },
  {
    id: "cloud-logs",
    name: "Cloud platform logs",
    group: "logs",
    runsOn: "central",
    signal: "logs",
    charts: [CHARTS.alloy],
    what: "Pulls logs of cloud services (firewall, load balancers, audit logs) from the cloud's streaming service into Loki via Alloy.",
    why: "Puts infrastructure and application logs side by side in Grafana. Firewall and audit logs are often the largest log source, so they get their own volume in the sizing.",
    skip: "If you only need logs from Kubernetes workloads.",
    recommended: () => false,
    questions: [
      {
        kind: "choice",
        id: "source",
        label: "Source",
        layout: "cards",
        options: (cfg) => [
          cfg.platform.cloud === "azure"
            ? { value: "event-hubs", label: "Azure Event Hubs", description: "Diagnostic settings → Event Hub → Alloy (loki.source.azure_event_hubs)." }
            : cfg.platform.cloud === "aws"
              ? { value: "firehose", label: "Amazon Data Firehose", description: "CloudWatch subscription → Firehose → Alloy (loki.source.awsfirehose)." }
              : { value: "pubsub", label: "Google Pub/Sub", description: "Log sink → Pub/Sub → Alloy (loki.source.gcplog)." },
        ],
      },
    ],
    defaults: (cfg) => ({ source: cfg.platform.cloud === "azure" ? "event-hubs" : cfg.platform.cloud === "aws" ? "firehose" : "pubsub" }),
  },
  {
    id: "loki",
    name: "Grafana Loki",
    group: "logs",
    runsOn: "central",
    signal: "logs",
    charts: [CHARTS.loki],
    what: "Log storage that indexes only labels, not the full text, and keeps compressed chunks in object storage.",
    why: "Much cheaper than full-text log systems at the same volume, multi-tenant, and queried with LogQL in the same Grafana as your metrics.",
    skip: "Only if logs go to another backend.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "mode",
        label: "How do you want to deploy Loki?",
        layout: "cards",
        options: [
          { value: "monolithic", label: "Monolithic", description: "One binary. Good for small installs, up to a few tens of GB/day, usually without HA." },
          {
            value: "simple-scalable",
            label: "Simple scalable",
            description: "Three targets: read, write, backend. Up to about 1 TB/day.",
            warning: "Deprecated: removed in Loki 4. Choose distributed for new installs so you don't have to migrate later.",
          },
          { value: "distributed", label: "Distributed (microservices)", badge: "Production", description: "Every component scales separately. Most capable; typical above ~1 TB/day, and the future-proof choice." },
        ],
      },
      zoneAwareQuestion,
      ingressQuestion("Loki"),
    ],
    defaults: (cfg) => ({ mode: "distributed", zoneAware: cfg.topology.zones > 1 }),
  },

  // ---------------------------------------------------------------- traces
  {
    id: "trace-collector",
    name: "Trace collector",
    group: "traces",
    runsOn: "remote",
    signal: "traces",
    charts: [CHARTS.alloy],
    what: "Receives traces from your applications over OTLP (gRPC 4317 / HTTP 4318), batches them and forwards them to Tempo.",
    why: "Applications send to a local endpoint, not across the network to the central cluster. The collector handles retries, batching, sampling and adds Kubernetes metadata.",
    skip: "If applications send OTLP straight to Tempo (not recommended across clusters).",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "collector",
        label: "Collector",
        layout: "cards",
        options: [
          { value: "alloy", label: "Grafana Alloy", badge: "Recommended", description: "Same agent family as logs; OTel-compatible pipeline." },
          { value: "otel", label: "OpenTelemetry Collector", description: "Vendor-neutral; pick it if your teams already standardise on it." },
        ],
      },
      {
        kind: "choice",
        id: "sampling",
        label: "Sampling: which traces are kept?",
        help: "Every request creates a trace. Storing all of them is often not needed and is the biggest Tempo cost driver. Sampling keeps a share of them.",
        layout: "cards",
        options: [
          { value: "none", label: "Keep everything (100 %)", description: "Every trace is stored. Simple, most expensive. Fine for low traffic or dev." },
          { value: "head", label: "Head sampling", description: "The decision is made when a request starts: keep X % at random. Cheap and simple, but a failed request is dropped with the same probability as a good one." },
          { value: "tail", label: "Tail sampling", badge: "Recommended", description: "The collector waits until a trace is complete, then always keeps errors and slow requests, plus X % of the rest. Needs more collector memory." },
        ],
      },
      {
        kind: "number",
        id: "samplingPercent",
        label: "Share of (normal) traces kept",
        unit: "%",
        min: 1,
        max: 100,
        step: 1,
        help: "10 % = 1 in 10 requests is stored. With tail sampling, errors and slow traces are kept on top of this.",
        visibleIf: (_c, o) => o.sampling !== "none",
      },
    ],
    defaults: () => ({ collector: "alloy", sampling: "tail", samplingPercent: 10 }),
  },
  {
    id: "beyla",
    name: "Beyla — auto-instrumentation (eBPF)",
    group: "traces",
    runsOn: "remote",
    charts: [CHARTS.alloy],
    what: "Optional. Beyla watches the network calls of your applications from the Linux kernel (eBPF) and turns them into metrics and traces, without any change to the application code or its container image. It runs inside Alloy as one pod per node on the remote clusters and covers every app pod on that node: HTTP, gRPC, SQL, Redis and Kafka calls, in any language (Java, .NET, Go, Python, Node.js, Rust, C++…).",
    why: "Every service gets request rate, errors and latency (RED metrics), a service graph and basic distributed traces from day one, even legacy or third-party apps nobody can instrument. Teams can still add OpenTelemetry SDKs later where they need more detail.",
    skip: "If your applications are already instrumented with OpenTelemetry or Prometheus client libraries, or if your clusters don't allow privileged pods. Beyla only sees calls at the network boundary: no internal functions, no business attributes, and no logs (logs still come from the log collector).",
    recommended: () => false,
    isRelevant: (cfg) => (cfg.signals.metrics && cfg.components.mimir?.enabled !== false) || (cfg.signals.traces && cfg.components.tempo?.enabled !== false),
    enabledNote: () =>
      "Needs Linux nodes with kernel 5.8 or newer (BTF), hostPID and extra Linux capabilities (BPF, PERFMON, SYS_PTRACE…). Managed node images on AKS, EKS and GKE meet this; clusters with strict Pod Security (\"restricted\") need an exception for the ns-monitoring namespace.",
    questions: [
      {
        kind: "choice",
        id: "exports",
        label: "What should Beyla produce?",
        layout: "cards",
        options: (cfg) => [
          {
            value: "both",
            label: "Metrics and traces",
            badge: "Recommended",
            description: "RED metrics and service graph in Mimir, spans in Tempo, linked with exemplars.",
            warning: !cfg.signals.traces ? "Traces are off in the signals step, so only metrics are sent." : !cfg.signals.metrics ? "Metrics are off in the signals step, so only traces are sent." : undefined,
          },
          { value: "metrics", label: "Metrics only", description: "Request rate, errors and latency per service and route, plus the service graph. No extra trace volume." },
          { value: "traces", label: "Traces only", description: "Spans for every request. Tempo's metrics-generator can still derive RED metrics from them." },
        ],
      },
      {
        kind: "choice",
        id: "scope",
        label: "Which applications should be instrumented?",
        layout: "cards",
        options: [
          { value: "all", label: "All applications", badge: "Recommended", description: "Every pod except the system namespaces (kube-system, ns-monitoring, cert-manager…)." },
          { value: "namespaces", label: "Only selected namespaces", description: "Start small, e.g. with one team, and widen later." },
        ],
      },
      {
        kind: "text",
        id: "namespaces",
        label: "Namespaces to instrument",
        placeholder: "shop, payments",
        help: "Comma-separated. Wildcards work, e.g. team-*.",
        visibleIf: (_c, o) => o.scope === "namespaces",
      },
      {
        kind: "toggle",
        id: "network",
        label: "Network metrics (traffic between pods, namespaces and zones)",
        help: "Shows who talks to whom and how many bytes cross availability zones, which helps find inter-zone costs. Adds about 20 series per pod.",
        visibleIf: (cfg, o) => cfg.signals.metrics && o.exports !== "traces",
      },
    ],
    defaults: (cfg) => ({ exports: cfg.signals.metrics && cfg.signals.traces ? "both" : cfg.signals.traces ? "traces" : "metrics", scope: "all", namespaces: "", network: false }),
  },
  {
    id: "tempo",
    name: "Grafana Tempo",
    group: "traces",
    runsOn: "central",
    signal: "traces",
    charts: [CHARTS.tempoMonolithic, CHARTS.tempoDistributed],
    what: "Distributed tracing backend that stores traces in object storage and needs no index database.",
    why: "Shows where time goes inside a request across services, and links traces with logs and metrics in Grafana. The metrics-generator turns traces into RED metrics (rate, errors, duration) in Mimir.",
    skip: "If your applications aren't instrumented for tracing yet.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "mode",
        label: "How do you want to deploy Tempo?",
        layout: "cards",
        options: (cfg) => [
          { value: "monolithic", label: "Monolithic", description: "One process (chart: tempo). Fine for low trace volumes and non-production." },
          {
            value: "distributed",
            label: "Distributed",
            badge: "Production",
            description: "Tempo 3 architecture: distributor → Kafka → live-store + block-builder, with backend scheduler/workers. Needs Kafka (asked in the Kafka step).",
            warning: cfg.components.kafka?.enabled !== true ? "Kafka is off, so Tempo runs monolithic. Turn Kafka on in the Kafka step to use this." : undefined,
          },
        ],
      },
      { kind: "toggle", id: "metricsGenerator", label: "Metrics generator (service graphs + RED metrics)", help: "Writes span-derived metrics to Mimir. Very useful for dashboards and SLOs; adds some series to Mimir.", visibleIf: (cfg) => cfg.signals.metrics },
      zoneAwareQuestion,
      ingressQuestion("Tempo"),
    ],
    defaults: (cfg) => ({ mode: cfg.components.kafka?.enabled === true ? "distributed" : "monolithic", metricsGenerator: cfg.signals.metrics, zoneAware: cfg.topology.zones > 1 }),
  },

  // ---------------------------------------------------------------- profiles
  {
    id: "alloy-profiles",
    name: "Alloy — profiling",
    group: "profiles",
    runsOn: "remote",
    signal: "profiles",
    charts: [CHARTS.alloy],
    what: "Collects continuous CPU/memory profiles, using eBPF for any process or pulling from instrumented apps.",
    why: "Profiles show which function burns CPU or memory in production, without reproducing the problem locally.",
    skip: "If you don't plan to investigate performance at code level.",
    recommended: () => true,
    questions: [],
    defaults: () => ({}),
  },
  {
    id: "pyroscope",
    name: "Grafana Pyroscope",
    group: "profiles",
    runsOn: "central",
    signal: "profiles",
    charts: [CHARTS.pyroscope],
    what: "Continuous profiling database, storing profiles in object storage.",
    why: "Lets you compare flame graphs over time and jump from a slow trace span to the code that caused it.",
    skip: "Together with the profiling agent, if profiling isn't needed.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "mode",
        label: "How do you want to deploy Pyroscope?",
        layout: "cards",
        options: [
          { value: "monolithic", label: "Monolithic", badge: "Recommended", description: "Single process; enough for most setups." },
          { value: "distributed", label: "Distributed", description: "Microservices for very large profile volumes." },
        ],
      },
      ingressQuestion("Pyroscope"),
    ],
    defaults: () => ({ mode: "monolithic" }),
  },

  // ---------------------------------------------------------------- AI / LLM observability
  {
    id: "langfuse",
    name: "Langfuse",
    group: "ai",
    runsOn: "central",
    signal: "ai",
    charts: [CHARTS.langfuse],
    what: "Open-source LLM engineering platform: traces every LLM call (prompt, response, tokens, latency, cost), manages prompts and runs evaluations.",
    why: "Classic metrics and traces don't show what an LLM was asked, what it answered, how many tokens it used or whether the answer was good. Langfuse does, for every model provider, and accepts OpenTelemetry (OTLP) traces.",
    skip: "If you don't run LLM-based applications or agents.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "hosting",
        label: "Where should Langfuse run?",
        layout: "cards",
        options: [
          { value: "central", label: "Central observability cluster", badge: "Recommended", description: "Next to Grafana and the LGTM stack; one place to operate and secure." },
          { value: "dedicated", label: "Its own cluster", description: "Isolates LLM data (prompts can contain personal or confidential data) and its load from the rest of the platform." },
          { value: "with-apps", label: "Next to the AI applications", description: "In the remote cluster that runs the LLM apps: shortest path, but one Langfuse per cluster." },
        ],
      },
      {
        kind: "choice",
        id: "postgres",
        label: "PostgreSQL (users, projects, prompts)",
        layout: "cards",
        options: (cfg) => [
          { value: "managed", label: CLOUDS[cfg.platform.cloud].managedDb, badge: "Production", description: "Backups and failover handled by the cloud." },
          { value: "bundled", label: "In the cluster (chart default)", description: "Simplest; you handle backups.", warning: "Fine for dev/test. Use the managed database for production." },
        ],
      },
      {
        kind: "choice",
        id: "postgresTier",
        label: "Managed PostgreSQL tier",
        layout: "cards",
        visibleIf: (_c, o) => o.postgres === "managed",
        options: [
          { value: "burstable", label: "Burstable (2 vCPU)", description: "Cheapest; Langfuse's PostgreSQL load is light (metadata only, traces live in ClickHouse)." },
          { value: "general", label: "General purpose (2–4 vCPU)", description: "Steady performance for many users and projects." },
        ],
      },
      {
        kind: "toggle",
        id: "postgresHa",
        label: "PostgreSQL high availability (standby in another zone)",
        help: "Automatic failover if the zone fails. Doubles the database cost.",
        visibleIf: (_c, o) => o.postgres === "managed",
      },
      {
        kind: "choice",
        id: "redis",
        label: "Redis / Valkey (queue and cache)",
        layout: "cards",
        options: (cfg) => [
          { value: "managed", label: CLOUDS[cfg.platform.cloud].managedRedis, description: "Managed, highly available." },
          { value: "bundled", label: "In the cluster (chart default)", description: "Cheaper; data is only a short-lived queue." },
        ],
      },
      {
        kind: "choice",
        id: "clickhouse",
        label: "ClickHouse (traces, observations, scores)",
        layout: "cards",
        options: [
          {
            value: "bundled",
            label: "Bundled with Langfuse (chart default)",
            description: "ClickHouse sub-chart inside the Langfuse release and namespace. Simplest: one install, one upgrade. But it's upgraded, rolled back and deleted together with Langfuse.",
          },
          {
            value: "operator",
            label: "Separate ClickHouse in its own namespace",
            badge: "Recommended",
            description: "Installed by the Altinity ClickHouse Operator (ClickHouseInstallation resource) in a dedicated namespace. Independent upgrades and backups, can run on its own node pool, and can be shared with other tools.",
          },
          {
            value: "external",
            label: "Existing / external ClickHouse",
            description: "A ClickHouse cluster you already run (in another cluster or on VMs) or ClickHouse Cloud. Langfuse only gets the connection settings.",
          },
        ],
      },
      {
        kind: "text",
        id: "clickhouseNamespace",
        label: "Namespace for ClickHouse",
        placeholder: "clickhouse",
        help: "Langfuse connects to it through the service DNS name, e.g. clickhouse-langfuse.clickhouse.svc.",
        visibleIf: (_c, o) => o.clickhouse === "operator",
      },
      {
        kind: "toggle",
        id: "clickhouseReplicated",
        label: "Replicate ClickHouse (3 replicas + ClickHouse Keeper)",
        help: "Survives the loss of a pod, node or zone. Needs 3 ClickHouse Keeper pods for coordination and sets CLICKHOUSE_CLUSTER_ENABLED in Langfuse. A single replica is fine for dev/test; back it up either way.",
        visibleIf: (_c, o) => o.clickhouse === "operator" || o.clickhouse === "bundled",
      },
      {
        kind: "choice",
        id: "objectStorage",
        label: "Object storage (raw events, media, exports)",
        layout: "cards",
        options: (cfg) => [
          { value: "cloud", label: CLOUDS[cfg.platform.cloud].objectStorage, badge: "Production", description: "Same storage type as the LGTM backends." },
          { value: "bundled", label: "Bundled SeaweedFS", description: "S3-compatible storage inside the cluster.", warning: "Fine for dev/test only." },
        ],
      },
      {
        kind: "choice",
        id: "auth",
        label: "Login",
        layout: "select",
        options: [
          { value: "sso", label: "Single sign-on (Entra ID, Google, Okta, Keycloak…)" },
          { value: "email", label: "E-mail and password" },
        ],
      },
      {
        kind: "toggle",
        id: "otelToTempo",
        label: "Also send LLM traces to Tempo",
        help: "Instrument once with OpenTelemetry (e.g. OpenLIT / OpenLLMetry) and send the same spans to Langfuse and Tempo, so LLM calls appear inside your normal request traces in Grafana.",
        visibleIf: (cfg) => cfg.signals.traces,
      },
      ingressQuestion("Langfuse"),
    ],
    defaults: (cfg) => ({ hosting: "central", postgres: "managed", postgresTier: "burstable", postgresHa: false, redis: "bundled", clickhouse: "operator", clickhouseNamespace: "clickhouse", clickhouseReplicated: cfg.topology.zones > 1, objectStorage: "cloud", auth: "sso", otelToTempo: cfg.signals.traces }),
  },

  // ---------------------------------------------------------------- visualisation / alerting / AI
  {
    id: "grafana",
    name: "Grafana",
    group: "visualisation",
    runsOn: "central",
    charts: [CHARTS.grafana],
    what: "Dashboards, Explore and correlations across metrics, logs, traces and profiles.",
    why: "The UI for everything above. Data sources for every backend (and every tenant) are generated for you.",
    skip: "If you already run Grafana elsewhere and only want to add data sources to it.",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "ha",
        label: "Availability",
        layout: "cards",
        options: (cfg) => [
          { value: "single", label: "Single replica", description: "SQLite on a small volume. Fine for dev or small teams." },
          { value: "ha", label: "High availability", badge: "Production", description: `2+ replicas sharing a database (${CLOUDS[cfg.platform.cloud].managedDb}).` },
        ],
      },
      { kind: "choice", id: "auth", label: "Login", layout: "select", options: [
        { value: "oidc", label: "Single sign-on (OIDC: Entra ID, Google, Okta, Keycloak…)" },
        { value: "basic", label: "Grafana users (username/password)" },
      ] },
      ingressQuestion("Grafana"),
    ],
    defaults: () => ({ ha: "ha", auth: "oidc" }),
  },
  {
    id: "alertmanager",
    name: "Alertmanager",
    group: "alerting",
    runsOn: "central",
    charts: [CHARTS.alertmanager],
    what: "Groups, deduplicates, silences and routes alerts to Slack, Teams, e-mail, PagerDuty, Opsgenie…",
    why: "Alert rules only produce firing alerts; Alertmanager decides who gets notified, how often, and suppresses noise during incidents.",
    skip: "If alerts are routed by another system (e.g. an existing on-call platform receiving from Grafana Alerting).",
    recommended: () => true,
    questions: [
      {
        kind: "choice",
        id: "type",
        label: "Which Alertmanager?",
        layout: "cards",
        options: (cfg) => [
          { value: "standalone", label: "Standalone Alertmanager", badge: "Default", description: "Separate deployment (prometheus-community chart). Simple and independent of Mimir." },
          {
            value: "mimir",
            label: "Mimir's built-in Alertmanager",
            description: "Multi-tenant, configured per tenant through the Mimir API.",
            warning: cfg.components.mimir?.enabled === false ? "Needs Mimir, which you skipped." : undefined,
          },
        ],
      },
      {
        kind: "choice",
        id: "placement",
        label: "Where should the Alertmanager run?",
        layout: "cards",
        visibleIf: (_c, o) => o.type === "standalone",
        options: (cfg) => {
          const agent = cfg.components.prometheus?.options.collector !== "prometheus" || cfg.components.prometheus?.options.mode !== "server";
          const warn = agent ? "Prometheus on the remote clusters is in agent mode, which doesn't evaluate alert rules: nothing would reach this Alertmanager. Switch the metrics collector to server mode." : undefined;
          return [
            { value: "central", label: "Central cluster", badge: "Default", description: "One Alertmanager for all clusters, fed by the Mimir/Loki rulers. One place for routing and silences." },
            { value: "remote", label: "Remote clusters (next to Prometheus)", description: "Each remote cluster alerts on its own, even when the central cluster is unreachable. Routing and silences are per cluster.", warning: warn },
            { value: "both", label: "Both", description: "Central Alertmanager for platform-wide rules, local ones for cluster-critical alerts that must work without the central cluster.", warning: warn },
          ];
        },
      },
      { kind: "number", id: "replicas", label: "Replicas", min: 1, max: 5, help: "Replicas share silences and the notification log by gossip; they don't need a majority, so 2 survive one failure.", visibleIf: (_c, o) => o.type === "standalone" },
    ],
    defaults: () => ({ type: "standalone", placement: "central", replicas: 2 }),
  },
  {
    id: "robusta",
    name: "Robusta OSS + HolmesGPT",
    group: "aiops",
    runsOn: "central",
    charts: [CHARTS.robusta],
    what: "Enriches alerts with context (pod logs, events, recent changes) and uses HolmesGPT, an open-source AI agent, to investigate the likely root cause.",
    why: "Cuts triage time: the on-call engineer receives an alert that already says what happened and where to look, instead of starting from a bare metric threshold.",
    skip: "If you don't want an LLM in the alert path, or company policy doesn't allow sending alert context to one.",
    recommended: () => false,
    questions: [
      {
        kind: "choice",
        id: "llm",
        label: "Which LLM should HolmesGPT use?",
        layout: "cards",
        options: (cfg) => {
          const def = cfg.platform.cloud;
          return [
            { value: "azure-openai", label: "Azure OpenAI", badge: def === "azure" ? "Your cloud" : undefined },
            { value: "bedrock", label: "Amazon Bedrock", badge: def === "aws" ? "Your cloud" : undefined },
            { value: "vertex", label: "Google Vertex AI", badge: def === "gcp" ? "Your cloud" : undefined },
            { value: "openai", label: "OpenAI API" },
            { value: "self-hosted", label: "Self-hosted model", description: "Any OpenAI-compatible endpoint (e.g. vLLM, Ollama)." },
          ];
        },
      },
      { kind: "number", id: "alertsPerDay", label: "Alerts investigated per day", min: 0, max: 10000, help: "Used to estimate the LLM token cost." },
      {
        kind: "number",
        id: "llmInputPrice",
        label: "LLM price per million input tokens",
        unit: "USD",
        min: 0,
        step: 0.1,
        help: "Check the current price of the model you use (it differs a lot between models). An investigation sends ~20k tokens of context and gets ~2k back.",
      },
      { kind: "number", id: "llmOutputPrice", label: "LLM price per million output tokens", unit: "USD", min: 0, step: 0.1 },
    ],
    defaults: (cfg) => ({ llm: cfg.platform.cloud === "azure" ? "azure-openai" : cfg.platform.cloud === "aws" ? "bedrock" : "vertex", alertsPerDay: 50, llmInputPrice: 3, llmOutputPrice: 15 }),
  },
];

/** Name that reflects the choices made (e.g. "Prometheus (server mode)" instead of "Metrics collector"). */
export function componentLabel(cfg: PlannerConfig, id: ComponentId): string {
  const o = cfg.components[id]?.options ?? {};
  switch (id) {
    case "prometheus":
      return o.collector === "alloy" ? "Grafana Alloy (metrics)" : `Prometheus (${o.mode === "server" ? "server" : "agent"} mode)`;
    case "trace-collector":
      return o.collector === "otel" ? "OpenTelemetry Collector (traces)" : "Grafana Alloy (traces)";
    case "alertmanager":
      return o.type === "mimir" ? "Alertmanager (in Mimir)" : `Alertmanager (${o.placement === "remote" ? "remote clusters" : o.placement === "both" ? "central + remote" : "central"})`;
    case "kafka":
      return `Kafka (${o.provider === "managed" ? "managed" : o.provider === "strimzi" ? "Strimzi" : "bundled broker"})`;
    default:
      return COMPONENT_BY_ID[id].name;
  }
}

/** Whether a component has pods on the remote clusters with the current choices. */
export function runsOnRemote(cfg: PlannerConfig, id: ComponentId): boolean {
  if (id === "alertmanager") return cfg.components.alertmanager?.options.type === "standalone" && ["remote", "both"].includes(String(cfg.components.alertmanager?.options.placement));
  return COMPONENT_BY_ID[id].runsOn !== "central";
}

/** Whether a component has pods on the central cluster with the current choices. */
export function runsOnCentral(cfg: PlannerConfig, id: ComponentId): boolean {
  if (id === "alertmanager") return cfg.components.alertmanager?.options.type !== "standalone" || cfg.components.alertmanager?.options.placement !== "remote";
  return COMPONENT_BY_ID[id].runsOn !== "remote";
}

export const COMPONENT_BY_ID = Object.fromEntries(COMPONENTS.map((c) => [c.id, c])) as Record<ComponentId, ComponentDef>;

/** Components the user is asked about, in wizard order, given the current answers. */
export function relevantComponents(cfg: PlannerConfig): ComponentDef[] {
  return COMPONENTS.filter((c) => (!c.signal || cfg.signals[c.signal]) && (!c.isRelevant || c.isRelevant(cfg)));
}
