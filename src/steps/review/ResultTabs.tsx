import JSZip from "jszip";
import { useMemo, useState } from "react";
import { CLOUDS } from "../../catalog/clouds";
import { centralClusters, centralWorkloads, designComponents, isCentral, isRemote, remoteClusters, remoteWorkloads } from "../../generate/common";
import { architectureSvg } from "../../generate/diagram";
import { generateRepository, type GeneratedFile } from "../../generate/index";
import { recommendNodePools } from "../../generate/nodepools";
import type { PlannerConfig } from "../../model/types";

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ Architecture
export function ArchitectureTab({ cfg }: { cfg: PlannerConfig }) {
  const svg = useMemo(() => architectureSvg(cfg), [cfg]);

  const png = () => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const scale = 2; // sharp on high-DPI screens and in slides
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => b && download("architecture.png", b), "image/png");
    };
    img.src = url;
  };

  return (
    <>
      <div className="tab-actions">
        <button type="button" className="btn btn-primary" onClick={png}>Download PNG</button>
        <button type="button" className="btn btn-outline" onClick={() => download("architecture.svg", new Blob([svg], { type: "image/svg+xml" }))}>Download SVG</button>
        <span className="muted">Also included in the ZIP as docs/architecture.svg</span>
      </div>
      <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
    </>
  );
}

