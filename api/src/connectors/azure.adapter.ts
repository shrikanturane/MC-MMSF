import type { CloudAccountRef, CloudConnector, ComplianceStandard, ControlContext, CostSummary, DiscoveredAsset, DiscoveredFinding, NetworkRule, NetworkRuleTarget, PowerAction, ProviderCredentials, ProvisionIdentity, ProvisionOptions, ProvisionResult, ProvisionSpec, TestResult } from './adapter';
import { runStages, ProvisionError, cloudId } from './adapter';
import { getAzureToken } from './azure.auth';
import { azureOsVersion } from './os-version';

/** Map an ARM failure to a phase-tagged ProvisionError with an actionable remediation. */
function azureProvisionError(phase: string, status: number, body: string): ProvisionError {
  const snippet = (body || '').slice(0, 300);
  let remediation = 'Check the app registration’s role assignments and inputs, then retry.';
  if (/quota|exceeding approved|QuotaExceeded/i.test(snippet)) {
    // Azure returns quota errors as 409 OperationNotAllowed (or async) — NOT a name clash.
    const loc = (body.match(/Location:\s*([a-zA-Z0-9]+)/) ?? [])[1];
    const limit = (body.match(/Current Limit:\s*(\d+)/i) ?? [])[1];
    remediation = `An Azure compute quota was exceeded${loc ? ` in ${loc}` : ''}${limit ? ` (current vCPU limit ${limit})` : ''} — this is NOT a name conflict and roles won't fix it. Request a quota increase (Portal → Subscription → Usage + quotas → Compute → request increase), or pick a smaller VM size / fewer vCPUs / a different region, then click ↻ Retry deploy — no re-approval needed.`;
  } else if (status === 403 || /AuthorizationFailed/i.test(snippet)) {
    remediation = /disk/i.test(phase)
      ? 'Grant the app registration "Disk Contributor" at the subscription or resource-group scope, then retry — no re-approval needed.'
      : /virtual machine|public ip|network interface/i.test(phase)
        ? 'Grant the app registration "Virtual Machine Contributor" + "Network Contributor" at the subscription or resource-group scope, then retry — no re-approval needed.'
        : 'Grant the app registration "Network Contributor" (or Contributor) at the subscription or resource-group scope, then retry — no re-approval needed.';
  } else if (status === 409) {
    remediation = 'A resource with this name already exists. Choose a different name, or use the existing one, then click ↻ Retry deploy — no re-approval needed.';
  } else if (status === 400 && /password/i.test(snippet)) {
    remediation = 'Use an admin password of 12–72 chars with an uppercase letter, lowercase letter, digit and symbol, then retry.';
  } else if (status === 400 && /address/i.test(snippet)) {
    remediation = 'Fix the address space / subnet CIDR (the subnet must fit inside the VNet range), then retry.';
  } else if (status === 400) {
    remediation = `Fix the invalid input and retry. ${snippet}`;
  }
  return new ProvisionError(`${phase}: HTTP ${status} — ${snippet}`, phase, remediation);
}

const SEV: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  informational: 'low',
};

/**
 * Real Azure connector (ported + enriched). Uses the ARM generic resources list so a single
 * authenticated call discovers the WHOLE subscription (VMs, storage, SQL, networks, AKS, …).
 * Dependency-free: client-credentials OAuth against Entra ID + fetch against management.azure.com.
 * Credentials: { tenantId, clientId, clientSecret, subscriptionId }.
 */
export class AzureConnector implements CloudConnector {
  readonly provider = 'azure';

  private require(c: ProviderCredentials) {
    const { tenantId, clientId, clientSecret, subscriptionId } = c;
    if (!tenantId || !clientId || !clientSecret || !subscriptionId) {
      throw new Error('azure connector requires { tenantId, clientId, clientSecret, subscriptionId }');
    }
    return { tenantId, clientId, clientSecret, subscriptionId };
  }

  async test(credentials: ProviderCredentials): Promise<TestResult> {
    const { subscriptionId } = this.require(credentials);
    let token = '';
    let subState = '';
    return runStages([
      {
        name: 'Authenticate with Entra ID (OAuth client credentials)',
        run: async () => {
          token = await getAzureToken(credentials);
          return 'Access token acquired for management.azure.com';
        },
      },
      {
        name: 'Read subscription',
        run: async () => {
          const res = await fetch(
            `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2022-12-01`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          if (!res.ok) {
            const body = (await res.text()).slice(0, 200);
            throw new Error(`HTTP ${res.status} — check subscriptionId and that the app has access. ${body}`);
          }
          const sub = (await res.json()) as { displayName?: string; state?: string };
          subState = sub.state ?? '';
          return `Subscription "${sub.displayName ?? subscriptionId}" (${subState || 'ok'})`;
        },
      },
      {
        // Subscription/billing state — like GCP billing, surfaced so a disabled / trial-ended /
        // past-due subscription shows a clear status instead of a cryptic resource-list failure.
        name: 'Billing / subscription state',
        optional: true,
        run: async () => {
          if (!subState || /^enabled$/i.test(subState)) return 'Subscription ENABLED — full discovery & live provisioning available.';
          throw new Error(`Subscription state is "${subState}" (e.g. free-trial ended / payment past due / disabled). Auth & permissions are fine, so the account connects — but resource discovery and live provisioning need an ENABLED subscription. Reactivate it in the Azure portal (Subscriptions → your subscription → Reactivate / update payment). No role changes needed.`);
        },
      },
      {
        name: 'List resources (Reader permission)',
        run: async () => {
          const res = await fetch(
            `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resources?api-version=2021-04-01&$top=1`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          if (res.ok) return 'Reader access confirmed';
          const body = (await res.text()).slice(0, 200);
          // Subscription not Enabled → degrade, don't hard-fail (auth + permissions are valid; discovery
          // just stays empty until the subscription is reactivated). See "Billing / subscription state".
          if ((res.status === 403 || res.status === 401) && /disabledsubscription|subscription.*(disabled|not.*enabled|warned|past due)/i.test(body)) {
            return 'Authorized — resource listing is gated because the subscription is not Enabled (see "Billing / subscription state"). Discovery returns nothing until it is reactivated; the connection is otherwise valid.';
          }
          throw new Error(`HTTP ${res.status} — assign the "Reader" role to the app on the subscription. ${body}`);
        },
      },
    ]);
  }

  async discover(_account: CloudAccountRef, credentials: ProviderCredentials): Promise<DiscoveredAsset[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);

    const assets: DiscoveredAsset[] = [];
    let next: string | undefined =
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resources?api-version=2021-04-01&$top=1000`;
    while (next) {
      const res = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`azure resources ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = (await res.json()) as { value?: AzureResource[]; nextLink?: string };
      for (const r of body.value ?? []) {
        assets.push({
          resourceType: r.type ?? 'resource',
          externalId: r.id ?? r.name,
          name: r.name,
          region: r.location ?? 'global',
          properties: {
            discoveredBy: 'azure-connector',
            azureType: r.type,
            kind: r.kind,
            sku: r.sku?.name,
            resourceGroup: (r.id?.split('/resourceGroups/')[1] ?? '').split('/')[0] || undefined,
            tags: r.tags ?? {},
          },
        });
      }
      next = body.nextLink;
    }

    await this.enrichVms(assets, token);
    return assets;
  }

