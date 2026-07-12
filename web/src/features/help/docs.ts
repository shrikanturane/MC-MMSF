import type { Provider } from '@/lib/format';

// ─────────────────────── MCMF Platform Guide (user documentation) ───────────────────────
// A readable, downloadable reference covering the whole platform. Each section is plain
// text (markdown-ish) so it renders in Help AND exports cleanly to a .md document.
export interface GuideSection {
  id: string;
  icon: string;
  title: string;
  body: string;
}

export const USER_GUIDE: GuideSection[] = [
  {
    id: 'overview',
    icon: '🧭',
    title: '1. Overview',
    body: `MCMF (Multi-Cloud Management Framework) is a single console to inventory, monitor, secure, govern and provision infrastructure across AWS, Azure, GCP, Docker, VMware/Nutanix and on-prem hosts.

It is self-hosted and private: MCMF reaches OUT to your clouds and hosts (agentless SSH pull + cloud APIs) rather than exposing inbound access. Sign in, connect your clouds, and each capability works as you enable it.

Core ideas:
• Connect once (Settings → Cloud Connections); the same identity drives manage, monitor, secure and cost.
• Everything is live — no seeded demo data; dashboards reflect real resources.
• Sensitive actions are governed by approvals and a full audit trail.`,
  },
  {
    id: 'navigation',
    icon: '🗂',
    title: '2. Modules & navigation',
    body: `The sidebar (customizable per role in Settings → Workspace) gives you:
• Network Topology — live map of clouds, VPCs/VNets, subnets and hosts.
• Management — fleet overview KPIs and quick actions.
• My Dashboard — drag/resize widgets; build your own view.
• Monitoring — tabbed: Overview (KPIs/CPU/alerts), Telemetry & Hosts (per-VM + IP/Host monitors), Health & Logs (service map + System Event Log).
• Security — tabbed: Zero-Trust Posture, Active Alerts, Automation & Escalation, Cloud Findings.
• Governance — policies & environment guardrails.
• Network — firewall/NSG risk, remediation.
• Cloud Inventory — every discovered resource, with detail + power control.
• Command Center — live SIEM/AIOps + the AI Assistant & RCA.
• Activity / Approvals — audit feed and the approval queue.
• Reports — build, run, download CSV, or schedule by email.
• Help — this guide + integration recipes.
• Settings — profile, workspace, connections, users, integrations.`,
  },
  {
    id: 'connections',
    icon: '☁️',
    title: '3. Cloud connections',
    body: `Settings → Cloud Connections → add AWS / Azure / GCP (and Docker, Linux/Windows SSH).
• AWS: IAM user (access key) or role; attach the read policies per pillar.
• Azure: Entra ID app registration (service principal) assigned Reader-type roles at the subscription.
• GCP: Service Account JSON key with viewer/monitoring roles; enable the listed APIs.
Help → "Cloud Permissions Reference" has the exact policies. Use the zero-touch Grant Scripts (Help → Grant Cloud Permissions) to apply them in one paste.`,
  },
  {
    id: 'provisioning',
    icon: '🛠',
    title: '4. Provisioning & approvals',
    body: `Provision real VMs, networks, disks and site-to-site VPN from MCMF with auto-populated, schema-driven forms (region, size, image, etc.).

Governance: sensitive actions (VM stop/reboot, connection delete, firewall remediation, provisioning) route through an approval gate. A request is queued and every active admin is notified over BOTH email and WhatsApp. Admins approve/reject in Approvals; approved actions execute and are audited. Failed steps are phase-tagged with remediation and can be retried without re-approval.`,
  },
  {
    id: 'monitoring',
    icon: '📡',
    title: '5. Monitoring — devices, reachability, agents',
    body: `Monitoring → Telemetry & Hosts → IP/Host Monitor.

WHAT YOU CAN MONITOR — anything with an IP:
• Servers / VMs (Linux, Windows)
• Network devices — routers, switches, firewalls, load balancers, BMCs/iLO/iDRAC
• Any service endpoint (web app, DB port, etc.)

HOW (pick a check type per target):
• ICMP Ping — basic up/down
• TCP port — SSH 22, RDP 3389, HTTPS 443, SMTP 25, DNS 53, or any custom port
• HTTP(S) — web reachability
• SNMP — network gear (UDP v2c probe)
No username or password is needed to check REACHABILITY — credentials are only for pulling system metrics (below).

MULTIPLE IPs, ONE DEVICE: add Alternate IPs (e.g. a public + a private address) on a monitor. MCMF probes each and reports UP if ANY answers — better reachability, but still one device/row. The row shows "via <ip>" when it answered on an alternate.

SYSTEM METRICS (optional): to also see CPU / memory / disk for a Linux/Windows host, click "🔌 Add agent" on its monitor row (or Command Center → Guest Agents) and attach SSH credentials. MCMF connects OUT to the host's public IP over SSH and pulls — nothing is installed and the host needs no route back to MCMF. Run the one-time "enable SSH" script from Help → Agents & Infra first, and allow inbound TCP 22 from the MCMF server.

VIEWS: up/down, latency, uptime sparkline, and a chart per widget (line / area / bars / availability). Group monitors and pin a dashboard widget to one group (isolated) or "All groups" (centralized). System Event Log (Health & Logs) — click any entry for the full log detail.`,
  },
  {
    id: 'netdevices',
    icon: '🔀',
    title: '5.1 Network device monitoring (SNMP) — firewall / router / switch',
    body: `For network gear, MCMF reads rich telemetry over SNMP v2c (read-only). Monitoring → Network Devices (or add the "Network Devices" board widget). It is the device-focused companion to IP/Host Monitor.

SET UP A DEVICE
1. IP/Host Monitor → + Add. Enter name, IP and group.
2. Set Device type to Firewall / Router / Switch / Server.
3. Enter the SNMP community (e.g. "public") — this enables telemetry.
4. Save. Within ~30s the Network Devices tab fills in.
(Reachability/latency still work without SNMP; the community unlocks the rest.)

WHAT YOU GET
• Uptime — the device's own sysUpTime (e.g. "12d 4h"), plus reachability %.
• Latency & jitter — round-trip time from ICMP; jitter = mean variation of recent RTTs.
• Bandwidth utilization — per interface, in/out bits-per-second and util % (from ifTable/ifXTable octet counters, 64-bit when available). Speed auto-detected.
• Link up / down alerts — each interface's operational status is checked every poll; a port going down raises a real alert ("Link down: Switch1 — Gi0/3") + event, and coming back resolves it automatically.
• Top talkers — the busiest ports/links by throughput (where traffic flows). App-level top-talkers need NetFlow/sFlow; SNMP gives the per-port view.
• Device MAC — the device's own base MAC (from ifPhysAddress) for asset tracking.
• Connected devices on the LAN — the MAC ↔ IP ↔ port table, built from the device's ARP table (ipNetToMediaTable) and a switch's forwarding DB (dot1dTpFdbTable). The summary shows how many devices are connected.

SNMP STATUS & PUSH (POLL NOW)
• Each device shows an SNMP status badge: ok / stale / no-response / off.
• "↻ Poll SNMP now" pushes an immediate poll and reports the result (interface + connected-device counts, or the exact failure).

ENABLE SNMP ON THE DEVICE ("⤓ Enable SNMP")
Turn on SNMP v2c read-only, open UDP 161 from the MCMF server, and set the same community on the monitor. Examples:
• Linux (net-snmp): apt install snmpd → /etc/snmp/snmpd.conf: "rocommunity public 192.168.0.0/16" → restart snmpd.
• MikroTik RouterOS: /snmp set enabled=yes ; /snmp community set [find default=yes] name=public addresses=192.168.0.0/16
• pfSense / OPNsense: Services → SNMP → Enable; community = public; bind to LAN; allow the MCMF server IP.
• Cisco IOS: snmp-server community public RO ; snmp-server host <MCMF_IP> version 2c public ; write memory

SECURITY: SNMP v2c is read-only — MCMF only reads. Use a non-default community and restrict it to the MCMF server's IP. SNMP v3 (auth/priv) is not required for this read-only telemetry.`,
  },
  {
    id: 'security',
    icon: '🛡',
    title: '6. Security, Zero-Trust & alerting',
    body: `Zero-Trust Posture scores the six CISA pillars (Identity, Network, Workload, Data, Visibility, Automation) from real signals into a maturity band, with prioritized recommendations and one-click network remediation.

Alerting: define threshold rules; the engine evaluates live metrics every minute and raises/resolves alerts. Automation Workflows run actions on triggers (notify / webhook / stop-VM / restart-VM, or multi-step). Escalation Policies act on stale unresolved alerts. Cloud Findings pulls vulnerabilities/misconfig/threats from each cloud.`,
  },
  {
    id: 'zt-remediation',
    icon: '🧩',
    title: '6.1 Zero-Trust remediation playbook — how to fix each failing check',
    body: `Every Zero-Trust check is scored from a real signal. When a check shows ✕ (fail) or ▲ (at risk), open it from Security → Zero-Trust Posture (click the pillar) to see the gap, then follow the matching fix below. Each check clears automatically once the underlying finding/signal is resolved — re-run the relevant scan afterwards.

IDENTITY
• "MFA enforced for all users" — enable MFA per user: Settings → Users → edit the user → tick "Require multi-factor authentication". The user enrols an authenticator app on next sign-in (an emailed one-time code also works after enrolment).
• "Least-privilege admins" — reduce standing admin accounts: Settings → Users → set non-essential admins to Operator/Viewer.

NETWORK
• "No admin ports (SSH/RDP) open to the internet" — Network → Analysis & Exposure → Scan firewall rules → click the Critical + High tile. For each SSH (22) / RDP (3389) rule open to 0.0.0.0/0, restrict the source to your admin CIDR (or click Remediate) in the cloud NSG / security-group, then re-scan.
• "No allow-all / critical exposure" — same screen; remediate any all-ports / all-source rule immediately.
• "Public attack surface minimized" — confirm each resource with a public IP is intended; remove public IPs that aren't needed.

DEVICES & WORKLOADS
• "Workloads have a posture agent / SSH pull" — open the pillar to see every VM and which lack telemetry, then enrol them: Command Center → Add SSH pull (agentless) or Push agent. Coverage reaches 100% once each VM reports.
• "No open vulnerabilities" — Security → Cloud Findings → External VAPT scan (or Refresh findings). Patch / upgrade the flagged service, then re-scan; resolved findings drop off.

DATA
• "No unencrypted-data findings" — fails when a cloud-posture finding mentioning encryption is open (e.g. "VM should enable Azure Disk Encryption / EncryptionAtHost", unencrypted EBS / disk, storage without encryption). Fix at the source:
   – Azure: enable Encryption at host (or Azure Disk Encryption). Portal → VM → Disks → Additional settings → Encryption at host = On (deallocate the VM first; register the feature once per subscription). CLI:
       az feature register --namespace Microsoft.Compute --name EncryptionAtHost
       az vm deallocate -g <rg> -n <vm>
       az vm update -g <rg> -n <vm> --set securityProfile.encryptionAtHost=true
       az vm start -g <rg> -n <vm>
   – AWS: turn on account-level "EBS encryption by default", and encrypt existing volumes (snapshot → copy as encrypted → restore). Enable S3 default encryption (SSE-KMS).
   – GCP: data is encrypted at rest by default; for compliance attach customer-managed keys (CMEK) to disks / buckets.
   Then Security → Cloud Findings → Refresh findings. Once Defender / Security Hub / SCC no longer reports it, the finding becomes resolved and this check turns ✓.
• "Secrets sealed at rest" — connection secrets and vault passwords are sealed with AES-256-GCM by default.

VISIBILITY & ANALYTICS
• "Telemetry agents reporting" / "SIEM events flowing (24h)" — enrol at least one agent / SSH-pull host (Command Center) so telemetry and SIEM events flow; review them in Activity & Event Tracking.

AUTOMATION & GOVERNANCE
• Define alert rules (Security → Alert Rules), automation workflows and approval/escalation policies so response is codified, not manual.

Note: findings pulled from Defender / Security Hub / SCC are read-only in MCMF — fix them in the cloud, then Refresh findings. The check re-evaluates automatically on the next pull.`,
  },
  {
    id: 'notifications',
    icon: '📨',
    title: '7. Notifications, retry & retention',
    body: `Channels (Security → Automation → Notification Channels): Email, Slack, WhatsApp, PagerDuty, generic Webhook, or a Group/Team. Workflows with the Notify action deliver to all enabled channels.

Reliability: every send is recorded in the Notification Delivery Log. A failed send auto-retries 3× every 3 minutes, then hourly, stopping after 3 days. Retry or Delete any entry manually.

Compliance retention: all deliveries (sent and failed) are kept for a configurable window (default 3 months — 30 days to 2 years presets, or custom), then auto-purged.`,
  },
  {
    id: 'whatsapp-token',
    icon: '💬',
    title: '7.1 WhatsApp access token (permanent)',
    body: `WhatsApp uses Meta's Cloud API. The token shown under WhatsApp → API Setup is TEMPORARY — it expires in ~24 hours. When it expires the integration health check fails with "token expired (code 190)" and MCMF raises an alert. Replace it with a permanent System-User token (does not expire):

1. developers.facebook.com → your App → WhatsApp → API Setup — copy the Phone Number ID.
2. business.facebook.com → Business Settings → Users → System Users → Add → create a System User with the Admin role.
3. System User → Add Assets → add your WhatsApp app (and WhatsApp Account) with Full control.
4. System User → Generate new token → pick the app → tick permissions whatsapp_business_messaging AND whatsapp_business_management → Generate token. Copy it (it is shown once). This token has no expiry.
5. MCMF → Settings → Integrations → WhatsApp → paste the Phone Number ID + the new token → Save → click Test.

Notes: keep the sending number verified and within Meta's tier limits. MCMF re-checks every integration once an hour and alerts the moment a token expires — so you'll know before users miss a notification.`,
  },
  {
    id: 'ai',
    icon: '✨',
    title: '8. AI Assistant & Root-Cause Analysis',
    body: `Command Center → AI Assistant answers "how do I…" and "why is…" questions grounded in MCMF + your live state. RCA writes an evidence-based root cause for an incident.

Choose your LLM in Settings → Integrations → AI Assistant:
• Free (built-in) — no key, no cost, works offline (navigation help + rule-based RCA).
• Claude (Anthropic), ChatGPT (OpenAI), or Gemini (Google) — bring a key for AI-written answers. Gemini has a free tier.
Set AI Provider (or leave blank to auto-detect by key). If a cloud provider errors, MCMF falls back to Free automatically.`,
  },
  {
    id: 'rbac',
    icon: '👥',
    title: '9. Users, roles & access',
    body: `Settings → Users & Access (admin only). Roles: Admin (full), Operator (cloud ops, no user/billing admin), Viewer (read-only).

Per-role visibility (Settings → Workspace): show/hide modules, dashboard widgets and Help sections for Operator/Viewer (Admin always sees all); reorder the sidebar.

Monitoring-only user: create a Viewer, assign Monitor Groups (so they see only those IP/Host monitors), and hide all modules except Monitoring. 2FA (TOTP) is available per account; password changes happen in Edit User.`,
  },
  {
    id: 'email',
    icon: '✉️',
    title: '10. Email (SMTP) & remote console',
    body: `Email: MCMF has a built-in sender (from no-reply@mcmf.edu) used by default. Add an external SMTP relay (Settings → Integrations → Email — Gmail/M365/SendGrid/SES) and it takes over automatically; remove it and the built-in returns. Note: the built-in needs outbound port 25 open — for reliable delivery use an external relay on 587.

Remote console: open in-browser RDP/SSH/Telnet to a VM (via Apache Guacamole) from the VMs table, with a per-VM encrypted credential vault, or download a .rdp / copy an ssh command for a native client.

HOW THE CONSOLE REACHES THE HOST — three paths, picked automatically:
• Outbound-AGENT TUNNEL (best for private / NAT'd hosts): if the host runs the pure-outbound MCMF agent, the console is relayed THROUGH the agent's own outbound connection to its local RDP/SSH (127.0.0.1:3389 / :22). No inbound port, no VPN, no LAN route from MCMF needed — works for a LAN host behind NAT even from a cloud-hosted MCMF. You'll see "Reachable through the <agent> tunnel" instead of a port probe. Just make sure Remote Desktop (Windows) or sshd (Linux) is enabled on the host.
• Direct (no agent): MCMF connects straight to the host's 3389/22 — needs that port open from the MCMF server (cloud NSG/security-group + OS firewall) and a routable IP.
• Cloud-credential SSH (AWS/GCP/Azure Linux): pick "☁ Cloud creds" — MCMF brokers a one-time key with the cloud account you already connected (no key paste). See section 17.

Note: the agent tunnel rides the agent's HTTPS connection to MCMF and trusts MCMF's self-signed cert via a compiled .NET delegate on Windows (no inbound port on the host). If RDP works from another PC but the browser console hangs at "Connecting…", the host's agent is likely the old push build — re-run the installer (it's a clean upgrade to the outbound, tunnel-capable agent).`,
  },
  {
    id: 'sizing',
    icon: '📐',
    title: '11. Production sizing & capacity planning',
    body: `MCMF is a single-host Docker Compose stack (PostgreSQL + API + Web + nginx + guacd + backup). One server scales to thousands of managed devices because work is light and steady — short reachability checks, agentless pulls and periodic SNMP/cloud polls — not heavy compute.

WHAT DRIVES LOAD (so you can size for YOUR mix)
• Device count (N) — every monitored VM / network device adds a reachability check (~30s), and, if enabled, an SSH/TCP agent pull (default 120s) or an SNMP poll. API CPU scales with how many run concurrently.
• Telemetry & history in PostgreSQL — metric points, alerts, SIEM/events, notification logs, audit. This is the main disk driver and is bounded by RETENTION (configurable in Settings).
• SNMP switches with large MAC/FDB tables and busy interfaces cost more per poll than a ping-only host.
The tiers below assume a realistic blend: ~70% hosts with agent pull + ~30% network devices on SNMP, default intervals, and 90-day log retention.

RECOMMENDED SERVER (the MCMF host), by max managed devices
┌──────────────┬───────┬────────┬────────────┬──────────────────────────────────────────────┐
│ Max devices  │ vCPU  │ RAM    │ Disk (SSD) │ Notes                                          │
├──────────────┼───────┼────────┼────────────┼──────────────────────────────────────────────┤
│ up to 100    │  2    │  4 GB  │   40 GB    │ Lab / small site. Default intervals fine.      │
│ up to 200    │  4    │  8 GB  │   80 GB    │ Small production.                              │
│ up to 500    │  6–8  │ 16 GB  │  200 GB    │ Stagger pulls; keep 90-day retention.          │
│ up to 1000   │ 8–12  │ 32 GB  │  400 GB    │ Raise pull interval to 180–300s.               │
│ up to 2000   │  16   │ 64 GB  │  800 GB    │ Consider a dedicated PostgreSQL volume/disk.   │
│ up to 5000   │ 24–32 │ 128 GB │  1.5–2 TB  │ Externalize PostgreSQL to its own host.        │
│ 10000+       │  scale-out: separate DB host + multiple API workers behind nginx (see below).        │
└──────────────┴───────┴────────┴────────────┴──────────────────────────────────────────────┘
All tiers: SSD/NVMe (PostgreSQL is IOPS-sensitive), Ubuntu 22.04+ with Docker, and a 1 Gbps NIC. Disk includes the OS + Docker images (~20 GB base) + PostgreSQL data + headroom.

WORKED EXAMPLES
• 100 VMs/servers → 2 vCPU, 4 GB RAM, 40 GB SSD. PostgreSQL footprint at 90-day retention is only a few GB; the 40 GB is mostly base + headroom.
• 200 VMs → 4 vCPU, 8 GB RAM, 80 GB SSD. Comfortable for agent pulls + a handful of SNMP switches.
• 500 VMs → 6–8 vCPU, 16 GB RAM, 200 GB SSD. Spread agent pulls so they don't all fire together; default 90-day retention.
• 1000 VMs → 8–12 vCPU, 32 GB RAM, 400 GB SSD. Increase the pull interval to 180–300s and SNMP to 60s; this halves steady CPU vs. defaults.
• 2000 VMs → 16 vCPU, 64 GB RAM, 800 GB SSD; put the PostgreSQL data directory on its own SSD/volume.
• 5000 VMs → 24–32 vCPU, 128 GB RAM, ~1.5–2 TB SSD, with PostgreSQL on a dedicated database server.

DISK = base(~20 GB) + PostgreSQL data + headroom. PostgreSQL size ≈ (events/day × bytes/row × retention_days) + small fixed tables. Time-series are pruned automatically (fleet metric points kept 7 days; delivery logs default 90 days — Settings → log retention). To shrink disk: lower retention, or trim SIEM/event volume.

TUNING KNOBS (env on the api service)
• MONITOR_INTERVAL_MS — reachability cadence (default 30000).
• Agent pull interval — per target (default 120s); raise it at scale.
• EVAL_INTERVAL_MS — alerting engine (default 60000).
• Log retention — Settings → Organization (delivery logs default 90 days).
Rule of thumb: above ~1000 devices, lengthen intervals before adding hardware — it's the cheapest lever.

WHEN TO SCALE OUT (beyond ~5000 devices)
• Move PostgreSQL to its own host (or managed Postgres) on fast SSD; point the api at it.
• Run multiple api replicas behind nginx (the pull/poll loops are idempotent and DB-coordinated).
• Keep guacd local to the console users for low latency.

AVAILABILITY: take regular PostgreSQL backups (the bundled backup container) and snapshot the host. For HA, run a warm standby host and a Postgres replica; failover by repointing nginx/DNS.

These are starting points — watch CPU, RAM and PostgreSQL disk for 1–2 weeks at your real device mix and adjust. The intervals matter more than the absolute count.`,
  },
  {
    id: 'agent-deploy',
    icon: '🛰',
    title: '12. MCMF Agent — deployment guide',
    body: `There is ONE MCMF agent, with a single copy per OS (Linux .py, Windows .ps1/.exe). It replaces all earlier agent variants. It is a PULL agent: it listens on a custom TCP port and MCMF connects IN and pulls — nothing is pushed, so it works even when MCMF is private. One agent delivers everything MCMF asks for.

WHAT THE AGENT DELIVERS (every pull)
• CPU %, Memory %, Disk %, Network (Mbps)
• Top processes with per-process CPU % and Memory % (Task-Manager style)
• Uptime, hostname, all IP addresses
• Recent OS events / logs → streamed into the SIEM/SOC pipeline (Command Center)
The same one agent feeds Monitoring, Telemetry, Services, the SIEM event stream and alerting. There is no separate "events agent" or "metrics agent".

WIRE PROTOCOL (simple + auditable)
MCMF opens a TCP socket to <vm>:<port> (default 9182), sends "AUTH <key>", the agent replies with ONE line of JSON telemetry, then the socket closes. No HTTP, no inbound to MCMF, read-only.

REQUIRED DEPENDENCIES
• Linux: python3 (standard library only — no pip packages). systemd recommended for a service.
• Windows: Windows PowerShell 5.1+ (built in). Optional: PS2EXE module to compile to a single mcmf-agent.exe. Run as Administrator/SYSTEM for full process + event access.
• Network: open inbound TCP 9182 (or your chosen port) from the MCMF server to the VM — on BOTH the cloud NSG/security-group AND the OS firewall.

DEPLOY — LINUX (get the script from Help → Agents → "MCMF Agent — Linux (.py)")
1. Save it on the VM as mcmf-agent.py (the key + default port are baked in).
2. Quick test:   MCMF_AGENT_PORT=9182 python3 mcmf-agent.py &
3. Install as a service (survives reboot):
     sudo mkdir -p /opt/mcmf && sudo cp mcmf-agent.py /opt/mcmf/
     sudo tee /etc/systemd/system/mcmf-agent.service >/dev/null <<'UNIT'
     [Unit]
     Description=MCMF Guest Agent
     After=network-online.target
     [Service]
     ExecStart=/usr/bin/python3 /opt/mcmf/mcmf-agent.py
     Restart=always
     User=root
     Environment=MCMF_AGENT_PORT=9182
     [Install]
     WantedBy=multi-user.target
     UNIT
     sudo systemctl daemon-reload && sudo systemctl enable --now mcmf-agent
4. Open the firewall:   sudo ufw allow 9182/tcp   (or firewall-cmd --add-port=9182/tcp --permanent && firewall-cmd --reload)
5. Enroll in MCMF: Command Center → + Add target → Method = Agent → host = the VM IP, port = 9182, key = baked-in value.
   Or skip all of the above: click "⬇ Push agent" on the VM in Command Center and MCMF installs everything over SSH (systemd if it can sudo, else a self-healing cron watchdog).

DEPLOY — WINDOWS (Help → Agents → "MCMF Agent — Windows (.ps1 / .exe)")
1. Save as mcmf-agent.ps1.
2. Quick test (Admin PowerShell):   $env:MCMF_AGENT_PORT=9182; powershell -ExecutionPolicy Bypass -File .\\mcmf-agent.ps1
3. Run on boot as SYSTEM (Task Scheduler) — use the "Install as service — Windows" script in Help, or:
     New-Item -ItemType Directory -Force 'C:\\Program Files\\MCMF' | Out-Null
     Copy-Item mcmf-agent.ps1 'C:\\Program Files\\MCMF\\'
     $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Program Files\\MCMF\\mcmf-agent.ps1"'
     Register-ScheduledTask -TaskName 'MCMF Agent' -Action $a -Trigger (New-ScheduledTaskTrigger -AtStartup) -User SYSTEM -RunLevel Highest -Force; Start-ScheduledTask -TaskName 'MCMF Agent'
4. Compile to a single .exe (optional):   Install-Module ps2exe -Scope CurrentUser -Force; Invoke-PS2EXE .\\mcmf-agent.ps1 .\\mcmf-agent.exe -noConsole
5. Firewall: the script adds an inbound rule for the port automatically; ensure the cloud NSG also allows TCP 9182 from MCMF.
6. Enroll the VM IP + port + key in Command Center (or use Push agent for Linux).

UPDATING / REMOVING
• Update (recommended): just re-run the installer — the bootstrap one-liner or the .exe. Every install is a CLEAN UPGRADE: it auto-stops and removes any prior/legacy agent first, then installs the latest pure-outbound agent. No duplicates, no leftover legacy "push" agent. The host flips to "outbound ✓" within ~60s.
• Remove from the console: Command Center → open the agent → ⏻ Shut down (uninstalls the agent and deletes its record). Use this when the host is reachable/online.

• Remove ON THE HOST — ONE COMMAND (run as Administrator / root; use when you want to wipe it locally):

  WINDOWS (elevated PowerShell):
  Get-ScheduledTask -TaskName 'MCMF*' -EA SilentlyContinue | %{ Stop-ScheduledTask $_.TaskName -EA SilentlyContinue; Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -EA SilentlyContinue }; Get-CimInstance Win32_Process | ?{ $_.CommandLine -like '*mcmf-tray-agent*' } | %{ Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }; Remove-Item -Recurse -Force 'C:\\Program Files\\MCMF', "$env:ProgramData\\MCMF" -EA SilentlyContinue; netsh advfirewall firewall delete rule name='MCMF Agent 9182' 2>$null; Write-Host 'MCMF agent removed.'

  LINUX (sudo):
  sudo systemctl stop mcmf-agent 2>/dev/null; sudo systemctl disable mcmf-agent 2>/dev/null; sudo rc-service mcmf-agent stop 2>/dev/null; sudo rm -f /etc/systemd/system/mcmf-agent.service /etc/init.d/mcmf-agent; sudo systemctl daemon-reload 2>/dev/null; sudo rm -rf /opt/mcmf; echo 'MCMF agent removed.'

• After a host-side removal, also delete the record in Command Center (→ the agent → Remove) if it lingers. To re-install, just run the installer again — it's a clean upgrade.`,
  },
  {
    id: 'replication-dr',
    icon: '⇄',
    title: '13. Replication & DR — multi-cloud HA (module + agents)',
    body: `Replication & DR pairs a PRIMARY VM with a SECONDARY (and optional TERTIARY) in another cloud so an application keeps running when a provider goes down (GCP → AWS, on-prem → Azure, etc.). MCMF is the CONTROL + STATUS plane; the actual data movement runs over SSH. DNS is yours to manage — on failover MCMF marks the new active side and logs "repoint DNS to <host>"; you update the record externally.

──────── ENGINES (what gets replicated) ────────
• Files / app data — rsync (mirror, with --delete) of a source directory to the target.
• Database — logical dump → restore: PostgreSQL (pg_dump -Fc / pg_restore) or MySQL/MariaDB (mysqldump / mysql).
• Docker volumes — each named volume's data is exported via a throwaway container (tar of the volume mount, so no host-root path access is needed), shipped to the target, and restored into the same-named volume. Point it at your app's data volumes (e.g. pgdata, uploads) for containerized-app HA. Needs docker on both hosts.
• Block device — DRBD (SYNCHRONOUS, RPO 0). True block-level mirroring with protocol C: every write is committed on both nodes before it's acknowledged, so zero data is lost on failover. MCMF installs drbd-utils, writes the resource, brings it up on both nodes, makes the primary Primary (seeding the initial full sync), and reports drbdadm status; "Sync now" re-runs this idempotently as a health-heal. The backing device must be a DEDICATED, empty block device or LVM volume on BOTH hosts (DRBD stores its metadata on the device — any existing filesystem there is lost). Linux-only. Open the DRBD TCP port (default 7789) between the hosts. On failover MCMF promotes the secondary with drbdadm primary and demotes the old primary.
Set the schedule per set: scheduled (every N minutes), async (ship deltas ~every few minutes), or sync. For files/database/docker, "sync" is NEAR-sync — MCMF runs the engine every N seconds (default 30, min 10; set "Near-sync interval") for near-real-time but NOT zero-RPO. For true RPO 0 use the DRBD block engine, which replicates continuously in the kernel (not on a timer).

──────── ENDPOINTS: OS + ADDRESS (Windows or Linux, public or private) ────────
When you create or edit a set, each endpoint (primary / secondary / tertiary) has:
• OS — 🐧 Linux or 🪟 Windows. This is REQUIRED so MCMF builds the right sync command (Windows uses PowerShell + tar/OpenSSH; Linux uses rsync/bash). "Auto (from provider)" infers it from the resource — but SET IT EXPLICITLY for a Windows box whose inventory record doesn't say "windows", or Windows→Windows file sync will try a Linux command and fail. Both a Windows PC and a Linux VM are valid on either side.
• Address — which IP to replicate over. "Auto" picks a PUBLIC IP for cross-cloud pairs (a private 10.x/172.16-31.x/192.168.x address cannot route between clouds or from an off-network MCMF) and a private IP same-cloud. Override to Private (same VPC / over a VPN) or Public per side. In ✎ Edit you can type any host/IP directly.

──────── STEP-BY-STEP: replicate Azure ⇄ AWS (Windows PCs) ────────
1. + New replication set → Name it, Data type = Files, pick the Primary (Azure) and Secondary (AWS) VMs.
2. Set each endpoint's OS = 🪟 Windows and Address = Public (so the two clouds can reach each other). Set Source path (e.g. C:\\data) and Target path (e.g. C:\\data).
3. Run via = Installed agent (MCMF on a private LAN can't SSH into cloud VMs; the agent runs the sync locally, outbound-only).
4. Add the SECONDARY's SSH credential to Credential Vault (the agent installs its key there once). Open the AWS security group so the Azure PC can SSH to the AWS PC (port 22).
5. Create → on the card click ⤓ Install agent, run the one-liner on the Azure PC (and on the AWS PC too, so it can sync back after a failover).
6. Click ✓ Test — it runs live checks and shows exactly what's still missing (credential, agent online, reachability, path). Fix reds, re-test, then Sync now.

──────── CARD ACTIONS ────────
• Sync now — run one hop immediately.   • ✓ Test — live connectivity/credential/agent/tool/path diagnostic; shows where it fails (red = blocking, amber = advisory).   • ✎ Edit — change ANY field later: hosts/IP, per-endpoint OS, paths, DB engine/name/user/password, docker volumes, DRBD device, driver, schedule.   • Pause / Resume — toggle scheduling.   • ■ Stop — hard-stop (disable scheduling + clear any in-progress run); Resume re-enables.   • ⚡ Fail over / ↩ Fail back — mark the active side.   • History — every run with output.

──────── RUN VIA: MCMF (SSH) vs INSTALLED AGENT ────────
• MCMF (SSH) — MCMF connects OUT to the source host over SSH (Credential Vault creds) and runs the engine. Nothing to install; good when MCMF can reach the source. NOTE: if MCMF is on a private network it usually CANNOT reach cloud VMs — use the agent instead.
• Installed agent — a small agent runs ON the host and does the replication locally, then reports status to MCMF. Use this when MCMF should not / cannot SSH into the source (private/NAT'd hosts, cross-cloud, tighter blast radius). MCMF stays status-only for agent sets; its own SSH scheduler skips them. The card shows the PRIMARY and SECONDARY agent's status (online / offline / pending, with OS + version + last-seen on hover).

──────── THE STANDALONE AGENT (Linux + Windows) ────────
Both agents behave the same way. Get them two ways: (1) Replication → a set's card → "⤓ Install agent" (per-host, pick 🐧 Linux or 🪟 Windows), or (2) Help → Agents & Infra → "Replication & DR Agent — download & install" — pick the host + OS and ⤓ Download the ready-to-run agent (.sh / .ps1) or copy the one-line installer. Either way, run it on the host as root/Administrator. Install the agent on BOTH the primary and the secondary so replication can resume after a failover.
• Poll — every 60 seconds the agent checks in with MCMF, receives its DUE jobs as ready-to-run commands, executes them locally, and reports success/output back. The card shows an "agent online / offline" badge (online = seen in the last 3 min).
• Auto-update + version control — each build has a version baked in (shown in the install dialog). On check-in MCMF returns the current build; if the agent is older it self-updates (re-downloads + restarts) with a 5-minute cooldown so it can't loop. To push a new agent to every host, the operator just bumps the server build — deployed agents upgrade themselves.
• Exit protection + restart — the agent is registered as an always-on background service set to restart on failure, so killing the process or a crash just brings it back.
• Survives reboot & logoff — it runs as a system service (not a user session): Linux = a systemd timer; Windows = a SYSTEM scheduled task (AtStartup + every minute). Logging off or rebooting the host does not stop it.
• Outbound-only — the agent needs OUTBOUND access to MCMF and SSH to the target. Nothing inbound is opened on the host.

LINUX agent — installs curl/jq/rsync/openssh-client, drops /opt/mcmf-repl/agent.sh, and enables the mcmf-repl-agent.timer. Logs: journalctl -u mcmf-repl-agent.service -f. Remove: sudo bash /opt/mcmf-repl/agent.sh uninstall.
  Install URL (served per host with its enrollment key): {MCMF_URL}/api/replication/agent/script?key={AGENT_KEY}&url={MCMF_URL}&os=linux
  One-liner (run as root):  curl -fsSk '{that URL}' -o /tmp/mcmf-repl-agent.sh && sudo bash /tmp/mcmf-repl-agent.sh install
WINDOWS agent — a PowerShell script under %ProgramData%\\MCMF-Repl, registered as the "MCMF Replication Agent" SYSTEM scheduled task. It auto-enables the built-in OpenSSH client. Remove: run the script with the uninstall argument, or Unregister-ScheduledTask -TaskName 'MCMF Replication Agent'.
  Install URL (served per host with its enrollment key): {MCMF_URL}/api/replication/agent/script?key={AGENT_KEY}&url={MCMF_URL}&os=windows
  One-liner (run in an elevated PowerShell):  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; iwr '{that URL}' -OutFile $env:TEMP\\mcmf-repl-agent.ps1; & $env:TEMP\\mcmf-repl-agent.ps1 install"
The exact URLs + copy/download buttons for BOTH OSes are generated for each host in Replication → the set's card → "⤓ Install agent" (or Help → Agents & Infra). {MCMF_URL} is your MCMF base URL; {AGENT_KEY} is the per-host key MCMF mints on enrollment.

──────── TRANSPORT: KEY-BASED SSH (auto-provisioned) ────────
Agents push over key-based SSH — no passwords on the host. On first install the agent generates an SSH keypair; on its first check-in MCMF installs the agent's PUBLIC key onto the target's authorized_keys using the target's Credential-Vault SSH credentials. So before installing the agent, add the TARGET host's SSH creds to the Credential Vault. (If MCMF cannot reach the target to install the key, the installer also prints the public key so you can authorize it manually.) The DB engines still use the database password you set on the replication set (stored encrypted).

──────── FAILOVER ────────
On the set's card: "⚡ Fail over" promotes the secondary (or "→ Tertiary"), "↩ Fail back" returns to the primary. MCMF marks the active side and logs the DNS hint — you repoint DNS. Replication direction follows the active side. "Sync now" runs a hop immediately; "History" shows every run with output.

──────── CROSS-CLOUD VPN (IPsec / strongSwan) — integration guide ────────
The "🔒 Cross-cloud VPN links" panel (below the replication sets) builds a private, encrypted IPsec tunnel between two clouds/sites so replication and failover traffic never crosses the public internet in the clear. + New VPN link → pick side-A and side-B VMs (or mark side B an "external gateway / on-prem"), choose site-to-site (route whole subnets) or host-to-host (just the two VMs), IKE version, and an optional PSK (auto-generated if blank). "▲ Bring up" makes MCMF install strongSwan and write a symmetric swanctl config on each MCMF-managed peer over SSH (Credential Vault creds), then initiate the tunnel; "↻ Refresh" re-reads the SA state; "▼ Down" tears it down.

TWO MODES — each side of a link is either a "Managed VM" or a "Gateway":
• ⚙ AUTO-CONFIG (managed VM ↔ managed VM) — MCMF installs strongSwan on each VM over SSH and builds the tunnel. VM pickers list ONLY running Linux VMs that have an SSH credential in the Credential Vault (a stopped VM, a Windows box, or one with no creds can't be an MCMF-managed endpoint). "▲ Bring up" configures + initiates; "↻ Refresh" re-reads the SA; "▼ Down" tears it down.
• 👁 MONITOR-ONLY (gateway ↔ gateway) — for AWS/Azure/GCP/on-prem VPN gateways (or in-cloud firewalls) that YOU set up in the cloud console / on the device. MCMF configures NOTHING; it only watches the site-to-site status and which ports are open. Pick "Gateway" on a side, choose the provider + public IP + subnet. No VM, no PSK to manage on that side. Use this for cloud-native gateway-to-gateway VPNs.

MONITORING (how MCMF reads a monitor-only tunnel's status + open ports):
• Cloud API (authoritative) — give the cloud VPN connection/tunnel id and, if that cloud account is connected in MCMF, it reads the real tunnel state from the provider API: AWS (vpn-xxxx → DescribeVpnConnections, tunnel UP/DOWN), Azure (resourceGroup/connectionName → connectionStatus Connected/NotConnected), GCP (region/tunnelName → vpnTunnel status ESTABLISHED). Falls back to the probe if the id/account isn't available.
• Active probe (universal) — name a "probe from" host (any VM MCMF has an SSH credential for, near one tunnel end), a target IP on the far side, and a list of TCP ports. MCMF pings the target + TCP-tests each port THROUGH the tunnel and reports reachable (up/down) + which ports are open/closed. Works for any cloud/on-prem combo, Linux or Windows probe host. "✓ Check now" runs it on demand; it also re-checks every 60s.
• The card shows status (up/down) with its source (aws-api / azure-api / gcp-api / probe) and the per-port results.

AUTO-POPULATE — as soon as you pick the endpoints, MCMF detects each side's cloud (AWS / Azure / GCP / on-prem), auto-fills the local subnet (CIDR) from discovery metadata, picks vendor-compatible IKE/ESP proposals, and shows a per-side REQUIREMENTS checklist (what to create + which ports to open) right in the dialog. You can override any auto-filled value.

ALL GATEWAY TYPES SUPPORTED (site-to-site compatible) — when side B is an external gateway, pick its type; MCMF tunes the proposals + shows that vendor's exact setup steps and the mirror params:
• Cloud VPN gateways — AWS (VPN Gateway / Transit Gateway + Customer Gateway), Azure (VPN Gateway + Local Network Gateway + Connection; route-based=IKEv2, policy-based=IKEv1), GCP (Cloud VPN / HA VPN + peer gateway + tunnel).
• On-prem / cloud firewalls — Cisco ASA, Cisco IOS/CSR, Fortinet FortiGate, Palo Alto (PAN-OS), pfSense/OPNsense, MikroTik RouterOS, Sophos/SonicWall/UTM, Check Point, and a generic IKEv2 profile for anything else. (Some customers run these firewalls IN the cloud — that works the same; pick the vendor type and point it at the peer's public IP.)
• Crypto is chosen for broad interop: IKEv2 with AES-256-GCM first, then AES-256/SHA-256/DH14, then a legacy AES-256/SHA1/DH2 fallback, so negotiation succeeds against strict cloud gateways and older firewalls alike. PFS on by default.

REQUIREMENTS BY CLOUD (side A terminating strongSwan on a VM):
• AWS — SG + NACL allow UDP 500/4500 + ESP (proto 50) from the peer IP; route table: remote subnet → the VM's ENI; DISABLE source/dest check on the ENI; give the VM an Elastic IP.
• Azure — NSG allow UDP 500/4500 + ESP; ENABLE IP forwarding on the NIC; UDR: remote subnet → the VM; static Public IP.
• GCP — VPC firewall allow udp:500,4500 + protocol 50 from the peer; set --can-ip-forward; custom route remote subnet → next-hop-instance = the VM; reserve a static external IP.
• On-prem — perimeter firewall allow UDP 500/4500 + ESP; if behind NAT, forward 500/4500 + use NAT-T; route the remote subnet to the gateway.

ON-PREM → CLOUD — mark side B "external gateway / on-prem", enter its public IP, choose the device type, and (optionally) a device label. MCMF configures the cloud side (A) and, after Bring up, the card's hint shows the exact mirror config + PSK + firewall/port list to apply on your on-prem device.
• Add a cloud ROUTE-TABLE entry for the remote subnet on each cloud side (MCMF can't edit a VPC/VNet route table from inside a guest). Site-to-site also enables net.ipv4.ip_forward on MCMF-managed hosts.
• Once "up", point a replication set at the peer's PRIVATE subnet address so the data rides the tunnel.
• Status shows up / down / error; "SA status" shows the raw swanctl --list-sas (look for ESTABLISHED + INSTALLED).

──────── COMMON ISSUES (run ✓ Test first — it pinpoints most of these) ────────
• "No SSH credential for the source/target host …" — add that host's SSH creds in Credential Vault (needed for MCMF-SSH runs and, for agents, to install the key once). If the host shown is a PRIVATE IP (10.x / 172.16-31.x / 192.168.x) on a cross-cloud pair, that's the real problem: ✎ Edit → set that endpoint's Address = Public.
• Set shows a private IP that MCMF can't reach — you're on the MCMF-SSH (orchestrated) driver on a private network. Switch Run via = Installed agent (✎ Edit), install the agent on the source, and it runs the sync outbound-locally.
• Windows→Windows file sync fails on the target — set BOTH endpoints' OS = 🪟 Windows (✎ Edit). If OS was "Auto" and the inventory didn't tag the box as Windows, MCMF built a Linux command.
• Agent badge stuck "offline/pending" — the service isn't checking in: confirm the host has outbound HTTPS to MCMF; Linux: systemctl status mcmf-repl-agent.timer; Windows: Get-ScheduledTask 'MCMF Replication Agent'.
• DB/rsync/docker "not found" in History — install the client tools on the SOURCE (rsync, postgresql-client/mysql-client, or docker). ✓ Test flags these when it can reach the source.
• Windows push fails auth — the agent's key isn't on the target yet: make sure the target's SSH creds are in the Vault, or paste the agent's printed public key into the target's authorized_keys.`,
  },
  {
    id: 'troubleshooting',
    icon: '🧰',
    title: '14. Troubleshooting & remediation playbook — every module',
    body: `A symptom → fix reference for the whole platform. Each fix points to the exact screen. (For Zero-Trust check fixes specifically, see section 6.1.)

──────── CLOUD CONNECTIONS ────────
• "invalid_grant: Invalid JWT: Token must be a short-lived token… / signature" (GCP/AWS/Azure) — the server clock has drifted. Cloud auth signs short-lived JWTs; a clock skew of minutes breaks it. Fix: sync the MCMF host clock (NTP / "timedatectl set-ntp true", or the mcmf-timesync timer). Re-test the connection afterwards.
• "SSH connect & authenticate failed: Timed out while waiting for handshake" — MCMF can't reach the host on TCP 22. Confirm the host is up, OpenSSH is running, and inbound 22 is open from the MCMF server on BOTH the cloud NSG/security-group and the OS firewall. Use the host's reachable (public/private-routable) IP.
• "Test failed — permission/AccessDenied" — the service-account/role lacks read access. Grant the read-only roles from Help → Cloud Setup (the grant scripts), then re-test.
• Secrets — every cloud credential, SSH password and API key is sealed (AES-256-GCM) in the vault; nothing sensitive is committed to GitHub. Rotate via Connections → edit.

──────── HOSTS, VMs & AGENTS ────────
• A VM shows the wrong up/down state — host status is live: UP if it sent a heartbeat within ~120s OR a reachability monitor is up; otherwise DOWN. After a shutdown it flips to "stopped" within ~2 minutes; pages auto-refresh, no reload needed.
• A host appears two/three times (by IP, by hostname, by a second IP) — these are collapsed automatically into one identity in the VM list and topology. If you still see a duplicate, it's a different physical machine or a cloud VM (whose private IPs legitimately repeat).
• A VM you removed keeps coming back in the topology — see section 14.1 (Removing a VM from the topology). Short version: open Network Topology, click the VM node, and in the detail panel press 🗑 Remove from topology. It returns only if (a) it's a cloud VM and the cloud account is still connected — it's re-discovered on the next scan — or (b) it's a host whose MCMF agent is still installed and checking in. Stop/uninstall that agent first (Command Center → the agent → ⏻ Shut down), then remove.
• Windows agent goes offline after you close PowerShell / log off — the old build ran in your session. Re-download the installer (Help → Agents → ⬇ Windows installer .exe), run it, and reboot once: the new build runs as an always-on SYSTEM service that reports across logoff/reboot.
• A VM has no agent / lacks telemetry — Command Center → Add agent (agentless SSH) or Push agent; or from the IP/Host monitor row click "🔌 Add agent". The host needs OpenSSH + inbound TCP 22 from MCMF (Linux/Windows-OpenSSH).
• "Push agent" / remote install fails on Windows — remote install needs OpenSSH Server enabled on the target and a local-admin login. If it's not enabled, run the .exe installer locally (Help → Agents) instead. On a brand-new box with nothing enabled, the bootstrap one-liner (Help → Agents, Windows tab) installs with zero dependencies.
• Test a Windows/endpoint agent — in Command Center, the agent's ⟳ Test pulls from its listener (TCP 9182). For a push agent behind NAT an inbound test can fail even though push works — if it isn't appearing at all, its background service isn't running; re-install + reboot.

──────── MONITORING ────────
• A monitor is "down" but the host is fine — monitors check a specific service port (e.g. the agent's 9182), which can be closed while the host is healthy; ICMP may be blocked. The host's up/down still reflects the heartbeat. Open the port or adjust the monitor target/port.
• No CPU/mem/disk for a host — add an agent (above). SNMP devices (firewall/router/switch): pick the device type and add the SNMP community to pull bandwidth, uptime and the MAC table.

──────── SECURITY & FINDINGS ────────
• A finding won't clear after you fixed it — Defender / Security Hub / SCC findings are read-only in MCMF. Fix in the cloud, then Security → Cloud Findings → Refresh findings; resolved items drop off and the related Zero-Trust check turns ✓.
• "No scannable VM IPs are enrolled yet" on VAPT — add VMs / IP monitors first; the external scan needs a reachable IP per host. See "Scan coverage & process" on the Findings panel for the full ruleset.
• Encryption / unencrypted-data check failing — see section 6.1 (Azure EncryptionAtHost / ADE, AWS EBS+S3 default encryption, GCP CMEK), then Refresh findings.

──────── ALERTS & NOTIFICATIONS ────────
• No alerts firing — define threshold rules (Security → Alert Rules). The engine evaluates live metrics every minute.
• WhatsApp delivery fails with "code 190 / token expired" — the Meta access token expired. Settings → Integrations → WhatsApp → paste a new token (use a permanent System-User token; steps in Help → Integrations).
• Email not sending (alerts / password reset / MFA email code) — SMTP isn't configured. Settings → Integrations → Email (SMTP). Until then, MFA email codes and reset links are unavailable (authenticator codes still work).

──────── SIGN-IN & MFA ────────
• Require MFA for a user — Settings → Users → edit → "Require multi-factor authentication". They enrol an authenticator on next sign-in; after that they can also get a one-time code by email ("✉ Email me a code instead").
• User lost their authenticator — they can use a recovery code, or on the 2FA screen click "Lost your device?" to email a disable link (needs SMTP). An admin can also clear/reset it from Settings → Users.
• Locked out (too many attempts) — the lockout is per-account + per-IP and clears after a short window; wait it out or have an admin reset the password.

──────── DATABASE, BACKUP & FAILOVER ────────
• Backups are empty / tiny (~20 bytes) — the pg_dump client major version must match the server (16). MCMF ships the matching client; if you self-host, install postgresql-client-16. Settings → Database → Backup now to re-test.
• Restore — gunzip < backup.sql.gz | psql (into the same Postgres major). Settings → Database lists backups.
• Stand up a failover server — Settings → Database → Replication & Failover → enter the standby VM IP → Generate setup guide; it produces a complete, pre-filled streaming-replication + app-stack runbook.

──────── PROVISIONING & APPROVALS ────────
• A deploy is stuck/failed — open the Provisioning request to see the failure phase and retry. Sensitive actions (and non-admin power actions) queue for approval — an admin approves under Approvals.

──────── REMOTE ACCESS / CONSOLE ────────
• Console / RDP / SSH won't open — the target needs to be reachable from MCMF on the relevant port (3389 RDP, 22 SSH) and have valid saved credentials in the vault (viewing a vault password requires a fresh 2FA code each time). For a private / NAT'd host MCMF can't route to, install the pure-outbound agent and the console tunnels through it instead (no inbound port) — see section 10.
• Console hangs at "Connecting…" on a host that has the agent (and RDP works from another PC) — the host is running the OLD push agent, which doesn't tunnel. Re-run the installer (Help → Agents) — it's a clean upgrade to the outbound, tunnel-capable agent; the badge in Command Center → Guest Agents flips to "⇡ outbound ✓" and the console connects through the tunnel.

──────── GENERAL ────────
• A page shows a 502 right after an update — the API was restarting; it clears in a few seconds (the proxy reloads automatically). Refresh.
• A number/value looks stale — every page auto-refreshes in the background (~15s) and on focus; you can also reload. Counts on stat tiles are clickable filters across Findings, Network exposure and the Zero-Trust workload dashboard.`,
  },
  {
    id: 'remove-from-topology',
    icon: '🗑',
    title: '14.1 Removing a VM from the topology',
    body: `The topology map and the VM/Inventory list are built from the same inventory records. Removing a VM deletes that record so it disappears from both. Admin only.

──────── HOW TO REMOVE ────────
1. Open Network Topology.
2. Click the VM node — its detail panel opens beside it.
3. Under "Inventory", click 🗑 Remove from topology and confirm.
The map refreshes within ~20s and the VM is gone from the topology and the Cloud Inventory list.

──────── WHY A REMOVED VM CAN COME BACK ────────
The record is genuinely deleted, but two things actively re-create hosts — so deleting alone isn't enough if either is still active:
• Cloud VMs (AWS / Azure / GCP) are re-discovered on every cloud scan. Removing one only hides it until the next scan. To remove it permanently, delete it in the cloud, OR disconnect that cloud account in Settings → Cloud Connections (which removes all of its resources).
• Host VMs (Linux / Windows / Docker) are re-registered by an installed MCMF agent each time it checks in (~every 30s). If the VM reappears after you remove it, an agent is still running on that machine. Stop it first: Command Center → open the agent → ⏻ Shut down (this uninstalls the agent and deletes its record), THEN remove the VM from the topology.
The remove confirmation tells you which case applies — if the agent is still online it says so, and the result banner stays amber ("…will re-register on its next check-in").

──────── ORPHANS (the common case) ────────
A host that was discovered once (e.g. a test box, or an old IP) but has no agent and no monitor is an orphan: 🗑 Remove from topology deletes it for good — it will not return. (Stale dev/test IPs left over from a clone are removed exactly this way.)`,
  },
  {
    id: 'open-api',
    icon: '🔌',
    title: '15. Open API — ITSM & monitoring tool integration',
    body: `A read-only REST API so 3rd-party tools — ITSM (ServiceNow, Jira Service Management) and monitoring (Datadog, Grafana, Zabbix, PRTG) — can pull every monitored entity and alert from MCMF. Base URL: https://<your-mcmf-host>/api/v1

──────── 1 · GET AN API KEY ────────
Settings → Integrations → API Keys → name it (e.g. "ServiceNow") → Generate key. The key (mcmf_…) is shown ONCE — copy it. Scopes: read (monitoring data) and alerts (incident feed). Revoke any time; tools using a revoked key stop immediately.

──────── 2 · AUTHENTICATE ────────
Send the key as a header on every request: x-api-key: mcmf_… (or ?api_key=… in the query). No login/JWT needed.
  curl -H "x-api-key: mcmf_xxx" https://<host>/api/v1/summary

──────── 3 · ENDPOINTS ────────
• GET /api/v1/monitors — every monitored entity: IP/Host monitors + network devices + guest agents. Filters: ?group=<scope>&kind=host|device|agent. Each row: name, kind, scope, status (up/down), uptimePct, latencyMs, jitterMs, bandwidthInMbps/OutMbps (devices), topInterface, cpuPct/memPct/diskPct (agents).
• GET /api/v1/devices — network devices only (firewall/router/switch) with bandwidth + uptime.
• GET /api/v1/agents — guest agents only (CPU/memory/disk + heartbeat).
• GET /api/v1/alerts — active alerts; the feed an ITSM turns into incidents/tickets (id, title, severity, source, resourceName, metric, value, raisedAt).
• GET /api/v1/summary — per-scope SLA rollup: totals (up/down) and, per scope, total/up/down/slaPct.

──────── 4 · WIRE IT UP ────────
• ServiceNow / Jira SM (incidents): poll GET /api/v1/alerts on a schedule (e.g. every 2 min); create an incident per new alert id; resolve it when the id drops off the feed. Map severity → priority.
• Datadog / Grafana / Zabbix (metrics & SLA): poll GET /api/v1/monitors (or /summary) and ingest uptimePct / latencyMs / jitterMs / bandwidth as custom metrics, tagged by scope + kind.
• Same data also exports from Reports → "Performance & Uptime" (CSV or scheduled email) if you prefer file-based exchange.

The matching report is REPORTS → New → "Performance & Uptime" — same fields, by scope/group.`,
  },
  {
    id: 'tls-green-lock',
    icon: '🔒',
    title: '16. TLS, Certificates & Domains — HTTPS + email (built-in)',
    body: `Everything is automated in Settings → TLS, Certificates & Domains. No SSH, no certbot. You add a domain once and MCMF handles the certificate AND email authentication for it; if anything fails, the current certificate stays and the site keeps working.

──────── WHAT YOU GET ────────
• HTTPS — a real, browser-trusted Let's Encrypt certificate for your domain (green padlock, no client import). Validated by DNS (DNS-01) so it works even behind NAT.
• Email — send MCMF mail AS your domain (notifications@yourco.com), DKIM-signed with SPF + DMARC aligned, so it isn't flagged as spoof/spam.

──────── STEPS (in MCMF) ────────
1. Settings → Domains → Add domain (e.g. yourco.com).
2. HTTPS → "① Get DNS TXT record" → MCMF shows a _acme-challenge TXT record → add it at your DNS host → "② Validate & install". Also add an A record (yourco.com → server public IP) so the site opens on the domain.
3. Email → "① Generate DKIM key + records" → MCMF shows three records (DKIM, SPF, DMARC) → add all three → "② Verify" → tick "Use this domain to send MCMF email".

──────── THE RECORDS (all are DNS "TXT", except the A record) ────────
• HTTPS validation: TXT  _acme-challenge.yourco.com  =  (the value MCMF shows)
• Web A record:     A    yourco.com (or @)            =  your server's public IP
• DKIM:             TXT  mcmf._domainkey.yourco.com   =  v=DKIM1; k=rsa; p=…
• SPF:              TXT  yourco.com (or @)            =  v=spf1 ip4:<server-ip> ~all
• DMARC:            TXT  _dmarc.yourco.com            =  v=DMARC1; p=none; rua=mailto:postmaster@yourco.com
NOTE on the "Name/Host" field: many registrars want it RELATIVE (without your domain) — e.g. enter "_acme-challenge" or "mcmf._domainkey" or "@" (for the root). MCMF shows the FULL name; drop the trailing ".yourco.com" if your host appends the domain automatically.

──────── HOW TO ADD A RECORD — PER PROVIDER ────────
GoDaddy:  My Products → Domain → DNS / Manage DNS → Records → Add → Type=TXT → Name=_acme-challenge (or @, mcmf._domainkey, _dmarc) → Value=(paste) → TTL=600s → Save. (For SPF on the root, GoDaddy may already have an @ TXT — edit it instead of adding a second.)

Microsoft 365 / Microsoft DNS:  admin.microsoft.com → Settings → Domains → select the domain → DNS records → Add record → Type=TXT → "TXT name"=_acme-challenge (use "@" for root) → "TXT value"=(paste) → TTL=1 hour → Save. (If your domain's DNS is hosted at GoDaddy/Cloudflare/etc., add it THERE instead — Microsoft only hosts DNS when the domain is delegated to Microsoft.)

Bigrock:  Login → My Orders → the domain → DNS Management / Manage DNS → TXT Records → Add TXT Record → Host Name=_acme-challenge (or blank/@ for root, mcmf._domainkey, _dmarc) → Value/Destination=(paste) → TTL=7200 → Add. Bigrock's host field is relative — do NOT include the domain.

Cloudflare:  Dashboard → the domain → DNS → Records → Add record → Type=TXT → Name=_acme-challenge (or @) → Content=(paste) → set Proxy status to "DNS only" (grey cloud) for the A record → Save. Cloudflare propagates in seconds.

AWS Route 53:  Hosted zones → your zone → Create record → Record name=_acme-challenge (Route 53 appends the zone) → Type=TXT → Value="(paste in quotes)" → TTL=300 → Create. For the A record, point it at the EIP/public IP.

Google (Cloud DNS / Squarespace-Google Domains):  the zone → Add standard record / Manage custom records → Type=TXT → Host/Name=_acme-challenge (or @) → Data/Value=(paste) → Save.

Namecheap:  Domain List → Manage → Advanced DNS → Add New Record → TXT Record → Host=_acme-challenge (or @, mcmf._domainkey, _dmarc) → Value=(paste) → TTL=Automatic → Save.

──────── TIPS ────────
• DNS can take a few minutes to propagate. Verify before clicking Validate:  dig TXT _acme-challenge.yourco.com   (Windows: nslookup -type=TXT _acme-challenge.yourco.com).
• If a value is long (DKIM/cert), paste it exactly — no spaces/line breaks added. Some UIs split long TXT into 255-char chunks automatically; that's fine.
• Only one SPF (v=spf1) TXT per domain — if one exists, merge MCMF's ip4: into it rather than adding a second.
• Let's Encrypt production allows ~5 certs/domain/week — use the "staging" toggle to dry-run first.

──────── ALTERNATIVES ────────
• Internal / no public domain: use the self-signed cert (Settings → TLS) and import it into Trusted Root on your machines (one-click Windows installer provided). • Behind a gateway (Azure App Gw, Cloudflare, F5): terminate TLS there with its managed cert and forward to MCMF.`,
  },
  {
    id: 'ssh-keys-console',
    icon: '🗝',
    title: '17. SSH keys for the browser console (GCP / AWS / Azure)',
    body: `Cloud VMs (GCP & AWS especially) are SSH KEY-only — a password is refused ("Password and keyboard-interactive authentication are not supported"). In the in-app console pick Authentication = Private key and paste the PRIVATE key; its PUBLIC half must be authorized on the VM. Here's how to get both — copy/paste the commands.

──────── A · QUICKEST: a key you already use ────────
• GCP via gcloud — your first 'gcloud compute ssh <user>@<vm>' already created the key and put its public half on the VM. Print the PRIVATE key to paste:
    cat ~/.ssh/google_compute_engine
• Any host you already SSH into with a key — print that private key:
    cat ~/.ssh/id_ed25519     # or ~/.ssh/id_rsa
Copy the whole block (from -----BEGIN to -----END-----) into the console's Private key field.

──────── B · GENERATE A NEW KEY + AUTHORIZE IT ────────
1) Make a key pair (your PC; press Enter for no passphrase, or set one):
    ssh-keygen -t ed25519 -f ~/.ssh/mcmf -C "<vm-username>"
2) Show the PUBLIC key — add this to the VM (see per-cloud below):
    cat ~/.ssh/mcmf.pub
3) Show the PRIVATE key — paste THIS into the MCMF console:
    cat ~/.ssh/mcmf

──────── ADD THE PUBLIC KEY TO THE VM ────────
• GCP: Console → Compute Engine → your VM → Edit → SSH Keys → "Add item" → paste ~/.ssh/mcmf.pub. (Project-wide: Compute Engine → Metadata → SSH Keys. OS Login: gcloud compute os-login ssh-keys add --key-file=~/.ssh/mcmf.pub.) The username shown before the key in the .pub must match the console username.
• AWS: you can't change a running instance's key pair — connect once (original key pair or EC2 Instance Connect) and append it:
    echo "$(cat ~/.ssh/mcmf.pub)" >> ~/.ssh/authorized_keys
• Azure: az vm user update -g <resource-group> -n <vm> --username <user> --ssh-key-value "$(cat ~/.ssh/mcmf.pub)"  (or Portal → VM → Reset password → SSH public key).

──────── THEN, IN MCMF ────────
Topology or Cloud Inventory → the VM → SSH (browser) → Authentication = Private key → Username = the VM login user (GCP/AWS/Azure default is pre-filled) → paste the PRIVATE key → optional passphrase → Connect. Tick "Save credentials" to seal it (AES-256-GCM) for next time.

Windows: the same commands work in PowerShell (ssh-keygen ships with Windows OpenSSH). Keys live in C:\\Users\\<you>\\.ssh\\ — print with:  type $env:USERPROFILE\\.ssh\\mcmf`,
  },
];
export type CapStatus = 'live' | 'planned';

