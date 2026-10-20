import { useId, type ReactNode } from "react";
import type { ChoiceOption } from "../catalog/questions";

export function Explainer({ what, why, skip }: { what: ReactNode; why?: ReactNode; skip?: ReactNode }) {
  return (
    <div className="explainer">
      <div className="explainer-row">
        <span className="explainer-tag">What</span>
        <p>{what}</p>
      </div>
      {why && (
        <div className="explainer-row">
          <span className="explainer-tag tag-why">Why</span>
          <p>{why}</p>
        </div>
      )}
      {skip && (
        <div className="explainer-row">
          <span className="explainer-tag tag-skip">Skip if</span>
          <p>{skip}</p>
        </div>
      )}
    </div>
  );
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {help && <div className="field-help">{help}</div>}
      {children}
    </div>
  );
}

export function ChoiceCards({
  options,
  value,
  onChange,
  columns,
  disabled,
}: {
  options: ChoiceOption[];
  value: string;
  onChange: (v: string) => void;
  columns?: number;
  disabled?: boolean;
}) {
  const name = useId();
  const selected = options.find((o) => o.value === value);
  return (
    <>
      <div className={`choice-grid${disabled ? " is-disabled" : ""}`} role="radiogroup" aria-disabled={disabled} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
        {options.map((o) => (
          <label key={o.value} className={`choice${o.value === value ? " is-selected" : ""}`}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={disabled} onChange={() => onChange(o.value)} />
            <span className="choice-head">
              <span className="choice-label">{o.label}</span>
              {o.badge && <span className="badge">{o.badge}</span>}
            </span>
            {o.description && <span className="choice-desc">{o.description}</span>}
          </label>
        ))}
      </div>
      {selected?.warning && <div className="warning">⚠ {selected.warning}</div>}
    </>
  );
}

export function Select({ options, value, onChange }: { options: ChoiceOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div className="number-input">
      <input
        className="input"
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="input" type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function YesNo({ value, onChange, recommended }: { value: boolean | undefined; onChange: (v: boolean) => void; recommended: boolean }) {
  return (
    <div className="yesno">
      <button type="button" className={`btn ${value === true ? "btn-primary" : "btn-outline"}`} onClick={() => onChange(true)}>
        Yes, set it up{recommended ? " (recommended)" : ""}
      </button>
      <button type="button" className={`btn ${value === false ? "btn-dark" : "btn-outline"}`} onClick={() => onChange(false)}>
        No, skip
      </button>
    </div>
  );
}
