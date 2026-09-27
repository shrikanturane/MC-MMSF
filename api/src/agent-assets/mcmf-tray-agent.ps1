# =====================================================================================
#  MCMF Endpoint Agent (Windows) — system-tray app, PUSH + PULL
#
#  Installed by MCMF-Agent-Setup.exe. Deploy to as many Windows PCs / VMs as you like;
#  each machine reports its own hostname + logged-in user. Two channels (both work when
#  MCMF and the PC can reach each other):
#    - PUSH : the agent sends telemetry OUT to MCMF over HTTPS (443) on an interval.
#    - PULL : the agent listens on a TCP port so MCMF can pull on demand ("AUTH <key>").
#
#  - Lives in the notification area (system tray); auto-starts at logon.
#  - Click the icon -> requires LOCAL ADMIN (UAC) + an app password to open settings.
#  - Configure the MCMF IP + port and EXACTLY which telemetry is sent.
#  - Reports logged-in Windows user + device posture for the future AAA / NAC (ClearPass).
#  - Shows live status: listener bound? firewall open? MCMF reachable? last push?
#
#  Tokens replaced by MCMF when the installer is built:  __MCMF_KEY__  __MCMF_IP__  __MCMF_PORT__
# =====================================================================================

param([switch]$Service, [switch]$Console, [switch]$Settings)
#  -Service = headless always-on engine (no tray UI). Run by the SYSTEM scheduled task, session 0.
#  -Console = headless CONSOLE CAPTURE helper. Spawned BY the service into the physical console
#             session, as SYSTEM, so it can attach to the Winlogon/secure desktop. Never installed
#             as a task of its own: it exists only while a remote session is active.

$ErrorActionPreference = 'SilentlyContinue'
# The tray UI needs WinForms. The service has no desktop at all. The console helper needs GDI+ for the
# capture but must NOT load WinForms: creating a window pins the thread to one desktop, and this helper
# exists precisely to follow the desktop as it switches (logon <-> desktop <-> UAC).
if ($Console) { Add-Type -AssemblyName System.Drawing }
elseif (-not $Service) { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing }

# Accept the MCMF self-signed cert via a COMPILED .NET delegate, not a PowerShell {$true} script
# block. ClientWebSocket (the console tunnel) invokes the cert callback on a background thread with
# no PS Runspace, so a script block throws "There is no Runspace available" and the WSS handshake
# fails. A real delegate runs on any thread. Set once, globally — covers telemetry AND the tunnel.
try {
  Add-Type @"
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public static class McmfCert {
  public static void TrustAll() {
    ServicePointManager.ServerCertificateValidationCallback =
      delegate(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { return true; };
  }
}
"@ -ErrorAction SilentlyContinue
} catch {}
try { [McmfCert]::TrustAll() } catch { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } }

$Global:Mode    = if ($Console) { 'console' } elseif ($Service) { 'service' } else { 'tray' }
$Global:CfgDir  = Join-Path $env:ProgramData 'MCMF'
$Global:CfgFile = Join-Path $CfgDir 'agent-config.json'
$Global:LogFile = Join-Path $CfgDir 'agent.log'
$Global:StatusFile = Join-Path $CfgDir 'agent-status.json'
# The -Console helper writes live remote-support counters here; the tray "About" dialog (a separate
# process) reads them so the operator can see exactly what a session has carried.
$Global:MediaStatsFile = Join-Path $CfgDir 'media-stats.json'
$Global:DefaultKey  = '__MCMF_KEY__'
$Global:DefaultIp   = '__MCMF_IP__'
$Global:DefaultPort = [int]'__MCMF_PORT__'
$Global:AgentVersion = '__AGENT_VERSION__'   # baked at download; reported on ingest; auto-updates if the server is newer
# Cumulative telemetry volume for this process (shown in the tray About dialog).
$Global:PushTxBytes = [long]0; $Global:PushRxBytes = [long]0; $Global:PushCount = [long]0
if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null }
function Write-Log([string]$m) { try { ("{0}  {1}" -f (Get-Date -Format s), $m) | Add-Content -Path $LogFile } catch {} }

# ---- config -------------------------------------------------------------------------
# Sensible, ON-by-default config: Push + Pull + Allow-any-network enabled, port 9182.
function New-DefaultConfig {
    $port = 0; if (-not [int]::TryParse([string]$DefaultPort, [ref]$port) -or $port -le 0) { $port = 9182 }
    [pscustomobject]@{
        MCMFIP = $DefaultIp; Port = $port; Key = $DefaultKey; Token = ''; HeartbeatSec = 30
        # Pure outbound by default: the agent dials MCMF over HTTPS (push + command long-poll). The
        # inbound PULL listener is OFF (no firewall port) — set Pull=$true only for the legacy model.
        Push = $true; Pull = $false; AllowAnyNetwork = $true; PullAllowFrom = ''; AdminHash = ''; AdminSalt = ''
        # Console tunnel (browser RDP/SSH over the outbound channel). User-controllable: uncheck it in the
        # tray settings to refuse all remote-console sessions on this host. ON by default.
        TunnelEnabled = $true
        # Per-feature remote-support switches. Each is an independently revocable service on this host:
        # uncheck one in the tray settings and the agent refuses just that feature (audio / chat / files),
        # while screen view keeps working. ON by default.
        AllowAudio = $true; AllowChat = $true; AllowFiles = $true
        Send = [pscustomobject]@{ Cpu=$true; Memory=$true; Disk=$true; Network=$true; Services=$true; EventLogs=$true; LoggedInUser=$true; Posture=$true; NetStat=$true; InstalledApps=$true }
    }
}
# Overlay a (possibly older / partial) saved config onto the defaults so missing fields — e.g. a
# blank Port or absent Push/Pull/AllowAnyNetwork from an earlier agent version — get the proper
# default instead of ending up null/unchecked.
function Merge-Config($c) {
    $d = New-DefaultConfig
    if ($c) {
        if ($c.MCMFIP)    { $d.MCMFIP = [string]$c.MCMFIP }
        if ($c.Key)       { $d.Key = [string]$c.Key }
        if ($c.Token)     { $d.Token = [string]$c.Token }
        if ($c.AdminHash) { $d.AdminHash = [string]$c.AdminHash }
        if ($c.AdminSalt) { $d.AdminSalt = [string]$c.AdminSalt }
        $p = 0; if ([int]::TryParse([string]$c.Port, [ref]$p) -and $p -gt 0) { $d.Port = $p }
        $h = 0; if ([int]::TryParse([string]$c.HeartbeatSec, [ref]$h) -and $h -ge 15) { $d.HeartbeatSec = $h }
        if ($null -ne $c.Push)            { $d.Push = [bool]$c.Push }
        if ($null -ne $c.Pull)            { $d.Pull = [bool]$c.Pull }
        if ($null -ne $c.AllowAnyNetwork) { $d.AllowAnyNetwork = [bool]$c.AllowAnyNetwork }
        if ($null -ne $c.TunnelEnabled)   { $d.TunnelEnabled = [bool]$c.TunnelEnabled }
        if ($null -ne $c.AllowAudio)      { $d.AllowAudio = [bool]$c.AllowAudio }
        if ($null -ne $c.AllowChat)       { $d.AllowChat = [bool]$c.AllowChat }
        if ($null -ne $c.AllowFiles)      { $d.AllowFiles = [bool]$c.AllowFiles }
        if ($null -ne $c.PullAllowFrom)   { $d.PullAllowFrom = [string]$c.PullAllowFrom }
        if ($c.Send) { foreach ($k in @($d.Send.PSObject.Properties.Name)) { if ($null -ne $c.Send.$k) { $d.Send.$k = [bool]$c.Send.$k } } }
    }
    return $d
}
function Load-Config {
    $c = $null
    if (Test-Path $CfgFile) { try { $c = Get-Content $CfgFile -Raw | ConvertFrom-Json } catch {} }
    $m = Merge-Config $c
    Save-Config $m   # persist the normalized config (fills blanks, fixes the port)
    return $m
}
function Save-Config($c) { $c | ConvertTo-Json -Depth 6 | Set-Content -Path $CfgFile -Encoding UTF8 }
# The per-agent token (issued by the server on first check-in) is presented instead of the shared
# bootstrap Key for runtime calls; the server accepts either, so this never breaks an enrolled agent.
function Get-AuthKey($c) { if ($c -and $c.Token) { return [string]$c.Token } else { return [string]$c.Key } }
$Global:Cfg = Load-Config

# ---- admin gate ---------------------------------------------------------------------
function Test-IsAdmin { $id=[System.Security.Principal.WindowsIdentity]::GetCurrent(); (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) }
function Hash-Password([string]$salt,[string]$pw) { $sha=[System.Security.Cryptography.SHA256]::Create(); -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($salt+$pw)) | ForEach-Object { $_.ToString('x2') }) }
function Prompt-Password([string]$title,[string]$label) {
    $f=New-Object System.Windows.Forms.Form; $f.Text=$title; $f.Width=360; $f.Height=170; $f.StartPosition='CenterScreen'; $f.FormBorderStyle='FixedDialog'; $f.MaximizeBox=$false; $f.MinimizeBox=$false; $f.TopMost=$true
    $l=New-Object System.Windows.Forms.Label; $l.Text=$label; $l.Left=16; $l.Top=14; $l.Width=320
    $tb=New-Object System.Windows.Forms.TextBox; $tb.UseSystemPasswordChar=$true; $tb.Left=16; $tb.Top=44; $tb.Width=312
    $ok=New-Object System.Windows.Forms.Button; $ok.Text='OK'; $ok.Left=172; $ok.Top=86; $ok.Width=75; $ok.DialogResult='OK'
    $cn=New-Object System.Windows.Forms.Button; $cn.Text='Cancel'; $cn.Left=253; $cn.Top=86; $cn.Width=75; $cn.DialogResult='Cancel'
    $f.Controls.AddRange(@($l,$tb,$ok,$cn)); $f.AcceptButton=$ok; $f.CancelButton=$cn
    if ($f.ShowDialog() -eq 'OK') { return $tb.Text } else { return $null }
}
# Relaunch just the Settings window ELEVATED. The tray may be running non-elevated -- e.g. started from
# the Start-menu shortcut, or on a host where the elevated logon task did not run -- and Settings needs
# admin. Rather than dead-ending with "run as administrator" (which the user cannot easily act on once
# the tray is already running), offer a one-click UAC relaunch that opens ONLY the settings dialog and
# exits, leaving the running tray alone.
function Invoke-ElevatedSettings {
    try {
        $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $me = $PSCommandPath; if (-not $me) { $me = $MyInvocation.MyCommand.Path }
        Start-Process -FilePath $exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', ('"' + $me + '"'), '-Settings') | Out-Null
        return $true
    } catch {
        return $false
    }
}
# Relaunch the TRAY itself from the on-disk script and exit the current one. After a self-update the
# service is restarted on the new build but the tray keeps running the OLD in-memory script -- so the
# Settings dialog and menus never show new features until the tray is reloaded. This does that reload:
# launch a fresh tray from the (now updated) .ps1, then exit this process. A short delay lets self-update
# finish laying the new file down first.
function Restart-Tray([int]$delayMs = 0) {
    try {
        if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
        $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $me = $PSCommandPath; if (-not $me) { $me = $MyInvocation.MyCommand.Path }
        Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', ('"' + $me + '"')) | Out-Null
    } catch {}
    try { $Global:Notify.Visible = $false } catch {}
    [System.Windows.Forms.Application]::Exit()
}
function Unlock-Admin {
    if (-not (Test-IsAdmin)) {
        $r = [System.Windows.Forms.MessageBox]::Show('Settings need administrator rights. Open them as administrator now? (You will get a Windows UAC prompt.)','MCMF Agent','YesNo','Question')
        if ($r -eq 'Yes') { if (-not (Invoke-ElevatedSettings)) { [System.Windows.Forms.MessageBox]::Show('Could not elevate. Right-click the MCMF shortcut and choose Run as administrator.','MCMF Agent','OK','Warning')|Out-Null } }
        return $false
    }
    if ([string]::IsNullOrEmpty($Cfg.AdminHash)) {
        $p1=Prompt-Password 'Set agent password' 'First run - set an admin password to protect this agent:'; if ([string]::IsNullOrEmpty($p1)) { return $false }
        $p2=Prompt-Password 'Confirm password' 'Re-enter the password:'; if ($p1 -ne $p2) { [System.Windows.Forms.MessageBox]::Show('Passwords did not match.','MCMF Agent','OK','Error')|Out-Null; return $false }
        $salt=[guid]::NewGuid().ToString('N'); $Cfg.AdminSalt=$salt; $Cfg.AdminHash=(Hash-Password $salt $p1); Save-Config $Cfg; return $true
    }
    $pw=Prompt-Password 'MCMF Agent' 'Enter the agent admin password:'; if ([string]::IsNullOrEmpty($pw)) { return $false }
    if ((Hash-Password $Cfg.AdminSalt $pw) -ne $Cfg.AdminHash) { [System.Windows.Forms.MessageBox]::Show('Incorrect password.','MCMF Agent','OK','Error')|Out-Null; return $false }
    return $true
}

