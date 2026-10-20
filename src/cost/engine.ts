import { runsOnRemote } from "../catalog/components";
import pricesJson from "../data/prices.json";
import { centralClusters, centralWorkloads, designComponents, isCentral, remoteClusters, remoteWorkloads, storageClassOf, type CentralCluster } from "../generate/common";
import { recommendNodePools, VM_TYPES } from "../generate/nodepools";
import { effectiveReplication, isMultiRegion, regionInfo } from "../model/regions";
import type { CloudId, ComponentId, PlannerConfig } from "../model/types";
import { deriveInputs } from "../sizing/inputs";

// ------------------------------------------------------------------ price data (src/data/prices.json, refreshed monthly)
interface DiskPrice {
  perGb?: number;
  tiers?: [number, number][];
}
interface StoragePrice {
  perGbMonth?: number;
  putPer1k?: number;
  getPer1k?: number;
}
export interface RegionPrices {
  vm: Record<string, number>;
  controlPlaneHour?: number;
  disks: Record<string, DiskPrice>;
  objectStorage: Record<string, StoragePrice>;
  transfer: { interZone?: number; interRegion?: number; internet?: number; geoReplication?: number };
  lb: { hour?: number; perGb?: number; lcuHour?: number };
  postgres: { burstable?: number; general?: number; storagePerGbMonth?: number };
  kafka: { unitHour?: number; unit?: string; mbPerUnit?: number; minUnits?: number; storagePerGbMonth?: number };
}
interface PriceFile {
  fetchedAt: string;
  eurPerUsd: number;
  sources: Record<string, string>;
  azure: Record<string, RegionPrices>;
  aws: Record<string, RegionPrices>;
  gcp: Record<string, RegionPrices>;
}
export const PRICES = pricesJson as unknown as PriceFile;

const HOURS = 730;

// ------------------------------------------------------------------ assumptions (shown in the UI)
export const COST_ASSUMPTIONS = {
  bytesPerSampleStored: 1.5, // Mimir TSDB blocks after compaction
  bytesPerSampleWire: 2, // remote_write, snappy-compressed
  logCompressionStored: 0.15, // Loki chunks vs raw log volume
  logCompressionWire: 0.25,
  traceCompression: 0.3, // Tempo Parquet blocks / OTLP compressed
  avgObjectMb: 2, // average object written to object storage
  llmInputTokens: 20_000, // per HolmesGPT investigation
  llmOutputTokens: 2_000,
};

export interface CostLine {
  group: "Compute" | "Storage" | "Network" | "Managed services" | "AI" | "Remote clusters";
  item: string;
  detail: string;
  usd: number;
  /** price list = computed from fetched prices; estimate = involves usage assumptions */
  basis: "price list" | "estimate";
}

export interface ClusterCost {
  name: string;
  region: string;
  role: "active" | "standby";
  lines: CostLine[];
  totalUsd: number;
  /** standby: monthly cost while it runs after a failover */
  ifRunningUsd?: number;
}

export interface CostReport {
  clusters: ClusterCost[];
  other: CostLine[];
  totalUsd: number;
  missing: string[];
  fetchedAt: string;
  eurPerUsd: number;
}

const priceRegion = (cloud: CloudId, region: string): RegionPrices | undefined => PRICES[cloud][region];

/** Monthly price of one disk: Azure sells disks in size tiers (P10 = 128 GiB …), the others per GB. */
function diskMonthly(p: RegionPrices, cls: string, sizeGi: number): number | undefined {
  const d = p.disks[cls];
  if (!d) return cls.startsWith("local") ? 0 : undefined;
  if (d.perGb !== undefined) return d.perGb * sizeGi;
  const tier = d.tiers?.find(([size]) => size >= sizeGi) ?? d.tiers?.at(-1);
  return tier?.[1];
}

/** Object-storage price key of the chosen setup. */
function storageKey(cfg: PlannerConfig): string {
  const standby = isMultiRegion(cfg) && cfg.multiRegion.model === "standby";
  if (cfg.platform.cloud === "azure") return standby && effectiveReplication(cfg) === "geo" ? (cfg.topology.zones > 1 ? "ragzrs" : "ragrs") : cfg.topology.zones > 1 ? "zrs" : "lrs";
  if (cfg.platform.cloud === "gcp" && standby) return "dualRegion";
  return "standard";
}

const on = (cfg: PlannerConfig, id: ComponentId) => designComponents(cfg).some((c) => c.id === id);

