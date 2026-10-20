import { workloadsFor, type Autoscaler, type WorkloadDef } from "../catalog/workloads";
import type { ComponentId, PlannerConfig, WorkloadOverride } from "../model/types";
import { ASSUMPTIONS, deriveInputs, round1, type DerivedInputs } from "./inputs";

export interface WorkloadSize {
  replicas: number;
  /** CPU request per pod, cores */
  cpu: number;
  /** Memory request per pod, GiB */
  memoryGi: number;
  /** PVC size per pod, GiB */
  pvcGi?: number;
}

export interface Calc extends WorkloadSize {
  /** How the numbers were derived */
  notes: string[];
  /** "official" = Grafana's published sizing; "heuristic" = no official number, a starting value */
  source: "official" | "heuristic";
  /** Replicas follow the load: changing CPU/memory per pod changes the replica count (and the other way round) */
  scalable?: boolean;
  /** Smallest allowed replica count (e.g. replication factor) */
  min?: number;
  /** Replicas must be a multiple of this (zone-aware replication) */
  zones?: number;
}

export interface SizedWorkload {
  def: WorkloadDef;
  enabled: boolean;
  autoscaler: Autoscaler;
  calc: Calc;
  final: WorkloadSize;
  overridden: (keyof WorkloadSize)[];
  /** Values recalculated because the user changed another one (same total capacity) */
  adjusted: (keyof WorkloadSize)[];
  /** Remote-cluster workloads: replicas are per cluster */
  perCluster: boolean;
}

const HEADROOM = 1.5; // Mimir docs: run with 50 % extra memory and disk capacity

/** Round up, but ignore tiny remainders (35.0003 pods → 35, not 36). */
const ceil = (n: number) => Math.ceil(n - 0.01);
const max = Math.max;
// Sizes are rounded to values people actually configure:
//  CPU: 0.1 · 0.2 · 0.25 · 0.5 · 0.75 · 1, then half cores (1.5, 2, 2.5 …)
//  memory and disks: powers of two (0.25 · 0.5 · 1 · 2 · 4 · 8 … GiB; disks 1 · 2 · 4 … 128 · 256 GiB)
const EPS = 1e-9;
const CPU_STEPS = [0.1, 0.2, 0.25, 0.5, 0.75, 1];
const roundCpu = (n: number) => (n <= 1 ? CPU_STEPS.find((v) => v >= n - EPS)! : Math.ceil(n * 2 - EPS) / 2);
const pow2 = (n: number, from: number) => {
  let v = from;
  while (v < n - EPS) v *= 2;
  return v;
};
const roundMem = (n: number) => pow2(n, 0.25);
const roundDisk = (n: number) => pow2(n, 1);
const multipleOf = (n: number, m: number) => (m > 1 ? ceil(n / m) * m : n);
const fmt = (n: number) => (n >= 1_000_000 ? `${round1(n / 1_000_000)} M` : n >= 1000 ? `${round1(n / 1000)} k` : `${round1(n)}`);

/** Spread a total CPU/memory need over replicas, respecting a min replica count and a max pod size. */
function spread(
  total: { cpu: number; mem: number; disk?: number },
  o: { min: number; maxCpu?: number; maxMem?: number; minCpu?: number; minMem?: number; zones?: number },
): WorkloadSize {
  let replicas = max(o.min, o.maxCpu ? ceil(total.cpu / o.maxCpu) : 1, o.maxMem ? ceil(total.mem / o.maxMem) : 1);
  replicas = multipleOf(replicas, o.zones ?? 1);
  return {
    replicas,
    cpu: roundCpu(max(o.minCpu ?? 0.1, total.cpu / replicas)),
    memoryGi: roundMem(max(o.minMem ?? 0.25, total.mem / replicas)),
    pvcGi: total.disk !== undefined ? roundDisk(total.disk / replicas) : undefined,
    scalable: true,
    min: o.min,
    zones: o.zones,
  } as WorkloadSize;
}

type Sizer = (cfg: PlannerConfig, d: DerivedInputs, wl: string) => Calc;

const fixed = (replicas: number, cpu: number, memoryGi: number, pvcGi: number | undefined, note: string): Calc => ({
  replicas,
  cpu: roundCpu(cpu),
  memoryGi: roundMem(memoryGi),
  pvcGi: pvcGi === undefined ? undefined : roundDisk(pvcGi),
  notes: [note],
  source: "heuristic",
});

