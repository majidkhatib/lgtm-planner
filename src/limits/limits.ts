import { centralFor, tenantsFor } from "../generate/common";
import type { ComponentId, OptionValue, PlannerConfig } from "../model/types";
import { sizeComponent } from "../sizing/engine";
import { deriveInputs, type DerivedInputs } from "../sizing/inputs";

// Per-tenant limits for Mimir, Loki, Tempo and Pyroscope, calculated from the volumes entered in the planner.
// They go into each backend's runtime configuration, so they can be changed later without restarts.

export interface LimitCtx {
  d: DerivedInputs;
  /** share of the environment's volume one average tenant sends */
  share: number;
  tenants: number;
  ingesters: number;
  zones: number;
}

export interface LimitDef {
  /** config key; dots = nesting (Tempo: ingestion.rate_limit_bytes) */
  key: string;
  label: string;
  help: string;
  unit?: string;
  kind: "number" | "text" | "toggle";
  calc: (c: LimitCtx) => OptionValue;
  formula: (c: LimitCtx) => string;
  /** shown in the per-tenant override table */
  perTenant?: boolean;
}

const HEADROOM = 2; // the busiest tenant may send twice the average
const up = (n: number, step: number) => Math.ceil(n / step) * step;
const max = Math.max;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

export const LIMITS: Partial<Record<ComponentId, LimitDef[]>> = {
  mimir: [
    {
      key: "ingestion_rate",
      label: "Ingestion rate",
      unit: "samples/s",
      kind: "number",
      perTenant: true,
      help: "Samples per second a tenant may send. Above it, writes are rejected with HTTP 429 and the collector retries.",
      calc: (c) => max(10_000, up((c.d.samplesPerSecond * c.share * HEADROOM), 1000)),
      formula: (c) => `${fmt(c.d.samplesPerSecond)} samples/s × ${fmt(c.share * 100)} % per tenant × ${HEADROOM} (min 10,000)`,
    },
    {
      key: "ingestion_burst_size",
      label: "Ingestion burst",
      unit: "samples",
      kind: "number",
      help: "Short spikes allowed above the rate, e.g. when a collector catches up after a network blip.",
      calc: (c) => max(200_000, up((c.d.samplesPerSecond * c.share * HEADROOM) * 10, 10_000)),
      formula: () => "10 × the ingestion rate (min 200,000)",
    },
    {
      key: "max_global_series_per_user",
      label: "Max active series per tenant",
      kind: "number",
      perTenant: true,
      help: "Protects the ingesters from a cardinality explosion in one tenant (e.g. a label with user IDs). 0 would mean unlimited: never use that in production.",
      calc: (c) => max(150_000, up(c.d.activeSeries * c.share * HEADROOM, 10_000)),
      formula: (c) => `${fmt(c.d.activeSeries)} series × ${fmt(c.share * 100)} % per tenant × ${HEADROOM} (min 150,000)`,
    },
    {
      key: "max_label_names_per_series",
      label: "Max labels per series",
      kind: "number",
      help: "Mimir default is 30. Raise it only for exporters with very wide metrics.",
      calc: () => 30,
      formula: () => "Mimir default",
    },
    {
      key: "max_label_value_length",
      label: "Max label value length",
      unit: "characters",
      kind: "number",
      help: "Long label values (URLs, SQL) usually mean a cardinality problem. Mimir default is 2048.",
      calc: () => 2048,
      formula: () => "Mimir default",
    },
    {
      key: "max_fetched_series_per_query",
      label: "Max series per query",
      kind: "number",
      help: "Stops a single heavy dashboard query from loading millions of series into a querier's memory.",
      calc: (c) => max(100_000, up(c.d.activeSeries * c.share * 0.5, 10_000)),
      formula: () => "half a tenant's series (min 100,000)",
    },
    {
      key: "compactor_blocks_retention_period",
      label: "Retention",
      kind: "text",
      perTenant: true,
      help: "How long the tenant's metrics are kept. Can be different per tenant (e.g. 13 months for prod, 30 days for test tenants).",
      calc: (c) => `${c.d.retention.metrics}d`,
      formula: () => "metrics retention set in this step",
    },
    {
      key: "ingestion_tenant_shard_size",
      label: "Shuffle sharding: ingesters per tenant",
      kind: "number",
      help: "Each tenant writes to its own subset of ingesters, so a misbehaving tenant can only affect that subset. 0 = all ingesters.",
      calc: (c) => (c.tenants > 1 && c.ingesters > 6 ? max(3, up(Math.min(c.ingesters, c.ingesters * c.share * HEADROOM * 2), max(3, c.zones))) : 0),
      formula: (c) => (c.tenants > 1 && c.ingesters > 6 ? "≈ 2 × the tenant's share of ingesters, multiple of the zones (min 3)" : "0: not useful with few tenants or ingesters"),
    },
    {
      key: "out_of_order_time_window",
      label: "Out-of-order window",
      kind: "text",
      help: "Accept samples that arrive late (e.g. from buffered or batched sources). 0s = reject them, which is right for Prometheus scrapes.",
      calc: () => "0s",
      formula: () => "off; set e.g. 10m for late-arriving data",
    },
    {
      key: "ruler_max_rule_groups_per_tenant",
      label: "Max rule groups per tenant",
      kind: "number",
      help: "Limits how many recording/alerting rule groups one tenant can load into the ruler.",
      calc: () => 70,
      formula: () => "Mimir default",
    },
    {
      key: "cardinality_analysis_enabled",
      label: "Cardinality analysis API",
      kind: "toggle",
      help: "Lets Grafana's cardinality dashboards show which metrics and labels drive the series count.",
      calc: () => true,
      formula: () => "recommended",
    },
  ],
  loki: [
    {
      key: "ingestion_rate_mb",
      label: "Ingestion rate",
      unit: "MB/s",
      kind: "number",
      perTenant: true,
      help: "Log volume per second a tenant may send. Above it, pushes are rejected (HTTP 429) and Alloy retries.",
      calc: (c) => max(4, Math.ceil(((c.d.logsGbPerDay * 1024) / 86_400) * c.share * 3 * HEADROOM)),
      formula: (c) => `${fmt(c.d.logsGbPerDay)} GB/day ÷ 86,400 × ${fmt(c.share * 100)} % × 3 (daily peak) × ${HEADROOM} (min 4)`,
    },
    {
      key: "ingestion_burst_size_mb",
      label: "Ingestion burst",
      unit: "MB",
      kind: "number",
      help: "Short spikes above the rate, e.g. log storms during an incident.",
      calc: (c) => max(6, Math.ceil(((c.d.logsGbPerDay * 1024) / 86_400) * c.share * 3 * HEADROOM) * 4),
      formula: () => "4 × the ingestion rate (min 6)",
    },
    {
      key: "per_stream_rate_limit",
      label: "Rate per stream",
      kind: "text",
      help: "Limit per log stream (one set of labels). Protects ingesters from one extremely chatty pod.",
      calc: (c) => `${Math.min(15, max(3, Math.ceil(((c.d.logsGbPerDay * 1024) / 86_400) * c.share)))}MB`,
      formula: () => "tenant's average MB/s, between 3 MB (Loki default) and 15 MB",
    },
    {
      key: "per_stream_rate_limit_burst",
      label: "Burst per stream",
      kind: "text",
      help: "Short spikes per stream.",
      calc: (c) => `${Math.min(30, max(15, Math.ceil(((c.d.logsGbPerDay * 1024) / 86_400) * c.share) * 2))}MB`,
      formula: () => "2 × the rate per stream, between 15 and 30 MB",
    },
    {
      key: "max_global_streams_per_user",
      label: "Max streams per tenant",
      kind: "number",
      perTenant: true,
      help: "Number of distinct label sets. Each container is about one stream; extra labels multiply it.",
      calc: (c) => max(5_000, up(c.d.remoteClusters * c.d.nodesPerCluster * 30 * 2 * c.share * HEADROOM, 1000)),
      formula: () => "≈ 2 streams per pod on the tenant's nodes × 2 (min 5,000, Loki default)",
    },
    {
      key: "retention_period",
      label: "Retention",
      kind: "text",
      perTenant: true,
      help: "How long the tenant's logs are kept. Per-stream retention (e.g. debug namespaces shorter) can be added in the runtime config.",
      calc: (c) => `${c.d.retention.logs * 24}h`,
      formula: () => "logs retention set in this step",
    },
    {
      key: "max_query_parallelism",
      label: "Query parallelism",
      kind: "number",
      help: "How many sub-queries of one query run at the same time. Lower it if one user's search can saturate all queriers.",
      calc: () => 16,
      formula: () => "half of Loki's default (32): fairer for many tenants",
    },
    {
      key: "max_entries_limit_per_query",
      label: "Max log lines per query",
      kind: "number",
      help: "Upper bound for lines returned to Grafana.",
      calc: () => 5000,
      formula: () => "Loki default",
    },
    {
      key: "query_timeout",
      label: "Query timeout",
      kind: "text",
      help: "Long-running searches are stopped after this.",
      calc: () => "5m",
      formula: () => "5 minutes (Loki default 1m is short for large tenants)",
    },
    {
      key: "max_label_names_per_series",
      label: "Max labels per stream",
      kind: "number",
      help: "Loki default is 15. High-cardinality fields belong in structured metadata, not labels.",
      calc: () => 15,
      formula: () => "Loki default",
    },
    {
      key: "volume_enabled",
      label: "Volume API (Logs Drilldown)",
      kind: "toggle",
      help: "Needed by Grafana's Logs Drilldown app to show volumes per service.",
      calc: () => true,
      formula: () => "recommended",
    },
  ],
  tempo: [
    {
      key: "ingestion.rate_limit_bytes",
      label: "Ingestion rate",
      unit: "bytes/s",
      kind: "number",
      perTenant: true,
      help: "Trace data per second a tenant may send. Tempo default is 15 MB/s.",
      calc: (c) => max(15_000_000, up(c.d.traceMbPerSecond * 1_048_576 * c.share * 3 * HEADROOM, 1_000_000)),
      formula: (c) => `${fmt(c.d.traceMbPerSecond)} MB/s × ${fmt(c.share * 100)} % × 3 (peak) × ${HEADROOM} (min 15 MB/s)`,
    },
    {
      key: "ingestion.burst_size_bytes",
      label: "Ingestion burst",
      unit: "bytes",
      kind: "number",
      help: "Short spikes above the rate. Tempo default is 20 MB.",
      calc: (c) => max(20_000_000, up(c.d.traceMbPerSecond * 1_048_576 * c.share * 3 * HEADROOM * 2, 1_000_000)),
      formula: () => "2 × the ingestion rate (min 20 MB)",
    },
    {
      key: "ingestion.max_traces_per_user",
      label: "Max live traces per tenant",
      kind: "number",
      help: "Traces held in memory at the same time. Tempo default is 10,000.",
      calc: (c) => max(10_000, up(((c.d.traceMbPerSecond * 1024) / 1) * c.share * 10 * HEADROOM, 1000)),
      formula: () => "≈ traces received in 10 s × 2 (min 10,000)",
    },
    {
      key: "global.max_bytes_per_trace",
      label: "Max trace size",
      unit: "bytes",
      kind: "number",
      help: "Very large traces are usually loops or batch jobs and make searches slow. Tempo default is 5 MB.",
      calc: () => 5_000_000,
      formula: () => "Tempo default",
    },
    {
      key: "compaction.block_retention",
      label: "Retention",
      kind: "text",
      perTenant: true,
      help: "How long the tenant's traces are kept.",
      calc: (c) => `${c.d.retention.traces * 24}h`,
      formula: () => "traces retention set in this step",
    },
  ],
  pyroscope: [
    {
      key: "ingestion_rate_mb",
      label: "Ingestion rate",
      unit: "MB/s",
      kind: "number",
      perTenant: true,
      help: "Profile data per second a tenant may send. Pyroscope default is 4 MB/s.",
      calc: (c) => max(4, Math.ceil(c.d.profileMbPerSecond * c.share * 3 * HEADROOM)),
      formula: (c) => `${fmt(c.d.profileMbPerSecond)} MB/s × ${fmt(c.share * 100)} % × 3 × ${HEADROOM} (min 4)`,
    },
    {
      key: "ingestion_burst_size_mb",
      label: "Ingestion burst",
      unit: "MB",
      kind: "number",
      help: "Short spikes above the rate.",
      calc: (c) => max(2, Math.ceil(c.d.profileMbPerSecond * c.share * 3 * HEADROOM) * 2),
      formula: () => "2 × the ingestion rate",
    },
    {
      key: "compactor_blocks_retention_period",
      label: "Retention",
      kind: "text",
      perTenant: true,
      help: "How long the tenant's profiles are kept.",
      calc: (c) => `${c.d.retention.profiles}d`,
      formula: () => "profiles retention set in this step",
    },
  ],
};

