import type { PlannerConfig } from "../model/types";

// Derived numbers every sizing function needs. All assumptions are written next to the formula
// and shown in the UI, so users can see where a number comes from.

export const ASSUMPTIONS = {
  seriesPerNode: 1_000, // node-exporter + kubelet + cAdvisor (node-level)
  seriesPerPod: 400, // cAdvisor per container + kube-state-metrics + typical app metrics
  replicationFactor: 3,
  activeUserShare: 0.2, // share of Grafana users looking at dashboards at the same time
  panelsPerDashboard: 20,
  dashboardRefreshSeconds: 60,
  avgSpanKb: 1,
  profileKbPerPodPerSecond: 4, // ~3 profile types × ~20 KB every 15 s
  observationsPerLlmCall: 5,
  beylaSeriesPerPod: 60, // RED histograms per service and route
  beylaNetworkSeriesPerPod: 20,
};

export interface DerivedInputs {
  activeSeries: number;
  activeSeriesEstimated: boolean;
  /** Series added by Tempo's metrics-generator (span-derived metrics written to Mimir) */
  metricsGeneratorSeries: number;
  /** Series added by Beyla (eBPF auto-instrumentation) */
  beylaSeries: number;
  scrapeIntervalSeconds: number;
  samplesPerSecond: number;
  metricsQps: number;
  metricsQpsEstimated: boolean;
  /** parts of the estimate */
  dashboardQps: number;
  ruleQps: number;
  logsGbPerDay: number;
  cloudLogsGbPerDay: number;
  traceMbPerSecond: number;
  traceSamplingPercent: number;
  profileMbPerSecond: number;
  llmCallsPerDay: number;
  grafanaUsers: number;
  remoteClusters: number;
  nodesPerCluster: number;
  retention: PlannerConfig["volumes"][string]["retentionDays"];
}

export function deriveInputs(cfg: PlannerConfig, env: string): DerivedInputs {
  const v = cfg.volumes[env];
  const scrape = Number(cfg.components.prometheus.options.scrapeInterval) || 30;

  const estimatedSeries = v.metrics.nodes * ASSUMPTIONS.seriesPerNode + v.metrics.nodes * v.metrics.podsPerNode * ASSUMPTIONS.seriesPerPod;
  const baseSeries = v.metrics.knowsActiveSeries ? v.metrics.activeSeries : estimatedSeries;
  // Span-derived metrics from Tempo's metrics-generator also land in Mimir (assumed +5 %).
  const generatorOn = cfg.signals.traces && cfg.components.tempo.enabled && cfg.components.tempo.options.metricsGenerator;
  const metricsGeneratorSeries = generatorOn ? Math.round(baseSeries * 0.05) : 0;
  const b = cfg.components.beyla;
  const beylaMetrics = cfg.signals.metrics && b?.enabled === true && b.options.exports !== "traces";
  const perPod = ASSUMPTIONS.beylaSeriesPerPod + (b?.options.network ? ASSUMPTIONS.beylaNetworkSeriesPerPod : 0);
  const beylaSeries = beylaMetrics ? Math.round(v.metrics.nodes * v.metrics.podsPerNode * perPod) : 0;
  const activeSeries = Math.round(baseSeries + metricsGeneratorSeries + beylaSeries);

  const dashboardQps = (v.grafanaUsers * ASSUMPTIONS.activeUserShare * ASSUMPTIONS.panelsPerDashboard) / ASSUMPTIONS.dashboardRefreshSeconds;
  const ruleQps = 1 + activeSeries / 250_000;
  const estimatedQps = round1(dashboardQps + ruleQps);

  const sampling = cfg.signals.traces ? samplingPercent(cfg) : 100;
  const rawTraceMb =
    v.traces.unit === "spans" ? (v.traces.spansPerSecond * ASSUMPTIONS.avgSpanKb) / 1024 : (v.traces.gbPerDay * 1024) / 86_400;

  const clusters = Math.max(1, cfg.topology.remoteClusters[env] ?? 1);

  return {
    activeSeries,
    activeSeriesEstimated: !v.metrics.knowsActiveSeries,
    metricsGeneratorSeries,
    beylaSeries,
    scrapeIntervalSeconds: scrape,
    samplesPerSecond: Math.round(activeSeries / scrape),
    metricsQps: v.queryQpsOverride ?? estimatedQps,
    metricsQpsEstimated: v.queryQpsOverride === undefined,
    dashboardQps: round1(dashboardQps),
    ruleQps: round1(ruleQps),
    logsGbPerDay: v.logsGbPerDay + (cfg.components["cloud-logs"].enabled ? v.cloudLogsGbPerDay : 0),
    cloudLogsGbPerDay: cfg.components["cloud-logs"].enabled ? v.cloudLogsGbPerDay : 0,
    traceMbPerSecond: round2((rawTraceMb * sampling) / 100),
    traceSamplingPercent: sampling,
    profileMbPerSecond: round2((v.profiledServices * ASSUMPTIONS.profileKbPerPodPerSecond) / 1024),
    llmCallsPerDay: v.llmCallsPerDay,
    grafanaUsers: v.grafanaUsers,
    remoteClusters: clusters,
    nodesPerCluster: Math.max(1, Math.ceil(v.metrics.nodes / clusters)),
    retention: v.retentionDays,
  };
}

/** Effective share of traces kept by the collector's sampling strategy. */
export function samplingPercent(cfg: PlannerConfig): number {
  const o = cfg.components["trace-collector"].options;
  if (o.sampling === "none") return 100;
  const pct = Number(o.samplingPercent) || 100;
  // Tail sampling always keeps errors and slow traces on top of the percentage (assumed ~5 % of traffic).
  return o.sampling === "tail" ? Math.min(100, pct + 5) : pct;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;
