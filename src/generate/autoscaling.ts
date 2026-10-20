import type { ComponentId, PlannerConfig } from "../model/types";
import type { SizedWorkload } from "../sizing/engine";
import { NS } from "./common";

// Builds the exact configuration that is added for the autoscaler chosen on a workload,
// using the keys of each official chart (checked against the chart values files, 2026-10-18).

export const NAMESPACE = NS;

export interface Snippet {
  file: string;
  yaml: string;
  notes: string[];
}

export type VpaMode = "Off" | "Initial";

export interface ScalingParams {
  min: number;
  max: number;
  targetCpu: number;
  vpaMode: VpaMode;
}

/** Path of the workload's section in the chart values (dot-separated). */
const VALUES_KEY: Partial<Record<ComponentId, Record<string, string>>> = {
  mimir: {
    distributor: "distributor",
    querier: "querier",
    "query-frontend": "query_frontend",
    ruler: "ruler",
    gateway: "gateway",
  },
  loki: {
    distributor: "distributor",
    querier: "querier",
    "query-frontend": "queryFrontend",
    gateway: "gateway",
    read: "read",
  },
  tempo: {
    distributor: "distributor",
    querier: "querier",
    "query-frontend": "queryFrontend",
    "backend-worker": "backendWorker",
    gateway: "gateway",
  },
  pyroscope: { distributor: "distributor", querier: "querier" },
  grafana: { grafana: "" },
  langfuse: { web: "langfuse.web", worker: "langfuse.worker" },
  prometheus: { "alloy-metrics": "controller" },
  "cloud-logs": { "alloy-cloud-logs": "controller" },
  "trace-collector": { "trace-collector": "controller" },
};

/** Name of the Kubernetes workload the chart creates (generated values set fullnameOverride = component id). */
export function workloadResourceName(id: ComponentId, wl: string): string {
  if (["grafana", "kube-state-metrics", "node-exporter", "alertmanager"].includes(id)) return id;
  if (["alloy-logs", "alloy-events", "cloud-logs", "trace-collector", "alloy-profiles", "beyla"].includes(id) || wl === "alloy-metrics") return id === "prometheus" ? "alloy-metrics" : id;
  if (id === "prometheus") return "prometheus-agent";
  return `${id}-${wl}`;
}

/** Values file of a component; `dir` is the cluster folder ("prod", "shared", "prod/gwc"). */
export function valuesFile(id: ComponentId, dir: string, remote: boolean): string {
  return `helm/${remote ? "remote" : "central"}/${dir}/${id}/values.yaml`;
}

function nest(path: string, body: string): string {
  if (!path) return body;
  const parts = path.split(".");
  return parts
    .reduceRight((inner, key, i) => {
      const indent = "  ".repeat(i);
      return `${indent}${key}:\n${inner}`;
    }, body.split("\n").map((l) => "  ".repeat(parts.length) + l).join("\n"));
}

