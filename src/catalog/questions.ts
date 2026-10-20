import type { OptionValue, PlannerConfig } from "../model/types";

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  /** Shown as a warning when this option is selected */
  warning?: string;
}

interface QuestionBase {
  id: string;
  label: string;
  help?: string;
  /** Hide the question unless this returns true. `opts` = the current component's options. */
  visibleIf?: (cfg: PlannerConfig, opts: Record<string, OptionValue>) => boolean;
}

export type Question =
  | (QuestionBase & {
      kind: "choice";
      options: ChoiceOption[] | ((cfg: PlannerConfig) => ChoiceOption[]);
      layout?: "cards" | "select";
    })
  | (QuestionBase & { kind: "toggle" })
  | (QuestionBase & { kind: "number"; min?: number; max?: number; step?: number; unit?: string })
  | (QuestionBase & { kind: "text"; placeholder?: string })
  /** Several options; stored as a comma-separated list of values. */
  | (QuestionBase & { kind: "multi"; options: ChoiceOption[] | ((cfg: PlannerConfig) => ChoiceOption[]) });

/** Selected values of a "multi" question. */
export const multiValues = (v: OptionValue | undefined): string[] =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function resolveOptions(q: Question & { kind: "choice" | "multi" }, cfg: PlannerConfig): ChoiceOption[] {
  return typeof q.options === "function" ? q.options(cfg) : q.options;
}
