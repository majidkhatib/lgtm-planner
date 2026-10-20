import { CLOUDS, regionOptions } from "../catalog/clouds";
import type { ChoiceOption } from "../catalog/questions";
import { effectiveReplication, regionInfo, replicationMethods, secondRegion, stackRegions } from "../model/regions";
import type { RegionModel, ReplicationMethod } from "../model/types";
import { useStore } from "../state/store";
import { ChoiceCards, Explainer, Field, Select, Toggle } from "../ui/controls";

const MODELS: ChoiceOption[] = [
  { value: "single", label: "Single region", description: "Everything runs in one region. Zones protect against a data-centre failure, not a region outage." },
  {
    value: "regional",
    label: "Regional stacks",
    badge: "Data residency",
    description: "A full stack in each region; remote clusters write to the stack of their own region. No cross-region traffic. Losing a region only affects that region's data.",
  },
  {
    value: "standby",
    label: "Standby region (replicated storage)",
    badge: "Lowest-cost DR",
    description:
      "The primary region runs everything. The cloud copies the object storage to a second region continuously. The second region's deployment is generated and kept ready; on failover you run one pipeline (or enable sync in GitOps) and DNS moves the same hostnames to it.",
  },
  {
    value: "active-active",
    label: "Active-active (dual write)",
    badge: "No data loss",
    description: "Both regions run a full stack and the collectors send every metric, log and trace to both. Survives a region loss without losing data, at about twice the cost.",
  },
];

const REPLICATION_TEXT: Record<ReplicationMethod, { label: string; description: string }> = {
  object: { label: "Object replication (any region)", description: "Copies new blobs to a storage account in the region you choose. Deletions aren't copied, so the replica gets a lifecycle rule matching your retention." },
  geo: { label: "Geo-redundant storage (paired region)", description: "RA-GZRS replicates everything, including deletions, to Azure's fixed paired region. On failover the same account becomes writable there." },
  crr: { label: "S3 Cross-Region Replication", description: "Copies every new object and delete marker to a versioned bucket in the second region, usually within minutes." },
  "dual-region": { label: "Dual-region bucket", description: "One bucket stored in both regions (same continent). Turbo replication puts every object in both regions within 15 minutes." },
};

export function RegionsStep() {
  const { config, resolved, update } = useStore();
  const m = config.multiRegion;
  const cloud = CLOUDS[config.platform.cloud];
  const primary = regionInfo(config, config.platform.region);
  const method = effectiveReplication(config);
  const geoPaired = m.model === "standby" && config.platform.cloud === "azure" && method === "geo";
  // GCP dual-region buckets only work within one continent.
  // Restricted regions can't host clusters; GCP dual-region buckets only exist within EU, US or Asia.
  const gcpDual = config.platform.cloud === "gcp" && m.model === "standby";
  const candidateFilter = (r: (typeof cloud.regions)[number]) => r.id !== primary.id && !r.restricted && (!gcpDual || (r.continent === primary.continent && ["europe", "america", "asia"].includes(primary.continent)));
  const candidates = cloud.regions.filter(candidateFilter);
  const second = secondRegion(config);
  const pairRestricted = geoPaired && !!second && !!regionInfo(config, second).restricted;

  const setModel = (model: RegionModel) =>
    update((d) => {
      d.multiRegion.model = model;
      if (model !== "single" && d.multiRegion.regions.length === 0 && candidates[0]) d.multiRegion.regions = [candidates[0].id];
    });

  return (
    <>
      <Explainer
        what="Whether the platform runs in more than one region of the cloud, and how the regions work together."
        why="Mimir, Loki and Tempo replicate data across zones, but one cluster can't be stretched across regions (too much latency). Multi-region always means separate stacks per region, plus replicated storage or dual writes."
        skip="One region with 3 zones is enough for most setups. Choose multi-region for data residency (EU data stays in the EU) or when a whole region outage must not stop observability."
      />
      <Field label="How should regions be used?">
        <ChoiceCards options={MODELS} value={m.model} onChange={(v) => setModel(v as RegionModel)} />
      </Field>

      {m.model === "regional" && (
        <Field label={`Additional regions (primary: ${primary.name})`} help="Each selected region gets its own central stack. You assign remote clusters to regions in the Clusters & topology step.">
          <div className="check-list">
            {regionOptions(config.platform.cloud, candidateFilter).map((r) => (
              <label key={r.value} className="check">
                <input
                  type="checkbox"
                  checked={m.regions.includes(r.value)}
                  onChange={(e) =>
                    update((d) => {
                      d.multiRegion.regions = e.target.checked ? [...d.multiRegion.regions, r.value] : d.multiRegion.regions.filter((x) => x !== r.value);
                    })
                  }
                />
                {r.label}
              </label>
            ))}
          </div>
        </Field>
      )}

      {m.model === "standby" && (
        <Field label="How is the storage copied to the standby region?" help={`${cloud.short}: ${cloud.storageReplication}.`}>
          <ChoiceCards
            options={replicationMethods(config).map((r) => ({ value: r, label: REPLICATION_TEXT[r].label, description: REPLICATION_TEXT[r].description }))}
            value={method}
            onChange={(v) => update((d) => void (d.multiRegion.replication = v as ReplicationMethod))}
          />
        </Field>
      )}

      {(m.model === "standby" || m.model === "active-active") && (
        <Field
          label={m.model === "standby" ? "Standby region" : "Second region"}
          help={
            geoPaired
              ? `Fixed by Azure: the geo-pair of ${primary.name}.`
              : gcpDual
                ? candidates.length
                  ? "Dual-region buckets need both regions in the same multi-region (EU, US or Asia)."
                  : "Dual-region buckets aren't available for this region's continent; choose another primary region or the active-active model."
                : undefined
          }
        >
          {geoPaired ? (
            <div className={pairRestricted ? "warning" : "note"}>
              {second ? regionInfo(config, second).name : "This region has no paired region; use object replication."}
              {pairRestricted &&
                " is a restricted region: the data can be replicated there, but deploying the standby cluster needs an access request from Microsoft. Choose object replication to use any region instead."}
            </div>
          ) : (
            <Select value={m.regions[0] ?? ""} options={regionOptions(config.platform.cloud, candidateFilter)} onChange={(v) => update((d) => void (d.multiRegion.regions = [v]))} />
          )}
        </Field>
      )}

      {m.model === "standby" && (
        <>
          <div className="field">
            <Toggle checked={m.mirrorKafka} onChange={(v) => update((d) => void (d.multiRegion.mirrorKafka = v))} label="Also replicate Kafka to the standby region" />
            <div className="field-help toggle-help">
              Without it, a failover loses what was received in the last ~2 hours but not yet written to object storage. With it ({cloud.kafkaReplication}), nothing is lost, but a small Kafka runs in the standby region all the time. Only relevant when Kafka is part of the design.
            </div>
          </div>
          <div className="warning">
            Failover: the standby deployment is generated with sync turned off. During an outage you start it (failover pipeline, or enable sync in Argo CD / resume Flux) and DNS ({cloud.dnsFailover}) points the same hostnames to it. The remote clusters' collectors don't need any change.
          </div>
        </>
      )}

      {m.model !== "single" && (
        <div className="mapping">
          <div className="mapping-title">Result</div>
          <dl>
            {stackRegions(resolved).map((r, i) => (
              <div key={r} className="contents">
                <dt>{regionInfo(config, r).name}</dt>
                <dd>{i === 0 ? "primary stack" : m.model === "standby" ? "standby stack (generated, not deployed)" : m.model === "active-active" ? "active stack (receives the same data)" : "regional stack"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}