// ------------------------------------------------------------------ Mimir (official capacity planning guide)
const sizeMimir: Sizer = (cfg, d, wl) => {
  const zones = cfg.components.mimir.options.zoneAware ? cfg.topology.zones : 1;
  const sps = d.samplesPerSecond;
  const qps = d.metricsQps;
  const inMem = d.activeSeries * ASSUMPTIONS.replicationFactor;
  const series = `${fmt(d.activeSeries)} active series`;

  switch (wl) {
    case "distributor": {
      const t = { cpu: sps / 25_000, mem: sps / 25_000 };
      return { ...spread(t, { min: 2, maxCpu: 4, minCpu: 0.5, minMem: 0.5 }), source: "official", notes: [`${fmt(sps)} samples/s (${series} ÷ ${d.scrapeIntervalSeconds} s)`, "1 CPU + 1 GB per 25,000 samples/s"] };
    }
    case "ingester": {
      const t = { cpu: inMem / 300_000, mem: (inMem / 300_000) * 2.5 * HEADROOM, disk: (inMem / 300_000) * 5 * HEADROOM };
      return {
        ...spread(t, { min: ASSUMPTIONS.replicationFactor, maxMem: 32, minCpu: 0.5, minMem: 2, zones }),
        source: "official",
        notes: [`${fmt(inMem)} in-memory series (${series} × RF ${ASSUMPTIONS.replicationFactor})`, "1 CPU + 2.5 GB memory + 5 GB disk per 300,000 series, +50 % headroom", "max 32 GiB per pod", "rounded up to power-of-two sizes"],
      };
    }
    case "querier": {
      const t = { cpu: qps / 10, mem: qps / 10 };
      return { ...spread(t, { min: 2, maxCpu: 4, minCpu: 0.5, minMem: 1 }), source: "official", notes: [`${qps} queries/s`, "1 CPU + 1 GB per 10 queries/s"] };
    }
    case "query-frontend":
      return { ...spread({ cpu: qps / 250, mem: qps / 250 }, { min: 2, minCpu: 0.25, minMem: 0.5 }), source: "official", notes: [`${qps} queries/s`, "1 CPU + 1 GB per 250 queries/s"] };
    case "query-scheduler":
      return { ...spread({ cpu: qps / 500, mem: (qps / 500) * 0.1 }, { min: 2, minCpu: 0.1, minMem: 0.25 }), source: "official", notes: ["1 CPU + 100 MB per 500 queries/s"] };
    case "store-gateway": {
      const disk = (d.activeSeries / 1_000_000) * 13 * (d.retention.metrics / 365) * (15 / d.scrapeIntervalSeconds) * HEADROOM;
      return {
        ...spread({ cpu: qps / 10, mem: qps / 10, disk: max(disk, 10) }, { min: zones > 1 ? zones : 2, maxCpu: 4, minCpu: 0.5, minMem: 1, zones }),
        source: "official",
        notes: ["1 CPU + 1 GB per 10 queries/s", `13 GB disk per 1 M series for 1 year at 15 s scrape → scaled to ${d.retention.metrics} days at ${d.scrapeIntervalSeconds} s, +50 %`],
      };
    }
    case "compactor": {
      const n = max(1, ceil(d.activeSeries / 20_000_000));
      return { replicas: n, cpu: 1, memoryGi: 4, pvcGi: roundDisk(max(20, (300 * d.activeSeries) / 20_000_000 / n)), source: "official", notes: ["1 instance per 20 M series: 1 CPU, 4 GB", "300 GB disk per 20 M series (scaled down, min 20 GB)"] };
    }
    case "ruler":
      return { ...spread({ cpu: (1 + d.activeSeries / 250_000) / 10, mem: (1 + d.activeSeries / 250_000) / 10 }, { min: 2, minCpu: 0.25, minMem: 0.5 }), source: "official", notes: ["Internal mode: sized like a querier for the rule evaluation rate"] };
    case "alertmanager":
      return { replicas: max(2, zones), cpu: 0.25, memoryGi: 1, pvcGi: 2, source: "official", notes: ["1 CPU per 100 notifications/s, 1 GB per 5,000 firing alerts → minimum size"] };
    case "overrides-exporter":
      return fixed(1, 0.1, 0.25, undefined, "Lightweight; one replica is enough.");
    case "gateway":
      return fixed(2, roundCpu(max(0.25, sps / 200_000)), 0.5, undefined, "Proxy only; scales with write traffic (starting value).");
    case "results-cache":
      return fixed(2, 0.25, roundMem(max(1, qps / 10)), undefined, "No official formula. Start here; scale out while the eviction rate is above 0.");
    case "index-cache":
      return fixed(2, 0.5, roundMem(max(1, (d.activeSeries / 1_000_000) * 2)), undefined, "No official formula: ~2 GB per 1 M series. Scale out while evictions are above 0.");
    case "chunks-cache":
      return fixed(2, 0.5, roundMem(max(2, (d.activeSeries / 1_000_000) * 4)), undefined, "No official formula: ~4 GB per 1 M series. Scale out while evictions are above 0.");
    case "metadata-cache":
      return fixed(1, 0.1, 0.5, undefined, "Small; bucket listings and block metadata only.");
    case "mimir": {
      // Monolithic: sum of the component requirements (official guidance).
      const parts = ["distributor", "ingester", "querier", "query-frontend", "store-gateway", "compactor"].map((w) => sizeMimir(cfg, d, w));
      const cpu = parts.reduce((a, p) => a + p.cpu * p.replicas, 0);
      const mem = parts.reduce((a, p) => a + p.memoryGi * p.replicas, 0);
      const disk = parts.reduce((a, p) => a + (p.pvcGi ?? 0) * p.replicas, 0);
      return { ...spread({ cpu, mem, disk }, { min: 3, minCpu: 1, minMem: 2, zones }), source: "official", notes: ["Monolithic = sum of all component requirements", "3 replicas for replication factor 3"] };
    }
  }
  return fixed(1, 0.25, 0.5, undefined, "Starting value.");
};