export function limitCtx(cfg: PlannerConfig, id: ComponentId, env: string): LimitCtx {
  const tenants = cfg.tenancy.enabled ? tenantsFor(cfg, centralFor(cfg, env)) : ["anonymous"];
  const d = deriveInputs(cfg, env);
  const ingesters = sizeComponent(cfg, id, env, false).find((w) => w.def.id === "ingester")?.final.replicas ?? 0;
  return { d, share: 1 / Math.max(1, tenants.length), tenants: tenants.length, ingesters, zones: cfg.components[id]?.options.zoneAware ? cfg.topology.zones : 1 };
}

export interface LimitRow {
  def: LimitDef;
  calculated: OptionValue;
  value: OptionValue;
  edited: boolean;
  formula: string;
}

/** Default limits of a backend in one environment: calculated, with the user's edits applied. */
export function limitRows(cfg: PlannerConfig, id: ComponentId, env: string): LimitRow[] {
  const defs = LIMITS[id] ?? [];
  const c = limitCtx(cfg, id, env);
  const edits = cfg.limits?.[env]?.[id]?.defaults ?? {};
  return defs.map((def) => {
    const calculated = def.calc(c);
    const edited = edits[def.key] !== undefined;
    return { def, calculated, value: edited ? edits[def.key] : calculated, edited, formula: def.formula(c) };
  });
}

export function tenantList(cfg: PlannerConfig, env: string): string[] {
  return cfg.tenancy.enabled ? tenantsFor(cfg, centralFor(cfg, env)) : [];
}

/** Per-tenant overrides (only the values the user set). */
export function tenantOverrides(cfg: PlannerConfig, id: ComponentId, env: string): Record<string, Record<string, OptionValue>> {
  return cfg.limits?.[env]?.[id]?.tenants ?? {};
}

/** Turns "a.b" keys into nested objects (Tempo's overrides format). */
export function nestKeys(flat: Record<string, OptionValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let o = out;
    parts.slice(0, -1).forEach((p) => (o = (o[p] ??= {}) as Record<string, unknown>));
    o[parts[parts.length - 1]] = v;
  }
  return out;
}
