import { useMemo, useState } from "react";
import { alternativeModelTotal, COST_ASSUMPTIONS, costReport, PRICES, regionName, type CostLine } from "../../cost/engine";
import type { Currency, PlannerConfig } from "../../model/types";

export function CostTab({ cfg }: { cfg: PlannerConfig }) {
  const [cur, setCur] = useState<Currency>(cfg.platform.currency);
  const report = useMemo(() => costReport(cfg), [cfg]);
  const alt = useMemo(() => alternativeModelTotal(cfg), [cfg]);
  const rate = cur === "EUR" ? report.eurPerUsd : 1;
  const sym = cur === "EUR" ? "€" : "$";
  const fmt = (usd: number) => `${sym}${(usd * rate).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  const table = (lines: CostLine[]) => (
    <div className="table-wrap">
      <table className="wl-table cost-table">
        <thead>
          <tr>
            <th>Group</th>
            <th>Item</th>
            <th>How it's calculated</th>
            <th>Basis</th>
            <th className="num">Per month</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="muted">{l.group}</td>
              <td>{l.item}</td>
              <td className="wl-role">{l.detail}</td>
              <td>
                <span className={`basis basis-${l.basis === "price list" ? "pl" : "est"}`}>{l.basis}</span>
              </td>
              <td className="num">{fmt(l.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="tab-actions">
        <div className="lang-switch cur-switch" role="group" aria-label="Currency">
          {(["EUR", "USD"] as Currency[]).map((c) => (
            <button key={c} type="button" aria-pressed={cur === c} onClick={() => setCur(c)}>
              {c}
            </button>
          ))}
        </div>
        <span className="muted">
          List prices of {report.fetchedAt} ({PRICES.sources[cfg.platform.cloud] ?? "no source"}). {PRICES.sources.eur}.
        </span>
      </div>

      {report.missing.length > 0 && (
        <div className="warning">
          Missing price data: {report.missing.join("; ")}. Those items count as 0.
        </div>
      )}

      <div className="stat-row cost-total">
        <div className="stat-box">
          <strong>{fmt(report.totalUsd)}</strong>
          <span>estimated total per month</span>
        </div>
        {report.clusters.map((c) => (
          <div key={c.name} className="stat-box">
            <strong>{fmt(c.totalUsd)}</strong>
            <span>
              {c.name}
              {c.role === "standby" ? " (standby: storage only)" : ""}
            </span>
          </div>
        ))}
        {alt && (
          <div className="stat-box stat-alt">
            <strong>{fmt(alt.totalUsd)}</strong>
            <span>
              with {alt.model === "shared" ? "one shared central cluster" : "one central cluster per environment"} instead ({alt.totalUsd < report.totalUsd ? "saves" : "costs"}{" "}
              {fmt(Math.abs(report.totalUsd - alt.totalUsd))})
            </span>
          </div>
        )}
      </div>

      {report.clusters.map((c) => (
        <section key={c.name} className="sizing-block">
          <h3>
            {c.name} <span className="muted">· {regionName(cfg, c.region)}</span>
          </h3>
          {c.role === "standby" && (
            <div className="note">
              Standby: only the replicated storage costs money now. After a failover it costs about <strong>{fmt(c.ifRunningUsd ?? 0)}</strong> per month more while it runs (cluster, nodes, disks, load
              balancer).
            </div>
          )}
          {c.lines.length ? table(c.lines) : <p className="muted">No price data for this region.</p>}
        </section>
      ))}

      {report.other.length > 0 && (
        <section className="sizing-block">
          <h3>Other</h3>
          {table(report.other)}
        </section>
      )}

      <section className="sizing-block">
        <h3>What the estimate assumes</h3>
        <ul className="assumptions">
          <li>On-demand list prices without discounts. Reservations / savings plans typically cut compute by 30–60 %.</li>
          <li>Nodes: the recommended node pools from the Sizing tab, running 730 hours a month.</li>
          <li>
            Disks: every PVC at its size and storage class; Azure disks are priced by size tier (e.g. a 100 GiB disk is billed as the 128 GiB tier).
          </li>
          <li>
            Object storage: metrics {COST_ASSUMPTIONS.bytesPerSampleStored} bytes per sample, logs compressed to {COST_ASSUMPTIONS.logCompressionStored * 100} % of raw, traces and profiles to{" "}
            {COST_ASSUMPTIONS.traceCompression * 100} %, kept for your retention; requests estimated from the written volume.
          </li>
          <li>
            Network: data from remote clusters at {COST_ASSUMPTIONS.bytesPerSampleWire} bytes per sample and {COST_ASSUMPTIONS.logCompressionWire * 100} % of raw logs; every write is replicated to 2 more zones.
          </li>
          <li>Taxes, support plans and egress for people opening Grafana are not included.</li>
        </ul>
      </section>
    </>
  );
}