export interface Capability {
  pillar: Pillar;
  status: CapStatus;
  what: string; // what this capability gives you in MCMF
  grant: string[]; // roles / managed policies to assign
  enable?: string[]; // APIs / services to turn on
  actions?: string[]; // granular permissions (for a custom/least-privilege policy)
  notes?: string[];
}

export interface IntegrationDoc {
  provider: Provider;
  title: string;
  summary: string;
  auth: string;
  credentials: { field: string; desc: string }[];
  setupSteps: string[];
  quickGrant: string; // one-line "grant everything read at once"
  capabilities: Capability[];
  network: string[];
}

export const INTEGRATION_DOCS: IntegrationDoc[] = [
  // ─────────────────────────────────────── AWS ───────────────────────────────────────
  {
    provider: 'aws',
    title: 'Amazon Web Services',
    summary: 'Connect an IAM user (access key) or role. The same identity drives manage, monitor, secure and cost — just attach the policies for the pillars you want.',
    auth: 'IAM access key (AKIA…) + secret, or temporary STS credentials. Attach the policies below to that IAM user. If the user has a permissions boundary, the boundary must also allow these actions.',
    credentials: [
      { field: 'Access Key ID', desc: 'IAM access key id (AKIA…).' },
      { field: 'Secret Access Key', desc: 'The matching secret.' },
      { field: 'Region', desc: 'Primary/default region, e.g. us-east-1 (discovery scans all regions automatically).' },
      { field: 'Endpoint URL', desc: 'Optional — override for LocalStack/GovCloud.' },
    ],
    setupSteps: [
      'IAM → Users → create a user (or role) for MCMF.',
      'Attach the policies for the pillars you want (see below).',
      'Security credentials → Create access key → "Application running outside AWS".',
      'MCMF → Connections → + Add Connection → AWS → paste key, secret, region → Save & Test.',
    ],
    quickGrant: 'Fast path: attach the managed policies ReadOnlyAccess + CloudWatchReadOnlyAccess + SecurityAuditReadOnly, then enable GuardDuty, Security Hub and Cost Explorer in the account.',
    capabilities: [
      {
        pillar: 'Manage',
        status: 'live',
        what: 'Discover EC2 instances, RDS databases and S3 buckets into Inventory/Management.',
        grant: ['AmazonEC2ReadOnlyAccess', 'AmazonRDSReadOnlyAccess', 'AmazonS3ReadOnlyAccess', '(or ReadOnlyAccess for all)'],
        actions: ['ec2:DescribeInstances', 'ec2:DescribeRegions', 'rds:DescribeDBInstances', 's3:ListAllMyBuckets', 's3:GetBucketLocation', 'sts:GetCallerIdentity'],
        notes: ['A permissions boundary on the user must also allow these (S3 was blocked by a boundary in your account — that is why it shows ⚠).'],
      },
      {
        pillar: 'Monitor',
        status: 'live',
        what: 'Live CPU / network / disk metrics per EC2 instance from CloudWatch (click a resource).',
        grant: ['CloudWatchReadOnlyAccess'],
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics'],
        notes: ['CPU/network/disk are available by default. Memory and guest disk-usage need the CloudWatch Agent installed on the instance.'],
      },
      {
        pillar: 'Secure',
        status: 'live',
        what: 'Vulnerabilities, misconfigurations and threats on the Security screen.',
        grant: ['AWSSecurityHubReadOnlyAccess', 'AmazonGuardDutyReadOnlyAccess', '(optional) AmazonInspector2ReadOnlyAccess'],
        enable: ['Security Hub', 'GuardDuty', '(optional) Inspector'],
        actions: ['securityhub:GetFindings', 'securityhub:DescribeHub', 'guardduty:ListDetectors', 'guardduty:ListFindings', 'guardduty:GetFindings', 'inspector2:ListFindings'],
        notes: ['Security Hub aggregates GuardDuty + Inspector + Config — enabling it gives the single richest findings source.'],
      },
      {
        pillar: 'Cost',
        status: 'live',
        what: 'Real spend by service/account on FinOps + Management cost views (auto-refreshed every 6h).',
        grant: ['ce:GetCostAndUsage — already in the MCMF grant script above; re-run it if cost shows 0.'],
        enable: ['Cost Explorer — Billing console → Cost Explorer → Enable (one-time, admin/root on the payer account).'],
        actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast', 'ce:GetDimensionValues'],
        notes: [
          'TWO steps for AWS cost: (1) enable Cost Explorer in the Billing console, (2) grant ce:GetCostAndUsage (in the grant script above).',
          'Cost Explorer data lags ~24h after enabling. Until then FinOps → Cost shows the connection as ⚠ and the reason.',
          'If a connection shows ⚠ "Cost/billing unavailable", the Test connection also fails its Cost/Billing stage — fix these two, then Test/Refresh.',
        ],
      },
      {
        pillar: 'Control',
        status: 'live',
        what: 'Start / stop / reboot instances and run remediation (WRITE access — only if you want actions).',
        grant: ['(custom policy — write)'],
        actions: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:RebootInstances'],
        notes: ['Grant only if you want MCMF to take actions. Read pillars never need this.'],
      },
    ],
    network: ['Outbound HTTPS (443) to the AWS service endpoints in each region.'],
  },

  // ────────────────────────────────────── Azure ──────────────────────────────────────
  {
    provider: 'azure',
    title: 'Microsoft Azure',
    summary: 'Connect an Entra ID app registration (service principal). Assign the roles below at the SUBSCRIPTION scope (Access control (IAM) → Add role assignment → select your app).',
    auth: 'App registration + client secret (client-credentials OAuth). All roles are assigned to the app at the subscription scope.',
    credentials: [
      { field: 'Tenant ID', desc: 'Directory (tenant) ID — GUID.' },
      { field: 'Client ID', desc: 'Application (client) ID — GUID.' },
      { field: 'Client Secret', desc: 'A client secret VALUE (not its ID).' },
      { field: 'Subscription ID', desc: 'The subscription to manage — GUID.' },
    ],
    setupSteps: [
      'Entra ID → App registrations → New registration ("MCMF Connector"). Copy Tenant ID + Client ID.',
      'Certificates & secrets → New client secret → copy the VALUE.',
      'Subscription → Access control (IAM) → Add role assignment → assign the roles below to the app.',
      'MCMF → Connections → + Add Connection → Azure → paste the four values → Save & Test.',
    ],
    quickGrant: 'Fast path: assign these built-in roles to the app on the subscription — Reader, Monitoring Reader, Security Reader, Cost Management Reader. Add Virtual Machine Contributor only if you want start/stop control.',
    capabilities: [
      {
        pillar: 'Manage',
        status: 'live',
        what: 'Discover the whole subscription (VMs, disks, storage, SQL, networks, AKS…).',
        grant: ['Reader (subscription scope)'],
        notes: ['One built-in Reader role covers all resource discovery via Azure Resource Manager.'],
      },
      {
        pillar: 'Monitor',
        status: 'live',
        what: 'Live VM CPU / network / disk (and memory when the agent is present) from Azure Monitor.',
        grant: ['Monitoring Reader (or Reader covers platform-metrics read)'],
        notes: ['VM CPU/network/disk are platform metrics — no agent needed. Memory %, guest disk-usage and per-process/service breakdown need the Azure Monitor Agent (VM Insights) on the VM.'],
      },
      {
        pillar: 'Secure',
        status: 'live',
        what: 'Defender for Cloud findings, recommendations, secure score and alerts on the Security screen.',
        grant: ['Security Reader'],
        enable: ['Microsoft Defender for Cloud (on the subscription)'],
        notes: ['Security Reader reads Microsoft.Security assessments, alerts and secure score. Defender plans drive the depth of findings.'],
      },
      {
        pillar: 'Cost',
        status: 'live',
        what: 'Real spend by resource/service feeding the cost views.',
        grant: ['Cost Management Reader'],
      },
      {
        pillar: 'Control',
        status: 'live',
        what: 'Start / deallocate / restart VMs (WRITE — only if you want actions).',
        grant: ['Virtual Machine Contributor (or a custom role with Microsoft.Compute/virtualMachines/start|deallocate|restart/action)'],
        notes: ['Grant only if you want MCMF to control VMs.'],
      },
    ],
    network: ['Outbound HTTPS (443) to login.microsoftonline.com and management.azure.com. Resource providers Microsoft.Insights and Microsoft.Security are usually auto-registered.'],
  },

  // ─────────────────────────────────────── GCP ───────────────────────────────────────
  {
    provider: 'gcp',
    title: 'Google Cloud Platform',
    summary: 'Connect a Service Account JSON key. Grant the roles below to that service account and enable the listed APIs. The SA may hold a single broad role (Viewer) or scoped roles per pillar.',
    auth: 'Service Account JSON key (recommended). MCMF signs a JWT with the key and mints read tokens automatically. Grant roles on the project; enable the APIs per pillar.',
    credentials: [
      { field: 'Service Account JSON Key', desc: 'Paste the whole downloaded key file (project id is read from it).' },
      { field: 'Project ID', desc: 'Optional — taken from the key if present.' },
      { field: 'OAuth Access Token', desc: 'Optional manual alternative to a key.' },
    ],
    setupSteps: [
      'IAM & Admin → Service Accounts → Create ("mcmf-connector").',
      'Grant the roles below (or roles/viewer to cover read across the board).',
      'Open the SA → Keys → Add key → Create new key → JSON → download.',
      'Enable the APIs listed per pillar (APIs & Services → Enable APIs).',
      'MCMF → Connections → + Add Connection → GCP → paste the whole JSON → Save & Test.',
    ],
    quickGrant: 'Fast path: grant roles/viewer + roles/monitoring.viewer + roles/securitycenter.findingsViewer + roles/billing.viewer, and enable the Compute Engine, Cloud Monitoring, Security Command Center and Cloud Billing APIs.',
    capabilities: [
      {
        pillar: 'Manage',
        status: 'live',
        what: 'Discover Compute Engine instances and Cloud Storage buckets.',
        grant: ['roles/viewer (broad)', 'or roles/compute.viewer + roles/storage.objectViewer'],
        enable: ['Compute Engine API (compute.googleapis.com)', '(optional) Cloud Resource Manager API'],
        notes: ['Your project authenticated fine; it just had 0 resources. Cloud Resource Manager API is optional (only a validation probe).'],
      },
      {
        pillar: 'Monitor',
        status: 'live',
        what: 'Live instance CPU / network from Cloud Monitoring (click a resource).',
        grant: ['roles/monitoring.viewer'],
        enable: ['Cloud Monitoring API (monitoring.googleapis.com)'],
      },
      {
        pillar: 'Secure',
        status: 'live',
        what: 'Security Command Center findings on the Security screen.',
        grant: ['roles/securitycenter.findingsViewer (org or project)'],
        enable: ['Security Command Center API (securitycenter.googleapis.com)'],
        notes: ['SCC is organisation-scoped and needs the Standard/Premium tier for findings.'],
      },
      {
        pillar: 'Cost',
        status: 'live',
        what: 'Real spend on FinOps + Management cost views (auto-refreshed every 6h).',
        grant: ['roles/bigquery.dataViewer + roles/bigquery.jobUser — already added to the MCMF GCP grant above.'],
        enable: ['BigQuery API + a BigQuery BILLING EXPORT (GCP has no live cost API).'],
        notes: [
          'THREE steps for GCP cost: (1) grant bigquery.dataViewer + jobUser (grant script above); (2) Billing → Billing export → BigQuery export (standard usage cost) to a dataset; (3) Connections → edit the GCP connection → set "BigQuery billing export table" = project.dataset.gcp_billing_export_v1_XXXXXX.',
          'Data appears a few hours after the export is enabled. Until then FinOps → Cost shows the connection as ⚠ and the reason.',
          'If a connection shows ⚠ "Cost/billing unavailable", the Test connection also fails its Cost/Billing stage — do the three steps, then Test/Refresh.',
        ],
      },
      {
        pillar: 'Control',
        status: 'live',
        what: 'Start / stop / reset instances (WRITE — only if you want actions).',
        grant: ['roles/compute.instanceAdmin.v1'],
        notes: ['Grant only if you want MCMF to control instances.'],
      },
      {
        pillar: 'Console SSH',
        status: 'live',
        what: 'Browser SSH via "☁ Cloud creds" (no key paste) — MCMF brokers a one-time key onto the instance metadata using this service account.',
        grant: ['roles/compute.instanceAdmin.v1', 'or a custom role with compute.instances.get + compute.instances.setMetadata'],
        notes: [
          'Read-only roles (roles/compute.viewer) can READ the VM but NOT write the key, so the broker fails with 403 "Required compute.instances.setMetadata permission".',
          'Check it fast:  gcloud compute instances add-metadata <VM> --zone <ZONE> --metadata foo=bar --impersonate-service-account <SA_EMAIL>  — if that 403s, the SA lacks setMetadata.',
          'Grant it:  gcloud projects add-iam-policy-binding <PROJECT> --member="serviceAccount:<SA_EMAIL>" --role="roles/compute.instanceAdmin.v1"',
          'OS Login VMs (metadata enable-oslogin=TRUE) ignore brokered metadata keys — the broker detects this and tells you to use Authentication = Private key instead (or grant roles/compute.osLogin and push the key via OS Login). See §17.',
        ],
      },
    ],
    network: ['Outbound HTTPS (443) to oauth2.googleapis.com and *.googleapis.com.'],
  },

  // ───────────────────────────── Docker / Linux / Windows ────────────────────────────
  {
    provider: 'docker',
    title: 'Docker Engine',
    summary: 'Lists containers from a Docker Engine. No cloud IAM — just access to the engine.',
    auth: 'Local unix socket or a TCP engine endpoint.',
    credentials: [
      { field: 'TCP host', desc: 'Optional — tcp://host:2375 for a remote engine. Blank = local socket.' },
      { field: 'Socket path', desc: 'Optional — defaults to /var/run/docker.sock.' },
    ],
    setupSteps: [
      'Local: mount /var/run/docker.sock into the MCMF API container.',
      'Remote: expose the Engine on tcp:// (TLS recommended) and use that host.',
      'MCMF → Connections → + Add Connection → Docker → Save & Test.',
    ],
    quickGrant: 'Just give MCMF read access to the Docker socket or a reachable Engine TCP endpoint.',
    capabilities: [
      { pillar: 'Manage', status: 'live', what: 'List containers as assets.', grant: ['Read access to the Docker socket / Engine API'] },
    ],
    network: ['Local socket, or TCP 2375/2376 to the remote engine.'],
  },
  {
    provider: 'linux',
    title: 'Linux Host (SSH)',
    summary: 'Agent-less host inventory + facts over SSH.',
    auth: 'SSH user with password or private key.',
    credentials: [
      { field: 'Host / IP', desc: 'Server address.' },
      { field: 'Port', desc: 'Optional — defaults to 22.' },
      { field: 'Username', desc: 'SSH user.' },
      { field: 'Password / Private Key', desc: 'One of the two.' },
    ],
    setupSteps: ['Ensure SSH is reachable from MCMF.', 'MCMF → Connections → + Add Connection → Linux → host + username + secret → Save & Test.'],
    quickGrant: 'A login that can run hostname, uname, nproc, free and read /etc/os-release.',
    capabilities: [
      { pillar: 'Manage', status: 'live', what: 'Register the host + gather CPU/mem facts and live load.', grant: ['SSH login with read commands'] },
    ],
    network: ['TCP 22 (or your SSH port) reachable from MCMF.'],
  },
  {
    provider: 'windows',
    title: 'Windows Host (OpenSSH)',
    summary: 'Inventory of a Windows host with the OpenSSH Server feature enabled.',
    auth: 'Windows account over SSH.',
    credentials: [
      { field: 'Host / IP', desc: 'Server address.' },
      { field: 'Port', desc: 'Optional — defaults to 22.' },
      { field: 'Username', desc: 'Local or domain account.' },
      { field: 'Password', desc: 'Account password.' },
    ],
    setupSteps: ['Add the "OpenSSH Server" optional feature and start sshd.', 'MCMF → Connections → + Add Connection → Windows → host + username + password → Save & Test.'],
    quickGrant: 'An account allowed to sign in over SSH.',
    capabilities: [
      { pillar: 'Manage', status: 'live', what: 'Register the host as an asset.', grant: ['SSH login'] },
    ],
    network: ['TCP 22 reachable; OpenSSH Server installed and running.'],
  },
];