# ---- telemetry / posture ------------------------------------------------------------
function Get-LoggedInUser {
    try { $u=(Get-CimInstance Win32_ComputerSystem).UserName; if ($u) { return $u } } catch {}
    try { return ((Get-Process explorer -IncludeUserName | Select-Object -First 1).UserName) } catch {}
    return "$env:USERDOMAIN\$env:USERNAME"
}
function Get-Posture {
    $p=[ordered]@{}
    try { $fw=Get-NetFirewallProfile -ErrorAction Stop; $p.firewallOn=[bool]($fw | Where-Object { $_.Enabled }).Count } catch { $p.firewallOn=$null }
    try { $av=Get-MpComputerStatus -ErrorAction Stop; $p.antivirusOn=[bool]$av.AntivirusEnabled; $p.realtimeOn=[bool]$av.RealTimeProtectionEnabled; $p.signatureAgeDays=[int]$av.AntivirusSignatureAge } catch { $p.antivirusOn=$null }
    try { $bl=Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop; $p.diskEncrypted=($bl.ProtectionStatus -eq 'On') } catch { $p.diskEncrypted=$null }
    try { $p.pendingReboot=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') } catch { $p.pendingReboot=$null }
    $p.domainJoined=[bool](Get-CimInstance Win32_ComputerSystem).PartOfDomain
    return $p
}
function Get-Snapshot {
    $s=$Cfg.Send
    $o=[ordered]@{ hostname=$env:COMPUTERNAME; os='windows'; agent='tray'; version=$Global:AgentVersion }
    try { $o.osVersion=[string](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption } catch { $o.osVersion='Windows' }
    try { $o.machineId=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { $o.machineId=$env:COMPUTERNAME }
    try { $o.ips=@((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' }).IPAddress) } catch { $o.ips=@() }
    if ($s.LoggedInUser) { $o.loggedInUser=Get-LoggedInUser }
    if ($s.Cpu)     { try { $o.cpuPct=[math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average,1) } catch {} }
    if ($s.Memory)  { try { $os=Get-CimInstance Win32_OperatingSystem; $o.memPct=[math]::Round((1-$os.FreePhysicalMemory/$os.TotalVisibleMemorySize)*100,1) } catch {} }
    if ($s.Disk)    { try { $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"; $o.diskPct=[math]::Round((1-$d.FreeSpace/$d.Size)*100,1) } catch {} }
    if ($s.Network) { $o.netMbps=0 }
    if ($s.Services){ try {
        $cpc=@{}; try { (Get-Counter '\Process(*)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.InstanceName -notmatch '^(_total|idle)$' } | ForEach-Object { $cpc[$_.InstanceName]=[math]::Round($_.CookedValue/[int]$env:NUMBER_OF_PROCESSORS,1) } } catch {}
        $tp=[double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        $o.services=@(Get-Process | Group-Object ProcessName | ForEach-Object { $ws=($_.Group | Measure-Object WorkingSet64 -Sum).Sum; @{ name=$_.Name; status='running'; cpu=[double]$cpc[$_.Name.ToLower()]; mem=$(if($tp){[math]::Round($ws/$tp*100,1)}else{0}) } } | Sort-Object {$_.cpu},{$_.mem} -Descending | Select-Object -First 20)
    } catch {} }
    if ($s.EventLogs){ try { $o.events=@(Get-WinEvent -FilterHashtable @{LogName='System';Level=2,3} -MaxEvents 10 -ErrorAction SilentlyContinue | ForEach-Object { @{ level='warning'; category='system'; message=$_.Message.Substring(0,[math]::Min(300,$_.Message.Length)) } }) } catch {} }
    if ($s.Posture) { $o.posture=Get-Posture }
    if ($s.NetStat -ne $false){
        try { $o.openPorts=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique) } catch {}
        try {
            $pn=@{}; try { Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $pn[[int]$_.Id]=$_.ProcessName } } catch {}
            $o.connections=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -and (@('127.0.0.1','::1','0.0.0.0','::') -notcontains $_.RemoteAddress) } | Select-Object -First 100 | ForEach-Object { @{ lport=$_.LocalPort; raddr=[string]$_.RemoteAddress; rport=$_.RemotePort; proc=[string]$pn[[int]$_.OwningProcess]; state='established' } })
        } catch {}
    }
    if ($s.InstalledApps -ne $false){ try {
        $uk=@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
        $o.installedApps=@(Get-ItemProperty $uk -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | Select-Object DisplayName,DisplayVersion -Unique | Sort-Object DisplayName | Select-Object -First 300 | ForEach-Object { @{ name=[string]$_.DisplayName; version=[string]$_.DisplayVersion } })
    } catch {} }
    return $o
}

# ---- firewall (scope the inbound PULL port to the MCMF IP only) ----------------------
function Get-AllowedPullSources {
    # MCMF server IP plus any extra MCMF IPs (failover / NAT) — used to scope the inbound pull port.
    $list = @([string]$Cfg.MCMFIP) + (([string]$Cfg.PullAllowFrom) -split '[,;\s]+')
    @($list | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
}
function Ensure-FirewallRule {
    if (-not $Cfg.Pull) { return $false }
    $name="MCMF Agent "+$Cfg.Port
    # "Allow any network" opens the pull port to Any. Otherwise it's locked to MCMF's IP(s):
    # the server IP plus any extra IPs (2-3) listed in "Also allow". The AUTH key still applies.
    $remote = 'Any'
    if (-not $Cfg.AllowAnyNetwork) { $remote = Get-AllowedPullSources; if (-not $remote -or @($remote).Count -eq 0) { $remote = 'Any' } }
    try { Get-NetFirewallRule -DisplayName $name -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction SilentlyContinue } catch {}
    try { New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $Cfg.Port -Action Allow -RemoteAddress $remote -ErrorAction Stop | Out-Null; return $true } catch { Write-Log ('firewall rule failed: '+$_.Exception.Message); return $false }
}
function Test-FirewallRule { try { [bool](Get-NetFirewallRule -DisplayName ("MCMF Agent "+$Cfg.Port) -ErrorAction Stop) } catch { $false } }

# ---- PULL: raw-TCP listener ("AUTH <key>" -> one JSON line) --------------------------
$Global:Listener=$null
function Start-Listener {
    Stop-Listener
    if (-not $Cfg.Pull) { return }
    try { $Global:Listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any,[int]$Cfg.Port); $Global:Listener.Start(); Write-Log ('listening on TCP '+$Cfg.Port) } catch { Write-Log ('listener bind failed: '+$_.Exception.Message); $Global:Listener=$null }
}
function Stop-Listener { try { if ($Global:Listener) { $Global:Listener.Stop() } } catch {}; $Global:Listener=$null }
function Pump-Listener {
    if (-not $Global:Listener) { return }
    try {
        while ($Global:Listener.Pending()) {
            $client=$Global:Listener.AcceptTcpClient(); $stream=$client.GetStream()
            $reader=New-Object System.IO.StreamReader($stream); $writer=New-Object System.IO.StreamWriter($stream); $writer.AutoFlush=$true
            $line=$reader.ReadLine()
            if ($line -eq ("AUTH "+$Cfg.Key)) { $writer.WriteLine((Get-Snapshot | ConvertTo-Json -Depth 6 -Compress)) } else { $writer.WriteLine('{"error":"auth"}') }
            $client.Close()
        }
    } catch { Write-Log ('listener error: '+$_.Exception.Message) }
}

# ---- PUSH: agent -> MCMF over HTTPS -------------------------------------------------
$Global:LastBeat='never'
# Self-update: re-run the server bootstrap (downloads the latest agent + installer, clean-upgrades in
# place, restarts the service). Used by auto-update, the 'update' command (remote push) and the tray menu.
function Invoke-SelfUpdate {
    Write-Log ('self-update: pulling latest agent from '+$Cfg.MCMFIP)
    # Stamp the time so the auto-update check honours a cooldown (prevents a self-update loop).
    try { Set-Content -Path (Join-Path $Global:CfgDir 'last-update.txt') -Value ([DateTime]::UtcNow.ToString('o')) -ErrorAction SilentlyContinue } catch {}
    Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',("[Net.ServicePointManager]::ServerCertificateValidationCallback={`$true};iex ((New-Object Net.WebClient).DownloadString('https://"+$Cfg.MCMFIP+"/api/agent/bootstrap?k="+[uri]::EscapeDataString($Cfg.Key)+"'))") -WindowStyle Hidden
}
function Send-Heartbeat {
    if (-not $Cfg.Push) { return }
    if ([string]::IsNullOrEmpty($Cfg.MCMFIP)) { $Global:LastBeat='no MCMF IP set'; return }
    try {
        [McmfCert]::TrustAll()
        try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls13 -bor [Net.SecurityProtocolType]::Tls12 } catch { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 }
        $body=(Get-Snapshot | ConvertTo-Json -Depth 6); $uri="https://"+$Cfg.MCMFIP+"/api/agent/ingest"
        $resp=Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType 'application/json' -Headers @{ 'x-agent-key'=(Get-AuthKey $Cfg) } -TimeoutSec 12
        try { $Global:PushTxBytes += [long][System.Text.Encoding]::UTF8.GetByteCount($body); $Global:PushCount += 1; if ($resp) { $Global:PushRxBytes += [long][System.Text.Encoding]::UTF8.GetByteCount([string]($resp | ConvertTo-Json -Depth 4 -Compress)) } } catch {}
        $Global:LastBeat='OK '+(Get-Date -Format 'HH:mm:ss')
        if ($resp -and $resp.agentId) { $Global:AgentId=[string]$resp.agentId }   # learn our id for the command channel
        if ($resp -and $resp.agentToken -and ([string]$resp.agentToken -ne [string]$Cfg.Token)) { $Cfg.Token=[string]$resp.agentToken; Save-Config $Cfg; Write-Log 'adopted per-agent token' }   # present it instead of the shared key from now on
        # Auto-update: the server returns its current agent build. If we're older, self-update once (the
        # bootstrap clean-upgrades in place + restarts the service on the new version).
        if ($resp -and $resp.agentVersion -and ([string]$resp.agentVersion -ne [string]$Global:AgentVersion) -and (-not $Global:UpdateTriggered)) {
            $recent = $false
            try { $lu = Get-Content (Join-Path $Global:CfgDir 'last-update.txt') -ErrorAction SilentlyContinue; if ($lu) { $recent = ([DateTime]::UtcNow - [DateTime]::Parse([string]$lu)).TotalMinutes -lt 10 } } catch {}
            if (-not $recent) {
                $Global:UpdateTriggered = $true
                Write-Log ("auto-update: server v"+$resp.agentVersion+" differs from local v"+$Global:AgentVersion+" - self-updating")
                Invoke-SelfUpdate
            }
        }
        # FUTURE AAA HOOK: AAA/NAC server may return an ACL directive for this user+posture; enforcement added with the AAA build.
        if ($resp -and $resp.acl) { Write-Log ('AAA ACL directive: '+($resp.acl | ConvertTo-Json -Compress)) }
    } catch {
        # Token rejected (revoked / server DB reset / corrupt) -> drop it and fall back to the shared Key.
        try { if ($Cfg.Token -and $_.Exception.Response -and ([int]$_.Exception.Response.StatusCode -eq 401)) { $Cfg.Token=''; Save-Config $Cfg; Write-Log 'token rejected - reverting to shared key' } } catch {}
        $Global:LastBeat='FAILED: '+$_.Exception.Message; Write-Log ('push failed: '+$_.Exception.Message)
    }
}
function Test-McmfReachable { try { $hp=($Cfg.MCMFIP -split ':'); $h=$hp[0]; $pt=if($hp.Count -gt 1){[int]$hp[1]}else{443}; (Test-NetConnection -ComputerName $h -Port $pt -InformationLevel Quiet -WarningAction SilentlyContinue) } catch { $false } }

# ---- COMMAND CHANNEL: agent long-polls MCMF over HTTPS (no inbound port) ------------
$Global:AgentId=''
function Send-CommandResult($id,$status,$result,$code) {
    try {
        [McmfCert]::TrustAll()
        $body=@{ commandId=$id; status=$status; result=[string]$result; exitCode=$code } | ConvertTo-Json
        Invoke-RestMethod -Uri ("https://"+$Cfg.MCMFIP+"/api/agent/command-result") -Method Post -Body $body -ContentType 'application/json' -Headers @{ 'x-agent-key'=(Get-AuthKey $Cfg) } -TimeoutSec 12 | Out-Null
    } catch { Write-Log ('result post failed: '+$_.Exception.Message) }
}
function Invoke-AgentCommand($c) {
    $status='done'; $result=''; $code=$null
    try {
        switch ([string]$c.kind) {
            'run'    { $result=(& powershell.exe -NoProfile -Command $c.payload.command 2>&1 | Out-String); $code=$LASTEXITCODE }
            'power'  { if ($c.payload.action -eq 'restart') { $result='restart scheduled'; Start-Sleep 1; Restart-Computer -Force } elseif ($c.payload.action -eq 'shutdown') { $result='shutdown scheduled'; Start-Sleep 1; Stop-Computer -Force } }
            'config' { if ($c.payload.intervalSec) { $h=0; if ([int]::TryParse([string]$c.payload.intervalSec,[ref]$h) -and $h -ge 15) { $Cfg.HeartbeatSec=$h; Save-Config $Cfg; $result='interval='+$h } } }
            'update' { Invoke-SelfUpdate; $result='self-update triggered' }
            'console-open' { if ($Cfg.TunnelEnabled) { $result=Open-ConsoleTunnel $c.payload.sessionId $c.payload.targetPort } else { $status='failed'; $result='console tunnel is DISABLED on this host - enable it in the MCMF tray icon -> Settings -> "Allow console tunnel"' } }
            # Remote support: MCMF flipped a session active (consent resolved). Start the SYSTEM helper
            # that can see the physical console. Only the service can do this - it is the SYSTEM process.
            'remote-console' { if ($Global:Mode -ne 'service') { $status='failed'; $result='only the SYSTEM service can start console capture' } else { $result=Start-ConsoleCapture } }
            'uninstall' {
                # Removing the agent is not an ordinary command. Once installed it stays installed
                # unless somebody deliberately says otherwise, so the operator has to name this exact
                # machine in the request. A stray or replayed 'uninstall' -- to the wrong agent id, or
                # from an old queued row -- is refused instead of quietly wiping a host's management.
                $confirmHost = ''
                try { $confirmHost = [string]$c.payload.confirmHost } catch {}
                if ($confirmHost -ne $env:COMPUTERNAME) {
                    $status='failed'
                    $result='uninstall REFUSED - this request did not name this machine (' + $env:COMPUTERNAME + '). Removing an installed agent requires explicit confirmation.'
                    Write-Log ('uninstall refused: confirmHost=' + $confirmHost + ' but this host is ' + $env:COMPUTERNAME)
                    break
                }
                Write-Log ('uninstall CONFIRMED for ' + $env:COMPUTERNAME + ' - removing the agent')
                # Detached cleanup (survives killing our own task): delete both scheduled tasks + files.
                Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',("Start-Sleep 3; schtasks /delete /tn 'MCMF Endpoint Agent (Service)' /f 2>`$null; schtasks /delete /tn 'MCMF Endpoint Agent' /f 2>`$null; Get-ChildItem ([Environment]::GetFolderPath('CommonDesktopDirectory')),([Environment]::GetFolderPath('CommonPrograms')) -Filter 'MCMF Endpoint Agent.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force 'C:\Program Files\MCMF' -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force '$env:ProgramData\MCMF' -ErrorAction SilentlyContinue")
                $result='uninstalled — scheduled tasks + files removed; agent exiting'
                $Global:UninstallExit=$true
            }
            default  { $status='failed'; $result='unknown command kind: '+$c.kind }
        }
    } catch { $status='failed'; $result=$_.Exception.Message }
    Send-CommandResult $c.id $status $result $code
    $Global:LastCommand = ("{0}: {1} ({2})" -f [string]$c.kind, $status, (Get-Date -Format 'HH:mm:ss'))
    Write-Status
    if ($Global:UninstallExit) { Start-Sleep -Seconds 5; [Environment]::Exit(0) }
}
function Open-ConsoleTunnel($sessionId, $targetPort) {
    # Bridge the MCMF relay (outbound WSS) ↔ this host's local RDP/SSH — no inbound port needed.
    try {
        [McmfCert]::TrustAll()
        $ws=New-Object System.Net.WebSockets.ClientWebSocket
        $uri=[Uri]("wss://"+$Cfg.MCMFIP+"/api/agent/tunnel?session="+$sessionId+"&k="+[uri]::EscapeDataString((Get-AuthKey $Cfg)))
        $ws.ConnectAsync($uri,[Threading.CancellationToken]::None).Wait()
        $tcp=New-Object System.Net.Sockets.TcpClient('127.0.0.1',[int]$targetPort); $stream=$tcp.GetStream()
        $shared=[hashtable]::Synchronized(@{ ws=$ws; stream=$stream; tcp=$tcp; stop=$false })
        $down={ param($s); $buf=New-Object byte[] 65536
            try { while (-not $s.stop -and $s.ws.State -eq 'Open') { $seg=New-Object System.ArraySegment[byte] (,$buf)
                $r=$s.ws.ReceiveAsync($seg,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
                if ($r.MessageType -eq 'Close' -or $r.Count -le 0) { break }; $s.stream.Write($buf,0,$r.Count) } } catch {} finally { $s.stop=$true; try{$s.tcp.Close()}catch{}; try{$s.ws.Abort()}catch{} } }
        $up={ param($s); $buf=New-Object byte[] 65536
            try { while (-not $s.stop) { $n=$s.stream.Read($buf,0,$buf.Length); if ($n -le 0) { break }
                $seg=New-Object System.ArraySegment[byte] (,($buf[0..($n-1)])); $s.ws.SendAsync($seg,'Binary',$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult() } } catch {} finally { $s.stop=$true; try{$s.tcp.Close()}catch{}; try{$s.ws.Abort()}catch{} } }
        foreach ($sb in @($down,$up)) { $p=[PowerShell]::Create(); $null=$p.AddScript($sb).AddArgument($shared); $rs=[RunspaceFactory]::CreateRunspace(); $rs.Open(); $p.Runspace=$rs; $null=$p.BeginInvoke() }
        return 'console tunnel open -> 127.0.0.1:'+$targetPort
    } catch { $ie=$_.Exception; while ($ie.InnerException) { $ie=$ie.InnerException }; return 'console tunnel failed: '+$ie.Message }
}
function Poll-Commands {
    if ([string]::IsNullOrEmpty($Global:AgentId)) { return }
    try {
        [McmfCert]::TrustAll()
        $uri="https://"+$Cfg.MCMFIP+"/api/agent/commands?agentId="+$Global:AgentId+"&k="+[uri]::EscapeDataString((Get-AuthKey $Cfg))
        $resp=Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 35
        if ($resp.active -eq $false) { Write-Log 'decommissioned by MCMF — exiting'; [Environment]::Exit(0) }
        foreach ($c in @($resp.commands)) { if ($c) { Invoke-AgentCommand $c } }
    } catch { Write-Log ('command poll: '+$_.Exception.Message); Start-Sleep -Seconds 5 }
}

# ---- shared status (service writes, tray reads) — so the tray can show live telemetry state ----
function Write-Status { try { [pscustomobject]@{ mode=$Global:Mode; lastBeat=$Global:LastBeat; channel=(-not [string]::IsNullOrEmpty($Global:AgentId)); lastCommand=$Global:LastCommand; mcmf=$Cfg.MCMFIP; at=(Get-Date -Format s) } | ConvertTo-Json -Compress | Set-Content -Path $StatusFile -Encoding UTF8 } catch {} }
function Read-Status  { try { if (Test-Path $StatusFile) { return (Get-Content $StatusFile -Raw | ConvertFrom-Json) } } catch {}; return $null }

# ---- settings window ----------------------------------------------------------------
function Show-Settings {
    if (-not (Unlock-Admin)) { return }
    # Resizable window with a SCROLLING content area and a fixed button bar at the bottom. The old
    # fixed-size dialog clipped its own last controls on a high-DPI display, and its telemetry group was
    # a few pixels too short for its own list -- so the bottom row of options was always cut off with no
    # way to reach it. A Dock=Fill+AutoScroll panel scrolls whatever does not fit; the buttons live in a
    # Dock=Bottom bar so they are always visible no matter the screen size or scaling.
    $f=New-Object System.Windows.Forms.Form; $f.Text='MCMF Endpoint Agent - Settings'
    $f.StartPosition='CenterScreen'; $f.FormBorderStyle='Sizable'; $f.MaximizeBox=$true; $f.MinimizeBox=$false; $f.TopMost=$true
    $f.ClientSize = New-Object System.Drawing.Size(500, 600)
    $f.MinimumSize = New-Object System.Drawing.Size(460, 360)

    # Bottom button bar (never scrolls, always reachable).
    $bar=New-Object System.Windows.Forms.Panel; $bar.Dock='Bottom'; $bar.Height=48
    # Scrolling content region for everything else.
    $pan=New-Object System.Windows.Forms.Panel; $pan.Dock='Fill'; $pan.AutoScroll=$true; $pan.Padding=New-Object System.Windows.Forms.Padding(4)

    $y=12
    $lblIp=New-Object System.Windows.Forms.Label; $lblIp.Text='MCMF server IP / host:'; $lblIp.Left=16; $lblIp.Top=$y; $lblIp.Width=200
    $tbIp=New-Object System.Windows.Forms.TextBox; $tbIp.Left=220; $tbIp.Top=($y-3); $tbIp.Width=230; $tbIp.Text=$Cfg.MCMFIP; $y+=32
    $lblPort=New-Object System.Windows.Forms.Label; $lblPort.Text='Pull port (MCMF connects in):'; $lblPort.Left=16; $lblPort.Top=$y; $lblPort.Width=200
    $tbPort=New-Object System.Windows.Forms.TextBox; $tbPort.Left=220; $tbPort.Top=($y-3); $tbPort.Width=100; $tbPort.Text=[string]$Cfg.Port; $y+=32
    $lblHb=New-Object System.Windows.Forms.Label; $lblHb.Text='Push interval (sec):'; $lblHb.Left=16; $lblHb.Top=$y; $lblHb.Width=200
    $tbHb=New-Object System.Windows.Forms.TextBox; $tbHb.Left=220; $tbHb.Top=($y-3); $tbHb.Width=100; $tbHb.Text=[string]$Cfg.HeartbeatSec; $y+=32
    $cbPush=New-Object System.Windows.Forms.CheckBox; $cbPush.Text='Push out to MCMF (HTTPS)'; $cbPush.Left=16; $cbPush.Top=$y; $cbPush.Width=210; $cbPush.Checked=[bool]$Cfg.Push
    $cbPull=New-Object System.Windows.Forms.CheckBox; $cbPull.Text='Allow MCMF pull (listen on port)'; $cbPull.Left=232; $cbPull.Top=$y; $cbPull.Width=240; $cbPull.Checked=[bool]$Cfg.Pull; $y+=26
    $cbAny=New-Object System.Windows.Forms.CheckBox; $cbAny.Text='Allow pull from any network (uncheck = only the MCMF IPs below)'; $cbAny.Left=16; $cbAny.Top=$y; $cbAny.Width=456; $cbAny.Checked=[bool]$Cfg.AllowAnyNetwork; $y+=26
    $cbTunnel=New-Object System.Windows.Forms.CheckBox; $cbTunnel.Text='Allow console tunnel (browser RDP / SSH to this host) - uncheck to block all remote console'; $cbTunnel.Left=16; $cbTunnel.Top=$y; $cbTunnel.Width=456; $cbTunnel.Height=34; $cbTunnel.Checked=[bool]$Cfg.TunnelEnabled; $y+=36
    # Remote-support feature switches. Each service is independently revocable on this host; unchecking one
    # makes the agent refuse just that feature during a remote session (screen view keeps working).
    $grpRs=New-Object System.Windows.Forms.GroupBox; $grpRs.Text='Remote support features (allowed during a session)'; $grpRs.Left=16; $grpRs.Top=$y; $grpRs.Width=444; $grpRs.Height=100
    $cbAudio=New-Object System.Windows.Forms.CheckBox; $cbAudio.Text='Audio (two-way voice with the operator)'; $cbAudio.Left=16; $cbAudio.Top=22; $cbAudio.Width=410; $cbAudio.Checked=[bool]$Cfg.AllowAudio; $grpRs.Controls.Add($cbAudio)
    $cbChat=New-Object System.Windows.Forms.CheckBox; $cbChat.Text='Chat (text messages with the operator)'; $cbChat.Left=16; $cbChat.Top=46; $cbChat.Width=410; $cbChat.Checked=[bool]$Cfg.AllowChat; $grpRs.Controls.Add($cbChat)
    $cbFiles=New-Object System.Windows.Forms.CheckBox; $cbFiles.Text='File transfer (send / receive files + browse this PC)'; $cbFiles.Left=16; $cbFiles.Top=70; $cbFiles.Width=410; $cbFiles.Checked=[bool]$Cfg.AllowFiles; $grpRs.Controls.Add($cbFiles)
    $y+=110
    $lblAllow=New-Object System.Windows.Forms.Label; $lblAllow.Text='Also allow pull from (extra MCMF IPs / CIDRs, comma-separated - e.g. failover/NAT):'; $lblAllow.Left=16; $lblAllow.Top=$y; $lblAllow.Width=456; $y+=18
    $tbAllow=New-Object System.Windows.Forms.TextBox; $tbAllow.Left=16; $tbAllow.Top=$y; $tbAllow.Width=444; $tbAllow.Text=[string]$Cfg.PullAllowFrom; $y+=34
    $tbAllow.Enabled = -not $cbAny.Checked
    $cbAny.Add_CheckedChanged({ $tbAllow.Enabled = -not $cbAny.Checked })
    $cats=@('Cpu','Memory','Disk','Network','Services','EventLogs','LoggedInUser','Posture','NetStat','InstalledApps')
    $labels=@{ Cpu='CPU %'; Memory='Memory %'; Disk='Disk %'; Network='Network'; Services='Running services'; EventLogs='System event logs'; LoggedInUser='Logged-in Windows user (for AAA)'; Posture='Device posture: firewall / AV / encryption (for AAA)'; NetStat='Open ports + active connections to remote IPs'; InstalledApps='Installed applications inventory' }
    # Group tall enough for every row plus the title inset. Height was the bug: 10 rows need more than
    # the old 234, so the last option ("Installed applications inventory") was clipped inside the box.
    $grpHeight = 28 + ($cats.Count * 22) + 8
    $grp=New-Object System.Windows.Forms.GroupBox; $grp.Text='Telemetry to send to MCMF'; $grp.Left=16; $grp.Top=$y; $grp.Width=444; $grp.Height=$grpHeight
    $boxes=@{}; $gy=24
    foreach ($c in $cats) { $cb=New-Object System.Windows.Forms.CheckBox; $cb.Text=$labels[$c]; $cb.Left=16; $cb.Top=$gy; $cb.Width=410; $cb.Checked=[bool]$Cfg.Send.$c; $grp.Controls.Add($cb); $boxes[$c]=$cb; $gy+=22 }
    $y+=($grpHeight + 10)
    $lblStatus=New-Object System.Windows.Forms.Label; $lblStatus.Left=16; $lblStatus.Top=$y; $lblStatus.Width=444; $lblStatus.Height=58
    $refreshStatus={ $st=Read-Status; $bound=if ($st -and $st.listening) {'bound on '+$st.port} else {'off'}; $fw=if (Test-FirewallRule) {'open'} else {'off'}; $reach=if (Test-McmfReachable) {'reachable'} else {'NOT reachable'}; $beat=if ($st) {$st.lastBeat} else {$Global:LastBeat}; $lblStatus.Text="Background service: $(if($st){'running'}else{'not detected'})  |  Pull listener: $bound`nFirewall: $fw  |  MCMF (443): $reach`nLast push: $beat" }
    & $refreshStatus; $y+=64

    # Buttons laid out left-to-right at FIXED positions anchored Top,Left so they are ALWAYS visible.
    # (The old right-anchored Left=ClientSize.Width-230 math mis-placed Save & apply / Close off-screen
    # under high-DPI scaling, leaving only "Change password" reachable -- there was no way to apply.)
    # Save & apply is first and bold so it is unmissable; a green tint marks it as the primary action.
    $btnSave=New-Object System.Windows.Forms.Button; $btnSave.Text='Save && apply'; $btnSave.Width=130; $btnSave.Height=30; $btnSave.Top=9; $btnSave.Left=12; $btnSave.Anchor='Top,Left'; $btnSave.DialogResult='None'
    $btnSave.Font=New-Object System.Drawing.Font($btnSave.Font,[System.Drawing.FontStyle]::Bold); $btnSave.BackColor=[System.Drawing.Color]::FromArgb(210,244,220)
    $btnClose=New-Object System.Windows.Forms.Button; $btnClose.Text='Close'; $btnClose.Width=90; $btnClose.Height=30; $btnClose.Top=9; $btnClose.Left=150; $btnClose.Anchor='Top,Left'; $btnClose.DialogResult='Cancel'
    $btnPw=New-Object System.Windows.Forms.Button; $btnPw.Text='Change password'; $btnPw.Left=250; $btnPw.Top=9; $btnPw.Width=140; $btnPw.Height=30; $btnPw.Anchor='Top,Left'
    $btnPw.Add_Click({ $p1=Prompt-Password 'Change password' 'New admin password:'; if ([string]::IsNullOrEmpty($p1)) { return }; $p2=Prompt-Password 'Confirm' 'Re-enter:'; if ($p1 -ne $p2) { [System.Windows.Forms.MessageBox]::Show('Did not match.','MCMF',0,'Error')|Out-Null; return }; $salt=[guid]::NewGuid().ToString('N'); $Cfg.AdminSalt=$salt; $Cfg.AdminHash=(Hash-Password $salt $p1); Save-Config $Cfg; [System.Windows.Forms.MessageBox]::Show('Password updated.','MCMF',0,'Information')|Out-Null })
    $btnSave.Add_Click({
        $Cfg.MCMFIP=$tbIp.Text.Trim(); $p=0; if ([int]::TryParse($tbPort.Text,[ref]$p) -and $p -gt 0) { $Cfg.Port=$p }
        $h=0; if ([int]::TryParse($tbHb.Text,[ref]$h) -and $h -ge 15) { $Cfg.HeartbeatSec=$h }
        $Cfg.Push=[bool]$cbPush.Checked; $Cfg.Pull=[bool]$cbPull.Checked; $Cfg.AllowAnyNetwork=[bool]$cbAny.Checked
        $Cfg.TunnelEnabled=[bool]$cbTunnel.Checked
        $Cfg.AllowAudio=[bool]$cbAudio.Checked; $Cfg.AllowChat=[bool]$cbChat.Checked; $Cfg.AllowFiles=[bool]$cbFiles.Checked
        $Cfg.PullAllowFrom=$tbAllow.Text.Trim()
        foreach ($c in $cats) { $Cfg.Send.$c=[bool]$boxes[$c].Checked }
        # Save only - the background service hot-reloads agent-config.json and re-applies (firewall, listener, interval).
        Save-Config $Cfg; Send-Heartbeat; Start-Sleep -Milliseconds 600; & $refreshStatus
        # Clear feedback that the click took effect (the status label may be scrolled out of view).
        try { $btnSave.Text='Saved'; $btnSave.Refresh() } catch {}
        try { if ($Global:Notify) { $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent'; $Global:Notify.BalloonTipText='Settings saved and applied.'; $Global:Notify.ShowBalloonTip(3000) } } catch {}
        try { $tmr=New-Object System.Windows.Forms.Timer; $tmr.Interval=1400; $tmr.Add_Tick({ $this.Stop(); try { $btnSave.Text='Save && apply' } catch {} }); $tmr.Start() } catch {}
    })
    # Everything scrollable goes in $pan; the three buttons go in the fixed bottom bar.
    $pan.Controls.AddRange(@($lblIp,$tbIp,$lblPort,$tbPort,$lblHb,$tbHb,$cbPush,$cbPull,$cbAny,$cbTunnel,$grpRs,$lblAllow,$tbAllow,$grp,$lblStatus))
    $bar.Controls.AddRange(@($btnPw,$btnSave,$btnClose))
    # The Fill panel must be added FIRST (lowest z-order): WinForms docks from the top of the z-order
    # down, so the last-added Bottom bar claims its strip and the Fill panel takes whatever remains.
    $f.Controls.Add($pan); $f.Controls.Add($bar)
    $f.AcceptButton=$btnSave; $f.CancelButton=$btnClose; $f.ShowDialog() | Out-Null
}

# =====================================================================================
#  CONSOLE CAPTURE  (shared by the tray, the service and the -Console helper)
#
#  Seeing the PHYSICAL console - the logon screen, the lock screen, a UAC prompt, a BSOD - is the whole
#  reason this exists rather than an RDP session: RDP opens a NEW session and can never show the monitor
#  in front of the user. Two facts drive the design:
#
#    1. Only SYSTEM may attach to the Winlogon/secure desktops, and only a process INSIDE the console
#       session can see them at all. The service is SYSTEM but sits in session 0, which has no desktop.
#       So it duplicates its own token, retargets it at the console session, and starts this same script
#       there with -Console.
#    2. Windows switches the input desktop under us (Default <-> Winlogon on lock/logout, and to the
#       secure desktop for every UAC prompt). A thread bound to the old one captures black. The helper
#       therefore re-attaches to whatever desktop currently owns input, every frame.
#
#  The helper exists only while the SERVER says a session is active, and exits on its own when it is not:
#  a SYSTEM process that can see the logon screen should not outlive the consent that justified it.
# =====================================================================================
try {
  Add-Type -ReferencedAssemblies 'System.Drawing' -ErrorAction Stop @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class McmfWin {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr tok);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool DuplicateTokenEx(IntPtr tok, uint acc, IntPtr sa, int imp, int type, out IntPtr dup);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool SetTokenInformation(IntPtr tok, int cls, ref uint val, int len);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetThreadDesktop(IntPtr d);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr d);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder sb, uint len, out uint need);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

    // ---- mouse pointer -------------------------------------------------------------------------
    // CopyFromScreen does NOT include the cursor - Windows draws it in a separate compositing pass. So
    // an unmodified screen grab shows the desktop with no pointer anywhere, which makes remote control
    // guesswork: the operator cannot see where they are aiming. It has to be drawn in by hand.
    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public int ptX; public int ptY; }
    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
    [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int w, int h, int step, IntPtr brush, int flags);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);

    const int CURSOR_SHOWING = 0x0001;
    const int DI_NORMAL = 0x0003;

    // Draw the live pointer onto the grab. Silently does nothing when the cursor is hidden (full-screen
    // video, some games) or when we cannot read it - a frame without a pointer beats no frame at all.
    public static void DrawCursor(Graphics g) {
        CURSORINFO ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref ci)) return;
        if ((ci.flags & CURSOR_SHOWING) == 0 || ci.hCursor == IntPtr.Zero) return;
        ICONINFO ii;
        if (!GetIconInfo(ci.hCursor, out ii)) return;
        try {
            IntPtr hdc = g.GetHdc();
            try {
                // The hotspot is the pixel the cursor actually POINTS at; drawing at the raw position
                // would offset every pointer by the size of its own artwork.
                DrawIconEx(hdc, ci.ptX - ii.xHotspot, ci.ptY - ii.yHotspot, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
            } finally {
                g.ReleaseHdc(hdc);
            }
        } catch {
        } finally {
            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
        }
    }

    // ---- keyboard / mouse injection -------------------------------------------------------------
    // SendInput posts to the desktop of the CALLING THREAD, which is why injection has to happen on
    // McmfShot's worker (the only thread attached to whichever desktop currently owns input). Calling it
    // from anywhere else would type into the desktop underneath a lock screen instead of the one on the
    // monitor.
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] pInputs, int cbSize);

    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    // Button flags indexed by [button, down] - left, right, middle.
    static readonly uint[,] BTN = new uint[3,2] { {0x0004,0x0002}, {0x0010,0x0008}, {0x0040,0x0020} };

    private static void Send(INPUT one) { INPUT[] a = new INPUT[1]; a[0] = one; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }

    private static INPUT Mouse(uint flags, int dx, int dy, uint data) {
        INPUT i = new INPUT();
        i.type = 0; // INPUT_MOUSE
        i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
        return i;
    }

    private static INPUT Key(ushort vk, ushort scan, uint flags) {
        INPUT i = new INPUT();
        i.type = 1; // INPUT_KEYBOARD
        i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
        return i;
    }

    // Apply one flat [op, a, b, c] group. Op codes are defined once in the server's input.ts and must
    // stay in step with it.
    public static void ApplyOp(int op, int a, int b, int c) {
        if (op == 1) {         // move, absolute 0..65535 across the virtual desktop
            Send(Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, a, b, 0));
        } else if (op == 2) {  // button a (0 left, 1 right, 2 middle), b = down
            if (a < 0 || a > 2) return;
            Send(Mouse(BTN[a, b == 1 ? 1 : 0], 0, 0, 0));
        } else if (op == 3) {  // wheel
            Send(Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)a)));
        } else if (op == 4) {  // virtual key
            Send(Key((ushort)a, 0, b == 1 ? 0u : KEYEVENTF_KEYUP));
        } else if (op == 5) {  // unicode code unit - typed as text, independent of the target's layout
            Send(Key(0, (ushort)a, b == 1 ? KEYEVENTF_UNICODE : (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)));
        }
    }

    public static int LastPid = 0;
    public static uint LastSession = 0;
    public static string LastDesktop = "";
    private static IntPtr held = IntPtr.Zero;

    public static int ScreenWidth() { return GetSystemMetrics(0); }
    public static int ScreenHeight() { return GetSystemMetrics(1); }

    // Start a process as SYSTEM inside the PHYSICAL console session. Returns null on success.
    public static string LaunchInConsoleSession(string cmdLine) {
        uint sid = WTSGetActiveConsoleSessionId();
        if (sid == 0xFFFFFFFF) return "no physical console session is attached to this machine";
        LastSession = sid;
        IntPtr tok = IntPtr.Zero;
        IntPtr dup = IntPtr.Zero;
        try {
            if (!OpenProcessToken(GetCurrentProcess(), 0xF01FF, out tok)) return "OpenProcessToken failed: " + Marshal.GetLastWin32Error();
            if (!DuplicateTokenEx(tok, 0xF01FF, IntPtr.Zero, 2, 1, out dup)) return "DuplicateTokenEx failed: " + Marshal.GetLastWin32Error();
            // TokenSessionId = 12. This is the step that only SYSTEM may take, and the step that moves the
            // child out of session 0 and onto the console.
            if (!SetTokenInformation(dup, 12, ref sid, 4)) return "SetTokenInformation(session " + sid + ") failed: " + Marshal.GetLastWin32Error() + " (requires SYSTEM)";
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = "winsta0\\default"; // the helper re-attaches to the input desktop itself
            PROCESS_INFORMATION pi;
            StringBuilder cmd = new StringBuilder(cmdLine); // CreateProcess may write to this buffer
            if (!CreateProcessAsUser(dup, null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref si, out pi))
                return "CreateProcessAsUser failed: " + Marshal.GetLastWin32Error();
            LastPid = pi.dwProcessId;
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return null;
        } finally {
            if (dup != IntPtr.Zero) CloseHandle(dup);
            if (tok != IntPtr.Zero) CloseHandle(tok);
        }
    }

    private static string DesktopName(IntPtr d) {
        StringBuilder sb = new StringBuilder(256);
        uint need;
        if (GetUserObjectInformation(d, 2, sb, 256, out need)) return sb.ToString(); // UOI_NAME
        return "?";
    }

    // Attach the CALLING thread to the desktop that currently has input. Idempotent: when the desktop has
    // not changed we drop the handle and leave the thread alone.
    //
    // Must only ever be called from McmfShot's worker thread. SetThreadDesktop fails with ERROR_BUSY (170)
    // if the calling thread owns any window, and both hosts of this script do: powershell.exe has its
    // console and the tray has WinForms. The failure is silent in the worst way - the thread simply stays
    // on the old desktop and keeps capturing it, so a locked screen would stream the desktop underneath.
    public static string SwitchToInputDesktop() {
        IntPtr d = OpenInputDesktop(0, false, 0x10000000); // GENERIC_ALL
        if (d == IntPtr.Zero) return "OpenInputDesktop failed: " + Marshal.GetLastWin32Error();
        string name = DesktopName(d);
        if (name == LastDesktop && held != IntPtr.Zero) { CloseDesktop(d); return null; }
        if (!SetThreadDesktop(d)) {
            int e = Marshal.GetLastWin32Error();
            CloseDesktop(d);
            return "SetThreadDesktop(" + name + ") failed: " + e + (e == 170 ? " (ERROR_BUSY: this thread owns a window)" : "");
        }
        if (held != IntPtr.Zero) CloseDesktop(held);
        held = d;
        LastDesktop = name;
        return null;
    }
}

