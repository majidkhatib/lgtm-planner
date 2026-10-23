// Welcome screen: what the planner does, how it works and what you get at the end.

const RESULTS: { tab: string; text: string }[] = [
  { tab: "Overview", text: "Every decision on one page, plus a link to share the plan with your team." },
  { tab: "Architecture", text: "A diagram of the central and remote clusters and how data flows between them (PNG or SVG)." },
  { tab: "Sizing", text: "Per cluster: node pools and VM types, and per component the replicas, CPU, memory and disk." },
  { tab: "Files", text: "A ZIP with Helm values, Terraform, Kubernetes manifests and your delivery setup (Argo CD, Flux or a pipeline), ready to commit." },
  { tab: "Cost", text: "A monthly estimate in EUR or USD, what it assumes, and whether a different layout would be cheaper." },
];

export function IntroStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="intro">
      <p className="intro-lead">
        Plan a self-hosted <strong>Grafana observability platform</strong> for Kubernetes on <strong>Azure, AWS or GCP</strong>,
        and get the files to build it. Metrics, logs, traces and profiles with Mimir, Loki, Tempo, Pyroscope and Grafana:
        one central cluster stores everything, your other clusters send their data to it.
      </p>
      <p className="muted">
        For platform and SRE teams that want to run Grafana OSS themselves and need to know up front how big it gets,
        what it costs and how to set it up.
      </p>

      <h2 className="intro-h">How it works</h2>
      <ol className="intro-steps">
        <li>
          <strong>Setup</strong>: cloud and region, environments, clusters, which signals you need, network and multi-tenancy.
          Eight short questions.
        </li>
        <li>
          <strong>Components</strong>: one step per component (collectors, Mimir, Loki, Tempo, Grafana, Alertmanager, …).
          Each explains what it does and why, with recommended defaults; skip what you don't need.
        </li>
        <li>
          <strong>Result</strong>: the plan, sized from your data volumes.
        </li>
      </ol>

      <h2 className="intro-h">What you get</h2>
      <dl className="intro-results">
        {RESULTS.map((r) => (
          <div key={r.tab}>
            <dt>{r.tab}</dt>
            <dd>{r.text}</dd>
          </div>
        ))}
      </dl>

      <h2 className="intro-h">Good to know</h2>
      <ul className="intro-notes">
        <li>Everything runs in your browser. Nothing you enter is sent to a server.</li>
        <li>Your answers are saved in this browser, so you can stop and come back. <em>Start over</em> in the step list clears them.</li>
        <li>With the defaults it takes about 10–15 minutes. Sizes and costs are a well-founded starting point, not a quote: check them against your real traffic.</li>
      </ul>

      <button type="button" className="btn btn-primary intro-start" onClick={onStart}>
        Start planning →
      </button>
    </div>
  );
}