// ------------------------------------------------------------------ Loki (official sizing tiers, scaled to the volume)
const LOKI_TIERS = [
  { upTo: 3_000, base: { ingester: [2, 4, 6], distributor: [2, 0.5, 4], "index-gateway": [0.5, 2, 4], querier: [1, 1, 10], "query-frontend": [1, 2, 2], "query-scheduler": [1, 0.5, 2], compactor: [2, 10, 1] } },
  { upTo: 30_000, base: { ingester: [2, 6, 90], distributor: [2, 1, 40], "index-gateway": [0.5, 4, 10], querier: [1.5, 2, 100], "query-frontend": [1, 2, 8], "query-scheduler": [1, 0.5, 2], compactor: [6, 20, 1] } },
  { upTo: Infinity, base: { ingester: [4, 8, 150], distributor: [2, 1, 100], "index-gateway": [1, 4, 20], querier: [1.5, 3, 250], "query-frontend": [1, 4, 16], "query-scheduler": [2, 0.5, 2], compactor: [6, 40, 1] } },
] as const;
const LOKI_MIN: Record<string, number> = { ingester: 3, distributor: 2, "index-gateway": 2, querier: 2, "query-frontend": 2, "query-scheduler": 2, compactor: 1 };

const sizeLoki: Sizer = (cfg, d, wl) => {
  const gb = d.logsGbPerDay;
  const zones = cfg.components.loki.options.zoneAware ? cfg.topology.zones : 1;
  const tier = LOKI_TIERS.find((t) => gb <= t.upTo)!;
  const tierIdx = LOKI_TIERS.indexOf(tier);
  const tierLabel = ["< 3 TB/day", "3–30 TB/day", "~30 TB/day"][tierIdx];
  const reference = tierIdx === 0 ? 3_000 : 30_000;
  const base = (tier.base as Record<string, readonly number[]>)[wl];

  if (base) {
    const [cpu, mem, replicas] = base;
    const scaled = wl === "compactor" ? 1 : max(LOKI_MIN[wl] ?? 1, ceil((replicas * gb) / reference));
    const r = wl === "ingester" || wl === "index-gateway" ? multipleOf(scaled, zones) : scaled;
    let pvcGi: number | undefined;
    const notes = [`Official tier "${tierLabel}": ${replicas} × ${cpu} CPU / ${mem} Gi`, `scaled to ${fmt(gb)} GB/day (min ${LOKI_MIN[wl] ?? 1})`];
    if (wl === "ingester") {
      const hourlyPerIngester = (gb * ASSUMPTIONS.replicationFactor) / r / 24;
      pvcGi = roundDisk(max(10, hourlyPerIngester * 2 * HEADROOM));
      notes.push("Disk (no official number): WAL for ~2 h of this ingester's share × RF 3, +50 %, min 10 Gi");
    }
    if (wl === "index-gateway") pvcGi = roundDisk(max(10, gb / 100));
    if (wl === "compactor") pvcGi = roundDisk(max(20, gb / 20));
    return {
      replicas: r,
      cpu: roundCpu(cpu),
      memoryGi: roundMem(mem),
      pvcGi,
      source: "official",
      notes,
      scalable: wl !== "compactor",
      min: LOKI_MIN[wl] ?? 1,
      zones: wl === "ingester" || wl === "index-gateway" ? zones : 1,
    };
  }

  switch (wl) {
    case "ruler":
      return fixed(2, 0.5, 1, 10, "No official number; light unless you have many log-based rules.");
    case "pattern-ingester":
      return fixed(multipleOf(2, zones), 1, 2, 10, "No official number; starting value.");
    case "gateway":
      return fixed(2, roundCpu(max(0.25, gb / 2_000)), 0.5, undefined, "Proxy only; starting value.");
    case "chunks-cache":
      return fixed(2, 0.5, roundMem(max(2, gb / 100)), undefined, "No official formula (~1 GB per 100 GB/day). Scale out while evictions are above 0.");
    case "results-cache":
      return fixed(2, 0.25, 1, undefined, "No official formula. Scale out while evictions are above 0.");
    case "single-binary": {
      const cpu = roundCpu(max(1, gb / 20));
      const mem = roundMem(max(2, gb / 8));
      const notes = ["Monolithic suits up to a few tens of GB/day (official guidance).", "Resources scaled from volume (starting value)."];
      if (gb > 50) notes.push(`⚠ ${fmt(gb)} GB/day is above what monolithic is meant for; consider distributed.`);
      return { replicas: zones > 1 ? 3 : 1, cpu, memoryGi: mem, pvcGi: roundDisk(max(10, gb / 5)), source: "heuristic", notes };
    }
    case "write":
      return { replicas: multipleOf(max(3, ceil(gb / 300)), zones), cpu: 1, memoryGi: 4, pvcGi: roundDisk(max(10, gb / 10)), source: "heuristic", notes: ["Simple scalable has no official tiers; starting value (~300 GB/day per write pod)."] };
    case "read":
      return { replicas: max(2, ceil(gb / 300)), cpu: 1, memoryGi: 2, source: "heuristic", notes: ["Starting value; autoscale on query load."] };
    case "backend":
      return { replicas: 3, cpu: 1, memoryGi: 2, pvcGi: 10, source: "heuristic", notes: ["Starting value."] };
  }
  return fixed(1, 0.25, 0.5, undefined, "Starting value.");
};

