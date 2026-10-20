import { Fragment, useState, type ReactNode } from "react";
import { recommendedStorageClass, STORAGE_CLASSES } from "../catalog/storage";
import { AUTOSCALER_INFO, KIND_SCALING_NOTE, type Autoscaler } from "../catalog/workloads";
import { defaultVolumes } from "../model/defaults";
import type { ComponentId, PlannerConfig, SignalId, Volumes, WorkloadOverride } from "../model/types";
import { autoscalingSnippet, vpaSnippet, type Snippet } from "../generate/autoscaling";
import { dirForEnv } from "../generate/common";
import { sizeComponent, type SizedWorkload } from "../sizing/engine";
import { deriveInputs } from "../sizing/inputs";
import { useStore } from "../state/store";
import { ChoiceCards, Field, NumberInput, Toggle } from "../ui/controls";

// ------------------------------------------------------------------ environment tabs
export function EnvTabs({ env, onChange }: { env: string; onChange: (e: string) => void }) {
  const { config } = useStore();
  return (
    <div className="tabs" role="tablist">
      {config.environments.map((e) => (
        <button key={e} type="button" role="tab" aria-selected={e === env} className={`tab${e === env ? " is-active" : ""}`} onClick={() => onChange(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <h3 className="panel-title">{title}</h3>
      {hint && <p className="panel-hint">{hint}</p>}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ volume & retention (per component)
const RETENTION_HELP: Record<SignalId, string> = {
  metrics: "Longer retention is cheap in object storage, but long-range queries read more blocks. 13 months (395 days) allows year-over-year comparison.",
  logs: "Logs are usually the biggest storage cost. Many teams keep 30 days here and archive older logs elsewhere for compliance.",
  traces: "Traces are mostly used for recent incidents; 7–14 days is typical.",
  profiles: "Mostly used to compare recent releases; 7–14 days is typical.",
  ai: "LLM traces include full prompts and responses, which can contain personal data. Keep them only as long as you need for debugging and evaluations.",
};

const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** 10500105 → "10.5 million" — makes a missing or extra digit obvious */
const fmtShort = (n: number) =>
  n >= 1e9 ? `${+(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${+(n / 1e6).toFixed(2)} million` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)} thousand` : `${n}`;

export function VolumePanel({ id, env }: { id: ComponentId; env: string }) {
  const { resolved, update } = useStore();
  const v = resolved.volumes[env] ?? defaultVolumes(env);
  const d = deriveInputs(resolved, env);
  const set = (fn: (vol: Volumes) => void) =>
    update((dr) => {
      dr.volumes[env] ??= defaultVolumes(env);
      fn(dr.volumes[env]);
    });

  const retention = (signal: SignalId) => (
    <Field label="Retention" help={RETENTION_HELP[signal]}>
      <NumberInput value={v.retentionDays[signal]} unit="days" min={1} max={3650} onChange={(n) => set((vol) => void (vol.retentionDays[signal] = n))} />
    </Field>
  );

  const users = (
    <Field label="Grafana users in this environment" help="Turned into query load: about 20 % of users look at dashboards at the same time, ~20 panels refreshing every minute, plus alert-rule evaluations.">
      <NumberInput value={v.grafanaUsers} min={1} onChange={(n) => set((vol) => void (vol.grafanaUsers = n))} />
    </Field>
  );

  const metrics = (
    <>
      <div className="field">
        <Toggle checked={v.metrics.knowsActiveSeries} onChange={(x) => set((vol) => void (vol.metrics.knowsActiveSeries = x))} label="I know the number of active series" />
        <div className="field-help toggle-help">Active series = unique metric + label combinations receiving samples. In Prometheus: prometheus_tsdb_head_series.</div>
      </div>
      {v.metrics.knowsActiveSeries ? (
        <Field label="Active series (all remote clusters of this environment)">
          <NumberInput value={v.metrics.activeSeries} min={1000} step={10000} unit={`= ${fmtShort(v.metrics.activeSeries)}`} onChange={(n) => set((vol) => void (vol.metrics.activeSeries = n))} />
        </Field>
      ) : (
        <div className="row-2">
          <Field label="Nodes (all remote clusters)">
            <NumberInput value={v.metrics.nodes} min={1} onChange={(n) => set((vol) => void (vol.metrics.nodes = n))} />
          </Field>
          <Field label="Pods per node (average)">
            <NumberInput value={v.metrics.podsPerNode} min={1} max={250} onChange={(n) => set((vol) => void (vol.metrics.podsPerNode = n))} />
          </Field>
        </div>
      )}
      <div className="derived">
        → <strong>{fmtNum(d.activeSeries)}</strong> active series ({fmtShort(d.activeSeries)})
        {d.activeSeriesEstimated && " · estimated: 1,000 per node + 400 per pod"}
        {d.metricsGeneratorSeries > 0 && ` · includes +${fmtNum(d.metricsGeneratorSeries)} (5 %) span-derived series from Tempo's metrics-generator`}
        {d.beylaSeries > 0 && ` · includes +${fmtNum(d.beylaSeries)} series from Beyla`}
        {" · "}<strong>{fmtNum(d.samplesPerSecond)}</strong> samples/s at a {d.scrapeIntervalSeconds} s scrape interval
      </div>
    </>
  );

  const qps = (
    <div className="derived">
      → <strong>Query load ≈ {fmtNum(d.metricsQps)} queries per second</strong>{d.metricsQpsEstimated ? "" : " (set by you)"}: how many PromQL queries Mimir has to answer every second.{" "}
      <QpsOverride env={env} current={d.metricsQps} />
      {d.metricsQpsEstimated && (
        <div className="derived-detail">
          Dashboards: {v.grafanaUsers} users × 20 % looking at the same time × 20 panels ÷ 60 s refresh = {fmtNum(d.dashboardQps)} q/s
          <br />
          Alert and recording rules: 1 + 1 per 250,000 series = {fmtNum(d.ruleQps)} q/s
          <br />
          Used to size the querier, query-frontend, query-scheduler and store-gateway. If you know your real rate (Mimir metric <code>cortex_query_frontend_queries_total</code>), set it with "change".
        </div>
      )}
    </div>
  );

  switch (id) {
    case "prometheus":
      return <Section title="Volume">{metrics}</Section>;
    case "mimir":
      return (
        <Section title="Volume, retention and query load">
          {metrics}
          {users}
          {qps}
          {retention("metrics")}
        </Section>
      );
    case "loki":
      return (
        <Section title="Volume, retention and query load">
          <Field label="Logs from Kubernetes workloads" help="Uncompressed volume as written by the applications, per day.">
            <NumberInput value={v.logsGbPerDay} unit="GB/day" min={0} onChange={(n) => set((vol) => void (vol.logsGbPerDay = n))} />
          </Field>
          {resolved.components["cloud-logs"].enabled && <p className="muted">+ {fmtNum(v.cloudLogsGbPerDay)} GB/day of cloud platform logs (set in the "Cloud platform logs" step).</p>}
          <div className="derived">→ Loki receives <strong>{fmtNum(d.logsGbPerDay)}</strong> GB/day in total</div>
          {users}
          {retention("logs")}
        </Section>
      );
    case "cloud-logs":
      return (
        <Section title="Volume">
          <Field label="Cloud platform logs per day" help="Logs the cloud platform and its managed services produce: activity/audit logs, firewall, load balancers and API gateways, managed databases, serverless functions and web apps (App Service, Lambda, Cloud Run…). Check the size of your current diagnostic-settings / log-sink exports.">
            <NumberInput value={v.cloudLogsGbPerDay} unit="GB/day" min={0} onChange={(n) => set((vol) => void (vol.cloudLogsGbPerDay = n))} />
          </Field>
        </Section>
      );
    case "trace-collector":
    case "tempo":
      return (
        <Section title={id === "tempo" ? "Volume and retention" : "Traffic"}>
          <ChoiceCards
            columns={2}
            value={v.traces.unit}
            options={[
              { value: "spans", label: "I know spans per second" },
              { value: "gb", label: "I know GB per day" },
            ]}
            onChange={(x) => set((vol) => void (vol.traces.unit = x as "spans" | "gb"))}
          />
          {v.traces.unit === "spans" ? (
            <Field label="Spans per second produced by applications (before sampling)">
              <NumberInput value={v.traces.spansPerSecond} min={0} step={100} onChange={(n) => set((vol) => void (vol.traces.spansPerSecond = n))} />
            </Field>
          ) : (
            <Field label="Trace data per day (before sampling)">
              <NumberInput value={v.traces.gbPerDay} unit="GB/day" min={0} onChange={(n) => set((vol) => void (vol.traces.gbPerDay = n))} />
            </Field>
          )}
          <div className="derived">→ After {d.traceSamplingPercent} % sampling Tempo receives <strong>{fmtNum(d.traceMbPerSecond)}</strong> MB/s</div>
          {id === "tempo" && retention("traces")}
        </Section>
      );
    case "pyroscope":
      return (
        <Section title="Volume and retention">
          <Field label="Pods with continuous profiling enabled" help="Every profiled pod sends CPU, memory and other profiles about every 15 seconds (~4 KB/s). Count the pods of the applications you want to profile, not the whole cluster.">
            <NumberInput value={v.profiledServices} min={0} onChange={(n) => set((vol) => void (vol.profiledServices = n))} />
          </Field>
          <div className="derived">→ ≈ <strong>{fmtNum(d.profileMbPerSecond)}</strong> MB/s of profiles</div>
          {retention("profiles")}
        </Section>
      );
    case "langfuse":
      return (
        <Section title="Volume and retention">
          <Field label="LLM calls per day" help="Each call becomes a trace with several observations (prompt, tool calls, response). Drives web/worker replicas and ClickHouse size.">
            <NumberInput value={v.llmCallsPerDay} min={0} step={1000} onChange={(n) => set((vol) => void (vol.llmCallsPerDay = n))} />
          </Field>
          {retention("ai")}
        </Section>
      );
    case "grafana":
      return (
        <Section title="Users">
          {users}
          <Field label="Dashboards">
            <NumberInput value={v.dashboards} min={0} onChange={(n) => set((vol) => void (vol.dashboards = n))} />
          </Field>
        </Section>
      );
    default:
      return null;
  }
}

function QpsOverride({ env, current }: { env: string; current: number }) {
  const { config, update } = useStore();
  const [open, setOpen] = useState(false);
  const isSet = config.volumes[env]?.queryQpsOverride !== undefined;
  if (!open && !isSet)
    return (
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        change
      </button>
    );
  return (
    <span className="inline-edit">
      <input
        className="input input-sm"
        type="number"
        min={0.1}
        step={0.5}
        defaultValue={current}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) update((d) => void (d.volumes[env].queryQpsOverride = n));
        }}
      />
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          update((d) => void delete d.volumes[env].queryQpsOverride);
          setOpen(false);
        }}
      >
        use estimate
      </button>
    </span>
  );
}

