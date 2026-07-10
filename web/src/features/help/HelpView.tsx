'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui';
import { useGrantScripts, useRevealGrantScripts, useAgentInstall, useAgentBootstrapCommand, useCluster, useResources, useEnrollAgent, type AgentEnroll } from '@/lib/hooks';
import { useAuthUser } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { accessAllows } from '@/lib/modules';
import { copyText, downloadText } from '@/lib/clipboard';
import { TOKEN_KEY } from '@/lib/api';
import { PROVIDER_COLORS, PROVIDER_LABELS, timeAgo } from '@/lib/format';

/** Wall-clock time in the viewer's own timezone (e.g. Asia/Calcutta) — "11:06 PM" style. */
const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
import type { GrantScript } from '@/lib/types';
import { INTEGRATION_DOCS, PLATFORM_INTEGRATIONS, INFRA_DOCS, SMTP_PROVIDERS, PROVISIONING_DOCS, USER_GUIDE, type Capability, type IntegrationDoc, type Pillar, type PlatformIntegration } from './docs';

const PILLAR_COLOR: Record<Pillar, string> = {
  Manage: '#3b82f6',
  Monitor: '#22c55e',
  Secure: '#ef4444',
  Cost: '#f59e0b',
  Control: '#a855f7',
};

const PILLAR_ICON: Record<Pillar, string> = {
  Manage: '▦',
  Monitor: '◍',
  Secure: '🛡',
  Cost: '$',
  Control: '⚡',
};

type HelpTab = 'guide' | 'clouds' | 'integrations' | 'provisioning' | 'infra' | 'versions';
const HELP_TABS: { id: HelpTab; label: string; icon: string; sections: string[] }[] = [
  { id: 'guide', label: 'Platform Guide', icon: '📘', sections: ['platform-guide'] },
  { id: 'clouds', label: 'Cloud Setup', icon: '☁️', sections: ['grant-scripts', 'cloud-perms'] },
  { id: 'integrations', label: 'Integrations', icon: '🔌', sections: ['platform-integrations', 'smtp'] },
  { id: 'provisioning', label: 'Provisioning', icon: '🛠', sections: ['provisioning'] },
  { id: 'infra', label: 'Agents & Infra', icon: '🖥', sections: ['guest-agent', 'infra'] },
  { id: 'versions', label: 'Version Control', icon: '🏷', sections: ['version-control'] },
];