// ------------------------------------------------------------------ Tempo (official sizing per MB/s)
const sizeTempo: Sizer = (cfg, d, wl) => {
  const mb = d.traceMbPerSecond;
  const zones = cfg.components.tempo.options.zoneAware ? cfg.topology.zones : 1;
  const traffic = `${mb} MB/s received (after ${d.traceSamplingPercent} % sampling)`;
  const scaleCpu = (perReplica: number, replicas: number, mbPerReplica: number) => roundCpu(max(0.25, perReplica * Math.min(1, mb / replicas / mbPerReplica)));

  switch (wl) {
    case "distributor": {
      const r = max(2, ceil(mb / 10));
      return { replicas: r, cpu: scaleCpu(2, r, 10), memoryGi: 2, source: "official", notes: [traffic, "1 replica per ~10 MB/s; 2 CPU / 2 GB at full load"], scalable: true, min: 2 };
    }
    case "live-store": {
      const r = multipleOf(max(2, ceil(mb / 8)), zones);
      return { replicas: r, cpu: 1, memoryGi: 8, pvcGi: roundDisk(max(10, mb * 3600 * 0.002 * HEADROOM)), source: "official", notes: [traffic, "1 replica per 6–10 MB/s; 1 CPU, 4–20 GB (8 GB chosen)", "Kafka partitions = live-store replicas"] };
    }
    case "block-builder": {
      const partitions = multipleOf(max(2, ceil(mb / 8)), zones);
      return { replicas: partitions, cpu: 0.5, memoryGi: 8, source: "official", notes: [`1 replica per Kafka partition (${partitions})`, "0.5 CPU, 5–10 GB (8 GB chosen)"] };
    }
    case "querier": {
      const r = max(2, ceil(mb / 1.5));
      return { replicas: r, cpu: 1, memoryGi: 4, source: "official", notes: [traffic, "1 replica per 1–2 MB/s; 4–20 GB depending on trace size"], scalable: true, min: 2 };
    }
    case "query-frontend":
      return { replicas: 2, cpu: 1, memoryGi: 4, source: "official", notes: ["2 replicas for HA; 4–20 GB depending on trace size and queries"] };
    case "backend-scheduler":
      return { replicas: 1, cpu: 0.5, memoryGi: 2, pvcGi: 8, source: "official", notes: ["Exactly 1 replica; 0.5 CPU, 1–2 GB (2 GB chosen)"] };
    case "backend-worker":
      return { replicas: max(1, ceil(mb / 10)), cpu: 0.5, memoryGi: 2, source: "heuristic", notes: ["0.5 CPU, 1–2 GB per replica (official); count is a starting value: watch the compaction backlog"] };
    case "metrics-generator":
      return { replicas: max(1, ceil(mb / 10)), cpu: 1, memoryGi: 2, source: "heuristic", notes: ["No official sizing; starting value"] };
    case "gateway":
      return fixed(2, 0.25, 0.5, undefined, "Proxy only; starting value.");
    case "memcached":
      return fixed(2, 0.5, 2, undefined, "Starting value; scale out while evictions are above 0.");
    case "tempo":
      return { replicas: 1, cpu: roundCpu(max(1, mb)), memoryGi: roundMem(max(4, mb * 4)), pvcGi: roundDisk(max(10, mb * 10)), source: "heuristic", notes: [traffic, "Monolithic: starting value scaled from traffic"] };
  }
  return fixed(1, 0.25, 0.5, undefined, "Starting value.");
};