// Screen grabs on a DEDICATED thread that owns no windows -- the only kind of thread allowed to follow
// the input desktop (see SwitchToInputDesktop). The thread is created here rather than in PowerShell so
// that it never touches a Runspace: it must stay a plain worker with nothing attached to it.
public static class McmfShot {
    private static Thread worker;
    private static AutoResetEvent go = new AutoResetEvent(false);
    private static AutoResetEvent done = new AutoResetEvent(false);
    private static byte[] result;
    private static int quality = 45;
    private static int maxHeight = 0; // 0 = capture at native resolution; else downscale so HEIGHT fits
    private static ImageCodecInfo jpeg;

    public static string LastError = null;
    public static string LastDesktopError = null;
    public static int LastWidth = 0;
    public static int LastHeight = 0;
    // Content fingerprint of the last grab. An unchanged screen re-encodes to byte-identical JPEG, so
    // equal hashes mean equal pixels and the frame does not need to be uploaded at all.
    public static long LastHash = 0;

    private static List<int> inbox = new List<int>();

    // Queue operator keyboard/mouse for the worker thread. Never injects on the caller's thread: see
    // McmfWin.SendInput.
    public static void Queue(int[] ops) {
        if (ops == null || ops.Length == 0) return;
        lock (inbox) { inbox.AddRange(ops); }
    }

    private static void DrainInput() {
        int[] ops = null;
        lock (inbox) {
            if (inbox.Count == 0) return;
            ops = inbox.ToArray();
            inbox.Clear();
        }
        for (int i = 0; i + 3 < ops.Length; i += 4) {
            try { McmfWin.ApplyOp(ops[i], ops[i+1], ops[i+2], ops[i+3]); } catch { /* one bad op must not stop the rest */ }
        }
    }

    public static void Start(int q) {
        quality = q;
        if (worker != null) return;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        worker = new Thread(new ThreadStart(Loop));
        worker.IsBackground = true; // never hold the process open
        worker.Start();
    }

    private static void Loop() {
        while (true) {
            go.WaitOne();
            // Inject first, then grab: the operator should see the effect of their own click in the very
            // next frame rather than the one after it.
            try { DrainInput(); } catch (Exception ie) { LastError = "input: " + ie.Message; }
            try { result = GrabInternal(); LastError = null; }
            catch (Exception e) { result = null; LastError = e.Message; }
            done.Set();
        }
    }

    // Returns a JPEG, or null (check LastError). Follows the input desktop first, so the frame is whatever
    // is actually on the monitor: the desktop, the lock screen, the logon screen, or a UAC prompt.
    // Apply a quality profile without restarting the worker thread - a mid-session mode change is meant
    // to be instant. Clamped so a bad value can never produce an unreadable frame.
    public static void SetProfile(int q, int mh) {
        if (q >= 1 && q <= 100) quality = q;
        if (mh >= 0) maxHeight = mh;
    }

    public static byte[] Grab() {
        if (worker == null) Start(quality);
        go.Set();
        if (!done.WaitOne(5000)) { LastError = "capture thread did not respond within 5s"; return null; }
        return result;
    }

    // Reused frame buffers. A 1080p 32bpp Bitmap is ~8MB; allocating one (plus the scaled copy) per
    // frame meant ~80MB/s of garbage at 10fps, and the GC pauses that come with it. Video is the case
    // that exposes it, because motion gating never suppresses a frame so every single one is captured,
    // scaled and encoded. These live on the worker thread only, so no locking is needed.
    private static Bitmap fullBmp;
    private static Bitmap scaledBmp;
    private static EncoderParameters encParams;
    private static long encQuality = -1;

    private static byte[] GrabInternal() {
        LastDesktopError = SwitchToInputDesktopSafe();
        int w = McmfWin.ScreenWidth();
        int h = McmfWin.ScreenHeight();
        if (w <= 0 || h <= 0) throw new Exception("no screen attached (" + w + "x" + h + ")");
        LastWidth = w; LastHeight = h;

        // Reuse the full-screen buffer; only reallocate when the resolution actually changes.
        if (fullBmp == null || fullBmp.Width != w || fullBmp.Height != h) {
            if (fullBmp != null) fullBmp.Dispose();
            fullBmp = new Bitmap(w, h);
        }
        using (Graphics g = Graphics.FromImage(fullBmp)) {
            g.CopyFromScreen(0, 0, 0, 0, fullBmp.Size);
            McmfWin.DrawCursor(g); // the pointer is never in the screen copy - see DrawCursor
        }

        Bitmap frame = fullBmp;
        if (maxHeight > 0 && h > maxHeight) {
            // Downscale so HEIGHT == maxHeight (144/240/360/480/720/1080), width follows the aspect
            // ratio -- exactly how a video site labels "720p". Even width keeps libx264 happy later.
            int nw = (int)((long)w * maxHeight / h);
            if (nw < 2) nw = 2;
            nw -= (nw % 2);
            if (scaledBmp == null || scaledBmp.Width != nw || scaledBmp.Height != maxHeight) {
                if (scaledBmp != null) scaledBmp.Dispose();
                scaledBmp = new Bitmap(nw, maxHeight);
            }
            using (Graphics g2 = Graphics.FromImage(scaledBmp)) {
                // Bilinear, not HighQualityBicubic: bicubic costs several times more CPU per frame and
                // the difference is invisible once the image is already being downscaled to <=720p and
                // JPEG-compressed. On video that saving is the difference between smooth and stuttering.
                g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                g2.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighSpeed;
                g2.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                g2.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                g2.DrawImage(fullBmp, 0, 0, nw, maxHeight);
            }
            frame = scaledBmp;
            LastWidth = nw; LastHeight = maxHeight;
        }

        // Cache the encoder parameters too - rebuilding them per frame is pure waste.
        if (encParams == null || encQuality != (long)quality) {
            encQuality = (long)quality;
            encParams = new EncoderParameters(1);
            // Fully qualified: System.Text is also in scope here and has its own Encoder.
            encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, encQuality);
        }
        using (MemoryStream ms = new MemoryStream(96 * 1024)) {
            frame.Save(ms, jpeg, encParams);
            byte[] outBytes = ms.ToArray();
            LastHash = Fingerprint(outBytes);
            return outBytes;
        }
    }

    // FNV-1a over the length plus a sample of the bytes. Sampling rather than hashing all ~80KB keeps
    // this off the frame budget; combined with the exact length it is more than enough to tell "the
    // screen did not change" from "it did", and a missed change costs one late frame, not a wrong one.
    private static long Fingerprint(byte[] b) {
        unchecked {
            long h = (long)2166136261u;
            h = (h ^ b.Length) * 16777619;
            // Sample every 16th byte rather than a fixed 512 samples. A window playing video changes
            // only part of the frame, and with a sparse sample it was possible to grab a run of bytes
            // that happened to match and call a moving screen unchanged. ~5000 samples of an 80KB
            // frame is still trivial next to the JPEG encode that just produced it.
            int step = 16;
            for (int i = 0; i < b.Length; i += step) h = (h ^ b[i]) * 16777619;
            return h;
        }
    }

    // A desktop we cannot follow is not fatal: the tray is not SYSTEM and will never be allowed onto
    // Winlogon, and it should still stream the user's own desktop. We record why and carry on.
    private static string SwitchToInputDesktopSafe() {
        try { return McmfWin.SwitchToInputDesktop(); } catch (Exception e) { return e.Message; }
    }

    public static string Desktop() { return McmfWin.LastDesktop; }
}
'@
} catch {
  # Swallowing this would make console capture fail later with an unrelated "type not found", so say it now.
  Write-Log ('screen capture interop failed to compile - remote support will not be able to capture: ' + $_.Exception.Message)
}

