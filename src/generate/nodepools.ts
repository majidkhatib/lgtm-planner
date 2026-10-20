import type { CloudId } from "../model/types";
import { centralWorkloads, designComponents, isCentral, type CentralCluster } from "./common";

export interface VmType {
  name: string;
  vcpu: number;
  memoryGi: number;
  family: "general" | "memory";
}

// Current general-purpose (4 GiB/vCPU) and memory-optimised (8 GiB/vCPU) VM types per cloud.
export const VM_TYPES: Record<CloudId, VmType[]> = {
  azure: [
    { name: "Standard_D4s_v5", vcpu: 4, memoryGi: 16, family: "general" },
    { name: "Standard_D8s_v5", vcpu: 8, memoryGi: 32, family: "general" },
    { name: "Standard_D16s_v5", vcpu: 16, memoryGi: 64, family: "general" },
    { name: "Standard_E8s_v5", vcpu: 8, memoryGi: 64, family: "memory" },
    { name: "Standard_E16s_v5", vcpu: 16, memoryGi: 128, family: "memory" },
  ],
  aws: [
    { name: "m7i.xlarge", vcpu: 4, memoryGi: 16, family: "general" },
    { name: "m7i.2xlarge", vcpu: 8, memoryGi: 32, family: "general" },
    { name: "m7i.4xlarge", vcpu: 16, memoryGi: 64, family: "general" },
    { name: "r7i.2xlarge", vcpu: 8, memoryGi: 64, family: "memory" },
    { name: "r7i.4xlarge", vcpu: 16, memoryGi: 128, family: "memory" },
  ],
  gcp: [
    { name: "n2-standard-4", vcpu: 4, memoryGi: 16, family: "general" },
    { name: "n2-standard-8", vcpu: 8, memoryGi: 32, family: "general" },
    { name: "n2-standard-16", vcpu: 16, memoryGi: 64, family: "general" },
    { name: "n2-highmem-8", vcpu: 8, memoryGi: 64, family: "memory" },
    { name: "n2-highmem-16", vcpu: 16, memoryGi: 128, family: "memory" },
  ],
};

export interface NodePool {
  name: string;
  vm: VmType;
  nodes: number;
  purpose: string;
  /** what the recommendation is based on */
  basis: string;
}

const ALLOCATABLE_CPU = 0.9; // kubelet/system reservations
const ALLOCATABLE_MEM = 0.85;
const HEADROOM = 1.2; // room for rollouts, rescheduling after a node failure

/** Recommends node pools for a central cluster from the summed requests of its workloads. */
export function recommendNodePools(c: CentralCluster): NodePool[] {
  const cfg = c.cfg;
  const zones = cfg.topology.zones;
  let cpu = 0;
  let mem = 0;
  let largestPodMem = 0;
  let largestPodCpu = 0;
  for (const comp of designComponents(cfg).filter((x) => isCentral(x.id, cfg))) {
    for (const w of centralWorkloads(c, comp.id)) {
      if (w.def.kind === "Managed") continue;
      const replicas = w.def.kind === "DaemonSet" ? 0 : w.final.replicas;
      cpu += w.final.cpu * replicas;
      mem += w.final.memoryGi * replicas;
      largestPodMem = Math.max(largestPodMem, w.final.memoryGi);
      largestPodCpu = Math.max(largestPodCpu, w.final.cpu);
    }
  }

  const family: VmType["family"] = mem / Math.max(cpu, 0.1) > 6 ? "memory" : "general";
  const candidates = VM_TYPES[cfg.platform.cloud].filter((v) => v.family === family);
  // Smallest VM that fits the largest pod with room to spare and keeps the node count reasonable.
  const fits = (v: VmType) => largestPodMem <= v.memoryGi * ALLOCATABLE_MEM * 0.8 && largestPodCpu <= v.vcpu * ALLOCATABLE_CPU * 0.8;
  const nodesFor = (v: VmType) => {
    const n = Math.ceil(Math.max(cpu / (v.vcpu * ALLOCATABLE_CPU - 0.3), mem / (v.memoryGi * ALLOCATABLE_MEM - 1)) * HEADROOM);
    return Math.max(zones, Math.ceil(n / zones) * zones);
  };
  const vm = candidates.find((v) => fits(v) && nodesFor(v) <= 30) ?? candidates[candidates.length - 1];

  const system = VM_TYPES[cfg.platform.cloud].find((v) => v.vcpu === 4)!;
  return [
    {
      name: "system",
      vm: system,
      nodes: Math.max(2, zones),
      purpose: "Cluster add-ons (CoreDNS, ingress/gateway, cert-manager, external-secrets, KEDA, operators)",
      basis: "Fixed small pool, one node per zone",
    },
    {
      name: "observability",
      vm,
      nodes: nodesFor(vm),
      purpose: "Mimir, Loki, Tempo, Grafana and the other components chosen",
      basis: `${Math.round(cpu * 10) / 10} CPU and ${Math.round(mem)} GiB requested in total (mem/CPU ratio ${Math.round((mem / Math.max(cpu, 0.1)) * 10) / 10} → ${family === "memory" ? "memory-optimised" : "general-purpose"} VMs), ${Math.round((1 - ALLOCATABLE_CPU) * 100)} % CPU / ${Math.round((1 - ALLOCATABLE_MEM) * 100)} % memory reserved by Kubernetes, +20 % headroom, rounded to a multiple of ${zones} zone(s)`,
    },
  ];
}