/** Data volumes of one central cluster (per month unless noted). */
function volumes(c: CentralCluster) {
  const cfg = c.cfg;
  const d = deriveInputs(cfg, c.env);
  const A = COST_ASSUMPTIONS;
  const day = 86_400;
  const metricsDay = on(cfg, "mimir") ? (d.samplesPerSecond * day) / 1e9 : 0; // billions of samples per day
  const logsDay = on(cfg, "loki") ? d.logsGbPerDay : 0;
  const tracesDay = on(cfg, "tempo") ? (d.traceMbPerSecond * day) / 1024 : 0;
  const profilesDay = on(cfg, "pyroscope") ? (d.profileMbPerSecond * day) / 1024 : 0;
  const llmDay = on(cfg, "langfuse") ? (d.llmCallsPerDay * 10) / 1e6 : 0; // ~10 KB per call
  const r = d.retention;
  const storedGb =
    metricsDay * A.bytesPerSampleStored * r.metrics +
    logsDay * A.logCompressionStored * r.logs +
    tracesDay * A.traceCompression * r.traces +
    profilesDay * A.traceCompression * r.profiles +
    llmDay * r.ai;
  const newGbPerDay = metricsDay * A.bytesPerSampleStored + logsDay * A.logCompressionStored + (tracesDay + profilesDay) * A.traceCompression + llmDay;
  const wireGbPerMonth = 30 * (metricsDay * A.bytesPerSampleWire + logsDay * A.logCompressionWire + (tracesDay + profilesDay) * A.traceCompression);
  return { d, storedGb, newGbPerDay, wireGbPerMonth };
}

