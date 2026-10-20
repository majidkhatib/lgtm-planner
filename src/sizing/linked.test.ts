import { describe, expect, it } from "vitest";
import { defaultConfig, resolvedConfig } from "../model/defaults";
import { sizeComponent } from "./engine";

const base = () => {
  const c = defaultConfig();
  c.volumes.prod.metrics.knowsActiveSeries = true;
  c.volumes.prod.metrics.activeSeries = 10_000_000;
  return c;
};
const ingester = (c: ReturnType<typeof defaultConfig>) => sizeComponent(resolvedConfig(c), "mimir", "prod", false).find((w) => w.def.id === "ingester")!;

describe("sizing values", () => {
  it("memory and disk are powers of two", () => {
    for (const w of sizeComponent(resolvedConfig(base()), "mimir", "prod", false)) {
      expect(Math.log2(w.final.memoryGi * 4) % 1).toBe(0);
      if (w.final.pvcGi) expect(Math.log2(w.final.pvcGi) % 1).toBe(0);
    }
  });
  it("lower CPU per pod → more replicas, same total", () => {
    const c = base();
    const before = ingester(c);
    c.overrides = { prod: { "mimir.ingester": { cpu: before.final.cpu / 2 } } };
    const after = ingester(c);
    expect(after.final.replicas).toBeGreaterThan(before.final.replicas);
    expect(after.final.replicas % 3).toBe(0); // zone-aware: multiple of 3 zones
    expect(after.adjusted).toContain("replicas");
  });
  it("more replicas → smaller pods", () => {
    const c = base();
    const before = ingester(c);
    c.overrides = { prod: { "mimir.ingester": { replicas: before.final.replicas * 2 } } };
    const after = ingester(c);
    expect(after.final.memoryGi).toBeLessThan(before.final.memoryGi);
  });
});
