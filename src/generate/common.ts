import { relevantComponents, runsOnCentral, runsOnRemote, type ComponentDef } from "../catalog/components";
import { defaultVolumes } from "../model/defaults";
import { effectiveReplication, isMultiRegion, regionInfo, stackRegions } from "../model/regions";
import type { ComponentId, PlannerConfig, Volumes } from "../model/types";
import { sizeComponent, type SizedWorkload } from "../sizing/engine";

/** Namespace of all observability components (add-ons, Argo CD and ClickHouse keep their own namespaces). */
export const NS = "ns-monitoring";

export interface GeneratedFile {
  path: string;
  content: string;
}

/** A central cluster and the configuration its sizing is based on. */
export interface CentralCluster {
  /** cluster name, e.g. central-prod or central-prod-gwc */
  name: string;
  /** sizing key: an environment, or "shared" */
  env: string;
  /** folder under helm/central, manifests/central…: "prod" or "prod/gwc" */
  dir: string;
  region: string;
  /** standby = files are generated, but it is only deployed on failover */
  role: "active" | "standby";
  /** environments whose remote clusters send data here */
  serves: string[];
  /** per-cluster view of the configuration: its region, its storage, its share of the volumes */
  cfg: PlannerConfig;
  /** the full configuration */
  global: PlannerConfig;
}

export interface RemoteCluster {
  name: string;
  env: string;
  region: string;
}

/** Remote clusters that share one set of collector values (same environment and region). */
export interface RemoteGroup {
  env: string;
  region: string;
  /** folder under helm/remote: "prod" or "prod/gwc" */
  dir: string;
  /** regions the collectors write to (two for active-active) */
  targets: string[];
}

/** Volumes of all environments added up; retention = the longest. */
function combinedVolumes(cfg: PlannerConfig): Volumes {
  const all = cfg.environments.map((e) => cfg.volumes[e] ?? defaultVolumes(e));
  const sum = (f: (v: Volumes) => number) => all.reduce((a, v) => a + f(v), 0);
  const maxOf = (f: (v: Volumes) => number) => Math.max(...all.map(f));
  const base = structuredClone(all[0]);
  base.metrics = {
    knowsActiveSeries: true,
    activeSeries: Math.round(
      all.reduce(
        (a, v) => a + (v.metrics.knowsActiveSeries ? v.metrics.activeSeries : v.metrics.nodes * 1000 + v.metrics.nodes * v.metrics.podsPerNode * 400),
        0,
      ),
    ),
    nodes: sum((v) => v.metrics.nodes),
    podsPerNode: base.metrics.podsPerNode,
  };
  base.logsGbPerDay = sum((v) => v.logsGbPerDay);
  base.cloudLogsGbPerDay = sum((v) => v.cloudLogsGbPerDay);
  base.traces = { unit: "spans", spansPerSecond: sum((v) => (v.traces.unit === "spans" ? v.traces.spansPerSecond : (v.traces.gbPerDay * 1024 * 1024) / 86_400)), gbPerDay: 0 };
  base.profiledServices = sum((v) => v.profiledServices);
  base.llmCallsPerDay = sum((v) => v.llmCallsPerDay);
  base.grafanaUsers = sum((v) => v.grafanaUsers);
  base.dashboards = sum((v) => v.dashboards);
  base.retentionDays = {
    metrics: maxOf((v) => v.retentionDays.metrics),
    logs: maxOf((v) => v.retentionDays.logs),
    traces: maxOf((v) => v.retentionDays.traces),
    profiles: maxOf((v) => v.retentionDays.profiles),
    ai: maxOf((v) => v.retentionDays.ai),
  };
  delete base.queryQpsOverride;
  return base;
}