  async control(action: PowerAction, ctx: ControlContext, credentials: ProviderCredentials): Promise<{ ok: boolean; detail: string }> {
    const token = await getAzureToken(credentials);
    const verb = action === 'start' ? 'start' : action === 'reboot' ? 'restart' : 'deallocate';
    const resourceId = cloudId(ctx.externalId); // strip "provisioned:azure:vm:" → real /subscriptions/… path
    const res = await fetch(`https://management.azure.com${resourceId}/${verb}?api-version=2023-07-01`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 202 && !res.ok) throw new Error(`azure ${verb} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return { ok: true, detail: `${action} requested for ${ctx.name} (async — takes ~1 min)` };
  }

  /** Non-destructive readiness probe: read the caller's effective permissions, check Network write. */
  async testProvision(credentials: ProviderCredentials): Promise<{ ready: boolean; detail: string }> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const rgUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/mcmf-provisioned/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`;
    const subUrl = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`;
    let res = await fetch(rgUrl, auth);
    if (res.status === 404) res = await fetch(subUrl, auth); // RG not created yet → check subscription scope
    if (!res.ok) return { ready: false, detail: `permission check failed (HTTP ${res.status}).` };
    const body = (await res.json()) as { value?: { actions?: string[]; notActions?: string[] }[] };
    const writeRe = /^\*$|microsoft\.network\/(\*|virtualnetworks\/(write|\*))/i;
    const ready = (body.value ?? []).some((p) => (p.actions ?? []).some((a) => writeRe.test(a)) && !(p.notActions ?? []).some((a) => writeRe.test(a)));
    return ready
      ? { ready: true, detail: 'Microsoft.Network write permission present.' }
      : { ready: false, detail: 'No network write — run the Azure grant script (Network Contributor).' };
  }

  /** Non-secret identity for the grant script: subscription + app registration. */
  async identity(credentials: ProviderCredentials): Promise<ProvisionIdentity> {
    const { subscriptionId } = this.require(credentials);
    return { subscriptionId, clientId: credentials.clientId };
  }

  /** Live pools for the provisioning form: physical regions, resource groups, existing VNets. */
  async listProvisionOptions(credentials: ProviderCredentials, _region?: string): Promise<ProvisionOptions> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const base = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}`;
    const getJson = async (url: string) => {
      const r = await fetch(url, auth);
      return r.ok ? ((await r.json()) as any) : null;
    };
    const [locs, rgs, vnets] = await Promise.all([
      getJson(`${base}/locations?api-version=2022-12-01`),
      getJson(`${base}/resourcegroups?api-version=2021-04-01`),
      getJson(`${base}/providers/Microsoft.Network/virtualNetworks?api-version=2023-05-01`),
    ]);
    const regions = (locs?.value ?? [])
      .filter((l: any) => !l.metadata || l.metadata.regionType === 'Physical')
      .map((l: any) => ({ value: l.name, label: l.displayName ?? l.name }));
    const resourceGroups = (rgs?.value ?? []).map((g: any) => ({ value: g.name, label: `${g.name} (${g.location})` }));
    const networks = (vnets?.value ?? []).map((v: any) => ({
      value: v.name,
      label: v.name,
      region: v.location,
      subnets: (v.properties?.subnets ?? []).map((s: any) => s.name),
    }));
    return { regions, resourceGroups, networks };
  }

  /**
   * Live resource creation. Today: Network (VNet + default subnet) — unbilled and
   * easily deleted, so it's the safe first provisioning path. VM/disk are stubbed
   * with a clear error until explicitly enabled.
   */
  async provision(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const auth = (method: string, body?: unknown) => ({
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const base = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}`;

    if (spec.kind === 'network') {
      const region = (spec.region || 'eastasia').trim();
      const cidr = (spec.cidr || '10.20.0.0/16').trim();
      const rg = (spec.resourceGroup || 'mcmf-provisioned').trim();
      const name = spec.name.trim();
      if (!/^[\w.-]{1,80}$/.test(name)) throw new ProvisionError('invalid network name', 'Validate input', 'Use a name of letters, numbers, dots, hyphens or underscores (max 80).');

      // 1. Ensure the resource group exists. GET first so an EXISTING group only needs
      //    read access (Network Contributor scoped to the RG is then enough); create it
      //    only when missing (which needs broader rights — see Help → Remote Provisioning).
      const rgUrl = `${base}/resourcegroups/${encodeURIComponent(rg)}?api-version=2021-04-01`;
      const rgGet = await fetch(rgUrl, { headers: { authorization: `Bearer ${token}` } });
      if (rgGet.status === 404) {
        const rgRes = await fetch(rgUrl, auth('PUT', { location: region }));
        if (!rgRes.ok) throw azureProvisionError('Resource group create', rgRes.status, await rgRes.text());
      } else if (!rgGet.ok) {
        throw azureProvisionError('Resource group lookup', rgGet.status, await rgGet.text());
      }

      // 2. Create/ensure the VNet with a "default" subnet (explicit, else carved /24). IDEMPOTENT: if the
      //    VNet already exists (e.g. left behind by a fabric tear-down), PRESERVE its existing subnets —
      //    replacing the list would try to DELETE a GatewaySubnet still held by a detaching VPN gateway
      //    ("InUseSubnetCannotBeDeleted"). We only ensure a 'default' subnet is present.
      const subnetPrefix = (spec.subnetCidr || '').trim() || defaultSubnet(cidr);
      const vnetUrl = `${base}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Network/virtualNetworks/${encodeURIComponent(name)}?api-version=2023-05-01`;
      const vnetGet = await fetch(vnetUrl, { headers: { authorization: `Bearer ${token}` } });
      let subnets: any[] = [{ name: 'default', properties: { addressPrefix: subnetPrefix } }];
      let addressPrefixes = [cidr];
      if (vnetGet.ok) {
        const ex: any = await vnetGet.json();
        const exSubnets = (ex?.properties?.subnets ?? []).map((s: any) => ({ name: s.name, properties: { addressPrefix: s.properties?.addressPrefix } }));
        subnets = exSubnets.length ? exSubnets : subnets;
        if (!subnets.some((s) => s.name === 'default')) subnets.push({ name: 'default', properties: { addressPrefix: subnetPrefix } });
        const exPrefixes = ex?.properties?.addressSpace?.addressPrefixes ?? [];
        if (exPrefixes.length) addressPrefixes = exPrefixes.includes(cidr) ? exPrefixes : [...exPrefixes, cidr];
      }
      const vnetBody = {
        location: region,
        properties: { addressSpace: { addressPrefixes }, subnets },
        tags: { createdBy: 'MCMF' },
      };
      const res = await fetch(vnetUrl, auth('PUT', vnetBody));
      if (!res.ok) throw azureProvisionError('Virtual network create', res.status, await res.text());
      const out = (await res.json()) as { id?: string };
      return { ok: true, detail: `Created VNet "${name}" (${cidr}, subnet ${subnetPrefix}) in ${rg} / ${region}.`, externalId: out.id };
    }

    if (spec.kind === 'vm') {
      const region = (spec.region || 'eastasia').trim();
      const rg = (spec.resourceGroup || 'mcmf-provisioned').trim();
      const name = spec.name.trim();
      const size = (spec.size || 'Standard_B2s').trim();
      const adminUsername = (spec.adminUsername || 'azureuser').trim();
      const adminPassword = String(spec.adminPassword || '');
      const vnetName = (spec.network || '').trim();
      const subnetName = (spec.subnet || 'default').trim();
      const osDiskGb = Number(spec.osDiskSizeGb || 30);
      const image = (spec.image || 'Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest').trim();
      const [publisher, offer, sku, version] = image.split(':');
      if (!vnetName) throw new ProvisionError('virtual network required', 'Validate input', 'Select a virtual network (the VM’s NIC attaches to its subnet).');
      if (!adminPassword) throw new ProvisionError('admin password required', 'Validate input', 'Enter an admin password (12+ chars with upper, lower, digit and symbol).');

      // 0. Ensure RG.
      const rgUrl = `${base}/resourcegroups/${encodeURIComponent(rg)}?api-version=2021-04-01`;
      const rgGet = await fetch(rgUrl, { headers: { authorization: `Bearer ${token}` } });
      if (rgGet.status === 404) {
        const rgRes = await fetch(rgUrl, auth('PUT', { location: region }));
        if (!rgRes.ok) throw azureProvisionError('Resource group create', rgRes.status, await rgRes.text());
      }

      // 1. Resolve the subnet id from the chosen VNet (which may live in another RG).
      const vnetsRes = await fetch(`${base}/providers/Microsoft.Network/virtualNetworks?api-version=2023-05-01`, { headers: { authorization: `Bearer ${token}` } });
      if (!vnetsRes.ok) throw azureProvisionError('Resolve network', vnetsRes.status, await vnetsRes.text());
      const vnets = ((await vnetsRes.json()) as any).value ?? [];
      const vnet = vnets.find((v: any) => v.name === vnetName);
      if (!vnet) throw new ProvisionError(`VNet "${vnetName}" not found`, 'Resolve network', 'Pick an existing virtual network, or create one first (Provision → Network).');
      const subnets = vnet.properties?.subnets ?? [];
      const subnetId = (subnets.find((s: any) => s.name === subnetName) ?? subnets[0])?.id;
      if (!subnetId) throw new ProvisionError('no subnet in the selected VNet', 'Resolve network', 'Add a subnet to the VNet, then retry.');

      const rgBase = `${base}/resourceGroups/${encodeURIComponent(rg)}/providers`;
      // 2. Console firewall: an NSG opening the chosen inbound ports from the allowed sources, so the
      //    browser console / SSH / RDP reach the VM. Scoped to the given CIDRs (MCMF server + admin).
      const ports = (Array.isArray(spec.consolePorts) ? spec.consolePorts : String(spec.consolePorts ?? '').split(','))
        .map((s) => String(s).trim()).filter((s) => /^\d{1,5}$/.test(s));
      const sources = String(spec.sourceCidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      let nsgId: string | undefined;
      let consoleHint: string | undefined;
      if (ports.length) {
        const srcProp = sources.length === 0 ? { sourceAddressPrefix: '*' } : sources.length === 1 ? { sourceAddressPrefix: sources[0] } : { sourceAddressPrefixes: sources };
        const securityRules = ports.map((port, i) => ({
          name: `mcmf-allow-${port}`,
          properties: { priority: 1000 + i, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourcePortRange: '*', destinationPortRange: port, destinationAddressPrefix: '*', ...srcProp },
        }));
        const nsgRes = await fetch(`${rgBase}/Microsoft.Network/networkSecurityGroups/${encodeURIComponent(name)}-nsg?api-version=2023-05-01`, auth('PUT', { location: region, properties: { securityRules }, tags: { createdBy: 'MCMF' } }));
        if (!nsgRes.ok) throw azureProvisionError('Network security group create', nsgRes.status, await nsgRes.text());
        nsgId = ((await nsgRes.json()) as any).id;
        consoleHint = `opened TCP ${ports.join(', ')} from ${sources.length ? sources.join(', ') : 'any'}`;
      }
      // 3. Public IP.
      const pipRes = await fetch(`${rgBase}/Microsoft.Network/publicIPAddresses/${encodeURIComponent(name)}-ip?api-version=2023-05-01`, auth('PUT', { location: region, properties: { publicIPAllocationMethod: 'Dynamic' }, sku: { name: 'Basic' } }));
      if (!pipRes.ok) throw azureProvisionError('Public IP create', pipRes.status, await pipRes.text());
      const pipId = ((await pipRes.json()) as any).id;
      // 4. NIC (in the VM's RG, referencing the subnet by full id — cross-RG is fine). Attach the NSG.
      const nicRes = await fetch(`${rgBase}/Microsoft.Network/networkInterfaces/${encodeURIComponent(name)}-nic?api-version=2023-05-01`, auth('PUT', {
        location: region,
        properties: { ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: subnetId }, publicIPAddress: { id: pipId } } }], ...(nsgId ? { networkSecurityGroup: { id: nsgId } } : {}) },
      }));
      if (!nicRes.ok) throw azureProvisionError('Network interface create', nicRes.status, await nicRes.text());
      const nicId = ((await nicRes.json()) as any).id;
      // 4. The VM itself (async — provisions in ~1-2 min).
      const vmRes = await fetch(`${rgBase}/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}?api-version=2023-07-01`, auth('PUT', {
        location: region,
        properties: {
          hardwareProfile: { vmSize: size },
          storageProfile: { imageReference: { publisher, offer, sku, version }, osDisk: { createOption: 'FromImage', diskSizeGB: osDiskGb, managedDisk: { storageAccountType: 'StandardSSD_LRS' } } },
          osProfile: { computerName: name.slice(0, 15), adminUsername, adminPassword, ...(spec.sshPublicKey ? { linuxConfiguration: { ssh: { publicKeys: [{ path: `/home/${adminUsername}/.ssh/authorized_keys`, keyData: String(spec.sshPublicKey).trim() }] } } } : {}) },
          networkProfile: { networkInterfaces: [{ id: nicId }] },
        },
        tags: { createdBy: 'MCMF' },
      }));
      if (!vmRes.ok) throw azureProvisionError('Virtual machine create', vmRes.status, await vmRes.text());
      const vm = (await vmRes.json()) as { id?: string };
      return { ok: true, detail: `Creating VM "${name}" (${size}, ${sku ?? image}) in ${rg} / ${region}${consoleHint ? ` — ${consoleHint}` : ''} — provisioning (~1-2 min).`, externalId: vm.id, consoleHint };
    }

    if (spec.kind === 'disk') {
      const region = (spec.region || 'eastasia').trim();
      const rg = (spec.resourceGroup || 'mcmf-provisioned').trim();
      const name = spec.name.trim();
      const sizeGb = Number(spec.sizeGb || 100);
      const sku = (spec.sku || 'StandardSSD_LRS').trim();
      // Ensure RG (GET, create only if missing — least-privilege friendly).
      const rgUrl = `${base}/resourcegroups/${encodeURIComponent(rg)}?api-version=2021-04-01`;
      const rgGet = await fetch(rgUrl, { headers: { authorization: `Bearer ${token}` } });
      if (rgGet.status === 404) {
        const rgRes = await fetch(rgUrl, auth('PUT', { location: region }));
        if (!rgRes.ok) throw azureProvisionError('Resource group create', rgRes.status, await rgRes.text());
      }
      const url = `${base}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Compute/disks/${encodeURIComponent(name)}?api-version=2023-04-02`;
      const body = { location: region, sku: { name: sku }, properties: { creationData: { createOption: 'Empty' }, diskSizeGB: sizeGb }, tags: { createdBy: 'MCMF' } };
      const res = await fetch(url, auth('PUT', body));
      if (!res.ok) throw azureProvisionError('Disk create', res.status, await res.text());
      const out = (await res.json()) as { id?: string };
      return { ok: true, detail: `Created disk "${name}" (${sizeGb} GB, ${sku}) in ${rg} / ${region}.`, externalId: out.id };
    }

    throw new ProvisionError(
      `azure live provisioning for "${spec.kind}" is not enabled yet`,
      'Capability',
      'Only Azure network creation is implemented today. VM/disk are governance-only.',
    );
  }

  /** Delete a provisioned VM and the resources MCMF created for it (NIC, public IP, NSG, OS disk). */
  async deprovision(credentials: ProviderCredentials, spec: ProvisionSpec): Promise<ProvisionResult> {
    if (spec.kind !== 'vm') throw new ProvisionError('only VM delete is supported', 'Validate input', 'Delete is implemented for VMs.');
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const rg = (spec.resourceGroup || 'mcmf-provisioned').trim();
    const name = (spec.name || '').trim();
    if (!name) throw new ProvisionError('VM name required', 'Validate input', 'Need the VM name to delete.');
    const base = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(rg)}/providers`;
    const del = (url: string) => fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    // 1. Delete the VM first (async). 2. Then best-effort its dependents (they can't go until the VM is).
    const vmDel = await del(`${base}/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}?api-version=2023-07-01`);
    if (!vmDel.ok && vmDel.status !== 404 && vmDel.status !== 202) throw azureProvisionError('Virtual machine delete', vmDel.status, await vmDel.text());
    await del(`${base}/Microsoft.Network/networkInterfaces/${encodeURIComponent(name)}-nic?api-version=2023-05-01`).catch(() => undefined);
    await del(`${base}/Microsoft.Network/publicIPAddresses/${encodeURIComponent(name)}-ip?api-version=2023-05-01`).catch(() => undefined);
    await del(`${base}/Microsoft.Network/networkSecurityGroups/${encodeURIComponent(name)}-nsg?api-version=2023-05-01`).catch(() => undefined);
    return { ok: true, detail: `Deleting VM "${name}" and its NIC / public IP / NSG in ${rg} (the OS disk auto-deletes).` };
  }

  /** Site-to-Site VPN connection status for the Replication/DR VPN monitor. connId = "rg/name" or a full ARM id. */
  async vpnConnectionStatus(credentials: ProviderCredentials, connId: string): Promise<{ up: boolean; state: string; tunnels: { ip: string; status: string; msg: string }[] }> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    let path = String(connId || '').trim();
    if (!path.startsWith('/subscriptions/')) {
      const [rg, name] = path.split('/');
      if (!rg || !name) throw new Error('Azure VPN connection id must be "resourceGroup/connectionName" or a full ARM resource id.');
      path = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/connections/${name}`;
    }
    const res = await fetch(`https://management.azure.com${path}?api-version=2023-09-01`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Azure connection query failed (${res.status})`);
    const j = (await res.json()) as any;
    const status = String(j?.properties?.connectionStatus ?? 'Unknown');
    const msg = `ingress ${j?.properties?.ingressBytesTransferred ?? 0}B / egress ${j?.properties?.egressBytesTransferred ?? 0}B`;
    return { up: status === 'Connected', state: status, tunnels: [{ ip: String(j?.properties?.virtualNetworkGateway2?.id ?? ''), status, msg }] };
  }

  /**
   * Discover EXISTING cross-cloud/site-to-site connectivity in the subscription: VPN gateway connections
   * (IPsec / VNet-to-VNet) with live connectionStatus, plus ExpressRoute circuits (cross-connect).
   */
  async discoverVpn(credentials: ProviderCredentials): Promise<any[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const h = { authorization: `Bearer ${token}` } as any;
    const base = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Network`;
    const av = 'api-version=2023-09-01';
    const out: any[] = [];
    try {
      const r = await fetch(`${base}/connections?${av}`, { headers: h });
      if (r.ok) {
        const conns: any[] = ((await r.json()) as any)?.value ?? [];
        // The connections LIST does NOT populate live connectionStatus (it comes back null); only the
        // per-connection GET does. Enrich each VPN connection with a best-effort individual GET (in
        // parallel) so the discovered inventory shows a real up/down instead of "unknown".
        const live = await Promise.all(conns.map(async (c) => {
          const isEr = c.properties?.connectionType === 'ExpressRoute';
          if (isEr || !c.id) return null;
          try {
            const g = await fetch(`https://management.azure.com${c.id}?${av}`, { headers: h });
            if (!g.ok) return null;
            const gp = ((await g.json()) as any)?.properties || {};
            return { status: gp.connectionStatus ?? null, ingress: gp.ingressBytesTransferred, egress: gp.egressBytesTransferred };
          } catch { return null; }
        }));
        conns.forEach((c, i) => {
          const pr = c.properties || {};
          const liveStatus = live[i]?.status ?? pr.connectionStatus ?? null; // GET wins; fall back to LIST
          const bytes = live[i] && (live[i]!.ingress != null || live[i]!.egress != null)
            ? ` · ${live[i]!.ingress ?? 0}B in / ${live[i]!.egress ?? 0}B out` : '';
          out.push({
            provider: 'azure', kind: pr.connectionType === 'ExpressRoute' ? 'expressroute' : 'vpn', id: `${(c.id || '').split('/resourceGroups/')[1]?.split('/providers')[0] || ''}/${c.name}`, name: c.name, region: c.location,
            managed: c.tags?.createdBy === 'MCMF',
            status: liveStatus === 'Connected' ? 'up' : liveStatus ? 'down' : 'unknown',
            localAddr: '', remoteAddr: '', remoteSubnets: '',
            detail: `${pr.connectionType || 'connection'}${liveStatus ? ' · ' + liveStatus : ''}${bytes}`,
          });
        });
      }
    } catch { /* no perms */ }
    try {
      const r = await fetch(`${base}/expressRouteCircuits?${av}`, { headers: h });
      if (r.ok) for (const c of ((await r.json()) as any)?.value ?? []) {
        const pr = c.properties || {};
        out.push({
          provider: 'azure', kind: 'expressroute', id: c.name, name: c.name, region: c.location, managed: false,
          status: pr.serviceProviderProvisioningState === 'Provisioned' ? 'up' : 'down',
          localAddr: '', remoteAddr: pr.serviceProviderProperties?.peeringLocation || '', remoteSubnets: '',
          detail: `ExpressRoute · ${pr.serviceProviderProperties?.serviceProviderName || ''} ${pr.serviceProviderProvisioningState || ''}`.trim(),
        });
      }
    } catch { /* no perms */ }
    return out;
  }

  /**
   * Tear down a DISCOVERED VPN connection by id ("resourceGroup/connectionName"). Always deletes the
   * connection; when deleteGateways is set, also deletes the connection's local-network-gateway (the peer
   * representation) and, best-effort, the virtual-network-gateway (async ~10 min, and refused by Azure if
   * still used by another connection). Each step is independent and reported.
   */
  async teardownVpn(credentials: ProviderCredentials, opts: { id: string; deleteGateways?: boolean }): Promise<string[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const h = { authorization: `Bearer ${token}` } as any;
    const av = 'api-version=2023-09-01';
    const [rg, name] = String(opts.id || '').split('/');
    if (!rg || !name) return [`invalid Azure connection id "${opts.id}" (expected resourceGroup/connectionName)`];
    const base = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network`;
    const done: string[] = [];
    let lgwId = '', vgwId = '';
    try {
      const g = await fetch(`${base}/connections/${name}?${av}`, { headers: h });
      if (g.ok) { const pr = ((await g.json()) as any)?.properties || {}; lgwId = pr.localNetworkGateway2?.id || ''; vgwId = pr.virtualNetworkGateway1?.id || ''; }
    } catch { /* lookup best-effort */ }
    try {
      const r = await fetch(`${base}/connections/${name}?${av}`, { method: 'DELETE', headers: h });
      done.push(r.ok || r.status === 202 || r.status === 204 ? `deleted connection ${name}` : `connection: HTTP ${r.status}`);
    } catch (e) { done.push(`connection: ${(e as Error).message}`); }
    if (opts.deleteGateways) {
      if (lgwId) { try { const r = await fetch(`https://management.azure.com${lgwId}?${av}`, { method: 'DELETE', headers: h }); done.push(r.ok || r.status === 202 || r.status === 204 ? `deleted local-network-gateway` : `local-network-gateway: HTTP ${r.status}`); } catch (e) { done.push(`local-network-gateway: ${(e as Error).message}`); } }
      if (vgwId) { try { const r = await fetch(`https://management.azure.com${vgwId}?${av}`, { method: 'DELETE', headers: h }); done.push(r.ok || r.status === 202 ? `deleting virtual-network-gateway (async ~10 min)` : r.status === 204 ? `deleted virtual-network-gateway` : `virtual-network-gateway: HTTP ${r.status} (in use?)`); } catch (e) { done.push(`virtual-network-gateway: ${(e as Error).message}`); } }
    }
    return done;
  }

  /**
   * Cross-cloud fabric (Azure VPN Gateway). Creates a static Public IP (address known immediately), a
   * GatewaySubnet, and starts a route-based VPN gateway. NOTE: the gateway itself takes ~30-45 minutes to
   * provision; the orchestrator polls provisioningState before creating the connection. EXPERIMENTAL:
   * unverified against a live subscription.
   */
  async fabricGateway(credentials: ProviderCredentials, opts: { networkId: string; region: string; name: string; gwSubnetCidr: string }): Promise<{ gatewayId: string; publicIp: string }> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const m = String(opts.networkId).match(/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/virtualNetworks\/([^/?]+)/i);
    if (!m) throw new Error('Azure fabric requires the full ARM id of the VNet as networkId.');
    const rg = m[1], vnet = m[2];
    // armId = RELATIVE ARM resource id (starts with /subscriptions/) — required inside request-body `id`
    // references. arm = the full management URL used only for the fetch() endpoint. Mixing them up makes
    // Azure reject the body: "SubscriptionsPrefixMissingInJsonReferenceId / id has to start with /subscriptions/".
    const armId = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network`;
    const arm = `https://management.azure.com${armId}`;
    const av = 'api-version=2023-09-01';
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' } as any;
    // Checked PUT: Azure resource creates return 200/201 (sync) or 202 (async, long-running). Anything else
    // is a real failure — surface Azure's actual error instead of silently continuing (which later showed up
    // as a mysterious "gateway not-found"). PUTs are idempotent, so a retry/re-Arm is safe.
    const put = async (url: string, body: any, label: string) => {
      const r = await fetch(`${url}?${av}`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
      if (![200, 201, 202].includes(r.status)) {
        const t = await r.text().catch(() => '');
        throw new Error(`Azure ${label} create failed (${r.status}): ${t.replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      return r;
    };
    // AZ VPN gateway SKUs require a ZONE-REDUNDANT Standard public IP (VmssVpnGatewayPublicIpsMustHaveZonesConfigured).
    // zones is immutable on a PIP, so a fabric whose PIP was created zone-less must be torn down before re-Arm.
    await put(`${arm}/publicIPAddresses/${opts.name}-pip`, { location: opts.region, sku: { name: 'Standard' }, zones: ['1', '2', '3'], properties: { publicIPAllocationMethod: 'Static' } }, 'gateway public IP');
    let ip = '';
    for (let i = 0; i < 15 && !ip; i++) {
      const r = await fetch(`${arm}/publicIPAddresses/${opts.name}-pip?${av}`, { headers: h });
      if (r.ok) ip = (((await r.json()) as any)?.properties?.ipAddress) || '';
      if (!ip) await new Promise((s) => setTimeout(s, 3000));
    }
    await put(`${arm}/virtualNetworks/${vnet}/subnets/GatewaySubnet`, { properties: { addressPrefix: opts.gwSubnetCidr } }, 'GatewaySubnet');
    const pipId = `${armId}/publicIPAddresses/${opts.name}-pip`;
    const subnetId = `${armId}/virtualNetworks/${vnet}/subnets/GatewaySubnet`;
    await put(`${arm}/virtualNetworkGateways/${opts.name}`, {
      location: opts.region,
      // Azure deprecated the non-AZ VpnGw SKUs (NonAzSkusNotAllowedForVPNGateway) — only the AZ SKUs
      // (VpnGw1AZ…VpnGw5AZ) can be created now. AZ SKUs require a Standard-SKU public IP (already used above).
      properties: { gatewayType: 'Vpn', vpnType: 'RouteBased', sku: { name: 'VpnGw1AZ', tier: 'VpnGw1AZ' }, ipConfigurations: [{ name: 'default', properties: { privateIPAllocationMethod: 'Dynamic', subnet: { id: subnetId }, publicIPAddress: { id: pipId } } }] },
    }, 'VPN gateway');
    if (!ip) throw new Error('Azure did not assign a Public IP (check quota/permissions).');
    return { gatewayId: opts.name, publicIp: ip };
  }

  /**
   * Poll the gateway provisioningState. Azure gateways take ~30-45 minutes. Returns the live state so the
   * caller can (a) show progress and (b) fail fast on a TERMINAL state (Failed/Canceled) instead of waiting
   * forever — a bare "not Succeeded === keep waiting" loop never ends if provisioning failed.
   */
  async fabricGatewayReady(credentials: ProviderCredentials, opts: { networkId: string; name: string }): Promise<{ ready: boolean; state: string; terminal: boolean }> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const m = String(opts.networkId).match(/resourceGroups\/([^/]+)\//i);
    if (!m) return { ready: false, state: 'bad-network-id', terminal: true };
    const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${m[1]}/providers/Microsoft.Network/virtualNetworkGateways/${opts.name}?api-version=2023-09-01`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 404) return { ready: false, state: 'not-found', terminal: true }; // gateway was deleted / never created
    if (!r.ok) return { ready: false, state: `http-${r.status}`, terminal: false }; // transient (throttle/token) — keep polling
    const state = String(((await r.json()) as any)?.properties?.provisioningState || 'Unknown');
    return { ready: state === 'Succeeded', state, terminal: /^(Failed|Canceled|Cancelled)$/i.test(state) };
  }

  /** Create a Local Network Gateway (peer) and an IPsec connection with the shared key. */
  async fabricConnection(credentials: ProviderCredentials, opts: { gatewayId: string; region: string; networkId: string; peerIp: string; peerCidr: string; psk: string; name: string }): Promise<{ connId: string; outsideIps: string[] }> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const m = String(opts.networkId).match(/resourceGroups\/([^/]+)\//i);
    if (!m) throw new Error('Azure fabric requires the full ARM id of the VNet as networkId.');
    const rg = m[1];
    const armId = `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network`; // relative id for body refs
    const arm = `https://management.azure.com${armId}`; // full url for fetch
    const av = 'api-version=2023-09-01';
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' } as any;
    const put = (url: string, body: any) => fetch(`${url}?${av}`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
    const lgwUrl = `${arm}/localNetworkGateways/${opts.name}-lgw`;
    await put(lgwUrl, { location: opts.region, properties: { gatewayIpAddress: opts.peerIp, localNetworkAddressSpace: { addressPrefixes: [opts.peerCidr] } } });
    // The lgw provisions async; creating the connection before it's Succeeded fails with
    // ReferencedResourceNotProvisioned. Poll it to Succeeded (a few seconds) before wiring the connection.
    for (let i = 0; i < 20; i++) {
      const lr = await fetch(`${lgwUrl}?${av}`, { headers: h });
      const state = lr.ok ? String((((await lr.json()) as any)?.properties?.provisioningState) || '') : '';
      if (state === 'Succeeded') break;
      if (/Failed|Canceled/i.test(state)) throw new Error(`Azure local network gateway provisioning ${state}.`);
      await new Promise((s) => setTimeout(s, 3000));
    }
    const r = await put(`${arm}/connections/${opts.name}-conn`, {
      location: opts.region,
      properties: { connectionType: 'IPsec', sharedKey: opts.psk, virtualNetworkGateway1: { id: `${armId}/virtualNetworkGateways/${opts.gatewayId}` }, localNetworkGateway2: { id: `${armId}/localNetworkGateways/${opts.name}-lgw` } },
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Azure connection create failed (${r.status}): ${t.replace(/\s+/g, ' ').slice(0, 300)}`); }
    return { connId: `${rg}/${opts.name}-conn`, outsideIps: [] };
  }

  /** Tear down a fabric's Azure VPN resources in reverse order. Best-effort. The gateway delete is async (~10 min). */
  async fabricTeardown(credentials: ProviderCredentials, opts: { name: string; gatewayId: string; networkId: string }): Promise<string[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const m = String(opts.networkId).match(/resourceGroups\/([^/]+)\//i);
    if (!m) return ['could not parse resource group from networkId'];
    const arm = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${m[1]}/providers/Microsoft.Network`;
    const av = 'api-version=2023-09-01';
    const h = { authorization: `Bearer ${token}` } as any;
    const done: string[] = [];
    const del = async (path: string, label: string) => { try { const r = await fetch(`${arm}/${path}?${av}`, { method: 'DELETE', headers: h }); done.push(r.ok || r.status === 404 ? `deleted ${label}` : `${label}: ${r.status}`); } catch (e) { done.push(`${label}: ${(e as Error).message}`); } };
    await del(`connections/${opts.name}-conn`, 'connection');
    await del(`localNetworkGateways/${opts.name}-lgw`, 'local-gateway');
    await del(`virtualNetworkGateways/${opts.gatewayId}`, 'vpn-gateway (async ~10min)');
    await del(`publicIPAddresses/${opts.gatewayId}-pip`, 'public-ip');
    return done;
  }

  async getCost(credentials: ProviderCredentials): Promise<CostSummary | null> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const res = await fetch(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'ActualCost',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [{ type: 'Dimension', name: 'ServiceName' }],
          },
        }),
      },
    );
    if (!res.ok) {
      console.warn(`[azure-connector] cost query ${res.status} (needs Cost Management Reader)`);
      return null;
    }
    const body = (await res.json()) as { properties?: { columns?: { name?: string }[]; rows?: any[][] } };
    const cols = body.properties?.columns ?? [];
    const iCost = cols.findIndex((c) => /cost/i.test(c.name ?? ''));
    const iSvc = cols.findIndex((c) => /service/i.test(c.name ?? ''));
    const iCur = cols.findIndex((c) => /currency/i.test(c.name ?? ''));
    let total = 0;
    let currency = 'USD';
    const byService: { service: string; cost: number }[] = [];
    for (const row of body.properties?.rows ?? []) {
      const cost = Number(row[iCost] ?? 0);
      const service = String(row[iSvc] ?? 'Other');
      if (iCur >= 0 && row[iCur]) currency = String(row[iCur]);
      total += cost;
      byService.push({ service, cost: Math.round(cost * 100) / 100 });
    }
    byService.sort((a, b) => b.cost - a.cost);
    return { total: Math.round(total * 100) / 100, currency, byService };
  }

  async getCompliance(credentials: ProviderCredentials): Promise<ComplianceStandard[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const res = await fetch(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Security/regulatoryComplianceStandards?api-version=2019-01-01-preview`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.warn(`[azure-connector] compliance ${res.status} (needs Defender for Cloud regulatory compliance)`);
      return [];
    }
    const body = (await res.json()) as { value?: { name?: string; properties?: { passedControls?: number; failedControls?: number } }[] };
    const out: ComplianceStandard[] = [];
    for (const s of body.value ?? []) {
      const passed = s.properties?.passedControls ?? 0;
      const failed = s.properties?.failedControls ?? 0;
      const denom = passed + failed;
      if (denom === 0) continue;
      out.push({ name: friendlyStandard(s.name ?? ''), score: Math.round((passed / denom) * 100), passed, failed });
    }
    return out;
  }

  async getFindings(credentials: ProviderCredentials): Promise<DiscoveredFinding[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const base = `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Security`;
    const findings: DiscoveredFinding[] = [];

    // Severity catalog from assessment metadata.
    const sevByName = new Map<string, string>();
    try {
      const mres = await fetch(`${base}/assessmentMetadata?api-version=2021-06-01`, auth);
      if (mres.ok) {
        const mb = (await mres.json()) as { value?: { name?: string; properties?: { severity?: string } }[] };
        for (const m of mb.value ?? []) if (m.name && m.properties?.severity) sevByName.set(m.name, m.properties.severity.toLowerCase());
      }
    } catch {
      /* ignore */
    }

    // Assessments → unhealthy = misconfiguration/posture findings.
    try {
      const res = await fetch(`${base}/assessments?api-version=2020-01-01`, auth);
      if (res.ok) {
        const body = (await res.json()) as { value?: AzureAssessment[] };
        for (const a of body.value ?? []) {
          if (a.properties?.status?.code !== 'Unhealthy') continue;
          const sev = SEV[sevByName.get(a.name ?? '') ?? a.properties?.status?.severity?.toLowerCase() ?? 'medium'] ?? 'medium';
          findings.push({
            externalId: `azure:${a.id ?? a.name}`,
            title: a.properties?.displayName ?? a.name ?? 'Security assessment',
            type: 'misconfiguration',
            severity: sev,
            status: 'open',
            source: 'defender',
            resourceName: shortName(a.properties?.resourceDetails?.Id ?? a.id),
          });
        }
      }
    } catch {
      /* ignore */
    }

    // Defender alerts → threats (needs Defender plans; best-effort).
    try {
      const res = await fetch(`${base}/alerts?api-version=2022-01-01`, auth);
      if (res.ok) {
        const body = (await res.json()) as { value?: AzureAlert[] };
        for (const al of body.value ?? []) {
          findings.push({
            externalId: `azure:${al.id ?? al.name}`,
            title: al.properties?.alertDisplayName ?? al.name ?? 'Security alert',
            type: 'threat',
            severity: SEV[(al.properties?.severity ?? 'medium').toLowerCase()] ?? 'medium',
            status: al.properties?.status === 'Resolved' ? 'resolved' : 'open',
            source: 'defender',
            resourceName: al.properties?.compromisedEntity,
            detectedAt: al.properties?.timeGeneratedUtc,
          });
        }
      }
    } catch {
      /* ignore */
    }

    return findings;
  }

  async getNetworkRules(credentials: ProviderCredentials): Promise<NetworkRule[]> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const res = await fetch(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Network/networkSecurityGroups?api-version=2023-05-01`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      console.warn(`[azure-connector] NSG list ${res.status} (needs Network Reader)`);
      return [];
    }
    const body = (await res.json()) as { value?: any[] };
    const rules: NetworkRule[] = [];
    for (const nsg of body.value ?? []) {
      for (const r of nsg.properties?.securityRules ?? []) {
        const p = r.properties ?? {};
        const source = (p.sourceAddressPrefix ?? (p.sourceAddressPrefixes ?? []).join(',')) || '*';
        const ports = (p.destinationPortRange ?? (p.destinationPortRanges ?? []).join(',')) || '*';
        rules.push({
          resourceName: nsg.name,
          ruleName: r.name,
          direction: String(p.direction).toLowerCase() === 'inbound' ? 'inbound' : 'outbound',
          access: String(p.access).toLowerCase() === 'allow' ? 'allow' : 'deny',
          protocol: String(p.protocol ?? '*') === '*' ? 'all' : String(p.protocol).toLowerCase(),
          source,
          ports: String(ports),
          priority: p.priority,
        });
      }
    }
    return rules;
  }

  async remediateRule(credentials: ProviderCredentials, target: NetworkRuleTarget): Promise<{ ok: boolean; detail: string }> {
    const { subscriptionId } = this.require(credentials);
    const token = await getAzureToken(credentials);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const listRes = await fetch(
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Network/networkSecurityGroups?api-version=2023-05-01`,
      auth,
    );
    if (!listRes.ok) throw new Error(`azure NSG list ${listRes.status}`);
    const body = (await listRes.json()) as { value?: any[] };
    const nsg = (body.value ?? []).find((n) => n.name === target.resourceName);
    if (!nsg) throw new Error(`NSG "${target.resourceName}" not found`);
    const rule = (nsg.properties?.securityRules ?? []).find((r: any) => r.name === target.ruleName);
    if (!rule?.id) throw new Error(`rule "${target.ruleName}" not found`);
    const props = { ...rule.properties, access: 'Deny' };
    const putRes = await fetch(`https://management.azure.com${rule.id}?api-version=2023-05-01`, {
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ properties: props }),
    });
    if (!putRes.ok && putRes.status !== 200 && putRes.status !== 201) {
      throw new Error(`azure rule PUT ${putRes.status}: ${(await putRes.text()).slice(0, 160)}`);
    }
    return { ok: true, detail: `NSG rule "${target.ruleName}" on ${target.resourceName} set to DENY` };
  }

  /** Best-effort: for each VM, resolve size, OS and private/public IP via VM → NIC → public-IP. */
  private async enrichVms(assets: DiscoveredAsset[], token: string): Promise<void> {
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const get = async (id: string, api: string) => {
      const r = await fetch(`https://management.azure.com${id}?api-version=${api}`, auth);
      return r.ok ? ((await r.json()) as any) : null;
    };
    const vms = assets
      .filter((a) => {
        const t = String(a.properties.azureType ?? '').toLowerCase();
        return t.includes('/virtualmachines') && !t.includes('/extensions');
      })
      .slice(0, 25);

    await Promise.all(
      vms.map(async (vm) => {
        try {
          const v = await get(vm.externalId, '2023-07-01');
          if (!v) return;
          vm.properties.size = v.properties?.hardwareProfile?.vmSize;
          vm.properties.os = (v.properties?.storageProfile?.osDisk?.osType ?? 'Linux').toLowerCase();
          const ov = azureOsVersion(v.properties?.storageProfile?.imageReference);
          if (ov) vm.properties.osVersion = ov;
          // Real power state (running/deallocated/stopped) comes from instanceView —
          // provisioningState alone is always "Succeeded" and would always read as running.
          const iv = await get(`${vm.externalId}/instanceView`, '2023-07-01');
          const power: string | undefined = (iv?.statuses ?? [])
            .map((s: any) => String(s.code || ''))
            .find((c: string) => c.startsWith('PowerState/'));
          vm.properties.state = power ? power.split('/')[1] : v.properties?.provisioningState;
          vm.properties.powerState = power ? power.split('/')[1] : undefined;
          const nicId = v.properties?.networkProfile?.networkInterfaces?.[0]?.id;
          if (!nicId) return;
          const nic = await get(nicId, '2023-05-01');
          const ipcfg = nic?.properties?.ipConfigurations?.[0]?.properties;
          if (ipcfg?.privateIPAddress) vm.properties.privateIp = ipcfg.privateIPAddress;
          const pipId = ipcfg?.publicIPAddress?.id;
          if (pipId) {
            const pip = await get(pipId, '2023-05-01');
            if (pip?.properties?.ipAddress) vm.properties.publicIp = pip.properties.ipAddress;
          }
        } catch {
          /* best-effort */
        }
      }),
    );
  }
}

