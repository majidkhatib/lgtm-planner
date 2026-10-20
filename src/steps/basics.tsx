import { useState } from "react";
import { CLOUDS, DEFAULT_REGION, regionOptions } from "../catalog/clouds";
import { isMultiRegion, regionInfo, stackRegions } from "../model/regions";
import type { ChoiceOption } from "../catalog/questions";
import type { CloudId, DeliveryId, GitHostId, SignalId } from "../model/types";
import { useStore } from "../state/store";
import { ChoiceCards, Explainer, Field, NumberInput, Select, TextInput, Toggle } from "../ui/controls";

// ------------------------------------------------------------------ 1. Platform
export function PlatformStep() {
  const { config, update } = useStore();
  const cloud = CLOUDS[config.platform.cloud];

  return (
    <>
      <Explainer
        what="The cloud where the central observability cluster runs. Every generated file targets its services."
        why="Object storage, identity, secret store, disks, DNS and load balancers differ per cloud, so the Terraform, the Helm storage settings and the prices all depend on this choice."
      />
      <Field label="Where do you want to deploy the stack?">
        <ChoiceCards
          columns={3}
          value={config.platform.cloud}
          options={(Object.values(CLOUDS) as (typeof cloud)[]).map((c) => ({ value: c.id, label: c.name, description: `${c.kubernetes} · ${c.objectStorage}` }))}
          onChange={(v) =>
            update((d) => {
              d.platform.cloud = v as CloudId;
              d.platform.region = DEFAULT_REGION[v as CloudId];
              // Extra regions belong to the previous cloud.
              d.multiRegion.regions = [];
              d.multiRegion.remoteClusters = {};
            })
          }
        />
      </Field>
      <Field label="Region" help="Prices and available VM/disk types depend on the region.">
        <Select
          value={config.platform.region}
          options={regionOptions(config.platform.cloud)}
          onChange={(v) => update((d) => void (d.platform.region = v))}
        />
      </Field>
      <Field label="Currency for the cost estimate" help="Both are always calculated; this sets which one is shown first.">
        <ChoiceCards
          columns={2}
          value={config.platform.currency}
          options={[
            { value: "EUR", label: "EUR (€)" },
            { value: "USD", label: "USD ($)" },
          ]}
          onChange={(v) => update((d) => void (d.platform.currency = v as "EUR" | "USD"))}
        />
      </Field>
      <div className="mapping">
        <div className="mapping-title">What {cloud.short} services the design will use</div>
        <dl>
          <dt>Kubernetes</dt><dd>{cloud.kubernetes}</dd>
          <dt>Object storage</dt><dd>{cloud.objectStorage}</dd>
          <dt>Pod → storage access</dt><dd>{cloud.podIdentity}</dd>
          <dt>Secrets</dt><dd>{cloud.secretStore}</dd>
          <dt>Disks (PVCs)</dt><dd>{cloud.blockStorage}</dd>
          <dt>DNS</dt><dd>{cloud.dns}</dd>
        </dl>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ 2. Delivery
const DELIVERY_OPTIONS: ChoiceOption[] = [
  { value: "argocd", label: "Argo CD", badge: "GitOps", description: "Cluster pulls from Git; ApplicationSets generate one app per component and cluster. Drift is corrected automatically." },
  { value: "flux", label: "Flux", badge: "GitOps", description: "Cluster pulls from Git with HelmRelease + Kustomization objects. Lightweight, no UI." },
  { value: "azure-devops", label: "Azure DevOps Pipelines", badge: "Pipeline", description: "Pipeline runs helm upgrade per environment with approvals between stages." },
  { value: "github-actions", label: "GitHub Actions", badge: "Pipeline", description: "Workflow per environment, keyless cloud login via OIDC." },
  { value: "gitlab-ci", label: "GitLab CI/CD", badge: "Pipeline", description: "Stages per environment, OIDC login to the cloud." },
  { value: "helm", label: "Manual (Helm commands)", description: "A script with the helm commands in the right order. Good for a first try; no automation." },
];

export function DeliveryStep() {
  const { config, update } = useStore();
  const method = config.delivery.method;
  return (
    <>
      <Explainer
        what="How the generated Helm releases get onto the clusters."
        why="GitOps (Argo CD, Flux) keeps clusters in sync with Git and undoes manual changes; pipelines push changes when they run. The planner generates the matching manifests or pipeline files."
      />
      <Field label="How do you want to deploy it?">
        <ChoiceCards options={DELIVERY_OPTIONS} value={method} onChange={(v) => update((d) => void (d.delivery.method = v as DeliveryId))} />
      </Field>
      {(method === "argocd" || method === "flux") && (
        <>
          <Field
            label="Git platform for your configuration repository"
            help={`The planner generates a repository of configuration files (Helm values, ${method === "argocd" ? "Argo CD Applications" : "Flux HelmReleases"}, Terraform). You push it to your Git platform, and ${method === "argocd" ? "Argo CD" : "Flux"} reads it from there to keep the clusters in sync. This sets the Git URL format and credentials setup in the generated manifests. It has nothing to do with container images.`}
          >
            <Select
              value={config.delivery.gitHost}
              options={[
                { value: "github", label: "GitHub" },
                { value: "gitlab", label: "GitLab" },
                { value: "azure-repos", label: "Azure Repos" },
                { value: "bitbucket", label: "Bitbucket" },
              ]}
              onChange={(v) => update((d) => void (d.delivery.gitHost = v as GitHostId))}
            />
          </Field>
          <Field label="Repository URL (optional)" help="The one repository you push the generated files to. All environments live in it as folders (helm/central/dev, helm/central/prod…). Argo CD / Flux on every cluster watches this repo, so a merge to it is a deployment. Leave empty to fill it in later.">
            <TextInput value={config.delivery.repoUrl} placeholder="https://github.com/acme/observability-platform.git" onChange={(v) => update((d) => void (d.delivery.repoUrl = v))} />
          </Field>
        </>
      )}
      {method !== "argocd" && method !== "flux" && method !== "helm" && (
        <div className="note">The pipeline files are generated for {DELIVERY_OPTIONS.find((o) => o.value === method)?.label}, so the configuration repository lives on that platform.</div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ 3. Environments
export function EnvironmentsStep() {
  const { config, setEnvironments } = useStore();
  const [draft, setDraft] = useState("");
  const envs = config.environments;

  const add = () => {
    const name = draft.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (name && !envs.includes(name)) setEnvironments([...envs, name]);
    setDraft("");
  };

  return (
    <>
      <Explainer
        what="The stages you want observability for, such as dev, stage and prod."
        why="Each environment gets its own values overlay, tenants and sizing. Production usually needs more replicas, zone redundancy and longer retention than dev."
      />
      <Field label="Environments">
        <div className="chips">
          {envs.map((e) => (
            <span key={e} className="chip">
              {e}
              {envs.length > 1 && (
                <button type="button" aria-label={`Remove ${e}`} onClick={() => setEnvironments(envs.filter((x) => x !== e))}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="inline-add">
          <TextInput value={draft} placeholder="e.g. qa" onChange={setDraft} />
          <button type="button" className="btn btn-outline" onClick={add}>
            Add
          </button>
        </div>
      </Field>
    </>
  );
}

// ------------------------------------------------------------------ 4. Topology
export function TopologyStep() {
  const { config, update } = useStore();
  const t = config.topology;
  // With a single environment its name isn't shown, and "per environment vs shared" doesn't apply.
  const multiEnv = config.environments.length > 1;
  const regional = isMultiRegion(config) && config.multiRegion.model === "regional";
  const onlyEnv = config.environments[0];
  const setRemote = (e: string, n: number) => update((d) => void (d.topology.remoteClusters[e] = Math.max(0, Math.round(n))));
  return (
    <>
      <Explainer
        what="How many clusters there are and how they connect: remote clusters run the workloads and collectors; a central cluster runs Mimir, Loki, Tempo and Grafana."
        why="Keeping storage and query components in one central place means one Grafana for everything, and remote clusters stay light."
      />
      {multiEnv && (
        <Field label="Central cluster" help="The cost tab will compare both models, so you can see the difference before deciding.">
          <ChoiceCards
            columns={2}
            value={t.centralModel}
            options={[
              { value: "per-env", label: "One central cluster per environment", description: "Strong isolation: a dev overload can never affect prod observability. Costs more." },
              { value: "shared", label: "One shared central cluster", description: "All environments send to the same central stack, separated by tenants. Cheaper and simpler." },
            ]}
            onChange={(v) => update((d) => void (d.topology.centralModel = v as typeof t.centralModel))}
          />
        </Field>
      )}
      {regional ? (
        <Field label="Remote (workload) clusters per region" help="Each remote cluster writes to the stack of its own region.">
          <div className="table-wrap">
            <table className="wl-table">
              <thead>
                <tr>
                  <th>Region</th>
                  {config.environments.map((e) => (
                    <th key={e}>{multiEnv ? e : "Clusters"}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stackRegions(config).map((r) => (
                  <tr key={r}>
                    <td>{regionInfo(config, r).name}</td>
                    {config.environments.map((e) => (
                      <td key={e}>
                        <NumberInput
                          value={r === config.platform.region ? (t.remoteClusters[e] ?? 0) : (config.multiRegion.remoteClusters[r]?.[e] ?? 0)}
                          min={0}
                          max={200}
                          onChange={(n) =>
                            r === config.platform.region
                              ? setRemote(e, n)
                              : update((d) => {
                                  d.multiRegion.remoteClusters[r] ??= {};
                                  d.multiRegion.remoteClusters[r][e] = Math.max(0, Math.round(n));
                                })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Field>
      ) : multiEnv ? (
        <Field label="Remote (workload) clusters per environment">
          <div className="env-grid">
            {config.environments.map((e) => (
              <label key={e} className="env-cell">
                <span>{e}</span>
                <NumberInput value={t.remoteClusters[e] ?? 1} min={0} max={200} onChange={(n) => setRemote(e, n)} />
              </label>
            ))}
          </div>
        </Field>
      ) : (
        <Field label="Number of remote (workload) clusters">
          <NumberInput value={t.remoteClusters[onlyEnv] ?? 1} min={0} max={200} onChange={(n) => setRemote(onlyEnv, n)} />
        </Field>
      )}
      <Field
        label="Do you want to build the central observability cluster?"
        help="Remote clusters are your existing workload clusters, so only the central cluster can be created by the planner."
      >
        <ChoiceCards
          columns={2}
          value={t.createCentralCluster ? "yes" : "no"}
          options={[
            {
              value: "yes",
              label: `Yes, create it with Terraform (${CLOUDS[config.platform.cloud].kubernetes})`,
              description: "The cluster and its node pools are generated, sized for the components you choose.",
            },
            {
              value: "no",
              label: "No, use an existing cluster",
              description: "Terraform only creates storage, identities and secrets. The planner still recommends node pools for it.",
            },
          ]}
          onChange={(v) => update((d) => void (d.topology.createCentralCluster = v === "yes"))}
        />
      </Field>
      <Field
        label="Availability zones for the central cluster"
        help={
          t.createCentralCluster
            ? "3 zones survive the loss of a whole zone, and Mimir, Loki and Tempo can spread their replicas across them. Cross-zone traffic is billed by most clouds and is included in the cost."
            : "Not needed: your existing cluster already has its zones."
        }
      >
        <ChoiceCards
          columns={3}
          value={String(t.zones)}
          disabled={!t.createCentralCluster}
          options={[
            { value: "1", label: "1 zone", description: "Cheapest, no zone redundancy." },
            { value: "2", label: "2 zones" },
            { value: "3", label: "3 zones", badge: "Production" },
          ]}
          onChange={(v) => update((d) => void (d.topology.zones = Number(v) as 1 | 2 | 3))}
        />
      </Field>
    </>
  );
}

// ------------------------------------------------------------------ 5. Signals
const SIGNALS: { id: SignalId; label: string; backend: string; text: string }[] = [
  { id: "metrics", label: "Metrics", backend: "Mimir", text: "Numbers over time: CPU, request rate, error rate, latency. The basis for dashboards and most alerts." },
  { id: "logs", label: "Logs", backend: "Loki", text: "What the application wrote. Needed to find the cause once an alert tells you something is wrong." },
  { id: "traces", label: "Traces", backend: "Tempo", text: "The path of a single request through all services. Needs applications instrumented with OpenTelemetry." },
  { id: "profiles", label: "Profiles", backend: "Pyroscope", text: "Which function uses CPU/memory, continuously in production. Usually added last." },
  { id: "ai", label: "AI / LLM observability", backend: "Langfuse", text: "Prompts, responses, token usage, latency and cost of every LLM call, plus evaluations. For teams running LLM apps or agents." },
];

export function SignalsStep() {
  const { config, update } = useStore();
  return (
    <>
      <Explainer
        what="The kinds of telemetry remote clusters send to the central cluster."
        why="Each signal adds a backend, collectors and storage. Pick only what you'll use; you can add more later."
      />
      <div className="signal-grid">
        {SIGNALS.map((s) => (
          <div key={s.id} className={`signal${config.signals[s.id] ? " is-on" : ""}`}>
            <Toggle checked={config.signals[s.id]} onChange={(v) => update((d) => void (d.signals[s.id] = v))} label={`${s.label} → ${s.backend}`} />
            <p>{s.text}</p>
          </div>
        ))}
      </div>
    </>
  );
}
