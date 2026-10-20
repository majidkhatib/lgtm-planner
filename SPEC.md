# LGTM Planner — Specification (v1 draft)

> Status: **draft for review** · No code yet · Hosted at `https://m-shahidi.com/lgtm-planner`

## 1. Goal

A guided, browser-only runbook that designs a **Grafana OSS observability platform** (central cluster + remote clusters) for **Azure, AWS or GCP**, and produces everything needed to deploy it:

1. An **architecture diagram**
2. A **sizing** of every component (replicas, CPU/memory, PVC size and type, node pools)
3. A **monthly cost estimate** in **EUR and USD**, itemised
4. A **file tree** with all generated files: Helm `values.yaml`, Terraform, GitOps manifests or CI pipelines
5. A **ZIP download** and a **shareable link** to reload the same configuration

The user answers one question at a time. Every step explains **what** is being set up, **why** it is needed, and **when it is safe to skip**.

## 2. Principles

| Principle | Meaning |
|---|---|
| Open source only | Grafana OSS stack, Prometheus, Robusta OSS + HolmesGPT. No Grafana Cloud / Enterprise features. |
| No backend | Static React app. Nothing the user types leaves the browser. $0 hosting on the existing S3/CloudFront. |
| No secrets in output | Generated files reference secrets from the cloud secret store via External Secrets Operator; never contain values. |
| Latest stable | Charts and images pinned to the latest **stable** release from the **official** repos, shown as "verified with chart X on <date>". |
| Honest numbers | Sizing shows the **official** result and a **practical** result side by side. Costs show the price date and are labelled as estimates. |

## 3. Scope

| v1 | Later |
|---|---|
| Azure, AWS, GCP | On-prem / bare metal |
| Metrics, logs, traces, profiles | Synthetic monitoring, RUM (Faro) |
| ArgoCD, Flux, Azure DevOps, GitHub Actions, GitLab CI, manual Helm | Jenkins, Tekton, Crossplane |
| English UI | — |

## 4. Wizard flow

Each step = a card with a short technical explainer (What / Why / When to skip), the question(s), a recommended default, and **Yes → configure** / **No → skip**.

### Step 1 — Platform
- **Cloud provider:** Azure · AWS · GCP
- **Region** (drives prices and available VM/disk types)
- **Currency display:** EUR, USD (both always computed)

### Step 2 — Delivery method
- **GitOps:** ArgoCD (ApplicationSet / app-of-apps) · Flux (HelmRelease + Kustomization)
- **Pipeline:** Azure DevOps · GitHub Actions · GitLab CI
- **Manual:** Helm commands / helmfile
- Git host for the generated repo (used in GitOps source URLs)

### Step 3 — Environments
- List of environments (default `dev`, `stage`, `prod`; add/remove/rename)

### Step 4 — Topology
- **Central model:** one central cluster **per environment** · one **shared** central cluster for all environments
  - The review page shows the cost of both models so the user can compare
- **Remote clusters:** count per environment
- **Create Kubernetes clusters with Terraform?** Optional (default: *No, I already have clusters*). Cluster cost is included in the estimate either way.

### Step 5 — Signals
- Metrics · Logs · Traces · Profiles (each on/off; drives which components are offered)

### Step 6 — Connectivity & security
- **Remote → central path:** public endpoint (TLS + basic auth or mTLS) · private networking (Private Link / PrivateLink / Private Service Connect, or peering)
- **Ingress / Gateway:**

  | Option | Notes |
  |---|---|
  | Gateway API — Envoy Gateway | Recommended modern default |
  | Gateway API — Istio | If a mesh is already used |
  | HAProxy Ingress | |
  | Traefik | |
  | Cloud-native | Azure Application Gateway for Containers · AWS Load Balancer Controller · GKE Gateway |
  | ingress-nginx | Shown with a warning: community project retired |

- **cert-manager** (TLS certificates) — optional
- **external-dns** (DNS records) — optional
- **Secrets:** External Secrets Operator + cloud secret store (see §7)

### Step 7 — Multi-tenancy
- Off · On
- If on: **tenant key** — cluster · environment · namespace · team · application · custom label
- **Cross-tenant querying** in Grafana — on/off (enables federated queries in Mimir/Loki/Tempo and matching Grafana data sources)

### Step 8 — Components (walk-through)

