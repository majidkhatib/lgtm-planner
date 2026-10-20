# LGTM Planner

A guided planner for a **Grafana OSS observability platform** (Loki, Grafana, Tempo, Mimir, Pyroscope) with a central cluster and remote clusters, on **Azure, AWS or GCP**.

Answer one question at a time; each step explains what is being set up and why. The result is an architecture, sizing, a monthly cost estimate and ready-to-use Helm, Terraform and GitOps/pipeline files.

Live: https://m-shahidi.com/lgtm-planner/ · Specification: [SPEC.md](SPEC.md)

## Run locally

```bash
npm install
npm run dev        # http://127.0.0.1:5173/lgtm-planner/
```

`?step=<key>` opens a specific step, e.g. `?step=component:mimir`.

## Project layout

```
src/
├── catalog/      # data: clouds, components (explanations + questions), chart versions
├── model/        # PlannerConfig type, defaults, resolved config
├── state/        # store (React context) + share link (config in the URL hash)
├── steps/        # one screen per wizard step
└── ui/           # reusable controls
```

Everything runs in the browser; nothing is sent to a server.