// ------------------------------------------------------------------ Pyroscope
const sizePyroscope: Sizer = (_cfg, d, wl) => {
  const mb = d.profileMbPerSecond;
  const note = `${mb} MB/s of profiles (~${ASSUMPTIONS.profileKbPerPodPerSecond} KB/s per profiled pod). No official sizing; starting value.`;
  switch (wl) {
    case "pyroscope":
      return { replicas: 1, cpu: roundCpu(max(1, mb * 2)), memoryGi: roundMem(max(2, mb * 8)), pvcGi: roundDisk(max(10, mb * 20)), source: "heuristic", notes: [note] };
    case "segment-writer":
      return { replicas: 3, cpu: roundCpu(max(0.5, mb)), memoryGi: roundMem(max(2, mb * 4)), pvcGi: 10, source: "heuristic", notes: [note, "Chart default: 3 replicas"] };
    case "metastore":
      return fixed(3, 0.5, 1, 10, "Raft quorum of 3 (chart default).");
    case "compaction-worker":
      return { replicas: 3, cpu: roundCpu(max(0.5, mb / 2)), memoryGi: 2, pvcGi: 20, source: "heuristic", notes: [note, "Chart default: 3 replicas"] };
    case "query-backend":
      return fixed(3, roundCpu(max(0.5, mb)), 2, undefined, "Chart default: 3 replicas. " + note);
    case "tenant-settings":
      return fixed(1, 0.1, 0.25, undefined, "Lightweight.");
    default:
      return fixed(2, roundCpu(max(0.25, mb / 2)), 1, undefined, note);
  }
};

