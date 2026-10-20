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
const river = (c: PlannerConfig): string => parse(beylaFile(c)!.content).alloy.configMap.content;
const on = (opts: Record<string, string | boolean> = {}, fn: (c: PlannerConfig) => void = () => {}) =>
  cfg((x) => {
    x.components.beyla.enabled = true;
    Object.assign(x.components.beyla.options, opts);
    fn(x);
  });

describe("Beyla", () => {
  it("is optional and off by default", () => {
    const c = cfg();
    expect(c.components.beyla.enabled).toBe(false);
    expect(beylaFile(c)).toBeUndefined();
  });

  it("generates an Alloy DaemonSet with beyla.ebpf, metrics to Mimir and traces via the local collector", () => {
    const c = on();
    const v = parse(beylaFile(c)!.content);
    expect(v.controller).toMatchObject({ type: "daemonset", hostPID: true });
    expect(v.alloy.securityContext.capabilities.add).toContain("BPF");
    expect(v.alloy.securityContext.privileged).toBe(false);
    const r = river(c);
    expect(r).toContain('beyla.ebpf "default"');
    expect(r).toContain("prometheus.remote_write");
    expect(r).toContain("trace-collector.ns-monitoring.svc:4317");
    expect(r).toMatch(/exclude_instrument \{\s+kubernetes \{\s+namespace = "\{kube-system,[^"]*ns-monitoring[^"]*\}"/);
  });

  it("defaults keep Mimir and Tempo small: route grouping, no health checks, HTTP/gRPC spans only", () => {
    const r = river(on());
    expect(r).toContain('unmatched = "heuristic"');
    expect(r).toContain('"/healthz"');
    expect(r).toContain('ignore_mode      = "all"');
    expect(r).toMatch(/traces \{\s+instrumentations = \["http", "grpc"\]/);
    expect(r).toMatch(/metrics \{[^}]*instrumentations = \["\*"\]/);
  });

  it("sends traces straight to Tempo without a local collector, and only instruments chosen namespaces", () => {
    const r = river(on({ scope: "namespaces", namespaces: "shop, payments" }, (x) => (x.components["trace-collector"].enabled = false)));
    expect(r).toContain("otelcol.exporter.otlphttp");
    expect(r).toContain('namespace = "shop"');
    expect(r).toContain('namespace = "payments"');
    expect(r).not.toContain('namespace = "*"');
  });

  it("metrics only: the required output block has no traces; adds series to the Mimir sizing", () => {
    const off = cfg();
    const c = on({ exports: "metrics" });
    const r = river(c);
    expect(r).toMatch(/output \{\s+\}/);
    expect(r).not.toMatch(/traces \{\s+instrumentations/);
    expect(deriveInputs(c, "prod").beylaSeries).toBeGreaterThan(0);
    expect(deriveInputs(c, "prod").activeSeries).toBeGreaterThan(deriveInputs(off, "prod").activeSeries);
  });

  it("advanced options: opt-in label, own routes, all protocols, process metrics", () => {
    const base = on();
    const c = on({
      scope: "label",
      optInLabel: "team.io/observe=yes",
      routes: "wildcard",
      routePatterns: "/api/orders/{id}",
      ignoreHealth: false,
      ignoredPaths: "/favicon.ico",
      traceProtocols: "all",
      metricProtocols: "http-grpc",
      processMetrics: true,
    });
    const r = river(c);
    expect(r).toContain('pod_labels = { "team.io/observe" = "yes" }');
    expect(r).toContain('unmatched = "wildcard"');
    expect(r).toContain('patterns  = ["/api/orders/{id}"]');
    expect(r).toContain('ignored_patterns = ["/favicon.ico"]');
    expect(r).not.toContain('"/healthz"');
    expect(r).toMatch(/traces \{\s+instrumentations = \["\*"\]/);
    expect(r).toMatch(/metrics \{[^}]*instrumentations = \["http", "grpc"\]/);
    expect(r).toContain('"application_process"');
    expect(deriveInputs(c, "prod").beylaSeries).toBeGreaterThan(deriveInputs(base, "prod").beylaSeries);
  });

  it("full paths without grouping multiply the series estimate", () => {
    expect(deriveInputs(on({ routes: "path" }), "prod").beylaSeries).toBe(deriveInputs(on(), "prod").beylaSeries * 10);
  });
});