function scaleVolumes(v: Volumes, f: number): Volumes {
  const c = structuredClone(v);
  c.metrics.knowsActiveSeries = true;
  c.metrics.activeSeries = Math.round((v.metrics.knowsActiveSeries ? v.metrics.activeSeries : v.metrics.nodes * 1000 + v.metrics.nodes * v.metrics.podsPerNode * 400) * f);
  c.metrics.nodes = Math.max(1, Math.round(v.metrics.nodes * f));
  c.logsGbPerDay *= f;
  c.cloudLogsGbPerDay *= f;
  c.traces.spansPerSecond *= f;
  c.traces.gbPerDay *= f;
  c.profiledServices = Math.round(c.profiledServices * f);
  c.llmCallsPerDay = Math.round(c.llmCallsPerDay * f);
  c.grafanaUsers = Math.max(1, Math.round(c.grafanaUsers * f));
  return c;
}

/** Remote clusters per environment in one region. */
function remoteCounts(cfg: PlannerConfig, region: string): Record<string, number> {
  if (cfg.multiRegion.model !== "regional" || region === cfg.platform.region) return cfg.topology.remoteClusters;
  return cfg.multiRegion.remoteClusters[region] ?? {};
}

/** Central clusters of one region (before multi-region): per environment or one shared. */
function baseCentral(cfg: PlannerConfig): Omit<CentralCluster, "dir" | "region" | "role" | "global">[] {
  if (cfg.topology.centralModel === "shared" && cfg.environments.length > 1) {
    const total = cfg.environments.reduce((a, e) => a + (cfg.topology.remoteClusters[e] ?? 0), 0);
    const shared: PlannerConfig = {
      ...cfg,
      environments: ["shared"],
      volumes: { shared: combinedVolumes(cfg) },
      topology: { ...cfg.topology, remoteClusters: { shared: total } },
      overrides: { shared: cfg.overrides.shared ?? {} },
    };
    return [{ name: "central", env: "shared", serves: cfg.environments, cfg: shared }];
  }
  return cfg.environments.map((e) => ({ name: `central-${e}`, env: e, serves: [e], cfg }));
}

export function centralClusters(cfg: PlannerConfig): CentralCluster[] {
  if (!isMultiRegion(cfg)) {
    return baseCentral(cfg).map((c) => ({ ...c, dir: c.env, region: cfg.platform.region, role: "active" as const, global: cfg }));
  }
  const model = cfg.multiRegion.model;
  const regions = stackRegions(cfg);
  return regions.flatMap((region, i) => {
    const short = regionInfo(cfg, region).short;
    const standby = model === "standby" && i > 0;
    // Regional model: each region sees only its own remote clusters and its share of the volumes.
    let view: PlannerConfig = { ...cfg, platform: { ...cfg.platform, region } };
    if (model === "regional") {
      const counts = remoteCounts(cfg, region);
      const volumes: Record<string, Volumes> = {};
      for (const e of cfg.environments) {
        const total = regions.reduce((a, r) => a + (remoteCounts(cfg, r)[e] ?? 0), 0);
        const share = total > 0 ? (counts[e] ?? 0) / total : 1 / regions.length;
        volumes[e] = scaleVolumes(cfg.volumes[e] ?? defaultVolumes(e), Math.max(share, 0.05));
      }
      view = { ...view, volumes, topology: { ...cfg.topology, remoteClusters: counts } };
    }
    // Standby reads the replicated storage (GCP dual-region: the same bucket as the primary).
    // (Azure geo-replication: the same storage account, which keeps its name after an account failover.)
    const sameStorage = cfg.platform.cloud === "gcp" || (cfg.platform.cloud === "azure" && effectiveReplication(cfg) === "geo");
    const storageRegion = standby && sameStorage ? cfg.platform.region : region;
    view = { ...view, multiRegion: { ...cfg.multiRegion, storageRegion } };
    return baseCentral(view)
      .filter((c) => model !== "regional" || region === cfg.platform.region || c.serves.some((e) => (remoteCounts(cfg, region)[e] ?? 0) > 0))
      .map((c) => ({
        ...c,
        name: `${c.name}-${short}`,
        dir: `${c.env}/${short}`,
        region,
        role: standby ? ("standby" as const) : ("active" as const),
        serves: standby ? [] : c.serves,
        global: cfg,
      }));
  });
}