// ------------------------------------------------------------------ Kafka
const sizeKafka: Sizer = (cfg, d, wl) => {
  const m = cfg.components.mimir;
  const mimirUsesKafka = m.enabled && m.options.mode === "distributed" && m.options.architecture === "ingest";
  const tempoUsesKafka = cfg.components.tempo.enabled && cfg.components.tempo.options.mode === "distributed";
  const mimirMb = mimirUsesKafka ? (d.samplesPerSecond * 30) / 1_048_576 : 0; // ~30 bytes per sample on the wire
  const tempoMb = tempoUsesKafka ? d.traceMbPerSecond : 0;
  const mb = round1(mimirMb + tempoMb);
  const retentionHours = 24;
  if (wl === "kafka-controller") return fixed(3, 0.5, 1, 10, "KRaft quorum: 3 controllers.");
  if (wl === "kafka") return { replicas: 0, cpu: 0, memoryGi: 0, source: "heuristic", notes: [`~${mb} MB/s write throughput, ${retentionHours} h retention`] };
  const brokers = cfg.components.kafka.options.provider === "bundled" ? 1 : 3;
  const disk = (mb * 3600 * retentionHours * (brokers > 1 ? 3 : 1)) / 1024;
  return {
    ...spread({ cpu: max(1, mb / 10) * brokers, mem: max(4, mb / 2) * brokers, disk: disk * HEADROOM }, { min: brokers, minCpu: 1, minMem: 4 }),
    source: "heuristic",
    notes: [`~${mb} MB/s (Mimir ~30 B/sample + Tempo traffic)`, `${retentionHours} h retention × RF ${brokers > 1 ? 3 : 1}, +50 %`],
  };
};

// ------------------------------------------------------------------ collectors and small components
const sizeOther = (id: ComponentId): Sizer => (cfg, d, wl) => {
  const seriesPerCluster = d.activeSeries / d.remoteClusters;
  switch (`${id}:${wl}`) {
    case "prometheus:prometheus-agent": {
      const server = cfg.components.prometheus.options.mode === "server";
      const days = Number(cfg.components.prometheus.options.localRetentionDays) || 2;
      const spsCluster = d.samplesPerSecond / d.remoteClusters;
      return server
        ? {
            replicas: 1,
            cpu: roundCpu(max(1, spsCluster / 25_000)),
            memoryGi: roundMem(max(2, (seriesPerCluster * 8 * HEADROOM) / 1_048_576)),
            pvcGi: roundDisk(max(20, (spsCluster * 86_400 * days * 1.5 * HEADROOM) / 1_073_741_824)),
            source: "heuristic",
            notes: [`${fmt(seriesPerCluster)} series per cluster`, "Server mode: ~8 KB per series in memory", `disk: ~1.5 bytes per sample × ${days} days local retention, +50 %`],
          }
        : {
            replicas: 1,
            cpu: roundCpu(max(0.5, spsCluster / 50_000)),
            memoryGi: roundMem(max(1, (seriesPerCluster * 3 * HEADROOM) / 1_048_576)),
            pvcGi: roundDisk(max(10, (seriesPerCluster * 6) / 1_048_576)),
            source: "heuristic",
            notes: [`${fmt(seriesPerCluster)} series per cluster`, "Agent mode ~3 KB per series in memory, WAL on disk (starting value)"],
          };
    }
    case "prometheus:alloy-metrics":
      return { replicas: max(1, ceil(seriesPerCluster / 1_000_000)), cpu: roundCpu(max(0.5, d.samplesPerSecond / d.remoteClusters / 50_000)), memoryGi: roundMem(max(1, (seriesPerCluster * 3) / 1_048_576)), pvcGi: 10, source: "heuristic", notes: [`${fmt(seriesPerCluster)} series per cluster; ~1 M series per replica`] };
    case "kube-state-metrics:kube-state-metrics":
      return fixed(1, 0.1, roundMem(max(0.25, d.nodesPerCluster * 30 / 1000)), undefined, "Grows with the number of objects in the cluster.");
    case "node-exporter:node-exporter":
      return fixed(1, 0.1, 0.125, undefined, "DaemonSet: one pod on every node.");
    case "alloy-logs:alloy-logs":
      return fixed(1, roundCpu(max(0.1, d.logsGbPerDay / d.remoteClusters / d.nodesPerCluster / 20)), 0.5, undefined, "DaemonSet: one pod on every node; CPU grows with log lines per node.");
    case "alloy-events:alloy-events":
      return fixed(1, 0.1, 0.25, undefined, "Single replica per cluster.");
    case "cloud-logs:alloy-cloud-logs":
      return fixed(max(1, ceil(d.cloudLogsGbPerDay / 500)), 0.5, 1, undefined, `${fmt(d.cloudLogsGbPerDay)} GB/day; ~500 GB/day per replica (starting value).`);
    case "trace-collector:trace-collector":
      return fixed(max(2, ceil(d.traceMbPerSecond / d.remoteClusters / 5)), 0.5, 1, undefined, "~5 MB/s per replica; 2 for availability.");
    case "beyla:beyla":
      return fixed(1, 0.2, 0.5, undefined, "DaemonSet: one pod on every node. Beyla's CPU grows with the request rate on the node (~1–3 %).");
    case "alloy-profiles:alloy-profiles":
      return fixed(1, 0.2, 0.5, undefined, "DaemonSet: one pod on every node.");
    case "grafana:grafana":
      return { replicas: cfg.components.grafana.options.ha === "ha" ? max(2, ceil(d.grafanaUsers / 200)) : 1, cpu: roundCpu(0.25 + d.grafanaUsers / 200), memoryGi: roundMem(0.5 + d.grafanaUsers / 100), source: "heuristic", notes: [`${d.grafanaUsers} users`] };
    case "alertmanager:alertmanager":
      return fixed(Number(cfg.components.alertmanager.options.replicas) || 2, 0.1, 0.25, 1, "Gossip cluster; 2 replicas survive one failure.");
    case "robusta:runner":
      return fixed(1, 0.25, 1, undefined, "Robusta default.");
    case "robusta:forwarder":
      return fixed(1, 0.1, 0.25, undefined, "Robusta default.");
    case "robusta:holmes":
      return fixed(1, 0.5, 1, undefined, "Mostly waits on the LLM API.");
  }
  return fixed(1, 0.25, 0.5, undefined, "Starting value.");
};

