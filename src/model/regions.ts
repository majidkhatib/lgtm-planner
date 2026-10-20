import { CLOUDS, type RegionInfo } from "../catalog/clouds";
import type { PlannerConfig, ReplicationMethod } from "./types";

export function regionInfo(cfg: PlannerConfig, id: string): RegionInfo {
  return CLOUDS[cfg.platform.cloud].regions.find((r) => r.id === id) ?? { id, name: id, short: id.replace(/[^a-z0-9]/g, "").slice(0, 5), continent: "europe" };
}

export const isMultiRegion = (cfg: PlannerConfig) => cfg.multiRegion.model !== "single" && cfg.multiRegion.regions.length > 0;

/** Second region for the standby / active-active models (Azure geo-replication: always the paired region). */
export function secondRegion(cfg: PlannerConfig): string | undefined {
  if (cfg.multiRegion.model === "standby" && cfg.platform.cloud === "azure" && cfg.multiRegion.replication === "geo") {
    return regionInfo(cfg, cfg.platform.region).paired;
  }
  return cfg.multiRegion.regions[0];
}

/** All regions with a central stack (active or standby), primary first. */
export function stackRegions(cfg: PlannerConfig): string[] {
  if (!isMultiRegion(cfg)) return [cfg.platform.region];
  if (cfg.multiRegion.model === "regional") return [cfg.platform.region, ...cfg.multiRegion.regions.filter((r) => r !== cfg.platform.region)];
  const second = secondRegion(cfg);
  return second && second !== cfg.platform.region ? [cfg.platform.region, second] : [cfg.platform.region];
}

/** Replication methods available on the chosen cloud. */
export function replicationMethods(cfg: PlannerConfig): ReplicationMethod[] {
  return cfg.platform.cloud === "azure" ? ["object", "geo"] : cfg.platform.cloud === "aws" ? ["crr"] : ["dual-region"];
}

export function effectiveReplication(cfg: PlannerConfig): ReplicationMethod {
  const allowed = replicationMethods(cfg);
  return allowed.includes(cfg.multiRegion.replication) ? cfg.multiRegion.replication : allowed[0];
}