export function autoscalingSnippet(cfg: PlannerConfig, id: ComponentId, w: SizedWorkload, dir: string, p: ScalingParams): Snippet | null {
  const remote = w.perCluster;
  const file = valuesFile(id, dir, remote);
  const key = VALUES_KEY[id]?.[w.def.id];
  const name = workloadResourceName(id, w.def.id);

  switch (w.autoscaler) {
    case "none":
      return null;

    case "hpa": {
      let body: string;
      if (id === "grafana") {
        body = `autoscaling:\n  enabled: true\n  minReplicas: ${p.min}\n  maxReplicas: ${p.max}\n  targetCPU: "${p.targetCpu}"`;
      } else if (id === "langfuse") {
        body = `hpa:\n  enabled: true\n  minReplicas: ${p.min}\n  maxReplicas: ${p.max}\n  targetCPUUtilizationPercentage: ${p.targetCpu}`;
      } else {
        body = `autoscaling:\n  enabled: true\n  minReplicas: ${p.min}\n  maxReplicas: ${p.max}\n  targetCPUUtilizationPercentage: ${p.targetCpu}`;
      }
      return {
        file,
        yaml: key === undefined ? body : nest(key, body),
        notes: [`The chart creates a HorizontalPodAutoscaler for ${name}.`, "Requires metrics-server (installed by default on AKS, EKS add-on, GKE)."],
      };
    }

    case "keda": {
      if (id === "mimir") {
        const body = `kedaAutoscaling:\n  enabled: true\n  minReplicaCount: ${p.min}\n  maxReplicaCount: ${p.max}\n  targetCPUUtilizationPercentage: ${p.targetCpu}\n  targetMemoryUtilizationPercentage: 100`;
        return {
          file,
          yaml:
            `# Global KEDA settings (once per Mimir release)\nkedaAutoscaling:\n  prometheusAddress: http://mimir-query-frontend.${NAMESPACE}.svc:8080/prometheus\n  customHeaders:\n    X-Scope-OrgID: meta-monitoring\n  pollingInterval: 10\n\n` +
            nest(key ?? w.def.id, body),
          notes: [
            `The chart creates a KEDA ScaledObject for ${name}, driven by its CPU/memory usage as stored in Mimir.`,
            "Requires the KEDA operator in the central cluster and Mimir's own metrics in the meta-monitoring tenant.",
          ],
        };
      }
      if (id === "loki") {
        const body = `kedaAutoscaling:\n  enabled: true\n  minReplicas: ${p.min}\n  maxReplicas: ${p.max}`;
        return {
          file,
          yaml:
            `# Global KEDA settings (once per Loki release)\ndefaults:\n  kedaAutoscaling:\n    prometheusAddress: http://mimir-query-frontend.${NAMESPACE}.svc:8080/prometheus\n    customHeaders: "X-Scope-OrgID=meta-monitoring"\n\n` +
            nest(key ?? w.def.id, body),
          notes: [
            `The chart creates a KEDA ScaledObject for ${name}; its default trigger is the number of in-flight requests, so it scales before CPU saturates.`,
            "Requires the KEDA operator. Mutually exclusive with the HPA option.",
          ],
        };
      }
      if (id === "langfuse") {
        const body = `keda:\n  enabled: true\n  minReplicas: ${p.min}\n  maxReplicas: ${p.max}\n  triggerType: cpu\n  metricType: Utilization\n  value: "${p.targetCpu}"`;
        return { file, yaml: nest(key ?? w.def.id, body), notes: [`The chart creates a KEDA ScaledObject for ${name}.`, "Requires the KEDA operator."] };
      }
      return null;
    }

    case "vpa":
      return vpaSnippet(cfg, id, w, dir, p.vpaMode);
  }
}

const VPA_MODE_NOTE: Record<VpaMode, string> = {
  Off: 'updateMode "Off": the VPA only recommends requests and never restarts pods. Apply them in a planned rollout.',
  Initial: 'updateMode "Initial": recommendations are applied only when a pod is created anyway (rollout, node drain); running pods are never evicted.',
};

/** VerticalPodAutoscaler for a workload (used for "VPA" and for "VPA advice" next to HPA/KEDA). */
export function vpaSnippet(cfg: PlannerConfig, id: ComponentId, w: SizedWorkload, dir: string, mode: VpaMode): Snippet {
  const file = valuesFile(id, dir, w.perCluster);
  const key = VALUES_KEY[id]?.[w.def.id];
  const name = workloadResourceName(id, w.def.id);
  const requires = "Requires the Vertical Pod Autoscaler (AKS add-on; installed separately on EKS; built into GKE).";

  if (id === "langfuse") {
    const body = `vpa:
  enabled: true
  updatePolicy:
    updateMode: "${mode}"`;
    return { file, yaml: nest(key ?? w.def.id, body), notes: ["The Langfuse chart creates the VPA itself.", VPA_MODE_NOTE[mode], requires] };
  }

  const kind = w.def.kind === "DaemonSet" ? "DaemonSet" : w.def.kind === "StatefulSet" ? "StatefulSet" : "Deployment";
  const zoneAware = id === "mimir" && w.def.kind === "StatefulSet" && cfg.components[id]?.options.zoneAware && ["ingester", "store-gateway", "alertmanager"].includes(w.def.id);
  const targets = zoneAware ? ["a", "b", "c"].slice(0, cfg.topology.zones).map((z) => `${name}-zone-${z}`) : [name];
  const yaml = targets
    .map(
      (t) =>
        `apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ${t}
  namespace: ${NAMESPACE}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: ${kind}
    name: ${t}
  updatePolicy:
    updateMode: "${mode}"
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: ${Math.max(0.05, w.final.cpu / 2)}
          memory: ${Math.max(0.125, w.final.memoryGi / 2)}Gi
        maxAllowed:
          cpu: ${w.final.cpu * 4}
          memory: ${w.final.memoryGi * 4}Gi`,
    )
    .join("\n---\n");
  return {
    file: `${file.replace(/values\.yaml$/, "")}vpa-${w.def.id}.yaml`,
    yaml,
    notes: [
      "Separate manifest (the chart doesn't create a VPA for this workload).",
      VPA_MODE_NOTE[mode],
      `Read the recommendations with: kubectl describe vpa ${targets[0]} -n ${NAMESPACE}`,
      requires,
      ...(zoneAware ? ["One VPA per zone StatefulSet (zone-aware replication)."] : []),
    ],
  };
}
