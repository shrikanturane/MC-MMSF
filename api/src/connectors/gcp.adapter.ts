import type { CloudAccountRef, CloudConnector, ControlContext, CostSummary, DiscoveredAsset, DiscoveredFinding, NetworkRule, NetworkRuleTarget, PowerAction, ProviderCredentials, ProvisionIdentity, ProvisionOptions, ProvisionResult, ProvisionSpec, TestResult } from './adapter';
import { runStages, ProvisionError } from './adapter';
import { getGcpToken } from './gcp.auth';
import { gcpOsVersion } from './os-version';

/**
 * Build the month-to-date cost-by-service query for a GCP BigQuery billing export.
 * Pure (table + clock in → SQL out) so the schema selection is unit-testable.
 *
 * GCP has three export schemas, distinguished by table name:
 *   - gcp_billing_export_focus_*       → FOCUS 1.0 (ServiceName / BilledCost / BillingCurrency / ChargePeriodStart)
 *   - gcp_billing_export_v1_*          → standard usage cost (service.description / cost / currency / invoice.month)
 *   - gcp_billing_export_resource_v1_* → detailed usage cost (same base schema as standard)
 */
export function buildGcpCostQuery(table: string, now: Date): { sql: string; schema: 'FOCUS' | 'standard' } {
  const isFocus = /_focus_/i.test(table) || /\bfocus\b/i.test(table);
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const month = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const sql = isFocus
    ? `SELECT ServiceName AS service, SUM(BilledCost) AS cost, ANY_VALUE(BillingCurrency) AS currency
         FROM \`${table}\`
         WHERE ChargePeriodStart >= TIMESTAMP('${monthStart}') AND ChargePeriodStart < TIMESTAMP('${nextMonth}')
         GROUP BY service ORDER BY cost DESC LIMIT 50`
    : `SELECT service.description AS service, SUM(cost) AS cost, ANY_VALUE(currency) AS currency
         FROM \`${table}\` WHERE invoice.month = '${month}'
         GROUP BY service ORDER BY cost DESC LIMIT 50`;
  return { sql, schema: isFocus ? 'FOCUS' : 'standard' };
}

