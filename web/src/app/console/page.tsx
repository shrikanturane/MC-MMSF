'use client';

import { useEffect, useRef, useState } from 'react';
import { TOKEN_KEY } from '@/lib/api';

type Phase = 'form' | 'connecting' | 'connected' | 'error';

export default function ConsolePage() {
  const [host, setHost] = useState('');
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState('rdp');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'password' | 'key' | 'cloud'>('password'); // password · SSH key · cloud-brokered
  const [provider, setProvider] = useState(''); // aws | azure | gcp — drives cloud-credential SSH
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [savePw, setSavePw] = useState(true);
  const [saved, setSaved] = useState(false);
  const [security, setSecurity] = useState('any');
  const [domain, setDomain] = useState('');
  const [rawShell, setRawShell] = useState(false); // SSH: load the host's full shell (~/.bashrc) instead of the clean shell
  const [phase, setPhase] = useState<Phase>('form');
  const [err, setErr] = useState<string | null>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<any>(null);
  const guacRef = useRef<any>(null);
  const reachedConnected = useRef(false);
  const fsRef = useRef<any>(null);
  const [clipMsg, setClipMsg] = useState<string | null>(null);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [vmFiles, setVmFiles] = useState<{ path: string; name: string; type: string }[]>([]);

  // ── Clipboard: VM → local (auto) and local → VM (button) ─────────────────
  const pasteToVm = async () => {
    const client = clientRef.current; const G = guacRef.current;
    if (!client || !G) return;
    try {
      const text = await navigator.clipboard.readText();
      const stream = client.createClipboardStream('text/plain');
      const writer = new G.StringWriter(stream);
      writer.sendText(text); writer.sendEnd();
      setClipMsg('Clipboard sent — press Ctrl+V in the VM');
    } catch {
      setClipMsg('Allow clipboard access in the browser, then retry');
    }
    setTimeout(() => setClipMsg(null), 3500);
  };

  // ── File sharing over the redirected RDP drive ───────────────────────────
  const uploadFiles = (files: FileList | null) => {
    const obj = fsRef.current; const G = guacRef.current;
    if (!files?.length) return;
    if (!obj || !G) { setFileMsg('Drive not ready — wait until fully connected'); return; }
    Array.from(files).forEach((file) => {
      const stream = obj.createOutputStream(file.type || 'application/octet-stream', '/' + file.name);
      const writer = new G.BlobWriter(stream);
      writer.oncomplete = () => { setFileMsg(`Uploaded "${file.name}" → VM (MCMF Share drive)`); refreshVmFiles(); };
      writer.onerror = () => setFileMsg(`Upload failed: ${file.name}`);
      writer.sendBlob(file);
    });
  };

  const refreshVmFiles = () => {
    const obj = fsRef.current; const G = guacRef.current;
    if (!obj || !G) return;
    obj.requestInputStream('/', (stream: any, mimetype: string) => {
      if (mimetype !== G.Object.STREAM_INDEX_MIMETYPE) { try { stream.sendAck('Unexpected', 0x0100); } catch { /* */ } return; }
      const reader = new G.JSONReader(stream);
      reader.onend = () => {
        const idx = reader.getJSON() || {};
        setVmFiles(Object.keys(idx).filter((k) => !k.endsWith('/.') && !k.endsWith('/..')).map((path) => ({ path, name: path.replace(/^\//, ''), type: idx[path] })));
      };
    });
  };

  const downloadVmFile = (path: string, name: string) => {
    const obj = fsRef.current; const G = guacRef.current;
    if (!obj || !G) return;
    obj.requestInputStream(path, (stream: any, mimetype: string) => {
      const reader = new G.BlobReader(stream, mimetype);
      reader.onend = () => {
        const url = URL.createObjectURL(reader.getBlob());
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      };
    });
  };

  const toggleFiles = () => { const n = !showFiles; setShowFiles(n); if (n) refreshVmFiles(); };

  const headers = () => {
    const jwt = window.localStorage.getItem(TOKEN_KEY);
    return { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) };
  };

  const portFor = (p: string) => (p === 'rdp' ? '3389' : p === 'ssh' ? '22' : p === 'telnet' ? '23' : p === 'vnc' ? '5900' : '');

  // Parse the query, then look up saved credentials — auto-connect if we have them.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const h = q.get('host') ?? '';
    const nm = q.get('name') ?? h ?? 'Remote console';
    const pr = (q.get('protocol') ?? 'rdp').toLowerCase();
    const prov = (q.get('provider') ?? '').toLowerCase();
    const os = (q.get('os') ?? '').toLowerCase();
    const pt = portFor(pr);
    setHost(h); setName(nm); setProtocol(pr); setPort(pt); setProvider(prov);
    document.title = `MCMF Console — ${nm}`;
    // Per-cloud defaults so AWS / Azure / GCP all "just work": the right login user + auth mode.
    const win = /win/.test(os);
    const defaultUser = win
      ? (prov === 'aws' ? 'Administrator' : 'azureuser')
      : (prov === 'aws' ? 'ec2-user' : prov === 'azure' ? 'azureuser' : '');
    const remembered = (typeof localStorage !== 'undefined' && localStorage.getItem(`mcmf:ssh-user:${h}`)) || '';
    setUsername(remembered || defaultUser);
    // Default auth: AWS Linux → cloud-brokered (no key paste); GCP Linux → key; Azure/Windows → password.
    if (pr === 'ssh' && !win) {
      if (prov === 'aws') setAuthMode('cloud');
      else if (prov === 'gcp') setAuthMode('key');
    }
    (async () => {
      try {
        const r = await fetch(`/api/console/cred?host=${encodeURIComponent(h)}&protocol=${pr}`, { headers: headers() });
        const j = await r.json().catch(() => ({}));
        if (j?.saved) {
          setSaved(true);
          setUsername(j.username ?? '');
          if (j.hasKey) setAuthMode('key');
          runConnect({ host: h, protocol: pr, port: pt, username: j.username ?? '', password: '', save: false, security: 'any' });
        }
      } catch { /* show the form */ }
    })();
  }, []);

  const errorFor = (status: any, h: string, p: string): string => {
    const code = status?.code;
    const msg = String(status?.message || '');
    // Key-only host (GCP/AWS): guacd reports the SSH server refused password auth.
    if (protocol === 'ssh' && /password.*not supported|publickey/i.test(msg)) {
      return 'This VM accepts only SSH KEY auth (typical for GCP/AWS) — password was refused. Switch Authentication to "Private key" and paste the key whose public half is on the VM.';
    }
    if (code === 0x0301 || code === 0x0303) return protocol === 'ssh'
      ? 'SSH authentication failed — wrong username/password or the VM is key-only. If it\'s a GCP/AWS VM, switch to "Private key" auth.'
      : 'Authentication failed — the username or password is wrong (or the account lacks remote-login rights).';
    if (code === 0x0202 || code === 0x0203 || code === 0x0204 || code === 0x0308) return `Could not reach ${h}:${p} from the MCMF server — open the port (NSG/firewall) to the server, and confirm the VM service is listening.`;
    if (code === 0x0200) return 'Gateway (guacd) error connecting to the host.';
    return status?.message || 'Connection error.';
  };

  const runConnect = async (o: { host: string; protocol: string; port: string; username: string; password: string; privateKey?: string; passphrase?: string; useCloudCreds?: boolean; save: boolean; security?: string; domain?: string; rawShell?: boolean }) => {
    setErr(null);
    setPhase('connecting');
    try {
      const chk = await fetch('/api/console/check', { method: 'POST', headers: headers(), body: JSON.stringify({ host: o.host, protocol: o.protocol, port: Number(o.port) || undefined }) });
      const cj = await chk.json().catch(() => ({}));
      if (!chk.ok) throw new Error(cj?.message || `check ${chk.status}`);
      if (!cj.reachable) { setErr(cj.detail); setPhase('error'); return; }

      const res = await fetch('/api/console/token', { method: 'POST', headers: headers(), body: JSON.stringify({ host: o.host, protocol: o.protocol, port: Number(o.port) || undefined, username: o.username || undefined, password: o.password || undefined, privateKey: o.privateKey || undefined, passphrase: o.passphrase || undefined, useCloudCreds: o.useCloudCreds || undefined, save: o.save, security: o.security, domain: o.domain || undefined, rawShell: o.rawShell || undefined }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || `token ${res.status}`);
      const { token } = await res.json();
      if (o.save && (o.password || o.privateKey)) setSaved(true);

      const mod: any = await import('guacamole-common-js');
      const Guacamole = mod.default ?? mod;
      guacRef.current = Guacamole;
      const tunnel = new Guacamole.WebSocketTunnel(`wss://${window.location.host}/guac`);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      // Clipboard VM → local (text): mirror the remote clipboard into the browser.
      client.onclipboard = (stream: any, mimetype: string) => {
        if (!/^text\//.test(mimetype)) { try { stream.sendAck('ok', 0); } catch { /* */ } return; }
        const reader = new Guacamole.StringReader(stream);
        let data = '';
        reader.ontext = (t: string) => { data += t; };
        reader.onend = () => { navigator.clipboard?.writeText(data).catch(() => {}); };
      };
      // Redirected drive (file sharing) becomes available once connected.
      client.onfilesystem = (object: any /* , name */) => { fsRef.current = object; };

      const display = client.getDisplay();
      const el = display.getElement();
      const container = displayRef.current!;
      container.innerHTML = '';
      container.appendChild(el);
      // Scale the remote display to fit the window (never upscale) — avoids a tiny/clipped canvas.
      const fit = () => { const w = display.getWidth(), h = display.getHeight(); if (w && h) display.scale(Math.min(container.clientWidth / w, container.clientHeight / h, 1)); };
      display.onresize = fit;
      window.addEventListener('resize', fit);
      const mouse = new Guacamole.Mouse(el);
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (s: any) => {
        // The remote display is CSS-scaled to fit the window; Guacamole.Mouse reports coordinates in
        // *displayed* pixels, so divide by the current scale to map back to the remote's real resolution.
        // Without this the remote cursor drifts away from the local pointer whenever scale < 1.
        const scale = display.getScale() || 1;
        if (scale !== 1) { s.x = Math.round(s.x / scale); s.y = Math.round(s.y / scale); }
        client.sendMouseState(s);
      };
      const keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (s: number) => client.sendKeyEvent(1, s);
      keyboard.onkeyup = (s: number) => client.sendKeyEvent(0, s);

      client.onerror = (st: any) => { setErr(errorFor(st, o.host, o.port)); setPhase('error'); };
      tunnel.onerror = (st: any) => { setErr(errorFor(st, o.host, o.port)); setPhase('error'); };
      // 3 = CONNECTED, 5 = DISCONNECTED. A disconnect before we ever connected = a silent failure
      // (often SSH key-only auth) — never leave the user stuck on "Connecting…".
      client.onstatechange = (state: number) => {
        if (state === 3) { reachedConnected.current = true; setPhase('connected'); }
        else if (state === 5 && !reachedConnected.current) {
          setErr((e) => e || (protocol === 'ssh'
            ? 'The session closed before it opened — usually the VM is SSH key-only (switch Authentication to "Private key") or the credentials were rejected.'
            : 'The session closed before it opened — check the credentials and that the VM service is reachable.'));
          setPhase('error');
        }
      };
      reachedConnected.current = false;
      client.connect('token=' + encodeURIComponent(token));
    } catch (e) {
      setErr((e as Error).message);
      setPhase('error');
    }
  };

  const forget = async () => {
    await fetch(`/api/console/cred?host=${encodeURIComponent(host)}&protocol=${protocol}`, { method: 'DELETE', headers: headers() }).catch(() => undefined);
    setSaved(false); setPassword('');
  };
  const disconnect = () => { try { clientRef.current?.disconnect(); } catch { /* */ } fsRef.current = null; setShowFiles(false); setVmFiles([]); setPhase('form'); };

  return (
    <div style={{ height: '100vh', background: '#0b0f14', color: '#e5e7eb', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid #1f2937', fontSize: 13 }}>
        <strong>🖥 {name}</strong>
        <span style={{ color: '#9ca3af' }}>{host}:{port} · {protocol.toUpperCase()}</span>
        {saved && <span style={{ color: '#22c55e', fontSize: 11 }}>🔒 saved</span>}
        <span style={{ marginLeft: 'auto', color: phase === 'connected' ? '#22c55e' : phase === 'error' ? '#ef4444' : '#9ca3af' }}>
          {phase === 'connected' ? '● connected' : phase === 'connecting' ? 'connecting…' : phase === 'error' ? '● disconnected' : ''}
        </span>
        {phase === 'connected' && protocol === 'rdp' && (
          <>
            <button onClick={pasteToVm} style={btn} title="Send your local clipboard text to the VM (then Ctrl+V there)">📋 Paste to VM</button>
            <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Upload file(s) from this PC to the VM's MCMF Share drive">
              📤 Upload<input type="file" multiple onChange={(e) => { uploadFiles(e.target.files); e.currentTarget.value = ''; }} style={{ display: 'none' }} />
            </label>
            <button onClick={toggleFiles} style={{ ...btn, ...(showFiles ? { borderColor: '#3b82f6', color: '#93c5fd' } : {}) }} title="Browse & download files the VM placed on the MCMF Share drive">📁 Files</button>
          </>
        )}
        {phase === 'connected' && <button onClick={disconnect} style={btn}>Disconnect</button>}
      </div>

      {phase === 'connected' && (clipMsg || fileMsg) && (
        <div style={{ padding: '4px 14px', borderBottom: '1px solid #1f2937', fontSize: 11, color: '#93c5fd', background: '#0f1620' }}>
          {clipMsg && <span>📋 {clipMsg}</span>} {fileMsg && <span style={{ marginLeft: clipMsg ? 16 : 0, color: '#86efac' }}>📁 {fileMsg}</span>}
        </div>
      )}

      {phase === 'form' || phase === 'error' ? (
        <div style={{ maxWidth: 440, margin: '40px auto', display: 'flex', flexDirection: 'column', gap: 12, background: '#0f141a', border: '1px solid #1f2937', borderRadius: 14, padding: 22, boxShadow: '0 8px 30px rgba(0,0,0,.35)' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Connect to {name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, fontFamily: 'monospace' }}>{host}{port ? `:${port}` : ''} · {protocol.toUpperCase()}</div>
          </div>
          {err && <div style={{ background: '#7f1d1d33', border: '1px solid #ef444455', color: '#fca5a5', padding: '8px 10px', borderRadius: 8, fontSize: 12 }}>{err}</div>}
          {saved && <div style={{ background: '#14532d33', border: '1px solid #22c55e55', color: '#86efac', padding: '6px 10px', borderRadius: 8, fontSize: 12 }}>🔒 Saved credentials for this VM will be used. <button onClick={forget} style={{ ...linkBtn }}>Forget</button></div>}
          <Field label="Protocol">
            <select value={protocol} onChange={(e) => { setProtocol(e.target.value); setPort(portFor(e.target.value)); }} style={inp}>
              <option value="rdp">RDP (Windows)</option>
              <option value="ssh">SSH (Linux)</option>
              <option value="telnet">Telnet</option>
              <option value="vnc">VNC</option>
            </select>
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Host"><input value={host} onChange={(e) => setHost(e.target.value)} style={inp} /></Field>
            <div style={{ width: 90 }}><Field label="Port"><input value={port} onChange={(e) => setPort(e.target.value)} style={inp} /></Field></div>
          </div>
          {protocol !== 'telnet' && <Field label="Username"><input value={username} onChange={(e) => setUsername(e.target.value)} style={inp} autoComplete="off" placeholder={protocol === 'ssh' ? 'e.g. ubuntu · ec2-user · azureuser · your GCP user' : ''} /></Field>}
          {protocol === 'ssh' && (
            <Field label="Authentication method">
              <div style={{ display: 'flex', gap: 4, background: '#0b0f14', border: '1px solid #232a33', borderRadius: 8, padding: 3 }}>
                {['aws', 'azure', 'gcp'].includes(provider) && (
                  <button type="button" onClick={() => setAuthMode('cloud')} style={{ ...btn, flex: 1, padding: '6px 8px', background: authMode === 'cloud' ? '#3b82f6' : 'transparent', borderColor: 'transparent', color: authMode === 'cloud' ? '#fff' : '#9ca3af' }}>☁ Cloud creds</button>
                )}
                <button type="button" onClick={() => setAuthMode('password')} style={{ ...btn, flex: 1, padding: '6px 8px', background: authMode === 'password' ? '#3b82f6' : 'transparent', borderColor: 'transparent', color: authMode === 'password' ? '#fff' : '#9ca3af' }}>🔑 Password</button>
                <button type="button" onClick={() => setAuthMode('key')} style={{ ...btn, flex: 1, padding: '6px 8px', background: authMode === 'key' ? '#3b82f6' : 'transparent', borderColor: 'transparent', color: authMode === 'key' ? '#fff' : '#9ca3af' }}>🗝 Private key</button>
              </div>
            </Field>
          )}
          {protocol === 'ssh' && authMode === 'cloud' && (
            <div style={{ fontSize: 12, color: '#9ca3af', background: '#0b1220', border: '1px solid #1e3a5f', borderRadius: 8, padding: '8px 10px' }}>
              ☁ MCMF will broker a one-time SSH key using your stored <b style={{ color: '#fff' }}>{provider.toUpperCase()}</b> credentials — no key to paste. Enter the <b style={{ color: '#fff' }}>VM login user</b> above ({provider === 'aws' ? 'usually ec2-user or ubuntu' : 'OS user'}) and click Connect.
              {provider === 'aws' ? <div style={{ marginTop: 4, color: '#6b7280' }}>Uses EC2 Instance Connect (needs the agent on the instance — Amazon Linux 2+/Ubuntu 20.04+).</div>
                : provider === 'gcp' ? <div style={{ marginTop: 4, color: '#6b7280' }}>Pushes a one-time key to the VM&apos;s metadata via your service account (~10s). Note: VMs using <b style={{ color: '#f59e0b' }}>OS Login</b> ignore metadata keys — there, use Private key instead.</div>
                : <div style={{ marginTop: 4, color: '#6b7280' }}>Pushes a key via the VMAccess extension using your service principal — this takes <b style={{ color: '#f59e0b' }}>~30–60s</b> to apply, so give it a moment. Linux VMs only.</div>}
            </div>
          )}
          {protocol !== 'telnet' && !(protocol === 'ssh' && (authMode === 'key' || authMode === 'cloud')) && <Field label={saved ? 'Password (blank = use saved)' : 'Password'}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inp} autoComplete="off" /></Field>}
          {protocol === 'ssh' && authMode === 'key' && (
            <>
              <Field label={saved ? 'Private key — PEM (blank = use saved)' : 'Private key — PEM'}>
                <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={5} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…paste the key whose PUBLIC key is on the VM…\n-----END OPENSSH PRIVATE KEY-----'} style={{ ...inp, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }} autoComplete="off" />
              </Field>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: -4 }}>Get it: <code style={{ color: '#9ca3af' }}>cat ~/.ssh/google_compute_engine</code> (GCP via gcloud) · or generate one: <code style={{ color: '#9ca3af' }}>ssh-keygen -t ed25519 -f ~/.ssh/mcmf</code> then add <code style={{ color: '#9ca3af' }}>~/.ssh/mcmf.pub</code> to the VM. Full steps: Help → §16.</div>
              <Field label="Key passphrase (optional)"><input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={inp} autoComplete="off" /></Field>
            </>
          )}
          {protocol === 'rdp' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Field label="Security (try NLA/RDP if black screen)">
                <select value={security} onChange={(e) => setSecurity(e.target.value)} style={inp}>
                  <option value="any">Auto-negotiate</option>
                  <option value="nla">NLA</option>
                  <option value="tls">TLS</option>
                  <option value="rdp">RDP (legacy)</option>
                  <option value="vmconnect">Hyper-V (vmconnect)</option>
                </select>
              </Field>
              <Field label="Domain (optional)"><input value={domain} onChange={(e) => setDomain(e.target.value)} style={inp} autoComplete="off" /></Field>
            </div>
          )}
          {protocol !== 'telnet' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#9ca3af' }}>
              <input type="checkbox" checked={savePw} onChange={(e) => setSavePw(e.target.checked)} /> Save credentials for this VM (encrypted)
            </label>
          )}
          {protocol === 'ssh' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#9ca3af' }} title="By default the SSH console runs a clean shell (skips ~/.bashrc) so host shell integrations (Amazon Q/Fig, Powerlevel10k…) don't garble the terminal. Tick this to load the host's full customised shell instead.">
              <input type="checkbox" checked={rawShell} onChange={(e) => setRawShell(e.target.checked)} /> Full shell — load the host&apos;s ~/.bashrc (may show shell-integration output)
            </label>
          )}
          <button onClick={() => runConnect({ host, protocol, port, username, password, privateKey: authMode === 'key' ? privateKey : '', passphrase: authMode === 'key' ? passphrase : '', useCloudCreds: authMode === 'cloud', save: savePw, security, domain, rawShell })} style={{ ...btn, background: '#3b82f6', borderColor: '#3b82f6', color: '#fff', padding: '8px 12px' }}>Connect</button>
          <div style={{ fontSize: 11, color: '#6b7280' }}>The MCMF server must reach {host}:{port}. Credentials are sealed (AES-256-GCM) and never returned to the browser. <b>GCP/AWS VMs are key-only</b> — pick <b>Private key</b> and paste the key whose public half is on the VM. Black screen on RDP? switch Security to <b>NLA</b>/<b>RDP</b>.</div>
        </div>
      ) : (
        <div ref={displayRef} style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', background: '#000' }} />
      )}
      {phase === 'connected' && showFiles && (
        <div style={{ position: 'fixed', top: 70, right: 0, bottom: 0, width: 300, background: '#0f1620', borderLeft: '1px solid #1f2937', padding: 12, overflow: 'auto', zIndex: 20, fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>📁 VM files — MCMF Share</strong>
            <span>
              <button onClick={refreshVmFiles} style={linkBtn}>refresh</button>
              <button onClick={() => setShowFiles(false)} style={{ ...linkBtn, marginLeft: 8 }}>close</button>
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10, lineHeight: 1.5 }}>
            On the VM, open <b>This PC → MCMF Share</b>. Copy a file there, then <b>refresh</b> here to download it. Use <b>📤 Upload</b> to push files from this PC onto that drive for the VM.
          </div>
          {vmFiles.length === 0 ? (
            <div style={{ color: '#6b7280' }}>No files on the share yet.</div>
          ) : (
            vmFiles.map((f) => {
              const dir = String(f.type).includes('stream-index');
              return (
                <div key={f.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid #1f2937' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{dir ? '📁' : '📄'} {f.name}</span>
                  {!dir && <button onClick={() => downloadVmFile(f.path, f.name)} style={linkBtn}>download</button>}
                </div>
              );
            })
          )}
        </div>
      )}

      {phase === 'connecting' && <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', color: '#9ca3af' }}>Connecting…</div>}
    </div>
  );
}

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#0f1620', border: '1px solid #1f2937', color: '#e5e7eb', borderRadius: 6, padding: '6px 8px', fontSize: 13 };
const btn: React.CSSProperties = { background: '#111827', border: '1px solid #374151', color: '#e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', padding: 0 };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', flex: 1 }}>
      <span style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}
