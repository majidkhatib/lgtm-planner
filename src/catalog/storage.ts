import type { CloudId } from "../model/types";

export type Suitability = "recommended" | "good" | "avoid";

export interface StorageClassInfo {
  /** Kubernetes StorageClass name (built-in names are the cloud's; others are created by the generated manifests) */
  name: string;
  label: string;
  /** Underlying cloud disk/file type */
  backing: string;
  builtIn: boolean;
  zoneRedundant: boolean;
  suitability: Suitability;
  description: string;
  pros: string;
  cons: string;
}

// Every storage option a PVC can use on each cloud, including the ones that should NOT be used,
// so the user sees why. Long-term observability data lives in object storage; PVCs hold the
// ingester WAL, store-gateway index headers, compactor scratch space, Kafka logs, ClickHouse data.
//
// Rule of thumb for all clouds:
//  - Block SSD: right choice. Mimir/Loki/Tempo replicate data themselves (RF 3), so zonal disks are fine.
//  - Network file systems (NFS/SMB): avoid. TSDB/WAL need fast fsync and file locking; Grafana docs advise against them.
//  - HDD: avoid. Too few IOPS for WAL replay and compaction.
//  - Local NVMe: fastest, but the data is gone when the node is replaced. Only with replication and fast re-sync.

const FILE_SHARE_CONS = "Network file system (NFS/SMB): high latency on fsync and unreliable file locking. Mimir, Loki and Tempo docs advise against network file systems for their data directories.";

