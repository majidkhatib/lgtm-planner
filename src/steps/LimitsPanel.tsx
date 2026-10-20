import { useState } from "react";
import { LIMITS, limitRows, tenantList, tenantOverrides, type LimitRow } from "../limits/limits";
import type { ComponentId, OptionValue } from "../model/types";
import { useStore } from "../state/store";
import { Section } from "./panels";

const show = (v: OptionValue) => (typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "number" ? v.toLocaleString("en-US") : v);

function ValueInput({ row, value, onChange, placeholder }: { row: LimitRow; value: OptionValue | undefined; onChange: (v: OptionValue | undefined) => void; placeholder?: string }) {
  const d = row.def;
  if (d.kind === "toggle")
    return (
      <select className="input input-sm" value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
        {placeholder !== undefined && <option value="">default ({placeholder})</option>}
        <option value="true">on</option>
        <option value="false">off</option>
      </select>
    );
  return (
    <input
      className="input input-sm input-limit"
      type={d.kind === "number" ? "number" : "text"}
      value={value === undefined ? "" : String(value)}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(undefined);
        onChange(d.kind === "number" ? Number(raw) : raw);
      }}
    />
  );
}

export function LimitsPanel({ id, env }: { id: ComponentId; env: string }) {
  const { resolved, setLimit } = useStore();
  const [showTenants, setShowTenants] = useState(false);
  if (!LIMITS[id]) return null;
  const rows = limitRows(resolved, id, env);
  const tenants = tenantList(resolved, env);
  const overrides = tenantOverrides(resolved, id, env);
  const perTenant = rows.filter((r) => r.def.perTenant);

  return (
    <Section
      title="Tenant limits"
      hint={
        <>
          Calculated from the volume above{tenants.length > 1 ? ` for ${tenants.length} tenants` : ""}: the busiest tenant may send twice the average, never below the backend's own default. Written to the
          runtime configuration, so they can be changed later without restarts. Edit a value to set it for all tenants.
        </>
      }
    >
      <div className="table-wrap">
        <table className="wl-table">
          <thead>
            <tr>
              <th>Limit</th>
              <th>Value (all tenants)</th>
              <th>How it's calculated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.def.key}>
                <td>
                  <strong>{r.def.label}</strong> {r.def.unit && <span className="muted">({r.def.unit})</span>}
                  <div className="wl-role">{r.def.help}</div>
                  <code className="sc-name">{r.def.key}</code>
                </td>
                <td className={r.edited ? "is-edited" : ""}>
                  <span className="cell-edit">
                    <ValueInput row={r} value={r.value} onChange={(v) => setLimit(env, id, r.def.key, v === r.calculated ? undefined : v)} />
                    {r.edited && (
                      <button type="button" className="reset" title={`Back to calculated value (${show(r.calculated)})`} onClick={() => setLimit(env, id, r.def.key, undefined)}>
                        ↺
                      </button>
                    )}
                  </span>
                </td>
                <td className="wl-role">{r.formula}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {tenants.length > 0 && perTenant.length > 0 && (
        <>
          <button type="button" className="link-btn sc-toggle" aria-expanded={showTenants} onClick={() => setShowTenants((v) => !v)}>
            {showTenants ? "▾" : "▸"} Per-tenant overrides ({Object.keys(overrides).length} set, {tenants.length} tenants)
          </button>
          {showTenants && (
            <div className="table-wrap">
              <table className="wl-table">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    {perTenant.map((r) => (
                      <th key={r.def.key}>{r.def.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tenants.slice(0, 100).map((t) => (
                    <tr key={t}>
                      <td>
                        <code>{t}</code>
                      </td>
                      {perTenant.map((r) => {
                        const v = overrides[t]?.[r.def.key];
                        return (
                          <td key={r.def.key} className={v !== undefined ? "is-edited" : ""}>
                            <ValueInput row={r} value={v} placeholder={String(show(r.value))} onChange={(nv) => setLimit(env, id, r.def.key, nv, t)} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {tenants.length > 100 && <p className="muted">Showing the first 100 tenants.</p>}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
