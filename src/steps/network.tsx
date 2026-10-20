import { Fragment } from "react";
import { CLOUDS } from "../catalog/clouds";
import { relevantComponents } from "../catalog/components";
import type { ChoiceOption } from "../catalog/questions";
import { hostnameFor } from "../model/defaults";
import type { ComponentId, IngressId, TenantKey } from "../model/types";
import { useStore } from "../state/store";
import { ChoiceCards, Explainer, Field, TextInput, Toggle } from "../ui/controls";

// ------------------------------------------------------------------ 6. Connectivity & security
export function ConnectivityStep() {
  const { config, update } = useStore();
  const c = config.connectivity;
  const cloud = CLOUDS[config.platform.cloud];

  const ingressOptions: ChoiceOption[] = [
    { value: "envoy-gateway", label: "Gateway API: Envoy Gateway", badge: "Recommended", description: "Gateway API is the successor of the Ingress object: richer routing, clean role separation." },
    { value: "istio", label: "Gateway API: Istio", description: "Choose if you already run Istio as a service mesh." },
    { value: "cloud-native", label: cloud.nativeL7, description: `Managed L7 load balancer of ${cloud.short}, configured from Kubernetes.` },
    { value: "haproxy", label: "HAProxy Ingress", description: "Fast, mature Ingress controller." },
    { value: "traefik", label: "Traefik", description: "Simple Ingress/Gateway controller with built-in middleware." },
    {
      value: "ingress-nginx",
      label: "ingress-nginx",
      description: "The community NGINX Ingress controller.",
      warning: "The community ingress-nginx project has been retired and gets no more updates or security fixes. Prefer a Gateway API option.",
    },
  ];

  return (
    <>
      <Explainer
        what="How remote clusters reach the central cluster, how that traffic is protected, and how secrets get into the clusters."
        why="Collectors push data continuously across cluster boundaries, so this path must be encrypted, authenticated and reliable."
      />
      <Field label="Network path from remote clusters to the central cluster">
        <ChoiceCards
          columns={2}
          value={c.path}
          options={[
            { value: "public", label: "Public endpoint (TLS + authentication)", description: "Works across clouds and regions. Simplest to set up." },
            { value: "private", label: `Private network (${cloud.privateLink})`, description: "Traffic never leaves the private network. More setup; avoids internet egress." },
          ]}
          onChange={(v) => update((d) => void (d.connectivity.path = v as typeof c.path))}
        />
      </Field>
      <Field label="How do remote clusters authenticate?">
        <ChoiceCards
          value={c.auth}
          options={[
            { value: "basic", label: "Basic auth per tenant", description: "A username/password per remote cluster, checked at the gateway. Easy to rotate via the secret store." },
            { value: "mtls", label: "Mutual TLS", description: "Each remote cluster has its own client certificate. Strongest, needs certificate management." },
            {
              value: "none",
              label: "Not needed: handled by existing infrastructure",
              description: "Your infrastructure team already controls access between clusters (private network, firewall rules, service mesh). No credentials are generated.",
              warning:
                c.path === "public"
                  ? "With a public endpoint and no authentication, anyone who can reach the address can write data. Only choose this if access is restricted in front of the gateway (IP allow-list, WAF, VPN)."
                  : undefined,
            },
          ]}
          onChange={(v) => update((d) => void (d.connectivity.auth = v as typeof c.auth))}
        />
      </Field>
      <Field label="Ingress / Gateway controller on the central cluster">
        <ChoiceCards options={ingressOptions} value={c.ingress} onChange={(v) => update((d) => void (d.connectivity.ingress = v as IngressId))} />
      </Field>
      <Field
        label="Base domain for the central services"
        help="Every service on the central cluster that needs an address gets a hostname under this domain: Grafana (opened by users in the browser) and the endpoints of Mimir, Loki, Tempo, Pyroscope and Langfuse (where remote clusters send their data). You can change each hostname on that component's step."
      >
        <TextInput value={c.baseDomain} placeholder="observability.example.com" onChange={(v) => update((d) => void (d.connectivity.baseDomain = v.trim()))} />
      </Field>
      <HostnamePreview />
      <Field label="TLS certificates" help="Every hostname above needs a certificate. Pick where it is created and renewed.">
        <ChoiceCards
          value={c.tls}
          options={[
            {
              value: "cert-manager",
              label: "cert-manager in the cluster",
              description: "Issues and renews certificates automatically (Let's Encrypt or your internal CA) and stores them as Kubernetes Secrets.",
            },
            {
              value: "edge-managed",
              label: "Managed at the cloud load balancer",
              description: `TLS ends at ${cloud.edgeCertificate}, typically one wildcard certificate for the whole domain. Nothing to create in the cluster, so cert-manager is skipped.`,
            },
            {
              value: "existing",
              label: "Existing certificate",
              description: `You already have a (wildcard) certificate. It is synced from ${cloud.secretStore} into the cluster as a TLS Secret.`,
            },
          ]}
          onChange={(v) => update((d) => void (d.connectivity.tls = v as typeof c.tls))}
        />
      </Field>
      <div className="field">
        <Toggle checked={c.externalDns} onChange={(v) => update((d) => void (d.connectivity.externalDns = v))} label={`external-dns: create DNS records in ${cloud.dns} automatically`} />
      </div>
      <Field label="Secrets" help={`Generated files never contain secrets. They are read from ${cloud.secretStore}.`}>
        <ChoiceCards
          columns={2}
          value={c.secrets}
          options={[
            { value: "eso", label: "External Secrets Operator", badge: "Recommended", description: `Syncs ${cloud.secretStore} entries into Kubernetes Secrets. Same setup on every cloud.` },
            { value: "csi", label: "Secrets Store CSI driver", description: "Mounts secrets as files from the secret store." },
          ]}
          onChange={(v) => update((d) => void (d.connectivity.secrets = v as typeof c.secrets))}
        />
      </Field>
    </>
  );
}

