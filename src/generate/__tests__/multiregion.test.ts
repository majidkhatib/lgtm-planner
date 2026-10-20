import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultConfig, resolvedConfig } from "../../model/defaults";
import type { CloudId, PlannerConfig, RegionModel } from "../../model/types";
import { centralClusters, remoteClusters } from "../common";
import { generateRepository } from "../index";

const REGIONS: Record<CloudId, [string, string]> = { azure: ["westeurope", "swedencentral"], aws: ["eu-central-1", "eu-west-1"], gcp: ["europe-west3", "europe-west1"] };

function cfgFor(cloud: CloudId, model: RegionModel, fn: (c: PlannerConfig) => void = () => {}): PlannerConfig {
  const c = defaultConfig();
  c.platform = { cloud, region: REGIONS[cloud][0], currency: "EUR" };
  c.multiRegion = { model, regions: [REGIONS[cloud][1]], remoteClusters: { [REGIONS[cloud][1]]: { prod: 2 } }, replication: cloud === "aws" ? "crr" : cloud === "gcp" ? "dual-region" : "object", mirrorKafka: false };
  fn(c);
  return resolvedConfig(c);
}

const parses = (cfg: PlannerConfig) => {
  for (const f of generateRepository(cfg).filter((x) => /\.ya?ml$/.test(x.path)))
    for (const d of parseAllDocuments(f.content)) expect(d.errors.map((e) => `${f.path}: ${e.message}`)).toEqual([]);
};

describe("multi-region", () => {
  for (const cloud of ["azure", "aws", "gcp"] as CloudId[]) {
    for (const model of ["regional", "standby", "active-active"] as RegionModel[]) {
      it(`${cloud} ${model}: generates and every YAML parses`, () => parses(cfgFor(cloud, model)));
    }
  }

  it("standby: second stack is a standby with no remote clusters", () => {
    const central = centralClusters(cfgFor("aws", "standby"));
    const standby = central.filter((c) => c.role === "standby");
    expect(standby.length).toBe(3); // one per environment
    expect(standby.every((c) => c.serves.length === 0 && c.region === "eu-west-1")).toBe(true);
  });

  it("standby on AWS: replication to replica buckets in the second region", () => {
    const files = generateRepository(cfgFor("aws", "standby"));
    const tf = files.find((f) => f.path === "terraform/central-prod-euc1/main.tf")!.content;
    expect(tf).toContain("aws_s3_bucket_replication_configuration");
    expect(tf).toContain("-prod-euw1-mimir-blocks");
    const standbyValues = files.find((f) => f.path === "helm/central/prod/euw1/mimir/values.yaml")!.content;
    expect(standbyValues).toContain("-prod-euw1-mimir-blocks"); // standby reads the replica
  });

  it("standby on GCP: dual-region bucket, standby reads the same bucket", () => {
    const files = generateRepository(cfgFor("gcp", "standby"));
    expect(files.find((f) => f.path === "terraform/central-prod-ew3/main.tf")!.content).toContain("custom_placement_config");
    expect(files.find((f) => f.path === "helm/central/prod/ew1/mimir/values.yaml")!.content).toContain("-prod-ew3-mimir-blocks");
  });

  it("active-active: collectors write to both regions", () => {
    const files = generateRepository(cfgFor("azure", "active-active"));
    const logs = files.find((f) => f.path === "helm/remote/prod/alloy-logs/values.yaml")!.content;
    expect(logs).toContain("loki.weu.");
    expect(logs).toContain("loki.sec.");
  });

  it("regional: remote clusters belong to their region and write there", () => {
    const cfg = cfgFor("azure", "regional");
    expect(remoteClusters(cfg).filter((r) => r.region === "swedencentral").map((r) => r.name)).toEqual(["prod-sec-workload-1", "prod-sec-workload-2"]);
    const files = generateRepository(cfg);
    expect(files.find((f) => f.path === "helm/remote/prod/sec/alloy-logs/values.yaml")!.content).toContain("loki.sec.");
  });
});
