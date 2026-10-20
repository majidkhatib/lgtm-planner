import { multiValues, resolveOptions, type Question } from "../catalog/questions";
import type { OptionValue, PlannerConfig } from "../model/types";
import { ChoiceCards, Field, MultiCards, NumberInput, Select, TextInput, Toggle } from "./controls";

/** Renders one data-driven question (used for component options). */
export function QuestionField({
  q,
  cfg,
  opts,
  onChange,
}: {
  q: Question;
  cfg: PlannerConfig;
  opts: Record<string, OptionValue>;
  onChange: (value: OptionValue) => void;
}) {
  if (q.visibleIf && !q.visibleIf(cfg, opts)) return null;
  const value = opts[q.id];

  switch (q.kind) {
    case "choice": {
      const options = resolveOptions(q, cfg);
      return (
        <Field label={q.label} help={q.help}>
          {q.layout === "select" ? (
            <Select options={options} value={String(value)} onChange={onChange} />
          ) : (
            <ChoiceCards options={options} value={String(value)} onChange={onChange} />
          )}
        </Field>
      );
    }
    case "multi": {
      const options = resolveOptions(q, cfg);
      const selected = multiValues(value);
      return (
        <Field label={q.label} help={q.help}>
          <MultiCards options={options} value={selected} onChange={(v) => onChange(options.map((o) => o.value).filter((x) => v.includes(x)).join(","))} />
        </Field>
      );
    }
    case "toggle":
      return (
        <div className="field">
          <Toggle checked={Boolean(value)} onChange={onChange} label={q.label} />
          {q.help && <div className="field-help toggle-help">{q.help}</div>}
        </div>
      );
    case "number":
      return (
        <Field label={q.label} help={q.help}>
          <NumberInput value={Number(value)} onChange={onChange} min={q.min} max={q.max} step={q.step} unit={q.unit} />
        </Field>
      );
    case "text":
      return (
        <Field label={q.label} help={q.help}>
          <TextInput value={String(value ?? "")} onChange={onChange} placeholder={q.placeholder} />
        </Field>
      );
  }
}