const HOSTED: { id: ComponentId; label: string; usedBy: string }[] = [
  { id: "grafana", label: "Grafana", usedBy: "users (browser)" },
  { id: "mimir", label: "Mimir", usedBy: "remote clusters → metrics" },
  { id: "loki", label: "Loki", usedBy: "remote clusters → logs" },
  { id: "tempo", label: "Tempo", usedBy: "remote clusters → traces" },
  { id: "pyroscope", label: "Pyroscope", usedBy: "remote clusters → profiles" },
  { id: "langfuse", label: "Langfuse", usedBy: "LLM apps + users (browser)" },
];

/** Shows the hostnames that will be generated for the components currently in the design. */
function HostnamePreview() {
  const { resolved } = useStore();
  const rows = relevantComponents(resolved)
    .filter((c) => resolved.components[c.id].enabled)
    .flatMap((c) => HOSTED.filter((h) => h.id === c.id));
  if (rows.length === 0) return null;
  return (
    <div className="mapping">
      <div className="mapping-title">Resulting hostnames</div>
      <dl>
        {rows.map((h) => (
          <Fragment key={h.id}>
            <dt>{h.label}</dt>
            <dd>
              <code>{hostnameFor(resolved, h.id)}</code> <span className="muted">· {h.usedBy}</span>
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ 7. Multi-tenancy
const TENANT_KEYS: ChoiceOption[] = [
  { value: "cluster", label: "Per cluster", description: "Each remote cluster is a tenant. Clear ownership of data and limits." },
  { value: "environment", label: "Per environment", description: "dev, stage, prod are separate tenants." },
  { value: "namespace", label: "Per namespace", description: "Fine-grained; useful when teams own namespaces." },
  { value: "team", label: "Per team", description: "Based on a team label on workloads." },
  { value: "application", label: "Per application", description: "Based on an app label." },
  { value: "custom", label: "Custom label", description: "Any label you choose." },
];

export function TenancyStep() {
  const { config, update } = useStore();
  const t = config.tenancy;
  return (
    <>
      <Explainer
        what="Mimir, Loki, Tempo and Pyroscope can keep data of different tenants strictly apart, using the X-Scope-OrgID header."
        why="Tenants get their own limits (one noisy team can't overload everyone), their own retention and access control. With cross-tenant queries, Grafana can still show everything together when needed."
        skip="You have one team and one environment, and no need for separation."
      />
      <div className="field">
        <Toggle checked={t.enabled} onChange={(v) => update((d) => void (d.tenancy.enabled = v))} label="Enable multi-tenancy" />
      </div>
      {t.enabled && (
        <>
          <Field label="What is a tenant?">
            <ChoiceCards options={TENANT_KEYS} value={t.key} onChange={(v) => update((d) => void (d.tenancy.key = v as TenantKey))} />
          </Field>
          {t.key === "custom" && (
            <Field label="Label name">
              <TextInput value={t.customLabel} placeholder="e.g. cost_center" onChange={(v) => update((d) => void (d.tenancy.customLabel = v.trim()))} />
            </Field>
          )}
          <div className="field">
            <Toggle checked={t.crossTenantQuery} onChange={(v) => update((d) => void (d.tenancy.crossTenantQuery = v))} label="Allow queries across tenants in Grafana" />
            <div className="field-help toggle-help">Enables tenant federation in the backends and adds an "all tenants" data source in Grafana (e.g. tenant-a|tenant-b).</div>
          </div>
        </>
      )}
    </>
  );
}