| Group | Component | Runs on | Deployment modes | Default |
|---|---|---|---|---|
| Metrics | **Mimir** | central | monolithic · distributed | distributed for prod |
| Metrics | **Prometheus** (agent mode, remote_write) | remote (+ central self-monitoring) | — | yes |
| Metrics | Alloy (alternative collector) | remote | — | no |
| Metrics | kube-state-metrics, node-exporter | all | — | yes |
| Logs | **Loki** | central | monolithic · simple scalable (deprecation warning) · distributed | distributed for prod |
| Logs | **Alloy** — logs | remote | — | yes |
| Logs | Alloy — Kubernetes events | remote | — | yes |
| Logs | **Cloud platform logs** (firewall, load balancer, audit logs) via Alloy | central | Azure: Event Hubs (`loki.source.azure_event_hubs`) · AWS: Kinesis Data Firehose (`loki.source.awsfirehose`) · GCP: Pub/Sub (`loki.source.gcplog`) | optional; asks for its own GB/day because it can be large |
| Traces | **Tempo** (+ metrics-generator) | central | monolithic · distributed | distributed for prod |
| Traces | **Alloy** — OTLP receiver | remote | OpenTelemetry Collector as alternative | yes |
| Profiles | **Pyroscope** | central | monolithic · distributed | monolithic |
| Profiles | Alloy — profiles | remote | — | yes |
| UI | **Grafana** | central | single · HA (needs external DB: Azure PostgreSQL Flexible / RDS / Cloud SQL) | single for dev, HA for prod |
| Alerting | **Alertmanager** | central | **standalone** · Mimir built-in | standalone |
| AIOps | **Robusta OSS + HolmesGPT** | central | — | optional |
| AIOps | LLM provider | — | Azure OpenAI · AWS Bedrock · GCP Vertex AI · OpenAI · self-hosted | matches the chosen cloud |
| Caching | Memcached (Mimir/Loki/Tempo) | central | — | yes when distributed |
| Pipeline | **Kafka** — only shown when needed | central | managed (Azure Event Hubs Kafka endpoint / Amazon MSK / GCP Managed Kafka) · Strimzi operator · bundled single broker (dev only) | managed |