export const STORAGE_CLASSES: Record<CloudId, StorageClassInfo[]> = {
  azure: [
    {
      name: "managed-csi-premium",
      label: "Premium SSD (LRS)",
      backing: "Premium_LRS managed disk",
      builtIn: true,
      zoneRedundant: false,
      suitability: "recommended",
      description: "Built-in AKS class. Premium SSD replicated three times inside one zone.",
      pros: "Low latency and predictable IOPS; the usual choice for ingester WALs, Kafka and ClickHouse.",
      cons: "Zonal: if the zone fails, the pod can't start elsewhere until the zone is back (replicas in other zones keep serving).",
    },
    {
      name: "premium-ssd-v2",
      label: "Premium SSD v2",
      backing: "PremiumV2_LRS managed disk",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Size, IOPS and throughput are set independently (3,000 IOPS / 125 MB/s included).",
      pros: "Lower price per GB than Premium SSD (LRS) for the same IOPS/throughput, because performance isn't tied to disk size; best for large ingester, Kafka or ClickHouse disks.",
      cons: "Zonal only (no zone-redundant version); the node pool must be pinned to zones. Not available in every region; no host caching.",
    },
    {
      name: "managed-csi-premium-zrs",
      label: "Premium SSD (ZRS)",
      backing: "Premium_ZRS managed disk",
      builtIn: false,
      zoneRedundant: true,
      suitability: "good",
      description: "Premium SSD replicated synchronously across 3 zones.",
      pros: "The pod can restart in another zone with its disk; useful for single-replica stateful parts (compactor, backend-scheduler, Grafana SQLite).",
      cons: "Costs about 50 % more per GB than Premium SSD (LRS), and every write is confirmed by 3 zones, so write latency is slightly higher. Unnecessary when the component already keeps 3 copies in 3 zones (zone-aware replication).",
    },
    {
      name: "managed-csi",
      label: "Standard SSD (LRS)",
      backing: "StandardSSD_LRS managed disk",
      builtIn: true,
      zoneRedundant: false,
      suitability: "good",
      description: "Built-in AKS default class.",
      pros: "Cheapest SSD: about half the price per GB of Premium SSD (LRS). Fine for dev/test and small components.",
      cons: "Far fewer guaranteed IOPS than Premium SSD (performance relies on bursting): WAL replay after a restart can be slow at production volume.",
    },
    {
      name: "managed-csi-standard-zrs",
      label: "Standard SSD (ZRS)",
      backing: "StandardSSD_ZRS managed disk",
      builtIn: false,
      zoneRedundant: true,
      suitability: "good",
      description: "Standard SSD replicated across 3 zones.",
      pros: "The cheapest zone-redundant disk; enough for small single-replica volumes (Grafana SQLite, Alertmanager).",
      cons: "Same IOPS limits as Standard SSD (LRS), at a higher price per GB than the LRS version.",
    },
    {
      name: "ultra-disk",
      label: "Ultra Disk",
      backing: "UltraSSD_LRS managed disk",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Highest-performance managed disk; IOPS adjustable without downtime.",
      pros: "Sub-millisecond latency for extreme ingest rates.",
      cons: "Billed per GB plus per provisioned IOPS and MB/s, typically several times the cost of Premium SSD (LRS); needs Ultra-enabled node pools in specific zones. Rarely needed for observability.",
    },
    {
      name: "local-nvme",
      label: "Local NVMe (Azure Container Storage)",
      backing: "Ephemeral NVMe of L-/storage-optimised VMs",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Disks physically attached to the node.",
      pros: "Fastest option and no separate disk charge (included in the VM price); good for memcached extstore and caches.",
      cons: "Data is lost when the node is replaced or scaled down. Only for caches or replicated data with fast re-sync.",
    },
    {
      name: "managed-csi-hdd",
      label: "Standard HDD",
      backing: "Standard_LRS managed disk",
      builtIn: false,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Magnetic disk.",
      pros: "Lowest price per GB of all Azure disks.",
      cons: "Very low IOPS: WAL replay and compaction become painfully slow.",
    },
    {
      name: "azurefile-csi-premium",
      label: "Azure Files Premium (SMB/NFS)",
      backing: "Azure Files share",
      builtIn: true,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Built-in shared file storage (ReadWriteMany).",
      pros: "Can be mounted by many pods at once.",
      cons: FILE_SHARE_CONS,
    },
    {
      name: "azurefile-csi",
      label: "Azure Files Standard",
      backing: "Azure Files share",
      builtIn: true,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Built-in standard file share.",
      pros: "Cheap shared storage.",
      cons: FILE_SHARE_CONS + " Standard shares are also slower than any SSD disk.",
    },
  ],
  aws: [
    {
      name: "gp3",
      label: "EBS gp3",
      backing: "gp3 volume",
      builtIn: false,
      zoneRedundant: false,
      suitability: "recommended",
      description: "General-purpose SSD: 3,000 IOPS / 125 MB/s included, more can be added independently of size.",
      pros: "Best price/performance on AWS: about 20 % cheaper per GB than gp2, with 3,000 IOPS included regardless of size. Right for WALs, store-gateway, Kafka and ClickHouse.",
      cons: "Zonal: a pod is pinned to its disk's zone. Not the EKS default, so the class is created by the generated manifests.",
    },
    {
      name: "io2",
      label: "EBS io2 Block Express",
      backing: "io2 volume",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Provisioned-IOPS SSD with 99.999 % durability.",
      pros: "Highest, most consistent IOPS for very large ingesters or Kafka.",
      cons: "You pay for every provisioned IOPS on top of capacity, typically several times the cost of gp3. Rarely needed.",
    },
    {
      name: "io1",
      label: "EBS io1",
      backing: "io1 volume",
      builtIn: false,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Previous-generation provisioned-IOPS SSD.",
      pros: "High provisioned IOPS.",
      cons: "Costs about the same as io2 but with lower durability (99.8–99.9 % vs 99.999 %). Use io2 instead.",
    },
    {
      name: "gp2",
      label: "EBS gp2 (legacy default)",
      backing: "gp2 volume",
      builtIn: true,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Older default class on many EKS clusters.",
      pros: "Already exists on many clusters.",
      cons: "IOPS are tied to size (3 IOPS per GB: a 32 GB disk gets ~100 IOPS plus burst credits) and it costs about 20 % more per GB than gp3.",
    },
    {
      name: "local-nvme",
      label: "Instance store NVMe",
      backing: "Local NVMe of i4i/i7i/m7gd… instances",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Disks attached to the EC2 instance (local static provisioner).",
      pros: "Fastest option, and included in the instance price (no separate EBS charge); good for caches.",
      cons: "Data is lost when the instance stops or is replaced. Only for caches or replicated data.",
    },
    {
      name: "st1",
      label: "EBS st1 (throughput HDD)",
      backing: "st1 volume",
      builtIn: false,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Throughput-optimised magnetic volume.",
      pros: "About half the price per GB of gp3, for large sequential reads.",
      cons: "Low IOPS for random access; minimum size 125 GiB. Unsuitable for WAL and TSDB.",
    },
    {
      name: "sc1",
      label: "EBS sc1 (cold HDD)",
      backing: "sc1 volume",
      builtIn: false,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Lowest-cost magnetic volume.",
      pros: "Cheapest block storage on AWS (about a quarter of gp3 per GB).",
      cons: "Very low IOPS. For archives only.",
    },
    {
      name: "efs-sc",
      label: "Amazon EFS",
      backing: "EFS file system",
      builtIn: false,
      zoneRedundant: true,
      suitability: "avoid",
      description: "Shared NFS file system across zones (ReadWriteMany).",
      pros: "Multi-zone, shared by many pods.",
      cons: FILE_SHARE_CONS + " Also several times the price per GB of gp3.",
    },
  ],
  gcp: [
    {
      name: "premium-rwo",
      label: "SSD persistent disk (pd-ssd)",
      backing: "pd-ssd",
      builtIn: true,
      zoneRedundant: false,
      suitability: "recommended",
      description: "Built-in GKE class backed by SSD persistent disks.",
      pros: "High IOPS for WALs, Kafka and ClickHouse.",
      cons: "Zonal; about 70 % more per GB than pd-balanced.",
    },
    {
      name: "standard-rwo",
      label: "Balanced persistent disk (pd-balanced)",
      backing: "pd-balanced",
      builtIn: true,
      zoneRedundant: false,
      suitability: "good",
      description: "Default GKE class.",
      pros: "Good balance of price and performance; enough for small and medium setups.",
      cons: "About a sixth of pd-ssd's IOPS per GB, so WAL replay is slower on small disks.",
    },
    {
      name: "hyperdisk-balanced",
      label: "Hyperdisk Balanced",
      backing: "hyperdisk-balanced",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "IOPS and throughput provisioned independently of size.",
      pros: "Tunable performance; the only option on newer machine series (C3, C4, N4…).",
      cons: "Only on supported machine families.",
    },
    {
      name: "hyperdisk-balanced-ha",
      label: "Hyperdisk Balanced High Availability",
      backing: "hyperdisk-balanced-high-availability",
      builtIn: false,
      zoneRedundant: true,
      suitability: "good",
      description: "Hyperdisk replicated synchronously across two zones.",
      pros: "Pod can fail over to the second zone with its data.",
      cons: "About twice the price of zonal Hyperdisk Balanced (every write goes to two zones); unnecessary when the component keeps 3 copies in 3 zones.",
    },
    {
      name: "regional-pd-ssd",
      label: "Regional SSD persistent disk",
      backing: "pd-ssd, replication-type regional-pd",
      builtIn: false,
      zoneRedundant: true,
      suitability: "good",
      description: "pd-ssd replicated across two zones.",
      pros: "Zone failover for single-replica stateful parts.",
      cons: "About twice the price of zonal pd-ssd (every write goes to two zones), and it covers only 2 of the region's zones.",
    },
    {
      name: "hyperdisk-extreme",
      label: "Hyperdisk Extreme",
      backing: "hyperdisk-extreme",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Highest IOPS block storage on GCP.",
      pros: "For extreme ingest rates.",
      cons: "Billed per GB plus provisioned IOPS, several times the cost of pd-ssd; only on large machine types.",
    },
    {
      name: "hyperdisk-throughput",
      label: "Hyperdisk Throughput",
      backing: "hyperdisk-throughput",
      builtIn: false,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Throughput-optimised, HDD-like cost.",
      pros: "Lower price per GB than pd-balanced, for large sequential workloads.",
      cons: "Low IOPS; not suited to WAL or TSDB access patterns.",
    },
    {
      name: "local-ssd",
      label: "Local SSD",
      backing: "Local NVMe SSD",
      builtIn: false,
      zoneRedundant: false,
      suitability: "good",
      description: "Disks attached to the node.",
      pros: "Fastest; good for caches.",
      cons: "Data is lost when the node is replaced. Only for caches or replicated data.",
    },
    {
      name: "standard",
      label: "Standard persistent disk (pd-standard)",
      backing: "pd-standard (HDD)",
      builtIn: true,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Legacy HDD-backed class.",
      pros: "About a quarter of pd-ssd's price per GB.",
      cons: "Very low IOPS for WAL replay and compaction.",
    },
    {
      name: "premium-rwx",
      label: "Filestore (premium-rwx / standard-rwx)",
      backing: "Filestore NFS share",
      builtIn: true,
      zoneRedundant: false,
      suitability: "avoid",
      description: "Shared NFS file storage (ReadWriteMany).",
      pros: "Shared by many pods.",
      cons: FILE_SHARE_CONS + " Large minimum share size.",
    },
  ],
};

