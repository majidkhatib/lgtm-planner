import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { defaultConfig, resolvedConfig } from "../../model/defaults";
import type { PlannerConfig } from "../../model/types";
import { deriveInputs } from "../../sizing/inputs";
import { generateRepository } from "../index";

function cfg(fn: (c: PlannerConfig) => void = () => {}): PlannerConfig {
  const c = defaultConfig();
  c.signals = { ...c.signals, metrics: true, traces: true };
  fn(c);
  return resolvedConfig(c);
}
const beylaFile = (c: PlannerConfig) => generateRepository(c).find((f) => f.path.startsWith("helm/remote/") && f.path.endsWith("/beyla/values.yaml"));

describe("Beyla", () => {
  it("is optional and off by default", () => {
    const c = cfg();
    expect(c.components.beyla.enabled).toBe(false);
    expect(beylaFile(c)).toBeUndefined();
  });

  it("generates an Alloy DaemonSet with beyla.ebpf, metrics to Mimir and traces via the local collector", () => {
    const c = cfg((x) => (x.components.beyla.enabled = true));
    const v = parse(beylaFile(c)!.content);
    expect(v.controller).toMatchObject({ type: "daemonset", hostPID: true });
    expect(v.alloy.securityContext.capabilities.add).toContain("BPF");
    expect(v.alloy.securityContext.privileged).toBe(false);
    const river: string = v.alloy.configMap.content;
    expect(river).toContain('beyla.ebpf "default"');
    expect(river).toContain("prometheus.remote_write");
    expect(river).toContain("trace-collector.ns-monitoring.svc:4317");
    expect(river).toContain('namespace = "kube-system"');
  });

  it("sends traces straight to Tempo without a local collector, and only instruments chosen namespaces", () => {
    const c = cfg((x) => {
      x.components.beyla.enabled = true;
      x.components.beyla.options.scope = "namespaces";
      x.components.beyla.options.namespaces = "shop, payments";
      x.components["trace-collector"].enabled = false;
    });
    const river: string = parse(beylaFile(c)!.content).alloy.configMap.content;
    expect(river).toContain("otelcol.exporter.otlphttp");
    expect(river).toContain('namespace = "shop"');
    expect(river).toContain('namespace = "payments"');
    expect(river).not.toContain('namespace = "*"');
  });

  it("metrics only: no trace output; adds series to the Mimir sizing", () => {
    const off = cfg();
    const on = cfg((x) => {
      x.components.beyla.enabled = true;
      x.components.beyla.options.exports = "metrics";
    });
    const river: string = parse(beylaFile(on)!.content).alloy.configMap.content;
    expect(river).not.toContain("output {");
    expect(deriveInputs(on, "prod").beylaSeries).toBeGreaterThan(0);
    expect(deriveInputs(on, "prod").activeSeries).toBeGreaterThan(deriveInputs(off, "prod").activeSeries);
  });
});