// ------------------------------------------------------------------ Sizing
export function SizingTab({ cfg }: { cfg: PlannerConfig }) {
  const central = centralClusters(cfg);
  const comps = designComponents(cfg);
  const cloud = CLOUDS[cfg.platform.cloud];
  return (
    <>
      {central.map((c) => {
        const pools = recommendNodePools(c);
        const rows = comps.filter((x) => isCentral(x.id, cfg)).flatMap((comp) => centralWorkloads(c, comp.id).filter((w) => w.def.kind !== "Managed").map((w) => ({ comp, w })));
        const tot = rows.reduce((a, { w }) => ({ cpu: a.cpu + w.final.cpu * w.final.replicas, mem: a.mem + w.final.memoryGi * w.final.replicas, disk: a.disk + (w.final.pvcGi ?? 0) * w.final.replicas, pods: a.pods + w.final.replicas }), { cpu: 0, mem: 0, disk: 0, pods: 0 });
        return (
          <section key={c.name} className="sizing-block">
            <h3>
              {c.name} <span className="muted">· {cloud.kubernetes}</span>
            </h3>
            <div className="stat-row">
              <div className="stat-box"><strong>{tot.pods}</strong><span>pods</span></div>
              <div className="stat-box"><strong>{Math.round(tot.cpu * 10) / 10}</strong><span>CPU requested</span></div>
              <div className="stat-box"><strong>{Math.round(tot.mem)} GiB</strong><span>memory requested</span></div>
              <div className="stat-box"><strong>{Math.round(tot.disk)} GiB</strong><span>disks (PVCs)</span></div>
            </div>
            <h4>Recommended node pools</h4>
            <div className="table-wrap">
              <table className="wl-table">
                <thead><tr><th>Pool</th><th>VM type</th><th>Nodes</th><th>Purpose</th><th>Based on</th></tr></thead>
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.name}>
                      <td><strong>{p.name}</strong></td>
                      <td><code>{p.vm.name}</code><div className="muted">{p.vm.vcpu} vCPU · {p.vm.memoryGi} GiB</div></td>
                      <td>{p.nodes}</td>
                      <td className="wl-role">{p.purpose}</td>
                      <td className="wl-role">{p.basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h4>Workloads</h4>
            <div className="table-wrap">
              <table className="wl-table">
                <thead><tr><th>Component</th><th>Workload</th><th>Type</th><th>Replicas</th><th>CPU / pod</th><th>Memory / pod</th><th>Disk / pod</th><th>Scaling</th></tr></thead>
                <tbody>
                  {rows.map(({ comp, w }) => (
                    <tr key={`${comp.id}.${w.def.id}`}>
                      <td>{comp.name}</td>
                      <td>{w.def.name}</td>
                      <td><span className={`kind kind-${w.def.kind}`}>{w.def.kind}</span></td>
                      <td>{w.final.replicas}</td>
                      <td>{w.final.cpu}</td>
                      <td>{w.final.memoryGi} Gi</td>
                      <td>{w.final.pvcGi ? `${w.final.pvcGi} Gi` : "—"}</td>
                      <td>{w.autoscaler === "none" ? "fixed" : w.autoscaler.toUpperCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {cfg.environments
        .filter((e) => remoteClusters(cfg).some((r) => r.env === e))
        .map((e) => (
          <section key={e} className="sizing-block">
            <h3>Remote clusters{cfg.environments.length > 1 ? ` · ${e}` : ""} <span className="muted">· per cluster</span></h3>
            <div className="table-wrap">
              <table className="wl-table">
                <thead><tr><th>Component</th><th>Type</th><th>Replicas</th><th>CPU / pod</th><th>Memory / pod</th><th>Disk / pod</th></tr></thead>
                <tbody>
                  {comps.filter((x) => isRemote(x.id, cfg)).flatMap((comp) =>
                    remoteWorkloads(cfg, e, comp.id).map((w) => (
                      <tr key={`${comp.id}.${w.def.id}`}>
                        <td>{w.def.name}</td>
                        <td><span className={`kind kind-${w.def.kind}`}>{w.def.kind}</span></td>
                        <td>{w.def.kind === "DaemonSet" ? "1 per node" : w.final.replicas}</td>
                        <td>{w.final.cpu}</td>
                        <td>{w.final.memoryGi} Gi</td>
                        <td>{w.final.pvcGi ? `${w.final.pvcGi} Gi` : "—"}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ))}
    </>
  );
}

// ------------------------------------------------------------------ Files
interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: GeneratedFile;
}

function buildTree(files: GeneratedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    let node = root;
    const parts = f.path.split("/");
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(p)) node.children.set(p, { name: p, path, children: new Map() });
      node = node.children.get(p)!;
      if (i === parts.length - 1) node.file = f;
    });
  }
  return root;
}

function Tree({ node, selected, onSelect, open, toggle, depth }: { node: TreeNode; selected: string; onSelect: (p: string) => void; open: Set<string>; toggle: (p: string) => void; depth: number }) {
  const entries = [...node.children.values()].sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name));
  return (
    <ul className="tree">
      {entries.map((n) =>
        n.file ? (
          <li key={n.path}>
            <button type="button" className={`tree-file${selected === n.path ? " is-selected" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(n.path)}>
              {n.name}
            </button>
          </li>
        ) : (
          <li key={n.path}>
            <button type="button" className="tree-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(n.path)}>
              {open.has(n.path) ? "▾" : "▸"} {n.name}/
            </button>
            {open.has(n.path) && <Tree node={n} selected={selected} onSelect={onSelect} open={open} toggle={toggle} depth={depth + 1} />}
          </li>
        ),
      )}
    </ul>
  );
}

export function FilesTab({ cfg }: { cfg: PlannerConfig }) {
  const files = useMemo(() => generateRepository(cfg), [cfg]);
  const tree = useMemo(() => buildTree(files), [files]);
  const [selected, setSelected] = useState("README.md");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["helm", "helm/central", "manifests", "terraform", "argocd", "flux", "flux/clusters", "docs", "scripts"]));
  const [copied, setCopied] = useState(false);
  const file = files.find((f) => f.path === selected) ?? files[0];

  const zip = async () => {
    const z = new JSZip();
    const folder = z.folder("observability-platform")!;
    for (const f of files) folder.file(f.path, f.content, f.path.endsWith(".sh") ? { unixPermissions: "755" } : undefined);
    download("observability-platform.zip", await z.generateAsync({ type: "blob", platform: "UNIX" }));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* blocked */
    }
  };

  return (
    <>
      <div className="tab-actions">
        <button type="button" className="btn btn-primary" onClick={zip}>Download ZIP ({files.length} files)</button>
        <span className="muted">Validated: every Helm release renders with <code>helm template</code> against the pinned chart versions.</span>
      </div>
      <div className="files">
        <div className="files-tree">
          <Tree
            node={tree}
            selected={file.path}
            onSelect={setSelected}
            open={open}
            toggle={(p) => setOpen((s) => {
              const n = new Set(s);
              if (n.has(p)) n.delete(p);
              else n.add(p);
              return n;
            })}
            depth={0}
          />
        </div>
        <div className="files-view">
          <div className="files-head">
            <code>{file.path}</code>
            <button type="button" className="link-btn" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
          </div>
          {file.path.endsWith(".svg") ? (
            <div className="diagram" dangerouslySetInnerHTML={{ __html: file.content }} />
          ) : (
            <pre className="code"><code>{file.content}</code></pre>
          )}
        </div>
      </div>
    </>
  );
}
