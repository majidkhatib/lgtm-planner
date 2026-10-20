import type { PlannerConfig } from "../model/types";
import type { CentralCluster } from "./common";

// Splits Helm values into helm/base (shared) and helm/central/<cluster> (environment-specific).
//
// base    = every value that is identical on all central clusters AND on a "probe" cluster
//           (an imaginary environment with another name and different volumes). So bucket names,
//           sizes, limits and retention never end up in base, even with a single environment.
//           Sizing and tenant limits always stay in the cluster files, even where several
//           environments happen to get the same (minimum) size: they belong to the environment.
// overlay = what differs from base for that cluster.
// Helm applies base first, then the overlay, which gives back exactly the cluster's values.

type Values = Record<string, unknown>;

const isObject = (v: unknown): v is Values => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Helm's merge: maps are merged, lists and scalars are replaced. */
export function mergeValues(base: unknown, overlay: unknown): unknown {
  if (!isObject(base) || !isObject(overlay)) return overlay === undefined ? base : overlay;
  const out: Values = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = mergeValues(base[k], v);
  return out;
}

/** Keys that are sized or calculated per environment (at any depth). */
const PER_ENVIRONMENT = new Set([
  // sizing
  "replicas",
  "replicaCount",
  "resources",
  "persistence",
  "persistentVolume",
  "autoscaling",
  "kedaAutoscaling",
  "hpa",
  "keda",
  "vpa",
  // tenant limits and retention
  "limits",
  "limits_config",
  "runtimeConfig",
  "overrides",
  "per_tenant_overrides",
  "tenantOverrides",
  "retention",
]);

/** Values present and equal in every input (maps are compared key by key, lists as a whole). */
export function commonValues(all: Values[]): Values {
  const out: Values = {};
  const [first, ...rest] = all;
  for (const [k, v] of Object.entries(first)) {
    if (PER_ENVIRONMENT.has(k)) continue;
    const others = rest.map((x) => x[k]);
    if (others.some((o) => o === undefined)) continue;
    if (isObject(v) && Object.keys(v).length && others.every(isObject)) {
      const inner = commonValues([v, ...(others as Values[])]);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (others.every((o) => same(o, v))) {
      out[k] = v;
    }
  }
  return out;
}

/** What `full` adds or changes on top of `base`. */
export function valuesDiff(full: Values, base: Values): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(full)) {
    const b = base[k];
    if (isObject(v) && Object.keys(v).length && isObject(b)) {
      const inner = valuesDiff(v, b);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (!same(v, b)) {
      out[k] = v;
    }
  }
  return out;
}

const PROBE = "zz-probe";

const scaled = (v: unknown): unknown =>
  typeof v === "number" ? v * 3 + 1 : Array.isArray(v) ? v.map(scaled) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scaled(x)])) : v;

/** The same cluster as an imaginary environment with another name and different volumes. */
export function probeCluster(c: CentralCluster): CentralCluster {
  const cfg = c.cfg;
  const pc: PlannerConfig = {
    ...cfg,
    environments: [...cfg.environments, PROBE],
    volumes: { ...cfg.volumes, [PROBE]: scaled(cfg.volumes[c.env]) as PlannerConfig["volumes"][string] },
    topology: { ...cfg.topology, remoteClusters: { ...cfg.topology.remoteClusters, [PROBE]: (cfg.topology.remoteClusters[c.env] ?? 1) * 3 + 1 } },
    overrides: { ...cfg.overrides, [PROBE]: cfg.overrides[c.env] ?? {} },
    limits: { ...(cfg.limits ?? {}), [PROBE]: cfg.limits?.[c.env] ?? {} },
  };
  return { ...c, name: `${c.name}-${PROBE}`, env: PROBE, dir: PROBE, serves: [PROBE], cfg: pc };
}
