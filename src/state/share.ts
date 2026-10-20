import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { defaultConfig, defaultVolumes } from "../model/defaults";
import type { PlannerConfig } from "../model/types";

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Values from `override` win; nested objects are merged; arrays are replaced. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

// Work in progress is saved in the browser (localStorage), so the address bar stays clean.
// Share links put the configuration in the URL hash (#c=...): only what differs from the
// defaults, compressed. Nothing is sent to a server: the hash never leaves the browser.

const HASH_KEY = "c";
const STORAGE_KEY = "lgtm-planner:config";

export function encodeConfig(cfg: PlannerConfig): string {
  return compressToEncodedURIComponent(JSON.stringify(cfg));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only the values that differ from `base` (arrays are kept whole when they differ). */
function diff(base: unknown, value: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(value)) return same(base, value) ? undefined : value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const d = diff(base[k], v);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Short form for share links: the changes against the defaults that decodeConfig merges onto. */
export function encodeShare(cfg: PlannerConfig): string {
  const base = defaultConfig();
  for (const env of cfg.environments) base.volumes[env] ??= defaultVolumes(env);
  const changes = (diff(base, cfg) ?? {}) as Record<string, unknown>;
  return compressToEncodedURIComponent(JSON.stringify({ ...changes, schema: 1 }));
}

export function decodeConfig(encoded: string): PlannerConfig | null {
  try {
    const json = decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json) as Partial<PlannerConfig>;
    if (parsed.schema !== 1) return null;
    // Merge onto defaults so links created by older versions still load (new fields get their defaults).
    const base = defaultConfig();
    const merged = deepMerge(base, parsed) as PlannerConfig;
    for (const env of merged.environments) {
      merged.volumes[env] = deepMerge(defaultVolumes(env), merged.volumes[env] ?? {}) as PlannerConfig["volumes"][string];
    }
    return merged;
  } catch {
    return null;
  }
}

export function loadInitialConfig(): PlannerConfig {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get(HASH_KEY);
  if (fromHash) {
    // A shared link: load it, then clean the address bar (the config is saved in the browser from now on).
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    const cfg = decodeConfig(fromHash);
    if (cfg) return cfg;
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const cfg = decodeConfig(saved);
      if (cfg) return cfg;
    }
  } catch {
    /* storage unavailable */
  }
  return defaultConfig();
}

export function persistConfig(cfg: PlannerConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, encodeConfig(cfg));
  } catch {
    /* storage unavailable */
  }
}

export function shareUrl(cfg: PlannerConfig): string {
  return `${location.origin}${location.pathname}#${HASH_KEY}=${encodeShare(cfg)}`;
}

export function clearSaved(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