/** Carve a valid /24 default subnet from a VNet CIDR (or use it as-is when already ≤ /24). */
function defaultSubnet(cidr: string): string {
  const [ip, lenStr] = cidr.split('/');
  const len = Number(lenStr);
  if (!ip || !Number.isFinite(len)) return '10.20.0.0/24';
  return len >= 24 ? cidr : `${ip}/24`;
}

interface AzureResource {
  id?: string;
  name: string;
  type?: string;
  location?: string;
  kind?: string;
  sku?: { name?: string };
  tags?: Record<string, string>;
}

interface AzureAssessment {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    status?: { code?: string; severity?: string };
    resourceDetails?: { Id?: string };
  };
}

interface AzureAlert {
  id?: string;
  name?: string;
  properties?: {
    alertDisplayName?: string;
    severity?: string;
    status?: string;
    compromisedEntity?: string;
    timeGeneratedUtc?: string;
  };
}

function shortName(id?: string): string | undefined {
  if (!id) return undefined;
  return id.split('/').filter(Boolean).pop();
}

function friendlyStandard(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('cis')) return 'CIS Benchmark';
  if (n.includes('iso')) return 'ISO 27001';
  if (n.includes('pci')) return 'PCI DSS';
  if (n.includes('soc')) return 'SOC 2';
  if (n.includes('nist')) return 'NIST CSF';
  if (n.includes('hipaa')) return 'HIPAA';
  return name.replace(/-/g, ' ');
}
