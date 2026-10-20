import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { defaultConfig, resolvedConfig } from "../../model/defaults";
import { generateRepository } from "../index";
import { commonValues, mergeValues, valuesDiff } from "../split";

describe("base / overlay split", () => {
  it("base + overlay gives back each cluster's values", () => {
    const a = { x: 1, m: { shared: "s", size: 10 }, list: [1, 2], only: true };
    const b = { x: 1, m: { shared: "s", size: 20 }, list: [1, 2] };
    const base = commonValues([a, b]);
    expect(base).toEqual({ x: 1, m: { shared: "s" }, list: [1, 2] });
    expect(mergeValues(base, valuesDiff(a, base))).toEqual(a);
    expect(mergeValues(base, valuesDiff(b, base))).toEqual(b);
  });

  it("environment-independent settings are in base; names and sizes stay in the cluster files", () => {
    const c = defaultConfig();
    c.environments = ["prod"]; // a single environment: the probe still keeps env-specific values out of base
    c.topology.remoteClusters = { prod: 2 };
    c.volumes = { prod: c.volumes.prod };
    const files = generateRepository(resolvedConfig(c));
    const get = (p: string) => parse(files.find((f) => f.path === p)!.content);
    const base = get("helm/base/loki/values.yaml");
    const prod = get("helm/central/prod/loki/values.yaml");
    expect(base.loki.auth_enabled).toBe(true);
    expect(base.loki.storage.type).toBeDefined();
    expect(prod.loki?.auth_enabled).toBeUndefined();
    // bucket/container names and retention depend on the environment
    expect(JSON.stringify(base)).not.toContain("prod");
    expect(prod.loki.limits_config.retention_period).toBeDefined();
  });
});
