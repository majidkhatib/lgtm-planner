import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultConfig, resolvedConfig } from "../../model/defaults";
import type { PlannerConfig } from "../../model/types";
import { generateRepository } from "../index";

// Generates the repository for a matrix of configurations and checks that every YAML file parses.
function variant(fn: (c: PlannerConfig) => void): PlannerConfig {
  const c = defaultConfig();
  fn(c);
  return resolvedConfig(c);
}

const VARIANTS: Record<string, PlannerConfig> = {
  "azure-argocd-default": variant(() => {}),
  "aws-flux-shared": variant((c) => {
    c.platform = { cloud: "aws", region: "eu-central-1", currency: "USD" };
    c.delivery.method = "flux";
    c.topology.centralModel = "shared";
  }),
  "gcp-github-all-signals": variant((c) => {
    c.platform = { cloud: "gcp", region: "europe-west3", currency: "EUR" };
    c.delivery.method = "github-actions";
    c.signals = { metrics: true, logs: true, traces: true, profiles: true, ai: true };
    c.components.robusta.enabled = true;
    c.components["cloud-logs"].enabled = true;
    c.connectivity.auth = "mtls";
    c.connectivity.ingress = "haproxy";
  }),
  "azure-devops-no-kafka-monolithic": variant((c) => {
    c.delivery.method = "azure-devops";
    c.components.kafka.enabled = false;
    c.components.loki.options.mode = "monolithic";
    c.environments = ["prod"];
    c.topology.remoteClusters = { prod: 2 };
    c.volumes = { prod: c.volumes.prod };
  }),
  "gitlab-strimzi-otel": variant((c) => {
    c.delivery.method = "gitlab-ci";
    c.components.kafka.options.provider = "strimzi";
    c.components["trace-collector"].options.collector = "otel";
    c.components.prometheus.options.collector = "alloy";
    c.connectivity.secrets = "csi";
    c.connectivity.tls = "edge-managed";
  }),
};

describe("repository generator", () => {
  for (const [name, cfg] of Object.entries(VARIANTS)) {
    it(`${name}: every YAML file parses`, () => {
      const files = generateRepository(cfg);
      expect(files.length).toBeGreaterThan(10);
      for (const f of files.filter((x) => /\.ya?ml$/.test(x.path))) {
        for (const doc of parseAllDocuments(f.content)) {
          expect(doc.errors.map((e) => `${f.path}: ${e.message}`)).toEqual([]);
        }
      }
      expect(files.some((f) => f.path === "README.md")).toBe(true);
      expect(files.some((f) => f.path === "docs/architecture.svg")).toBe(true);
    });
  }
});
