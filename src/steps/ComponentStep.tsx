import { useState } from "react";
import type { ComponentDef } from "../catalog/components";
import { CHARTS } from "../catalog/versions";
import { useStore } from "../state/store";
import { Explainer, YesNo } from "../ui/controls";
import { QuestionField } from "../ui/QuestionField";
import { LimitsPanel } from "./LimitsPanel";
import { EnvTabs, hasPvc, Section, StoragePanel, VolumePanel, WorkloadsPanel } from "./panels";

const RUNS_ON = { central: "Central cluster", remote: "Remote clusters", both: "Central + remote clusters" };

// The environment tab stays the same while moving between component steps.
let lastEnv: string | undefined;

export function ComponentStep({ def }: { def: ComponentDef }) {
  const { config, resolved, setComponentEnabled, setComponentOption } = useStore();
  const [envState, setEnvState] = useState(() => lastEnv ?? resolved.environments[resolved.environments.length - 1]);
  const env = resolved.environments.includes(envState) ? envState : resolved.environments[0];
  const setEnv = (e: string) => {
    lastEnv = e;
    setEnvState(e);
  };

  const answered = config.components[def.id].enabled;
  const enabled = resolved.components[def.id].enabled;
  const opts = resolved.components[def.id].options;
  const recommended = def.recommended(resolved);
  const remote = def.runsOn === "remote";
  const skipEffects = def.skipEffect?.(resolved) ?? [];

  const charts = def.id === "tempo" ? [opts.mode === "distributed" ? CHARTS.tempoDistributed : CHARTS.tempoMonolithic] : def.charts;
  const questions = def.questions.filter((q) => !q.visibleIf || q.visibleIf(resolved, opts));

  return (
    <>
      <div className="component-meta">
        <span className="pill">{RUNS_ON[def.runsOn]}</span>
        {charts.map((c) => (
          <span key={c.chart} className="pill pill-mono" title={`Helm repo: ${c.repo}`}>
            {c.chart} {c.version} · app {c.appVersion}
          </span>
        ))}
      </div>
      <Explainer what={def.what} why={def.why} skip={def.skip} />

      <YesNo value={answered} recommended={recommended} onChange={(v) => setComponentEnabled(def.id, v)} />

      {!enabled && answered === false && (
        <div className="note">
          Skipped. It won't be part of the design. You can change this any time.
          {skipEffects.length > 0 && (
            <ul className="effects">
              {skipEffects.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {enabled && def.enabledNote?.(resolved) && <div className="note">{def.enabledNote(resolved)}</div>}

      {enabled && (
        <>
          {questions.length > 0 && (
            <Section title="Configuration">
              {def.questions.map((q) => (
                <QuestionField key={q.id} q={q} cfg={resolved} opts={opts} onChange={(v) => setComponentOption(def.id, q.id, v)} />
              ))}
            </Section>
          )}

          {resolved.environments.length > 1 && (
            <div className="env-bar">
              <span className="muted">Environment:</span>
              <EnvTabs env={env} onChange={setEnv} />
            </div>
          )}
          <VolumePanel id={def.id} env={env} />
          {hasPvc(resolved, def.id, env) && <StoragePanel id={def.id} />}
          <WorkloadsPanel id={def.id} env={env} runsOnRemote={remote} />
          <LimitsPanel id={def.id} env={env} />
        </>
      )}
    </>
  );
}
