import { useState, type ReactNode } from "react";
import { CLOUDS } from "../../catalog/clouds";
import { componentLabel, relevantComponents, runsOnCentral, runsOnRemote } from "../../catalog/components";
import { resolveOptions, type Question } from "../../catalog/questions";
import { STORAGE_CLASSES } from "../../catalog/storage";
import { centralClusters, centralWorkloads, hostOf, remoteClusters, remoteWorkloads } from "../../generate/common";
import { recommendNodePools } from "../../generate/nodepools";
import { effectiveReplication, isMultiRegion, regionInfo } from "../../model/regions";
import type { OptionValue, PlannerConfig } from "../../model/types";
import { deriveInputs } from "../../sizing/inputs";
import { shareUrl } from "../../state/share";

const DELIVERY: Record<string, string> = {
  argocd: "Argo CD",
  flux: "Flux",
  "azure-devops": "Azure DevOps Pipelines",
  "github-actions": "GitHub Actions",
  "gitlab-ci": "GitLab CI/CD",
  helm: "Manual Helm",
};
const MODEL: Record<string, string> = {
  single: "Single region",
  regional: "Regional stacks",
  standby: "Standby region (replicated storage)",
  "active-active": "Active-active (dual write)",
};
const INGRESS: Record<string, string> = {
  "envoy-gateway": "Gateway API: Envoy Gateway",
  istio: "Gateway API: Istio",
  "cloud-native": "Cloud-native load balancer",
  haproxy: "HAProxy Ingress",
  traefik: "Traefik",
  "ingress-nginx": "ingress-nginx",
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
/** Small data rates in KB/s instead of "0 MB/s". */
const rate = (mb: number) => (mb >= 1 ? `${fmt(mb)} MB/s` : `${fmt(mb * 1024)} KB/s`);

/** Human-readable answer of one component question. */
function answer(q: Question, cfg: PlannerConfig, value: OptionValue): string {
  if (q.kind === "choice") return resolveOptions(q, cfg).find((o) => o.value === String(value))?.label ?? String(value);
  if (q.kind === "toggle") return value ? "yes" : "no";
  if (q.kind === "number") return `${value}${q.unit ? ` ${q.unit}` : ""}`;
  return String(value || "default");
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ov-block">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="ov-dl">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Overview({ cfg }: { cfg: PlannerConfig }) {
  const [copied, setCopied] = useState(false);
  const cloud = CLOUDS[cfg.platform.cloud];
  const multiEnv = cfg.environments.length > 1;
  const comps = relevantComponents(cfg);
  const central = centralClusters(cfg);
  const remotes = remoteClusters(cfg);
  const c = cfg.connectivity;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(cfg));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* blocked */
    }
  };

  return (
    <>
      <div className="share">
        <button type="button" className="btn btn-primary" onClick={copy}>
          {copied ? "Link copied ✓" : "Copy shareable link"}
        </button>
        <span className="muted">The link contains all your answers. Nothing is stored on a server.</span>
      </div>

      <div className="ov-grid">
        <Block title="Platform">
          <Rows
            rows={[
              ["Cloud", cloud.name],
              ["Primary region", regionInfo(cfg, cfg.platform.region).name],
              ["Multi-region", MODEL[cfg.multiRegion.model]],
              ...(isMultiRegion(cfg)
                ? ([
                    ["Other regions", cfg.multiRegion.regions.map((r) => regionInfo(cfg, r).name).join(", ")],
                    ...(cfg.multiRegion.model === "standby"
                      ? ([
                          ["Storage replication", effectiveReplication(cfg)],
                          ["Kafka replication", cfg.multiRegion.mirrorKafka ? "yes" : "no"],
                        ] as [string, string][])
                      : []),
                  ] as [string, string][])
                : []),
              ["Delivery", DELIVERY[cfg.delivery.method]],
              ...(cfg.delivery.repoUrl ? ([["Repository", cfg.delivery.repoUrl]] as [string, string][]) : []),
              ["Currency", cfg.platform.currency],
            ]}
          />
        </Block>

        <Block title="Clusters">
          <Rows
            rows={[
              ["Environments", cfg.environments.join(", ")],
              ...(multiEnv ? ([["Central model", cfg.topology.centralModel === "per-env" ? "One central cluster per environment" : "One shared central cluster"]] as [string, string][]) : []),
              ["Central clusters", central.map((x) => `${x.name}${x.role === "standby" ? " (standby)" : ""}`).join(", ")],
              ["Central cluster", cfg.topology.createCentralCluster ? `created by Terraform, ${cfg.topology.zones} zone(s)` : "existing cluster"],
              ["Remote clusters", `${remotes.length}${remotes.length ? `: ${remotes.length > 4 ? `${remotes[0].name} … ${remotes[remotes.length - 1].name}` : remotes.map((r) => r.name).join(", ")}` : ""}`],
            ]}
          />
        </Block>

        <Block title="Connectivity & security">
          <Rows
            rows={[
              ["Network path", c.path === "public" ? "Public endpoint" : `Private network (${cloud.privateLink})`],
              ["Remote auth", c.auth === "basic" ? "Basic auth per tenant" : c.auth === "mtls" ? "Mutual TLS" : "Handled by existing infrastructure"],
              ["Ingress / Gateway", INGRESS[c.ingress]],
              ["TLS", c.tls === "cert-manager" ? "cert-manager" : c.tls === "edge-managed" ? cloud.edgeCertificate : "Existing certificate"],
              ["DNS", c.externalDns ? `external-dns (${cloud.dns})` : "managed manually"],
              ["Secrets", c.secrets === "eso" ? `External Secrets Operator (${cloud.secretStore})` : `Secrets Store CSI (${cloud.secretStore})`],
              ["Base domain", c.baseDomain],
            ]}
          />
        </Block>

        <Block title="Multi-tenancy">
          <Rows
            rows={
              cfg.tenancy.enabled
                ? [
                    ["Tenant", cfg.tenancy.key === "custom" ? `label ${cfg.tenancy.customLabel || "?"}` : cfg.tenancy.key],
                    ["Cross-tenant queries", cfg.tenancy.crossTenantQuery ? "yes" : "no"],
                  ]
                : [["Multi-tenancy", "off"]]
            }
          />
        </Block>
      </div>

      <Block title="Components">
        <div className="table-wrap">
          <table className="wl-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Runs on</th>
                <th>Choices</th>
                <th>Disk</th>
                <th>Hostname</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((def) => {
                const r = cfg.components[def.id];
                if (!r.enabled)
                  return (
                    <tr key={def.id} className="is-off">
                      <td>{def.name}</td>
                      <td colSpan={4}>skipped</td>
                    </tr>
                  );
                const qs = def.questions.filter((q) => q.id !== "host" && (!q.visibleIf || q.visibleIf(cfg, r.options)) && r.options[q.id] !== undefined);
                const where = [runsOnCentral(cfg, def.id) ? "central" : "", runsOnRemote(cfg, def.id) ? "remote" : ""].filter(Boolean).join(" + ");
                // Disk only when one of the component's workloads has a PVC (central or remote)
                const pvc =
                  (runsOnCentral(cfg, def.id) && centralWorkloads(central[0], def.id).some((w) => w.def.pvc)) ||
                  (runsOnRemote(cfg, def.id) && remoteWorkloads(cfg, cfg.environments[0], def.id).some((w) => w.def.pvc));
                const sc = STORAGE_CLASSES[cfg.platform.cloud].find((s) => s.name === r.options.storageClass);
                const hosted = ["grafana", "mimir", "loki", "tempo", "pyroscope", "langfuse"].includes(def.id);
                return (
                  <tr key={def.id}>
                    <td>
                      <strong>{componentLabel(cfg, def.id)}</strong>
                    </td>
                    <td>{where}</td>
                    <td className="ov-choices">
                      {qs.length ? (
                        qs.map((q) => (
                          <div key={q.id}>
                            <span className="muted">{q.label.replace(/\?$/, "")}:</span> {answer(q, cfg, r.options[q.id])}
                          </div>
                        ))
                      ) : (
                        <span className="muted">defaults</span>
                      )}
                    </td>
                    <td>{pvc && sc ? sc.label : "—"}</td>
                    <td>{hosted ? <code>{hostOf(cfg, def.id)}</code> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Block>

      <Block title="Volumes and retention">
        <div className="table-wrap">
          <table className="wl-table">
            <thead>
              <tr>
                <th>Environment</th>
                {cfg.signals.metrics && <th>Active series</th>}
                {cfg.signals.logs && <th>Logs / day</th>}
                {cfg.signals.traces && <th>Traces (after sampling)</th>}
                {cfg.signals.profiles && <th>Profiled pods</th>}
                {cfg.signals.ai && <th>LLM calls / day</th>}
                <th>Grafana users</th>
                <th>Retention</th>
              </tr>
            </thead>
            <tbody>
              {cfg.environments.map((e) => {
                const d = deriveInputs(cfg, e);
                const v = cfg.volumes[e];
                return (
                  <tr key={e}>
                    <td>{e}</td>
                    {cfg.signals.metrics && <td>{fmt(d.activeSeries)}</td>}
                    {cfg.signals.logs && <td>{fmt(d.logsGbPerDay)} GB</td>}
                    {cfg.signals.traces && <td>{rate(d.traceMbPerSecond)} ({d.traceSamplingPercent} % kept)</td>}
                    {cfg.signals.profiles && <td>{fmt(v.profiledServices)}</td>}
                    {cfg.signals.ai && <td>{fmt(v.llmCallsPerDay)}</td>}
                    <td>{v.grafanaUsers}</td>
                    <td className="ov-choices">
                      {(["metrics", "logs", "traces", "profiles", "ai"] as const)
                        .filter((s) => cfg.signals[s])
                        .map((s) => `${s} ${v.retentionDays[s]} d`)
                        .join(" · ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Block>

      <Block title="Central clusters: size">
        <div className="table-wrap">
          <table className="wl-table">
            <thead>
              <tr>
                <th>Cluster</th>
                <th>Region</th>
                <th>Node pools</th>
              </tr>
            </thead>
            <tbody>
              {central.map((x) => (
                <tr key={x.name}>
                  <td>
                    {x.name}
                    {x.role === "standby" && <span className="muted"> (standby)</span>}
                  </td>
                  <td>{regionInfo(cfg, x.region).name}</td>
                  <td>
                    {recommendNodePools(x)
                      .map((p) => `${p.name}: ${p.nodes} × ${p.vm.name}`)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}