# Every remote-support call is HTTPS, and the agent refuses to build a plain-HTTP URL. Frames, keyboard
# and mouse all travel over this one helper, so enforcing TLS here covers the whole remote console: a
# misconfigured server address can never downgrade a live desktop stream onto the wire in clear text.
function Assert-Tls([string]$server) {
    if ($server -match '^\s*http://') { throw 'MCMF server is configured as plain HTTP; remote support requires HTTPS and will not send screen data over an unencrypted connection.' }
}

function Invoke-RemoteApi([string]$path, $body) {
    Assert-Tls $Cfg.MCMFIP
    $uri = "https://" + $Cfg.MCMFIP + "/api/remote/" + $path
    $json = ($body | ConvertTo-Json -Depth 5)
    # The key proves this box IS the session's agent (the server refuses keyless ack/consent/frame).
    return Invoke-RestMethod -Uri $uri -Method Post -Body $json -ContentType 'application/json' -Headers @{ 'x-agent-key'=(Get-AuthKey $Cfg) } -TimeoutSec 15
}

$Global:CapSession = $null
$Global:CapHttp = $null
$Global:CapTask = $null   # in-flight frame POST; its reply is read on the next timer tick

function Init-Capture {
    if (-not $Global:CapHttp) {
        Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
        $h = New-Object System.Net.Http.HttpClientHandler
        try { $h.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator } catch {}
        $Global:CapHttp = New-Object System.Net.Http.HttpClient($h)
        $Global:CapHttp.Timeout = [TimeSpan]::FromSeconds(5)
    }
    # Frame POSTs must carry the agent key. Re-set every time: the token can be adopted or rotated after
    # the client was created.
    try {
        [void]$Global:CapHttp.DefaultRequestHeaders.Remove('x-agent-key')
        [void]$Global:CapHttp.DefaultRequestHeaders.TryAddWithoutValidation('x-agent-key', (Get-AuthKey $Cfg))
    } catch {}
    # 45 keeps a 1080p frame around 60-90KB, which is what makes 10 fps viable over the tunnel.
    try { [McmfShot]::Start(45) } catch {}
}

# One grab, off the dedicated worker thread. Returns @{ b64; bytes; w; h; hash } or $null.
# `bytes` is the raw JPEG, carried so the WebSocket path can send binary without a base64 encode/decode
# round-trip; `b64` is kept for the HTTP POST fallback which needs a JSON-safe string.
function Get-ScreenJpeg {
    $bytes = [McmfShot]::Grab()
    if (-not $bytes) { return $null }
    return @{ b64 = [Convert]::ToBase64String($bytes); bytes = $bytes; w = [McmfShot]::LastWidth; h = [McmfShot]::LastHeight; hash = [McmfShot]::LastHash }
}

# ---- motion gating --------------------------------------------------------------------------
# Most of a support session is a screen nobody is touching. Uploading ten identical copies of it every
# second costs the customer bandwidth and costs us disk, and shows the operator nothing new. So a grab
# whose pixels are unchanged is simply not sent - the server is told how many were skipped so the saving
# is reported as a measurement rather than a claim.
#
# The keep-alive is not optional: lastFrameAt is what the server's idle ceiling uses to close abandoned
# sessions, and a motionless desktop must not look abandoned.
$Global:LastSentHash = $null
$Global:LastSentAt = [DateTime]::MinValue
$Global:SkippedFrames = 0
$Global:MotionKeepAliveMs = 300

function Test-ShouldSendFrame($shot) {
    if ($null -eq $Global:LastSentHash) { return $true }
    if ($shot.hash -ne $Global:LastSentHash) { return $true }
    return (([DateTime]::UtcNow - $Global:LastSentAt).TotalMilliseconds -ge $Global:MotionKeepAliveMs)
}

function Reset-MotionState {
    $Global:LastSentHash = $null
    $Global:LastSentAt = [DateTime]::MinValue
    $Global:SkippedFrames = 0
}

# Apply the quality profile the server attached to the active session (fps handled by each caller; JPEG
# quality + downscale applied here). Cheap and idempotent, so it is safe to call every poll.
$Global:CapQuality = ''
function Set-CaptureProfile($active) {
    if (-not $active) { return }
    $q = 45; if ($active.jpegQuality) { $q = [int]$active.jpegQuality }
    $mh = 0; if ($active.maxHeight) { $mh = [int]$active.maxHeight }
    try { [McmfShot]::SetProfile($q, $mh) } catch {}
    $mode = [string]$active.quality
    if ($mode -and $mode -ne $Global:CapQuality) { $Global:CapQuality = $mode; Write-Log ('remote console quality -> ' + $mode + ' (q=' + $q + ', maxH=' + $mh + ')') }
}

# Hand queued operator keyboard/mouse to the capture thread. The ops ride back on the frame response, so
# there is no second round-trip per keystroke.
function Invoke-RemoteInput($resp) {
    if (-not $resp) { return }
    $ops = $resp.input
    if (-not $ops -or $ops.Count -eq 0) { return }
    try { [McmfShot]::Queue([int[]]$ops) } catch { Write-Log ('remote input: ' + $_.Exception.Message) }
}

# ---- the -Console helper: capture the physical console and post frames --------------------
$Global:ConsolePid = 0

# The POST of the PREVIOUS frame, still in flight while we capture the next one.
$Global:ConTask = $null
$Global:ConFps = 0

# Read the reply of the previous POST, if it has landed. Returns a stop reason or $null.
# Never uses Task.ContinueWith - a scriptblock delegate cannot be resolved on some PowerShell 5.1
# builds and it took the tray down once already; polling IsCompleted needs no delegate at all.
function Complete-ConsoleSend {
    if (-not $Global:ConTask) { return $null }
    if (-not $Global:ConTask.IsCompleted) { return $null }
    $t = $Global:ConTask; $Global:ConTask = $null
    try {
        if ($t.IsFaulted -or $t.IsCanceled) { return $null }
        $r = $t.Result.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        Invoke-RemoteInput $r
        # The frame reply carries the live quality profile, so a mid-session change applies within one
        # frame without the capture loop having to make a blocking poll for it.
        if ($r.q) { Set-CaptureProfile $r.q; if ($r.q.fps) { $Global:ConFps = [int]$r.q.fps } }
        if ($r.stop) { return [string]$r.reason }
    } catch {
        $m = $_.Exception.Message
        if ($m -ne $Global:LastFrameErr) { Write-Log ('console frame reply: ' + $m); $Global:LastFrameErr = $m }
    }
    return $null
}

function Send-ConsoleFrame([string]$id) {
    # Returns the server's stop reason, or $null to keep going.
    #
    # PIPELINED: the previous frame's POST is left in flight while this one is captured and encoded, so
    # the frame period is max(capture, upload) instead of capture + upload. Serial send-then-capture was
    # why a playing video looked slow: every frame paid the full network round-trip before the next grab
    # even started, capping the rate far below the requested fps no matter what quality was chosen.
    try {
        $shot = Get-ScreenJpeg
        if (-not $shot) {
            $m = [string][McmfShot]::LastError
            if ($m -ne $Global:LastFrameErr) { Write-Log ('console capture: ' + $m); $Global:LastFrameErr = $m }
            return (Complete-ConsoleSend)
        }
        # Reap the previous POST now - it has had the whole capture+encode to finish, so this is
        # normally already complete and costs nothing.
        $stop = Complete-ConsoleSend
        if ($stop) { return $stop }
        if (-not (Test-ShouldSendFrame $shot)) { $Global:SkippedFrames++; return $null }
        # Still waiting on the previous upload: drop this frame rather than queue it. A queued frame is
        # already stale by the time it would go out, and piling them up only adds latency.
        if ($Global:ConTask) { return $null }

        # Build the JSON by hand rather than with ConvertTo-Json. The payload is a ~120KB base64 string,
        # and ConvertTo-Json re-scans and escapes the whole thing on every frame -- one of the slowest
        # things PowerShell 5.1 can be asked to do at 10fps. Base64 only ever contains A-Z a-z 0-9 + / =,
        # none of which need JSON escaping, so plain concatenation is both correct and far cheaper.
        $body = '{"jpeg":"' + $shot.b64 + '","w":' + [int]$shot.w + ',"h":' + [int]$shot.h + ',"source":"console","skipped":' + [int]$Global:SkippedFrames + '}'
        $uri = "https://" + $Cfg.MCMFIP + "/api/remote/sessions/" + $id + "/frame"
        $content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, 'application/json')
        $Global:ConTask = $Global:CapHttp.PostAsync($uri, $content)
        # Optimistic: count it sent now. A failed POST only suppresses the next identical grab, which
        # the keep-alive corrects on its own.
        $Global:LastSentHash = $shot.hash
        $Global:LastSentAt = [DateTime]::UtcNow
        $Global:SkippedFrames = 0
        return $null
    } catch {
        # Deduplicate: at 10 fps a persistent error would otherwise write 600 log lines a minute.
        $m = $_.Exception.Message
        if ($m -ne $Global:LastFrameErr) { Write-Log ('console frame: ' + $m); $Global:LastFrameErr = $m }
        return $null
    }
}

# ---- two-way audio (WASAPI, inline COM interop - no external DLL) -----------------------------------
# Compiled lazily the first time audio is enabled, so the tray and service never pay for it. Wire format
# is 48 kHz mono 16-bit PCM in BOTH directions; the C# handles every device-format conversion (float32,
# stereo, odd rates) so PowerShell and the browser only ever deal with clean mono PCM. Capture runs two
# endpoints - the render device in LOOPBACK (what is playing on the target's speakers) and the default
# microphone - each tagged with a source byte so the browser can mix them. Render plays the operator's
# voice on the target's speakers. Nothing runs until StartCapture/StartRender are called, and Stop tears
# it all down - the audioEnabled gate decides when.
$Global:AudioTypeReady = $false
$Global:AudioOn = $false
function Init-Audio {
    if ($Global:AudioTypeReady) { return $true }
    try {
        Add-Type -ErrorAction Stop @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;

public static class McmfAudio {
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator { int NI0(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev); }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice { int Activate(ref Guid iid, int clsCtx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient {
        int Initialize(int share, int flags, long dur, long period, IntPtr fmt, IntPtr guid);
        int GetBufferSize(out uint n);
        int GetStreamLatency(out long l);
        int GetCurrentPadding(out uint n);
        int IsFormatSupported(int share, IntPtr fmt, IntPtr closest);
        int GetMixFormat(out IntPtr fmt);
        int GetDevicePeriod(out long def, out long min);
        int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr h);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    }
    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient {
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long pos, out long qpc);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }
    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioRenderClient {
        int GetBuffer(uint frames, out IntPtr data);
        int ReleaseBuffer(uint frames, int flags);
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorClass {}

    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr p, int coInit);

    const int SHARE = 0;              // AUDCLNT_SHAREMODE_SHARED
    const int LOOPBACK = 0x00020000;  // AUDCLNT_STREAMFLAGS_LOOPBACK
    const int WIRE = 48000;           // wire sample rate (mono int16)
    static Guid IID_AC  = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static Guid IID_CAP = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static Guid IID_REN = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");

    public static string LastError = "";
    static volatile bool _run = false;
    static Queue<byte[]> _capQ = new Queue<byte[]>();   // each item: [srcTag][pcm16 mono 48k...]
    static Queue<short[]> _renQ = new Queue<short[]>(); // admin voice, mono int16 @ 48k
    static readonly object _capLock = new object();
    static readonly object _renLock = new object();
    static int _renQueued = 0;

    static IMMDeviceEnumerator NewEnum() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorClass()); }

    // Parse the leading WAVEFORMATEX fields at a native pointer.
    static void ParseFmt(IntPtr p, out int ch, out int rate, out int bits, out bool isFloat) {
        short tag = Marshal.ReadInt16(p, 0);
        ch   = Marshal.ReadInt16(p, 2);
        rate = Marshal.ReadInt32(p, 4);
        bits = Marshal.ReadInt16(p, 14);
        isFloat = false;
        if (tag == 3) isFloat = true;                       // WAVE_FORMAT_IEEE_FLOAT
        else if (tag == 1) isFloat = false;                 // WAVE_FORMAT_PCM
        else if (tag == unchecked((short)0xFFFE)) {          // EXTENSIBLE: SubFormat guid Data1 at +24
            int sub = Marshal.ReadInt32(p, 24);
            isFloat = (sub == 3);
        }
    }

    // ---- capture (loopback or mic) ----
    public static bool StartCapture(bool loopback, byte srcTag) {
        try {
            var t = new Thread(() => CaptureLoop(loopback, srcTag));
            t.IsBackground = true;
            t.Start();
            return true;
        } catch (Exception e) { LastError = "startcap: " + e.Message; return false; }
    }

    static void CaptureLoop(bool loopback, byte srcTag) {
        IntPtr fmt = IntPtr.Zero;
        try {
            CoInitializeEx(IntPtr.Zero, 0);
            IMMDevice dev;
            NewEnum().GetDefaultAudioEndpoint(loopback ? 0 : 1, 0, out dev); // eRender for loopback, else eCapture
            object o; dev.Activate(ref IID_AC, 1, IntPtr.Zero, out o);
            IAudioClient ac = (IAudioClient)o;
            ac.GetMixFormat(out fmt);
            int ch, rate, bits; bool isFloat; ParseFmt(fmt, out ch, out rate, out bits, out isFloat);
            int hr = ac.Initialize(SHARE, loopback ? LOOPBACK : 0, 10000000L, 0, fmt, IntPtr.Zero);
            if (hr != 0) { LastError = "cap init 0x" + hr.ToString("X"); return; }
            object cs; ac.GetService(ref IID_CAP, out cs);
            IAudioCaptureClient cap = (IAudioCaptureClient)cs;
            ac.Start();
            double pos = 0.0, step = (double)rate / WIRE; // input samples consumed per output sample
            float prev = 0f; // last sample of the previous packet, so interpolation spans the boundary
            while (_run) {
                uint packet;
                cap.GetNextPacketSize(out packet);
                if (packet == 0) { Thread.Sleep(8); continue; }
                IntPtr data; uint frames, flags; long dp, qp;
                cap.GetBuffer(out data, out frames, out flags, out dp, out qp);
                if (frames > 0) {
                    // Copy the packet to managed memory ONCE, then read samples with BitConverter - far
                    // cheaper than per-sample marshaling at 48 kHz.
                    int bps = bits / 8;
                    int total = (int)frames * ch * bps;
                    byte[] raw = new byte[total];
                    bool silent = (flags & 0x2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT
                    if (!silent) Marshal.Copy(data, raw, 0, total);
                    // Downmix to a mono float array at the device rate.
                    float[] mono = new float[frames];
                    for (int i = 0; i < frames; i++) {
                        float s = 0f;
                        if (!silent) {
                            for (int cc = 0; cc < ch; cc++) {
                                int off = (i * ch + cc) * bps;
                                float v = isFloat ? BitConverter.ToSingle(raw, off) : (BitConverter.ToInt16(raw, off) / 32768f);
                                s += v;
                            }
                            s /= ch;
                        }
                        mono[i] = s;
                    }
                    // Resample mono float (device rate) -> 48k int16 by linear interpolation. `pos` is the
                    // fractional read index; it carries across packets, so a negative i0 reads `prev` (the
                    // previous packet's last sample) rather than indexing out of bounds - the bug that
                    // crashed the 48 kHz loopback thread after one packet.
                    List<short> outp = new List<short>();
                    while (true) {
                        int i0 = (int)Math.Floor(pos);
                        if (i0 + 1 >= frames) break;              // need mono[i0+1]; defer to the next packet
                        float a = (i0 < 0) ? prev : mono[i0];
                        float b = mono[i0 + 1];
                        double fr = pos - i0;
                        float v = (float)(a * (1 - fr) + b * fr);
                        int iv = (int)(v * 32767f); if (iv > 32767) iv = 32767; if (iv < -32768) iv = -32768;
                        outp.Add((short)iv);
                        pos += step;
                    }
                    prev = mono[frames - 1];
                    pos -= frames; // carry the fractional remainder into the next packet
                    if (outp.Count > 0) {
                        // Echo cancellation: if this is the LOOPBACK (system-audio) capture and the operator's
                        // own voice is playing right now, drop it — otherwise it round-trips and the operator
                        // hears themselves. ~220ms tail covers the gap between downlink packets. The MIC
                        // capture (loopback==false) is never gated, so two-way talk still works.
                        bool echo = loopback && (unchecked(Environment.TickCount - RenderEchoTick) < 220);
                        if (!echo) {
                            byte[] chunk = new byte[1 + outp.Count * 2];
                            chunk[0] = srcTag;
                            Buffer.BlockCopy(outp.ToArray(), 0, chunk, 1, outp.Count * 2);
                            lock (_capLock) { if (_capQ.Count < 50) _capQ.Enqueue(chunk); }
                        }
                    }
                }
                cap.ReleaseBuffer(frames);
            }
            ac.Stop();
        } catch (Exception e) { LastError = "caploop: " + e.Message; }
        finally { if (fmt != IntPtr.Zero) Marshal.FreeCoTaskMem(fmt); }
    }

    // PS pulls one ready capture chunk ([srcTag][pcm...]) or null.
    public static byte[] ReadCaptured() {
        lock (_capLock) { return _capQ.Count > 0 ? _capQ.Dequeue() : null; }
    }

    // ---- render (operator voice on the target speakers) ----
    public static bool StartRender() {
        try { var t = new Thread(RenderLoop); t.IsBackground = true; t.Start(); return true; }
        catch (Exception e) { LastError = "startren: " + e.Message; return false; }
    }

    // Diagnostics for the admin->PC (downlink) path so a silent failure can be told apart from a real
    // device problem: RenderRecv counts wire samples handed to WriteRender (i.e. 'D' frames that arrived),
    // RenderPlayed counts samples actually written to the device, RenderInfo/LastError describe the device.
    public static long RenderRecv = 0;
    public static long RenderPlayed = 0;
    public static string RenderInfo = "";
    // Peak |sample| (0..32767) of the admin audio that arrived since the last read -- lets us prove real
    // voice content is coming through the wire (vs. near-silence) without hearing it. Reset on read.
    static int _renPeak = 0;
    public static int GetRenderPeak() { lock (_renLock) { int p = _renPeak; _renPeak = 0; return p; } }
    // Echo cancellation: while the operator's OWN voice is playing on this PC's speakers, the loopback
    // capture (system audio) would grab it and send it right back — the operator hears themselves. When a
    // real (non-silent) downlink frame arrives we stamp this tick; the loopback capture drops its uplink
    // for a short window after, so the operator's voice never round-trips. The PC's MICROPHONE is a
    // separate capture and is NOT gated, so the person can still talk back at the same time.
    public static int RenderEchoTick = -100000;
    // PS pushes admin audio (mono int16 @ 48k) for playback.
    public static void WriteRender(short[] pcm) {
        if (pcm == null || pcm.Length == 0) return;
        lock (_renLock) { RenderRecv += pcm.Length; if (_renQueued < WIRE * 3) { _renQ.Enqueue(pcm); _renQueued += pcm.Length; } }
    }
    // Push admin audio as RAW BYTES (little-endian int16). The receive runspace hands us the 'D' payload
    // this way because building a short[] + BlockCopy in that isolated PowerShell runspace was throwing and
    // silently dropping every frame — the root cause of admin->PC audio being silent. Convert here in C#.
    public static void WriteRenderBytes(byte[] b) {
        if (b == null || b.Length < 2) return;
        int n = b.Length / 2;
        short[] pcm = new short[n];
        Buffer.BlockCopy(b, 0, pcm, 0, n * 2);
        int pk = 0;
        for (int i = 0; i < n; i++) { int a = pcm[i]; if (a < 0) a = -a; if (a > pk) pk = a; }
        if (pk > 350) RenderEchoTick = Environment.TickCount; // real operator voice is about to play -> gate loopback echo
        lock (_renLock) { RenderRecv += n; if (pk > _renPeak) _renPeak = pk; if (_renQueued < WIRE * 3) { _renQ.Enqueue(pcm); _renQueued += n; } }
    }

    static void RenderLoop() {
        IntPtr fmt = IntPtr.Zero;
        try {
            CoInitializeEx(IntPtr.Zero, 0);
            IMMDevice dev; NewEnum().GetDefaultAudioEndpoint(0, 0, out dev); // eRender
            object o; dev.Activate(ref IID_AC, 1, IntPtr.Zero, out o);
            IAudioClient ac = (IAudioClient)o;
            ac.GetMixFormat(out fmt);
            int ch, rate, bits; bool isFloat; ParseFmt(fmt, out ch, out rate, out bits, out isFloat);
            int hr = ac.Initialize(SHARE, 0, 10000000L, 0, fmt, IntPtr.Zero);
            if (hr != 0) { LastError = "ren init 0x" + hr.ToString("X"); return; }
            uint bufFrames; ac.GetBufferSize(out bufFrames);
            object rs; ac.GetService(ref IID_REN, out rs);
            IAudioRenderClient ren = (IAudioRenderClient)rs;
            int frameBytes = ch * (bits / 8);
            ac.Start();
            RenderInfo = "render ok " + ch + "ch " + rate + "hz " + (isFloat ? "float" : "int" + bits);
            double pos = 0.0, step = (double)WIRE / rate; // wire samples per one device sample
            float prev = 0f, cur = 0f; bool have = false;
            // Local pull of one wire sample; returns false when nothing queued.
            Func<bool> pull = () => {
                lock (_renLock) {
                    while (_renQ.Count > 0 && _renQ.Peek().Length == 0) _renQ.Dequeue();
                    if (_renQ.Count == 0) return false;
                    short[] head = _renQ.Peek();
                    prev = cur; cur = head[_headIdx] / 32768f; _renQueued--;
                    _headIdx++;
                    if (_headIdx >= head.Length) { _renQ.Dequeue(); _headIdx = 0; }
                    return true;
                }
            };
            // The mic produces audio at almost exactly the rate the speaker consumes it, so the device
            // buffer naturally hovers near empty and EVERY bit of network jitter underran it -> a click at
            // each packet boundary (the "tic tic" with no clear voice). Fix: keep a real silence CUSHION in
            // the device (pre-filled with the SILENT flag) so there is genuine slack; ride real audio on top
            // of it; and when we truly run dry, top the cushion back up with silence (inaudible) instead of
            // letting the device underrun (which is what clicks). AUDCLNT_BUFFERFLAGS_SILENT = 0x2.
            const int SILENT = 0x2;
            uint cushion  = (uint)(rate * 0.12);  // ~120ms of slack in the device
            uint hiWater  = (uint)(rate * 0.24);  // don't build latency past ~240ms
            uint loWater  = (uint)(rate * 0.05);  // below this with no data = top up with silence
            int  minStart = (int)(WIRE * 0.06);   // wait for ~60ms of real audio before we start a burst
            bool priming  = true;
            while (_run) {
                uint pad; ac.GetCurrentPadding(out pad);
                int q; lock (_renLock) { q = _renQueued; } // wire samples currently queued
                if (priming) {
                    if (q < minStart) { Thread.Sleep(4); continue; }        // wait for a cushion of real audio to exist
                    if (pad < cushion) {                                     // pre-fill the device with silence for slack
                        uint sil = cushion - pad; IntPtr sb;
                        if (ren.GetBuffer(sil, out sb) == 0) { ren.ReleaseBuffer(sil, SILENT); RenderPlayed += sil; }
                    }
                    priming = false; continue;
                }
                if (q <= 0) {
                    // Nothing to play. If the device is draining toward empty, bridge with silence so it
                    // never actually underruns (silence is inaudible; an underrun is a click).
                    if (pad < loWater) { uint sil = cushion - pad; IntPtr sb; if (ren.GetBuffer(sil, out sb) == 0) { ren.ReleaseBuffer(sil, SILENT); RenderPlayed += sil; } }
                    Thread.Sleep(3); continue;
                }
                if (pad >= hiWater) { Thread.Sleep(3); continue; }          // plenty buffered; let it drain a bit
                uint canWrite = bufFrames - pad;
                // Only ask for as many device frames as our queued audio can actually fill, and don't push
                // past the hi-water mark. Never DC-pad the tail -- that discontinuity is what clicks.
                uint producible = (uint)(q / step);
                uint headroom = hiWater - pad;
                uint toWrite = canWrite; if (toWrite > producible) toWrite = producible; if (toWrite > headroom) toWrite = headroom;
                if (toWrite < 1) { Thread.Sleep(3); continue; }
                IntPtr buf; if (ren.GetBuffer(toWrite, out buf) != 0) { Thread.Sleep(3); continue; }
                uint wrote = 0; bool under = false;
                for (uint f = 0; f < toWrite; f++) {
                    // advance the resampler until we have the sample straddling pos
                    while (pos >= 1.0) { if (!pull()) { under = true; break; } pos -= 1.0; have = true; }
                    if (under) break;
                    if (!have) { if (!pull()) { under = true; break; } have = true; }
                    float v = (float)(prev + (cur - prev) * pos);
                    for (int cc = 0; cc < ch; cc++) {
                        int off = (int)(f * frameBytes + cc * (bits / 8));
                        if (isFloat) { byte[] fb = BitConverter.GetBytes(v); Marshal.Copy(fb, 0, buf + off, 4); }
                        else { int iv = (int)(v * 32767f); if (iv > 32767) iv = 32767; if (iv < -32768) iv = -32768; Marshal.WriteInt16(buf, off, (short)iv); }
                    }
                    pos += step; wrote++;
                }
                ren.ReleaseBuffer(wrote, 0); // release only real audio frames -> no DC padding -> no clicks
                RenderPlayed += wrote;
            }
            ac.Stop();
        } catch (Exception e) { LastError = "renloop: " + e.Message; RenderInfo = "renloop err: " + e.Message; }
        finally { if (fmt != IntPtr.Zero) Marshal.FreeCoTaskMem(fmt); }
    }
    static int _headIdx = 0;

    public static void Start() { _run = true; }
    public static void Stop() {
        _run = false;
        lock (_capLock) { _capQ.Clear(); }
        lock (_renLock) { _renQ.Clear(); _renQueued = 0; _headIdx = 0; }
    }
}
'@
        $Global:AudioTypeReady = $true
        return $true
    } catch {
        Write-Log ('audio init failed: ' + $_.Exception.Message)
        return $false
    }
}

