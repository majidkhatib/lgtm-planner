#!/usr/bin/env node
// Fetches the cloud prices the cost estimate needs and writes src/data/prices.json.
// Run monthly (GitHub Actions) or by hand:  node scripts/fetch-prices.mjs
//
// Sources (all list prices, USD, on-demand, Linux):
//   Azure: Retail Prices API (public, no login)          https://prices.azure.com/api/retail/prices
//   AWS:   Price List Query API via the AWS CLI           aws pricing get-products   (needs AWS credentials; pricing:GetProducts)
//   GCP:   Cloud Billing Catalog API                      needs GCP_API_KEY (skipped when not set)
//   EUR:   European Central Bank reference rate           https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "data", "prices.json");
const AWS = process.env.AWS_CLI || "aws";
const HOURS = 730;

// VM types and storage classes the planner can generate (keep in sync with src/generate/nodepools.ts and src/catalog/storage.ts)
const VMS = {
  azure: ["Standard_D4s_v5", "Standard_D8s_v5", "Standard_D16s_v5", "Standard_E8s_v5", "Standard_E16s_v5"],
  aws: ["m7i.xlarge", "m7i.2xlarge", "m7i.4xlarge", "r7i.2xlarge", "r7i.4xlarge"],
  gcp: { "n2-standard-4": [4, 16], "n2-standard-8": [8, 32], "n2-standard-16": [16, 64], "n2-highmem-8": [8, 64], "n2-highmem-16": [16, 128] },
};
const AZ_TIER_SIZES = { 1: 4, 2: 8, 3: 16, 4: 32, 6: 64, 10: 128, 15: 256, 20: 512, 30: 1024, 40: 2048, 50: 4096, 60: 8192, 70: 16384, 80: 32767 };

const log = (...a) => console.error(...a);
const prices = { fetchedAt: new Date().toISOString().slice(0, 10), eurPerUsd: null, sources: {}, azure: {}, aws: {}, gcp: {} };
const region = (cloud, r) => (prices[cloud][r] ??= { vm: {}, disks: {}, objectStorage: {}, transfer: {}, lb: {}, postgres: {}, kafka: {} });

