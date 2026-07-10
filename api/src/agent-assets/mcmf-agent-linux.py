#!/usr/bin/env python3
# =====================================================================================
#  MCMF Linux Endpoint Agent — PURE OUTBOUND. The agent dials home to MCMF over HTTPS
#  and NEVER listens on a port — no inbound firewall rule needed. One outbound connection
#  carries telemetry (push) AND commands (long-poll): run / power / config / self-update.
#
#  Tokens replaced by MCMF when served:  __MCMF_URL__  __MCMF_KEY__  __MCMF_INTERVAL__
# =====================================================================================
import json, os, ssl, socket, subprocess, time, threading, struct, base64, urllib.request, urllib.parse

MCMF_URL = "__MCMF_URL__".rstrip("/")        # e.g. https://mcmf.example.com:8443 (any port)
KEY      = "__MCMF_KEY__"
INTERVAL = max(15, int("__MCMF_INTERVAL__" or "60"))
VERSION  = "__AGENT_VERSION__"                # baked at download; reported on ingest; auto-updates if the server is newer
SELF     = os.path.abspath(__file__)

# MCMF ships a self-signed cert by default; accept it (the agent key authenticates us).
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

AGENT_ID = None
UPDATING = False


def self_update():
    # Re-download the latest agent (baked with the new version) and restart the service on it. Used by
    # auto-update (push), the 'update' command (remote push) — guarded so it only fires once.
    global UPDATING
    if UPDATING:
        return
    UPDATING = True
    subprocess.Popen(["bash", "-c", "curl -fsSk '%s/api/agent/linux?k=%s' -o '%s' && (sudo systemctl restart mcmf-agent || systemctl restart mcmf-agent)" % (MCMF_URL, urllib.parse.quote(KEY), SELF)])


def http(method, path, body=None, timeout=35):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MCMF_URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("x-agent-key", KEY)
    with urllib.request.urlopen(req, context=CTX, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _cpu_pct():
    def snap():
        with open("/proc/stat") as f:
            p = [int(x) for x in f.readline().split()[1:]]
        return p[3] + p[4], sum(p)            # idle, total
    i1, t1 = snap(); time.sleep(0.3); i2, t2 = snap()
    dt = t2 - t1
    return round((1 - (i2 - i1) / dt) * 100, 1) if dt > 0 else 0.0


def _sh(cmd, timeout=8):
    try:
        return subprocess.check_output(["bash", "-c", cmd], text=True, stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception:
        return ""


def machine_id():
    for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(p) as f:
                v = f.read().strip()
                if v:
                    return v
        except Exception:
            pass
    return socket.gethostname()


def telemetry():
    o = {"hostname": socket.gethostname(), "os": "linux", "agent": "linux", "machineId": machine_id(), "version": VERSION}
    o["ips"] = [ip for ip in _sh("hostname -I").split() if not ip.startswith("127")]
    o["cpuPct"] = _cpu_pct()
    try:
        mem = {}
        for line in open("/proc/meminfo"):
            parts = line.split()
            mem[parts[0].rstrip(":")] = int(parts[1])
        avail = mem.get("MemAvailable", mem.get("MemFree", 0))
        o["memPct"] = round((1 - avail / mem["MemTotal"]) * 100, 1)
    except Exception:
        pass
    try:
        st = os.statvfs("/")
        o["diskPct"] = round((1 - st.f_bavail / st.f_blocks) * 100, 1)
    except Exception:
        pass
    o["loggedInUser"] = (_sh("who | awk '{print $1}' | head -1").strip() or _sh("logname").strip() or "system")
    svc = []
    for line in _sh("ps -eo comm,pcpu,pmem --sort=-pcpu --no-headers | head -20").splitlines():
        c = line.split()
        if len(c) >= 3:
            try:
                svc.append({"name": c[0][:40], "status": "running", "cpu": float(c[1]), "mem": float(c[2])})
            except ValueError:
                pass
    o["services"] = svc
    ev = _sh("journalctl -p err -n 10 --no-pager -o cat 2>/dev/null || tail -n 10 /var/log/syslog 2>/dev/null")
    o["events"] = [{"level": "warning", "category": "system", "message": l[:300]} for l in ev.splitlines() if l.strip()][:10]
    fw = _sh("(ufw status 2>/dev/null | grep -qi 'Status: active' && echo on) || (firewall-cmd --state 2>/dev/null | grep -qi running && echo on)")
    o["posture"] = {"firewallOn": fw.strip() == "on", "diskEncrypted": None, "pendingReboot": os.path.exists("/var/run/reboot-required"), "domainJoined": False}
    return o


def push():
    global AGENT_ID
    try:
        r = http("POST", "/api/agent/ingest", telemetry())
        AGENT_ID = r.get("agentId") or AGENT_ID
        # Auto-update: the server returns its current agent build; if we're older, self-update once.
        sv = r.get("agentVersion")
        if sv and sv != VERSION:
            self_update()
    except Exception:
        pass


# ── Console tunnel: a minimal WebSocket client (client frames are masked) that bridges the server
#    relay to a local RDP/SSH port, so console works with NO inbound port on this host. ────────────
def _ws_handshake(sock, host, path):
    key = base64.b64encode(os.urandom(16)).decode()
    req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, key))
    sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = sock.recv(1)
        if not d:
            raise IOError("ws closed during handshake")
        buf += d
    if b" 101 " not in buf.split(b"\r\n", 1)[0]:
        raise IOError("ws handshake rejected: " + buf.split(b"\r\n", 1)[0].decode("latin1"))


