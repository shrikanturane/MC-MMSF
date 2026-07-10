'use client';

import { useState } from 'react';
import { Card, ErrorState, LoadingState, Modal, ProviderBadge, StatusBadge } from '@/components/ui';
import { useVms, useControlVm } from '@/lib/hooks';
import { TOKEN_KEY } from '@/lib/api';
import { pct } from '@/lib/format';
import type { VmRow } from '@/lib/types';

export type VmAction = 'start' | 'stop' | 'reboot';

const PROVIDER_TINT: Record<string, string> = { aws: '#ff9900', azure: '#0078d4', gcp: '#ea4335', docker: '#2496ed', linux: '#f59e0b', windows: '#3b82f6' };
function osIcon(os?: string | null, provider?: string): string {
  const o = (os ?? '').toLowerCase();
  if (provider === 'docker' || o.includes('container')) return '🐳';
  if (o.includes('win')) return '🪟';
  if (o.includes('linux') || provider === 'linux') return '🐧';
  return '🖥';
}

export function VmsTable({ embedded = false, bare = false }: { embedded?: boolean; bare?: boolean }) {
  const { data, isLoading, isError } = useVms();
  const control = useControlVm();
  const [openConnect, setOpenConnect] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ vm: VmRow; action: VmAction } | null>(null);
  const [deleting, setDeleting] = useState<VmRow | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  // Delete files a governed approval (not an immediate action) — the VM is removed only after approval.
  const runDelete = async () => {
    if (!deleting) return;
    const vm = deleting;
    setDeleting(null); setDelBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/network/provision/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : ''}` },
        body: JSON.stringify({ resourceId: vm.id, provider: vm.provider, name: vm.name, region: vm.region }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || 'delete request failed');
      setMsg({ id: vm.id, text: j.duplicate ? 'Delete already requested — pending approval.' : 'Delete requested — approve it in Approvals to execute.', ok: true });
    } catch (e) {
      setMsg({ id: vm.id, text: (e as Error).message, ok: false });
    } finally {
      setDelBusy(false);
    }
  };

  // Every power change opens a confirmation modal (warning + "I accept") before it runs.
  const act = (vm: VmRow, action: VmAction) => {
    setMsg(null);
    setConfirming({ vm, action });
  };

  const runAction = async () => {
    if (!confirming) return;
    const { vm, action } = confirming;
    setConfirming(null);
    try {
      const r = await control.mutateAsync({ id: vm.id, action });
      setMsg({ id: vm.id, text: r.detail, ok: true });
    } catch (e) {
      setMsg({ id: vm.id, text: (e as Error).message, ok: false });
    }
  };

  const body = isLoading ? (
    <div className="p-4"><LoadingState rows={4} /></div>
  ) : isError ? (
    <div className="p-4"><ErrorState /></div>
  ) : !data || data.length === 0 ? (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card text-xl">🖥</span>
      <div className="text-sm font-medium text-white">No VMs discovered yet</div>
      <div className="max-w-sm text-2xs text-muted">Connect a cloud and <b className="text-white">Sync</b>, or add a host agent in Command Center — discovered machines appear here with power control and remote access.</div>
    </div>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
            <th className="px-4 py-2.5 font-medium">VM</th>
            <th className="px-4 py-2.5 font-medium">Provider</th>
            <th className="px-4 py-2.5 font-medium">State</th>
            <th className="px-4 py-2.5 font-medium">CPU</th>
            <th className="px-4 py-2.5 font-medium">Public IP</th>
            <th className="px-4 py-2.5 font-medium">Private IP</th>
            <th className="px-4 py-2.5 font-medium">Power</th>
            <th className="px-4 py-2.5 font-medium">Remote</th>
          </tr>
        </thead>
        <tbody>
          {data.map((vm) => {
            const running = vm.status === 'running';
            const stopped = vm.status === 'stopped' || vm.status === 'terminated';
            return (
              <ConnectableRow key={vm.id} vm={vm} open={openConnect === vm.id} msg={msg?.id === vm.id ? msg : null}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-card text-sm" style={{ borderColor: `${PROVIDER_TINT[vm.provider] ?? '#475569'}66` }} title={`${vm.os ?? ''} · ${vm.provider}`}>{osIcon(vm.os, vm.provider)}</span>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-white">{vm.name}</div>
                      <div className="truncate text-2xs text-muted">{vm.size ?? '—'} · {vm.os} · {vm.region}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5"><ProviderBadge provider={vm.provider} /></td>
                <td className="px-4 py-2.5"><StatusBadge status={vm.status} /></td>
                <td className="px-4 py-2.5">
                  {vm.cpuPct > 0 ? (
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-border"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, vm.cpuPct)}%`, background: vm.cpuPct > 85 ? '#ef4444' : vm.cpuPct > 60 ? '#f59e0b' : '#22c55e' }} /></span>
                      <span className="tabular-nums text-2xs text-muted-light">{pct(vm.cpuPct)}</span>
                    </div>
                  ) : <span className="text-2xs text-muted">—</span>}
                </td>
                <td className="px-4 py-2.5 font-mono text-2xs text-muted-light">{vm.publicIp ?? '—'}</td>
                <td className="px-4 py-2.5 font-mono text-2xs text-muted-light">{vm.privateIp ?? '—'}</td>
                <td className="px-4 py-2.5">
                  {vm.controllable ? (
                    <div className="flex gap-1">
                      <PowerBtn label="Start" color="#22c55e" disabled={running || control.isPending} onClick={() => act(vm, 'start')} />
                      <PowerBtn label="Stop" color="#ef4444" disabled={stopped || control.isPending} onClick={() => act(vm, 'stop')} />
                      <PowerBtn label="Reboot" color="#f59e0b" disabled={!running || control.isPending} onClick={() => act(vm, 'reboot')} />
                      {['aws', 'azure', 'gcp'].includes(vm.provider) && <PowerBtn label="Delete" color="#b91c1c" disabled={delBusy} onClick={() => setDeleting(vm)} />}
                    </div>
                  ) : (
                    <span className="text-2xs text-muted">n/a</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <button
                    onClick={() => setOpenConnect(openConnect === vm.id ? null : vm.id)}
                    disabled={!vm.connect.ip && !vm.connect.docker}
                    className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-brand hover:text-white disabled:opacity-40"
                  >
                    {openConnect === vm.id ? 'Hide' : vm.connect.docker ? 'Console' : 'Connect'}
                  </button>
                </td>
              </ConnectableRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const modal = (
    <>
      {confirming && (
        <VmActionConfirm
          vm={confirming.vm}
          action={confirming.action}
          pending={control.isPending}
          onConfirm={runAction}
          onClose={() => setConfirming(null)}
        />
      )}
      {deleting && (
        <Modal title={`Delete ${deleting.provider.toUpperCase()} VM "${deleting.name}"?`} onClose={() => setDeleting(null)}>
          <div className="space-y-3 text-sm">
            <p className="text-muted">This files a <b className="text-white">governed approval</b> to <b className="text-danger">permanently delete</b> this cloud VM and the resources MCMF created for it (NIC, public IP, firewall). It is <b className="text-white">not reversible</b>. The VM is removed only after an admin approves the request and live provisioning is enabled.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:text-white">Cancel</button>
              <button onClick={runDelete} disabled={delBusy} className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-danger/90 disabled:opacity-50">{delBusy ? 'Requesting…' : 'Request delete'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );

  if (bare) return <><div className="-m-3">{body}</div>{modal}</>; // board widget provides chrome
  if (embedded) {
    return (
      <Card title={`VMs · Hosts · Containers${data ? ` (${data.length})` : ''}`} bodyClassName="p-0" className="col-span-12">
        {body}
        {modal}
      </Card>
    );
  }
  return <Card title={`VMs · Hosts · Containers${data ? ` (${data.length})` : ''}`} bodyClassName="p-0">{body}{modal}</Card>;
}

const ACTION_COLOR: Record<VmAction, { verb: string; color: string }> = {
  start: { verb: 'Start', color: '#22c55e' },
  stop: { verb: 'Stop', color: '#ef4444' },
  reboot: { verb: 'Reboot', color: '#f59e0b' },
};

/** Provider-aware warning text — a container, an SSH host and a cloud VM behave differently. */
function actionWarn(action: VmAction, provider?: string): string {
  const noun = provider === 'docker' ? 'container' : provider === 'linux' || provider === 'windows' ? 'host' : 'cloud VM';
  if (noun === 'container') {
    return action === 'start' ? 'This starts the Docker container.'
      : action === 'stop' ? 'This stops the Docker container — its running processes are terminated.'
      : 'This restarts the Docker container — its processes are briefly interrupted.';
  }
  if (noun === 'host') {
    return action === 'start' ? 'This sends a Wake-on-LAN packet to power the host on — it only works if WoL is enabled in the host BIOS/NIC and MCMF is on the same LAN.'
      : action === 'stop' ? 'This powers OFF the host over SSH. It goes offline and can then only be powered back on via Wake-on-LAN or IPMI/iDRAC — not over SSH.'
      : 'This restarts the host over SSH (sudo). Active sessions and services are interrupted while it reboots.';
  }
  return action === 'start' ? 'This powers on a real cloud VM and will start incurring compute charges.'
    : action === 'stop' ? 'This shuts down a real cloud VM. Running workloads, sessions and services on it will be interrupted.'
    : 'This restarts a real cloud VM. In-flight work and active sessions will be interrupted while it reboots.';
}

type ConfirmVm = { name: string; provider?: string; region?: string; status: string; publicIp?: string | null };

export function VmActionConfirm({ vm, action, pending, onConfirm, onClose }: { vm: ConfirmVm; action: VmAction; pending: boolean; onConfirm: () => void; onClose: () => void }) {
  const [accepted, setAccepted] = useState(false);
  const noun = vm.provider === 'docker' ? 'container' : vm.provider === 'linux' || vm.provider === 'windows' ? 'host' : 'cloud VM';
  const meta = { ...ACTION_COLOR[action], warn: actionWarn(action, vm.provider) };
  return (
    <Modal title={`${meta.verb} ${noun}`} subtitle={`${vm.name}${vm.provider ? ` · ${vm.provider.toUpperCase()}` : ''}${vm.region ? ` · ${vm.region}` : ''}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-lg border px-3 py-2.5 text-2xs" style={{ borderColor: `${meta.color}55`, background: `${meta.color}14`, color: meta.color }}>
          <span className="mr-1 font-semibold">⚠ Warning:</span>
          <span className="text-muted-light">{meta.warn}</span>
        </div>

        <div className="rounded-lg border border-border bg-card/50 p-3 text-2xs">
          <Row k="Action"><span style={{ color: meta.color }}>{meta.verb.toUpperCase()}</span></Row>
          <Row k={noun === 'container' ? 'Container' : noun === 'host' ? 'Host' : 'VM'}>{vm.name}</Row>
          {vm.provider && <Row k="Provider">{vm.provider.toUpperCase()}</Row>}
          <Row k="Current state">{vm.status}</Row>
          {vm.publicIp && <Row k="Public IP">{vm.publicIp}</Row>}
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-bg px-3 py-2.5 text-2xs text-muted-light">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 accent-brand" />
          <span>I understand this affects a real {noun} and I accept responsibility for this <b className="text-white">{meta.verb.toLowerCase()}</b> action.</span>
        </label>

        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={!accepted || pending}
            className="rounded-lg px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: meta.color }}
          >
            {pending ? 'Submitting…' : `${meta.verb} ${noun === 'cloud VM' ? 'VM' : noun}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-2 py-0.5"><span className="text-muted">{k}</span><span className="text-right font-medium text-white">{children}</span></div>;
}

function ConnectableRow({
  vm,
  open,
  msg,
  children,
}: {
  vm: VmRow;
  open: boolean;
  msg: { text: string; ok: boolean } | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr className="border-b border-border-soft last:border-0 hover:bg-card-hover">{children}</tr>
      {msg && (
        <tr>
          <td colSpan={8} className="px-4 pb-2">
            <div className={`rounded-lg border px-3 py-1.5 text-2xs ${msg.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>{msg.text}</div>
          </td>
        </tr>
      )}
      {open && (
        <tr>
          <td colSpan={8} className="bg-bg/40 px-4 py-3">
            <ConnectPanel vm={vm} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Open an in-browser remote console (Guacamole) popup for the VM. */
export function openConsole(host: string, name: string, protocol: 'rdp' | 'ssh' | 'telnet' | 'vnc', meta?: { provider?: string; os?: string }) {
  const q = new URLSearchParams({ host, name, protocol });
  if (meta?.provider) q.set('provider', meta.provider);
  if (meta?.os) q.set('os', meta.os);
  window.open(`/console?${q.toString()}`, `mcmf_console_${host}_${protocol}`, 'width=1320,height=900,menubar=no,toolbar=no');
}

/** Direct RDP — download a native .rdp file (opens in the user's own mstsc / RDP client). */
export async function downloadRdp(id: string, name: string) {
  try {
    const jwt = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
    const res = await fetch(`/api/inventory/resources/${id}/rdp`, { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.rdp`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    alert('Could not generate the .rdp file.');
  }
}

/** Direct SSH — copy the ssh command (opens in the user's own terminal). Pass the login user. */
export function copySsh(host: string, user?: string) {
  let u = (user ?? '').trim();
  if (!u) {
    const remembered = (typeof localStorage !== 'undefined' && (localStorage.getItem(`mcmf:ssh-user:${host}`) || localStorage.getItem('mcmf:ssh-user'))) || '';
    u = (window.prompt(`SSH username for ${host}\n(ubuntu/ec2-user for AWS · azureuser for Azure · your GCP user):`, remembered) ?? '').trim();
    if (!u) return;
    if (typeof localStorage !== 'undefined') { localStorage.setItem(`mcmf:ssh-user:${host}`, u); localStorage.setItem('mcmf:ssh-user', u); }
  }
  const cmd = `ssh ${u}@${host}`;
  navigator.clipboard?.writeText(cmd);
  alert(`Copied:\n${cmd}\n\nPaste into your terminal.\n\nIf you get "Permission denied (publickey)": cloud VMs use SSH KEYS, not passwords — your SSH public key must be authorized on the VM (GCP: OS Login / instance metadata SSH keys; AWS: the EC2 key pair; Azure: the configured key). Or use "SSH (browser)", which connects using the credentials saved in MCMF's vault.`);
}

/** Docker exec — copy the `docker exec -it <id> sh` command to open a shell in the container. */
function copyExec(cmd: string) {
  navigator.clipboard?.writeText(cmd);
  alert(`Copied:\n${cmd}\n\nRun it on the Docker host to open an interactive shell in the container (use bash if sh is unavailable).`);
}

function ConnectPanel({ vm }: { vm: VmRow }) {
  // Container: console = exec a shell (no IP). Offer the copy-command launcher.
  if (vm.connect.docker) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs text-muted">Container console <span className="font-mono text-white">{vm.connect.docker.id.slice(0, 12)}</span>:</span>
        <ConnectBtn label="⌨ Exec shell (copy command)" onClick={() => copyExec(vm.connect.docker!.cmd)} />
        <span className="text-2xs text-muted">runs <span className="font-mono text-muted-light">docker exec -it … sh</span> on the host</span>
      </div>
    );
  }
  const ip = vm.publicIp || vm.privateIp || null;
  const isWin = String(vm.os ?? '').toLowerCase().includes('win');
  if (!ip) return <div className="text-2xs text-muted">No reachable IP — start the VM or attach a public IP.</div>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-2xs text-muted">Connect to <span className="font-mono text-white">{ip}</span>:</span>
      {isWin ? (
        <>
          <ConnectBtn label="🖥 RDP (browser)" onClick={() => openConsole(ip, vm.name, 'rdp', { provider: vm.provider, os: vm.os })} />
          <ConnectBtn label="⤓ RDP (direct .rdp)" onClick={() => downloadRdp(vm.id, vm.name)} />
        </>
      ) : (
        <>
          <ConnectBtn label="⌨ SSH (browser)" onClick={() => openConsole(ip, vm.name, 'ssh', { provider: vm.provider, os: vm.os })} />
          <ConnectBtn label="⧉ SSH (direct)" onClick={() => copySsh(ip)} />
        </>
      )}
    </div>
  );
}

function ConnectBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">{label}</button>
  );
}

function PowerBtn({ label, color, disabled, onClick }: { label: string; color: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border px-2 py-1 text-2xs font-medium transition disabled:cursor-not-allowed disabled:opacity-30"
      style={{ borderColor: `${color}55`, color, background: `${color}14` }}
    >
      {label}
    </button>
  );
}