// ─────────────────────────── Platform integrations (auth + notifications) ───────────────────────────
export interface PlatformIntegration {
  id: string;
  icon: string;
  title: string;
  summary: string;
  steps: string[];
  env?: { key: string; desc: string }[];
  notes?: string[];
}

export const PLATFORM_INTEGRATIONS: PlatformIntegration[] = [
  {
    id: 'sso-google',
    icon: '🔑',
    title: 'Single Sign-On — Google',
    summary: 'Let your team sign in with their Google Workspace / Gmail account. Activates automatically once credentials are set.',
    steps: [
      'Open Google Cloud Console → APIs & Services → OAuth consent screen. Choose "External", set App name "MCMF" and your support email, and add your email under Test users (or Publish).',
      'Go to APIs & Services → Credentials → Create credentials → OAuth client ID → Application type "Web application".',
      'Under "Authorized redirect URIs" add EXACTLY: https://localhost/api/auth/sso/google/callback',
      'Click Create, then copy the Client ID and Client secret.',
      'On the server edit ~/mcmf/.env and add: GOOGLE_CLIENT_ID=…  GOOGLE_CLIENT_SECRET=…  SSO_BASE_URL=https://localhost',
      'Redeploy: cd ~/mcmf && docker compose up --build -d  — a "Continue with Google" button now appears on the login page.',
    ],
    env: [
      { key: 'GOOGLE_CLIENT_ID', desc: 'OAuth client ID from Google Cloud Console.' },
      { key: 'GOOGLE_CLIENT_SECRET', desc: 'OAuth client secret.' },
      { key: 'SSO_BASE_URL', desc: 'Public HTTPS origin of the app, e.g. https://localhost.' },
      { key: 'SSO_AUTO_PROVISION', desc: 'Optional. 1 = auto-create unknown users as Viewer; 0 (default) = only pre-existing MCMF users may sign in.' },
    ],
    notes: [
      'The Google account email must match the user’s MCMF email. By default an admin must add the user first (Settings → Users).',
      'The redirect URI must match character-for-character, including https and the trailing path.',
    ],
  },
  {
    id: 'sso-microsoft',
    icon: '🪟',
    title: 'Single Sign-On — Microsoft (Entra ID)',
    summary: 'Sign in with Microsoft 365 / Azure AD (Entra ID) accounts.',
    steps: [
      'Azure Portal → Microsoft Entra ID → App registrations → New registration. Name it "MCMF".',
      'Choose the supported account types (single-tenant for your org, or multi-tenant). Under Redirect URI pick "Web" and enter: https://localhost/api/auth/sso/microsoft/callback',
      'Register, then copy the Application (client) ID and the Directory (tenant) ID.',
      'Go to Certificates & secrets → New client secret → copy the secret Value (not the Secret ID).',
      'API permissions should include Microsoft Graph → User.Read (delegated) — present by default.',
      'Server ~/mcmf/.env: MS_CLIENT_ID=…  MS_CLIENT_SECRET=…  MS_TENANT=<your tenant id, or "common" for multi-tenant>  SSO_BASE_URL=https://localhost',
      'Redeploy (docker compose up --build -d) — a "Continue with Microsoft" button appears.',
    ],
    env: [
      { key: 'MS_CLIENT_ID', desc: 'Application (client) ID from the Entra app registration.' },
      { key: 'MS_CLIENT_SECRET', desc: 'Client secret Value.' },
      { key: 'MS_TENANT', desc: 'Directory (tenant) ID, or "common" for any Microsoft account.' },
      { key: 'SSO_BASE_URL', desc: 'Public HTTPS origin of the app.' },
    ],
    notes: ['Same email-match / auto-provision rules as Google apply.'],
  },
  {
    id: 'mfa',
    icon: '🔐',
    title: 'Two-Factor Authentication (MFA / TOTP)',
    summary: 'Add a second factor with any authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator).',
    steps: [
      'Sign in → Settings → Two-Factor Authentication → Enable 2FA.',
      'Scan the QR code with your authenticator app, or type the shown secret key in manually.',
      'Enter the current 6-digit code and click "Verify & enable".',
      'IMPORTANT: copy and store the recovery codes shown — each one works once if you ever lose your device.',
      'From the next sign-in onward you’ll enter a 6-digit code after your password. Lost your phone? Use a recovery code in the same field.',
    ],
    notes: [
      'It’s per-user and self-service — every user enables it on their own account.',
      'To turn it off: Settings → Two-Factor Authentication → Disable (requires a current code).',
      'No server config needed — 2FA works out of the box.',
    ],
  },
  {
    id: 'email',
    icon: '✉️',
    title: 'Email (SMTP)',
    summary: 'Outbound email for alert notifications, scheduled reports, and password-reset links.',
    steps: [
      'Get SMTP credentials from your mail provider (Gmail App Password, SendGrid, Amazon SES SMTP, Microsoft 365, etc.).',
      'Server ~/mcmf/.env: SMTP_HOST=…  SMTP_PORT=587  SMTP_USER=…  SMTP_PASS=…  SMTP_FROM="MCMF <alerts@yourco.com>"',
      'Redeploy (docker compose up -d).',
      'Add an Email channel: Security → Notification Channels → type Email, target = recipient address. Scheduled reports: set recipients on the report.',
    ],
    env: [
      { key: 'SMTP_HOST', desc: 'SMTP server hostname.' },
      { key: 'SMTP_PORT', desc: '587 (STARTTLS) or 465 (SSL).' },
      { key: 'SMTP_USER / SMTP_PASS', desc: 'SMTP username and password / app password.' },
      { key: 'SMTP_FROM', desc: 'From address shown to recipients.' },
    ],
    notes: ['Without SMTP, password-reset links are written to the API server log (docker logs mcmf-std-api) and emails are skipped.'],
  },
  {
    id: 'whatsapp',
    icon: '💬',
    title: 'WhatsApp (Meta Cloud API)',
    summary: 'Send alert notifications to WhatsApp numbers via the official Meta WhatsApp Cloud API.',
    steps: [
      'At developers.facebook.com create an app (type "Business") and add the "WhatsApp" product.',
      'In WhatsApp → API Setup, note the Phone number ID and generate an access token (use a System User permanent token for production).',
      'Add recipient numbers under API Setup (test numbers must be added; production needs a verified business number).',
      'Server ~/mcmf/.env: WHATSAPP_TOKEN=…  WHATSAPP_PHONE_ID=…',
      'Redeploy (docker compose up -d).',
      'Add a WhatsApp channel: Security → Notification Channels → type WhatsApp, target = recipient phone in digits, E.164 without "+", e.g. 919876543210.',
    ],
    env: [
      { key: 'WHATSAPP_TOKEN', desc: 'Meta WhatsApp Cloud API access token.' },
      { key: 'WHATSAPP_PHONE_ID', desc: 'The sender Phone number ID from API Setup.' },
    ],
    notes: [
      'Meta only allows free-form text within 24h of the recipient last messaging your number; outside that window you must use approved message templates.',
      'For internal alerting, have the recipient message your business number once to open the 24h window.',
      'Error #131030 "Recipient phone number not in allowed list" = your app is still in test/development mode. Fix: WhatsApp → API Setup → "To" → Manage phone number list → Add the recipient (up to 5), then verify the code WhatsApp sends to that number. To message anyone, take the app Live with a verified business number.',
      'Error #131026 / #131047 = outside the 24h window — switch to an approved template. Error #190 / HTTP 401 = the access token expired; regenerate a permanent System User token.',
    ],
  },
  {
    id: 'slack',
    icon: '💬',
    title: 'Slack — Incoming Webhook',
    summary: 'Post alert notifications into a Slack channel. No server config — just paste a webhook URL into a notification channel.',
    steps: [
      'Go to api.slack.com/apps → Create New App → "From scratch" → name it "MCMF" and pick your workspace.',
      'In the app, open "Incoming Webhooks" → toggle Activate ON → "Add New Webhook to Workspace" → choose the channel to post into → Allow.',
      'Copy the Webhook URL (looks like https://hooks.slack.com/services/T…/B…/…).',
      'MCMF → Security & Alerting → Automation & Escalation → Notification Channels → + New → Type "Slack", paste the webhook URL as the target → Add channel.',
      'Click Test on the channel to confirm a message lands in Slack. Workflows with the "Notify" action then deliver here.',
    ],
    notes: [
      'The webhook is bound to one channel; create one webhook per channel you want to post to.',
      'Keep the webhook URL secret — anyone with it can post to that channel.',
    ],
  },
  {
    id: 'pagerduty',
    icon: '📟',
    title: 'PagerDuty — Events API v2',
    summary: 'Raise PagerDuty incidents from MCMF alerts using an Events API v2 integration (routing) key.',
    steps: [
      'In PagerDuty: Services → your service (or create one) → Integrations → Add integration → choose "Events API v2".',
      'Copy the Integration Key (a.k.a. Routing Key) it generates.',
      'MCMF → Security & Alerting → Automation & Escalation → Notification Channels → + New → Type "PagerDuty", paste the routing key as the target → Add channel.',
      'Click Test — a test event should appear on the PagerDuty service. Alerts routed via a "Notify" workflow then open/trigger incidents.',
    ],
    notes: [
      'Use one Events API v2 integration per MCMF→service mapping; the key determines which service the incident lands on.',
      'Critical-severity alerts map to PagerDuty "trigger" events; resolve actions can auto-resolve where supported.',
    ],
  },
  {
    id: 'webhook',
    icon: '🔗',
    title: 'Generic Webhook (custom integrations)',
    summary: 'Send alerts to any HTTPS endpoint as a JSON POST — wire MCMF into Teams, Discord, an internal API, a SIEM, or an automation tool.',
    steps: [
      'Stand up (or obtain) an HTTPS URL that accepts a POST with a JSON body — e.g. a Microsoft Teams / Discord incoming webhook, an n8n/Zapier catch hook, or your own service.',
      'MCMF → Security & Alerting → Automation & Escalation → Notification Channels → + New → Type "Webhook", paste the URL as the target → Add channel.',
      'Click Test to send a sample payload and confirm your endpoint receives it.',
      'Alternatively use Automation Workflows → action "Webhook" to POST on a specific trigger (severity / metric) rather than to all channels.',
    ],
    notes: [
      'MCMF POSTs a JSON body describing the alert (title, severity, resource, metric/value). Map those fields on your receiving end.',
      'Endpoint must be reachable from the MCMF server and should respond 2xx; non-2xx is logged as a delivery failure under Settings → Integrations → Delivery log.',
    ],
  },
  {
    id: 'ai-assistant',
    icon: '✨',
    title: 'AI Assistant & RCA — Free · Claude · ChatGPT · Gemini',
    summary: 'Powers the Command Center assistant and AI root-cause analysis. Choose your LLM: a built-in Free mode (no key, no cost), or bring your own Claude / ChatGPT / Gemini key.',
    steps: [
      'Pick a provider in Settings → Integrations → AI Assistant → AI Provider: free | anthropic | openai | gemini (leave blank to auto-detect by whichever key you set).',
      'FREE (default): no key needed — a built-in assistant answers MCMF "how do I…" questions and RCA uses rule-based correlation. Zero cost, works offline.',
      'CLAUDE: console.anthropic.com → API Keys (sk-ant-…) → paste into Anthropic API Key.',
      'CHATGPT: platform.openai.com → API keys (sk-…) → paste into OpenAI API Key.',
      'GEMINI: aistudio.google.com → Get API key (AIza…) → paste into Gemini API Key. Google offers a free tier.',
      'Optionally set Model (blank = provider default), then Save. Keys are sealed (AES-256-GCM) and never shown back.',
      'Use it: Command Center → AI Assistant; and Root-Cause Analysis on an active incident.',
    ],
    env: [
      { key: 'AI_PROVIDER', desc: 'free | anthropic | openai | gemini (blank = auto by key).' },
      { key: 'ANTHROPIC_API_KEY', desc: 'Claude key — default model claude-sonnet-4-6.' },
      { key: 'OPENAI_API_KEY', desc: 'ChatGPT key — default model gpt-4o-mini.' },
      { key: 'GEMINI_API_KEY', desc: 'Gemini key — default model gemini-1.5-flash (free tier available).' },
      { key: 'AI_MODEL', desc: 'Optional override of the provider’s default model.' },
    ],
    notes: [
      'Grounding (not fine-tuning): MCMF feeds the chosen LLM a system prompt describing its features + a live snapshot of your state (resources/alerts/incidents/connections/agents). RCA additionally feeds correlated SIEM events, platform events and hot resources around the incident.',
      'Free mode is always available and never fails; if a configured cloud provider errors, MCMF automatically falls back to the Free built-in answer so you’re never blocked.',
      'Cost: Free mode = $0. Claude/ChatGPT bill per token; Gemini has a free tier then bills. Switch providers any time without redeploying.',
      'Data note: with a cloud provider, your question + live-state summary (and RCA evidence) are sent to that provider’s API. Free mode sends nothing externally. Don’t paste secrets into the assistant.',
    ],
  },
  {
    id: 'notify-audit',
    icon: '🧾',
    title: 'Notification audit, retry & retention (compliance)',
    summary: 'Every notification MCMF sends — alerts, escalations, approvals, reports — is recorded in the Notification Delivery Log with full retry and retention controls.',
    steps: [
      'View: Settings → Integrations → Notification Delivery Log (or the Security → Automation area). Every attempt is logged: channel, recipient, status (sent / failed / gave up), exact error, attempt count and next-retry time.',
      'Auto-retry (all channels): a failed send retries 3× every 3 minutes, then hourly, and stops after 3 days (status "gave up").',
      'Manual controls per row: ↻ Retry re-sends immediately; ✕ Delete removes the entry.',
      'Retention: records are kept for a configurable window (default 3 months) for compliance, then auto-purged. Change it in the log header — presets 30 days / 3 months / 6 months / 1 year / 2 years, or a custom value (7 days–10 years).',
    ],
    notes: [
      'Both successful and failed deliveries are retained for the full window — a complete audit trail of who was notified, when, and over which channel.',
      'Retries reuse the original saved message, so a re-sent notification is byte-identical to the first attempt.',
      'Approval requests notify every active admin over BOTH email and WhatsApp (best-effort, each independent); those sends appear in this log too.',
    ],
  },
];