export function remoteClusters(cfg: PlannerConfig): RemoteCluster[] {
  const regional = isMultiRegion(cfg) && cfg.multiRegion.model === "regional";
  const regions = regional ? stackRegions(cfg) : [cfg.platform.region];
  return regions.flatMap((region) => {
    const counts = remoteCounts(cfg, region);
    const tag = regional ? `-${regionInfo(cfg, region).short}` : "";
    return cfg.environments.flatMap((env) =>
      Array.from({ length: counts[env] ?? 0 }, (_, i) => ({ name: `${env}${tag}-workload-${i + 1}`, env, region })),
    );
  });
}

/** Groups of remote clusters that share collector settings, and where they write to. */
export function remoteGroups(cfg: PlannerConfig): RemoteGroup[] {
  const multi = isMultiRegion(cfg);
  const regional = multi && cfg.multiRegion.model === "regional";
  const targetsAll = multi && cfg.multiRegion.model === "active-active" ? stackRegions(cfg) : [cfg.platform.region];
  const groups: RemoteGroup[] = [];
  for (const r of remoteClusters(cfg)) {
    if (groups.some((g) => g.env === r.env && g.region === r.region)) continue;
    groups.push({
      env: r.env,
      region: r.region,
      dir: regional ? `${r.env}/${regionInfo(cfg, r.region).short}` : r.env,
      targets: regional ? [r.region] : targetsAll,
    });
  }
  return groups;
}

export function groupOf(cfg: PlannerConfig, r: RemoteCluster): RemoteGroup {
  return remoteGroups(cfg).find((g) => g.env === r.env && g.region === r.region)!;
}

/** The (primary-region) central cluster that serves an environment. */
export function centralFor(cfg: PlannerConfig, env: string): CentralCluster {
  const all = centralClusters(cfg);
  return all.find((c) => c.serves.includes(env) && c.region === cfg.platform.region) ?? all.find((c) => c.serves.includes(env)) ?? all[0];
}

/** Folder of an environment's values in the primary region (used by the UI to show file paths). */
export function dirForEnv(cfg: PlannerConfig, env: string, remote: boolean): string {
  if (!remote) return centralFor(cfg, env).dir;
  return remoteGroups(cfg).find((g) => g.env === env && g.region === cfg.platform.region)?.dir ?? env;
}

/** Remote clusters that send their data to a central cluster. */
export function remotesOf(c: CentralCluster): RemoteCluster[] {
  const cfg = c.global;
  const regional = isMultiRegion(cfg) && cfg.multiRegion.model === "regional";
  return remoteClusters(cfg).filter((r) => c.serves.includes(r.env) && (!regional || r.region === c.region));
}

/** Components that are part of the design, in wizard order. */
export function designComponents(cfg: PlannerConfig): ComponentDef[] {
  return relevantComponents(cfg).filter((c) => cfg.components[c.id].enabled);
}

/** Whether the component has pods on central / remote clusters with the current choices (e.g. Alertmanager placement). */
export const isCentral = (id: ComponentId, cfg: PlannerConfig) => runsOnCentral(cfg, id);
export const isRemote = (id: ComponentId, cfg: PlannerConfig) => runsOnRemote(cfg, id);

/** Workloads of a component on the central cluster (enabled only). */
export function centralWorkloads(c: CentralCluster, id: ComponentId): SizedWorkload[] {
  return sizeComponent(c.cfg, id, c.env, false).filter((w) => w.enabled);
}

export function remoteWorkloads(cfg: PlannerConfig, env: string, id: ComponentId): SizedWorkload[] {
  return sizeComponent(cfg, id, env, true).filter((w) => w.enabled);
}

// ------------------------------------------------------------------ tenants
export function tenantsFor(cfg: PlannerConfig, c: CentralCluster): string[] {
  if (!cfg.tenancy.enabled) return ["anonymous"];
  // A standby stack serves the same tenants as the primary once it takes over.
  if (cfg.tenancy.key === "environment") return c.role === "standby" ? c.global.environments : c.serves;
  if (cfg.tenancy.key === "cluster") return (c.role === "standby" ? remoteClusters(c.global) : remotesOf(c)).map((r) => r.name);
  return ["tenant-a", "tenant-b"]; // label-based tenancy: tenant names come from workload labels
}

