// Latest stable chart + app versions from the official Helm repos.
// Checked: 2026-10-18. Bumped by Renovate / the version check in CI.
//
// Note: the Grafana, Loki and Tempo charts moved to the grafana-community repo;
// the copies in the grafana repo are deprecated or no longer updated.

export const HELM_REPOS = {
  grafana: "https://grafana.github.io/helm-charts",
  "grafana-community": "https://grafana-community.github.io/helm-charts",
  "prometheus-community": "https://prometheus-community.github.io/helm-charts",
  robusta: "https://robusta-charts.storage.googleapis.com",
  langfuse: "https://langfuse.github.io/langfuse-k8s",
  "open-telemetry": "https://open-telemetry.github.io/opentelemetry-helm-charts",
  jetstack: "https://charts.jetstack.io",
  "external-secrets": "https://charts.external-secrets.io",
  "external-dns": "https://kubernetes-sigs.github.io/external-dns",
  kedacore: "https://kedacore.github.io/charts",
  autoscaler: "https://kubernetes.github.io/autoscaler",
  strimzi: "https://strimzi.io/charts",
  altinity: "https://helm.altinity.com",
  haproxytech: "https://haproxytech.github.io/helm-charts",
  traefik: "https://traefik.github.io/charts",
  "ingress-nginx": "https://kubernetes.github.io/ingress-nginx",
  "envoy-gateway": "oci://docker.io/envoyproxy",
  istio: "https://istio-release.storage.googleapis.com/charts",
} as const;

export type HelmRepoId = keyof typeof HELM_REPOS;

export interface ChartRef {
  repo: HelmRepoId;
  chart: string;
  version: string;
  appVersion: string;
}

export const VERSIONS_CHECKED = "2026-10-18";

export const CHARTS = {
  mimir: { repo: "grafana", chart: "mimir-distributed", version: "6.2.1", appVersion: "3.2.1" },
  loki: { repo: "grafana-community", chart: "loki", version: "18.17.1", appVersion: "3.7.8" },
  tempoMonolithic: { repo: "grafana-community", chart: "tempo", version: "3.2.0", appVersion: "3.1.0" },
  tempoDistributed: { repo: "grafana-community", chart: "tempo-distributed", version: "3.14.0", appVersion: "3.1.0" },
  pyroscope: { repo: "grafana", chart: "pyroscope", version: "2.4.0", appVersion: "2.4.0" },
  grafana: { repo: "grafana-community", chart: "grafana", version: "14.0.1", appVersion: "13.2.4" },
  alloy: { repo: "grafana", chart: "alloy", version: "1.13.1", appVersion: "v1.20.1" },
  prometheus: { repo: "prometheus-community", chart: "prometheus", version: "29.37.0", appVersion: "v3.15.0" },
  alertmanager: { repo: "prometheus-community", chart: "alertmanager", version: "2.1.1", appVersion: "v0.34.1" },
  kubeStateMetrics: { repo: "prometheus-community", chart: "kube-state-metrics", version: "8.6.0", appVersion: "2.20.0" },
  nodeExporter: { repo: "prometheus-community", chart: "prometheus-node-exporter", version: "4.60.0", appVersion: "1.12.1" },
  robusta: { repo: "robusta", chart: "robusta", version: "0.53.0", appVersion: "0.53.0" },
  langfuse: { repo: "langfuse", chart: "langfuse", version: "2.1.5", appVersion: "4.56.0" },
  otelCollector: { repo: "open-telemetry", chart: "opentelemetry-collector", version: "0.176.0", appVersion: "0.162.0" },
} satisfies Record<string, ChartRef>;

/** Cluster add-ons the design may need (installed before the observability components). */
export const ADDON_CHARTS = {
  certManager: { repo: "jetstack", chart: "cert-manager", version: "v1.21.2", appVersion: "v1.21.2" },
  externalSecrets: { repo: "external-secrets", chart: "external-secrets", version: "2.13.0", appVersion: "v2.13.0" },
  externalDns: { repo: "external-dns", chart: "external-dns", version: "1.23.0", appVersion: "0.23.0" },
  keda: { repo: "kedacore", chart: "keda", version: "2.21.0", appVersion: "2.21.0" },
  vpa: { repo: "autoscaler", chart: "vertical-pod-autoscaler", version: "0.14.0", appVersion: "1.8.0" },
  strimzi: { repo: "strimzi", chart: "strimzi-kafka-operator", version: "1.3.0", appVersion: "1.3.0" },
  clickhouseOperator: { repo: "altinity", chart: "altinity-clickhouse-operator", version: "0.27.4", appVersion: "0.27.4" },
  haproxy: { repo: "haproxytech", chart: "kubernetes-ingress", version: "1.54.3", appVersion: "3.2.17" },
  traefik: { repo: "traefik", chart: "traefik", version: "42.0.0", appVersion: "v3.7.14" },
  envoyGateway: { repo: "envoy-gateway", chart: "gateway-helm", version: "v1.9.2", appVersion: "v1.9.2" },
  istio: { repo: "istio", chart: "istiod", version: "1.31.2", appVersion: "1.31.2" },
} satisfies Record<string, ChartRef>;