// ─────────────────────── Email (SMTP) provider recipes ───────────────────────
// Per-provider, copy-paste SMTP settings for Settings → Integrations → Email.
export const SMTP_PROVIDERS: PlatformIntegration[] = [
  {
    id: 'smtp-howitworks',
    icon: '✉️',
    title: 'How MCMF sends email — built-in default vs external relay',
    summary: 'MCMF works out of the box with a built-in sender, and automatically switches to an external SMTP the moment you add one. No code, no restart.',
    steps: [
      'DEFAULT (built-in): with no external SMTP configured, MCMF sends as its own mail client from no-reply@mcmf.edu — delivering straight to each recipient’s mail server. Nothing to set up.',
      'ADD AN EXTERNAL SMTP: enter an SMTP Host in Settings → Integrations → Email (using one of the provider recipes below). The moment a host is saved, the built-in sender turns OFF and every email goes through your relay.',
      'REMOVE THE EXTERNAL SMTP: clear the SMTP Host (or Settings → Integrations → Email → Remove). MCMF automatically falls back to the built-in sender again.',
      'TEST ANY TIME: Settings → Integrations → Email → Test sends a real message through whichever sender is currently active and reports success or the exact error.',
    ],
    notes: [
      'Deliverability note: the built-in sender needs OUTBOUND PORT 25 open from the MCMF server. Many cloud/ISP networks block port 25, and mail sent from an un-authenticated IP (no SPF/DKIM for mcmf.edu) often lands in spam. For reliable delivery to Gmail/Outlook/etc., configure an external relay below — it sends over port 587 with proper authentication.',
      'Who uses this: alert notifications, escalation policies, scheduled reports, and password / 2FA reset emails all use whichever sender is active.',
      'Override the built-in default sender by setting SMTP_FROM (e.g. a different domain), or the whole domain via MCMF_MAIL_DOMAIN in .env.',
    ],
  },
  {
    id: 'smtp-gmail',
    icon: '📧',
    title: 'Gmail / Google Workspace — App Password',
    summary: 'Send through a Gmail or Google Workspace mailbox using a 16-character App Password (Google blocks plain passwords for SMTP).',
    steps: [
      'The Google account MUST have 2-Step Verification turned on (myaccount.google.com → Security → 2-Step Verification).',
      'Go to myaccount.google.com/apppasswords → create an App Password named “MCMF”. Copy the 16-character code (remove the spaces).',
      'MCMF → Settings → Integrations → Email (SMTP) → Edit, and enter the values below.',
      'Click “Save & send test” to confirm delivery.',
    ],
    env: [
      { key: 'SMTP_HOST', desc: 'smtp.gmail.com' },
      { key: 'SMTP_PORT', desc: '587 (STARTTLS) — or 465 for SSL.' },
      { key: 'SMTP_USER', desc: 'Your full address, e.g. you@gmail.com / you@yourdomain.com.' },
      { key: 'SMTP_PASS', desc: 'The 16-character App Password (NOT your normal password).' },
      { key: 'SMTP_FROM', desc: 'Same mailbox, e.g. "MCMF Alerts <you@yourdomain.com>".' },
    ],
    notes: [
      'Google Workspace admins can restrict App Passwords — if the option is missing, an admin must allow it (Admin console → Security).',
      'Daily sending limits apply (~500 Gmail / ~2,000 Workspace). For higher volume use SendGrid or SES.',
    ],
  },
  {
    id: 'smtp-m365',
    icon: '🏢',
    title: 'Microsoft 365 / Outlook',
    summary: 'Send through a Microsoft 365 mailbox via authenticated client SMTP submission (smtp.office365.com).',
    steps: [
      'Enable SMTP AUTH for the mailbox: Microsoft 365 admin center → Users → the user → Mail → Manage email apps → tick “Authenticated SMTP”. (Or via PowerShell: Set-CASMailbox -Identity user@dom -SmtpClientAuthenticationDisabled $false.)',
      'If the tenant enforces MFA / Security Defaults, basic SMTP auth is blocked — create an App Password (account → Security info) and use it as SMTP_PASS, or use a dedicated mailbox excluded from MFA.',
      'MCMF → Settings → Integrations → Email (SMTP) → Edit → enter the values below → Save & send test.',
    ],
    env: [
      { key: 'SMTP_HOST', desc: 'smtp.office365.com' },
      { key: 'SMTP_PORT', desc: '587 (STARTTLS).' },
      { key: 'SMTP_USER', desc: 'The mailbox UPN, e.g. alerts@yourco.com.' },
      { key: 'SMTP_PASS', desc: 'Mailbox password, or an App Password when MFA is on.' },
      { key: 'SMTP_FROM', desc: 'Must be the authenticated mailbox or a permitted alias.' },
    ],
    notes: [
      'Microsoft is retiring Basic Auth for client SMTP submission on some tenants — if it fails, confirm SMTP AUTH is enabled and consider a high-volume option (Azure Communication Services, SendGrid, SES).',
      'The From address must match the signed-in mailbox or send will be rejected.',
    ],
  },
  {
    id: 'smtp-sendgrid',
    icon: '🟦',
    title: 'Twilio SendGrid',
    summary: 'Transactional email via SendGrid SMTP relay — the username is literally “apikey”.',
    steps: [
      'Create an API key: SendGrid → Settings → API Keys → Create API Key → “Restricted Access” with the Mail Send permission. Copy it (shown once).',
      'Verify a sender: Settings → Sender Authentication → verify a Single Sender, or authenticate your domain (recommended).',
      'MCMF → Settings → Integrations → Email (SMTP) → Edit → enter the values below → Save & send test.',
    ],
    env: [
      { key: 'SMTP_HOST', desc: 'smtp.sendgrid.net' },
      { key: 'SMTP_PORT', desc: '587 (STARTTLS) — also 465 (SSL) or 2525.' },
      { key: 'SMTP_USER', desc: 'The literal word: apikey' },
      { key: 'SMTP_PASS', desc: 'Your SendGrid API key (starts with SG.…).' },
      { key: 'SMTP_FROM', desc: 'A verified sender / domain, e.g. alerts@yourco.com.' },
    ],
    notes: ['The From address must be a verified Single Sender or on an authenticated domain, otherwise SendGrid rejects the message.'],
  },
  {
    id: 'smtp-ses',
    icon: '🟧',
    title: 'Amazon SES (SMTP)',
    summary: 'Amazon SES SMTP interface. SES SMTP credentials are NOT your AWS access keys — generate them in the SES console.',
    steps: [
      'SES console → SMTP settings → “Create SMTP credentials” (this makes a dedicated IAM user and shows an SMTP username + password — download them, shown once).',
      'Verify a sender: SES → Verified identities → verify your domain or a from-address.',
      'Note your region’s SMTP endpoint (shown on the SMTP settings page).',
      'MCMF → Settings → Integrations → Email (SMTP) → Edit → enter the values below → Save & send test.',
    ],
    env: [
      { key: 'SMTP_HOST', desc: 'email-smtp.<region>.amazonaws.com, e.g. email-smtp.us-east-1.amazonaws.com.' },
      { key: 'SMTP_PORT', desc: '587 (STARTTLS) — also 465 (SSL) or 2587/2465.' },
      { key: 'SMTP_USER', desc: 'The SES SMTP username (NOT your AKIA access key).' },
      { key: 'SMTP_PASS', desc: 'The SES SMTP password from the same dialog.' },
      { key: 'SMTP_FROM', desc: 'A verified SES identity (domain or address).' },
    ],
    notes: [
      'New SES accounts are in the sandbox — you can only send to verified recipients until you request production access (SES → Account dashboard).',
      'Use the SMTP endpoint for the SAME region where your identities are verified.',
    ],
  },
  {
    id: 'smtp-other',
    icon: '✉️',
    title: 'Mailgun, Postmark, Zoho & other SMTP',
    summary: 'Any standards-compliant SMTP relay works — host, port, username, password.',
    steps: [
      'Get SMTP credentials from your provider’s dashboard (often under “SMTP”, “Sending”, or “Integrations”).',
      'Typical hosts: Mailgun smtp.mailgun.org · Postmark smtp.postmarkapp.com · Zoho smtp.zoho.com · Brevo smtp-relay.brevo.com.',
      'Use port 587 (STARTTLS) in almost all cases; 465 for implicit SSL.',
      'MCMF → Settings → Integrations → Email (SMTP) → Edit → enter host/port/user/pass + a verified From → Save & send test.',
    ],
    notes: ['Most providers require you to verify your sending domain or from-address before they will deliver.'],
  },
];

