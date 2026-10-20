// The complete set of answers. Everything the planner generates is derived from this object,
// and it is what gets encoded into the share link.

export type CloudId = "azure" | "aws" | "gcp";
export type Currency = "EUR" | "USD";
export type DeliveryId = "argocd" | "flux" | "azure-devops" | "github-actions" | "gitlab-ci" | "helm";
export type GitHostId = "github" | "gitlab" | "azure-repos" | "bitbucket";
export type SignalId = "metrics" | "logs" | "traces" | "profiles" | "ai";
export type CentralModel = "per-env" | "shared";
/** single · regional stacks · standby region with replicated storage · active-active (dual write) */
export type RegionModel = "single" | "regional" | "standby" | "active-active";
/** Azure: geo = GZRS paired region, object = object replication; AWS: crr; GCP: dual-region bucket */
export type ReplicationMethod = "geo" | "object" | "crr" | "dual-region";
export type ConnectivityPath = "public" | "private";
export type RemoteAuth = "basic" | "mtls" | "none";
export type SecretsBackend = "eso" | "csi";
/** cert-manager in the cluster · certificate managed at the cloud edge (App Gateway, ALB+ACM, Google LB) · existing certificate */
export type TlsMode = "cert-manager" | "edge-managed" | "existing";
export type TenantKey = "cluster" | "environment" | "namespace" | "team" | "application" | "custom";
export type IngressId =
  | "envoy-gateway"
  | "istio"
  | "haproxy"
  | "traefik"
  | "cloud-native"
  | "ingress-nginx";

export type ComponentId =
  | "mimir"
  | "prometheus"
  | "kube-state-metrics"
  | "node-exporter"
  | "loki"
  | "alloy-logs"
  | "alloy-events"
  | "cloud-logs"
  | "tempo"
  | "trace-collector"
  | "pyroscope"
  | "alloy-profiles"
  | "beyla"
  | "kafka"
  | "grafana"
  | "alertmanager"
  | "robusta"
  | "langfuse";

export type OptionValue = string | number | boolean;

export type AutoscalerChoice = "none" | "hpa" | "keda" | "vpa";

/** User decisions for one workload (e.g. mimir ingester) — same for all environments */
export interface WorkloadChoice {
  /** Only for optional workloads; undefined = default */
  enabled?: boolean;
  autoscaler?: AutoscalerChoice;
  /** HPA / KEDA bounds; default min = calculated replicas, max = 3 × min */
  minReplicas?: number;
  maxReplicas?: number;
  targetCpuPercent?: number;
  /** VPA update mode when the autoscaler is "vpa" */
  vpaMode?: "Off" | "Initial";
  /** Add a recommendation-only VPA next to HPA/KEDA */
  vpaAdvice?: boolean;
}

/** User edits of the calculated size of one workload in one environment */
export interface WorkloadOverride {
  replicas?: number;
  cpu?: number;
  memoryGi?: number;
  pvcGi?: number;
}

export interface ComponentChoice {
  /** undefined = not answered yet */
  enabled?: boolean;
  options: Record<string, OptionValue>;
  /** keyed by workload id */
  workloads?: Record<string, WorkloadChoice>;
}

export interface Volumes {
  metrics: {
    knowsActiveSeries: boolean;
    activeSeries: number;
    nodes: number;
    podsPerNode: number;
  };
  logsGbPerDay: number;
  cloudLogsGbPerDay: number;
  traces: {
    unit: "spans" | "gb";
    spansPerSecond: number;
    gbPerDay: number;
  };
  profiledServices: number;
  llmCallsPerDay: number;
  retentionDays: Record<SignalId, number>;
  grafanaUsers: number;
  dashboards: number;
  /** Optional override of the estimated queries per second (metrics) */
  queryQpsOverride?: number;
}

export interface PlannerConfig {
  schema: 1;
  platform: {
    cloud: CloudId;
    region: string;
    currency: Currency;
  };
  delivery: {
    method: DeliveryId;
    gitHost: GitHostId;
    repoUrl: string;
  };
  /** Additional regions; the primary region is platform.region */
  multiRegion: {
    model: RegionModel;
    /** regional: any number of extra regions; standby / active-active: the first entry is the second region */
    regions: string[];
    /** regional model: remote clusters per extra region and environment */
    remoteClusters: Record<string, Record<string, number>>;
    /** standby model: how object storage is copied */
    replication: ReplicationMethod;
    /** standby model: also mirror Kafka so data not yet in object storage survives a region loss */
    mirrorKafka: boolean;
    /** internal (set on per-cluster views): region whose buckets this cluster reads */
    storageRegion?: string;
  };
  environments: string[];
  topology: {
    centralModel: CentralModel;
    remoteClusters: Record<string, number>;
    /** Build the central observability cluster with Terraform (otherwise: use an existing one) */
    createCentralCluster: boolean;
    zones: 1 | 2 | 3;
  };
  signals: Record<SignalId, boolean>;
  connectivity: {
    path: ConnectivityPath;
    auth: RemoteAuth;
    ingress: IngressId;
    baseDomain: string;
    tls: TlsMode;
    externalDns: boolean;
    secrets: SecretsBackend;
  };
  tenancy: {
    enabled: boolean;
    key: TenantKey;
    customLabel: string;
    crossTenantQuery: boolean;
  };
  components: Record<ComponentId, ComponentChoice>;
  volumes: Record<string, Volumes>;
  /** env -> "component.workload" -> edited size */
  overrides: Record<string, Record<string, WorkloadOverride>>;
  /** env -> backend -> edited tenant limits (defaults for all tenants, and per tenant) */
  limits?: Record<string, Partial<Record<ComponentId, { defaults?: Record<string, OptionValue>; tenants?: Record<string, Record<string, OptionValue>> }>>>;
}
