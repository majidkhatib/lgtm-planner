import { CLOUDS } from "../catalog/clouds";
import { componentLabel, runsOnCentral, runsOnRemote } from "../catalog/components";
import type { ComponentId, PlannerConfig, SignalId } from "../model/types";
import { isMultiRegion, regionInfo } from "../model/regions";
import { centralClusters, centralWorkloads, designComponents, hostOf, remotesOf } from "./common";

// Architecture diagram as a standalone SVG (used in the UI, the PNG export and docs/architecture.svg).

const COLORS: Record<SignalId, string> = { metrics: "#e8590c", logs: "#2f9e44", traces: "#1c7ed6", profiles: "#7048e8", ai: "#d6336c" };
const SIGNAL_OF: Partial<Record<ComponentId, SignalId>> = {
  mimir: "metrics",
  prometheus: "metrics",
  loki: "logs",
  "alloy-logs": "logs",
  "alloy-events": "logs",
  "cloud-logs": "logs",
  tempo: "traces",
  "trace-collector": "traces",
  pyroscope: "profiles",
  "alloy-profiles": "profiles",
  beyla: "traces",
  langfuse: "ai",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const box = (x: number, y: number, w: number, h: number, fill: string, stroke: string, r = 10, dash = false) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash ? ' stroke-dasharray="6 4"' : ""}/>`;
const text = (x: number, y: number, s: string, size = 13, weight = 400, fill = "#1a2129", anchor = "start") =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const arrow = (x1: number, y1: number, x2: number, y2: number, color: string, dash = false) => {
  const mx = (x1 + x2) / 2;
  return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="2"${dash ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#arrow-${color.slice(1)})"/>`;
};

function modeLabel(cfg: PlannerConfig, id: ComponentId): string {
  const o = cfg.components[id].options;
  if (id === "mimir") return o.architecture === "ingest" ? "distributed · ingest storage" : "distributed · classic";
  if (typeof o.mode === "string") return o.mode.replace("-", " ");
  return "";
}