**Architecture notes (verified 2026-10-18):**
- **Mimir 3** offers two write-path architectures: **ingest storage** (Grafana's preferred; writes go through **Kafka**) and **classic** (ingesters with local WAL, no Kafka). The wizard asks when Mimir is distributed.
- **Tempo 3 distributed** replaced ingesters with *distributor → Kafka → live-store + block-builder*, plus backend scheduler/workers. It **requires Kafka**. Monolithic Tempo doesn't.
- **Loki** modes: Monolithic · SimpleScalable (**deprecated, removed in Loki 4**) · Distributed.
- Chart sources: **Grafana, Loki, Tempo** charts now live in the **`grafana-community`** Helm repo; **Mimir, Alloy, Pyroscope** stay in `grafana`; Prometheus, Alertmanager, kube-state-metrics, node-exporter in `prometheus-community`.

For each chosen component the wizard asks only what matters for it (mode, ingress host, retention, replication, zone awareness).

### Step 9 — Volumes, retention, usage
Per environment (with "copy from prod at X%" to speed up input):

| Signal | Input | If the user doesn't know |
|---|---|---|
| Metrics | active series | **estimated** from nodes, pods per node, scrape interval and enabled exporters |
| Logs | GB/day | — |
| Traces | spans/s **or** GB/day | estimated from services × requests/s × sampling rate |
| Profiles | number of profiled services | — |
| All | retention per signal — **user decides**; the step explains the trade-off (longer retention = more object storage cost, slower long-range queries) and shows a suggested default | suggested default pre-filled, always editable |
| Query load | number of Grafana users + dashboards | converted to queries/s |
| HA | availability zones, replication factor | 3 zones, RF 3 for prod |

### Step 10 — Review & export
Tabs:
1. **Architecture** — interactive diagram (PNG/SVG download)
2. **Sizing** — per component: official vs practical
3. **Cost** — per environment and total, EUR + USD, itemised; central-model comparison
4. **Files** — tree + file preview with syntax highlighting
5. **Export** — ZIP download · copy shareable link

## 5. Sizing engine

- Pure functions: `inputs → per-component plan` (replicas, CPU/memory requests & limits, PVC size, storage class, node pool).
- **Official profile:** coefficients taken from Grafana's published capacity-planning docs for Mimir, Loki, Tempo and Pyroscope. Each coefficient stored with its source URL and date.
- **Practical profile:** official result × per-component **calibration factor**, based on real production data. Until the factors are set, the UI labels the practical profile as "provisional".
  - Reference data points from a production platform:

    | Component | Replicas | Memory per ingester | Volume |
    |---|---|---|---|
    | Mimir ingester | 4 | 32 GiB | _tbd (active series)_ |
    | Loki ingester | 4 | 32 GiB (was 8 GiB before adding cloud firewall logs via Event Hub) | _tbd (GB/day before / after)_ |
- Node pools are bin-packed from the summed requests (+ DaemonSet overhead + headroom), choosing a VM family per cloud (general purpose vs memory optimised).
- PVC: size from ingester WAL/retention needs; class per cloud (§7).

## 6. Pricing engine

| Cost item | Source |
|---|---|
| Kubernetes control plane (AKS tier, EKS, GKE fee) | cloud price list |
| Node VMs (on-demand; reserved/savings plans as optional toggle) | cloud price list |
| Block storage (PVCs) | cloud price list |
| Object storage — GB stored, write/read requests, by retention | cloud price list |
| Load balancers / Application Gateway for Containers | cloud price list |
| Cross-zone and egress traffic (remote → central) | cloud price list |
| Managed DB for Grafana HA (if chosen) | cloud price list |
| LLM tokens for HolmesGPT (alerts/day × tokens per investigation) | provider price list |

- A **scheduled GitHub Action** (monthly) refreshes `prices/*.json` from:
  - Azure Retail Prices API (public, EUR available directly)
  - AWS Price List bulk files (public, USD)
  - GCP Cloud Billing Catalog API (API key as GitHub secret)
- USD↔EUR conversion uses the **ECB reference rate** fetched in the same job.
- Every price file carries `fetchedAt`; the UI shows "Prices as of <date>".

## 7. Cloud mapping

| Concern | Azure | AWS | GCP |
|---|---|---|---|
| Kubernetes | AKS | EKS | GKE |
| Object storage | Blob Storage | S3 | Cloud Storage |
| Pod identity to storage | Azure Workload Identity | EKS Pod Identity (IRSA alternative) | GKE Workload Identity Federation |
| Secret store (via ESO) | Key Vault | Secrets Manager | Secret Manager |
| PVC storage class | Premium SSD v2 / Premium SSD (ZRS option) | gp3 | Hyperdisk Balanced / pd-balanced |
| DNS (external-dns) | Azure DNS | Route 53 | Cloud DNS |
| Native L7 | App Gateway for Containers | AWS Load Balancer Controller | GKE Gateway |
| Private connectivity | Private Link / VNet peering | PrivateLink / VPC peering | Private Service Connect / VPC peering |
| Managed DB (Grafana HA) | PostgreSQL Flexible Server | RDS PostgreSQL | Cloud SQL PostgreSQL |
| LLM default | Azure OpenAI | Bedrock | Vertex AI |

## 8. Generated repository layout

Base values + per-environment overlays for central and remote clusters:

```
<project-name>/
├── README.md                     # how to deploy, in order
├── docs/
│   ├── ARCHITECTURE.md / .svg
│   ├── SIZING.md
│   └── COSTS.md
├── terraform/
│   ├── modules/
│   │   ├── object-storage/
│   │   ├── workload-identity/
│   │   ├── secret-store/
│   │   └── kubernetes-cluster/   # only if "create clusters" chosen
│   └── envs/<env>/               # main.tf, variables.tf, <env>.tfvars, backend.tf
├── helm/
│   ├── base/<component>/values.yaml
│   ├── central/<env>/<component>/values.yaml
│   └── remote/<env>/<component>/values.yaml
├── gitops/                       # ArgoCD OR Flux, depending on the choice
│   ├── argocd/
│   │   ├── projects/<env>.yaml
│   │   └── applicationsets/<central|remote>-<env>.yaml
│   └── flux/clusters/<cluster>/...
└── pipelines/                    # only if a pipeline tool was chosen
    └── azure-devops/ | github-actions/ | gitlab-ci/
```

## 9. Planner application

| Concern | Choice |
|---|---|
| Framework | React 19 + TypeScript + Vite 8 (static build, base path `/lgtm-planner/`) |
| State | Single typed `PlannerConfig` object; URL-encoded (compressed) for share links |
| Wizard content | Data-driven step/component definitions (text + questions + defaults), separate from UI code |
| YAML / HCL | Generated from typed templates per component × cloud × mode |
| Diagram | SVG generated from the config (central, remotes, flows per signal, storage, LB) |
| ZIP | Built in the browser (JSZip) |
| Versions | `versions.json` (chart + image per component), bumped by Renovate |

## 10. Quality & validation (CI in the `lgtm-planner` repo)

- Unit tests for the sizing and pricing functions
- Snapshot tests for generated files
- For a matrix of sample configs (each cloud × each delivery method × modes): `helm template` with the generated values against the pinned chart, then `kubeconform`; `terraform validate` on generated Terraform
- Lint + type check

## 11. Hosting & deployment

- Separate repo `lgtm-planner`, built by GitHub Actions, synced to `s3://<site-bucket>/lgtm-planner/`
- Same CloudFront distribution as the CV site; a CloudFront Function maps `/lgtm-planner/` → `/lgtm-planner/index.html`
- The GitHub OIDC deploy role trusts both repos, each limited to its own S3 path
- CV site "Projects" card links to `/lgtm-planner/`

## 12. Open items

1. Real production volumes behind the reference data points in §5 → sets the practical calibration factors
2. Exact list of HolmesGPT-supported LLM providers/models to offer (verify against the latest release at build time)
