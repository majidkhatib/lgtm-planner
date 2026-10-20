import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "vitest";
import { defaultConfig, resolvedConfig } from "../../model/defaults";
import { generateRepository } from "../index";

// Writes generated repositories to $DUMP_DIR so CI can run `helm template` against the real charts.
const out = process.env.DUMP_DIR;
it.skipIf(!out)("dump generated repositories", () => {
  const variants: Record<string, (c: ReturnType<typeof defaultConfig>) => void> = {
    azure: () => {},
    aws: (c) => {
      c.platform = { cloud: "aws", region: "eu-central-1", currency: "USD" };
      c.signals.profiles = true;
      c.signals.ai = true;
      c.components.loki.options.mode = "simple-scalable";
    },
    gcp: (c) => {
      c.platform = { cloud: "gcp", region: "europe-west3", currency: "EUR" };
      c.components.kafka.enabled = false;
      c.components.loki.options.mode = "monolithic";
      c.components["trace-collector"].options.collector = "otel";
    },
  };
  variants["aws-standby"] = (c) => {
    c.platform = { cloud: "aws", region: "eu-central-1", currency: "USD" };
    c.multiRegion = { model: "standby", regions: ["eu-west-1"], remoteClusters: {}, replication: "crr", mirrorKafka: false };
  };
  variants["azure-active"] = (c) => {
    c.multiRegion = { model: "active-active", regions: ["swedencentral"], remoteClusters: {}, replication: "object", mirrorKafka: false };
  };
  variants["gcp-regional"] = (c) => {
    c.platform = { cloud: "gcp", region: "europe-west3", currency: "EUR" };
    c.multiRegion = { model: "regional", regions: ["europe-west1"], remoteClusters: { "europe-west1": { prod: 2, dev: 1 } }, replication: "dual-region", mirrorKafka: false };
  };
  variants["azure-server-am"] = (c) => {
    c.components.prometheus.options.mode = "server";
    c.components.alertmanager.options.placement = "both";
    c.components.robusta.enabled = true;
    c.components.robusta.options.playbooks = "crashes,oom,nodes";
    c.components.robusta.options.extraPlaybooks = "krr,popeye,changes";
  };
  variants["aws-beyla-basic"] = (c) => {
    c.platform = { cloud: "aws", region: "eu-central-1", currency: "USD" };
    c.signals = { ...c.signals, traces: true };
    c.connectivity.auth = "basic";
    c.components.beyla.enabled = true;
    c.components.beyla.options.network = true;
    c.components["trace-collector"].enabled = false;
  };
  variants["azure-beyla-namespaces"] = (c) => {
    c.signals = { ...c.signals, traces: true };
    c.components.beyla.enabled = true;
    c.components.beyla.options.scope = "namespaces";
    c.components.beyla.options.namespaces = "shop, team-*";
  };
  for (const [name, fn] of Object.entries(variants)) {
    const c = defaultConfig();
    fn(c);
    for (const f of generateRepository(resolvedConfig(c))) {
      const p = join(out!, name, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
  }
});
