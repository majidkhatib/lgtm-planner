import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { relevantComponents, type ComponentDef } from "./catalog/components";
import { VERSIONS_CHECKED } from "./catalog/versions";
import { ConnectivityStep, TenancyStep } from "./steps/network";
import { RegionsStep } from "./steps/regions";
import { DeliveryStep, EnvironmentsStep, PlatformStep, SignalsStep, TopologyStep } from "./steps/basics";
import { ComponentStep } from "./steps/ComponentStep";
import { IntroStep } from "./steps/intro";
import { ReviewStep } from "./steps/ReviewStep";
import { HASH_KEY } from "./state/share";
import { useStore } from "./state/store";

// Read before the store loads a shared link and cleans the address bar:
// someone opening a shared plan wants the result, not the welcome screen.
const OPENED_SHARED_LINK = new URLSearchParams(location.hash.slice(1)).has(HASH_KEY);

interface Step {
  key: string;
  section: string;
  title: string;
  render: () => ReactNode;
  /** For component steps: has the user answered Yes/No? */
  done?: boolean;
}

function buildSteps(components: ComponentDef[], answered: (id: ComponentDef["id"]) => boolean,
                    start: () => void): Step[] {
  return [
    { key: "intro", section: "Start", title: "What this planner does", render: () => <IntroStep onStart={start} /> },
    { key: "platform", section: "Setup", title: "Cloud & region", render: () => <PlatformStep /> },
    { key: "regions", section: "Setup", title: "Multi-region", render: () => <RegionsStep /> },
    { key: "delivery", section: "Setup", title: "Delivery method", render: () => <DeliveryStep /> },
    { key: "environments", section: "Setup", title: "Environments", render: () => <EnvironmentsStep /> },
    { key: "topology", section: "Setup", title: "Clusters & topology", render: () => <TopologyStep /> },
    { key: "signals", section: "Setup", title: "Signals", render: () => <SignalsStep /> },
    { key: "connectivity", section: "Setup", title: "Connectivity & security", render: () => <ConnectivityStep /> },
    { key: "tenancy", section: "Setup", title: "Multi-tenancy", render: () => <TenancyStep /> },
    ...components.map((c) => ({
      key: `component:${c.id}`,
      section: "Components",
      title: c.name,
      render: () => <ComponentStep def={c} />,
      done: answered(c.id),
    })),
    { key: "review", section: "Result", title: "Review", render: () => <ReviewStep /> },
  ];
}

export default function App() {
  const { config, resolved, reset } = useStore();
  // ?step=<key> opens a specific step (e.g. ?step=component:mimir); a shared link opens the result.
  const [currentKey, setCurrentKey] = useState(
    () => new URLSearchParams(location.search).get("step") ?? (OPENED_SHARED_LINK ? "review" : "intro"),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  const steps = useMemo(
    () => buildSteps(relevantComponents(resolved), (id) => config.components[id].enabled !== undefined,
                     () => go("platform")), // `go` only uses setters and a ref, so it needn't be a dependency
    [resolved, config.components],
  );

  // If the current step disappears (e.g. a signal was turned off), fall back to the review list position.
  const index = Math.max(0, steps.findIndex((s) => s.key === currentKey));
  const step = steps[index];

  const go = (key: string) => {
    setCurrentKey(key);
    setMenuOpen(false);
    mainRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    if (!steps.some((s) => s.key === currentKey)) setCurrentKey(steps[Math.min(index, steps.length - 1)].key);
  }, [steps, currentKey, index]);

  const sections = steps.reduce<Record<string, Step[]>>((acc, s) => ((acc[s.section] ??= []).push(s), acc), {});
  const componentSteps = steps.filter((s) => s.section === "Components");
  const componentNumber = componentSteps.findIndex((s) => s.key === step.key);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/">
            m-shahidi<span>.</span>com
          </a>
          <span className="topbar-title">LGTM Planner</span>
          <button type="button" className="menu-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            Steps ({index + 1}/{steps.length})
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className={`sidebar${menuOpen ? " is-open" : ""}`}>
          {Object.entries(sections).map(([section, items]) => (
            <div key={section} className="nav-section">
              <div className="nav-section-title">{section}</div>
              <ol>
                {items.map((s) => {
                  const i = steps.indexOf(s);
                  const state = s.key === step.key ? "current" : s.done || (s.section !== "Components" && i < index) ? "done" : "";
                  return (
                    <li key={s.key}>
                      <button type="button" className={`nav-item ${state}`} onClick={() => go(s.key)}>
                        <span className="nav-dot" aria-hidden="true" />
                        {s.title}
                        {s.section === "Components" && config.components[s.key.split(":")[1] as ComponentDef["id"]].enabled === false && (
                          <span className="nav-skip">skipped</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
          <div className="sidebar-foot">
            {confirmReset ? (
              <span>
                Clear all answers?{" "}
                <button type="button" className="link-btn danger" onClick={() => { reset(); setConfirmReset(false); go("platform"); }}>Yes</button>{" "}
                <button type="button" className="link-btn" onClick={() => setConfirmReset(false)}>No</button>
              </span>
            ) : (
              <button type="button" className="link-btn" onClick={() => setConfirmReset(true)}>Start over</button>
            )}
            <div className="muted small">Chart versions checked {VERSIONS_CHECKED}</div>
          </div>
        </aside>

        <main className="main" ref={mainRef}>
          <div className="step-head">
            <div className="step-kicker">
              {step.section}
              {componentNumber >= 0 && ` · ${componentNumber + 1} of ${componentSteps.length}`}
            </div>
            <h1>{step.title}</h1>
          </div>
          <div className="card">{step.render()}</div>
          <div className="pager">
            <button type="button" className="btn btn-outline" disabled={index === 0} onClick={() => go(steps[index - 1].key)}>
              ← Back
            </button>
            {index < steps.length - 1 && (
              <button type="button" className="btn btn-primary" onClick={() => go(steps[index + 1].key)}>
                Next: {steps[index + 1].title} →
              </button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
