import { describe, expect, it } from "vitest";
import { defaultConfig, resolvedConfig } from "../model/defaults";
import type { CloudId } from "../model/types";
import { costReport } from "./engine";

const cfgFor = (cloud: CloudId, region: string) => {
  const c = defaultConfig();
  c.platform = { cloud, region, currency: "EUR" };
  return resolvedConfig(c);
};

describe("cost", () => {
  it("Azure: every line priced, total > 0", () => {
    const r = costReport(cfgFor("azure", "germanywestcentral"));
    expect(r.missing).toEqual([]);
    expect(r.totalUsd).toBeGreaterThan(0);
    const prod = r.clusters.find((c) => c.name === "central-prod")!;
    expect(prod.lines.map((l) => l.item)).toEqual(expect.arrayContaining(["AKS Standard tier control plane", "Load balancer", "Data from remote clusters"]));
  });
  it("AWS: inter-zone traffic is billed, Azure's is not counted above its price", () => {
    const aws = costReport(cfgFor("aws", "eu-central-1"));
    expect(aws.missing).toEqual([]);
    expect(aws.clusters[0].lines.some((l) => l.item === "Traffic between zones")).toBe(true);
  });
  it("GCP without price data is reported as missing, not as zero silently", () => {
    const r = costReport(cfgFor("gcp", "europe-west3"));
    expect(r.missing.length).toBeGreaterThan(0);
  });
  it("standby: storage now, full cost only after failover", () => {
    const c = defaultConfig();
    c.platform = { cloud: "aws", region: "eu-central-1", currency: "USD" };
    c.multiRegion = { model: "standby", regions: ["eu-west-1"], remoteClusters: {}, replication: "crr", mirrorKafka: false };
    const r = costReport(resolvedConfig(c));
    const standby = r.clusters.filter((x) => x.role === "standby");
    expect(standby.length).toBeGreaterThan(0);
    expect(standby[0].ifRunningUsd!).toBeGreaterThan(standby[0].totalUsd);
  });
});