// ------------------------------------------------------------------ storage class
export function StoragePanel({ id }: { id: ComponentId }) {
  const { resolved, setComponentOption } = useStore();
  const cloud = resolved.platform.cloud;
  const value = String(resolved.components[id].options.storageClass);
  const all = STORAGE_CLASSES[cloud];
  const rec = recommendedStorageClass(cloud, resolved.topology.zones, resolved.components[id].options.zoneAware === true);
  const selected = all.find((s) => s.name === value);
  const [showAvoid, setShowAvoid] = useState(selected?.suitability === "avoid");

  const card = (s: (typeof all)[number]) => (
    <label key={s.name} className={`choice sc${s.name === value ? " is-selected" : ""}${s.suitability === "avoid" ? " sc-avoid" : ""}`}>
      <input type="radio" name={`sc-${id}`} checked={s.name === value} onChange={() => setComponentOption(id, "storageClass", s.name)} />
      <span className="choice-head">
        <span className="choice-label">{s.label}</span>
        {s.name === rec.name && <span className="badge">Recommended here</span>}
        {s.suitability === "avoid" && <span className="badge badge-red">Not recommended</span>}
        {s.zoneRedundant && <span className="badge badge-blue">Zone-redundant</span>}
      </span>
      <code className="sc-name">
        {s.name} · {s.backing}
        {s.builtIn ? " · built in" : " · created by the generated manifests"}
      </code>
      <span className="choice-desc">{s.description}</span>
      <span className="sc-pro">+ {s.pros}</span>
      <span className="sc-con">− {s.cons}</span>
    </label>
  );

  const avoid = all.filter((s) => s.suitability === "avoid");
  return (
    <Section
      title="Disk storage class"
      hint="Used for the PVCs of this component (WAL, index headers, scratch space). Long-term data is in object storage, so these disks need to be fast, not big. Mimir, Loki and Tempo replicate data themselves, so zone-redundant disks are only worth it for single-replica parts."
    >
      <div className="note sc-why">
        Recommended for this component: <strong>{all.find((x) => x.name === rec.name)?.label}</strong>. {rec.reason}
      </div>
      <div className="sc-grid">{all.filter((s) => s.suitability !== "avoid").map(card)}</div>
      {avoid.length > 0 && (
        <>
          <button type="button" className="link-btn sc-toggle" aria-expanded={showAvoid} onClick={() => setShowAvoid((v) => !v)}>
            {showAvoid ? "▾" : "▸"} Options that are not recommended, and why ({avoid.length})
          </button>
          {showAvoid && <div className="sc-grid">{avoid.map(card)}</div>}
        </>
      )}
      {selected?.suitability === "avoid" && <div className="warning">⚠ {selected.label} is not recommended here: {selected.cons}</div>}
    </Section>
  );
}