export function tenantOfRemote(cfg: PlannerConfig, r: RemoteCluster): string {
  if (!cfg.tenancy.enabled) return "anonymous";
  if (cfg.tenancy.key === "environment") return r.env;
  return r.name;
}

// ------------------------------------------------------------------ naming
/** Short, stable suffix so bucket/account names (global namespace) don't collide. */
export function namePrefix(cfg: PlannerConfig): string {
  let h = 0;
  for (const ch of cfg.connectivity.baseDomain || "example.com") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `obs${h.toString(36).slice(0, 4)}`;
}

/** Region code added to storage names when there is more than one region. */
function storageTag(cfg: PlannerConfig, region?: string): string {
  if (!isMultiRegion(cfg)) return "";
  return regionInfo(cfg, region ?? cfg.multiRegion.storageRegion ?? cfg.platform.region).short;
}

/** Storage account (Azure) of an environment; in multi-region setups one per region. */
export function azureStorageAccount(cfg: PlannerConfig, env: string, region?: string): string {
  return `st${namePrefix(cfg)}${env}${storageTag(cfg, region)}`.replace(/[^a-z0-9]/g, "").slice(0, 24);
}

/** Azure Key Vault of a central cluster (max 24 characters). */
export function keyVaultName(cfg: PlannerConfig, env: string, region?: string): string {
  return `kv-${namePrefix(cfg)}-${env}${storageTag(cfg, region)}`.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24);
}

/** S3 / GCS bucket name; in multi-region setups the region code is part of the name. */
export function bucketName(cfg: PlannerConfig, env: string, store: string, region?: string): string {
  const tag = storageTag(cfg, region);
  return `${namePrefix(cfg)}-${env}${tag ? `-${tag}` : ""}-${store}`.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
}

/** Object storage "buckets" (S3/GCS buckets or Azure blob containers) per component. */
export const STORES: Partial<Record<ComponentId, string[]>> = {
  mimir: ["mimir-blocks", "mimir-ruler", "mimir-alertmanager"],
  loki: ["loki-chunks", "loki-ruler", "loki-admin"],
  tempo: ["tempo-traces"],
  pyroscope: ["pyroscope-profiles"],
  langfuse: ["langfuse-events"],
};

// ------------------------------------------------------------------ formatting
export function cpuStr(cores: number): string {
  return cores >= 1 && Number.isInteger(cores) ? String(cores) : `${Math.round(cores * 1000)}m`;
}

export function memStr(gi: number): string {
  return Number.isInteger(gi) ? `${gi}Gi` : `${Math.round(gi * 1024)}Mi`;
}

export function resources(w: SizedWorkload) {
  // Limits: memory = 1.5 × request (Go apps need headroom for GC); no CPU limit (avoids throttling).
  return {
    requests: { cpu: cpuStr(w.final.cpu), memory: memStr(w.final.memoryGi) },
    limits: { memory: memStr(Math.ceil(w.final.memoryGi * 1.5 * 4) / 4) },
  };
}

/**
 * Hostname of a central service. Regional and active-active stacks get one hostname per region
 * (mimir.gwc.example.com); a standby region takes over the primary hostnames through DNS failover.
 */
export function hostOf(cfg: PlannerConfig, id: ComponentId, region?: string): string {
  const custom = String(cfg.components[id]?.options.host ?? "").trim();
  const base = custom || `${id}.${cfg.connectivity.baseDomain || "example.com"}`;
  const perRegion = isMultiRegion(cfg) && (cfg.multiRegion.model === "regional" || cfg.multiRegion.model === "active-active");
  if (!perRegion) return base;
  const short = regionInfo(cfg, region ?? cfg.platform.region).short;
  const dot = base.indexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}.${short}${base.slice(dot)}` : `${base}.${short}`;
}

export function storageClassOf(cfg: PlannerConfig, id: ComponentId): string {
  return String(cfg.components[id].options.storageClass);
}
