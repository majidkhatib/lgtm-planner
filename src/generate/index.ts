import type { PlannerConfig } from "../model/types";
import { centralClusters, designComponents, type GeneratedFile } from "./common";
import { deliveryFiles } from "./delivery";
import { architectureSvg } from "./diagram";
import { docFiles } from "./docs";
import { helmFiles } from "./helm";
import { manifestFiles } from "./manifests";
import { terraformFiles } from "./terraform";

export type { GeneratedFile } from "./common";

/** Generates the complete repository for the given (resolved) configuration. */
export function generateRepository(cfg: PlannerConfig): GeneratedFile[] {
  const central = centralClusters(cfg);
  const ids = designComponents(cfg).map((c) => c.id);
  const files = [
    ...docFiles(cfg, central),
    { path: "docs/architecture.svg", content: architectureSvg(cfg) },
    ...helmFiles(cfg, central, ids),
    ...manifestFiles(cfg, central),
    ...terraformFiles(cfg, central),
    ...deliveryFiles(cfg, central),
  ];
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