/** Map a GCP Compute API failure to a phase-tagged ProvisionError with a remediation. */
function gcpProvisionError(phase: string, status: number, body: string): ProvisionError {
  const snippet = (body || '').slice(0, 280);
  const role = /disk/i.test(phase) ? 'roles/compute.storageAdmin' : /instance/i.test(phase) ? 'roles/compute.instanceAdmin.v1' : 'roles/compute.networkAdmin';
  let remediation = 'Check the service-account roles and inputs, then retry — no re-approval needed.';
  if (status === 403) {
    const b = snippet.toLowerCase();
    if (/billing/.test(b)) {
      // 403 "requires billing to be enabled" → IAM roles can't fix this; the PROJECT needs billing.
      const proj = (body.match(/[?&]project=([a-z0-9:-]+)/i) ?? body.match(/project[s]?\s*[#:]?\s*([a-z][a-z0-9-]{5,})/i) ?? [])[1];
      remediation = `Billing is NOT enabled on this GCP project — granting IAM roles will not fix it. Link a billing account at https://console.cloud.google.com/billing/enable${proj ? `?project=${proj}` : ''} then click ↻ Retry deploy — no re-approval needed.`;
    } else if (/has not been used in project|is disabled|not been enabled|serviceusage|accessnotconfigured/.test(b)) {
      remediation = 'The Compute Engine API is not enabled on this project. Enable it (gcloud services enable compute.googleapis.com, or in the Console), wait ~1 min, then click ↻ Retry deploy — no re-approval needed.';
    } else if (/quota|exceeded/.test(b)) {
      remediation = 'A GCP quota was exceeded (e.g. CPUs / in-use IPs in this region). Request more quota, or pick a smaller machine type / different region, then click ↻ Retry deploy — no re-approval needed.';
    } else {
      remediation = `Grant the service account ${role} on the project (and ensure the Compute Engine API is enabled), then click ↻ Retry deploy — no re-approval needed.`;
    }
  } else if (status === 409) {
    remediation = 'A network with this name already exists. Choose a different name or use the existing one.';
  } else if (status === 400) {
    remediation = 'Fix the name (lowercase letters, digits, hyphens; must start with a letter) / CIDR, then retry.';
  }
  return new ProvisionError(`${phase}: HTTP ${status} — ${snippet}`, phase, remediation);
}

/**
 * A clear, billing/API-aware message for a Compute DISCOVERY failure (shown as the connection's
 * "Last error"). The deploy path uses gcpProvisionError; discovery threw the raw JSON before — so a
 * billing-disabled project surfaced a cryptic "gcp compute 403: {…}" instead of the actual fix.
 */
function gcpComputeMessage(status: number, body: string): string {
  const snippet = (body || '').slice(0, 200);
  const b = snippet.toLowerCase();
  const proj = (body.match(/project[s]?\s*[#:]?\s*([a-z0-9][a-z0-9:-]{4,})/i) ?? [])[1];
  if (status === 403 && /billing/.test(b)) {
    return `GCP billing is not enabled on this project${proj ? ` (${proj})` : ''} — so Compute discovery is blocked. Authentication & permissions are fine; the project just needs an active billing account. Link one at https://console.cloud.google.com/billing/enable${proj ? `?project=${proj}` : ''} (staying on free tier keeps usage at $0), then re-sync. Granting IAM roles will NOT fix this.`;
  }
  if (status === 403 && /(has not been used|is disabled|not been enabled|serviceusage|accessnotconfigured)/.test(b)) {
    return `The Compute Engine API is not enabled on this GCP project — enable it (gcloud services enable compute.googleapis.com, or Console → APIs & Services → Enable), wait ~1 min, then re-sync.`;
  }
  if (status === 403) {
    return `GCP denied Compute discovery (403) — grant the service account "Compute Viewer" (roles/compute.viewer) on the project, then re-sync. Detail: ${snippet}`;
  }
  return `gcp compute ${status}: ${snippet}`;
}

const GCP_SEV: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

/**
 * Real GCP connector. Auth via a Service Account JSON key (recommended — long-lived; the SA may
 * hold Owner/"root-like" or just Viewer/Compute Viewer) or a raw OAuth access token. Discovers
 * Compute Engine instances and Cloud Storage buckets. Dependency-free.
 */
export class GcpConnector implements CloudConnector {
  readonly provider = 'gcp';

  async test(credentials: ProviderCredentials): Promise<TestResult> {
    let token = '';
    let project = '';
    return runStages([
      {
        name: 'Authenticate (service-account key / token)',
        run: async () => {
          const r = await getGcpToken(credentials);
          token = r.token;
          project = r.project;
          return `Token acquired for project "${project}"`;
        },
      },
      {
        name: 'Validate project (Cloud Resource Manager API)',
        optional: true, // a nice-to-have probe; discovery uses Compute/Storage, not this API
        run: async () => {
          const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} — enable the Cloud Resource Manager API (optional). ${(await res.text()).slice(0, 140)}`);
          const p = (await res.json()) as { name?: string; lifecycleState?: string };
          return `Project "${p.name ?? project}" (${p.lifecycleState ?? 'ok'})`;
        },
      },
      {
        // Account / billing state — surfaced so a free-trial or billing-disabled project shows a
        // clear status instead of a cryptic Compute 403. Optional (a failed read = warning, not a
        // connection failure), so the account still connects and is visible.
        name: 'Billing / account state',
        optional: true,
        run: async () => {
          const res = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(project)}/billingInfo`, { headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) return `Could not read billing state (grant roles/billing.viewer to show it). HTTP ${res.status}.`;
          const b = (await res.json()) as { billingEnabled?: boolean; billingAccountName?: string };
          const acct = (b.billingAccountName || '').replace('billingAccounts/', '');
          if (b.billingEnabled) return `Billing ACTIVE${acct ? ` (account ${acct})` : ''} — full discovery & live provisioning available.`;
          throw new Error(`Billing is DISABLED${acct ? ` (account ${acct} is closed / free-trial ended)` : ' (no billing account linked)'}. Auth & permissions are fine, so the account connects — but Compute discovery and live provisioning need an ACTIVE billing account. Reactivate/relink at console.cloud.google.com/billing (free-tier usage stays $0). No IAM changes needed.`);
        },
      },
      {
        name: 'List Compute instances (compute.viewer)',
        run: async () => {
          const res = await fetch(
            `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/aggregated/instances?maxResults=1`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          if (res.ok) return 'Compute read OK';
          const body = (await res.text()).slice(0, 200);
          // Billing-gated (not a permission problem) → degrade, don't hard-fail: the connection is
          // valid, discovery just stays empty until billing is active. See the Billing stage above.
          if (res.status === 403 && /billing/i.test(body)) return 'Authorized — Compute is gated by billing (see "Billing / account state"). Discovery returns nothing until an active billing account is linked; the connection is otherwise valid.';
          throw new Error(`HTTP ${res.status} — enable the Compute Engine API + grant "Compute Viewer". ${body.slice(0, 140)}`);
        },
      },
      {
        name: 'List Storage buckets (storage.viewer)',
        optional: true,
        run: async () => {
          const res = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} — grant "Storage Object Viewer" for bucket discovery.`);
          return 'Storage read OK';
        },
      },
    ]);
  }

  async discover(_account: CloudAccountRef, credentials: ProviderCredentials): Promise<DiscoveredAsset[]> {
    const { token, project } = await getGcpToken(credentials);
    const [instances, buckets, networks] = await Promise.all([
      this.discoverInstances(token, project),
      this.discoverBuckets(token, project),
      this.discoverNetworks(token, project),
    ]);
    return [...instances, ...buckets, ...networks];
  }

  /** Enumerate VPC networks so MCMF-provisioned and pre-existing networks show in Inventory. */
  private async discoverNetworks(token: string, project: string): Promise<DiscoveredAsset[]> {
    try {
      const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/networks`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { items?: { id?: string; name: string; autoCreateSubnetworks?: boolean; description?: string }[] };
      return (body.items ?? []).map((n) => ({
        resourceType: 'compute:network',
        externalId: `gcpnet:${n.id ?? n.name}`,
        name: n.name,
        region: 'global',
        properties: { discoveredBy: 'gcp-connector', autoSubnets: n.autoCreateSubnetworks ?? false, description: n.description ?? '' },
      }));
    } catch {
      return [];
    }
  }

  /** Cloud VPN tunnel status for the Replication/DR VPN monitor. tunnelId = "region/tunnelName" or a full selfLink. */
  async vpnConnectionStatus(credentials: ProviderCredentials, tunnelId: string): Promise<{ up: boolean; state: string; tunnels: { ip: string; status: string; msg: string }[] }> {
    const { token, project } = await getGcpToken(credentials);
    let url = String(tunnelId || '').trim();
    if (!/^https?:\/\//.test(url)) {
      const [region, name] = url.split('/');
      if (!region || !name) throw new Error('GCP VPN tunnel id must be "region/tunnelName" or a full selfLink URL.');
      url = `https://compute.googleapis.com/compute/v1/projects/${project}/regions/${region}/vpnTunnels/${name}`;
    }
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GCP vpnTunnel query failed (${res.status})`);
    const j = (await res.json()) as any;
    const status = String(j?.status ?? 'UNKNOWN');
    return { up: status === 'ESTABLISHED', state: status, tunnels: [{ ip: String(j?.peerIp ?? ''), status, msg: String(j?.detailedStatus ?? '') }] };
  }

  /**
   * Discover EXISTING cross-cloud connectivity in the project: Cloud VPN tunnels (aggregated across all
   * regions) with live status, plus Interconnect attachments (cross-connect).
   */
  async discoverVpn(credentials: ProviderCredentials): Promise<any[]> {
    const { token, project } = await getGcpToken(credentials);
    const h = { authorization: `Bearer ${token}` } as any;
    const out: any[] = [];
    try {
      const r = await fetch(`https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/vpnTunnels`, { headers: h });
      if (r.ok) for (const [, scope] of Object.entries(((await r.json()) as any)?.items ?? {})) {
        for (const t of (scope as any)?.vpnTunnels ?? []) {
          out.push({
            provider: 'gcp', kind: 'vpn', id: `${String(t.region || '').split('/').pop()}/${t.name}`, name: t.name, region: String(t.region || '').split('/').pop(),
            managed: /mcmf/i.test(String(t.name || '')),
            status: t.status === 'ESTABLISHED' ? 'up' : 'down',
            localAddr: t.vpnGatewayInterface != null ? '' : '', remoteAddr: t.peerIp || t.peerExternalGateway || t.peerGcpGateway || '', remoteSubnets: (t.localTrafficSelector || []).join(', '),
            detail: `Cloud VPN · ${t.status || ''}${t.detailedStatus ? ' · ' + t.detailedStatus : ''}`.trim(),
          });
        }
      }
    } catch { /* no perms */ }
    try {
      const r = await fetch(`https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/interconnectAttachments`, { headers: h });
      if (r.ok) for (const [, scope] of Object.entries(((await r.json()) as any)?.items ?? {})) {
        for (const a of (scope as any)?.interconnectAttachments ?? []) {
          out.push({
            provider: 'gcp', kind: 'interconnect', id: `${String(a.region || '').split('/').pop()}/${a.name}`, name: a.name, region: String(a.region || '').split('/').pop(), managed: false,
            status: a.state === 'ACTIVE' ? 'up' : 'down', localAddr: a.cloudRouterIpAddress || '', remoteAddr: a.customerRouterIpAddress || '', remoteSubnets: '',
            detail: `Interconnect · ${a.type || ''} ${a.state || ''}`.trim(),
          });
        }
      }
    } catch { /* no perms */ }
    return out;
  }

  /**
   * Tear down a DISCOVERED Cloud VPN tunnel by id ("region/tunnelName"). Always deletes the tunnel; when
   * deleteGateways is set, also deletes the target VPN gateway the tunnel referenced (best-effort — GCP
   * refuses while other tunnels/forwarding-rules still use it, which is reported, not forced).
   */
  async teardownVpn(credentials: ProviderCredentials, opts: { id: string; deleteGateways?: boolean }): Promise<string[]> {
    const { token, project } = await getGcpToken(credentials);
    const base = `https://compute.googleapis.com/compute/v1/projects/${project}`;
    const h = { authorization: `Bearer ${token}` } as any;
    const [region, name] = String(opts.id || '').split('/');
    if (!region || !name) return [`invalid GCP tunnel id "${opts.id}" (expected region/tunnelName)`];
    const done: string[] = [];
    // Read the tunnel first so we know which target gateway it used (for the optional gateway delete).
    let gwName = '';
    try {
      const r = await fetch(`${base}/regions/${region}/vpnTunnels/${name}`, { headers: h });
      if (r.ok) gwName = String(((await r.json()) as any)?.targetVpnGateway || '').split('/').pop() || '';
    } catch { /* best-effort */ }
    const del = async (url: string, label: string) => { try { const r = await fetch(url, { method: 'DELETE', headers: h }); done.push(r.ok || r.status === 404 ? `deleted ${label}` : `${label}: HTTP ${r.status}`); } catch (e) { done.push(`${label}: ${(e as Error).message}`); } };
    await del(`${base}/regions/${region}/vpnTunnels/${name}`, `vpnTunnel ${name}`);
    if (opts.deleteGateways && gwName) await del(`${base}/regions/${region}/targetVpnGateways/${gwName}`, `targetVpnGateway ${gwName}`);
    return done;
  }

  /**
   * Cross-cloud fabric (GCP Classic Cloud VPN). Reserves a regional external IP, creates a target VPN
   * gateway on the network, and adds ESP/UDP-500/UDP-4500 forwarding rules. Returns the assigned public IP.
   * EXPERIMENTAL: unverified against a live billing-enabled project; calls are best-effort and idempotent-ish.
   */
  async fabricGateway(credentials: ProviderCredentials, opts: { networkId: string; region: string; name: string }): Promise<{ gatewayId: string; publicIp: string }> {
    const { token, project } = await getGcpToken(credentials);
    const base = `https://compute.googleapis.com/compute/v1/projects/${project}`;
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' } as any;
    const netUrl = /^https?:\/\//.test(opts.networkId) ? opts.networkId : `${base}/global/networks/${opts.networkId}`;
    await fetch(`${base}/regions/${opts.region}/addresses`, { method: 'POST', headers: h, body: JSON.stringify({ name: `${opts.name}-ip` }) }).catch(() => undefined);
    let ip = '';
    for (let i = 0; i < 20 && !ip; i++) {
      const r = await fetch(`${base}/regions/${opts.region}/addresses/${opts.name}-ip`, { headers: h });
      if (r.ok) ip = ((await r.json()) as any).address || '';
      if (!ip) await new Promise((s) => setTimeout(s, 3000));
    }
    await fetch(`${base}/regions/${opts.region}/targetVpnGateways`, { method: 'POST', headers: h, body: JSON.stringify({ name: opts.name, network: netUrl }) });
    const tgw = `${base}/regions/${opts.region}/targetVpnGateways/${opts.name}`;
    const rules: [string, string, string | null][] = [['esp', 'ESP', null], ['udp500', 'UDP', '500'], ['udp4500', 'UDP', '4500']];
    for (const [suffix, proto, port] of rules) {
      await fetch(`${base}/regions/${opts.region}/forwardingRules`, { method: 'POST', headers: h, body: JSON.stringify({ name: `${opts.name}-${suffix}`, IPAddress: ip, IPProtocol: proto, ...(port ? { portRange: port } : {}), target: tgw }) }).catch(() => undefined);
    }
    if (!ip) throw new Error('GCP did not assign an external IP to the VPN gateway (check quota/permissions).');
    return { gatewayId: opts.name, publicIp: ip };
  }

  /** Create a Classic VPN tunnel (peer IP + shared secret) and a route to the peer subnet. */
  async fabricConnection(credentials: ProviderCredentials, opts: { gatewayId: string; region: string; networkId: string; peerIp: string; peerCidr: string; localCidr: string; psk: string; name: string }): Promise<{ connId: string; outsideIps: string[] }> {
    const { token, project } = await getGcpToken(credentials);
    const base = `https://compute.googleapis.com/compute/v1/projects/${project}`;
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' } as any;
    const netUrl = /^https?:\/\//.test(opts.networkId) ? opts.networkId : `${base}/global/networks/${opts.networkId}`;
    const tgw = `${base}/regions/${opts.region}/targetVpnGateways/${opts.gatewayId}`;
    const r = await fetch(`${base}/regions/${opts.region}/vpnTunnels`, { method: 'POST', headers: h, body: JSON.stringify({ name: opts.name, targetVpnGateway: tgw, peerIp: opts.peerIp, sharedSecret: opts.psk, ikeVersion: 2, localTrafficSelector: [opts.localCidr], remoteTrafficSelector: [opts.peerCidr] }) });
    if (!r.ok) throw new Error(`GCP vpnTunnel create failed (${r.status})`);
    await fetch(`${base}/global/routes`, { method: 'POST', headers: h, body: JSON.stringify({ name: `${opts.name}-route`, network: netUrl, destRange: opts.peerCidr, priority: 1000, nextHopVpnTunnel: `${base}/regions/${opts.region}/vpnTunnels/${opts.name}` }) }).catch(() => undefined);
    return { connId: `${opts.region}/${opts.name}`, outsideIps: [] };
  }

  /** Tear down a fabric's GCP Classic VPN resources in reverse order. Best-effort per step. */
  async fabricTeardown(credentials: ProviderCredentials, opts: { name: string; gatewayId: string; region: string }): Promise<string[]> {
    const { token, project } = await getGcpToken(credentials);
    const base = `https://compute.googleapis.com/compute/v1/projects/${project}`;
    const h = { authorization: `Bearer ${token}` } as any;
    const done: string[] = [];
    const del = async (url: string, label: string) => { try { const r = await fetch(url, { method: 'DELETE', headers: h }); done.push(r.ok || r.status === 404 ? `deleted ${label}` : `${label}: ${r.status}`); } catch (e) { done.push(`${label}: ${(e as Error).message}`); } };
    await del(`${base}/global/routes/${opts.name}-route`, 'route');
    await del(`${base}/regions/${opts.region}/vpnTunnels/${opts.name}`, 'vpnTunnel');
    for (const s of ['esp', 'udp500', 'udp4500']) await del(`${base}/regions/${opts.region}/forwardingRules/${opts.gatewayId}-${s}`, `fwd ${s}`);
    await del(`${base}/regions/${opts.region}/targetVpnGateways/${opts.gatewayId}`, 'targetVpnGateway');
    await del(`${base}/regions/${opts.region}/addresses/${opts.gatewayId}-ip`, 'address');
    return done;
  }

  async getCost(credentials: ProviderCredentials): Promise<CostSummary | null> {
    const { token, project } = await getGcpToken(credentials);

    // The billing table can be set explicitly, or auto-detected from BigQuery when the SA can
    // list datasets — so a GCP connection surfaces cost with zero manual table-string hunting.
    let table = credentials.billingTable?.trim(); // e.g. project.dataset.gcp_billing_export_v1_XXXXXX
    let autoDetected = false;
    if (!table) {
      table = (await this.discoverBillingTable(token, project)) ?? undefined;
      if (!table) return null; // no export exists yet → costNote guidance
      autoDetected = true;
    }

    const { sql, schema } = buildGcpCostQuery(table, new Date());
    try {
      const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 }),
      });
      if (!res.ok) {
        console.warn(`[gcp-connector] BigQuery cost ${res.status} for ${table} (${schema} schema; check table + BigQuery Data Viewer/Job User)`);
        return null;
      }
      const body = (await res.json()) as { rows?: { f: { v: string }[] }[] };
      let total = 0;
      let currency = 'USD';
      const byService: { service: string; cost: number }[] = [];
      for (const row of body.rows ?? []) {
        const service = row.f[0]?.v ?? 'Other';
        const cost = Number(row.f[1]?.v ?? 0);
        if (row.f[2]?.v) currency = row.f[2].v;
        if (cost <= 0) continue;
        total += cost;
        byService.push({ service, cost: Math.round(cost * 100) / 100 });
      }
      return { total: Math.round(total * 100) / 100, currency, byService, ...(autoDetected ? { usedTable: table } : {}) };
    } catch (err) {
      console.warn(`[gcp-connector] BigQuery cost error: ${String(err)}`);
      return null;
    }
  }

  /**
   * Best-effort auto-discovery of the billing-export table: list datasets, then the first table
   * matching gcp_billing_export_*. Preference order: standard (v1) → FOCUS → detailed (resource_v1)
   * → any billing_export table. Returns null (silently) if the SA can't list datasets — the caller
   * then falls back to the manual-setup guidance in costNote.
   */
  private async discoverBillingTable(token: string, project: string): Promise<string | null> {
    try {
      const H = { authorization: `Bearer ${token}` };
      const dsRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/datasets`, { headers: H });
      if (!dsRes.ok) return null;
      const dsBody = (await dsRes.json()) as { datasets?: { datasetReference: { datasetId: string } }[] };
      const datasets = (dsBody.datasets ?? []).map((d) => d.datasetReference.datasetId);
      const candidates: string[] = [];
      for (const ds of datasets) {
        const tRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(ds)}/tables`, { headers: H });
        if (!tRes.ok) continue;
        const tBody = (await tRes.json()) as { tables?: { tableReference: { tableId: string } }[] };
        for (const t of tBody.tables ?? []) {
          const id = t.tableReference.tableId;
          if (/gcp_billing_export_|billing_export_focus/i.test(id)) candidates.push(`${project}.${ds}.${id}`);
        }
      }
      if (candidates.length === 0) return null;
      const rank = (tbl: string) => (/_v1_/.test(tbl) && !/resource_v1/.test(tbl) ? 0 : /_focus_/.test(tbl) ? 1 : /resource_v1/.test(tbl) ? 2 : 3);
      candidates.sort((a, b) => rank(a) - rank(b));
      const picked = candidates[0] as string;
      console.warn(`[gcp-connector] auto-detected billing table: ${picked}${candidates.length > 1 ? ` (of ${candidates.length})` : ''}`);
      return picked;
    } catch {
      return null;
    }
  }

  async getFindings(credentials: ProviderCredentials): Promise<DiscoveredFinding[]> {
    const org = credentials.orgId;
    if (!org) return []; // SCC is organisation-scoped; needs an org id
    const { token } = await getGcpToken(credentials);
    const out: DiscoveredFinding[] = [];
    try {
      const url = `https://securitycenter.googleapis.com/v1/organizations/${encodeURIComponent(org)}/sources/-/findings?pageSize=200&filter=${encodeURIComponent('state="ACTIVE"')}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        listFindingsResults?: { finding?: { name?: string; category?: string; severity?: string; resourceName?: string; eventTime?: string } }[];
      };
      for (const r of body.listFindingsResults ?? []) {
        const f = r.finding;
        if (!f?.name) continue;
        const cat = (f.category ?? '').toUpperCase();
        const type = cat.includes('VULNERABILIT') ? 'vulnerability' : cat.includes('MALWARE') || cat.includes('THREAT') ? 'threat' : 'misconfiguration';
        out.push({
          externalId: `gcp:${f.name}`,
          title: f.category ?? 'SCC finding',
          type,
          severity: GCP_SEV[(f.severity ?? 'MEDIUM').toUpperCase()] ?? 'medium',
          status: 'open',
          source: 'scc',
          resourceName: f.resourceName?.split('/').pop() ?? f.resourceName,
          detectedAt: f.eventTime,
        });
      }
    } catch {
      /* SCC unavailable */
    }
    return out;
  }

  async control(action: PowerAction, ctx: ControlContext, credentials: ProviderCredentials): Promise<{ ok: boolean; detail: string }> {
    const { token, project } = await getGcpToken(credentials);
    const zone = ctx.zone;
    if (!zone) throw new Error('GCP control needs the instance zone');
    const verb = action === 'start' ? 'start' : action === 'reboot' ? 'reset' : 'stop';
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(ctx.name)}/${verb}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`gcp ${verb} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return { ok: true, detail: `${action} requested for ${ctx.name} (${zone})` };
  }

  /** Non-destructive readiness probe: testIamPermissions for compute.networks.create. */
  async testProvision(credentials: ProviderCredentials): Promise<{ ready: boolean; detail: string }> {
    const { token, project } = await getGcpToken(credentials);
    const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(project)}:testIamPermissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['compute.networks.create', 'compute.subnetworks.create'] }),
    });
    if (!res.ok) return { ready: false, detail: `permission check failed (HTTP ${res.status}).` };
    const body = (await res.json()) as { permissions?: string[] };
    const ready = (body.permissions ?? []).includes('compute.networks.create');
    return ready
      ? { ready: true, detail: 'compute.networks.create granted.' }
      : { ready: false, detail: 'compute.networks.create missing — run the GCP grant script (compute.networkAdmin).' };
  }

  /** Non-secret identity for the grant script: project + service-account email (from the key). */
  async identity(credentials: ProviderCredentials): Promise<ProvisionIdentity> {
    let project = credentials.project;
    let serviceAccountEmail: string | undefined;
    try {
      const k = JSON.parse(credentials.serviceAccountKey ?? '{}');
      project = project || k.project_id;
      serviceAccountEmail = k.client_email;
    } catch {
      /* key not JSON / token-only auth */
    }
    return { project, serviceAccountEmail };
  }

  /** Live option pools for the provisioning form: regions + existing VPC networks. */
  async listProvisionOptions(credentials: ProviderCredentials, _region?: string): Promise<ProvisionOptions> {
    const { token, project } = await getGcpToken(credentials);
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      return r.ok ? ((await r.json()) as any) : null;
    };
    const base = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}`;
    const [regionsJson, netsJson] = await Promise.all([get(`${base}/regions`), get(`${base}/global/networks`)]);
    const regions = (regionsJson?.items ?? []).map((r: any) => ({ value: r.name, label: r.name }));
    const networks = (netsJson?.items ?? []).map((n: any) => ({ value: n.name, label: n.name }));
    return { regions, networks };
  }

  /** Live resource creation. Today: Network (auto-mode VPC). */
  async provision(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult> {
    if (spec.kind === 'network') {
      const name = spec.name.trim();
      if (!/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
        throw new ProvisionError('invalid network name', 'Validate input', 'Use lowercase letters, digits and hyphens; must start with a letter (e.g. prod-vpc).');
      }
      const { token, project } = await getGcpToken(credentials);
      const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/networks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, autoCreateSubnetworks: true, description: 'Created by MCMF' }),
      });
      if (!res.ok) throw gcpProvisionError('VPC network create', res.status, await res.text());
      return { ok: true, detail: `Created VPC network "${name}" (auto subnets) in project ${project} — provisioning.`, externalId: name };
    }

    if (spec.kind === 'vm') {
      const name = (spec.name ?? '').trim();
      if (!/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
        throw new ProvisionError('invalid instance name', 'Validate input', 'Use lowercase letters, digits and hyphens; must start with a letter (e.g. app-server-1).');
      }
      const { token, project } = await getGcpToken(credentials);
      const zone = (spec.zone || 'us-central1-a').trim();
      const machineType = (spec.machineType || 'e2-medium').trim();
      const image = (spec.image || 'projects/debian-cloud/global/images/family/debian-12').trim();
      const network = (spec.network || 'default').trim();
      const diskSizeGb = Number(spec.diskSizeGb || 20);
      const adminUsername = String(spec.adminUsername || '').trim();
      const adminPassword = String(spec.adminPassword || '');
      if (!adminUsername || !adminPassword) throw new ProvisionError('admin username + password required', 'Validate input', 'Enter an admin username and password for the VM (used for SSH login).');
      // startup-script: create the admin user with the password + enable SSH password auth.
      const startup = `#!/bin/bash\nid -u ${adminUsername} &>/dev/null || useradd -m -s /bin/bash ${adminUsername}\necho '${adminUsername}:${adminPassword}' | chpasswd\nusermod -aG sudo ${adminUsername} 2>/dev/null || usermod -aG google-sudoers ${adminUsername} 2>/dev/null || true\nsed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config\nsystemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || true\n`;
      // Console firewall: a network firewall rule for the chosen ports from the chosen sources,
      // targeting a per-VM network tag — so the browser console / SSH / RDP reach the instance.
      const ports = (Array.isArray(spec.consolePorts) ? spec.consolePorts : String(spec.consolePorts ?? '').split(','))
        .map((s) => String(s).trim()).filter((s) => /^\d{1,5}$/.test(s));
      const sources = String(spec.sourceCidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const tag = `mcmf-${name}`;
      let consoleHint: string | undefined;
      if (ports.length) {
        const fwBody = { name: `${name}-mcmf-console`.slice(0, 63), network: `global/networks/${network}`, direction: 'INGRESS', priority: 1000, allowed: [{ IPProtocol: 'tcp', ports }], sourceRanges: sources.length ? sources : ['0.0.0.0/0'], targetTags: [tag], description: 'MCMF console access' };
        const fwRes = await fetch(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/firewalls`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(fwBody),
        });
        if (!fwRes.ok) throw gcpProvisionError('Firewall rule create', fwRes.status, await fwRes.text());
        consoleHint = `opened TCP ${ports.join(', ')} from ${sources.length ? sources.join(', ') : 'any'} (tag ${tag})`;
      }
      const body: any = {
        name,
        machineType: `zones/${zone}/machineTypes/${machineType}`,
        disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: image, diskSizeGb: String(diskSizeGb) } }],
        networkInterfaces: [{ network: `global/networks/${network}`, accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }] }],
        metadata: { items: [{ key: 'startup-script', value: startup }, ...(spec.sshPublicKey ? [{ key: 'ssh-keys', value: `${adminUsername}:${String(spec.sshPublicKey).trim()}` }] : [])] },
        labels: { createdby: 'mcmf' },
        ...(ports.length ? { tags: { items: [tag] } } : {}),
      };
      const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/instances`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw gcpProvisionError('Instance create', res.status, await res.text());
      return { ok: true, detail: `Creating VM "${name}" (${machineType}) in ${zone}${consoleHint ? ` — ${consoleHint}` : ''} — provisioning.`, externalId: name, consoleHint };
    }

    if (spec.kind === 'disk') {
      const name = (spec.name ?? '').trim();
      if (!/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
        throw new ProvisionError('invalid disk name', 'Validate input', 'Use lowercase letters, digits and hyphens; must start with a letter.');
      }
      const { token, project } = await getGcpToken(credentials);
      const zone = (spec.zone || 'us-central1-a').trim();
      const type = (spec.type || 'pd-balanced').trim();
      const sizeGb = Number(spec.sizeGb || 100);
      const body = { name, sizeGb: String(sizeGb), type: `projects/${project}/zones/${zone}/diskTypes/${type}` };
      const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/disks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw gcpProvisionError('Disk create', res.status, await res.text());
      return { ok: true, detail: `Created disk "${name}" (${sizeGb} GB, ${type}) in ${zone}.`, externalId: name };
    }

    throw new ProvisionError(`gcp live provisioning for "${spec.kind}" is not enabled yet`, 'Capability', 'GCP network, VM and disk creation are implemented.');
  }

  /** Delete a provisioned VM and the per-VM console firewall rule MCMF created for it. */
  async deprovision(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult> {
    if (spec.kind !== 'vm') throw new ProvisionError('only VM delete is supported', 'Validate input', 'Delete is implemented for VMs.');
    const { token, project } = await getGcpToken(credentials);
    const zone = (spec.zone || 'us-central1-a').trim();
    const name = (spec.name || '').trim();
    if (!name) throw new ProvisionError('VM name required', 'Validate input', 'Need the instance name to delete.');
    const del = (url: string) => fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    const r = await del(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}`);
    if (!r.ok && r.status !== 404) throw gcpProvisionError('Instance delete', r.status, await r.text());
    await del(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/firewalls/${encodeURIComponent(`${name}-mcmf-console`.slice(0, 63))}`).catch(() => undefined);
    return { ok: true, detail: `Deleting VM "${name}" and its console firewall rule in ${zone}.` };
  }

  async remediateRule(credentials: ProviderCredentials, target: NetworkRuleTarget): Promise<{ ok: boolean; detail: string }> {
    const { token, project } = await getGcpToken(credentials);
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/firewalls/${encodeURIComponent(target.resourceName)}`,
      { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) },
    );
    if (!res.ok) throw new Error(`gcp firewall disable ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return { ok: true, detail: `firewall "${target.resourceName}" disabled` };
  }

  async getNetworkRules(credentials: ProviderCredentials): Promise<NetworkRule[]> {
    const { token, project } = await getGcpToken(credentials);
    const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/firewalls`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[gcp-connector] firewalls ${res.status} (needs compute.firewalls.list)`);
      return [];
    }
    const body = (await res.json()) as { items?: any[] };
    const rules: NetworkRule[] = [];
    for (const fw of body.items ?? []) {
      if (fw.disabled) continue;
      const inbound = String(fw.direction ?? 'INGRESS').toUpperCase() === 'INGRESS';
      const sources: string[] = fw.sourceRanges ?? (inbound ? ['(tagged)'] : []);
      const allows = fw.allowed ?? [];
      const denies = fw.denied ?? [];
      const entries = [...allows.map((a: any) => ({ a, access: 'allow' as const })), ...denies.map((a: any) => ({ a, access: 'deny' as const }))];
      for (const { a, access } of entries) {
        const proto = String(a.IPProtocol ?? 'all').toLowerCase() === 'all' ? 'all' : String(a.IPProtocol).toLowerCase();
        const ports = (a.ports ?? []).join(',') || '*';
        for (const source of sources.length ? sources : ['*']) {
          rules.push({ resourceName: fw.name, ruleName: fw.name, direction: inbound ? 'inbound' : 'outbound', access, protocol: proto, source, ports });
        }
      }
    }
    return rules;
  }

  private async discoverInstances(token: string, project: string): Promise<DiscoveredAsset[]> {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/aggregated/instances`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(gcpComputeMessage(res.status, await res.text()));
    const body = (await res.json()) as { items?: Record<string, { instances?: GcpInstance[] }> };
    const assets: DiscoveredAsset[] = [];
    for (const [scope, group] of Object.entries(body.items ?? {})) {
      const zone = scope.replace(/^zones\//, '');
      for (const inst of group.instances ?? []) {
        const nic = inst.networkInterfaces?.[0];
        const osVersion = gcpOsVersion((inst.disks ?? []).flatMap((d) => d.licenses ?? []));
        assets.push({
          resourceType: 'compute:instance',
          externalId: String(inst.id ?? inst.name),
          name: inst.name,
          region: zone.replace(/-[a-z]$/, ''),
          properties: {
            discoveredBy: 'gcp-connector',
            machineType: inst.machineType?.split('/').pop(),
            size: inst.machineType?.split('/').pop(),
            status: inst.status,
            os: osVersion && /windows/i.test(osVersion) ? 'windows' : 'linux',
            ...(osVersion ? { osVersion } : {}),
            zone,
            privateIp: nic?.networkIP,
            publicIp: nic?.accessConfigs?.[0]?.natIP,
            tags: (inst as any).labels ?? {},
          },
        });
      }
    }
    return assets;
  }

  private async discoverBuckets(token: string, project: string): Promise<DiscoveredAsset[]> {
    try {
      const res = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { items?: { id: string; name: string; location?: string }[] };
      return (body.items ?? []).map((b) => ({
        resourceType: 'storage:bucket',
        externalId: `gcs:${b.id}`,
        name: b.name,
        region: (b.location ?? 'GLOBAL').toLowerCase(),
        properties: { discoveredBy: 'gcp-connector' },
      }));
    } catch {
      return [];
    }
  }
}

interface GcpInstance {
  id?: string | number;
  name: string;
  status?: string;
  machineType?: string;
  networkInterfaces?: { networkIP?: string; accessConfigs?: { natIP?: string }[] }[];
  disks?: { licenses?: string[] }[];
}
