import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EC2InstanceConnectClient, SendSSHPublicKeyCommand } from '@aws-sdk/client-ec2-instance-connect';
import { getGcpToken } from '../../connectors/gcp.auth';
import { getAzureToken } from '../../connectors/azure.auth';

const exec = promisify(execFile);

export interface BrokeredSsh { privateKey: string; username: string }

/**
 * Generate a throwaway ed25519 keypair. The PUBLIC half is pushed to the cloud (short-lived,
 * 60s for AWS); the PRIVATE half is handed to guacd inside the encrypted console token only —
 * never stored. Falls back to RSA if ed25519 isn't supported by the host's ssh-keygen.
 */
export async function ephemeralKey(): Promise<{ pub: string; priv: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmf-ssh-'));
  const kf = path.join(dir, 'k');
  try {
    try {
      await exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', kf, '-C', 'mcmf-ephemeral', '-q']);
    } catch {
      await exec('ssh-keygen', ['-t', 'rsa', '-b', '2048', '-N', '', '-f', kf, '-C', 'mcmf-ephemeral', '-q']);
    }
    return { priv: fs.readFileSync(kf, 'utf8'), pub: fs.readFileSync(kf + '.pub', 'utf8').trim() };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * AWS EC2 Instance Connect: push the ephemeral public key (valid ~60s) using the account's
 * stored IAM credentials, then return the private key for guacd. Requires the EC2 Instance
 * Connect agent on the instance (Amazon Linux 2+, Ubuntu 20.04+) and ec2-instance-connect:
 * SendSSHPublicKey permission. No key management for the operator.
 */
export async function brokerAwsSsh(
  creds: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string },
  region: string,
  instanceId: string,
  osUser: string,
): Promise<BrokeredSsh> {
  if (!creds.accessKeyId || !creds.secretAccessKey) throw new Error('AWS credentials are missing on the connection');
  if (!instanceId) throw new Error('this VM has no EC2 instance id');
  const user = osUser || 'ec2-user';
  const { pub, priv } = await ephemeralKey();
  const client = new EC2InstanceConnectClient({ region, credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken } });
  await client.send(new SendSSHPublicKeyCommand({ InstanceId: instanceId, InstanceOSUser: user, SSHPublicKey: pub }));
  return { privateKey: priv, username: user };
}

/**
 * GCP: push the ephemeral public key onto the instance's `ssh-keys` metadata using the service
 * account, wait for the guest agent to create the user + authorized_keys, then return the private
 * key for guacd. Works on metadata-SSH VMs; an OS-Login VM ignores metadata keys, so we detect
 * that and bail with a clear message (use paste-key there). Old mcmf-ephemeral keys are pruned.
 */
export async function brokerGcpSsh(
  creds: Record<string, string>,
  zone: string,
  instanceName: string,
  osUser: string,
): Promise<BrokeredSsh> {
  const user = (osUser || 'mcmf-user').trim().replace(/[^a-z0-9_-]/gi, '') || 'mcmf-user';
  if (!zone) throw new Error('this GCP VM has no zone recorded — cannot broker SSH');
  const { token, project } = await getGcpToken(creds as any);
  const base = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instanceName)}`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const inst: any = await fetch(base, { headers: h }).then((r) => r.json());
  if (inst?.error) {
    const m = inst.error?.message || 'unknown';
    if (inst.error?.code === 403 || /permission/i.test(m)) throw new Error(`GCP denied reading the instance (403): ${m}. The connection's service account needs compute.instances.get — grant roles/compute.viewer (read) on the project.`);
    throw new Error(`GCP get instance failed: ${m}`);
  }
  const md = inst.metadata || { items: [] };
  const items: { key: string; value: string }[] = md.items || [];
  const osLogin = items.find((i) => i.key === 'enable-oslogin')?.value;
  if (String(osLogin ?? '').toUpperCase() === 'TRUE') {
    throw new Error('This GCP VM uses OS Login, which ignores brokered SSH keys. Use "Private key" and paste your gcloud key (cat ~/.ssh/google_compute_engine).');
  }
  const { pub, priv } = await ephemeralKey();
  const existing = items.find((i) => i.key === 'ssh-keys')?.value ?? '';
  const kept = existing.split('\n').filter((l) => l.trim() && !l.includes('mcmf-ephemeral')).join('\n');
  const line = `${user}:${pub}`;
  const merged = kept ? `${kept}\n${line}` : line;
  const newItems = items.filter((i) => i.key !== 'ssh-keys').concat({ key: 'ssh-keys', value: merged });
  const res = await fetch(`${base}/setMetadata`, { method: 'POST', headers: h, body: JSON.stringify({ fingerprint: md.fingerprint, items: newItems }) });
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 200);
    if (res.status === 403) throw new Error(`GCP denied pushing the SSH key (403): ${txt}. The connection's service account is missing compute.instances.setMetadata — grant roles/compute.instanceAdmin.v1 (or a custom role with compute.instances.get + setMetadata) on the project. Read-only roles like roles/compute.viewer can't write the key.`);
    throw new Error(`GCP setMetadata failed (${res.status}): ${txt}`);
  }
  // give the guest agent time to create the user + apply the key
  await new Promise((r) => setTimeout(r, 10_000));
  return { privateKey: priv, username: user };
}

/**
 * Azure: push the ephemeral public key with the VMAccess extension (using the connection's service
 * principal), wait for it to provision, then return the private key. Slower than AWS/GCP (the
 * extension takes ~30–60s to apply) and the key lingers on the VM until removed. resourceId is the
 * full ARM id (/subscriptions/…/virtualMachines/<name>).
 */
export async function brokerAzureSsh(
  creds: Record<string, string>,
  resourceId: string,
  location: string,
  osUser: string,
): Promise<BrokeredSsh> {
  const user = (osUser || 'azureuser').trim();
  if (!resourceId) throw new Error('this Azure VM has no ARM resource id');
  const token = await getAzureToken(creds as any);
  const { pub, priv } = await ephemeralKey();
  const ext = `https://management.azure.com${resourceId}/extensions/enablevmaccess?api-version=2023-09-01`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = { location, properties: { publisher: 'Microsoft.OSTCExtensions', type: 'VMAccessForLinux', typeHandlerVersion: '1.5', autoUpgradeMinorVersion: true, forceUpdateTag: String(Date.now()), protectedSettings: { username: user, ssh_key: pub } } };
  const put = await fetch(ext, { method: 'PUT', headers: h, body: JSON.stringify(body) });
  if (![200, 201, 202].includes(put.status)) throw new Error(`Azure VMAccess push failed (${put.status}): ${(await put.text()).slice(0, 200)}`);
  // poll the extension's provisioning state (up to ~75s)
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st: any = await fetch(ext, { headers: h }).then((r) => r.json()).catch(() => ({}));
    const ps = st?.properties?.provisioningState;
    if (ps === 'Succeeded') return { privateKey: priv, username: user };
    if (ps === 'Failed') throw new Error('The Azure VMAccess extension failed to apply the key — check the VM is a running Linux VM with the agent.');
  }
  // applied (key likely usable) even if still finalizing
  return { privateKey: priv, username: user };
}