// ------------------------------------------------------------------ Langfuse
const sizeLangfuse: Sizer = (cfg, d, wl) => {
  const eps = (d.llmCallsPerDay * ASSUMPTIONS.observationsPerLlmCall) / 86_400;
  const days = d.retention.ai;
  const note = `${fmt(d.llmCallsPerDay)} LLM calls/day ≈ ${round1(eps)} events/s`;
  switch (wl) {
    case "web":
      return { replicas: max(2, ceil(eps / 50)), cpu: 1, memoryGi: 2, source: "heuristic", notes: [note, "~50 events/s per web pod (starting value)"], scalable: true, min: 2 };
    case "worker":
      return { replicas: max(1, ceil(eps / 100)), cpu: 1, memoryGi: 2, source: "heuristic", notes: [note, "~100 events/s per worker (starting value)"], scalable: true, min: 1 };
    case "clickhouse": {
      const gb = (d.llmCallsPerDay * ASSUMPTIONS.observationsPerLlmCall * 2 * days * 0.3) / 1_048_576;
      const replicas = cfg.components.langfuse.options.clickhouseReplicated ? 3 : 1;
      return { replicas, cpu: roundCpu(max(2, eps / 50)), memoryGi: roundMem(max(8, eps / 10)), pvcGi: roundDisk(max(20, gb * HEADROOM)), source: "heuristic", notes: [note, `~2 KB per observation, ~70 % compression, ${days} days retention, +50 %`] };
    }
    case "clickhouse-keeper":
      return fixed(3, 0.5, 1, 10, "3 Keeper pods form a Raft quorum (survives one failure).");
    case "clickhouse-operator":
      return fixed(1, 0.1, 0.25, undefined, "Controller only.");
    case "postgresql":
      return fixed(1, 0.5, 1, 10, "Small: users, projects, prompts.");
    case "redis":
      return fixed(1, 0.25, 0.5, 5, "Short-lived queue.");
    case "seaweedfs":
      return fixed(1, 0.5, 1, roundDisk(max(20, (d.llmCallsPerDay * 10 * days) / 1_048_576)), "~10 KB raw event per call.");
  }
  return fixed(1, 0.25, 0.5, undefined, "Starting value.");
};

const SIZERS: Partial<Record<ComponentId, Sizer>> = {
  mimir: sizeMimir,
  loki: sizeLoki,
  tempo: sizeTempo,
  pyroscope: sizePyroscope,
  kafka: sizeKafka,
  langfuse: sizeLangfuse,
};