def _ws_send(sock, data):
    n = len(data)
    hdr = bytearray([0x82])               # FIN + binary
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
    mask = os.urandom(4)
    hdr += mask
    sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def _ws_recv(sock):
    def rd(n):
        b = b""
        while len(b) < n:
            d = sock.recv(n - len(b))
            if not d:
                return None
            b += d
        return b
    h = rd(2)
    if not h:
        return None, None
    opcode = h[0] & 0x0f
    masked = h[1] & 0x80
    ln = h[1] & 0x7f
    if ln == 126:
        ln = struct.unpack(">H", rd(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", rd(8))[0]
    mk = rd(4) if masked else None
    payload = rd(ln) if ln else b""
    if payload is None:
        return None, None
    if mk:
        payload = bytes(b ^ mk[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def console_open(session_id, target_port):
    try:
        u = urllib.parse.urlparse(MCMF_URL)
        host, port = u.hostname, (u.port or 443)
        raw = socket.create_connection((host, port), timeout=15)
        ws = CTX.wrap_socket(raw, server_hostname=host)
        _ws_handshake(ws, host, "/api/agent/tunnel?session=%s&k=%s" % (urllib.parse.quote(session_id), urllib.parse.quote(KEY)))
        local = socket.create_connection(("127.0.0.1", int(target_port)), timeout=10)
        stop = threading.Event()

        def shut():
            stop.set()
            for s in (ws, local):
                try:
                    s.close()
                except Exception:
                    pass

        def ws_to_local():
            try:
                while not stop.is_set():
                    op, data = _ws_recv(ws)
                    if op is None or op == 0x8:
                        break
                    if data and op in (0x0, 0x1, 0x2):
                        local.sendall(data)
            except Exception:
                pass
            finally:
                shut()

        def local_to_ws():
            try:
                while not stop.is_set():
                    d = local.recv(65536)
                    if not d:
                        break
                    _ws_send(ws, d)
            except Exception:
                pass
            finally:
                shut()

        threading.Thread(target=ws_to_local, daemon=True).start()
        threading.Thread(target=local_to_ws, daemon=True).start()
        return "console tunnel open → 127.0.0.1:%s" % target_port
    except Exception as e:
        return "console tunnel failed: %s" % (str(e)[:300])


def run_command(c):
    global INTERVAL
    kind, p, cid = c.get("kind"), (c.get("payload") or {}), c.get("id")
    status, result, code = "done", "", None
    try:
        if kind == "run":
            r = subprocess.run(["bash", "-c", p.get("command", "")], capture_output=True, text=True, timeout=180)
            result = (r.stdout + r.stderr)[-7000:]; code = r.returncode
        elif kind == "power":
            act = p.get("action")
            cmd = "shutdown -r now" if act == "restart" else "shutdown -h now"
            subprocess.Popen(["bash", "-c", "sleep 2; (sudo %s || %s)" % (cmd, cmd)])
            result = act + " scheduled"
        elif kind == "config":
            if "intervalSec" in p:
                INTERVAL = max(15, int(p["intervalSec"])); result = "interval=%d" % INTERVAL
        elif kind == "update":
            self_update()
            result = "self-update triggered"
        elif kind == "console-open":
            result = console_open(p.get("sessionId"), p.get("targetPort", 3389))
        elif kind == "uninstall":
            # Disable (no boot start) + remove unit & files WITHOUT --now (so this cleanup isn't
            # cgroup-killed), then exit ourselves; the unit is gone so systemd won't restart us.
            subprocess.Popen(["bash", "-c", "systemctl disable mcmf-agent 2>/dev/null; rm -rf /opt/mcmf-agent /etc/systemd/system/mcmf-agent.service; systemctl daemon-reload 2>/dev/null"])
            result = "uninstalled — service disabled, files removed; agent exiting"
            threading.Timer(5, lambda: os._exit(0)).start()
        else:
            status, result = "failed", "unknown command kind: %s" % kind
    except Exception as e:
        status, result = "failed", str(e)[:500]
    try:
        http("POST", "/api/agent/command-result", {"commandId": cid, "status": status, "result": result, "exitCode": code})
    except Exception:
        pass


def command_loop():
    while True:
        if not AGENT_ID:
            time.sleep(2); continue
        try:
            q = urllib.parse.urlencode({"agentId": AGENT_ID, "k": KEY})
            r = http("GET", "/api/agent/commands?" + q, None, timeout=35)
            if not r.get("active", True):
                os._exit(0)              # admin decommissioned this agent → stop
            for c in r.get("commands", []):
                run_command(c)
        except Exception:
            time.sleep(5)


def main():
    push()                                   # first report → learn our agentId
    threading.Thread(target=command_loop, daemon=True).start()
    while True:
        push()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