# Start capture (loopback + mic) and render for a session. Idempotent.
function Start-Audio {
    if ($Global:AudioOn) { return }
    if (-not (Init-Audio)) { return }
    try {
        [McmfAudio]::Start()
        [McmfAudio]::StartCapture($true, [byte]0)   # system loopback  -> src 0
        [McmfAudio]::StartCapture($false, [byte]1)  # microphone       -> src 1
        [McmfAudio]::StartRender()
        $Global:AudioOn = $true
        Write-Log 'two-way audio started (loopback + mic capture, render)'
    } catch { Write-Log ('audio start failed: ' + $_.Exception.Message) }
}
function Stop-Audio {
    if (-not $Global:AudioOn) { return }
    try { [McmfAudio]::Stop() } catch {}
    $Global:AudioOn = $false
    Write-Log 'two-way audio stopped'
}

# ---- persistent WebSocket media transport (replaces JPEG-per-POST while a session streams) -----------
# The agent dials ONE outbound socket per session and pushes frames as binary; the server relays them to
# the operator's browser and replies to each frame with control JSON (input + quality + audio). A single
# POST cost ~105ms of TLS/connection setup on real hardware, which capped the frame rate at a few fps no
# matter how the capture was tuned; a kept-open socket pays that once, so the frame period drops to the
# network RTT. If the socket will not open (proxy, old server) the caller falls back to the HTTP path.
$Global:MediaWs = $null
$Global:MediaShared = $null
$Global:MediaRecvPs = $null
$Global:MediaRecvRs = $null

function Close-MediaWs {
    try { if ($Global:MediaShared) { $Global:MediaShared.stop = $true } } catch {}
    try { if ($Global:MediaWs) { $Global:MediaWs.Abort() } } catch {}
    try { if ($Global:MediaRecvPs) { $Global:MediaRecvPs.Dispose() } } catch {}
    try { if ($Global:MediaRecvRs) { $Global:MediaRecvRs.Close() } } catch {}
    $Global:MediaWs = $null; $Global:MediaShared = $null; $Global:MediaRecvPs = $null; $Global:MediaRecvRs = $null
}