// ─────────────── Remote provisioning & network configuration ───────────────
// Write permissions needed for MCMF to create VMs / networks / disks / VPNs.
export const PROVISIONING_DOCS: PlatformIntegration[] = [
  {
    id: 'provision-overview',
    icon: '🏗️',
    title: 'How provisioning & remote configuration works',
    summary: 'Topology → “Provision Resource” (and Site-to-Site VPN) raise a governed request. An admin approves it in Approvals, then it is deployed. Below are the exact write permissions per cloud.',
    steps: [
      'Open Topology → + Provision Resource → pick VM / Network / Disk, choose the cloud, fill the fields, tick “I accept”, and Request provisioning.',
      'For a VPN: Topology → Site-to-Site VPN panel → Request VPN on the cloud pair.',
      'The request appears under Approvals. An admin approves (or rejects) it — read pillars are never enough; the connector needs the WRITE permissions listed in the cloud cards below.',
      'Live execution is OFF by default for safety (it creates billed infrastructure). Enable it per cloud on the server with PROVISION_EXEC, then approving a request deploys it for real.',
    ],
    env: [
      { key: 'PROVISION_EXEC', desc: 'Comma list of clouds allowed to execute live provisioning, e.g. "azure,aws,gcp" or "all". Empty (default) = governance only: approval returns the deployment plan + required permissions instead of creating resources.' },
    ],
    notes: [
      'Until PROVISION_EXEC enables a cloud, approving a provisioning request authorizes it and records the exact resource + permissions, but does not create billed infrastructure — apply it via the console/IaC, or enable execution.',
      'The connection used for that cloud (Settings → Connections) must hold a credential with the write permissions below, in addition to the read roles you already granted.',
    ],
  },
  {
    id: 'provision-aws',
    icon: '🟧',
    title: 'AWS — provisioning permissions',
    summary: 'Attach these to the IAM user/role on the AWS connection (in addition to the read policies). Grant only what you intend to create.',
    steps: [
      'Network (VPC): ec2:CreateVpc, ec2:CreateSubnet, ec2:CreateRouteTable, ec2:CreateInternetGateway, ec2:AssociateRouteTable.',
      'Virtual machine (EC2): ec2:RunInstances, ec2:CreateTags, and iam:PassRole if you attach an instance profile.',
      'Disk (EBS): ec2:CreateVolume, ec2:AttachVolume.',
      'Site-to-site VPN: ec2:CreateVpnGateway, ec2:CreateCustomerGateway, ec2:CreateVpnConnection, ec2:AttachVpnGateway.',
    ],
    env: [
      { key: 'Managed policy (broad)', desc: 'AmazonVPCFullAccess + AmazonEC2FullAccess cover all of the above — or craft a least-privilege policy from the actions listed.' },
    ],
    notes: [
      'LIVE: AWS network creation is implemented — with PROVISION_EXEC including "aws" and the IAM user allowed ec2:CreateVpc/CreateSubnet/CreateTags, approving a Network request creates a real VPC + subnet.',
      'A permissions boundary on the IAM user must also allow these write actions.',
    ],
  },
  {
    id: 'provision-azure',
    icon: '🔷',
    title: 'Azure — provisioning permissions',
    summary: 'Assign these built-in roles to the app registration at the subscription (or resource-group) scope, on top of Reader.',
    steps: [
      'Network (VNet/subnet): Network Contributor (Microsoft.Network/virtualNetworks/write, …/subnets/write).',
      'Virtual machine: Virtual Machine Contributor (Microsoft.Compute/virtualMachines/write) — plus Network Contributor for its NIC/IP.',
      'Disk: Disk Contributor (Microsoft.Compute/disks/write).',
      'Site-to-site VPN: Network Contributor (virtualNetworkGateways/write, connections/write, localNetworkGateways/write).',
    ],
    env: [
      { key: 'Scope', desc: 'Assign at the subscription scope for fleet-wide provisioning, or a single resource group to limit blast radius.' },
    ],
    notes: [
      'LIVE: Azure network creation is implemented — with PROVISION_EXEC=azure set and the app registration granted Network Contributor, approving a Network request creates a real VNet (+ default subnet) in resource group "mcmf-provisioned". An empty VNet/subnet has no charge.',
      'With only Reader, approving returns Azure’s real 403 AuthorizationFailed — grant Network Contributor to enable creation. VMs, managed disks, public IPs and VPN gateways are billed.',
    ],
  },
  {
    id: 'provision-gcp',
    icon: '🟦',
    title: 'GCP — provisioning permissions',
    summary: 'Grant these roles to the service account on the project, in addition to roles/viewer.',
    steps: [
      'Network (VPC/subnet): roles/compute.networkAdmin (compute.networks.create, compute.subnetworks.create).',
      'Virtual machine: roles/compute.instanceAdmin.v1 (compute.instances.create) — plus roles/iam.serviceAccountUser if the VM runs as a service account.',
      'Disk: roles/compute.storageAdmin (compute.disks.create).',
      'Site-to-site VPN: roles/compute.networkAdmin (compute.vpnGateways.create, compute.vpnTunnels.create, compute.routers.create for BGP).',
      'Ensure the Compute Engine API is enabled on the project.',
    ],
    notes: [
      'LIVE: GCP network creation is implemented — with PROVISION_EXEC including "gcp" and the service account granted roles/compute.networkAdmin (Compute Engine API enabled), approving a Network request creates a real auto-mode VPC.',
      'Cloud VPN, external IPs, instances and persistent disks are billed resources.',
    ],
  },
  {
    id: 'provision-vpn',
    icon: '🔐',
    title: 'Site-to-Site VPN / IPsec — what gets deployed',
    summary: 'A cross-cloud VPN needs a coordinated gateway + tunnel on BOTH ends — it cannot be done from one side alone.',
    steps: [
      'On each cloud: create a VPN gateway (Azure VirtualNetworkGateway / AWS VPN Gateway / GCP Cloud VPN) and note its public IP.',
      'Create the peer/customer gateway on each side pointing at the OTHER cloud’s gateway public IP.',
      'Create the IPsec connection/tunnel on both sides with a MATCHING pre-shared key and IKE/IPsec parameters.',
      'Add routes (or BGP with matching ASNs) so each VNet/VPC knows the remote CIDR via the tunnel.',
      'MCMF detects the gateways on the next network scan and shows the pair as ● deployed in the Topology VPN panel.',
    ],
    notes: [
      'Pre-shared keys and tunnel parameters (IKE version, DH group, lifetimes) MUST match on both ends or the tunnel stays down.',
      'VPN gateways are billed hourly on every cloud — budget before deploying.',
      'This is why an approved VPN request shows the deployment plan + permissions: the two ends must be configured together with a shared secret.',
    ],
  },
];