// ------------------------------------------------------------------ EUR rate
async function ecb() {
  const xml = await (await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml")).text();
  const usd = Number(/currency='USD' rate='([\d.]+)'/.exec(xml)?.[1]);
  prices.eurPerUsd = Math.round((1 / usd) * 10000) / 10000;
  prices.sources.eur = `ECB reference rate ${/time='([\d-]+)'/.exec(xml)?.[1]}: 1 EUR = ${usd} USD`;
}

// ------------------------------------------------------------------ Azure
async function azureQuery(filter) {
  let url = "https://prices.azure.com/api/retail/prices?$filter=" + encodeURIComponent(filter);
  const items = [];
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Azure prices ${res.status}`);
    const d = await res.json();
    items.push(...d.Items);
    url = d.NextPageLink;
  }
  return items.filter((i) => i.type === "Consumption" && i.armRegionName && !/gov|china|euap/i.test(i.armRegionName));
}

const firstTier = (items) => items.filter((i) => !i.tierMinimumUnits).sort((a, b) => b.retailPrice - a.retailPrice)[0];

async function azure() {
  for (const sku of VMS.azure) {
    for (const i of await azureQuery(`serviceName eq 'Virtual Machines' and armSkuName eq '${sku}' and priceType eq 'Consumption'`)) {
      if (/Windows/.test(i.productName) || /Spot|Low Priority/.test(i.skuName)) continue;
      region("azure", i.armRegionName).vm[sku] = i.retailPrice;
    }
  }
  // AKS Standard tier (uptime SLA)
  for (const i of await azureQuery("serviceName eq 'Azure Kubernetes Service' and skuName eq 'Standard' and meterName eq 'Standard Uptime SLA'"))
    region("azure", i.armRegionName).controlPlaneHour = i.retailPrice;

  // Managed disks: tier prices per month (P = Premium SSD, E = Standard SSD, S = Standard HDD)
  const tiers = async (product, letter, redundancy, cls) => {
    for (const i of await azureQuery(`serviceName eq 'Storage' and productName eq '${product}' and priceType eq 'Consumption'`)) {
      const m = new RegExp(`^${letter}(\\d+) ${redundancy} Disk$`).exec(i.meterName);
      if (!m || !AZ_TIER_SIZES[m[1]]) continue;
      const d = (region("azure", i.armRegionName).disks[cls] ??= { tiers: [] });
      d.tiers.push([AZ_TIER_SIZES[m[1]], i.retailPrice]);
    }
  };
  await tiers("Premium SSD Managed Disks", "P", "LRS", "managed-csi-premium");
  await tiers("Premium SSD Managed Disks", "P", "ZRS", "managed-csi-premium-zrs");
  await tiers("Standard SSD Managed Disks", "E", "LRS", "managed-csi");
  await tiers("Standard SSD Managed Disks", "E", "ZRS", "managed-csi-standard-zrs");
  await tiers("Standard HDD Managed Disks", "S", "LRS", "managed-csi-hdd");
  for (const i of await azureQuery("serviceName eq 'Storage' and productName eq 'Azure Premium SSD v2' and skuName eq 'Premium LRS' and meterName eq 'Premium LRS Provisioned Capacity'"))
    region("azure", i.armRegionName).disks["premium-ssd-v2"] = { perGb: Math.round(i.retailPrice * HOURS * 10000) / 10000 };

  // Blob storage (Hot): per GB-month (first tier) and operations per 10,000
  for (const [sku, key] of [["Hot LRS", "lrs"], ["Hot ZRS", "zrs"], ["Hot RA-GZRS", "ragzrs"], ["Hot RA-GRS", "ragrs"]]) {
    const byRegion = {};
    for (const i of await azureQuery(`serviceName eq 'Storage' and productName eq 'General Block Blob v2' and skuName eq '${sku}'`)) (byRegion[i.armRegionName] ??= []).push(i);
    for (const [r, items] of Object.entries(byRegion)) {
      const stored = firstTier(items.filter((i) => /Data Stored$/.test(i.meterName)));
      // RA-GZRS bills writes under "List and Create Container Operations"
      const write = items.find((i) => /Write Operations$/.test(i.meterName)) ?? items.find((i) => /List and Create Container Operations$/.test(i.meterName));
      const read = items.find((i) => /Read Operations$/.test(i.meterName));
      if (!stored) continue;
      region("azure", r).objectStorage[key] = { perGbMonth: stored.retailPrice, putPer1k: (write?.retailPrice ?? 0) / 10, getPer1k: (read?.retailPrice ?? 0) / 10 };
    }
  }
  for (const i of await azureQuery("serviceName eq 'Storage' and skuName eq 'Geo-Replication v2' and meterName eq 'Geo-Replication v2 Data Transfer'"))
    region("azure", i.armRegionName).transfer.geoReplication = i.retailPrice;

  // Standard Load Balancer (global meters: same price in every region)
  const lb = await azureQuery("serviceName eq 'Load Balancer' and skuName eq 'Standard'");
  const lbHour = lb.find((i) => /Included LB Rules/.test(i.meterName))?.retailPrice ?? 0.025;
  const lbGb = lb.find((i) => i.meterName === "Standard Data Processed")?.retailPrice ?? 0.005;

  // Bandwidth: internet egress (first paid tier), inter-region, inter-zone
  const bw = await azureQuery("serviceName eq 'Bandwidth' and priceType eq 'Consumption'");
  for (const i of bw) {
    if (i.productName.startsWith("Bandwidth - Routing Preference: Internet") && i.meterName === "Standard Data Transfer Out" && i.tierMinimumUnits === 100)
      region("azure", i.armRegionName).transfer.internet = i.retailPrice;
    if (/Inter-Region Data Transfer/.test(i.meterName)) region("azure", i.armRegionName).transfer.interRegion = i.retailPrice;
    if (/Inter-Availability Zone/.test(i.meterName)) region("azure", i.armRegionName).transfer.interZone = i.retailPrice;
  }

  // PostgreSQL Flexible Server: Burstable B2s, General Purpose D2ds v5, storage
  for (const i of await azureQuery("serviceName eq 'Azure Database for PostgreSQL' and priceType eq 'Consumption'")) {
    const p = region("azure", i.armRegionName).postgres;
    if (/Flexible Server Burstable BS Series Compute/.test(i.productName) && /^B2s$/i.test(i.meterName)) p.burstable = i.retailPrice;
    if (/Flexible Server General Purpose Ddsv5 Series Compute/.test(i.productName) && i.skuName === "2 vCore") p.general = i.retailPrice;
    if (/Flex Server Storage/.test(i.productName) && i.meterName === "Storage Data Stored") p.storagePerGbMonth = i.retailPrice;
  }
  // Event Hubs Premium (Kafka endpoint): per processing unit hour
  for (const i of await azureQuery("serviceName eq 'Event Hubs' and skuName eq 'Premium' and meterName eq 'Premium Processing Unit'"))
    region("azure", i.armRegionName).kafka = { unitHour: i.retailPrice, unit: "processing unit", mbPerUnit: 5 };

  for (const r of Object.keys(prices.azure)) {
    const x = prices.azure[r];
    x.lb = { hour: lbHour, perGb: lbGb };
    x.transfer.interZone ??= 0;
    for (const d of Object.values(x.disks)) d.tiers?.sort((a, b) => a[0] - b[0]);
  }
  prices.sources.azure = "Azure Retail Prices API (pay-as-you-go list prices, USD)";
}

// ------------------------------------------------------------------ AWS
function awsQuery(service, filters) {
  const items = [];
  let token;
  do {
    const args = ["pricing", "get-products", "--region", "us-east-1", "--service-code", service, "--output", "json", "--filters", ...filters.map(([k, v]) => `Type=TERM_MATCH,Field=${k},Value=${v}`)];
    if (token) args.push("--next-token", token);
    const res = JSON.parse(execFileSync(AWS, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    for (const pl of res.PriceList ?? []) items.push(JSON.parse(pl));
    token = res.NextToken;
  } while (token);
  return items;
}

/** On-demand price of a product; `pick` chooses among tiered price dimensions. */
function onDemand(p, pick = (dims) => dims[0]) {
  const dims = Object.values(p.terms?.OnDemand ?? {}).flatMap((t) => Object.values(t.priceDimensions));
  const d = pick(dims);
  return d ? Number(d.pricePerUnit.USD) : undefined;
}

function aws() {
  const byRegion = (items, fn) => items.forEach((p) => p.product.attributes.regionCode && fn(region("aws", p.product.attributes.regionCode), p));
  for (const type of VMS.aws)
    byRegion(awsQuery("AmazonEC2", [["instanceType", type], ["operatingSystem", "Linux"], ["tenancy", "Shared"], ["preInstalledSw", "NA"], ["capacitystatus", "Used"]]), (x, p) => (x.vm[type] = onDemand(p)));
  byRegion(awsQuery("AmazonEKS", [["operation", "CreateOperation"]]), (x, p) => {
    if (/perCluster/.test(p.product.attributes.usagetype) && !/ExtendedSupport/.test(p.product.attributes.usagetype)) x.controlPlaneHour = onDemand(p);
  });
  for (const vol of ["gp3", "gp2", "io1", "io2", "st1", "sc1"])
    byRegion(awsQuery("AmazonEC2", [["volumeApiName", vol], ["productFamily", "Storage"]]), (x, p) => (x.disks[vol] = { perGb: onDemand(p) }));
  byRegion(awsQuery("AmazonS3", [["volumeType", "Standard"], ["productFamily", "Storage"]]), (x, p) => {
    x.objectStorage.standard ??= {};
    x.objectStorage.standard.perGbMonth = onDemand(p, (dims) => dims.find((d) => d.beginRange === "0"));
  });
  byRegion(awsQuery("AmazonS3", [["group", "S3-API-Tier1"]]), (x, p) => {
    if (!/Annotation/.test(p.product.attributes.usagetype)) (x.objectStorage.standard ??= {}).putPer1k = onDemand(p) * 1000;
  });
  byRegion(awsQuery("AmazonS3", [["group", "S3-API-Tier2"]]), (x, p) => {
    if (!/Annotation/.test(p.product.attributes.usagetype)) (x.objectStorage.standard ??= {}).getPer1k = onDemand(p) * 1000;
  });
  byRegion(awsQuery("AWSELB", [["productFamily", "Load Balancer-Network"]]), (x, p) => {
    const ut = p.product.attributes.usagetype;
    if (/LoadBalancerUsage$/.test(ut)) x.lb.hour = onDemand(p);
    if (/LCUUsage$/.test(ut) && !/Reserved/.test(ut)) x.lb.lcuHour = onDemand(p);
  });
  for (const p of awsQuery("AWSDataTransfer", [["transferType", "IntraRegion"]])) {
    const r = p.product.attributes.fromRegionCode;
    if (r) region("aws", r).transfer.interZone = onDemand(p);
  }
  for (const p of awsQuery("AWSDataTransfer", [["transferType", "AWS Outbound"]])) {
    const r = p.product.attributes.fromRegionCode;
    if (r) region("aws", r).transfer.internet = onDemand(p, (dims) => dims.find((d) => d.beginRange === "0") ?? dims[0]);
  }
  for (const p of awsQuery("AWSDataTransfer", [["transferType", "InterRegion Outbound"]])) {
    const r = p.product.attributes.fromRegionCode;
    // Cheapest destination = same-continent regions (what a standby region usually is)
    const v = onDemand(p);
    if (r && v) region("aws", r).transfer.interRegion = Math.min(region("aws", r).transfer.interRegion ?? Infinity, v);
  }
  for (const [type, key] of [["db.t4g.medium", "burstable"], ["db.m7g.large", "general"]])
    byRegion(awsQuery("AmazonRDS", [["instanceType", type], ["databaseEngine", "PostgreSQL"], ["deploymentOption", "Single-AZ"]]), (x, p) => (x.postgres[key] = onDemand(p)));
  byRegion(awsQuery("AmazonRDS", [["productFamily", "Database Storage"], ["volumeType", "General Purpose-GP3"], ["deploymentOption", "Single-AZ"], ["databaseEngine", "PostgreSQL"]]), (x, p) => (x.postgres.storagePerGbMonth = onDemand(p)));
  for (const p of awsQuery("AmazonMSK", [])) {
    const a = p.product.attributes;
    if (!a.regionCode) continue;
    if (a.usagetype?.endsWith("Kafka.m7g.large")) region("aws", a.regionCode).kafka = { ...region("aws", a.regionCode).kafka, unitHour: onDemand(p), unit: "broker (kafka.m7g.large)", minUnits: 3 };
    if (/Kafka\.Storage\.GP2$/.test(a.usagetype ?? "")) region("aws", a.regionCode).kafka = { ...region("aws", a.regionCode).kafka, storagePerGbMonth: onDemand(p) };
  }
  prices.sources.aws = "AWS Price List Query API (on-demand list prices, USD)";
}

// ------------------------------------------------------------------ GCP
async function gcp() {
  const key = process.env.GCP_API_KEY;
  if (!key) {
    log("GCP: GCP_API_KEY not set, skipping (the cost tab shows GCP as 'no price data').");
    prices.sources.gcp = "not loaded: set GCP_API_KEY";
    return;
  }
  const skus = async (service) => {
    const all = [];
    let token = "";
    do {
      const res = await fetch(`https://cloudbilling.googleapis.com/v1/services/${service}/skus?key=${key}&currencyCode=USD&pageSize=5000${token ? `&pageToken=${token}` : ""}`);
      if (!res.ok) throw new Error(`GCP ${service}: ${res.status}`);
      const d = await res.json();
      all.push(...d.skus);
      token = d.nextPageToken;
    } while (token);
    return all;
  };
  const unit = (s) => {
    const r = s.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
    return r ? Number(r.units ?? 0) + (r.nanos ?? 0) / 1e9 : undefined;
  };
  const each = (s, fn) => s.serviceRegions?.forEach((r) => fn(region("gcp", r)));
  const onDemandSku = (s) => s.category?.usageType === "OnDemand";

  for (const s of (await skus("6F81-5844-456A")).filter(onDemandSku)) {
    const d = s.description;
    if (/^N2 Instance Core running in /.test(d)) each(s, (x) => (x.n2Core = unit(s)));
    if (/^N2 Instance Ram running in /.test(d)) each(s, (x) => (x.n2Ram = unit(s)));
    if (/^SSD backed PD Capacity in /.test(d)) each(s, (x) => (x.disks["premium-rwo"] = { perGb: unit(s) }));
    if (/^Regional SSD backed PD Capacity in /.test(d)) each(s, (x) => (x.disks["regional-pd-ssd"] = { perGb: unit(s) }));
    if (/^Balanced PD Capacity in /.test(d)) each(s, (x) => (x.disks["standard-rwo"] = { perGb: unit(s) }));
    if (/^Storage PD Capacity in /.test(d)) each(s, (x) => (x.disks.standard = { perGb: unit(s) }));
    if (/^Hyperdisk Balanced Capacity in /.test(d)) each(s, (x) => (x.disks["hyperdisk-balanced"] = { perGb: unit(s) }));
    if (/^Network Inter Zone Data Transfer Out/.test(d)) each(s, (x) => (x.transfer.interZone = unit(s)));
    if (/^Network Internet Data Transfer Out from/.test(d)) each(s, (x) => (x.transfer.internet ??= unit(s)));
    if (/^Network Inter Region Data Transfer Out from/.test(d)) each(s, (x) => (x.transfer.interRegion = Math.max(x.transfer.interRegion ?? 0, unit(s) ?? 0)));
  }
  for (const [r, x] of Object.entries(prices.gcp)) {
    if (x.n2Core && x.n2Ram) for (const [t, [c, m]] of Object.entries(VMS.gcp)) x.vm[t] = Math.round((c * x.n2Core + m * x.n2Ram) * 10000) / 10000;
    delete x.n2Core;
    delete x.n2Ram;
    x.controlPlaneHour = 0.1; // GKE cluster management fee (list price, all regions)
    if (x.disks["hyperdisk-balanced"]) x.disks["hyperdisk-balanced-ha"] = { perGb: x.disks["hyperdisk-balanced"].perGb * 2 };
    void r;
  }
  for (const s of (await skus("95FF-2EF5-5EA1")).filter(onDemandSku)) {
    const d = s.description;
    if (/^Standard Storage .*\(?Regional\)?|^Regional Standard Class A|^Standard Storage/.test(d) && s.category.resourceGroup === "RegionalStorage") each(s, (x) => ((x.objectStorage.standard ??= {}).perGbMonth = unit(s)));
    if (/Dual-Region Standard Storage|Standard Storage .*Dual-Region/.test(d)) each(s, (x) => ((x.objectStorage.dualRegion ??= {}).perGbMonth = unit(s)));
    if (/^Regional Standard Class A Operations/.test(d)) each(s, (x) => ((x.objectStorage.standard ??= {}).putPer1k = (unit(s) ?? 0) * 1000));
    if (/^Regional Standard Class B Operations/.test(d)) each(s, (x) => ((x.objectStorage.standard ??= {}).getPer1k = (unit(s) ?? 0) * 1000));
  }
  prices.sources.gcp = "Google Cloud Billing Catalog API (on-demand list prices, USD)";
}

// ------------------------------------------------------------------ run
const previous = (() => {
  try {
    return JSON.parse(readFileSync(out, "utf8"));
  } catch {
    return null;
  }
})();

await ecb();
for (const [name, fn] of [["azure", azure], ["aws", aws], ["gcp", gcp]]) {
  try {
    log(`fetching ${name}…`);
    await fn();
  } catch (e) {
    log(`${name} failed: ${e.message}`);
    if (previous?.[name]) {
      prices[name] = previous[name];
      prices.sources[name] = `${previous.sources?.[name] ?? ""} (kept from ${previous.fetchedAt}: refresh failed)`;
    }
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(prices));
log(`wrote ${out}: ${Object.keys(prices.azure).length} Azure, ${Object.keys(prices.aws).length} AWS, ${Object.keys(prices.gcp).length} GCP regions`);
