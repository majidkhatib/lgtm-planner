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

// The whole configuration lives in the URL hash (#c=...), compressed.
// Nothing is sent to a server: the hash never leaves the browser.

const HASH_KEY = "c";
const STORAGE_KEY = "lgtm-planner:config";

export function encodeConfig(cfg: PlannerConfig): string {
  return compressToEncodedURIComponent(JSON.stringify(cfg));
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
  const encoded = encodeConfig(cfg);
  history.replaceState(null, "", `${location.pathname}${location.search}#${HASH_KEY}=${encoded}`);
  try {
    localStorage.setItem(STORAGE_KEY, encoded);
  } catch {
    /* storage unavailable */
  }
}

export function shareUrl(cfg: PlannerConfig): string {
  return `${location.origin}${location.pathname}#${HASH_KEY}=${encodeConfig(cfg)}`;
}

export function clearSaved(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
