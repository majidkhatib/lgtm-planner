import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ROBUSTA_PLAYBOOK_GROUPS } from "../../catalog/components";
import { defaultConfig, resolvedConfig } from "../../model/defaults";
import type { PlannerConfig } from "../../model/types";
import { generateRepository } from "../index";
import { mergeValues } from "../split";

function cfg(fn: (c: PlannerConfig) => void = () => {}): PlannerConfig {
  const c = defaultConfig();
  fn(c);
  return resolvedConfig(c);
}
const paths = (c: PlannerConfig) => generateRepository(c).map((f) => f.path);
/** Values as Helm sees them on the prod cluster: base, then the cluster overlay. */
function centralValues(c: PlannerConfig, id: string): Record<string, any> {
  const files = generateRepository(c);
  const get = (p: string) => parse(files.find((f) => f.path === p)?.content ?? "{}") ?? {};
  return mergeValues(get(`helm/base/${id}/values.yaml`), get(`helm/central/prod/${id}/values.yaml`)) as Record<string, any>;
}

describe("Alertmanager placement", () => {
  it("always runs on the central cluster; 'Central + remote' adds one per remote cluster", () => {
    const central = paths(cfg());
    expect(central).toContain("helm/central/prod/alertmanager/values.yaml");
    expect(central.some((p) => p.startsWith("helm/remote/") && p.includes("/alertmanager/"))).toBe(false);

    const both = paths(cfg((c) => (c.components.alertmanager.options.placement = "both")));
    expect(both).toContain("helm/central/prod/alertmanager/values.yaml");
    expect(both.some((p) => p.startsWith("helm/remote/") && p.endsWith("/alertmanager/values.yaml"))).toBe(true);
  });

  it("old 'remote only' configurations become 'Central + remote'", () => {
    expect(cfg((c) => (c.components.alertmanager.options.placement = "remote")).components.alertmanager.options.placement).toBe("both");
  });

  it("remote Alertmanagers also work next to Mimir's built-in central Alertmanager", () => {
    const c = cfg((x) => {
      x.components.alertmanager.options.type = "mimir";
      x.components.alertmanager.options.placement = "both";
    });
    const p = paths(c);
    expect(p).not.toContain("helm/central/prod/alertmanager/values.yaml");
    expect(p.some((x) => x.startsWith("helm/remote/") && x.endsWith("/alertmanager/values.yaml"))).toBe(true);
  });
});

describe("Robusta playbooks", () => {
  const robusta = (fn: (c: PlannerConfig) => void = () => {}) =>
    cfg((c) => {
      c.components.robusta.enabled = true;
      fn(c);
    });

  it("all built-in groups on by default, Slack as destination", () => {
    const v = centralValues(robusta(), "robusta");
    expect(v.disabledPlaybooks).toEqual([]);
    expect(v.sinksConfig[0].slack_sink.api_key).toBe("{{ env.SLACK_API_KEY }}");
    expect(v.runner.additional_env_vars.map((e: { name: string }) => e.name)).toContain("SLACK_API_KEY");
    expect(v.clusterName).toBe("central-prod");
  });

  it("unselected groups are disabled by name; extras become named custom playbooks sent to the sink", () => {
    const v = centralValues(
      robusta((c) => {
        c.components.robusta.options.playbooks = "crashes,oom";
        c.components.robusta.options.extraPlaybooks = "krr,changes";
        c.components.robusta.options.sink = "msteams";
      }),
      "robusta",
    );
    const nodes = ROBUSTA_PLAYBOOK_GROUPS.find((g) => g.id === "nodes")!.playbooks;
    expect(v.disabledPlaybooks).toEqual(expect.arrayContaining(nodes));
    expect(v.disabledPlaybooks).not.toContain("CrashLoopBackOff");
    expect(v.namedCustomPlaybooks["weekly-krr"].actions[0]).toHaveProperty("krr_scan");
    expect(v.namedCustomPlaybooks["weekly-krr"].sinks).toEqual(["main_ms_teams_sink"]);
    expect(v.namedCustomPlaybooks["change-tracking"].actions[0]).toHaveProperty("resource_babysitter");
    expect(v.namedCustomPlaybooks["weekly-popeye"]).toBeUndefined();
    expect(v.sinksConfig[0].ms_teams_sink.webhook_url).toBe("{{ env.MSTEAMS_WEBHOOK_URL }}");
  });

  it("playbook choices are shared settings (base), the cluster name is per cluster", () => {
    const files = generateRepository(robusta());
    const base = parse(files.find((f) => f.path === "helm/base/robusta/values.yaml")!.content);
    const prod = parse(files.find((f) => f.path === "helm/central/prod/robusta/values.yaml")!.content);
    expect(base.sinksConfig).toBeDefined();
    expect(base.clusterName).toBeUndefined();
    expect(prod.clusterName).toBe("central-prod");
  });
});