export function HelpView() {
  const [open, setOpen] = useState<string>('aws');
  const [openPlat, setOpenPlat] = useState<string>('');
  const [openInfra, setOpenInfra] = useState<string>('');
  const [openSmtp, setOpenSmtp] = useState<string>('');
  const [openProv, setOpenProv] = useState<string>('');
  const [tab, setTab] = useState<HelpTab>('guide');
  const { data: me } = useAuthUser();
  const { layout } = useBranding();
  // Admin sees every section; otherwise only help sections granted by the user's group access policy.
  const canSee = (id: string) => accessAllows(me?.access, 'help', id, me?.role);

  // Only show a tab if at least one of its sections is visible to this role.
  const visibleTabs = HELP_TABS.filter((t) => t.sections.some((s) => canSee(s)));

  useEffect(() => {
    // ?doc=<guide-section-id> deep-links into the Platform Guide (e.g. from a failing Zero-Trust check).
    const doc = new URLSearchParams(window.location.search).get('doc');
    if (doc && USER_GUIDE.some((s) => s.id === doc)) { setTab('guide'); return; }
    const h = window.location.hash.replace('#', '') as HelpTab;
    if (HELP_TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const go = (id: HelpTab) => {
    setTab(id);
    window.history.replaceState(null, '', `#${id}`);
  };
  const active = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[0];

  const Legend = (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-4 py-2.5 text-2xs text-muted-light">
      <span className="font-medium text-muted">Status:</span>
      <span className="flex items-center gap-1.5"><span className="rounded bg-success/15 px-1.5 py-0.5 text-success">live</span> available now</span>
      <span className="flex items-center gap-1.5"><span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">planned</span> set perms now — works when the feature ships</span>
      <span className="ml-auto hidden md:block">Pillars: {(['Manage', 'Monitor', 'Secure', 'Cost', 'Control'] as Pillar[]).map((p) => (
        <span key={p} className="ml-2" style={{ color: PILLAR_COLOR[p] }}>{PILLAR_ICON[p]} {p}</span>
      ))}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Help &amp; Integration Guide</div>
          <div className="text-2xs text-muted">
            Platform documentation plus the exact cloud permissions and integration recipes — set it once, it works as each feature ships.
          </div>
        </div>
        <Link href="/connections" className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">
          Go to Connections →
        </Link>
      </div>

      {/* Tab bar — splits the long guide into focused, one-screenful sections */}
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {visibleTabs.map((t) => {
          const on = t.id === active?.id;
          return (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                on ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted hover:text-white'
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Platform Guide */}
      {active?.id === 'guide' && canSee('platform-guide') && <PlatformGuide />}

      {/* Version Control — CI/CD changelog: each build + what changed + when (your local time) */}
      {active?.id === 'versions' && canSee('version-control') && <VersionControl />}

      {/* Cloud Setup — grant scripts + the AWS/Azure/GCP permission reference */}
      {active?.id === 'clouds' && (
        <div className="space-y-4">
          {canSee('grant-scripts') && <GrantScripts />}
          {canSee('grant-scripts') && <CostSetupGuide />}
          {canSee('cloud-perms') && (
            <>
              {Legend}
              <div className="flex flex-wrap gap-2">
                {INTEGRATION_DOCS.map((d) => (
                  <button
                    key={d.provider}
                    onClick={() => setOpen(d.provider)}
                    className={`rounded-lg border px-3 py-1.5 text-xs ${
                      open === d.provider ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted-light hover:text-white'
                    }`}
                  >
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: PROVIDER_COLORS[d.provider] }} />
                    {PROVIDER_LABELS[d.provider]}
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                {INTEGRATION_DOCS.map((d) => (
                  <ProviderCard key={d.provider} doc={d} expanded={open === d.provider} onToggle={() => setOpen(open === d.provider ? '' : d.provider)} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Integrations — platform integrations + SMTP recipes */}
      {active?.id === 'integrations' && (
        <div className="space-y-4">
          {canSee('platform-integrations') && (
            <Card title="Platform Integrations — SSO · MFA · Email · WhatsApp · Slack · PagerDuty · Webhook · AI" bodyClassName="p-0">
              <div className="divide-y divide-border-soft">
                {PLATFORM_INTEGRATIONS.map((p) => (
                  <PlatformCard key={p.id} doc={p} expanded={openPlat === p.id} onToggle={() => setOpenPlat(openPlat === p.id ? '' : p.id)} />
                ))}
              </div>
            </Card>
          )}
          {canSee('smtp') && (
            <Card title="Email (SMTP) Setup — Gmail · Microsoft 365 · SendGrid · Amazon SES" bodyClassName="p-0">
              <div className="divide-y divide-border-soft">
                {SMTP_PROVIDERS.map((p) => (
                  <PlatformCard key={p.id} doc={p} expanded={openSmtp === p.id} onToggle={() => setOpenSmtp(openSmtp === p.id ? '' : p.id)} />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Provisioning */}
      {active?.id === 'provisioning' && canSee('provisioning') && (
        <Card title="Remote Provisioning & Network Configuration — VM · Network · Disk · VPN" bodyClassName="p-0">
          <div className="divide-y divide-border-soft">
            {PROVISIONING_DOCS.map((p) => (
              <PlatformCard key={p.id} doc={p} expanded={openProv === p.id} onToggle={() => setOpenProv(openProv === p.id ? '' : p.id)} />
            ))}
          </div>
        </Card>
      )}

      {/* Agents & Infra — guest agent + data-center / monitoring protocols */}
      {active?.id === 'infra' && (
        <div className="space-y-4">
          {canSee('guest-agent') && <GuestAgentInstall />}
          {canSee('guest-agent') && <ReplicationAgentDownload />}
          {canSee('infra') && (
            <Card title="Data Center & Monitoring Protocols — VMware · Nutanix · Redfish · SNMP · SSH/RDP" bodyClassName="p-0">
              <div className="divide-y divide-border-soft">
                {INFRA_DOCS.map((p) => (
                  <PlatformCard key={p.id} doc={p} expanded={openInfra === p.id} onToggle={() => setOpenInfra(openInfra === p.id ? '' : p.id)} />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/** Version Control — the CI/CD changelog. Each promoted build, what changed, and when (your timezone). */
function VersionControl() {
  const { data: c, isLoading } = useCluster();
  const deploys = c?.deploys ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-white">🏷 Version Control — change log</div>
            <div className="text-2xs text-muted">Every promoted build, what changed in it, and the exact time (your local timezone). Latest 5 retained.</div>
          </div>
          {c?.build && <span className="rounded-lg bg-indigo-500/15 px-2.5 py-1 font-mono text-xs text-indigo-200">current {c.build}</span>}
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <div className="py-6 text-center text-xs text-muted">Loading change log…</div>
        ) : !deploys.length ? (
          <div className="py-6 text-center text-xs text-muted">No builds promoted yet. Each <b className="text-white">Sync to Production</b> records a versioned entry here with its changelog.</div>
        ) : (
          <ol className="relative space-y-4 border-l border-border pl-5">
            {deploys.map((d, i) => (
              <li key={i} className="relative">
                <span className={`absolute -left-[26px] top-1 h-3 w-3 rounded-full border-2 border-panel ${d.status === 'deployed' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono text-xs text-indigo-200">{d.version}</span>
                  {i === 0 && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-2xs text-emerald-300">latest</span>}
                  <span className="text-2xs text-muted">{d.sourceHost || '—'}</span>
                  <span className="text-2xs text-muted-light">→</span>
                  <span className="text-2xs text-white">{d.targetName || d.targetHost}</span>
                  <span className="ml-auto text-2xs text-muted" title={new Date(d.at).toLocaleString()}>🕐 {clock(d.at)} · {timeAgo(d.at)}</span>
                </div>
                <div className="mt-1 rounded-md border border-border-soft bg-card/60 px-2.5 py-1.5 text-2xs text-muted-light">
                  <span className="text-muted">Changes:</span> {d.changes ? <span className="break-words font-mono">{d.changes}</span> : <span className="italic">config / data only — no code change</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

/** The MCMF Platform Guide — full user documentation, expandable sections + download. */
function PlatformGuide() {
  const [open, setOpen] = useState<string>(USER_GUIDE[0]?.id ?? '');
  useEffect(() => {
    const doc = new URLSearchParams(window.location.search).get('doc');
    if (doc && USER_GUIDE.some((s) => s.id === doc)) {
      setOpen(doc);
      setTimeout(() => document.getElementById(`guide-${doc}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, []);
  const download = () => {
    const md =
      `# MCMF Platform Guide\n\n_Generated ${new Date().toLocaleString()}_\n\n` +
      USER_GUIDE.map((s) => `## ${s.title}\n\n${s.body}\n`).join('\n');
    downloadText('MCMF-Platform-Guide.md', md);
  };
  return (
    <Card
      title="MCMF Platform Guide"
      bodyClassName="p-0"
      action={
        <button onClick={download} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-brand hover:text-white">
          ⬇ Download (.md)
        </button>
      }
    >
      <div className="border-b border-border-soft px-4 py-2 text-2xs text-muted">
        A complete walkthrough of the platform — overview, modules, and every key workflow. Click a section to expand, or download the whole guide.
      </div>
      <div className="divide-y divide-border-soft">
        {USER_GUIDE.map((s) => {
          const expanded = open === s.id;
          return (
            <div key={s.id} id={`guide-${s.id}`}>
              <button
                onClick={() => setOpen(expanded ? '' : s.id)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-card-hover"
              >
                <span className="flex items-center gap-2 text-xs font-medium text-white">
                  <span>{s.icon}</span>
                  {s.title}
                </span>
                <span className="text-2xs text-muted">{expanded ? '▾' : '▸'}</span>
              </button>
              {expanded && (
                <div className="whitespace-pre-wrap px-4 pb-3 pl-10 text-2xs leading-relaxed text-muted-light">{s.body}</div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

type AgentTab = 'linuxOutboundAgent' | 'windowsTrayAgent';
function GuestAgentInstall() {
  const { data, isError } = useAgentInstall();
  const [tab, setTab] = useState<AgentTab>('linuxOutboundAgent');
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  // Build + download the real Windows installer (.exe) — kept above the early return (Rules of Hooks).
  const [building, setBuilding] = useState(false);
  const [buildErr, setBuildErr] = useState<string | null>(null);
  const bootstrap = useAgentBootstrapCommand();
  const [bootCopied, setBootCopied] = useState(false);
  if (isError || !data) return null;
  const script = (data as any)[tab] as string;
  const FILENAMES: Record<AgentTab, string> = {
    linuxOutboundAgent: 'mcmf-agent-linux.py',
    windowsTrayAgent: 'mcmf-tray-agent.ps1',
  };
  const filename = FILENAMES[tab];
  const copy = async () => { const ok = await copyText(script); setCopied(ok ? 'ok' : 'fail'); setTimeout(() => setCopied(null), 1800); };
  const download = () => downloadText(filename, script);
  // Build + download the real Windows installer — as .exe or wrapped in a .zip (avoids the browser's
  // "unsafe .exe download" warning on the unsigned installer). Authenticated binary fetch.
  const downloadInstaller = async (asZip = false) => {
    setBuildErr(null); setBuilding(true);
    try {
      const jwt = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
      const res = await fetch(asZip ? '/api/agent/windows-installer-zip' : '/api/agent/windows-installer', { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });
      if (!res.ok) throw new Error(`build failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = asZip ? 'MCMF-Agent-Setup.zip' : 'MCMF-Agent-Setup.exe'; a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setBuildErr((e as Error).message); }
    finally { setBuilding(false); }
  };
  const TABS: [AgentTab, string][] = [
    ['linuxOutboundAgent', 'Outbound Agent — Linux ★'],
    ['windowsTrayAgent', 'Outbound Agent — Windows (.exe) ★'],
  ];
  return (
    <Card title="MCMF Guest Agent — capture memory · disk · network · services · event logs" bodyClassName="p-0">
      <div className="border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-2xs text-muted-light">
        <b className="text-emerald-300">★ Recommended: pure-outbound agent (no inbound ports).</b> The agent <b className="text-white">dials home to MCMF over HTTPS</b> — it never listens on a port, so you open <b className="text-white">no firewall rules on the VM</b>. One outbound connection carries telemetry <i>and</i> a command channel (run · power · config · self-update), and it&apos;s <b className="text-white">env-aware</b>: an agent downloaded from this server reports to <b className="font-mono text-white">{(data as any).ingestUrl?.replace('/api/agent/ingest', '') ?? 'this server'}</b>. Install on any Linux host that can reach MCMF — one line (run as root):
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 select-all overflow-x-auto rounded border border-border bg-bg px-2 py-1 font-mono text-white">{(data as any).linuxInstallCommand ?? '—'}</code>
          <button onClick={() => copyText((data as any).linuxInstallCommand ?? '')} className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-300 hover:text-white">⧉ Copy</button>
        </div>
        <div className="mt-1.5 text-muted">Windows: use the <b className="text-white">Endpoint Agent (.exe)</b> tab — it now runs the same outbound command channel (the inbound listener is off by default). MCMF can run on any port (not just 443); the agent targets whatever host:port it was downloaded from.</div>
      </div>
      <div className="border-b border-border bg-brand/5 px-4 py-3 text-2xs text-muted-light">
        <b className="text-white">One agent, two OSes.</b> Install the outbound agent on a Linux host (one-line command above) or a Windows host (the <b className="text-white">.exe</b> tab). It auto-starts on every boot and keeps running at the lock screen / after logoff (Linux systemd service · Windows SYSTEM scheduled task). Re-running the installer <b className="text-white">updates the existing agent</b> (no duplicate), and you can <b className="text-white">Shut down</b> an agent from Command Center → Guest Agents to make it uninstall itself and drop off the list.
        <div className="mt-1.5 text-muted"><b className="text-white">Check agent status</b> — Windows: <b className="text-white">left-click the tray icon</b> (shows MCMF reachability, command channel, last report/command). Linux: <span className="font-mono">systemctl status mcmf-agent</span> · live logs <span className="font-mono">journalctl -u mcmf-agent -f</span> · quick check <span className="font-mono">systemctl is-active mcmf-agent</span>. Either way, every agent and its last check-in also show in <b className="text-white">Command Center → Guest Agents</b>.</div>
        <div className="mt-1.5 text-muted">Tip: for <b className="text-white">routers, switches and firewalls</b> you don’t need an agent — add them in the IP/Host Monitor with ICMP ping, a TCP port, or SNMP.</div>
      </div>

      {/* Port requirements */}
      <div className="border-b border-border px-4 py-3">
        <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">Port requirements</div>
        <table className="w-full text-2xs">
          <thead><tr className="text-left text-muted"><th className="py-1 pr-3 font-medium">Direction</th><th className="py-1 pr-3 font-medium">Path</th><th className="py-1 pr-3 font-medium">Port</th><th className="py-1 font-medium">Why</th></tr></thead>
          <tbody>
            {data.ports.map((p, i) => (
              <tr key={i} className="border-t border-border-soft"><td className="py-1 pr-3 capitalize text-white">{p.dir}</td><td className="py-1 pr-3 text-muted-light">{p.from} → {p.to}</td><td className="py-1 pr-3 font-mono text-muted-light">{p.proto} {p.port}</td><td className="py-1 text-muted">{p.why}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {TABS.map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-2xs font-medium ${tab === t ? 'bg-brand text-white' : 'border border-border bg-card text-muted hover:text-white'}`}>{label}</button>
          ))}
          {/* The real Windows installer — always reachable, whichever sub-tab is open. */}
          <button onClick={() => downloadInstaller(true)} disabled={building} title="Build & download the Windows installer wrapped in a .zip (no browser warning)" className="ml-auto rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{building ? 'Building…' : '⤓ Windows installer (.zip)'}</button>
          <button onClick={() => downloadInstaller(false)} disabled={building} title="Raw .exe (browsers may warn it's unsafe — the .zip avoids that)" className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white disabled:opacity-50">.exe</button>
          {buildErr && <span className="text-2xs text-danger" title={buildErr}>{buildErr}</span>}
          {tab !== 'windowsTrayAgent' && <button onClick={download} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">⤓ Download {filename}</button>}
          {tab !== 'windowsTrayAgent' && <button onClick={copy} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white">{copied === 'ok' ? 'Copied ✓' : copied === 'fail' ? 'Select & ⌘/Ctrl+C' : '⧉ Copy'}</button>}
        </div>
        {tab === 'windowsTrayAgent' ? (
          <div className="space-y-2 rounded-lg border border-brand/30 bg-brand/5 p-3 text-2xs text-muted-light">
            <div className="text-sm font-semibold text-white">MCMF Endpoint Agent — Windows installer (.exe) <span className="text-emerald-300">★ pure outbound</span></div>
            <div>A standalone agent for Windows endpoints / VMs, delivered as a real <b className="text-white">double-click installer</b> (no scripts to run). Install it on <b className="text-white">as many machines as you like</b> — each reports its own hostname + logged-in user. <b className="text-emerald-300">Pure outbound</b>: it dials home to MCMF over HTTPS and <b className="text-white">never listens on a port</b> — one outbound connection carries telemetry, the <b className="text-white">command channel</b> (run / power / config / self-update) <i>and</i> the <b className="text-white">console tunnel</b> (RDP/SSH). <b className="text-white">No inbound firewall rule</b> on the VM; works behind NAT. It targets the host:port it was downloaded from (MCMF can run on any port).</div>
            <ul className="ml-4 list-disc space-y-0.5">
              <li><b className="text-white">Always-on background service</b>: telemetry runs as a SYSTEM scheduled task that starts at <b className="text-white">boot</b>, auto-restarts on failure, and keeps reporting <b className="text-white">whether or not anyone is logged on</b> — it does <i>not</i> stop when a PowerShell window closes or the user logs off.</li>
              <li>A <b className="text-white">tray icon</b> (settings UI) also auto-starts at logon; click it → <b className="text-white">local-admin (UAC) + app password</b> to open settings. Closing/hiding the tray does <b className="text-white">not</b> stop telemetry — that's the service's job.</li>
              <li>Set the <b className="text-white">MCMF IP + port</b> and pick exactly which telemetry is sent (CPU / memory / disk / network / services / event logs / logged-in user / posture).</li>
              <li>Reports <b className="text-white">logged-in Windows user + device posture</b> (firewall / AV / disk encryption) — the input to the AAA / NAC step.</li>
              <li><b className="text-white">Console over the tunnel</b>: open an RDP/SSH session from MCMF and the agent relays it back through its own outbound HTTPS connection — no inbound 3389/22 on the VM.</li>
              <li>Live status: MCMF reachable? command channel live? last push? Includes an uninstaller (Add/Remove Programs). (The legacy inbound pull listener is <b className="text-white">off by default</b>.)</li>
            </ul>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button onClick={() => downloadInstaller(true)} disabled={building} className="rounded-md bg-brand px-3 py-1.5 font-medium text-white hover:bg-brand-soft disabled:opacity-50">{building ? 'Building…' : '⤓ Download installer (.zip) ★'}</button>
              <button onClick={() => downloadInstaller(false)} disabled={building} className="rounded-md border border-border bg-card px-3 py-1.5 text-muted-light hover:text-white disabled:opacity-50">⤓ Raw .exe</button>
              <button onClick={download} className="rounded-md border border-border bg-card px-3 py-1.5 text-muted-light hover:text-white" title="Download the agent PowerShell source (mcmf-tray-agent.ps1)">⤓ Source (.ps1)</button>
              {buildErr && <span className="text-danger">{buildErr}</span>}
            </div>
            <div className="text-muted">The <b className="text-white">.zip</b> is recommended — browsers flag the unsigned <span className="font-mono">.exe</span> as &ldquo;not safe&rdquo;; download the .zip, extract, and run <span className="font-mono">MCMF-Agent-Setup.exe</span>. The <b className="text-white">.ps1</b> is the same agent as plain source if you prefer to deploy it via GPO/MDM.</div>
            <div className="text-muted">Runs on Windows 10 / 11 and Server 2016+ (PowerShell 5.1 + .NET are in-box). Needs <b className="text-white">only outbound HTTPS</b> to MCMF (the port you downloaded it from — 443 or your custom port). <b className="text-white">No inbound port to open</b> on the VM, NSG or OS firewall. Per-machine settings live in <span className="font-mono">C:\ProgramData\MCMF\agent-config.json</span>. Reported data appears under <b className="text-white">Command Center → Guest Agents</b> (with the user + posture chips).</div>
            <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-emerald-200/90">Upgrading from the old push+pull agent? Re-run this installer (or push <b>self-update</b> from Guest Agents) — the new build turns the inbound listener <b>off</b> and switches to the outbound command channel. You can then <b>close the inbound firewall port</b> you previously opened.</div>
            {/* Zero-dependency bootstrap: no OpenSSH/WinRM/SMB, no .exe — one elevated command on a fresh box. */}
            <div className="rounded-lg border border-brand/30 bg-brand/5 p-2.5">
              <div className="font-semibold text-white">No-dependency bootstrap (fresh box, no OpenSSH)</div>
              <div className="mt-0.5 text-muted">On the new Windows machine, open <b className="text-white">PowerShell as administrator</b> and paste this one command. It downloads + installs the always-on agent (service + tray + firewall) from MCMF — nothing to pre-install:</div>
              {bootstrap.data ? (
                <div className="mt-1.5 flex items-start gap-2">
                  <pre className="flex-1 select-all overflow-auto rounded border border-border bg-bg p-2 font-mono text-2xs leading-relaxed text-muted-light">{bootstrap.data.command}</pre>
                  <button onClick={async () => { const ok = await copyText(bootstrap.data!.command); setBootCopied(ok); setTimeout(() => setBootCopied(false), 1800); }} className="shrink-0 rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">{bootCopied ? 'Copied ✓' : '⧉ Copy'}</button>
                </div>
              ) : <div className="mt-1 text-2xs text-muted">{bootstrap.isError ? 'Could not load the bootstrap command.' : 'Loading…'}</div>}
              <div className="mt-1 text-2xs text-muted">The URL carries the agent key, so treat the command as a secret. Ideal for golden images, GPO/MDM startup scripts, or ad-hoc enrollment.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-2xs text-amber-200/90">
              <b className="text-amber-200">⚠ This is the agent SOURCE (Python) — do not paste it into a shell.</b> Pasting it into bash gives errors like <span className="font-mono">import: command not found</span> / <span className="font-mono">syntax error near unexpected token &apos;(&apos;</span>. To install, use the <b className="text-white">one-line installer at the top of this page</b> (run as root) — it works on any distro (Ubuntu/Debian, SUSE, RHEL/Fedora, Alpine, Arch): installs Python if missing, downloads this agent, and registers it as a service (systemd / OpenRC / SysV). Only use this source if you want to <b className="text-white">⤓ Download</b> it and run it yourself with <span className="font-mono">python3 agent.py</span>.
            </div>
            <pre className="max-h-72 select-all overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-2xs leading-relaxed text-muted-light">{script}</pre>
            <div className="mt-2 rounded-lg border border-border bg-card/50 p-2.5 text-2xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-muted">What MCMF reads — all read-only, only on an authenticated pull</div>
              <div className="text-muted-light">The agent dials home to MCMF over HTTPS (no inbound port, no listener) and on each report sends read-only:</div>
              <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-light sm:grid-cols-3">
                <li>• CPU usage %</li>
                <li>• Memory (RAM) usage %</li>
                <li>• Disk usage %</li>
                <li>• Network throughput</li>
                <li>• Running services + status</li>
                <li>• System event log (warn/error)</li>
                <li>• IP addresses</li>
                <li>• Hostname / OS</li>
              </ul>
              <div className="mt-1 text-muted">Nothing is written or changed on the VM. View it per-VM under <b className="text-white">Command Center → Services Monitoring</b>.</div>
            </div>
            <ul className="mt-2 space-y-1 text-2xs text-muted">
              <li><b className="text-white">Run interval:</b> defaults to 60s. Change it locally with the <span className="font-mono">MCMF_INTERVAL</span> env var (e.g. 30), or centrally from MCMF (Command Center → Guest Agents → set interval) — the agent honors the server value on its next report.</li>
              <li><b className="text-white">Runs as a service/task:</b> use the “Run as service/task” tabs so it survives reboot and appears in <span className="font-mono">systemctl status mcmf-agent</span> / Windows Task Scheduler.</li>
              <li><b className="text-white">Stopping requires an administrator:</b> decommission it in MCMF (admin) and the agent self-exits on its next report, or stop the service/task locally (needs root / Administrator).</li>
              <li><b className="text-white">Enrollment says “can’t connect on 9182”:</b> MCMF connects IN to the VM on TCP 9182, so open inbound 9182 from the MCMF server on the cloud NSG / security group and the OS firewall (the “Install as service” tab adds the OS rule), and confirm the agent is running (<span className="font-mono">systemctl status mcmf-agent</span> / Windows Task Scheduler).</li>
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

/** Replication & DR agent — enroll a host and download the ready-to-run Linux (.sh) / Windows (.ps1) agent. */
function ReplicationAgentDownload() {
  const vms = useResources({ type: 'compute' });
  const enroll = useEnrollAgent();
  const [vmId, setVmId] = useState('');
  const [os, setOs] = useState<'linux' | 'windows'>('linux');
  const [data, setData] = useState<AgentEnroll | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const hostOf = (v: any) => { const p = v?.properties ?? {}; return p.privateIp || p.ip || p.publicIp || p.ipAddress || v?.name || ''; };
  const opts = (vms.data ?? []) as any[];
  const doEnroll = (id: string) => {
    setVmId(id); setData(null); setErr('');
    const v = opts.find((x) => x.id === id); if (!v) return;
    const host = hostOf(v); if (!host) { setErr('This VM has no resolvable host / IP.'); return; }
    enroll.mutateAsync({ host }).then(setData).catch((e) => setErr(String((e as Error)?.message || e)));
  };
  const inst = data ? (os === 'windows' ? data.windows : data.linux) : null;
  const fname = os === 'windows' ? 'mcmf-repl-agent.ps1' : 'mcmf-repl-agent.sh';
  const copy = (t: string, w: string) => { copyText(t).then(() => { setCopied(w); setTimeout(() => setCopied(''), 1500); }); };
  return (
    <Card title="Replication & DR Agent — download & install (Linux · Windows)" bodyClassName="p-0">
      <div className="border-b border-brand/20 bg-brand/5 px-4 py-3 text-2xs text-muted-light">
        The <b className="text-white">standalone replication agent</b> runs replication ON a host (no inbound SSH from MCMF). It installs as a background service that <b className="text-white">auto-updates</b>, <b className="text-white">survives reboot / logoff</b>, and <b className="text-white">restarts on failure</b> (Linux systemd timer · Windows SYSTEM scheduled task). Pick the host, choose the OS, then download the ready-to-run agent or copy the one-line installer. The script has the host&apos;s enrolment key + this MCMF URL baked in — treat it as a secret. Add the <b className="text-white">target</b> host&apos;s SSH creds to the Credential Vault first (MCMF installs the agent&apos;s key onto the target on first check-in). See §13 for the full guide.
      </div>
      <div className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select value={vmId} onChange={(e) => doEnroll(e.target.value)} className="rounded-md border border-border bg-bg px-2.5 py-1 text-2xs text-white focus:border-brand focus:outline-none">
            <option value="">— pick the host to install on —</option>
            {opts.map((v) => <option key={v.id} value={v.id}>{v.name} {hostOf(v) ? `(${hostOf(v)})` : ''}</option>)}
          </select>
          {(['linux', 'windows'] as const).map((o) => (
            <button key={o} onClick={() => setOs(o)} className={`rounded-md px-3 py-1 text-2xs font-medium ${os === o ? 'bg-brand text-white' : 'border border-border bg-card text-muted hover:text-white'}`}>{o === 'linux' ? '🐧 Linux (.sh)' : '🪟 Windows (.ps1)'}</button>
          ))}
          {data && <span className="text-2xs text-muted">agent v{data.version}</span>}
          {inst && <button onClick={() => downloadText(fname, inst.script)} className="ml-auto rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">⤓ Download {fname}</button>}
          {inst && <button onClick={() => copy(inst.oneLiner, 'one')} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white">{copied === 'one' ? 'Copied ✓' : '⧉ Copy installer'}</button>}
        </div>
        {err && <div className="mb-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger">{err}</div>}
        {enroll.isPending && <div className="text-2xs text-muted">Enrolling…</div>}
        {!vmId && !enroll.isPending && <div className="rounded-lg border border-dashed border-border py-6 text-center text-2xs text-muted">Pick a host above to generate its download + installer. (You can also install per-set from Replication → a set&apos;s card → &ldquo;⤓ Install agent&rdquo;.)</div>}
        {inst && (
          <>
            <div className="mb-1 text-2xs text-muted">{os === 'windows' ? 'Run in an elevated PowerShell (Admin):' : 'One-line install (run as root):'}</div>
            <pre className="mb-2 select-all overflow-x-auto rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-2xs text-white">{inst.oneLiner}</pre>
            <details className="rounded-lg border border-border bg-bg px-2.5 py-2">
              <summary className="cursor-pointer text-2xs text-muted">Preview the agent script ({inst.script.length} bytes)</summary>
              <pre className="mt-1 max-h-72 select-all overflow-auto whitespace-pre font-mono text-2xs text-muted-light">{inst.script}</pre>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}

/** Cloud cost / billing — a Cloud Connections concern (separate from the connection Test). Step-by-step. */
const COST_GUIDE: { key: string; label: string; steps: string[]; note: string; deploy: { url: string; label: string }[] }[] = [
  {
    key: 'aws', label: '☁️ AWS',
    steps: [
      'Deploy the grant: use ① Grant Cloud Permissions → "Login & deploy" above — its script already grants ce:GetCostAndUsage.',
      'Enable Cost Explorer: click the button below → it opens the AWS Billing console signed in as you → click Enable (one-time, no CLI exists for this).',
      'In MCMF, Cloud Connections → your AWS connection → the 💰 Cost box shows the status.',
      'Cost appears automatically within ~24h (Cost Explorer backfills) and refreshes every 6h. No further action.',
    ],
    note: 'AWS has NO API/CLI to enable Cost Explorer — it must be turned on in the Billing console (step 2), and its data lags ~24h.',
    deploy: [{ url: 'https://console.aws.amazon.com/cost-management/home#/cost-explorer', label: '🔑 Login & enable AWS Cost Explorer →' }],
  },
  {
    key: 'gcp', label: '☁️ GCP',
    steps: [
      'Deploy the grant: use ① Grant Cloud Permissions → "Login & deploy" above — it grants bigquery.dataViewer + jobUser and enables the BigQuery API.',
      'Turn on the export: click the button below → GCP Billing → Billing export → enable "Standard usage cost" to a BigQuery dataset (this is a billing-account console setting — no CLI).',
      'Wait a few hours for GCP to write the first export rows.',
      'In MCMF: Cloud Connections → your GCP connection → Edit → set "BigQuery billing export table" = project.dataset.gcp_billing_export_v1_XXXXXX.',
      'Save. The 💰 Cost box fills in on the next 6h auto-refresh (or Refresh cost in FinOps → Cost).',
    ],
    note: 'GCP has NO live cost API — cost is read from a BigQuery billing export you enable (steps 2 + 4). The export can only be enabled in the console.',
    deploy: [{ url: 'https://console.cloud.google.com/billing/export', label: '🔑 Login & open GCP BigQuery billing export →' }],
  },
  {
    key: 'azure', label: '☁️ Azure',
    steps: [
      'Assign the role: click the button below → your Subscription → Access control (IAM) → Add role assignment → "Cost Management Reader" (or Reader) → the MCMF app registration.',
      'In MCMF, Cloud Connections → your Azure connection → the 💰 Cost box shows the status.',
      'Cost fills in on the next 6h auto-refresh. No export/enable step needed for Azure.',
    ],
    note: 'Azure exposes cost via the Cost Management API — a single role assignment at the subscription scope is enough.',
    deploy: [{ url: 'https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBladeV2', label: '🔑 Login & open Azure Subscriptions → IAM →' }],
  },
];
function CostSetupGuide() {
  const [p, setP] = useState('aws');
  const g = COST_GUIDE.find((x) => x.key === p)!;
  return (
    <Card title="💰 Cloud cost & billing — set up (Login & deploy)" bodyClassName="p-0">
      <div className="border-b border-border bg-brand/5 px-4 py-3 text-2xs text-muted-light">
        Cost/billing is part of <b className="text-white">Cloud Connections</b> (it does not affect the connection Test). The <b className="text-white">IAM permissions</b> are deployed by the <b className="text-white">Login &amp; deploy</b> button in ① Grant Cloud Permissions above. The remaining <b className="text-white">enable</b> step (AWS Cost Explorer / GCP billing export) has no CLI — the button below opens that cloud&apos;s console signed in as you, on the exact page. Once done, MCMF <b className="text-white">auto-refreshes cost every 6h</b>.
      </div>
      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {COST_GUIDE.map((x) => (
            <button key={x.key} onClick={() => setP(x.key)} className={`rounded-md px-3 py-1 text-xs font-medium ${p === x.key ? 'bg-brand text-white' : 'border border-border bg-card text-muted hover:text-white'}`}>{x.label}</button>
          ))}
          <div className="ml-auto flex gap-2">
            {g.deploy.map((d) => (
              <a key={d.url} href={d.url} target="_blank" rel="noopener noreferrer" className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft">{d.label}</a>
            ))}
          </div>
        </div>
        <ol className="ml-1 space-y-2">
          {g.steps.map((s, i) => (
            <li key={i} className="flex gap-2.5 text-xs text-muted-light">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/20 text-2xs font-semibold text-brand">{i + 1}</span>
              <span className="pt-0.5">{s}</span>
            </li>
          ))}
        </ol>
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-200/90">ℹ {g.note}</div>
      </div>
    </Card>
  );
}

function GrantScripts() {
  const { data, isLoading, isError } = useGrantScripts();
  const reveal = useRevealGrantScripts();
  const [revealed, setRevealed] = useState<GrantScript[] | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  if (isError) return null; // non-admins / no connections — hide silently
  const rows = revealed ?? data ?? [];
  const isMasked = !revealed && (data?.some((g) => g.masked) ?? false);
  const submit = () => {
    setErr('');
    reveal.mutateAsync(code.trim()).then((r) => { setRevealed(r); setShowCode(false); setCode(''); }).catch((e) => setErr(String((e as Error)?.message || e)));
  };
  return (
    <Card title="① Grant Cloud Permissions — copy & run (zero-touch)" bodyClassName="p-0">
      <div className="border-b border-border px-4 py-2 text-2xs text-muted">
        Pre-filled from your connections (identifiers only — no secrets). Two ways: <b className="text-white">Copy</b> the script, or <b className="text-white">Login &amp; run</b> — opens that cloud’s own Cloud Shell signed in as you (GCP runs it automatically; AWS/Azure open the shell, then paste). The grant always runs under <i>your</i> cloud login — MCMF never handles your admin credentials.
      </div>
      {/* Sensitive identifiers (account / subscription / project id) are masked until an admin reveals with 2FA. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-2xs text-amber-200/90">
        {isMasked ? <><span>🔒 Account / subscription / project IDs are hidden. The scripts won&apos;t run until you reveal the real values.</span>
          {!showCode
            ? <button onClick={() => { setShowCode(true); setErr(''); }} className="ml-auto rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">🔓 Reveal (admin + 2FA)</button>
            : <span className="ml-auto flex items-center gap-1.5"><input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} inputMode="numeric" maxLength={8} placeholder="2FA code" autoComplete="one-time-code" className="w-24 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-white focus:border-brand focus:outline-none" /><button onClick={submit} disabled={reveal.isPending || !code.trim()} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{reveal.isPending ? '…' : 'Reveal'}</button><button onClick={() => { setShowCode(false); setCode(''); setErr(''); }} className="text-2xs text-muted hover:text-white">cancel</button></span>}
        </> : revealed ? <><span className="text-success">🔓 Real identifiers revealed (2FA verified). Copy or run the scripts below.</span><button onClick={() => setRevealed(null)} className="ml-auto rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white">Hide again</button></> : <span>Identifiers pre-filled from your connections.</span>}
      </div>
      {err && <div className="border-b border-danger/20 bg-danger/5 px-4 py-1.5 text-2xs text-danger">{err}</div>}
      {isLoading && <div className="px-4 py-6 text-center text-2xs text-muted">Loading your connection identities…</div>}
      <div className="divide-y divide-border-soft">
        {rows.map((g) => <GrantScriptRow key={g.provider} g={g} />)}
        {data?.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">Connect AWS, Azure or GCP first (Settings → Connections).</div>}
      </div>
    </Card>
  );
}

function GrantScriptRow({ g }: { g: GrantScript }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(g.script);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const download = () => downloadText(`grant-mcmf-${g.provider}.sh`, g.script);
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PROVIDER_COLORS[g.provider as keyof typeof PROVIDER_COLORS] }} />
          <span className="text-sm font-semibold text-white">{PROVIDER_LABELS[g.provider as keyof typeof PROVIDER_LABELS] ?? g.provider}</span>
          <span className="text-2xs text-muted">{g.connectionName} · run in {g.shell}</span>
          {g.ready
            ? <span className="rounded bg-success/15 px-1.5 py-0.5 text-2xs text-success">pre-filled ✓</span>
            : <span className="rounded bg-warning/15 px-1.5 py-0.5 text-2xs text-warning">edit: {g.missing.join(', ')}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={download} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white">⤓ Download</button>
          <button onClick={copy} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-brand hover:text-white">{copied ? 'Copied ✓' : '⧉ Copy'}</button>
          {g.loginUrl && (
            <a href={g.loginUrl} target="_blank" rel="noopener noreferrer" onClick={() => { if (!g.autoRun) copy(); }}
              className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">
              🔑 {g.autoRun ? 'Login & deploy' : 'Login & paste'}
            </a>
          )}
        </div>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-3 font-mono text-2xs leading-relaxed text-muted-light">{g.script}</pre>
      <div className="mt-1 text-2xs text-muted">
        {g.autoRun
          ? '🔑 Login & deploy opens Google Cloud Shell signed in as you and runs the grant (you just confirm the trust prompt).'
          : `🔑 Login & paste opens ${g.shell} signed in as you and copies the script — paste (Ctrl/⌘+V) and press Enter.`}
      </div>
    </div>
  );
}

function ProviderCard({ doc, expanded, onToggle }: { doc: IntegrationDoc; expanded: boolean; onToggle: () => void }) {
  return (
    <Card bodyClassName="p-0">
      <button onClick={onToggle} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg text-2xs font-bold text-white" style={{ background: PROVIDER_COLORS[doc.provider] }}>
            {PROVIDER_LABELS[doc.provider].slice(0, 2).toUpperCase()}
          </span>
          <span>
            <span className="block text-sm font-semibold text-white">{doc.title}</span>
            <span className="block text-2xs text-muted">{doc.summary}</span>
          </span>
        </span>
        <span className="text-muted">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="space-y-5 border-t border-border px-5 py-4">
          {/* Authenticate */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="1 · Authenticate">
              <p className="mb-2 text-2xs text-muted-light">{doc.auth}</p>
              <dl className="space-y-1.5">
                {doc.credentials.map((c) => (
                  <div key={c.field} className="text-xs">
                    <dt className="font-medium text-white">{c.field}</dt>
                    <dd className="text-2xs text-muted">{c.desc}</dd>
                  </div>
                ))}
              </dl>
            </Section>
            <Section title="2 · Setup steps">
              <ol className="list-decimal space-y-1.5 pl-4 text-2xs text-muted-light">
                {doc.setupSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              <div className="mt-3 rounded-lg border border-brand/20 bg-brand/5 p-3 text-2xs text-muted-light">
                <span className="font-medium text-brand">Quick grant · </span>{doc.quickGrant}
              </div>
            </Section>
          </div>

          {/* Capabilities / permissions matrix */}
          <Section title="3 · Permissions by capability">
            <div className="grid gap-3 md:grid-cols-2">
              {doc.capabilities.map((cap) => <CapabilityCard key={cap.pillar} cap={cap} />)}
            </div>
          </Section>

          {/* Network */}
          <Section title="Network">
            <ul className="list-disc space-y-1 pl-4 text-2xs text-muted-light">
              {doc.network.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </Section>
        </div>
      )}
    </Card>
  );
}

function CapabilityCard({ cap }: { cap: Capability }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold text-white">
          <span style={{ color: PILLAR_COLOR[cap.pillar] }}>{PILLAR_ICON[cap.pillar]}</span>
          {cap.pillar}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-2xs ${cap.status === 'live' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
          {cap.status}
        </span>
      </div>
      <p className="mb-2 text-2xs text-muted">{cap.what}</p>

      <Line label="Grant" items={cap.grant} />
      {cap.enable && <Line label="Enable" items={cap.enable} />}
      {cap.actions && <Line label="Actions" items={cap.actions} mono />}
      {cap.notes?.map((n, i) => (
        <div key={i} className="mt-1.5 text-2xs text-muted-light">ⓘ {n}</div>
      ))}
    </div>
  );
}

function Line({ label, items, mono = false }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div className="mt-1.5 flex gap-2 text-2xs">
      <span className="w-12 shrink-0 font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="flex flex-wrap gap-1">
        {items.map((it, i) => (
          <span key={i} className={`rounded bg-bg px-1.5 py-0.5 text-muted-light ${mono ? 'font-mono' : ''}`}>{it}</span>
        ))}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}

function PlatformCard({ doc, expanded, onToggle }: { doc: PlatformIntegration; expanded: boolean; onToggle: () => void }) {
  return (
    <div>
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-card-hover">
        <div className="flex items-center gap-3">
          <span className="text-lg">{doc.icon}</span>
          <div>
            <div className="text-sm font-medium text-white">{doc.title}</div>
            <div className="text-2xs text-muted">{doc.summary}</div>
          </div>
        </div>
        <span className="shrink-0 text-muted">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-border-soft bg-bg/30 px-4 py-3">
          <div>
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Step by step</div>
            <ol className="list-decimal space-y-1.5 pl-4 text-2xs text-muted-light">
              {doc.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
          {doc.env && (
            <div>
              <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Server environment (~/mcmf/.env)</div>
              <div className="divide-y divide-border-soft rounded-lg border border-border">
                {doc.env.map((e) => (
                  <div key={e.key} className="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:gap-3">
                    <span className="shrink-0 font-mono text-2xs text-brand sm:w-44">{e.key}</span>
                    <span className="text-2xs text-muted">{e.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {doc.notes && (
            <ul className="space-y-1 text-2xs text-muted">
              {doc.notes.map((n, i) => <li key={i} className="flex gap-1.5"><span className="text-warning">•</span>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