export function defaultStorageClass(cloud: CloudId): string {
  return (STORAGE_CLASSES[cloud].find((s) => s.suitability === "recommended") ?? STORAGE_CLASSES[cloud][0]).name;
}

/** Zone-redundant class of a cloud (AWS EBS has none). */
const ZONE_REDUNDANT: Record<CloudId, string | null> = { azure: "managed-csi-premium-zrs", aws: null, gcp: "regional-pd-ssd" };

/**
 * Recommended class for a component:
 *  - replicas spread over zones (zone-aware replication, RF 3): zonal disks, because every zone already holds a copy
 *  - otherwise, in a multi-zone cluster: zone-redundant disks, so a pod can restart in another zone with its data
 */
export function recommendedStorageClass(cloud: CloudId, zones: number, spreadsOverZones: boolean): { name: string; reason: string } {
  const zrs = ZONE_REDUNDANT[cloud];
  if (zones > 1 && !spreadsOverZones && zrs)
    return { name: zrs, reason: "This component doesn't spread its replicas over zones, so a zone-redundant disk lets a pod restart in another zone with its data." };
  if (zones > 1 && !spreadsOverZones)
    return { name: defaultStorageClass(cloud), reason: "EBS has no zone-redundant volumes: rely on replicas in several zones to survive a zone outage." };
  return {
    name: defaultStorageClass(cloud),
    reason: zones > 1 ? "Replicas are spread over zones, so every zone already holds a copy of the data: fast zonal disks are enough." : "Single-zone cluster: zone-redundant disks bring no benefit.",
  };
}