const money = (n: number) => Math.round(n * 100) / 100;
const gb = (n: number) => (n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} TB` : `${Math.round(n)} GB`);

function clusterCost(cfg: PlannerConfig, c: CentralCluster, missing: string[]): ClusterCost {
  const cloud = cfg.platform.cloud;
  const p = priceRegion(cloud, c.region);
  const lines: CostLine[] = [];
  if (!p) {
    missing.push(`${cloud.toUpperCase()} ${c.region}: no price data${cloud === "gcp" ? " (GCP prices need an API key in the price-fetch job)" : ""}`);
    return { name: c.name, region: c.region, role: c.role, lines, totalUsd: 0 };
  }
  const add = (l: CostLine) => lines.push({ ...l, usd: money(l.usd) });
  const v = volumes(c);

  // ---- compute
  const compute: CostLine[] = [];
  const cp = p.controlPlaneHour ?? 0.1;
  compute.push({ group: "Compute", item: `${cloud === "azure" ? "AKS Standard tier" : cloud === "aws" ? "EKS" : "GKE"} control plane`, detail: `$${cp}/h × ${HOURS} h`, usd: cp * HOURS, basis: "price list" });
  for (const pool of recommendNodePools(c)) {
    const hour = p.vm[pool.vm.name];
    if (hour === undefined) missing.push(`${pool.vm.name} in ${c.region}`);
    compute.push({ group: "Compute", item: `Node pool "${pool.name}"`, detail: `${pool.nodes} × ${pool.vm.name} at $${hour ?? "?"}/h`, usd: (hour ?? 0) * pool.nodes * HOURS, basis: "price list" });
  }

  // ---- disks (PVCs)
  const disks: CostLine[] = [];
  for (const comp of designComponents(cfg).filter((x) => isCentral(x.id, cfg))) {
    const cls = storageClassOf(cfg, comp.id);
    let total = 0;
    const parts: string[] = [];
    for (const w of centralWorkloads(c, comp.id)) {
      if (!w.def.pvc || !w.final.pvcGi) continue;
      const per = diskMonthly(p, cls, w.final.pvcGi);
      if (per === undefined) {
        missing.push(`disk class ${cls} in ${c.region}`);
        continue;
      }
      total += per * w.final.replicas;
      parts.push(`${w.final.replicas} × ${w.final.pvcGi} GiB`);
    }
    if (parts.length) disks.push({ group: "Storage", item: `${comp.name} disks (${cls})`, detail: parts.join(", "), usd: total, basis: "price list" });
  }

  // ---- object storage
  const key = storageKey(cfg);
  const s = p.objectStorage[key] ?? p.objectStorage.standard ?? Object.values(p.objectStorage)[0];
  const storage: CostLine[] = [];
  if (s?.perGbMonth !== undefined && v.storedGb > 0) {
    storage.push({ group: "Storage", item: `Object storage (${key})`, detail: `${gb(v.storedGb)} stored with your retention × $${s.perGbMonth}/GB`, usd: v.storedGb * s.perGbMonth, basis: "estimate" });
    const puts = ((v.newGbPerDay * 1000) / COST_ASSUMPTIONS.avgObjectMb) * 30 * 2; // written once, rewritten once by compaction
    const gets = puts * 10;
    storage.push({ group: "Storage", item: "Object storage requests", detail: `~${Math.round(puts / 1000)}k writes, ~${Math.round(gets / 1000)}k reads per month`, usd: (puts / 1000) * (s.putPer1k ?? 0) + (gets / 1000) * (s.getPer1k ?? 0), basis: "estimate" });
  }

  // ---- network
  const network: CostLine[] = [];
  const t = p.transfer;
  if (p.lb.hour !== undefined) {
    const processed = p.lb.perGb ? v.wireGbPerMonth * p.lb.perGb : (p.lb.lcuHour ?? 0) * HOURS * Math.max(1, v.wireGbPerMonth / HOURS);
    network.push({ group: "Network", item: "Load balancer", detail: `$${p.lb.hour}/h + data processed (${gb(v.wireGbPerMonth)})`, usd: p.lb.hour * HOURS + processed, basis: "estimate" });
  }
  if (c.role === "active" && c.serves.length) {
    const viaInternet = cfg.connectivity.path === "public";
    const perGb = viaInternet ? (t.internet ?? 0) : (t.interZone ?? 0) * 2;
    network.push({
      group: "Network",
      item: "Data from remote clusters",
      detail: `${gb(v.wireGbPerMonth)}/month ${viaInternet ? "over the internet (billed to the sending side; $0 if the remote clusters are in the same region and use private IPs)" : "over private peering"}`,
      usd: v.wireGbPerMonth * perGb,
      basis: "estimate",
    });
    if (cfg.topology.zones > 1 && (t.interZone ?? 0) > 0) {
      // ingesters replicate every write to 2 other zones (RF 3); AWS bills both directions
      const factor = cloud === "aws" ? 2 : 1;
      network.push({ group: "Network", item: "Traffic between zones", detail: `writes replicated to 2 more zones: ${gb(v.wireGbPerMonth * 2)} × $${t.interZone}/GB${factor > 1 ? " × 2 directions" : ""}`, usd: v.wireGbPerMonth * 2 * (t.interZone ?? 0) * factor, basis: "estimate" });
    }
    if (isMultiRegion(cfg) && cfg.multiRegion.model === "standby") {
      const method = effectiveReplication(cfg);
      const perGbRep = method === "geo" ? (t.geoReplication ?? t.interRegion ?? 0) : method === "dual-region" ? 0 : (t.interRegion ?? 0);
      network.push({ group: "Network", item: "Replication to the standby region", detail: `${gb(v.newGbPerDay * 30)}/month new data × $${perGbRep}/GB`, usd: v.newGbPerDay * 30 * perGbRep, basis: "estimate" });
    }
  }

  // ---- managed services
  const managed: CostLine[] = [];
  const pgNeeds = [cfg.components.grafana.enabled && cfg.components.grafana.options.ha === "ha" ? "Grafana" : "", on(cfg, "langfuse") && cfg.components.langfuse.options.postgres === "managed" ? "Langfuse" : ""].filter(Boolean);
  if (pgNeeds.length) {
    const tier = cfg.components.langfuse.options.postgresTier === "general" ? "general" : "burstable";
    const hour = p.postgres[tier] ?? p.postgres.burstable ?? 0;
    const ha = cfg.components.langfuse.options.postgresHa ? 2 : 1;
    managed.push({ group: "Managed services", item: `Managed PostgreSQL (${pgNeeds.join(" + ")})`, detail: `${tier}${ha > 1 ? ", HA" : ""}, 32 GB`, usd: hour * HOURS * ha + 32 * (p.postgres.storagePerGbMonth ?? 0), basis: "price list" });
  }
  const kafkaUsed = on(cfg, "kafka") && cfg.components.kafka.options.provider === "managed";
  if (kafkaUsed && p.kafka.unitHour) {
    const mb = (v.wireGbPerMonth * 1024) / (30 * 86_400);
    const units = Math.max(p.kafka.minUnits ?? 1, Math.ceil(mb / (p.kafka.mbPerUnit ?? 5)));
    const storageGb = p.kafka.storagePerGbMonth ? mb * 86_400 * 3 / 1024 : 0;
    managed.push({ group: "Managed services", item: `Managed Kafka`, detail: `${units} × ${p.kafka.unit} (${mb >= 1 ? `${Math.round(mb * 10) / 10} MB/s` : `${Math.round(mb * 1024)} KB/s`} of writes; minimum size)`, usd: units * p.kafka.unitHour * HOURS + storageGb * (p.kafka.storagePerGbMonth ?? 0), basis: "estimate" });
  }

  const running = [...compute, ...disks, ...network.filter((l) => l.item === "Load balancer")];
  if (c.role === "standby") {
    // A standby only costs its replicated storage until a failover.
    for (const l of storage) add(l);
    const ifRunningUsd = money(running.reduce((a, l) => a + l.usd, 0));
    return { name: c.name, region: c.region, role: c.role, lines, totalUsd: money(lines.reduce((a, l) => a + l.usd, 0)), ifRunningUsd };
  }
  for (const l of [...compute, ...disks, ...storage, ...network, ...managed]) add(l);
  return { name: c.name, region: c.region, role: c.role, lines, totalUsd: money(lines.reduce((a, l) => a + l.usd, 0)) };
}

export function costReport(cfg: PlannerConfig): CostReport {
  const missing: string[] = [];
  const clusters = centralClusters(cfg).map((c) => clusterCost(cfg, c, missing));
  const other: CostLine[] = [];
  const p = priceRegion(cfg.platform.cloud, cfg.platform.region);

  // Capacity the collectors take on the existing remote clusters (priced as general-purpose VM capacity)
  if (p && remoteClusters(cfg).length) {
    const vm = VM_TYPES[cfg.platform.cloud].find((x) => x.family === "general" && x.vcpu === 4)!;
    const hour = p.vm[vm.name] ?? 0;
    let usd = 0;
    let cpu = 0;
    let mem = 0;
    for (const env of cfg.environments) {
      const n = remoteClusters(cfg).filter((r) => r.env === env).length;
      const nodes = cfg.volumes[env]?.metrics.nodes ?? 1;
      for (const comp of designComponents(cfg).filter((x) => runsOnRemote(cfg, x.id)))
        for (const w of remoteWorkloads(cfg, env, comp.id)) {
          const pods = w.def.kind === "DaemonSet" ? nodes : w.final.replicas * n;
          cpu += w.final.cpu * pods;
          mem += w.final.memoryGi * pods;
        }
    }
    usd = Math.max(cpu / vm.vcpu, mem / vm.memoryGi) * hour * HOURS;
    other.push({ group: "Remote clusters", item: "Collectors on your remote clusters", detail: `${Math.round(cpu * 10) / 10} CPU, ${Math.round(mem)} GiB in total (share of existing nodes, priced as ${vm.name})`, usd: money(usd), basis: "estimate" });
  }

  // LLM tokens for HolmesGPT
  if (on(cfg, "robusta")) {
    const o = cfg.components.robusta.options;
    const perMonth = (Number(o.alertsPerDay) || 0) * 30;
    const inPrice = Number(o.llmInputPrice) || 0;
    const outPrice = Number(o.llmOutputPrice) || 0;
    const usd = (perMonth * (COST_ASSUMPTIONS.llmInputTokens * inPrice + COST_ASSUMPTIONS.llmOutputTokens * outPrice)) / 1e6;
    other.push({ group: "AI", item: "LLM tokens (HolmesGPT)", detail: `${perMonth} investigations × ~${COST_ASSUMPTIONS.llmInputTokens / 1000}k in / ${COST_ASSUMPTIONS.llmOutputTokens / 1000}k out tokens at $${inPrice} / $${outPrice} per million`, usd: money(usd), basis: "estimate" });
  }

  const totalUsd = money(clusters.reduce((a, c) => a + c.totalUsd, 0) + other.reduce((a, l) => a + l.usd, 0));
  return { clusters, other, totalUsd, missing: [...new Set(missing)], fetchedAt: PRICES.fetchedAt, eurPerUsd: PRICES.eurPerUsd };
}

/** Same design with the other central-cluster model, for the comparison box. */
export function alternativeModelTotal(cfg: PlannerConfig): { model: "per-env" | "shared"; totalUsd: number } | null {
  if (cfg.environments.length < 2) return null;
  const model = cfg.topology.centralModel === "per-env" ? "shared" : "per-env";
  return { model, totalUsd: costReport({ ...cfg, topology: { ...cfg.topology, centralModel: model } }).totalUsd };
}

export const regionName = (cfg: PlannerConfig, r: string) => regionInfo(cfg, r).name;
