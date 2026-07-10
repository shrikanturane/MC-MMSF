'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, ErrorState, LoadingState, Modal } from '@/components/ui';
import { useTopology, useProvisionRequest, useProvisionSchema, useControlVm, useDeleteResource } from '@/lib/hooks';
import { PROVIDER_COLORS, PROVIDER_LABELS } from '@/lib/format';
import { openConsole, downloadRdp, copySsh, VmActionConfirm, type VmAction } from '@/features/vms/VmsTable';
import type { TopologyData, TopoProvider, TopoNet, TopoVm, ProvField } from '@/lib/types';

function ConsoleBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick} className="rounded-md bg-brand px-2.5 py-1 text-2xs font-medium text-white hover:bg-brand-soft">{label}</button>;
}

/** VM detail: OS + live CPU/mem/disk, OS-based console (Win→RDP, Linux→SSH), power on/off (no reboot). */
function VmDetail({ v }: { v: TopoVm }) {
  const control = useControlVm();
  const del = useDeleteResource();
  const [confirm, setConfirm] = useState<VmAction | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const remove = async () => {
    if (!window.confirm('Remove this VM from inventory & topology?\n\n' + v.name + '\n\nThis deletes the inventory record. A cloud VM returns on the next scan unless you disconnect the account; a host VM returns if its agent is still installed.')) return;
    setMsg(null);
    try {
      const r = await del.mutateAsync(v.id);
      setMsg({ ok: !r.willReturn, text: r.note });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const ip = v.publicIp || v.privateIp || null;
  const isWin = String(v.os ?? '').toLowerCase().includes('win');
  const running = v.status === 'running';
  const stopped = v.status === 'stopped' || v.status === 'deallocated' || v.status === 'terminated';

  const run = async () => {
    if (!confirm) return;
    const action = confirm;
    setConfirm(null);
    setMsg(null);
    try {
      const r = await control.mutateAsync({ id: v.id, action });
      setMsg({ ok: true, text: r.detail });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <Card title={v.name}>
      <div className="space-y-1.5 text-2xs">
        <Row k="Status"><span style={{ color: statusColor(v.up, v.status) }}>● {v.status}</span></Row>
        <Row k="OS"><span className="capitalize text-white">{v.os ?? '—'}{v.size ? ` · ${v.size}` : ''}</span></Row>
        <Row k="Public IP"><span className="font-mono text-white">{v.publicIp ?? '—'}</span></Row>
        <Row k="Private IP"><span className="font-mono text-white">{v.privateIp ?? '—'}</span></Row>
      </div>

      {v.up && (
        <div className="mt-3 space-y-2 border-t border-border-soft pt-3">
          <Meter label="CPU" pct={v.cpuPct ?? 0} />
          <Meter label="Memory" pct={v.memoryPct ?? 0} />
          <Meter label="Disk" pct={v.diskPct ?? 0} />
          <div className="text-2xs text-muted">Memory/disk show when a guest agent is installed; otherwise 0.</div>
        </div>
      )}

      {/* Power on/off (no reboot) */}
      {v.controllable && (
        <div className="mt-3 border-t border-border-soft pt-3">
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Power</div>
          <div className="flex gap-2">
            <button onClick={() => setConfirm('start')} disabled={running || control.isPending} className="rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-2xs font-medium text-success disabled:opacity-30">⏻ Power on</button>
            <button onClick={() => setConfirm('stop')} disabled={stopped || control.isPending} className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-2xs font-medium text-danger disabled:opacity-30">⏼ Power off</button>
          </div>
        </div>
      )}

      {/* Connect — OS-based: Windows → RDP, Linux → SSH */}
      <div className="mt-3 border-t border-border-soft pt-3">
        <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Connect</div>
        {ip ? (
          <div className="flex flex-wrap gap-2">
            {isWin ? (
              <>
                <ConsoleBtn label="🖥 RDP (browser)" onClick={() => openConsole(ip, v.name, 'rdp', { provider: v.provider, os: v.os ?? undefined })} />
                <ConsoleBtn label="⤓ RDP (direct)" onClick={() => downloadRdp(v.id, v.name)} />
              </>
            ) : (
              <div className="flex w-full flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <ConsoleBtn label="⌨ SSH (browser)" onClick={() => openConsole(ip, v.name, 'ssh', { provider: v.provider, os: v.os ?? undefined })} />
                  <ConsoleBtn label="⧉ SSH (direct)" onClick={() => copySsh(ip)} />
                </div>
                <div className="text-[10px] text-muted"><b className="text-white">SSH (browser)</b> opens the in-app console — it asks for the username + password or <b className="text-white">private key</b> (cloud VMs are key-based) and connects through MCMF. <b className="text-white">SSH (direct)</b> copies an ssh command for your own terminal.</div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-2xs text-muted">No reachable IP — power on the VM or attach a public IP.</div>
        )}
      </div>

      {/* Remove from topology / inventory */}
      <div className="mt-3 border-t border-border-soft pt-3">
        <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Inventory</div>
        <button onClick={remove} disabled={del.isPending} className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-2xs font-medium text-danger hover:bg-danger/20 disabled:opacity-40" title="Delete this resource from inventory & the topology view">🗑 {del.isPending ? 'Removing…' : 'Remove from topology'}</button>
      </div>

      {msg && <div className={`mt-2 rounded-lg border px-3 py-1.5 text-2xs ${msg.ok ? 'border-success/30 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning'}`}>{msg.text}</div>}
      {confirm && (
        <VmActionConfirm vm={{ name: v.name, provider: v.provider, region: v.region, status: v.status, publicIp: v.publicIp }} action={confirm} pending={control.isPending} onConfirm={run} onClose={() => setConfirm(null)} />
      )}
    </Card>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  const v = Math.max(0, Math.min(100, pct));
  const color = v >= 85 ? '#ef4444' : v >= 60 ? '#f59e0b' : '#22c55e';
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-2xs"><span className="text-muted">{label}</span><span className="text-white">{v}%</span></div>
      <div className="h-1.5 w-full rounded-full bg-border"><div className="h-1.5 rounded-full" style={{ width: `${v}%`, background: color }} /></div>
    </div>
  );
}

const NEW = '__new__';

const ROW_H = 46;
const COL = { app: 16, provider: 190, net: 410, vm: 650 };
const W = { app: 120, provider: 165, net: 165, vm: 180 };

type Sel =
  | { kind: 'provider'; data: TopoProvider }
  | { kind: 'net'; data: TopoNet }
  | { kind: 'vm'; data: TopoVm }
  | null;

const statusColor = (up: boolean, status: string) => (up ? '#22c55e' : status === 'unknown' ? '#64748b' : '#ef4444');
const connColor = (s: string) => (s === 'connected' ? '#22c55e' : s === 'error' ? '#ef4444' : '#64748b');

export function TopologyView() {
  const topo = useTopology();
  const [sel, setSel] = useState<Sel>(null);
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [zoom, setZoom] = useState(1);

  const layout = useMemo(() => (topo.data ? buildLayout(topo.data) : null), [topo.data]);

  // Click a node → select it AND anchor the detail popover where it was clicked, so the details
  // always appear right next to the node (no scrolling up to a fixed side panel).
  const pick = (n: LayoutNode, e: React.MouseEvent) => {
    const s = toSel(n);
    if (!s) return;
    setSel(s);
    setPop({ x: e.clientX, y: e.clientY });
  };
  const closePop = () => setPop(null);

  // Render the map at the full width of its container (min 850) so it uses the whole screen.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [mapW, setMapW] = useState(850);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setMapW(Math.max(850, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [topo.data]);

  if (topo.isLoading) return <LoadingState rows={8} />;
  if (topo.isError || !topo.data || !layout) return <ErrorState />;
  const d = topo.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Virtual Network Topology</div>
          <div className="text-2xs text-muted">App → cloud → VPC/VNet → VMs. <span className="text-success">●</span> up · <span className="text-danger">●</span> down. Click a node — details open right beside it.</div>
        </div>
        <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Provision Resource</button>
      </div>

      <Card
        title="Topology Map"
        bodyClassName="p-0"
        action={
          <div className="flex items-center gap-2">
            <ZoomControls zoom={zoom} setZoom={setZoom} />
            <button onClick={() => setExpanded(true)} className="rounded-md border border-border bg-card px-2.5 py-1 text-2xs text-muted-light hover:text-white" title="Expand to full screen">⛶ Expand</button>
          </div>
        }
      >
        <div ref={wrapRef} className="overflow-auto" style={{ maxHeight: '74vh' }}>
          <MapSvg layout={layout} sel={sel} onPick={pick} width={Math.round(mapW * zoom)} />
        </div>
      </Card>

      <VpnPanel data={d} />

      {/* Dynamic detail popover anchored to the clicked node (hidden under the full-screen view). */}
      {!expanded && pop && sel && <NodePopover sel={sel} x={pop.x} y={pop.y} onClose={closePop} />}

      {/* Full-screen map. */}
      {expanded && (
        <div className="fixed inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className="text-sm font-semibold text-white">Topology Map — full screen</div>
            <div className="flex items-center gap-2">
              <ZoomControls zoom={zoom} setZoom={setZoom} />
              <button onClick={() => { setExpanded(false); closePop(); }} className="rounded-md border border-border bg-card px-3 py-1 text-xs text-muted-light hover:text-white">✕ Close</button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <MapSvg layout={layout} sel={sel} onPick={pick} width={Math.round(Math.max(850, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 48) * zoom)} />
          </div>
          {pop && sel && <NodePopover sel={sel} x={pop.x} y={pop.y} onClose={closePop} />}
        </div>
      )}

      {adding && <ProvisionModal providers={d.providers.map((p) => p.provider)} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** Zoom in / out / reset for the topology map. */
function ZoomControls({ zoom, setZoom }: { zoom: number; setZoom: (fn: (z: number) => number) => void }) {
  const clamp = (z: number) => Math.min(3, Math.max(0.5, Math.round(z * 10) / 10));
  const btn = 'flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-sm text-muted-light hover:text-white';
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => setZoom((z) => clamp(z - 0.2))} className={btn} title="Zoom out">−</button>
      <button onClick={() => setZoom(() => 1)} className="min-w-[44px] rounded-md border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-light hover:text-white" title="Reset zoom">{Math.round(zoom * 100)}%</button>
      <button onClick={() => setZoom((z) => clamp(z + 0.2))} className={btn} title="Zoom in">+</button>
    </div>
  );
}

/** The topology SVG, rendered at a given pixel width (scales proportionally). */
function MapSvg({ layout, sel, onPick, width }: { layout: ReturnType<typeof buildLayout>; sel: Sel; onPick: (n: LayoutNode, e: React.MouseEvent) => void; width: number }) {
  const scale = width / 850;
  return (
    <svg viewBox={`0 0 850 ${layout.height}`} width={width} height={layout.height * scale} style={{ minWidth: width }}>
      {layout.links.map((l, i) => {
        const a = layout.map[l.from];
        const b = layout.map[l.to];
        if (!a || !b) return null;
        const x1 = a.x + a.w;
        const x2 = b.x;
        const mx = (x1 + x2) / 2;
        return <path key={i} d={`M ${x1} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${x2} ${b.y}`} fill="none" stroke="#2a3441" strokeWidth={1.5} />;
      })}
      {layout.nodes.map((n) => (
        <Node key={n.id} n={n} selected={isSel(sel, n)} onClick={(e) => onPick(n, e)} />
      ))}
    </svg>
  );
}

/** Floating detail card anchored next to the clicked node, always kept fully on screen. */
function NodePopover({ sel, x, y, onClose }: { sel: Sel; x: number; y: number; onClose: () => void }) {
  const W = 340;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  // Horizontal: prefer right of the cursor; flip left if it would overflow.
  const left = x + 16 + W > vw ? Math.max(8, x - W - 16) : x + 16;
  // Vertical: if the click is in the lower part of the screen, open the popover UPWARD so a
  // bottom VM's details stay fully visible instead of running off the bottom edge.
  const lowerHalf = y > vh * 0.5;
  const pos: React.CSSProperties = lowerHalf
    ? { left, bottom: Math.max(8, vh - y - 24) }
    : { left, top: Math.max(8, y - 24) };
  const maxHeight = lowerHalf ? Math.max(160, y - 16) : Math.max(160, vh - Math.max(8, y - 24) - 12);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed z-50 w-[340px] max-w-[92vw]" style={pos}>
        <div className="relative overflow-auto rounded-xl border border-brand/40 bg-panel shadow-2xl shadow-black/60" style={{ maxHeight }}>
          <button onClick={onClose} className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-2xs text-muted-light hover:text-white" title="Close">✕</button>
          <DetailPanel sel={sel} />
        </div>
      </div>
    </>
  );
}

// ── SVG node ──
function Node({ n, selected, onClick }: { n: LayoutNode; selected: boolean; onClick: (e: React.MouseEvent) => void }) {
  const w = n.w;
  const h = 36;
  const ring = selected ? '#3b82f6' : '#232a33';
  if (n.type === 'app') {
    return (
      <g onClick={onClick} className="cursor-pointer">
        <rect x={n.x} y={n.y - 18} width={w} height={h} rx={8} fill="#1f2937" stroke="#3b82f6" strokeWidth={1.5} />
        <text x={n.x + w / 2} y={n.y + 4} textAnchor="middle" fill="#fff" fontSize="12" fontWeight="600">🛰 MCMF</text>
      </g>
    );
  }
  if (n.type === 'provider') {
    const p = n.data as TopoProvider;
    return (
      <g onClick={onClick} className="cursor-pointer">
        <rect x={n.x} y={n.y - 18} width={w} height={h} rx={7} fill="#161b22" stroke={ring} strokeWidth={selected ? 2 : 1} />
        <rect x={n.x} y={n.y - 18} width={4} height={h} rx={2} fill={PROVIDER_COLORS[p.provider]} />
        <circle cx={n.x + 16} cy={n.y} r={4} fill={connColor(p.status)} />
        <text x={n.x + 26} y={n.y - 2} fill="#fff" fontSize="11" fontWeight="600">{PROVIDER_LABELS[p.provider]}</text>
        <text x={n.x + 26} y={n.y + 10} fill="#8b95a3" fontSize="8.5">{p.upCount}/{p.vmCount} up{p.hasVpn ? ' · VPN' : ''}</text>
      </g>
    );
  }
  if (n.type === 'net') {
    const net = n.data as TopoNet;
    return (
      <g onClick={onClick} className="cursor-pointer">
        <rect x={n.x} y={n.y - 18} width={w} height={h} rx={7} fill="#161b22" stroke={ring} strokeWidth={selected ? 2 : 1} />
        <text x={n.x + 8} y={n.y - 2} fill="#cbd5e1" fontSize="10" fontWeight="600">{trunc(net.name, 20)}</text>
        <text x={n.x + 8} y={n.y + 10} fill="#8b95a3" fontSize="8.5">{net.vnet ? `vnet ${trunc(net.vnet, 12)} · ` : ''}{net.vms.length} vm</text>
      </g>
    );
  }
  const vm = n.data as TopoVm;
  return (
    <g onClick={onClick} className="cursor-pointer">
      <rect x={n.x} y={n.y - 18} width={w} height={h} rx={7} fill="#161b22" stroke={ring} strokeWidth={selected ? 2 : 1} />
      <circle cx={n.x + 12} cy={n.y - 4} r={4} fill={statusColor(vm.up, vm.status)} />
      <text x={n.x + 22} y={n.y - 1} fill="#fff" fontSize="10" fontWeight="600">{trunc(vm.name, 18)}</text>
      <text x={n.x + 8} y={n.y + 11} fill="#8b95a3" fontSize="8" fontFamily="monospace">{vm.publicIp ? `↗${vm.publicIp} ` : ''}⌂{vm.privateIp ?? '-'}</text>
    </g>
  );
}

// ── Detail panel ──
function DetailPanel({ sel }: { sel: Sel }) {
  if (!sel) return <Card title="Details"><div className="py-6 text-center text-2xs text-muted">Select a node on the map.</div></Card>;
  if (sel.kind === 'vm') return <VmDetail v={sel.data} />;
  if (sel.kind === 'provider') {
    const p = sel.data;
    return (
      <Card title={PROVIDER_LABELS[p.provider]}>
        <div className="space-y-1.5 text-2xs">
          <Row k="Connection"><span style={{ color: connColor(p.status) }}>● {p.status}</span></Row>
          <Row k="VMs">{p.upCount}/{p.vmCount} up</Row>
          <Row k="VPN gateway">{p.hasVpn ? p.vpnGateways.map((g) => g.name).join(', ') : 'none detected'}</Row>
          <Row k="Networks">{p.networks.length}</Row>
        </div>
      </Card>
    );
  }
  const net = sel.data;
  return (
    <Card title={net.name}>
      <div className="space-y-2 text-2xs">
        <Row k="VNet / VPC"><span className="text-white">{net.vnet ?? '—'}</span></Row>
        <Row k="Region">{net.region || '—'}</Row>
        <Row k="Security groups">{net.nsgs.length ? net.nsgs.join(', ') : '—'}</Row>
        <div>
          <div className="mb-1 font-medium uppercase tracking-wide text-muted">Allowed / open ports</div>
          {net.openPorts.length ? (
            <div className="space-y-1">
              {net.openPorts.map((p, i) => (
                <div key={i} className="flex items-center justify-between rounded border border-border bg-bg px-2 py-1">
                  <span className="font-mono text-white">{p.protocol}/{p.ports}</span>
                  <span className="text-muted">from {p.source}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted">No open-port data. Run <b className="text-white">Network → Scan firewall rules</b> to populate.</div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── VPN / site-to-site ──
/** Read-only: show site-to-site links ONLY where real VPN connectivity is detected. */
function VpnPanel({ data }: { data: TopologyData }) {
  const label = (p: string) => PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS] ?? p;
  const connected = (data.vpnPairs ?? []).filter((p) => p.status === 'detected');
  if (connected.length === 0) return null; // nothing to show unless connectivity exists

  return (
    <Card title="Site-to-Site Connectivity">
      <div className="space-y-2">
        {connected.map((p, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2">
            <span className="text-2xs text-white">{label(p.a)} ↔ {label(p.b)}</span>
            <span className="rounded bg-success/15 px-2 py-0.5 text-2xs text-success">● connected</span>
          </div>
        ))}
        <div className="text-2xs text-muted">Detected from VPN gateways present on both clouds.</div>
      </div>
    </Card>
  );
}

type ProvKind = 'network' | 'vm' | 'disk';
const PROV_TABS: { kind: ProvKind; label: string }[] = [
  { kind: 'network', label: 'Network' },
  { kind: 'vm', label: 'Virtual Machine' },
  { kind: 'disk', label: 'Disk' },
];

export type ProvisionInitial = { provider: string; kind: ProvKind; values: Record<string, string> };

export function ProvisionModal({ providers, onClose, initial }: { providers: string[]; onClose: () => void; initial?: ProvisionInitial }) {
  const prov = useProvisionRequest();
  const [kind, setKind] = useState<ProvKind>(initial?.kind ?? 'network');
  const [provider, setProvider] = useState(initial?.provider ?? providers[0] ?? 'azure');
  const [vals, setVals] = useState<Record<string, string>>(initial?.values ?? {});
  const [newVals, setNewVals] = useState<Record<string, string>>({}); // typed values for "+ create new"
  const [accepted, setAccepted] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Region drives AWS subnet/AMI lists — refetch the schema when it changes.
  const schema = useProvisionSchema(provider, kind, vals.region ?? '');
  const mounted = useRef(false);

  const provLabel = PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider;
  const fields = schema.data?.fields ?? [];

  // Clean slate when the cloud or resource kind changes — but keep any pre-filled (edit) values on first mount.
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setVals({}); setNewVals({}); setAccepted(false); setMsg(null);
  }, [provider, kind]);

  // Seed/merge defaults whenever a schema (incl. a region-variant) loads — preserve entered values.
  useEffect(() => {
    if (!schema.data) return;
    setVals((prev) => {
      const seed: Record<string, string> = { ...prev };
      for (const f of schema.data!.fields) {
        if (f.type === 'note') continue;
        if (seed[f.key] === undefined || seed[f.key] === '') {
          seed[f.key] = f.default ?? (f.type === 'select' ? f.options?.[0]?.value ?? '' : '');
        } else if (f.type === 'select' && f.options && seed[f.key] !== NEW && !f.options.some((o) => o.value === seed[f.key])) {
          // value no longer valid for this region's options → reset to the first
          seed[f.key] = f.options[0]?.value ?? (f.allowNew ? NEW : '');
        }
      }
      return seed;
    });
  }, [schema.data]);

  const resolved = (f: ProvField): string => (vals[f.key] === NEW ? (newVals[f.key] ?? '') : vals[f.key] ?? '');

  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    setMsg(null);
    const body: Record<string, unknown> = { kind, provider };
    for (const f of fields) {
      if (f.type === 'note') continue;
      const v = resolved(f).trim();
      if (f.required && !v) return setMsg({ ok: false, text: `${f.label} is required` });
      // Enforce the cloud naming/format rule here so an invalid value can't be submitted.
      if (v && f.pattern && !new RegExp(f.pattern).test(v)) {
        return setMsg({ ok: false, text: `${f.label}: ${f.patternHint ?? 'invalid format'}` });
      }
      if (v) body[f.key] = f.type === 'number' ? Number(v) : v;
    }
    setSubmitted(true); // lock the form so the same request can't be sent twice
    try {
      await prov.mutateAsync(body);
      setMsg({ ok: true, text: `Requested on ${provLabel} — pending admin approval. Closing…` });
      setTimeout(onClose, 1100); // close the window so no duplicate same-name request is sent
    } catch (e) {
      setSubmitted(false);
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <Modal title={initial ? 'Edit & Resubmit' : 'Provision Resource'} subtitle={initial ? 'Pre-filled from the failed request — fix the flagged field (re-enter any password) and resubmit.' : 'Cloud-aware form — deployed on admin approval (governed)'} onClose={onClose}>
      <div className="space-y-3">
        {msg && <div className={`rounded-lg border px-3 py-2 text-2xs ${msg.ok ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'}`}>{msg.text}</div>}

        <div className="flex gap-1 rounded-lg border border-border bg-card p-0.5">
          {PROV_TABS.map((t) => (
            <button key={t.kind} onClick={() => { setKind(t.kind); setAccepted(false); }} className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${kind === t.kind ? 'bg-brand text-white' : 'text-muted hover:text-white'}`}>{t.label}</button>
          ))}
        </div>

        <Field label="Cloud">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className={inp}>
            {providers.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS] ?? p}</option>)}
          </select>
        </Field>

        {schema.isLoading && <div className="py-4 text-center text-2xs text-muted">Loading {provLabel} options…</div>}
        {schema.data && (
          <>
            {schema.data.executable
              ? <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-1.5 text-2xs text-success">● Live deploy enabled for {provLabel} {kind} — approving creates it for real.</div>
              : <div className="rounded-lg border border-border bg-card/60 px-3 py-1.5 text-2xs text-muted">Governed request — approving authorizes it; live execution for {provLabel} {kind} is not enabled (see Help → Remote Provisioning).</div>}

            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {fields.map((f) => (
                <SchemaField
                  key={f.key}
                  field={f}
                  value={vals[f.key] ?? ''}
                  newValue={newVals[f.key] ?? ''}
                  onChange={(v) => setVals((p) => ({ ...p, [f.key]: v }))}
                  onNewChange={(v) => setNewVals((p) => ({ ...p, [f.key]: v }))}
                />
              ))}
            </div>
          </>
        )}

        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-2xs text-warning">
          ⚠ This creates a <b>real, billed</b> resource on {provLabel} once an admin approves the request.
        </div>
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-bg px-3 py-2.5 text-2xs text-muted-light">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 accent-brand" />
          <span>I understand this provisions a real cloud resource and accept the resulting charges.</span>
        </label>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={submit} disabled={prov.isPending || submitted || !accepted || !schema.data} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-40">{submitted ? 'Requested ✓' : prov.isPending ? 'Requesting…' : 'Request provisioning'}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Renders one schema field: select (with "+ create new"), text/number/password, or a note. */
function SchemaField({ field, value, newValue, onChange, onNewChange }: { field: ProvField; value: string; newValue: string; onChange: (v: string) => void; onNewChange: (v: string) => void }) {
  if (field.type === 'note') {
    return <div className="col-span-2 rounded-lg border border-border bg-card/50 px-3 py-1.5 text-2xs text-muted">ⓘ {field.label}</div>;
  }
  const full = field.type === 'select' || field.key === 'name' || field.key === 'cidr' || field.key === 'subnetCidr' || field.key === 'adminPassword' || field.key === 'ami';
  const label = field.label + (field.required ? ' *' : '');

  if (field.type === 'select') {
    const creating = value === NEW;
    return (
      <label className={full ? 'col-span-2 block' : 'block'}>
        <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} className={inp}>
          {!field.options?.length && !field.allowNew && <option value="">—</option>}
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {field.allowNew && <option value={NEW}>{field.newLabel ?? '+ Create new…'}</option>}
        </select>
        {creating && (
          <input value={newValue} onChange={(e) => onNewChange(e.target.value)} placeholder={`New ${field.label.toLowerCase()} name`} className={`${inp} mt-1.5`} />
        )}
        {field.help && <span className="mt-1 block text-2xs text-muted">{field.help}</span>}
      </label>
    );
  }

  return (
    <label className={full ? 'col-span-2 block' : 'block'}>
      <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <input
        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={inp}
      />
      {field.help && <span className="mt-1 block text-2xs text-muted">{field.help}</span>}
    </label>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-2"><span className="text-muted">{k}</span><span className="text-right text-muted-light">{children}</span></div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>{children}</label>;
}
const inp = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none';

// ── layout helpers ──
interface LayoutNode { id: string; type: 'app' | 'provider' | 'net' | 'vm'; x: number; w: number; y: number; data: any }
function buildLayout(d: TopologyData) {
  const nodes: LayoutNode[] = [];
  const links: { from: string; to: string }[] = [];
  let leaf = 0;
  const provYs: number[] = [];
  for (const p of d.providers) {
    // Only show networks that actually contain VMs — hide empty VPC/VNet branches.
    const pNets = p.networks.filter((net) => net.vms.length > 0);
    if (pNets.length === 0) continue; // provider with nothing connected → don't render it at all
    const netYs: number[] = [];
    for (const net of pNets) {
      const vmYs: number[] = [];
      for (const vm of net.vms) {
        const y = leaf * ROW_H + 34;
        leaf++;
        nodes.push({ id: vm.id, type: 'vm', x: COL.vm, w: W.vm, y, data: vm });
        links.push({ from: net.id, to: vm.id });
        vmYs.push(y);
      }
      const ny = avg(vmYs);
      nodes.push({ id: net.id, type: 'net', x: COL.net, w: W.net, y: ny, data: net });
      links.push({ from: p.provider, to: net.id });
      netYs.push(ny);
    }
    const py = avg(netYs);
    nodes.push({ id: p.provider, type: 'provider', x: COL.provider, w: W.provider, y: py, data: p });
    links.push({ from: 'app', to: p.provider });
    provYs.push(py);
  }
  const appY = avg(provYs) || 60;
  nodes.push({ id: 'app', type: 'app', x: COL.app, w: W.app, y: appY, data: d.app });
  const map: Record<string, LayoutNode> = {};
  for (const n of nodes) map[n.id] = n;
  return { nodes, links, map, height: Math.max(160, leaf * ROW_H + 50) };
}
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 60);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function toSel(n: LayoutNode): Sel {
  if (n.type === 'vm') return { kind: 'vm', data: n.data };
  if (n.type === 'net') return { kind: 'net', data: n.data };
  if (n.type === 'provider') return { kind: 'provider', data: n.data };
  return null;
}
function isSel(sel: Sel, n: LayoutNode) {
  if (!sel) return false;
  return (sel.kind === n.type) && sel.data?.id === n.data?.id;
}