// ------------------------------------------------------------------ workloads table
export function WorkloadsPanel({ id, env, runsOnRemote }: { id: ComponentId; env: string; runsOnRemote: boolean }) {
  const { resolved, setWorkload, setOverride } = useStore();
  const multiEnv = resolved.environments.length > 1;
  const [openRow, setOpenRow] = useState<string | null>(null);
  const rows = sizeComponent(resolved, id, env, runsOnRemote);
  if (rows.length === 0) return null;
  const managed = rows.every((r) => r.def.kind === "Managed");

  if (managed)
    return (
      <Section title="Sizing">
        {rows.map((r) => (
          <p key={r.def.id} className="derived">{r.calc.notes.join(" · ")}</p>
        ))}
      </Section>
    );

  const totals = rows
    .filter((r) => r.enabled && r.def.kind !== "Managed" && r.def.kind !== "DaemonSet")
    .reduce((a, r) => ({ cpu: a.cpu + r.final.cpu * r.final.replicas, mem: a.mem + r.final.memoryGi * r.final.replicas, disk: a.disk + (r.final.pvcGi ?? 0) * r.final.replicas }), { cpu: 0, mem: 0, disk: 0 });

  return (
    <Section
      title={multiEnv ? `Workloads and sizing: ${env}` : "Workloads and sizing"}
      hint={
        <>
          Calculated from the volume above. Click a value to change it; <span className="ov-dot" /> marks your edits, <span className="adj-dot" /> values recalculated from them (changing CPU or memory per pod changes the replicas so the total capacity stays the same, and the other way round). {runsOnRemote && "Replicas are per remote cluster."} Click a name for details.
        </>
      }
    >
      <div className="table-wrap">
        <table className="wl-table">
          <thead>
            <tr>
              <th>Deploy</th>
              <th>Workload</th>
              <th>Type</th>
              <th>Replicas</th>
              <th>CPU / pod</th>
              <th>Memory / pod</th>
              <th>Disk / pod</th>
              <th>Scaling</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = `${id}.${r.def.id}`;
              const open = openRow === r.def.id;
              return (
                <Fragment key={r.def.id}>
                  <tr className={r.enabled ? "" : "is-off"}>
                    <td>
                      {r.def.required ? (
                        <span className="req" title="Required: the component can't work without it">Required</span>
                      ) : (
                        <input type="checkbox" aria-label={`Deploy ${r.def.name}`} checked={r.enabled} onChange={(e) => setWorkload(id, r.def.id, { enabled: e.target.checked })} />
                      )}
                    </td>
                    <td>
                      <button type="button" className="wl-name" aria-expanded={open} onClick={() => setOpenRow(open ? null : r.def.id)}>
                        {r.def.name} <span className="chev">{open ? "▾" : "▸"}</span>
                      </button>
                      <div className="wl-role">{r.def.role}</div>
                    </td>
                    <td><span className={`kind kind-${r.def.kind}`}>{r.def.kind}</span></td>
                    {r.def.kind === "DaemonSet" ? (
                      <td className="muted" title="A DaemonSet runs exactly one pod on every node, so the count follows the number of nodes.">1 per node</td>
                    ) : (
                      <SizeCell row={r} field="replicas" env={env} k={key} setOverride={setOverride} step={1} />
                    )}
                    <SizeCell row={r} field="cpu" env={env} k={key} setOverride={setOverride} step={0.1} />
                    <SizeCell row={r} field="memoryGi" env={env} k={key} setOverride={setOverride} step={0.25} unit="Gi" />
                    {r.def.pvc ? <SizeCell row={r} field="pvcGi" env={env} k={key} setOverride={setOverride} step={1} unit="Gi" /> : <td className="muted">—</td>}
                    <td>
                      <select className="input input-sm" value={r.autoscaler} disabled={!r.enabled} onChange={(e) => setWorkload(id, r.def.id, { autoscaler: e.target.value as Autoscaler })}>
                        {(["none", ...r.def.autoscalers.filter((a) => a !== "none")] as Autoscaler[]).map((a) => (
                          <option key={a} value={a}>{AUTOSCALER_INFO[a].label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                  {r.enabled && r.autoscaler !== "none" && <ScalingRow id={id} env={env} row={r} />}
                  {open && (
                    <tr className="wl-details">
                      <td />
                      <td colSpan={7}>
                        <p><strong>Why:</strong> {r.def.why}</p>
                        {r.def.skip && <p><strong>Can be skipped if:</strong> {r.def.skip}</p>}
                        <p><strong>How it was sized</strong> ({r.calc.source === "official" ? "Grafana's official sizing guide" : "no official number: starting value"}): {r.calc.notes.join(" · ")}</p>
                        <p><strong>Scaling:</strong> {KIND_SCALING_NOTE[r.def.kind]} {AUTOSCALER_INFO[r.autoscaler].text}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td colSpan={3}>
                Total{runsOnRemote ? " per remote cluster" : ""}
                {rows.some((r) => r.enabled && r.def.kind === "DaemonSet") && <span className="muted"> (+ DaemonSet pods: one per node)</span>}
              </td>
              <td>{fmtNum(totals.cpu)} CPU</td>
              <td>{fmtNum(totals.mem)} Gi</td>
              <td>{totals.disk ? `${fmtNum(totals.disk)} Gi` : "—"}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  );
}

/** Shows the bounds and the exact configuration added for the chosen autoscaler. */
function ScalingRow({ id, env, row }: { id: ComponentId; env: string; row: SizedWorkload }) {
  const { resolved, setWorkload } = useStore();
  const [showCode, setShowCode] = useState(true);
  const wc = resolved.components[id].workloads?.[row.def.id] ?? {};
  const params = {
    min: wc.minReplicas ?? row.final.replicas,
    max: wc.maxReplicas ?? Math.max(row.final.replicas * 3, row.final.replicas + 1),
    targetCpu: wc.targetCpuPercent ?? (row.autoscaler === "keda" && id === "mimir" ? 100 : 70),
    vpaMode: wc.vpaMode ?? "Off",
  };
  const horizontal = row.autoscaler === "hpa" || row.autoscaler === "keda";
  const advice = horizontal && wc.vpaAdvice === true && row.def.autoscalers.includes("vpa");
  const dir = dirForEnv(resolved, env, row.perCluster);
  const snippets = [autoscalingSnippet(resolved, id, row, dir, params), advice ? vpaSnippet(resolved, id, row, dir, "Off") : null].filter(
    (x): x is Snippet => x !== null,
  );

  return (
    <tr className="wl-scaling">
      <td />
      <td colSpan={7}>
        <div className="scaling-head">
          <strong>{AUTOSCALER_INFO[row.autoscaler].label}</strong>
          {horizontal && (
            <>
              <label>
                min <input className="input input-sm" type="number" min={1} value={params.min} onChange={(e) => e.target.valueAsNumber > 0 && setWorkload(id, row.def.id, { minReplicas: e.target.valueAsNumber })} />
              </label>
              <label>
                max <input className="input input-sm" type="number" min={1} value={params.max} onChange={(e) => e.target.valueAsNumber > 0 && setWorkload(id, row.def.id, { maxReplicas: e.target.valueAsNumber })} />
              </label>
              <label>
                target CPU <input className="input input-sm" type="number" min={10} max={100} value={params.targetCpu} onChange={(e) => e.target.valueAsNumber > 0 && setWorkload(id, row.def.id, { targetCpuPercent: e.target.valueAsNumber })} /> %
              </label>
              {row.def.autoscalers.includes("vpa") && (
                <label title="A VPA in Off mode only gives advice, so it never conflicts with the HPA/KEDA.">
                  <input type="checkbox" checked={advice} onChange={(e) => setWorkload(id, row.def.id, { vpaAdvice: e.target.checked })} /> also add VPA recommendations (Off mode)
                </label>
              )}
            </>
          )}
          {row.autoscaler === "vpa" && (
            <label>
              mode{" "}
              <select className="input input-sm input-wide" value={params.vpaMode} onChange={(e) => setWorkload(id, row.def.id, { vpaMode: e.target.value as "Off" | "Initial" })}>
                <option value="Off">Off: recommend only</option>
                <option value="Initial">Initial: apply on new pods</option>
              </select>
            </label>
          )}
          <button type="button" className="link-btn" onClick={() => setShowCode((v) => !v)}>
            {showCode ? "Hide" : "Show"} configuration
          </button>
        </div>
        {showCode &&
          snippets.map((sn) => (
            <div key={sn.file} className="snippet">
              <div className="snippet-file">{sn.file}</div>
              <pre>
                <code>{sn.yaml}</code>
              </pre>
              <ul>
                {sn.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          ))}
      </td>
    </tr>
  );
}

function SizeCell({
  row,
  field,
  env,
  k,
  setOverride,
  step,
  unit,
}: {
  row: SizedWorkload;
  field: keyof WorkloadOverride;
  env: string;
  k: string;
  setOverride: (env: string, key: string, field: keyof WorkloadOverride, value: number | undefined) => void;
  step: number;
  unit?: string;
}) {
  const value = row.final[field] ?? 0;
  const edited = row.overridden.includes(field);
  const adjusted = !edited && row.adjusted.includes(field);
  return (
    <td
      className={edited ? "is-edited" : adjusted ? "is-adjusted" : ""}
      title={adjusted ? `Recalculated from your other change to keep the same total capacity (calculated: ${row.calc[field]})` : undefined}
    >
      <span className="cell-edit">
        <input
          className="input input-sm"
          type="number"
          min={field === "replicas" ? 0 : step}
          step={step}
          value={value}
          disabled={!row.enabled}
          aria-label={`${row.def.name} ${field}`}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (Number.isFinite(n)) setOverride(env, k, field, n === row.calc[field] ? undefined : n);
          }}
        />
        {unit && <span className="unit">{unit}</span>}
        {edited && (
          <button type="button" className="reset" title={`Back to calculated value (${row.calc[field]})`} onClick={() => setOverride(env, k, field, undefined)}>
            ↺
          </button>
        )}
      </span>
    </td>
  );
}

export function hasPvc(cfg: PlannerConfig, id: ComponentId, env: string): boolean {
  return sizeComponent(cfg, id, env, false).some((r) => r.def.pvc && r.enabled);
}