export function architectureSvg(cfg: PlannerConfig): string {
  const comps = designComponents(cfg);
  const has = (id: ComponentId) => comps.some((c) => c.id === id);
  const envOrder = (e: string) => (e === "shared" ? 0 : cfg.environments.indexOf(e));
  const central = centralClusters(cfg)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (cfg.multiRegion.model === "standby" ? envOrder(a.c.env) - envOrder(b.c.env) || a.i - b.i : a.i - b.i))
    .map((x) => x.c);
  const multi = isMultiRegion(cfg);
  const activeActive = multi && cfg.multiRegion.model === "active-active";
  // Active-active: the remote clusters are drawn once (next to the first region) with arrows to every region.
  const remoteAnchors: { env: string; y: number }[] = [];
  // Primary storage position per environment, so each standby links to its own primary.
  const primaryStore: Record<string, { x: number; y: number }> = {};
  const cloud = CLOUDS[cfg.platform.cloud];

  const remoteComps = comps.filter((c) => runsOnRemote(cfg, c.id));
  const backends = (["mimir", "loki", "tempo", "pyroscope", "langfuse"] as ComponentId[]).filter(has);
  const extras = (["grafana", "alertmanager", "robusta", "kafka", "cloud-logs"] as ComponentId[]).filter((id) => has(id) && runsOnCentral(cfg, id));

  const W = 1240;
  const REMOTE_X = 24;
  const REMOTE_W = 270;
  const CENTRAL_X = 360;
  const CENTRAL_W = 600;
  const STORE_X = 1010;
  const STORE_W = 206;

  let y = 90;
  const parts: string[] = [];
  const arrows: string[] = [];

  // Title
  parts.push(text(24, 36, `Grafana LGTM on ${cloud.name} · ${cfg.platform.region}`, 20, 700));
  const legend = (Object.keys(COLORS) as SignalId[]).filter((s) => cfg.signals[s]);
  legend.forEach((s, i) => {
    const lx = 24 + i * 130;
    parts.push(`<line x1="${lx}" y1="58" x2="${lx + 26}" y2="58" stroke="${COLORS[s]}" stroke-width="3"/>`);
    parts.push(text(lx + 32, 62, s === "ai" ? "AI / LLM" : s[0].toUpperCase() + s.slice(1), 12, 500, "#5b6672"));
  });

  for (const c of central) {
    const blockTop = y;
    // ---- central cluster
    const rowH = 64;
    const backendRows = Math.ceil(backends.length / 3);
    const extraRows = Math.ceil(extras.length / 3);
    const centralH = 70 + 52 + backendRows * (rowH + 12) + (extraRows ? extraRows * (52 + 10) + 10 : 0) + 16;
    const standby = c.role === "standby";
    parts.push(box(CENTRAL_X, y, CENTRAL_W, centralH, standby ? "#f6f7f9" : "#f3f8f6", standby ? "#9aa7b4" : "#1fb77a", 14, standby));
    parts.push(text(CENTRAL_X + 16, y + 26, `${c.name}${standby ? "  ·  STANDBY (not deployed until failover)" : ""}`, 15, 700, standby ? "#5b6672" : "#1a2129"));
    parts.push(
      text(
        CENTRAL_X + 16,
        y + 44,
        `${cloud.kubernetes}${multi ? ` · ${regionInfo(cfg, c.region).name}` : ""} · ${cfg.topology.zones} zone(s)${cfg.topology.createCentralCluster ? " · created by Terraform" : ""}`,
        11.5,
        400,
        "#5b6672",
      ),
    );

    // ingress / gateway bar
    const gy = y + 58;
    parts.push(box(CENTRAL_X + 16, gy, CENTRAL_W - 32, 40, "#ffffff", "#9aa7b4", 8));
    const ing = { "envoy-gateway": "Envoy Gateway", istio: "Istio Gateway", "cloud-native": cloud.nativeL7, haproxy: "HAProxy Ingress", traefik: "Traefik", "ingress-nginx": "ingress-nginx" }[cfg.connectivity.ingress];
    parts.push(text(CENTRAL_X + 28, gy + 25, `${ing} · TLS ${cfg.connectivity.tls === "edge-managed" ? "at the cloud edge" : cfg.connectivity.tls === "cert-manager" ? "by cert-manager" : "existing cert"} · auth ${cfg.connectivity.auth === "none" ? "by infrastructure" : cfg.connectivity.auth}`, 12, 500));

    // backends grid
    const cellW = (CENTRAL_W - 32 - 2 * 12) / 3;
    const backendPos: Partial<Record<ComponentId, { x: number; y: number; w: number; h: number }>> = {};
    backends.forEach((id, i) => {
      const bx = CENTRAL_X + 16 + (i % 3) * (cellW + 12);
      const by = gy + 52 + Math.floor(i / 3) * (rowH + 12);
      const color = COLORS[SIGNAL_OF[id]!];
      const workloads = centralWorkloads(c, id).filter((w) => w.def.kind !== "Managed");
      const pods = workloads.reduce((a, w) => a + w.final.replicas, 0);
      parts.push(box(bx, by, cellW, rowH, "#ffffff", color, 8));
      parts.push(`<rect x="${bx}" y="${by}" width="5" height="${rowH}" rx="2" fill="${color}"/>`);
      parts.push(text(bx + 14, by + 22, comps.find((x) => x.id === id)!.name.replace("Grafana ", ""), 14, 700));
      parts.push(text(bx + 14, by + 40, modeLabel(cfg, id), 11, 400, "#5b6672"));
      parts.push(text(bx + 14, by + 56, `${workloads.length} workloads · ${pods} pods`, 11, 400, "#5b6672"));
      backendPos[id] = { x: bx, y: by, w: cellW, h: rowH };
      // ingress -> backend
      arrows.push(`<line x1="${bx + cellW / 2}" y1="${gy + 40}" x2="${bx + cellW / 2}" y2="${by - 2}" stroke="${color}" stroke-width="1.5" marker-end="url(#arrow-${color.slice(1)})"/>`);
    });

    // extras row (Grafana, Alertmanager, Robusta, Kafka, cloud logs)
    const ey = gy + 52 + backendRows * (rowH + 12) + 6;
    extras.forEach((id, i) => {
      const ex = CENTRAL_X + 16 + (i % 3) * (cellW + 12);
      const eyy = ey + Math.floor(i / 3) * 62;
      const label =
        id === "kafka"
          ? `Kafka · ${cfg.components.kafka.options.provider === "managed" ? "managed service" : cfg.components.kafka.options.provider === "strimzi" ? "Strimzi" : "bundled broker"}`
          : id === "alertmanager"
            ? componentLabel(cfg, id)
            : id === "grafana"
              ? `Grafana · ${cfg.components.grafana.options.ha === "ha" ? "HA" : "single"}`
              : id === "robusta"
                ? `Robusta + HolmesGPT`
                : "Cloud logs (Alloy)";
      parts.push(box(ex, eyy, cellW, 50, "#ffffff", "#5b6672", 8, id === "kafka" && cfg.components.kafka.options.provider === "managed"));
      parts.push(text(ex + 12, eyy + 30, label, 12.5, 600));
    });

    // ---- remote clusters of this central cluster
    let ry = blockTop;
    const sigsAll = [...new Set(remoteComps.map((rc) => SIGNAL_OF[rc.id]).filter((s): s is SignalId => !!s))];
    if (activeActive && remoteAnchors.length && !standby) {
      // Second active region: arrows from the remote clusters drawn next to the first region.
      for (const a of remoteAnchors) sigsAll.forEach((s, i) => arrows.push(arrow(REMOTE_X + REMOTE_W, a.y + 30 + i * 12, CENTRAL_X + 16, gy + 14 + i * 4, COLORS[s], true)));
    }
    for (const env of activeActive && remoteAnchors.length ? [] : c.serves) {
      const rs = remotesOf(c).filter((r) => r.env === env);
      if (!rs.length) continue;
      remoteAnchors.push({ env, y: ry });
      const h = 54 + remoteComps.length * 20 + 10;
      parts.push(box(REMOTE_X + 8, ry + 8, REMOTE_W, h, "#ffffff", "#9aa7b4", 12));
      parts.push(box(REMOTE_X + 4, ry + 4, REMOTE_W, h, "#ffffff", "#9aa7b4", 12));
      parts.push(box(REMOTE_X, ry, REMOTE_W, h, "#ffffff", "#5b6672", 12));
      parts.push(text(REMOTE_X + 14, ry + 24, `${rs.length} remote cluster${rs.length > 1 ? "s" : ""}${cfg.environments.length > 1 ? ` · ${env}` : ""}`, 14, 700));
      parts.push(text(REMOTE_X + 14, ry + 42, rs.length > 3 ? `${rs[0].name} … ${rs[rs.length - 1].name}` : rs.map((r) => r.name).join(", "), 11, 400, "#5b6672"));
      remoteComps.forEach((rc, i) => {
        const sig = SIGNAL_OF[rc.id];
        const yy = ry + 64 + i * 20;
        parts.push(`<circle cx="${REMOTE_X + 20}" cy="${yy - 4}" r="4" fill="${sig ? COLORS[sig] : "#9aa7b4"}"/>`);
        parts.push(text(REMOTE_X + 32, yy, componentLabel(cfg, rc.id), 12));
      });
      // one arrow per signal from remote to the gateway
      const sigs = [...new Set(remoteComps.map((rc) => SIGNAL_OF[rc.id]).filter((s): s is SignalId => !!s))];
      sigs.forEach((s, i) => arrows.push(arrow(REMOTE_X + REMOTE_W, ry + 30 + i * 12, CENTRAL_X + 16, gy + 14 + i * 4, COLORS[s])));
      ry += h + 22;
    }

    // ---- object storage
    const storeH = 40 + backends.length * 22 + 16;
    const sy = y + 58;
    parts.push(box(STORE_X, sy, STORE_W, storeH, "#fffaf0", "#d69e2e", 12, standby));
    parts.push(text(STORE_X + 14, sy + 24, standby ? `${cloud.objectStorage} (replica)` : cloud.objectStorage, 13, 700));
    const ps = primaryStore[c.env];
    if (standby && ps) {
      // Replication from the primary region's storage
      arrows.push(`<path d="M${ps.x + STORE_W / 2},${ps.y} L${STORE_X + STORE_W / 2},${sy}" fill="none" stroke="#d69e2e" stroke-width="2.5" stroke-dasharray="8 5" marker-end="url(#arrow-d69e2e)"/>`);
      parts.push(text(STORE_X + STORE_W / 2 + 8, (ps.y + sy) / 2, "replication", 12, 600, "#9a5b00"));
    }
    if (!standby) primaryStore[c.env] = { x: STORE_X, y: sy + storeH };
    backends.forEach((id, i) => {
      parts.push(text(STORE_X + 14, sy + 48 + i * 22, `▪ ${id}`, 12, 400, "#5b6672"));
      const p = backendPos[id]!;
      arrows.push(arrow(p.x + p.w, p.y + p.h / 2, STORE_X, sy + 44 + i * 22, "#d69e2e", true));
    });

    // users -> grafana
    if (has("grafana") && !standby) {
      primaryStore[c.env] = { x: STORE_X, y: sy + storeH + 30 + 56 };
      const uy = sy + storeH + 30;
      parts.push(box(STORE_X, uy, STORE_W, 56, "#ffffff", "#2b6cb0", 12));
      parts.push(text(STORE_X + 14, uy + 24, "Users (browser)", 13, 700));
      parts.push(text(STORE_X + 14, uy + 42, hostOf(cfg, "grafana", c.region), 10.5, 400, "#5b6672"));
      arrows.push(arrow(STORE_X, uy + 28, CENTRAL_X + CENTRAL_W - 16, gy + 20, "#2b6cb0"));
    }

    y = Math.max(y + centralH, ry) + 40;
  }

  const H = y + 10;
  const markers = [...Object.values(COLORS), "#d69e2e", "#2b6cb0"]
    .map((c) => `<marker id="arrow-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, system-ui, -apple-system, Roboto, Arial, sans-serif">
<defs>${markers}</defs>
<rect width="${W}" height="${H}" fill="#ffffff"/>
${arrows.join("\n")}
${parts.join("\n")}
</svg>`;
}
