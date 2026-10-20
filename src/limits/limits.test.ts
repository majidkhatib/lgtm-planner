import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generateRepository } from "../generate/index";
import { mergeValues } from "../generate/split";
import { defaultConfig, resolvedConfig } from "../model/defaults";
import type { PlannerConfig } from "../model/types";
import { limitRows, nestKeys } from "./limits";

function cfg(fn: (c: PlannerConfig) => void = () => {}): PlannerConfig {
  const c = defaultConfig();
  c.signals = { ...c.signals, metrics: true, logs: true, traces: true, profiles: true };
  fn(c);
  return resolvedConfig(c);
}

/** Values as Helm sees them: helm/base first, then the cluster overlay. */
function values(c: PlannerConfig, suffix: string): Record<string, any> {
  const files = generateRepository(c);
  const f = files.find((x) => x.path.startsWith("helm/central/prod/") && x.path.endsWith(suffix));
  if (!f) throw new Error(`no file ${suffix}`);
  const base = files.find((x) => x.path === `helm/base${suffix}`);
  return mergeValues(base ? parse(base.content) ?? {} : {}, parse(f.content) ?? {}) as Record<string, any>;
}

describe("tenant limits", () => {
  it("are calculated from the volumes and never below the backend defaults", () => {
    const c = cfg();
    const series = limitRows(c, "mimir", "prod").find((r) => r.def.key === "max_global_series_per_user")!;
    expect(typeof series.value).toBe("number");
    expect(series.value as number).toBeGreaterThanOrEqual(150000);
    expect(series.edited).toBe(false);
  });

  it("are written to the Mimir, Loki, Tempo and Pyroscope values", () => {
    const c = cfg();
    const mimir = values(c, "/mimir/values.yaml");
    expect(mimir.mimir.structuredConfig.limits.max_global_series_per_user).toBeGreaterThan(0);
    expect(mimir.mimir.structuredConfig.limits.ingestion_rate).toBeGreaterThan(0);
    expect(values(c, "/loki/values.yaml").loki.limits_config.ingestion_rate_mb).toBeGreaterThan(0);
    const tempo = values(c, "/tempo/values.yaml");
    expect((tempo.tempo ?? tempo).overrides.defaults.ingestion.rate_limit_bytes).toBeGreaterThan(0);
    expect(values(c, "/pyroscope/values.yaml").pyroscope.structuredConfig.limits.ingestion_rate_mb).toBeGreaterThan(0);
  });

  it("user edits and per-tenant overrides reach the runtime configuration", () => {
    const c = cfg((x) => {
      x.limits = {
        prod: {
          mimir: { defaults: { max_global_series_per_user: 123456 }, tenants: { "team-a": { max_global_series_per_user: 999999 } } },
          tempo: { tenants: { "team-a": { "ingestion.rate_limit_bytes": 1 } } },
        },
      };
    });
    const mimir = values(c, "/mimir/values.yaml");
    expect(mimir.mimir.structuredConfig.limits.max_global_series_per_user).toBe(123456);
    expect(mimir.runtimeConfig.overrides["team-a"].max_global_series_per_user).toBe(999999);
    const tempo = values(c, "/tempo/values.yaml");
    const t = (tempo.tempo ?? tempo).per_tenant_overrides["team-a"];
    expect(t.ingestion.rate_limit_bytes).toBe(1);
    // Tempo needs complete blocks per tenant
    expect(t.ingestion.burst_size_bytes).toBeGreaterThan(0);
  });

  it("nests dotted keys for Tempo", () => {
    expect(nestKeys({ "a.b": 1, "a.c": "x", d: true })).toEqual({ a: { b: 1, c: "x" }, d: true });
  });
});