/**
 * Default autoscaler by workload type:
 *  - Deployment: KEDA for queriers/query-frontends (queue-based, scales before CPU saturates), else HPA on CPU
 *  - StatefulSet: VPA (recommendations); horizontal scaling stays deliberate (flush/hand-off before scale-down)
 *  - DaemonSet: fixed (scales with nodes)
 */
export function defaultAutoscaler(def: WorkloadDef): Autoscaler {
  if (def.defaultAutoscaler) return def.defaultAutoscaler;
  const has = (a: Autoscaler) => def.autoscalers.includes(a);
  if (def.kind === "Deployment") {
    if (/querier|query-frontend/.test(def.id) && has("keda")) return "keda";
    if (has("hpa")) return "hpa";
    if (has("keda")) return "keda";
    return "none";
  }
  if (def.kind === "StatefulSet") return has("vpa") ? "vpa" : "none";
  return "none";
}

/**
 * Applies the user's edits while keeping the total capacity of a load-based workload:
 *  - fewer CPU / less memory per pod → more replicas (and the other way round)
 *  - more replicas → smaller pods
 * Fixed-count workloads (singletons, Raft quorums, one-per-partition) only change what was edited.
 */
function linkedSize(def: WorkloadDef, calc: Calc, o: WorkloadOverride): WorkloadSize {
  const total = { cpu: calc.cpu * calc.replicas, mem: calc.memoryGi * calc.replicas, disk: (calc.pvcGi ?? 0) * calc.replicas };
  let replicas = calc.replicas;
  const linked = calc.scalable && def.kind !== "DaemonSet";
  if (o.replicas !== undefined) replicas = o.replicas;
  else if (linked && (o.cpu !== undefined || o.memoryGi !== undefined)) {
    const byCpu = o.cpu ? ceil(total.cpu / o.cpu) : 0;
    const byMem = o.memoryGi ? ceil(total.mem / o.memoryGi) : 0;
    replicas = multipleOf(max(calc.min ?? 1, byCpu, byMem, 1), calc.zones ?? 1);
  }
  const changed = replicas !== calc.replicas && linked && replicas > 0;
  return {
    replicas,
    cpu: o.cpu ?? (changed ? roundCpu(total.cpu / replicas) : calc.cpu),
    memoryGi: o.memoryGi ?? (changed ? roundMem(total.mem / replicas) : calc.memoryGi),
    pvcGi: def.pvc ? (o.pvcGi ?? (changed && calc.pvcGi ? roundDisk(total.disk / replicas) : calc.pvcGi)) : undefined,
  };
}

/** Sizes every workload of a component for one environment, applying the user's overrides. */
export function sizeComponent(cfg: PlannerConfig, id: ComponentId, env: string, runsOnRemote: boolean): SizedWorkload[] {
  const choice = cfg.components[id];
  const mimirAlertmanager = cfg.components.alertmanager.enabled === true && cfg.components.alertmanager.options.type === "mimir";
  const defs = workloadsFor(id, choice.options, { mimirAlertmanager });
  const d = deriveInputs(cfg, env);
  const sizer = SIZERS[id] ?? sizeOther(id);
  const overrides = cfg.overrides[env] ?? {};

  return defs.map((def) => {
    const wc = choice.workloads?.[def.id] ?? {};
    const calc = sizer(cfg, d, def.id);
    const o: WorkloadOverride = overrides[`${id}.${def.id}`] ?? {};
    const final = linkedSize(def, calc, o);
    return {
      def,
      enabled: def.required || (wc.enabled ?? def.defaultEnabled ?? true),
      autoscaler: wc.autoscaler && def.autoscalers.includes(wc.autoscaler) ? wc.autoscaler : defaultAutoscaler(def),
      calc,
      final,
      overridden: (Object.keys(o) as (keyof WorkloadSize)[]).filter((k) => o[k] !== undefined),
      adjusted: (["replicas", "cpu", "memoryGi", "pvcGi"] as (keyof WorkloadSize)[]).filter((k) => o[k] === undefined && final[k] !== (k === "pvcGi" && !def.pvc ? undefined : calc[k])),
      perCluster: runsOnRemote,
    };
  });
}
