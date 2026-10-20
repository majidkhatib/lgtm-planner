import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { defaultConfig, defaultVolumes, resolvedConfig } from "../model/defaults";
import type { ComponentId, OptionValue, PlannerConfig, WorkloadChoice, WorkloadOverride } from "../model/types";
import { clearSaved, loadInitialConfig, persistConfig } from "./share";

interface Store {
  /** Raw answers (what the user actually set) */
  config: PlannerConfig;
  /** Answers with defaults filled in — use this for display and generation */
  resolved: PlannerConfig;
  update: (fn: (draft: PlannerConfig) => void) => void;
  setComponentEnabled: (id: ComponentId, enabled: boolean) => void;
  setComponentOption: (id: ComponentId, key: string, value: OptionValue) => void;
  setEnvironments: (envs: string[]) => void;
  setWorkload: (id: ComponentId, workload: string, patch: Partial<WorkloadChoice>) => void;
  /** value undefined = back to the calculated size */
  setOverride: (env: string, key: string, field: keyof WorkloadOverride, value: number | undefined) => void;
  /** tenant undefined = the default for all tenants; value undefined = back to the calculated value */
  setLimit: (env: string, id: ComponentId, key: string, value: OptionValue | undefined, tenant?: string) => void;
  reset: () => void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PlannerConfig>(loadInitialConfig);

  useEffect(() => {
    const t = setTimeout(() => persistConfig(config), 300);
    return () => clearTimeout(t);
  }, [config]);

  const update = useCallback((fn: (draft: PlannerConfig) => void) => {
    setConfig((prev) => {
      const draft = structuredClone(prev);
      fn(draft);
      return draft;
    });
  }, []);

  const setComponentEnabled = useCallback(
    (id: ComponentId, enabled: boolean) => update((d) => void (d.components[id].enabled = enabled)),
    [update],
  );

  const setComponentOption = useCallback(
    (id: ComponentId, key: string, value: OptionValue) => update((d) => void (d.components[id].options[key] = value)),
    [update],
  );

  // Keeps per-environment maps (remote cluster counts, volumes) in sync with the list.
  const setEnvironments = useCallback(
    (envs: string[]) =>
      update((d) => {
        d.environments = envs;
        d.topology.remoteClusters = Object.fromEntries(envs.map((e) => [e, d.topology.remoteClusters[e] ?? 1]));
        d.volumes = Object.fromEntries(envs.map((e) => [e, d.volumes[e] ?? defaultVolumes(e)]));
      }),
    [update],
  );

  const setWorkload = useCallback(
    (id: ComponentId, workload: string, patch: Partial<WorkloadChoice>) =>
      update((d) => {
        const c = d.components[id];
        c.workloads ??= {};
        c.workloads[workload] = { ...c.workloads[workload], ...patch };
      }),
    [update],
  );

  const setOverride = useCallback(
    (env: string, key: string, field: keyof WorkloadOverride, value: number | undefined) =>
      update((d) => {
        d.overrides ??= {};
        const envO = (d.overrides[env] ??= {});
        const o = (envO[key] ??= {});
        if (value === undefined) delete o[field];
        else o[field] = value;
        if (Object.keys(o).length === 0) delete envO[key];
      }),
    [update],
  );

  const setLimit = useCallback(
    (env: string, id: ComponentId, key: string, value: OptionValue | undefined, tenant?: string) =>
      update((d) => {
        const comp = ((d.limits ??= {})[env] ??= {})[id] ??= {};
        const target = tenant ? ((comp.tenants ??= {})[tenant] ??= {}) : (comp.defaults ??= {});
        if (value === undefined) delete target[key];
        else target[key] = value;
        if (tenant && comp.tenants && Object.keys(comp.tenants[tenant]).length === 0) delete comp.tenants[tenant];
      }),
    [update],
  );

  const reset = useCallback(() => {
    clearSaved();
    setConfig(defaultConfig());
  }, []);

  const resolved = useMemo(() => resolvedConfig(config), [config]);

  const value = useMemo(
    () => ({ config, resolved, update, setComponentEnabled, setComponentOption, setEnvironments, setWorkload, setOverride, setLimit, reset }),
    [config, resolved, update, setComponentEnabled, setComponentOption, setEnvironments, setWorkload, setOverride, setLimit, reset],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