# Open the media socket for a session. Returns $true on success. Spawns a background runspace that reads
# control frames (text JSON: input/quality/audio/stop) and admin audio (binary tag 'D', Phase 2) so the
# send side never blocks on receive - the same dual-runspace shape as the console tunnel.
function Open-MediaWs([string]$id) {
    # Carry the two-way-audio flag across a reconnect. The WASAPI capture/render threads are independent of
    # the socket (Pump-Audio + the receive runspace drain them via the CURRENT $Global:MediaShared), so a
    # dropped socket must NOT reset audio to off — doing so made it flap start/stop every few seconds.
    $prevAudio = $false; try { if ($Global:MediaShared) { $prevAudio = [bool]$Global:MediaShared.audio } } catch {}
    try {
        Close-MediaWs
        [McmfCert]::TrustAll()
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $uri = [Uri]("wss://" + $Cfg.MCMFIP + "/api/remote/media/agent?session=" + $id + "&k=" + [uri]::EscapeDataString((Get-AuthKey $Cfg)))
        $ws.ConnectAsync($uri, [Threading.CancellationToken]::None).Wait(8000) | Out-Null
        if ($ws.State -ne 'Open') { try { $ws.Abort() } catch {}; return $false }
        # Shared state written by the receive runspace + chat window, read by the send loop. Everything
        # the runspaces do uses static .NET calls (McmfShot/McmfAudio/System.IO) or these queues - a
        # runspace cannot call this script's functions. `out` holds outbound frames the MAIN loop sends
        # (single-writer socket); `chatIn` feeds the chat window; `up` is the in-progress upload stream.
        $shared = [hashtable]::Synchronized(@{ ws = $ws; stop = $false; stopReason = $null; fps = 0; audio = $prevAudio;
            out = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue));
            chatIn = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue));
            fileOffers = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue));
            renderQ = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue));
            dRecv = [long]0; rxBin = [long]0; rxTag = 0; rxLen = 0; rxErr = '';
            chatShow = $false; up = $null; upPath = $null; upBytes = [long]0; upTotal = [long]0;
            # Per-feature switches (snapshot of $Cfg) so the isolated runspace can refuse a disabled service,
            # and live counters so the tray "About" can show what this session has actually carried.
            allowAudio = [bool]$Cfg.AllowAudio; allowChat = [bool]$Cfg.AllowChat; allowFiles = [bool]$Cfg.AllowFiles;
            cAudio = [long]0; cChat = [long]0; cFiles = [long]0; cVideo = [long]0; bytesRx = [long]0; bytesTx = [long]0 })
        $recv = {
            param($s)
            $buf = New-Object byte[] 65536
            try {
                while (-not $s.stop -and $s.ws.State -eq 'Open') {
                    $ms = New-Object System.IO.MemoryStream
                    $mtype = 'Text'
                    do {
                        $seg = New-Object System.ArraySegment[byte] (,$buf)
                        $r = $s.ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
                        if ($r.MessageType -eq 'Close' -or $r.Count -le 0) { $s.stop = $true; break }
                        $mtype = [string]$r.MessageType
                        $ms.Write($buf, 0, $r.Count)
                    } while (-not $r.EndOfMessage)
                    if ($s.stop) { break }
                    if ($mtype -eq 'Binary') {
                        try {
                            $bytes = $ms.ToArray()
                            if ($bytes.Length -lt 1) { continue }
                            try { $s.rxBin += 1; $s.rxTag = [int]$bytes[0]; $s.rxLen = [int]$bytes.Length; $s.bytesRx += [long]$bytes.Length } catch {}
                            if ($bytes[0] -eq 0x44) {
                                # 'D' admin voice. Copy the raw payload (bytes 1..end) into a byte[] with the
                                # rock-solid Array.Copy, and hand it to the main runspace as BYTES — building a
                                # short[] here (New-Object short[] + BlockCopy) THREW in this isolated runspace
                                # and got swallowed, dropping every frame (the admin->PC silence bug).
                                # allowAudio off = this host has revoked voice: drop the frame, play nothing.
                                try {
                                    if ($s.allowAudio -and $bytes.Length -gt 2) {
                                        $pl = New-Object byte[] ($bytes.Length - 1)
                                        [System.Array]::Copy($bytes, 1, $pl, 0, $bytes.Length - 1)
                                        $s.renderQ.Enqueue($pl); $s.dRecv += [int](($bytes.Length - 1) / 2); $s.cAudio += 1
                                    }
                                } catch { $s.rxErr = $_.Exception.Message }
                            } elseif ($bytes[0] -eq 0x46) {
                                # 'F' file-upload chunk: [tag][reqId u16][seq u32][data] -> current upload stream
                                if ($s.up -and $bytes.Length -gt 7) { $s.up.Write($bytes, 7, $bytes.Length - 7); try { $s.upBytes += ($bytes.Length - 7) } catch {} }
                            }
                        } catch {}
                        continue
                    }
                    # Text: per-frame ctrl reply (input/q/audio/stop) OR a chat/fs/file request from the operator.
                    try {
                        $c = ([System.Text.Encoding]::UTF8.GetString($ms.ToArray())) | ConvertFrom-Json
                        $ct = [string]$c.t
                        if ($c.input -and $c.input.Count -gt 0) { try { [McmfShot]::Queue([int[]]$c.input) } catch {} }
                        if ($c.q) {
                            $qq = 45; if ($c.q.jpegQuality) { $qq = [int]$c.q.jpegQuality }
                            $mh = 0; if ($c.q.maxHeight) { $mh = [int]$c.q.maxHeight }
                            try { [McmfShot]::SetProfile($qq, $mh) } catch {}
                            if ($c.q.fps) { $s.fps = [int]$c.q.fps }
                        }
                        if ($null -ne $c.audio) { $s.audio = ($c.audio -eq $true) }
                        if ($c.stop) { $s.stop = $true; $s.stopReason = [string]$c.reason }
                        if ($ct -eq 'chat') {
                            if ($s.allowChat) { $s.chatIn.Enqueue([string]$c.text); $s.chatShow = $true; $s.cChat += 1 }
                            else { $s.out.Enqueue(@{ text = (@{ t = 'chat'; text = '[This host has chat disabled by its administrator.]' } | ConvertTo-Json -Compress) }) }
                        }
                        elseif ($ct -eq 'chat.file') {
                            # The operator is OFFERING a file in chat. Queue it for the chat window to show a
                            # Save button; the actual bytes stream only after the person clicks it (pull model).
                            if ($s.allowFiles) {
                                $s.fileOffers.Enqueue(@{ offerId = [string]$c.offerId; name = [string]$c.name; size = [long]$c.size; kind = [string]$c.kind; count = [int]$c.count })
                                $s.chatShow = $true
                            } else { $s.out.Enqueue(@{ text = (@{ t = 'chat'; text = '[File transfer is disabled on this host by its administrator.]' } | ConvertTo-Json -Compress) }) }
                        }
                        elseif ($ct -eq 'fs.list') {
                            if (-not $s.allowFiles) { $s.out.Enqueue(@{ text = (@{ t = 'fs.list'; reqId = $c.reqId; path = [string]$c.path; error = 'File transfer is disabled on this host by its administrator.' } | ConvertTo-Json -Compress) }); continue }
                            $p = [string]$c.path
                            try {
                                $entries = New-Object System.Collections.ArrayList
                                # Empty path = the INTERACTIVE user's Desktop. This handler runs in the SYSTEM
                                # service, so [Environment]::GetFolderPath('Desktop') would give the systemprofile
                                # desktop (C:\Windows\system32\config\systemprofile\Desktop) which does not exist.
                                # Resolve the signed-in user's Desktop from their profile; if none is found, fall
                                # back to the drive list so this NEVER errors.
                                if ([string]::IsNullOrEmpty($p)) {
                                    $desk = $null; $cu = $null
                                    try { $cu = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).UserName } catch {}
                                    if ([string]::IsNullOrEmpty($cu)) { try { $cu = (Get-WmiObject Win32_ComputerSystem).UserName } catch {} }
                                    if (-not [string]::IsNullOrEmpty($cu)) {
                                        $uname = $cu.Split('\')[-1]
                                        foreach ($cand in @((Join-Path $env:SystemDrive ('Users\' + $uname + '\Desktop')), (Join-Path $env:SystemDrive ('Users\' + $uname + '\OneDrive\Desktop')))) {
                                            if (Test-Path -LiteralPath $cand) { $desk = $cand; break }
                                        }
                                        if (-not $desk) { $uh = Join-Path $env:SystemDrive ('Users\' + $uname); if (Test-Path -LiteralPath $uh) { $desk = $uh } }
                                    }
                                    if (-not $desk) { $g = [Environment]::GetFolderPath('Desktop'); if ($g -and (Test-Path -LiteralPath $g)) { $desk = $g } }
                                    $p = $desk  # may be $null -> handled as drives below
                                }
                                if ($p -eq '::drives' -or [string]::IsNullOrEmpty($p)) {
                                    if ([string]::IsNullOrEmpty($p)) { $p = '' }
                                    foreach ($d in [System.IO.DriveInfo]::GetDrives()) { if ($d.IsReady) { [void]$entries.Add(@{ name = $d.Name; dir = $true; size = 0 }) } }
                                } else {
                                    $dinfo = New-Object System.IO.DirectoryInfo($p)
                                    foreach ($di in $dinfo.GetDirectories()) { [void]$entries.Add(@{ name = $di.Name; dir = $true; size = 0 }) }
                                    foreach ($fi in $dinfo.GetFiles()) { [void]$entries.Add(@{ name = $fi.Name; dir = $false; size = $fi.Length }) }
                                }
                                $s.out.Enqueue(@{ text = (@{ t = 'fs.list'; reqId = $c.reqId; path = $p; entries = $entries } | ConvertTo-Json -Depth 5 -Compress) })
                            } catch { $s.out.Enqueue(@{ text = (@{ t = 'fs.list'; reqId = $c.reqId; path = $p; error = $_.Exception.Message } | ConvertTo-Json -Compress) }) }
                        }
                        elseif ($ct -eq 'file.get') {
                            $path = [string]$c.path; $rid = [int]$c.reqId
                            if (-not $s.allowFiles) { $s.out.Enqueue(@{ text = (@{ t = 'file.end'; reqId = $rid; dir = 'down'; path = $path; ok = $false; error = 'File transfer is disabled on this host by its administrator.' } | ConvertTo-Json -Compress) }); continue }
                            $s.cFiles += 1
                            try {
                                $fsr = [System.IO.File]::OpenRead($path); $sent = 0; $seq = 0
                                $cbuf = New-Object byte[] 61440
                                while (-not $s.stop) {
                                    $rd = $fsr.Read($cbuf, 0, $cbuf.Length); if ($rd -le 0) { break }
                                    $frame = New-Object byte[] (7 + $rd)
                                    $frame[0] = 0x46
                                    [BitConverter]::GetBytes([uint16]$rid).CopyTo($frame, 1)
                                    [BitConverter]::GetBytes([uint32]$seq).CopyTo($frame, 3)
                                    [Array]::Copy($cbuf, 0, $frame, 7, $rd)
                                    $s.out.Enqueue(@{ bin = $frame }); $seq++; $sent += $rd
                                    while ($s.out.Count -gt 64 -and -not $s.stop) { Start-Sleep -Milliseconds 15 }
                                }
                                $fsr.Close()
                                # SHA-256 integrity: the viewer recomputes it over the received bytes and flags any
                                # mismatch. (Browsers can't compute MD5 natively; SHA-256 is stronger, same purpose.)
                                $sha = ''; try { $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } catch {}
                                $s.out.Enqueue(@{ text = (@{ t = 'file.end'; reqId = $rid; dir = 'down'; path = $path; bytes = $sent; sha256 = $sha; ok = $true } | ConvertTo-Json -Compress) })
                            } catch { $s.out.Enqueue(@{ text = (@{ t = 'file.end'; reqId = $rid; dir = 'down'; path = $path; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }) }
                        }
                        elseif ($ct -eq 'file.put') {
                            # Two modes: DIRECT (write to the path the operator chose) or INTERACTIVE (let the
                            # person at the PC pick the location via a Save dialog on their own screen). Either
                            # way we reply 'file.dest' with the final path (or cancelled) BEFORE the viewer streams
                            # the bytes, so the file is open and pointed at the right place first.
                            if (-not $s.allowFiles) { $s.out.Enqueue(@{ text = (@{ t = 'file.dest'; reqId = [int]$c.reqId; cancelled = $true; error = 'File transfer is disabled on this host by its administrator.' } | ConvertTo-Json -Compress) }); continue }
                            $s.cFiles += 1
                            try {
                                if ($s.up) { try { $s.up.Close() } catch {} ; $s.up = $null }
                                $dest = [string]$c.path
                                $cancelled = $false
                                if ($c.interactive -eq $true) {
                                    # Show a Save dialog on the remote user's own screen (its own STA runspace so
                                    # the modal loop doesn't block this receive loop's apartment).
                                    $picked = $null
                                    try {
                                        $dsb = {
                                            param($fn)
                                            Add-Type -AssemblyName System.Windows.Forms
                                            $d = New-Object System.Windows.Forms.SaveFileDialog
                                            $d.Title = 'Support wants to send you a file - choose where to save it'
                                            $d.FileName = $fn
                                            $d.OverwritePrompt = $true
                                            $res = $d.ShowDialog()
                                            if ($res -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName } else { '' }
                                        }
                                        $drs = [RunspaceFactory]::CreateRunspace(); $drs.ApartmentState = 'STA'; $drs.Open()
                                        $dps = [PowerShell]::Create(); $dps.Runspace = $drs
                                        $null = $dps.AddScript($dsb).AddArgument([System.IO.Path]::GetFileName($dest))
                                        $dout = $dps.Invoke()
                                        try { $dps.Dispose() } catch {}; try { $drs.Close() } catch {}
                                        if ($dout -and $dout.Count -gt 0) { $picked = [string]$dout[$dout.Count - 1] }
                                    } catch {}
                                    if ([string]::IsNullOrEmpty($picked)) { $cancelled = $true } else { $dest = $picked }
                                }
                                if ($cancelled) {
                                    $s.out.Enqueue(@{ text = (@{ t = 'file.dest'; reqId = $c.reqId; cancelled = $true } | ConvertTo-Json -Compress) })
                                } else {
                                    # Create any missing parent folders first, so a folder transfer can recreate its
                                    # subdirectory tree (e.g. dest\myfolder\sub\a.txt).
                                    $pd = [System.IO.Path]::GetDirectoryName($dest)
                                    if ($pd -and -not (Test-Path -LiteralPath $pd)) { [void][System.IO.Directory]::CreateDirectory($pd) }
                                    $s.upPath = $dest; $s.up = [System.IO.File]::Create($dest)
                                    $s.out.Enqueue(@{ text = (@{ t = 'file.dest'; reqId = $c.reqId; path = $dest } | ConvertTo-Json -Compress) })
                                }
                            } catch { $s.out.Enqueue(@{ text = (@{ t = 'file.dest'; reqId = $c.reqId; cancelled = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress) }) }
                        }
                        elseif ($ct -eq 'file.end') {
                            $bytes = 0; try { if ($s.up) { $bytes = $s.up.Length; $s.up.Close() } } catch {}
                            $up = $s.upPath; $s.up = $null
                            $sha = ''; try { if ($up -and (Test-Path -LiteralPath $up)) { $sha = (Get-FileHash -LiteralPath $up -Algorithm SHA256).Hash } } catch {}
                            try { if ($up) { $s.chatIn.Enqueue('Saved file: ' + $up + ' (' + $bytes + ' bytes)') } } catch {}
                            $s.out.Enqueue(@{ text = (@{ t = 'file.end'; reqId = $c.reqId; dir = 'up'; path = $up; bytes = $bytes; sha256 = $sha; ok = $true } | ConvertTo-Json -Compress) })
                        }
                    } catch {}
                }
            } catch { $s.stop = $true } finally { try { if ($s.up) { $s.up.Close() } } catch {}; try { $s.ws.Abort() } catch {} }
        }
        $ps = [PowerShell]::Create(); $null = $ps.AddScript($recv).AddArgument($shared)
        $rs = [RunspaceFactory]::CreateRunspace(); $rs.Open(); $ps.Runspace = $rs; $null = $ps.BeginInvoke()
        $Global:MediaWs = $ws; $Global:MediaShared = $shared; $Global:MediaRecvPs = $ps; $Global:MediaRecvRs = $rs
        Write-Log ('media socket open for session ' + $id)
        return $true
    } catch {
        $ie = $_.Exception; while ($ie.InnerException) { $ie = $ie.InnerException }
        Write-Log ('media socket failed (' + $ie.Message + ') - falling back to HTTP frames')
        Close-MediaWs
        return $false
    }
}

# Send one captured frame over the media socket as a binary V-frame: [ 'V' | w u16le | h u16le | skipped
# u16le | jpeg... ]. Returns $true if sent, $false if the socket is not usable (caller falls back to HTTP).
function Send-MediaFrame($shot) {
    if (-not $Global:MediaWs -or $Global:MediaWs.State -ne 'Open') { return $false }
    try {
        $jpeg = $shot.bytes
        $payload = New-Object byte[] (7 + $jpeg.Length)
        $payload[0] = 0x56  # 'V'
        [BitConverter]::GetBytes([uint16]$shot.w).CopyTo($payload, 1)
        [BitConverter]::GetBytes([uint16]$shot.h).CopyTo($payload, 3)
        [BitConverter]::GetBytes([uint16]([Math]::Min(65535, [int]$Global:SkippedFrames))).CopyTo($payload, 5)
        [Array]::Copy($jpeg, 0, $payload, 7, $jpeg.Length)
        $seg = New-Object System.ArraySegment[byte] (,$payload)
        $Global:MediaWs.SendAsync($seg, 'Binary', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        try { if ($Global:MediaShared) { $Global:MediaShared.cVideo += 1; $Global:MediaShared.bytesTx += [long]$payload.Length } } catch {}
        return $true
    } catch {
        $m = $_.Exception.Message
        if ($m -ne $Global:LastFrameErr) { Write-Log ('media frame: ' + $m); $Global:LastFrameErr = $m }
        return $false
    }
}

# Feed one 'D' frame (operator voice, [0x44][pcm16 mono 48k...]) to the WASAPI render queue. Called from
# the media receive runspace. No-op unless audio is running.
$Global:LastAudioErr = ''
function Play-RemoteAudio($bytes) {
    if (-not $Global:AudioOn) { return }
    try {
        $n = $bytes.Length - 1
        if ($n -lt 2) { return }
        $sc = [int][math]::Floor($n / 2)
        $pcm = New-Object short[] $sc
        [Buffer]::BlockCopy($bytes, 1, $pcm, 0, $sc * 2)
        [McmfAudio]::WriteRender($pcm)
    } catch {}
}

# Drain captured audio (system loopback + mic) and send it over the media socket as 'A' frames:
# [0x41][srcTag][pcm16 mono 48k...]. Called once per console-loop iteration; the WS is single-writer, so
# audio and video sends stay serialised on this one thread (never a concurrent SendAsync).
function Pump-Audio {
    if (-not $Global:AudioOn) { return }
    if (-not $Global:MediaWs -or $Global:MediaWs.State -ne 'Open') { return }
    try {
        $sent = 0
        while ($sent -lt 60) {
            $chunk = [McmfAudio]::ReadCaptured()
            if (-not $chunk) { break }
            $frame = New-Object byte[] (1 + $chunk.Length)
            $frame[0] = 0x41
            [Array]::Copy($chunk, 0, $frame, 1, $chunk.Length)
            $seg = New-Object System.ArraySegment[byte] (,$frame)
            $Global:MediaWs.SendAsync($seg, 'Binary', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            try { if ($Global:MediaShared) { $Global:MediaShared.bytesTx += [long]$frame.Length } } catch {}
            $sent++
        }
    } catch {
        $m = $_.Exception.Message
        if ($m -ne $Global:LastAudioErr) { Write-Log ('audio send: ' + $m); $Global:LastAudioErr = $m }
    }
}

# Drain the shared outbound queue (chat replies, fs listings, file-download chunks) that the receive
# runspace and chat window fill, and send each over the media socket. The socket is single-writer, so ALL
# sends - video, audio, and these - go through this one console-loop thread; the runspaces only enqueue.
function Pump-Out {
    if (-not $Global:MediaWs -or $Global:MediaWs.State -ne 'Open') { return }
    if (-not $Global:MediaShared -or -not $Global:MediaShared.out) { return }
    $q = $Global:MediaShared.out
    try {
        $n = 0
        while ($q.Count -gt 0 -and $n -lt 120) {
            $item = $q.Dequeue()
            if ($item.text) {
                $b = [System.Text.Encoding]::UTF8.GetBytes([string]$item.text)
                $seg = New-Object System.ArraySegment[byte] (,$b)
                $Global:MediaWs.SendAsync($seg, 'Text', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
                try { if ($Global:MediaShared) { $Global:MediaShared.bytesTx += [long]$b.Length } } catch {}
            } elseif ($item.bin) {
                $bb = [byte[]]$item.bin
                $seg = New-Object System.ArraySegment[byte] (,$bb)
                $Global:MediaWs.SendAsync($seg, 'Binary', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
                try { if ($Global:MediaShared) { $Global:MediaShared.bytesTx += [long]$bb.Length } } catch {}
            }
            $n++
        }
    } catch {
        $m = $_.Exception.Message
        if ($m -ne $Global:LastOutErr) { Write-Log ('media out: ' + $m); $Global:LastOutErr = $m }
    }
}

# Show a small always-on-top chat window on the remote user's desktop (own STA runspace with its own
# message loop, so it never blocks capture). Incoming operator chat is polled from $shared.chatIn; the
# user's replies are enqueued to $shared.out as {t:'chat'} frames. Started on the first message.
$Global:ChatPs = $null
$Global:ChatRs = $null
$Global:LastOutErr = ''
function Start-ChatWindow {
    if ($Global:ChatPs) { return }
    if (-not $Global:MediaShared) { return }
    $sb = {
        param($s)
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        # Swallow UI-thread exceptions (timer ticks / button clicks / teardown races) instead of popping the
        # .NET "Unhandled exception - The pipeline has been stopped" dialog on the remote user's screen when
        # the window is torn down (e.g. a media-socket reconnect closes this runspace mid-message-loop).
        try {
            [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
            [System.Windows.Forms.Application]::add_ThreadException({ param($sn, $ea) })
        } catch {}
        $f = New-Object System.Windows.Forms.Form
        $f.Text = 'MCMF Support Chat'
        $f.Size = New-Object System.Drawing.Size(340, 420)
        $f.TopMost = $true
        $f.ShowInTaskbar = $true
        $f.StartPosition = 'Manual'
        $f.Location = New-Object System.Drawing.Point(40, 40)
        # Make sure it actually surfaces on the user's desktop rather than opening behind other windows.
        $f.Add_Shown({ try { $f.WindowState = 'Normal'; $f.Activate(); $f.BringToFront() } catch {} })
        $log = New-Object System.Windows.Forms.TextBox
        $log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'; $log.Dock = 'Fill'
        $bar = New-Object System.Windows.Forms.Panel; $bar.Dock = 'Bottom'; $bar.Height = 58
        $inp = New-Object System.Windows.Forms.TextBox; $inp.Multiline = $true; $inp.Dock = 'Fill'
        $btn = New-Object System.Windows.Forms.Button; $btn.Text = 'Send'; $btn.Dock = 'Right'; $btn.Width = 70
        $send = {
            $t = $inp.Text.Trim()
            if ($t.Length -gt 0) {
                $s.out.Enqueue(@{ text = (@{ t = 'chat'; text = $t } | ConvertTo-Json -Compress) })
                $log.AppendText('You: ' + $t + [Environment]::NewLine)
                $inp.Clear()
            }
        }
        $btn.Add_Click($send)
        $inp.Add_KeyDown({ param($sn, $e) if ($e.KeyCode -eq 'Return' -and -not $e.Shift) { $e.SuppressKeyPress = $true; & $send } })
        $bar.Controls.Add($inp); $bar.Controls.Add($btn)
        # Incoming file offers appear here as Save buttons; the download starts only when the user clicks.
        $offers = New-Object System.Windows.Forms.FlowLayoutPanel
        $offers.Dock = 'Top'; $offers.AutoSize = $true; $offers.AutoSizeMode = 'GrowAndShrink'
        $offers.WrapContents = $true; $offers.BackColor = [System.Drawing.Color]::FromArgb(238, 242, 255)
        $f.Controls.Add($log); $f.Controls.Add($bar); $f.Controls.Add($offers)
        $fmtKb = { param($n) if ($n -ge 1048576) { '' + [Math]::Round($n/1048576,1) + ' MB' } elseif ($n -ge 1024) { '' + [Math]::Round($n/1024) + ' KB' } else { '' + $n + ' B' } }
        # The agent runs as SYSTEM, so a Save dialog would default to the systemprofile Desktop (which does
        # not exist -> "Location is not available"). Resolve the SIGNED-IN user's folder ROBUSTLY and open
        # there. Never rely on one method: try the interactive user, then explorer.exe's owner, then just
        # enumerate the real profiles under C:\Users.
        $userDir = $null
        $usersRoot = Join-Path $env:SystemDrive 'Users'
        $names = New-Object System.Collections.ArrayList
        try { $cu = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName; if ($cu) { [void]$names.Add($cu.Split('\')[-1]) } } catch {}
        try { $ep = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($ep) { $ow = Invoke-CimMethod -InputObject $ep -MethodName GetOwner -ErrorAction SilentlyContinue; if ($ow -and $ow.User) { [void]$names.Add($ow.User) } } } catch {}
        foreach ($u in $names) {
            foreach ($sub in @('Downloads', 'Desktop', 'Documents', '')) {
                $p = Join-Path (Join-Path $usersRoot $u) $sub
                if (Test-Path -LiteralPath $p) { $userDir = $p; break }
            }
            if ($userDir) { break }
        }
        if (-not $userDir) {
            try {
                Get-ChildItem $usersRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -notmatch '^(Public|Default|Default User|All Users|systemprofile|.NET.*)$' } |
                    Sort-Object LastWriteTime -Descending | ForEach-Object {
                        if (-not $userDir) { foreach ($sub in @('Downloads', 'Desktop', '')) { $p = Join-Path $_.FullName $sub; if (Test-Path -LiteralPath $p) { $userDir = $p; break } } }
                    }
            } catch {}
        }
        # Tracks the button of the in-progress download so the timer can show a live percentage on it.
        $dl = @{ btn = $null; name = ''; done = $false }
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 300
        $timer.Add_Tick({
            try { while ($s.chatIn.Count -gt 0) { $log.AppendText('Support: ' + [string]$s.chatIn.Dequeue() + [Environment]::NewLine) } } catch {}
            # A file the operator is offering: show a Save button. Clicking it asks WHERE to save, then the
            # transfer begins (nothing downloads until the user chooses).
            try {
                while ($s.fileOffers.Count -gt 0) {
                    $of = $s.fileOffers.Dequeue()
                    $b = New-Object System.Windows.Forms.Button
                    $b.AutoSize = $true; $b.Margin = New-Object System.Windows.Forms.Padding(3)
                    if ($of.kind -eq 'folder') { $b.Text = 'Save folder: ' + $of.name + ' (' + $of.count + ' files, ' + (& $fmtKb $of.size) + ')' }
                    else { $b.Text = 'Save: ' + $of.name + ' (' + (& $fmtKb $of.size) + ')' }
                    $b.Tag = $of
                    $b.Add_Click({
                        param($sender, $e)
                        $o = $sender.Tag
                        if ($o.kind -eq 'folder') {
                            # A whole folder: pick the parent directory; the operator streams each file with its
                            # relative path and the agent recreates the subfolders (file.put makes parent dirs).
                            $fb = New-Object System.Windows.Forms.FolderBrowserDialog
                            $fb.Description = 'Support is sending you a folder - choose where to save it'
                            if ($userDir) { $fb.SelectedPath = $userDir }
                            if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                                $rid = Get-Random -Minimum 1 -Maximum 60000
                                $s.upBytes = [long]0; $s.upTotal = [long]$o.size; $dl.btn = $sender; $dl.name = $o.name; $dl.done = $false
                                $s.out.Enqueue(@{ text = (@{ t = 'file.pull'; offerId = $o.offerId; reqId = $rid; path = $fb.SelectedPath; folder = $true } | ConvertTo-Json -Compress) })
                                $sender.Text = 'Downloading folder ' + $o.name + '...'; $sender.Enabled = $false
                            }
                        } else {
                            $d = New-Object System.Windows.Forms.SaveFileDialog
                            $d.FileName = $o.name; $d.Title = 'Support is sending you a file - choose where to save it'; $d.OverwritePrompt = $true
                            # Classic-style dialog + explicit start folder: the modern Vista dialog probes the
                            # shell "Desktop" node for its sidebar, which under SYSTEM is the nonexistent
                            # systemprofile Desktop and pops "Location is not available". The classic one opens
                            # straight at InitialDirectory without that probe.
                            $d.AutoUpgradeEnabled = $false; $d.RestoreDirectory = $true
                            if ($userDir) { $d.InitialDirectory = $userDir } elseif (Test-Path -LiteralPath $usersRoot) { $d.InitialDirectory = $usersRoot }
                            if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                                try {
                                    if ($s.up) { try { $s.up.Close() } catch {} }
                                    $s.up = [System.IO.File]::Create($d.FileName); $s.upPath = $d.FileName
                                    $rid = Get-Random -Minimum 1 -Maximum 60000
                                    $s.upBytes = [long]0; $s.upTotal = [long]$o.size; $dl.btn = $sender; $dl.name = $o.name; $dl.done = $false
                                    $s.out.Enqueue(@{ text = (@{ t = 'file.pull'; offerId = $o.offerId; reqId = $rid; path = $d.FileName } | ConvertTo-Json -Compress) })
                                    $sender.Text = 'Downloading ' + $o.name + '...'; $sender.Enabled = $false
                                } catch { $sender.Text = 'Save failed: ' + $_.Exception.Message }
                            }
                        }
                    })
                    $offers.Controls.Add($b)
                }
            } catch {}
            # Live download progress on the active Save button (download acceleration for large files).
            try {
                if ($dl.btn -and $s.upTotal -gt 0) {
                    if ($s.upBytes -ge $s.upTotal) {
                        if (-not $dl.done) { $dl.btn.Text = 'Saved: ' + $dl.name; $dl.done = $true; $dl.btn = $null }
                    } else {
                        $pct = [Math]::Round(($s.upBytes / $s.upTotal) * 100)
                        $dl.btn.Text = 'Downloading ' + $dl.name + ': ' + $pct + '%'
                    }
                }
            } catch {}
            if ($s.stop) { try { $f.Close() } catch {} }
        })
        $timer.Start()
        [System.Windows.Forms.Application]::Run($f)
    }
    try {
        $rs = [RunspaceFactory]::CreateRunspace(); $rs.ApartmentState = 'STA'; $rs.Open()
        $ps = [PowerShell]::Create(); $ps.Runspace = $rs; $null = $ps.AddScript($sb).AddArgument($Global:MediaShared)
        $null = $ps.BeginInvoke()
        $Global:ChatPs = $ps; $Global:ChatRs = $rs
        Write-Log 'chat window opened'
    } catch { Write-Log ('chat window failed: ' + $_.Exception.Message) }
}
function Stop-ChatWindow {
    if (-not $Global:ChatPs) { $Global:ChatRs = $null; return }
    # Close GRACEFULLY: the window's timer polls $s.stop and calls $f.Close(), which ends its own message
    # loop and lets the runspace finish — rather than disposing the runspace out from under a running loop
    # (that throws PipelineStoppedException as an unhandled WinForms dialog on the user's screen). $Global:
    # MediaShared is the SAME object the chat window captured, so setting stop here reaches its timer.
    try { if ($Global:MediaShared) { $Global:MediaShared.stop = $true } } catch {}
    try { Start-Sleep -Milliseconds 350 } catch {}
    try { $Global:ChatPs.Dispose() } catch {}
    try { if ($Global:ChatRs) { $Global:ChatRs.Close() } } catch {}
    $Global:ChatPs = $null; $Global:ChatRs = $null
}

# Send one frame over the best available transport: the persistent media socket if it is open, else the
# original pipelined HTTP POST. Returns the server's stop reason, or $null to keep going. Motion gating,
# keep-alive and the skipped-frame counter are identical on both paths, so the server sees the same stream.
function Send-Frame-Auto([string]$id) {
    if ($Global:MediaWs -and $Global:MediaWs.State -eq 'Open') {
        try {
            if ($Global:MediaShared -and $Global:MediaShared.stop) { return ([string]$Global:MediaShared.stopReason) }
            $shot = Get-ScreenJpeg
            if (-not $shot) {
                $m = [string][McmfShot]::LastError
                if ($m -ne $Global:LastFrameErr) { Write-Log ('console capture: ' + $m); $Global:LastFrameErr = $m }
                return $null
            }
            if (-not (Test-ShouldSendFrame $shot)) { $Global:SkippedFrames++; return $null }
            if (Send-MediaFrame $shot) {
                $Global:LastSentHash = $shot.hash
                $Global:LastSentAt = [DateTime]::UtcNow
                $Global:SkippedFrames = 0
                return $null
            }
            # The socket went bad mid-stream: drop it and let the next frame go over HTTP.
            Write-Log 'media socket unusable - reverting to HTTP frames'
            Close-MediaWs
            return $null
        } catch { return $null }
    }
    return (Send-ConsoleFrame $id)
}

if ($Console) {
    Write-Log 'console capture helper starting (SYSTEM, physical console session)'
    try { [McmfWin]::SetProcessDPIAware() | Out-Null } catch {}   # capture real pixels on a scaled display
    Init-Capture
    $sess = $null; $fps = 10; $idle = 0
    $lastPoll = [DateTime]::MinValue
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        # Poll only every 30s WHILE STREAMING. This call is a synchronous HTTPS request on the very
        # thread that captures frames, and at 3s it was stalling the capture loop repeatedly -- measured
        # capture work is ~36ms/frame, yet the loop only managed ~3.6 grabs/sec. While a session is live
        # the frame reply already carries stop + input + quality, so the poll is only needed to discover
        # a session in the first place; keep it responsive (3s) when idle.
        $pollEvery = if ($sess) { 30 } else { 3 }
        if (([DateTime]::UtcNow - $lastPoll).TotalSeconds -ge $pollEvery) {
            $lastPoll = [DateTime]::UtcNow
            $res = $null
            try { $res = Invoke-RemoteApi 'agent/poll' @{ key = (Get-AuthKey $Cfg); hostname = $env:COMPUTERNAME } }
            catch { Write-Log ('console helper poll: ' + $_.Exception.Message) }
            if ($res -and $res.active -and $res.active.id) {
                if ($sess -ne [string]$res.active.id) { $sess = [string]$res.active.id; Reset-MotionState; $Global:ConTask = $null; Open-MediaWs $sess | Out-Null; Write-Log ('console helper capturing session ' + $sess) }
                if ($res.active.fps) { $fps = [int]$res.active.fps }
                Set-CaptureProfile $res.active
                $idle = 0
            } else { $sess = $null; $idle++ }
        }
        if (-not $sess) {
            # No active session: leave. This process can see the logon screen; it has no business
            # outliving the consent that justified starting it.
            Stop-Audio
            Stop-ChatWindow
            Close-MediaWs
            if ($idle -ge 2) { Write-Log 'console helper exiting (server reports no active session)'; break }
            Start-Sleep -Milliseconds 500
            continue
        }
        # The media socket carries chat + file transfer + two-way audio (video can fall back to HTTP, they
        # cannot). A transient drop (api restart / 502 / network blip) reverts to HTTP frames and silently
        # kills chat & file for the rest of the session. Reconnect it here so they recover automatically:
        # tear down the stale chat window + audio (they hold the dead socket's queues), then reopen — chat
        # reopens on the next message, audio on the next enable, video returns to the WS.
        if (-not $Global:MediaWs -or $Global:MediaWs.State -ne 'Open') {
            if (-not $Global:LastMediaTry -or ([DateTime]::UtcNow - $Global:LastMediaTry).TotalSeconds -ge 8) {
                $Global:LastMediaTry = [DateTime]::UtcNow
                Write-Log 'media socket down mid-session - reconnecting (restores chat/file/audio)'
                # Do NOT Stop-Audio: the WASAPI threads are socket-independent and the audio flag is now
                # preserved across the reopen, so two-way audio keeps flowing without a start/stop flap.
                # The chat window DOES need restarting (it captured the old socket's offer/chat queues).
                Stop-ChatWindow
                if (Open-MediaWs $sess) { Write-Log 'media socket reconnected' }
            }
        }
        $sw.Restart()
        $stop = Send-Frame-Auto $sess
        # The grab follows the input desktop itself (on its own thread). Report a desktop we cannot follow
        # once, and note which one we are on: "streaming Winlogon" is the whole point of this helper.
        $desk = [McmfShot]::LastDesktopError
        if ($desk -ne $Global:LastDeskErr) {
            $Global:LastDeskErr = $desk
            if ($desk) { Write-Log ('console helper cannot follow the input desktop: ' + $desk) }
            else { Write-Log ('console helper now capturing desktop: ' + [McmfShot]::Desktop()) }
        }
        # Two-way audio follows the server's audioEnabled flag, delivered on the media control channel.
        # Nothing is captured or played until the operator ticks the box (which sets this true).
        if ($Global:MediaShared) {
            if ($Global:MediaShared.audio -and $Cfg.AllowAudio -and -not $Global:AudioOn) { Start-Audio }
            elseif (-not $Global:MediaShared.audio -and $Global:AudioOn) { Stop-Audio }
        } elseif ($Global:AudioOn) { Stop-Audio }
        Pump-Audio
        # Render the admin's voice: the receive runspace queued the 'D' samples (it can't resolve the
        # McmfAudio Add-Type type); THIS runspace owns the type, so drain the queue into WriteRender here.
        if ($Global:AudioOn -and $Global:MediaShared) {
            try { while ($Global:MediaShared.renderQ.Count -gt 0) { [McmfAudio]::WriteRenderBytes([byte[]]$Global:MediaShared.renderQ.Dequeue()) } } catch {}
        }
        # Downlink (admin->PC) diagnostics: dRecv = 'D' samples that ARRIVED, played = samples written to the
        # speaker. dRecv=0 -> the operator's mic frames aren't reaching us (muted / not sent / relay). played=0
        # with dRecv>0 -> the render device isn't accepting audio (see the info/err string).
        if ($Global:AudioOn -and (-not $Global:LastAudioLog -or ([DateTime]::UtcNow - $Global:LastAudioLog).TotalSeconds -ge 3)) {
            $Global:LastAudioLog = [DateTime]::UtcNow
            $dr = 0; $rb = 0; try { $dr = [long]$Global:MediaShared.dRecv; $rb = [long]$Global:MediaShared.rxBin } catch {}
            $pk = 0; try { $pk = [int][McmfAudio]::GetRenderPeak() } catch {}
            try { Write-Log ('audio dl: rxBin=' + $rb + ' dRecv=' + $dr + ' peak=' + $pk + ' played=' + [McmfAudio]::RenderPlayed + ' info=[' + [McmfAudio]::RenderInfo + '] err=[' + [McmfAudio]::LastError + ']') } catch {}
            # Surface it to the operator's browser too, so a downlink problem is visible without log access.
            try { if ($Global:MediaShared) { $Global:MediaShared.out.Enqueue(@{ text = (@{ t = 'audio.stat'; rxBin = $rb; rxTag = [int]$Global:MediaShared.rxTag; rxLen = [int]$Global:MediaShared.rxLen; rxErr = [string]$Global:MediaShared.rxErr; recv = $dr; peak = $pk; played = [McmfAudio]::RenderPlayed; info = [string][McmfAudio]::RenderInfo; err = [string][McmfAudio]::LastError } | ConvertTo-Json -Compress) }) } } catch {}
        }
        # Chat + file transfer share the media socket. Open the chat window on first message; drain the
        # outbound queue (chat replies, folder listings, file-download chunks) filled by the runspaces.
        if ($Global:MediaShared -and $Global:MediaShared.chatShow -and -not $Global:ChatPs) { Start-ChatWindow }
        Pump-Out
        # Publish live remote-support counters (~every 2s) for the tray "About" dialog to read.
        if (-not $Global:LastStatsAt -or ([DateTime]::UtcNow - $Global:LastStatsAt).TotalSeconds -ge 2) {
            $Global:LastStatsAt = [DateTime]::UtcNow
            try {
                $ms = $Global:MediaShared
                $connected = [bool]($Global:MediaWs -and $Global:MediaWs.State -eq 'Open')
                @{ at = (Get-Date -Format s); connected = $connected; audioOn = [bool]$Global:AudioOn;
                   video = [long]$ms.cVideo; audio = [long]$ms.cAudio; chat = [long]$ms.cChat; files = [long]$ms.cFiles;
                   bytesTx = [long]$ms.bytesTx; bytesRx = [long]$ms.bytesRx;
                   allowAudio = [bool]$ms.allowAudio; allowChat = [bool]$ms.allowChat; allowFiles = [bool]$ms.allowFiles
                } | ConvertTo-Json -Compress | Set-Content -Path $Global:MediaStatsFile -Encoding UTF8 -ErrorAction SilentlyContinue
            } catch {}
        }
        if ($stop) {
            # Session over: zero the live counters so a stale "About" can't imply a session is still up.
            try { @{ at = (Get-Date -Format s); connected = $false } | ConvertTo-Json -Compress | Set-Content -Path $Global:MediaStatsFile -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
            Write-Log ('console helper stopping: ' + $stop); Stop-Audio; Stop-ChatWindow; Close-MediaWs; break
        }
        if ($Global:ConFps -and $Global:ConFps -gt 0) { $fps = $Global:ConFps }
        if ($Global:MediaShared -and $Global:MediaShared.fps -gt 0) { $fps = [int]$Global:MediaShared.fps }
        $wait = [int](1000 / $fps) - [int]$sw.ElapsedMilliseconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    }
    return
}

function Test-ConsoleHelperAlive {
    if (-not $Global:ConsolePid) { return $false }
    try { return [bool](Get-Process -Id $Global:ConsolePid -ErrorAction Stop) } catch { return $false }
}

# Called by the service when MCMF queues 'remote-console' (i.e. the server just flipped a session active).
function Start-ConsoleCapture {
    if (Test-ConsoleHelperAlive) { return ('console capture helper already running (pid ' + $Global:ConsolePid + ')') }
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $me = $PSCommandPath
    if (-not $me) { $me = $MyInvocation.MyCommand.Path }
    $cmd = '"' + $exe + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $me + '" -Console'
    $err = [McmfWin]::LaunchInConsoleSession($cmd)
    if ($err) {
        $Global:ConsolePid = 0
        Write-Log ('console capture helper NOT started: ' + $err)
        # Surfaced to the operator as a failed command, not swallowed: the difference matters, because it
        # is the difference between "you will see the lock screen" and "you will see it only while a user
        # is logged in and the tray is running".
        throw ('console capture unavailable: ' + $err + ' - falling back to tray capture (logged-in desktop only)')
    }
    $Global:ConsolePid = [McmfWin]::LastPid
    Write-Log ('console capture helper started (pid ' + $Global:ConsolePid + ', console session ' + [McmfWin]::LastSession + ')')
    return ('console capture helper started (pid ' + $Global:ConsolePid + ')')
}

# =====================================================================================
#  HEADLESS SERVICE ENGINE  (-Service)
#  Owns continuous telemetry (push + pull). Run by a SYSTEM scheduled task at BOOT with
#  restart-on-failure, so it stays online across logoff / reboot / crash — independent of
#  any interactive PowerShell window or tray session. Never returns to the tray code below.
# =====================================================================================
# ---- consent ack from the SERVICE ------------------------------------------------------------
# The tray is the only component that can ASK the person at the desk, so it owns the consent dialog.
# It must not be the only component that can ANSWER, though: it runs in the interactive session and
# can die or fail to start (a crashed tray, or a logon task stuck Queued), and when it does the host
# stops being connectable entirely -- every session sits at "pending" and expires after 60s with
# nothing in the UI explaining why. That is exactly what took a live machine offline.
#
# So the SYSTEM service acks too, but ONLY when no tray is running. A live tray still owns the flow
# and can prompt; a dead one no longer takes remote support down with it. The server decides what an
# ack means (prompt vs proceed) -- this only reports who is at the console.
$Global:SvcAcked = @{}

function Test-TrayRunning {
    try {
        $t = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like '*mcmf-tray-agent*' -and $_.CommandLine -notlike '*-Service*' -and $_.CommandLine -notlike '*-Console*'
        })
        return ($t.Count -gt 0)
    } catch { return $false }
}

# ---- keep the tray alive ----------------------------------------------------------------------
# After an update the installer restarts the tray with Start-ScheduledTask. That task runs as the
# interactive user and has been seen stuck in state 'Queued', leaving the machine with no tray icon --
# which is what "the update removed my agent" looked like from the console.
#
# The service nudges that task ONCE per process, and no more. An earlier version also launched the tray
# directly into the console session as a fallback: that raced with the scheduled task, produced two
# trays, and the pair of them kept re-triggering self-update in a loop that stopped frames flowing
# altogether. Connectivity does not depend on the tray any more (Poll-ConsentFromService covers it), so
# a best-effort nudge is the right amount of effort here -- anything more aggressive risks the machine.
$Global:TrayNudged = $false

function Ensure-TrayRunning {
    if ($Global:TrayNudged) { return }
    $Global:TrayNudged = $true
    if (Test-TrayRunning) { return }
    try {
        Start-ScheduledTask -TaskName 'MCMF Endpoint Agent' -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
        if (Test-TrayRunning) { Write-Log 'tray was not running - restarted it via its scheduled task' }
        else { Write-Log 'tray is not running and its scheduled task did not start it - remote support still works (the service answers consent), but there is no tray icon on this host' }
    } catch {
        Write-Log ('could not nudge the tray task: ' + $_.Exception.Message)
    }
}

function Poll-ConsentFromService {
    try {
        if (Test-TrayRunning) { return }   # the tray is alive: leave consent to it, it can prompt
        $res = Invoke-RemoteApi 'agent/poll' @{ key = (Get-AuthKey $Cfg); hostname = $env:COMPUTERNAME }
        if (-not $res -or -not $res.pending) { return }
        $id = [string]$res.pending.id
        if ($Global:SvcAcked.ContainsKey($id)) { return }
        $Global:SvcAcked[$id] = $true
        Write-Log ('no tray running - service answering the remote request ' + $id + ' from ' + $res.pending.operator)
        Invoke-RemoteApi ('sessions/' + $id + '/ack') @{ interactiveUser = (Get-LoggedInUser) } | Out-Null
    } catch {
        $m = $_.Exception.Message
        if ($m -ne $Global:LastSvcAckErr) { Write-Log ('service consent poll: ' + $m); $Global:LastSvcAckErr = $m }
    }
}

if ($Service) {
    Write-Log 'service engine starting (PURE OUTBOUND: push + command long-poll, no inbound port)'
    # Legacy inbound PULL listener only if explicitly re-enabled (Pull=$true). Default is outbound-only.
    if ($Cfg.Pull) { Ensure-FirewallRule | Out-Null; Start-Listener }
    Send-Heartbeat; Write-Status      # first push learns our AgentId for the command channel
    $last = [DateTime]::UtcNow
    $cfgStamp = try { (Get-Item $CfgFile -ErrorAction SilentlyContinue).LastWriteTimeUtc } catch { $null }
    while ($true) {
        if ($Cfg.Pull) { Pump-Listener }
        # The command long-poll IS the heartbeat of the outbound tunnel — it blocks up to ~35s, so
        # commands run near-real-time while telemetry pushes on the configured interval.
        Poll-Commands
        # Answer a pending remote request when no tray is there to do it (see Poll-ConsentFromService).
        Poll-ConsentFromService
        # ...and get the tray back, so "no tray" stays the exception rather than the steady state.
        Ensure-TrayRunning
        if (([DateTime]::UtcNow - $last).TotalSeconds -ge [int]$Cfg.HeartbeatSec) { $last=[DateTime]::UtcNow; Send-Heartbeat; Write-Status }
        # Hot-reload config when the tray UI saves changes.
        try {
            $w = (Get-Item $CfgFile -ErrorAction SilentlyContinue).LastWriteTimeUtc
            if ($w -and $w -ne $cfgStamp) { $cfgStamp=$w; $oldPull=$Cfg.Pull; $Global:Cfg=Load-Config
                if ($Cfg.Pull -and -not $oldPull) { Ensure-FirewallRule | Out-Null; Start-Listener }
                if (-not $Cfg.Pull -and $oldPull) { Stop-Listener }
                Write-Status }
        } catch {}
    }
    return
}

# ---- tray icon (interactive logon): settings / status / manual push only --------------
#  Continuous telemetry is owned by the SYSTEM service above, so the tray does NOT bind the
#  pull port or run a push loop (avoids a port-bind conflict and double-reporting).
# Elevated Settings-only launch (from Invoke-ElevatedSettings): show the dialog, then exit. No tray
# icon, no timers, no second agent -- this instance exists only to host Settings with admin rights.
if ($Settings) { Show-Settings; return }

$Global:Notify=New-Object System.Windows.Forms.NotifyIcon; $Global:Notify.Icon=[System.Drawing.SystemIcons]::Shield; $Global:Notify.Text='MCMF Endpoint Agent'; $Global:Notify.Visible=$true
$menu=New-Object System.Windows.Forms.ContextMenuStrip
$miOpen=$menu.Items.Add('Open settings (admin)'); $miStatus=$menu.Items.Add('Show status'); $miAbout=$menu.Items.Add('About / telemetry'); $miPush=$menu.Items.Add('Push now'); $miUpdate=$menu.Items.Add('Update agent now'); $miRestart=$menu.Items.Add('Restart agent (no reboot)'); $null=$menu.Items.Add('-'); $miHide=$menu.Items.Add('Hide icon (keep running)'); $miExit=$menu.Items.Add('Exit (stop agent)')
$Global:Notify.ContextMenuStrip=$menu
# Status balloon (outbound model): service running? · MCMF reachable? · command channel live? · last report/command.
function Format-Bytes([long]$b) {
    if ($b -ge 1073741824) { return ('{0:N2} GB' -f ($b / 1073741824)) }
    if ($b -ge 1048576)    { return ('{0:N2} MB' -f ($b / 1048576)) }
    if ($b -ge 1024)       { return ('{0:N1} KB' -f ($b / 1024)) }
    return ([string]$b + ' B')
}
function Read-MediaStats { try { if (Test-Path $Global:MediaStatsFile) { return (Get-Content $Global:MediaStatsFile -Raw | ConvertFrom-Json) } } catch {}; return $null }
# About / telemetry: one place that shows the version, where the agent talks to, how much telemetry it has
# sent/received, and what the current remote-support session has actually carried (video/audio/chat/files),
# plus which features are enabled. A Refresh button re-reads the live counters the -Console helper publishes.
function Show-About {
    $reach = if (Test-McmfReachable) { 'reachable' } else { 'NOT reachable' }
    $f = New-Object System.Windows.Forms.Form
    $f.Text = 'MCMF Endpoint Agent - About / telemetry'
    $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'Sizable'; $f.TopMost = $true
    $f.ClientSize = New-Object System.Drawing.Size(470, 500)
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Multiline = $true; $tb.ReadOnly = $true; $tb.ScrollBars = 'Vertical'; $tb.Dock = 'Fill'
    $tb.Font = New-Object System.Drawing.Font('Consolas', 9)
    $bar = New-Object System.Windows.Forms.Panel; $bar.Dock = 'Bottom'; $bar.Height = 40
    $btnR = New-Object System.Windows.Forms.Button; $btnR.Text = 'Refresh'; $btnR.Left = 12; $btnR.Top = 7; $btnR.Width = 90
    $btnC = New-Object System.Windows.Forms.Button; $btnC.Text = 'Close'; $btnC.Left = 110; $btnC.Top = 7; $btnC.Width = 90; $btnC.DialogResult = 'Cancel'
    $fill = {
        $st = Read-Status
        $push = if ($st -and $st.lastBeat) { $st.lastBeat } else { $Global:LastBeat }
        $bound = if ($st -and $st.listening) { 'listening on ' + $st.port } else { 'outbound only (no inbound port)' }
        $ms = Read-MediaStats
        $NL = [Environment]::NewLine
        $onoff = { param($v) if ($v) { 'ENABLED' } else { 'disabled' } }
        $t = 'MCMF ENDPOINT AGENT' + $NL + '===============================' + $NL
        $t += ('Agent version : ' + $Global:AgentVersion) + $NL
        $t += ('This machine  : ' + $env:COMPUTERNAME) + $NL
        $t += ('MCMF server   : ' + $Cfg.MCMFIP) + $NL
        $t += ('Port          : ' + $Cfg.Port + '  (' + $bound + ')') + $NL
        $t += ('MCMF status   : ' + $reach) + $NL + $NL
        $t += 'TELEMETRY (heartbeat to MCMF)' + $NL + '-------------------------------' + $NL
        $t += ('Push interval : ' + $Cfg.HeartbeatSec + ' s') + $NL
        $t += ('Last report   : ' + $push) + $NL
        $t += ('Reports sent  : ' + $Global:PushCount) + $NL
        $t += ('Data sent     : ' + (Format-Bytes $Global:PushTxBytes)) + $NL
        $t += ('Data received : ' + (Format-Bytes $Global:PushRxBytes)) + $NL + $NL
        $t += 'REMOTE SUPPORT (current / last session)' + $NL + '-------------------------------' + $NL
        if ($ms) {
            $conn = if ($ms.connected) { 'CONNECTED' } else { 'not connected' }
            $von  = if ($ms.audioOn) { 'on' } else { 'off' }
            $t += ('Session       : ' + $conn) + $NL
            $t += ('Video frames  : ' + [long]$ms.video) + $NL
            $t += ('Audio frames  : ' + [long]$ms.audio + '  (voice ' + $von + ')') + $NL
            $t += ('Chat messages : ' + [long]$ms.chat) + $NL
            $t += ('File transfers: ' + [long]$ms.files) + $NL
            $t += ('Data sent     : ' + (Format-Bytes ([long]$ms.bytesTx))) + $NL
            $t += ('Data received : ' + (Format-Bytes ([long]$ms.bytesRx))) + $NL
        } else {
            $t += 'No remote-support session has run since the agent started.' + $NL
        }
        $t += $NL + 'FEATURES ALLOWED ON THIS HOST' + $NL + '-------------------------------' + $NL
        $t += ('Screen view / console : ' + (& $onoff $Cfg.TunnelEnabled)) + $NL
        $t += ('Audio (voice)         : ' + (& $onoff $Cfg.AllowAudio)) + $NL
        $t += ('Chat                  : ' + (& $onoff $Cfg.AllowChat)) + $NL
        $t += ('File transfer         : ' + (& $onoff $Cfg.AllowFiles)) + $NL
        $tb.Text = $t
    }
    & $fill
    $btnR.Add_Click($fill)
    $bar.Controls.AddRange(@($btnR, $btnC))
    $f.Controls.Add($tb); $f.Controls.Add($bar)
    $f.AcceptButton = $btnR; $f.CancelButton = $btnC
    [void]$f.ShowDialog(); $f.Dispose()
}
function Show-Status {
    $st=Read-Status
    $svc=if ($st){'running'}else{'not detected'}
    $beat=if ($st -and $st.lastBeat){$st.lastBeat}else{$Global:LastBeat}
    $chan=if ($st -and $st.channel){'live (outbound)'}elseif($Global:AgentId){'live (outbound)'}else{'connecting…'}
    $reach=if (Test-McmfReachable){'reachable'}else{'NOT reachable'}
    $lastCmd=if ($st -and $st.lastCommand){$st.lastCommand}else{'none yet'}
    $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent — status'
    $Global:Notify.BalloonTipText="MCMF: $($Cfg.MCMFIP)`nAgent version: $($Global:AgentVersion)`nBackground service: $svc`nMCMF reachable: $reach`nCommand channel: $chan`nLast report: $beat`nLast command: $lastCmd`nUser: $(Get-LoggedInUser)"
    $Global:Notify.ShowBalloonTip(7000)
}
$miOpen.Add_Click({ Show-Settings })
# Left-click the tray icon → show STATUS (no admin needed); settings are still in the right-click menu.
$Global:Notify.Add_MouseClick({ param($s,$e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-Status } })
$miStatus.Add_Click({ Show-Status })
$miAbout.Add_Click({ Show-About })
$miPush.Add_Click({ Send-Heartbeat; Write-Status; $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent'; $Global:Notify.BalloonTipText="Push: $($Global:LastBeat)"; $Global:Notify.ShowBalloonTip(4000) })
$miUpdate.Add_Click({
    Invoke-SelfUpdate
    $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent'
    $Global:Notify.BalloonTipText="Updating to the latest agent from $($Cfg.MCMFIP)... the service restarts and the tray reloads on the new version in a moment."
    $Global:Notify.ShowBalloonTip(6000)
    # Self-update lays down the new script + restarts the SERVICE, but this TRAY keeps running the OLD
    # in-memory script (so Settings / About would still show old features). Reload the tray from the new
    # file once the update has had time to land, so the UI actually reflects the new version.
    try {
        $t = New-Object System.Windows.Forms.Timer; $t.Interval = 18000
        $t.Add_Tick({ $this.Stop(); Restart-Tray 0 })
        $t.Start()
    } catch {}
})
# "Restart agent" recovers a STUCK background service WITHOUT rebooting the machine (production hosts
# cannot be rebooted on demand). The tray is a separate process with its own message loop, so it stays
# clickable even if the SYSTEM service has hung. This kills the service + any console-capture helper and
# relaunches the boot task fresh; a live remote session's capture restarts automatically after.
$miRestart.Add_Click({
    if (-not (Unlock-Admin)) { return }
    if ([System.Windows.Forms.MessageBox]::Show("Restart the MCMF background service now?`n`nNo reboot is needed. Telemetry, the command channel and remote console reconnect within a few seconds. Use this to recover an agent that has stopped reporting.","MCMF Endpoint Agent",'YesNo','Question') -ne 'Yes') { return }
    $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent'
    $Global:Notify.BalloonTipText='Restarting the background service (no reboot)...'
    $Global:Notify.ShowBalloonTip(4000)
    try { Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*mcmf-tray-agent*' -and ($_.CommandLine -like '*-Service*' -or $_.CommandLine -like '*-Console*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
    Start-Sleep -Milliseconds 800
    try { schtasks /end /tn 'MCMF Endpoint Agent (Service)' 2>$null | Out-Null } catch {}
    try { schtasks /run /tn 'MCMF Endpoint Agent (Service)' 2>$null | Out-Null } catch {}
    Start-Sleep -Milliseconds 1500
    $Global:Notify.BalloonTipText='Background service restarted. Reporting should resume within a few seconds.'
    $Global:Notify.ShowBalloonTip(5000)
})
# "Hide icon" only removes the tray icon for this session — the background service keeps reporting.
$miHide.Add_Click({ $Global:Notify.Visible=$false; [System.Windows.Forms.Application]::Exit() })
# "Exit (stop agent)" STOPS the agent now — tray + the SYSTEM background service. It does NOT unregister
# the boot task, so the agent AUTO-STARTS again after a reboot; or start it now from the Desktop / Start-menu
# "MCMF Endpoint Agent" shortcut. (The logon tray runs elevated, so it can stop the SYSTEM service task.)
$miExit.Add_Click({
    # Stopping the agent is privileged — gate it behind the admin password (same gate as Settings).
    if (-not (Unlock-Admin)) { return }
    if ([System.Windows.Forms.MessageBox]::Show("Stop the MCMF agent now?`n`nMonitoring and the console tunnel stop until you start it again (Desktop / Start-menu shortcut) or reboot (it auto-starts on boot).","MCMF Endpoint Agent",'YesNo','Question') -ne 'Yes') { return }
    try { Stop-ScheduledTask -TaskName 'MCMF Endpoint Agent (Service)' -ErrorAction SilentlyContinue } catch {}
    try { schtasks /end /tn 'MCMF Endpoint Agent (Service)' 2>$null | Out-Null } catch {}
    try { Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*mcmf-tray-agent*' -and $_.CommandLine -like '*-Service*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
    $Global:Notify.Visible=$false; [System.Windows.Forms.Application]::Exit()
})

# ---------------------------------------------------------------------------
# Attended remote support: the consent prompt.
# ONLY the tray can do this. It is the component that runs inside the interactive
# session; the SYSTEM service sits in session 0 and has no desktop to draw on.
# Poll -> ack (tells MCMF who is at the console) -> ask -> answer. Nothing is
# captured until the server flips the session to active.
# ---------------------------------------------------------------------------
$Global:ConsentBusy = $false
$Global:ConsentSeen = @{}
# Sessions the SERVER told us the console helper owns. Without this the tray would notice the session is
# still active on its next 3s poll and restart the capture it was just told to stop, forever.
$Global:CapDenied = @{}

function Show-ConsentDialog($req, [int]$seconds) {
    $f = New-Object System.Windows.Forms.Form
    $f.Text = 'Remote support request'
    $f.Width = 460; $f.Height = 250; $f.StartPosition = 'CenterScreen'
    $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
    $f.TopMost = $true   # a consent prompt the user cannot see is not consent
    $l1 = New-Object System.Windows.Forms.Label
    $l1.Text = ("" + $req.operator + " is asking to view this computer's screen.")
    $l1.Left = 16; $l1.Top = 16; $l1.Width = 420; $l1.Height = 34
    $l2 = New-Object System.Windows.Forms.Label
    $l2.Text = ("Reason: " + $req.reason)
    $l2.Left = 16; $l2.Top = 54; $l2.Width = 420; $l2.Height = 34
    $l3 = New-Object System.Windows.Forms.Label
    $l3.Text = 'Your screen will be shown and recorded while the session is open.'
    $l3.Left = 16; $l3.Top = 92; $l3.Width = 420; $l3.Height = 20
    $l4 = New-Object System.Windows.Forms.Label
    $l4.Left = 16; $l4.Top = 118; $l4.Width = 420; $l4.Height = 20
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'Allow'; $ok.Left = 250; $ok.Top = 160; $ok.Width = 90; $ok.DialogResult = 'OK'
    $no = New-Object System.Windows.Forms.Button
    $no.Text = 'Decline'; $no.Left = 346; $no.Top = 160; $no.Width = 90; $no.DialogResult = 'Cancel'
    $f.AcceptButton = $ok; $f.CancelButton = $no
    $f.Controls.AddRange(@($l1, $l2, $l3, $l4, $ok, $no))
    # Count the prompt down so the user can see it will proceed on its own.
    $left = $seconds
    $l4.Text = ("Starts automatically in " + $left + "s if you do not answer.")
    $t = New-Object System.Windows.Forms.Timer
    $t.Interval = 1000
    $t.Add_Tick({
        $script:left = $script:left - 1
        if ($script:left -le 0) { $t.Stop(); $f.DialogResult = 'Ignore'; $f.Close() }
        else { $l4.Text = ("Starts automatically in " + $script:left + "s if you do not answer.") }
    })
    $script:left = $left
    $t.Start()
    $r = $f.ShowDialog()
    $t.Stop(); $f.Dispose()
    return $r
}

function Poll-Consent {
    if ($Global:ConsentBusy) { return }
    try {
        $res = Invoke-RemoteApi 'agent/poll' @{ key = (Get-AuthKey $Cfg); hostname = $env:COMPUTERNAME }
        if (-not $res -or -not $res.pending) { return }
        $req = $res.pending
        if ($Global:ConsentSeen.ContainsKey($req.id)) { return }
        $Global:ConsentBusy = $true
        $Global:ConsentSeen[$req.id] = $true
        Write-Log ('remote consent requested by ' + $req.operator + ' (' + $req.id + ')')
        # Tell MCMF who is at this console. The server decides prompt-vs-proceed from this.
        $ack = Invoke-RemoteApi ('sessions/' + $req.id + '/ack') @{ interactiveUser = (Get-LoggedInUser) }
        # UNATTENDED MODE: the server flips the session straight to active on ack when consent is not
        # required for this deployment. There is nothing to ask, so do not draw a dialog - just note it.
        # Capture still only starts because the SERVER reports the session active, never on our say-so.
        if ($ack -and ($ack.status -eq 'active' -or $ack.consent -eq 'not-required')) {
            Write-Log ('remote session ' + $req.id + ' started by ' + $req.operator + ' (unattended - no consent prompt required by policy)')
            return
        }
        $secs = 30
        if ($ack -and $ack.consentSecondsLeft) { $secs = [int]$ack.consentSecondsLeft }
        $r = Show-ConsentDialog $req $secs
        if ($r -eq 'OK') {
            Invoke-RemoteApi ('sessions/' + $req.id + '/consent') @{ accept = $true; user = (Get-LoggedInUser) } | Out-Null
            Write-Log ('remote consent ALLOWED for ' + $req.id)
            $Global:Notify.BalloonTipTitle = 'MCMF Endpoint Agent'
            $Global:Notify.BalloonTipText = 'Remote support session started. Your screen is being shown and recorded.'
            $Global:Notify.ShowBalloonTip(6000)
        } elseif ($r -eq 'Cancel') {
            Invoke-RemoteApi ('sessions/' + $req.id + '/consent') @{ accept = $false; user = (Get-LoggedInUser) } | Out-Null
            Write-Log ('remote consent DECLINED for ' + $req.id)
        } else {
            # No answer. The server auto-accepts on its own timer; do not claim the user agreed.
            Write-Log ('remote consent NOT answered for ' + $req.id + ' (server policy decides)')
        }
    } catch {
        Write-Log ('consent poll: ' + $_.Exception.Message)
    } finally {
        $Global:ConsentBusy = $false
    }
}

# ---------------------------------------------------------------------------
# TRAY capture — the FALLBACK path, for hosts where the service could not start
# the SYSTEM console helper. It can only ever see this user's own desktop and
# goes black the moment the screen locks, so the server hands the session to the
# console helper whenever both are alive (see capture-arbiter). We only ever
# capture while the SERVER says the session is active: every frame POST returns
# stop=true the moment consent is withdrawn or the session ends.
# ---------------------------------------------------------------------------
function Stop-Capture([string]$why) {
    if ($Global:CapSession) { Write-Log ('remote capture stopped (' + $why + ') for ' + $Global:CapSession) }
    $Global:CapSession = $null
    $Global:CapTask = $null
    if ($Global:CaptureTimer) { $Global:CaptureTimer.Stop() }
}

function Send-Frame {
    if (-not $Global:CapSession) { return }
    # Read the PREVIOUS post's reply here, on the UI thread, instead of in a continuation.
    #
    # Task.ContinueWith with a scriptblock cannot be resolved on some PowerShell 5.1 builds -- it
    # cannot choose between the Action<Task> / Action<Task<T>> overloads and throws "Multiple ambiguous
    # overloads found for ContinueWith". That fires once per frame, ten times a second, and it is what
    # took the tray down on a live machine: the tray is the ONLY component that answers the consent
    # ack, so once it dies every session sits at "pending" and expires, and the host simply stops
    # being connectable. Polling the task on the next tick needs no delegate at all.
    if ($Global:CapTask) {
        if ($Global:CapTask.IsCompleted) {
            try {
                if (-not $Global:CapTask.IsFaulted -and -not $Global:CapTask.IsCanceled) {
                    $r = $Global:CapTask.Result.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                    if ($r.stop) { $Global:StopReason = [string]$r.reason; if ($r.handover) { $Global:StopHandover = $true } }
                    # Injection still happens on the capture thread (the one attached to the desktop);
                    # this only hands the ops over, and the queue is lock-guarded.
                    if ($r.input -and $r.input.Count -gt 0) { try { [McmfShot]::Queue([int[]]$r.input) } catch {} }
                }
            } catch {
                $m = $_.Exception.Message
                if ($m -ne $Global:LastPostErr) { Write-Log ('frame reply: ' + $m); $Global:LastPostErr = $m }
            }
            $Global:CapTask = $null
        } else {
            # Still in flight. Skipping this tick is the right backpressure: piling more posts onto a
            # slow link would queue frames we would only have to drop.
            return
        }
    }
    try {
        Init-Capture
        $shot = Get-ScreenJpeg
        if (-not $shot) { return }
        if (-not (Test-ShouldSendFrame $shot)) { $Global:SkippedFrames++; return }
        # Build the JSON by hand rather than with ConvertTo-Json. The payload is a ~120KB base64 string,
        # and ConvertTo-Json re-scans and escapes the whole thing on every frame -- one of the slowest
        # things PowerShell 5.1 can be asked to do at 10fps. Base64 only ever contains A-Z a-z 0-9 + / =,
        # none of which need JSON escaping, so plain concatenation is both correct and far cheaper.
        $body = '{"jpeg":"' + $shot.b64 + '","w":' + [int]$shot.w + ',"h":' + [int]$shot.h + ',"source":"tray","skipped":' + [int]$Global:SkippedFrames + '}'
        $uri = "https://" + $Cfg.MCMFIP + "/api/remote/sessions/" + $Global:CapSession + "/frame"
        $content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, 'application/json')
        # Fire-and-forget: awaiting a 10 fps POST on the UI thread would freeze the desktop we capture.
        $Global:CapTask = $Global:CapHttp.PostAsync($uri, $content)
        # Optimistic: count it sent now. A failed POST only suppresses the next identical grab, which
        # the 2s keep-alive corrects on its own.
        $Global:LastSentHash = $shot.hash
        $Global:LastSentAt = [DateTime]::UtcNow
        $Global:SkippedFrames = 0
    } catch {
        # Deduplicate: at 10 fps a persistent error would otherwise write 600 log lines a minute -- the
        # exact flood that buried the real failure on the machine this was found on.
        $m = $_.Exception.Message
        if ($m -ne $Global:LastFrameErr) { Write-Log ('frame: ' + $m); $Global:LastFrameErr = $m }
    }
    # The server's stop verdict is applied here, on the UI thread.
    if ($Global:StopReason) {
        $r = $Global:StopReason; $Global:StopReason = $null
        # A handover means the console helper has the session: stand down for good rather than restart
        # capture on the next poll and fight it.
        if ($Global:StopHandover) { $Global:StopHandover = $false; if ($Global:CapSession) { $Global:CapDenied[$Global:CapSession] = $true } }
        Stop-Capture $r
    }
}

$Global:CaptureTimer = New-Object System.Windows.Forms.Timer
$Global:CaptureTimer.Interval = 100   # 10 fps
$Global:CaptureTimer.Add_Tick({ Send-Frame })

$Global:ConsentTimer = New-Object System.Windows.Forms.Timer
$Global:ConsentTimer.Interval = 3000
$Global:ConsentTimer.Add_Tick({
    Poll-Consent
    # Start/stop capture purely from what the SERVER reports as active.
    try {
        $res = Invoke-RemoteApi 'agent/poll' @{ key = (Get-AuthKey $Cfg); hostname = $env:COMPUTERNAME }
        if ($res -and $res.active -and $res.active.id) {
            if ($Global:CapSession -ne $res.active.id -and -not $Global:CapDenied.ContainsKey([string]$res.active.id)) {
                $Global:CapSession = [string]$res.active.id
                Reset-MotionState
                $fps = 10; if ($res.active.fps) { $fps = [int]$res.active.fps }
                $Global:CaptureTimer.Interval = [Math]::Max(50, [int](1000 / $fps))
                Init-Capture
                Set-CaptureProfile $res.active
                $Global:CaptureTimer.Start()
                Write-Log ('remote capture started for ' + $Global:CapSession + ' at ' + $fps + ' fps')
            }
        } elseif ($Global:CapSession) {
            Stop-Capture 'server no longer reports the session active'
        }
    } catch {}
})
$Global:ConsentTimer.Start()

Write-Log 'tray UI started (settings/status only; telemetry handled by the background service)'
[System.Windows.Forms.Application]::Run()