// ─────────────── Data center platforms + monitoring protocols ───────────────
// Reuses the PlatformIntegration shape so the Help UI can render it the same way.
export const INFRA_DOCS: PlatformIntegration[] = [
  {
    id: 'vmware',
    icon: '🖥️',
    title: 'VMware vSphere / ESXi',
    summary: 'Inventory and monitor VMware virtual machines and hosts via the vCenter / ESXi REST API. Reachability of vCenter, ESXi management and guests can also be watched from IP / Host Monitor.',
    steps: [
      'In vCenter, create a read-only service account (or a role with System.Read, VirtualMachine.* read) for MCMF.',
      'Confirm the vCenter REST API is reachable on https://<vcenter>/api (port 443).',
      'For live reachability now: IP / Host Monitor → + Add → choose HTTPS/TLS for vCenter (443), and add each ESXi host / guest as Ping or its service port (SSH 22, RDP 3389).',
      'For deep inventory (VM list, CPU/mem, power state): a vSphere connector is on the roadmap — the credentials above are what it will use.',
    ],
    env: [
      { key: 'vCenter URL', desc: 'https://<vcenter-fqdn> — REST API base.' },
      { key: 'Username / Password', desc: 'Read-only vSphere account (user@vsphere.local or AD).' },
    ],
    notes: [
      'vSphere uses session-based auth (POST /api/session returns a token used as vmware-api-session-id).',
      'ESXi hosts also expose Redfish on the BMC — add those under the Redfish protocol to watch hardware health.',
    ],
  },
  {
    id: 'nutanix',
    icon: '🧱',
    title: 'Nutanix Prism (AHV)',
    summary: 'Inventory and monitor Nutanix clusters and VMs via the Prism Central / Prism Element v3 REST API.',
    steps: [
      'In Prism, create a read-only (Viewer) local user, or use a service account.',
      'Confirm the Prism API is reachable: https://<prism>:9440/api/nutanix/v3 (port 9440).',
      'For live reachability now: IP / Host Monitor → + Add → HTTPS/TLS to Prism on port 9440, and add CVMs / AHV hosts (SSH 22) and guest VMs.',
      'For deep inventory (VM/cluster list, CPU/mem, power state): a Nutanix connector is on the roadmap and will use the credentials below.',
    ],
    env: [
      { key: 'Prism URL', desc: 'https://<prism-central-or-element>:9440' },
      { key: 'Username / Password', desc: 'Prism Viewer (read-only) account.' },
    ],
    notes: ['Prism v3 uses HTTP Basic auth over TLS. The API listens on 9440, not 443.'],
  },
  {
    id: 'redfish',
    icon: '🔧',
    title: 'Redfish (BMC — iDRAC / iLO / XCC)',
    summary: 'Watch server out-of-band controllers (Dell iDRAC, HPE iLO, Lenovo XCC, Supermicro) which expose the DMTF Redfish REST API over HTTPS.',
    steps: [
      'Make sure the BMC management IP is reachable from the MCMF server.',
      'IP / Host Monitor → + Add → protocol Redfish (BMC / iDRAC / iLO). Target = the BMC IP/host (port 443 is filled automatically).',
      'A 200/401/403 from /redfish/v1 means the controller is alive (MCMF treats auth-required responses as “up”).',
    ],
    notes: [
      'Redfish is an HTTPS check — it confirms the BMC is reachable and serving its API, not the host OS.',
      'For hardware health/inventory pulled from Redfish (fans, PSUs, thermal), a Redfish connector is on the roadmap.',
    ],
  },
  {
    id: 'snmp',
    icon: '📡',
    title: 'SNMP (network devices)',
    summary: 'Reachability of switches, routers, firewalls, UPS and printers via an SNMP v2c probe (GetRequest for sysUpTime).',
    steps: [
      'Enable SNMP on the device and allow the MCMF server’s IP. Note the read community string.',
      'IP / Host Monitor → + Add → protocol SNMP. Target = device IP (UDP port 161 is filled automatically).',
      'A valid SNMP reply marks the device up and records response latency.',
    ],
    notes: [
      'This build uses SNMP v2c with the default community “public”. If your devices use a different community or v3, tell us and we’ll add a community/credentials field.',
      'SNMP is UDP — firewalls must permit UDP/161 from the MCMF server to the device.',
    ],
  },
  {
    id: 'telnet',
    icon: '⌨️',
    title: 'Telnet',
    summary: 'TCP reachability of a Telnet service (legacy network gear, console servers).',
    steps: [
      'IP / Host Monitor → + Add → protocol Telnet. Target = host (TCP port 23 is filled automatically).',
      'A successful TCP connect marks it up and records latency.',
    ],
    notes: ['Telnet is unencrypted; prefer SSH where possible. This monitor only checks reachability, it does not log in.'],
  },
  {
    id: 'ssh-rdp',
    icon: '🔌',
    title: 'SSH & RDP (remote access)',
    summary: 'Watch that remote-access services are listening — SSH (Linux/network/ESXi) and RDP (Windows Remote Desktop).',
    steps: [
      'IP / Host Monitor → + Add → protocol SSH (port 22) or RDP (port 3389) — the port is filled automatically, so you no longer have to remember it.',
      'Target = the host IP/name. A TCP connect to the port marks the service up with its latency.',
      'Override the port only if you run SSH/RDP on a non-standard port.',
    ],
    notes: [
      'These are TCP reachability checks from the MCMF server — the server must be able to reach the host:port (firewall/VPN permitting).',
      'If SSH/RDP shows “down” but the host is up, check that a firewall/NSG isn’t blocking the MCMF server, and that you used the right port.',
    ],
  },
  {
    id: 'icmp-tcp-http',
    icon: '🌐',
    title: 'Ping · TCP · HTTP(S)',
    summary: 'The core link checks — ICMP ping for raw reachability, TCP for any port, and HTTP(S) for web endpoints (status < 500 = up).',
    steps: [
      'Ping (ICMP): Target = IP/host. Best for raw up/down where ICMP is allowed.',
      'TCP port: Target = host, then enter any port to check a custom service.',
      'HTTP(S): Target = a URL or host; MCMF treats any response under HTTP 500 as healthy.',
    ],
    notes: ['Many networks block ICMP — if ping shows down but the host is up, use a TCP or HTTP check instead.'],
  },
];
