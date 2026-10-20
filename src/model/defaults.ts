import { COMPONENTS, COMPONENT_BY_ID } from "../catalog/components";
import { resolveOptions } from "../catalog/questions";
import { recommendedStorageClass, STORAGE_CLASSES } from "../catalog/storage";
import type { ComponentId, OptionValue, PlannerConfig, Volumes } from "./types";

export function defaultVolumes(env: string): Volumes {
  const prod = /prod/i.test(env);
  return {
    metrics: {
      knowsActiveSeries: false,
      activeSeries: prod ? 1_000_000 : 200_000,
      nodes: prod ? 30 : 6,
      podsPerNode: 30,
    },
    logsGbPerDay: prod ? 100 : 10,
    cloudLogsGbPerDay: prod ? 50 : 5,
    traces: { unit: "spans", spansPerSecond: prod ? 2000 : 200, gbPerDay: prod ? 50 : 5 },
    profiledServices: prod ? 100 : 20,
    llmCallsPerDay: prod ? 50_000 : 2_000,
    retentionDays: { metrics: prod ? 90 : 30, logs: prod ? 30 : 7, traces: prod ? 14 : 7, profiles: prod ? 14 : 7, ai: prod ? 30 : 7 },
    grafanaUsers: prod ? 50 : 10,
    dashboards: prod ? 60 : 20,
  };
}

export function defaultConfig(): PlannerConfig {
  const environments = ["dev", "stage", "prod"];
  return {
    schema: 1,
    platform: { cloud: "azure", region: "germanywestcentral", currency: "EUR" },
    delivery: { method: "argocd", gitHost: "github", repoUrl: "" },
    multiRegion: { model: "single", regions: [], remoteClusters: {}, replication: "object", mirrorKafka: false },
    environments,
    topology: {
      centralModel: "per-env",
      remoteClusters: Object.fromEntries(environments.map((e) => [e, e === "prod" ? 3 : 1])),
      createCentralCluster: true,
      zones: 3,
    },
    signals: { metrics: true, logs: true, traces: true, profiles: false, ai: false },
    connectivity: {
      path: "public",
      auth: "basic",
      ingress: "envoy-gateway",
      baseDomain: "observability.example.com",
      tls: "cert-manager",
      externalDns: true,
      secrets: "eso",
    },
    tenancy: { enabled: true, key: "cluster", customLabel: "", crossTenantQuery: true },
    components: Object.fromEntries(COMPONENTS.map((c) => [c.id, { options: {} }])) as PlannerConfig["components"],
    volumes: Object.fromEntries(environments.map((e) => [e, defaultVolumes(e)])),
    overrides: {},
    limits: {},
  };
}

/** Whether the component is (or will be, if unanswered) part of the design. */
export function isEnabled(cfg: PlannerConfig, id: ComponentId): boolean {
  const choice = cfg.components[id];
  return choice?.enabled ?? COMPONENT_BY_ID[id].recommended(cfg);
}

/**
 * Options = smart defaults for the current answers, overridden by what the user set.
 * A stored choice that is no longer valid (e.g. after switching cloud) falls back to the default.
 */
export function effectiveOptions(cfg: PlannerConfig, id: ComponentId): Record<string, OptionValue> {
  const def = COMPONENT_BY_ID[id];
  const merged: Record<string, OptionValue> = { ...def.defaults(cfg), ...(cfg.components[id]?.options ?? {}) };
  for (const q of def.questions) {
    if (q.kind !== "choice") continue;
    const allowed = resolveOptions(q, cfg).map((o) => o.value);
    if (!allowed.includes(String(merged[q.id]))) merged[q.id] = def.defaults(cfg)[q.id] ?? allowed[0];
  }
  // The official Mimir chart is microservices-only.
  if (id === "mimir") merged.mode = "distributed";
  // Storage class for the component's PVCs must exist on the chosen cloud.
  // Storage class: the user's choice if it exists on this cloud, otherwise the recommendation for this component.
  const userChose = cfg.components[id]?.options.storageClass !== undefined;
  if (!userChose || !STORAGE_CLASSES[cfg.platform.cloud].some((s) => s.name === merged.storageClass))
    merged.storageClass = recommendedStorageClass(cfg.platform.cloud, cfg.topology.zones, merged.zoneAware === true).name;
  return merged;
}

/** Hostname of a central service: the component's own setting, or <id>.<base domain>. */
export function hostnameFor(cfg: PlannerConfig, id: ComponentId): string {
  const custom = String(cfg.components[id]?.options.host ?? "").trim();
  return custom || `${id}.${cfg.connectivity.baseDomain || "example.com"}`;
}

/** Config with every component's options resolved — what generators and the sizing engine read. */
export function resolvedConfig(cfg: PlannerConfig): PlannerConfig {
  const resolveOnce = (base: PlannerConfig): PlannerConfig => {
    const components = { ...cfg.components };
    for (const c of COMPONENTS) {
      const answered = cfg.components[c.id]?.enabled;
      const options = effectiveOptions(base, c.id);
      // Kafka is opt-in: without it Mimir uses the classic architecture and Tempo runs monolithic.
      if (base.components.kafka?.enabled !== true && cfg.components.kafka?.enabled !== true) {
        if (c.id === "mimir") options.architecture = "classic";
        if (c.id === "tempo") options.mode = "monolithic";
      }
      if (c.id === "kafka") options.skippedByUser = answered === false;
      // Not part of the design when its signal is off (e.g. Langfuse without AI observability).
      const relevant = (!c.signal || base.signals[c.signal]) && (!c.isRelevant || c.isRelevant(base));
      components[c.id] = { enabled: relevant && (answered ?? c.recommended(base)), options, workloads: cfg.components[c.id]?.workloads };
    }
    return { ...cfg, components };
  };
  // Two passes: some defaults depend on other components' resolved answers
  // (e.g. Kafka is recommended when the resolved Mimir/Tempo choices use it).
  return resolveOnce(resolveOnce(cfg));
}
