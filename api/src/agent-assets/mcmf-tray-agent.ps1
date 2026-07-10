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

param([switch]$Service)   # -Service = headless always-on engine (no tray UI). Run by the SYSTEM scheduled task.

$ErrorActionPreference = 'SilentlyContinue'
# The tray UI needs WinForms; the headless service does not (and runs in session 0 with no desktop).
if (-not $Service) { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing }

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

$Global:Mode    = if ($Service) { 'service' } else { 'tray' }
$Global:CfgDir  = Join-Path $env:ProgramData 'MCMF'
$Global:CfgFile = Join-Path $CfgDir 'agent-config.json'
$Global:LogFile = Join-Path $CfgDir 'agent.log'
$Global:StatusFile = Join-Path $CfgDir 'agent-status.json'
$Global:DefaultKey  = '__MCMF_KEY__'
$Global:DefaultIp   = '__MCMF_IP__'
$Global:DefaultPort = [int]'__MCMF_PORT__'
$Global:AgentVersion = '__AGENT_VERSION__'   # baked at download; reported on ingest; auto-updates if the server is newer
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
function Unlock-Admin {
    if (-not (Test-IsAdmin)) { [System.Windows.Forms.MessageBox]::Show('Run the agent as a local Administrator to open settings (right-click > Run as administrator).','MCMF Agent','OK','Warning')|Out-Null; return $false }
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
            'uninstall' {
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
    $f=New-Object System.Windows.Forms.Form; $f.Text='MCMF Endpoint Agent - Settings'; $f.Width=480; $f.Height=740; $f.StartPosition='CenterScreen'; $f.FormBorderStyle='FixedDialog'; $f.MaximizeBox=$false; $f.TopMost=$true; $f.AutoScroll=$true
    $y=16
    $lblIp=New-Object System.Windows.Forms.Label; $lblIp.Text='MCMF server IP / host:'; $lblIp.Left=16; $lblIp.Top=$y; $lblIp.Width=200
    $tbIp=New-Object System.Windows.Forms.TextBox; $tbIp.Left=220; $tbIp.Top=($y-3); $tbIp.Width=230; $tbIp.Text=$Cfg.MCMFIP; $y+=32
    $lblPort=New-Object System.Windows.Forms.Label; $lblPort.Text='Pull port (MCMF connects in):'; $lblPort.Left=16; $lblPort.Top=$y; $lblPort.Width=200
    $tbPort=New-Object System.Windows.Forms.TextBox; $tbPort.Left=220; $tbPort.Top=($y-3); $tbPort.Width=100; $tbPort.Text=[string]$Cfg.Port; $y+=32
    $lblHb=New-Object System.Windows.Forms.Label; $lblHb.Text='Push interval (sec):'; $lblHb.Left=16; $lblHb.Top=$y; $lblHb.Width=200
    $tbHb=New-Object System.Windows.Forms.TextBox; $tbHb.Left=220; $tbHb.Top=($y-3); $tbHb.Width=100; $tbHb.Text=[string]$Cfg.HeartbeatSec; $y+=32
    $cbPush=New-Object System.Windows.Forms.CheckBox; $cbPush.Text='Push out to MCMF (HTTPS)'; $cbPush.Left=16; $cbPush.Top=$y; $cbPush.Width=210; $cbPush.Checked=[bool]$Cfg.Push
    $cbPull=New-Object System.Windows.Forms.CheckBox; $cbPull.Text='Allow MCMF pull (listen on port)'; $cbPull.Left=232; $cbPull.Top=$y; $cbPull.Width=230; $cbPull.Checked=[bool]$Cfg.Pull; $y+=26
    $cbAny=New-Object System.Windows.Forms.CheckBox; $cbAny.Text='Allow pull from any network (uncheck = only the MCMF IPs below)'; $cbAny.Left=16; $cbAny.Top=$y; $cbAny.Width=446; $cbAny.Checked=[bool]$Cfg.AllowAnyNetwork; $y+=26
    $cbTunnel=New-Object System.Windows.Forms.CheckBox; $cbTunnel.Text='Allow console tunnel (browser RDP / SSH to this host) - uncheck to block all remote console'; $cbTunnel.Left=16; $cbTunnel.Top=$y; $cbTunnel.Width=446; $cbTunnel.Checked=[bool]$Cfg.TunnelEnabled; $y+=28
    $lblAllow=New-Object System.Windows.Forms.Label; $lblAllow.Text='Also allow pull from (extra MCMF IPs / CIDRs, comma-separated — e.g. failover/NAT):'; $lblAllow.Left=16; $lblAllow.Top=$y; $lblAllow.Width=446; $y+=18
    $tbAllow=New-Object System.Windows.Forms.TextBox; $tbAllow.Left=16; $tbAllow.Top=$y; $tbAllow.Width=434; $tbAllow.Text=[string]$Cfg.PullAllowFrom; $y+=34
    $tbAllow.Enabled = -not $cbAny.Checked
    $cbAny.Add_CheckedChanged({ $tbAllow.Enabled = -not $cbAny.Checked })
    $grp=New-Object System.Windows.Forms.GroupBox; $grp.Text='Telemetry to send to MCMF'; $grp.Left=16; $grp.Top=$y; $grp.Width=434; $grp.Height=234; $grp.AutoScroll=$true
    $cats=@('Cpu','Memory','Disk','Network','Services','EventLogs','LoggedInUser','Posture','NetStat','InstalledApps')
    $labels=@{ Cpu='CPU %'; Memory='Memory %'; Disk='Disk %'; Network='Network'; Services='Running services'; EventLogs='System event logs'; LoggedInUser='Logged-in Windows user (for AAA)'; Posture='Device posture: firewall / AV / encryption (for AAA)'; NetStat='Open ports + active connections to remote IPs'; InstalledApps='Installed applications inventory' }
    $boxes=@{}; $gy=24
    foreach ($c in $cats) { $cb=New-Object System.Windows.Forms.CheckBox; $cb.Text=$labels[$c]; $cb.Left=16; $cb.Top=$gy; $cb.Width=400; $cb.Checked=[bool]$Cfg.Send.$c; $grp.Controls.Add($cb); $boxes[$c]=$cb; $gy+=22 }
    $y+=244
    $lblStatus=New-Object System.Windows.Forms.Label; $lblStatus.Left=16; $lblStatus.Top=$y; $lblStatus.Width=434; $lblStatus.Height=58
    $refreshStatus={ $st=Read-Status; $bound=if ($st -and $st.listening) {'bound on '+$st.port} else {'off'}; $fw=if (Test-FirewallRule) {'open'} else {'off'}; $reach=if (Test-McmfReachable) {'reachable'} else {'NOT reachable'}; $beat=if ($st) {$st.lastBeat} else {$Global:LastBeat}; $lblStatus.Text="Background service: $(if($st){'running'}else{'not detected'})  |  Pull listener: $bound`nFirewall: $fw  |  MCMF (443): $reach`nLast push: $beat" }
    & $refreshStatus; $y+=66
    $btnPw=New-Object System.Windows.Forms.Button; $btnPw.Text='Change password'; $btnPw.Left=16; $btnPw.Top=$y; $btnPw.Width=130
    $btnPw.Add_Click({ $p1=Prompt-Password 'Change password' 'New admin password:'; if ([string]::IsNullOrEmpty($p1)) { return }; $p2=Prompt-Password 'Confirm' 'Re-enter:'; if ($p1 -ne $p2) { [System.Windows.Forms.MessageBox]::Show('Did not match.','MCMF',0,'Error')|Out-Null; return }; $salt=[guid]::NewGuid().ToString('N'); $Cfg.AdminSalt=$salt; $Cfg.AdminHash=(Hash-Password $salt $p1); Save-Config $Cfg; [System.Windows.Forms.MessageBox]::Show('Password updated.','MCMF',0,'Information')|Out-Null })
    $btnSave=New-Object System.Windows.Forms.Button; $btnSave.Text='Save & apply'; $btnSave.Left=250; $btnSave.Top=$y; $btnSave.Width=100; $btnSave.DialogResult='OK'
    $btnClose=New-Object System.Windows.Forms.Button; $btnClose.Text='Close'; $btnClose.Left=355; $btnClose.Top=$y; $btnClose.Width=95; $btnClose.DialogResult='Cancel'
    $btnSave.Add_Click({
        $Cfg.MCMFIP=$tbIp.Text.Trim(); $p=0; if ([int]::TryParse($tbPort.Text,[ref]$p) -and $p -gt 0) { $Cfg.Port=$p }
        $h=0; if ([int]::TryParse($tbHb.Text,[ref]$h) -and $h -ge 15) { $Cfg.HeartbeatSec=$h }
        $Cfg.Push=[bool]$cbPush.Checked; $Cfg.Pull=[bool]$cbPull.Checked; $Cfg.AllowAnyNetwork=[bool]$cbAny.Checked
        $Cfg.TunnelEnabled=[bool]$cbTunnel.Checked
        $Cfg.PullAllowFrom=$tbAllow.Text.Trim()
        foreach ($c in $cats) { $Cfg.Send.$c=[bool]$boxes[$c].Checked }
        # Save only — the background service hot-reloads agent-config.json and re-applies (firewall, listener, interval).
        Save-Config $Cfg; Send-Heartbeat; Start-Sleep -Milliseconds 600; & $refreshStatus
    })
    $f.Controls.AddRange(@($lblIp,$tbIp,$lblPort,$tbPort,$lblHb,$tbHb,$cbPush,$cbPull,$cbAny,$cbTunnel,$lblAllow,$tbAllow,$grp,$lblStatus,$btnPw,$btnSave,$btnClose)); $f.AcceptButton=$btnSave; $f.ShowDialog() | Out-Null
}

# =====================================================================================
#  HEADLESS SERVICE ENGINE  (-Service)
#  Owns continuous telemetry (push + pull). Run by a SYSTEM scheduled task at BOOT with
#  restart-on-failure, so it stays online across logoff / reboot / crash — independent of
#  any interactive PowerShell window or tray session. Never returns to the tray code below.
# =====================================================================================
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
$Global:Notify=New-Object System.Windows.Forms.NotifyIcon; $Global:Notify.Icon=[System.Drawing.SystemIcons]::Shield; $Global:Notify.Text='MCMF Endpoint Agent'; $Global:Notify.Visible=$true
$menu=New-Object System.Windows.Forms.ContextMenuStrip
$miOpen=$menu.Items.Add('Open settings (admin)'); $miStatus=$menu.Items.Add('Show status'); $miPush=$menu.Items.Add('Push now'); $miUpdate=$menu.Items.Add('Update agent now'); $null=$menu.Items.Add('-'); $miHide=$menu.Items.Add('Hide icon (keep running)'); $miExit=$menu.Items.Add('Exit (stop agent)')
$Global:Notify.ContextMenuStrip=$menu
# Status balloon (outbound model): service running? · MCMF reachable? · command channel live? · last report/command.
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
$miPush.Add_Click({ Send-Heartbeat; Write-Status; $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent'; $Global:Notify.BalloonTipText="Push: $($Global:LastBeat)"; $Global:Notify.ShowBalloonTip(4000) })
$miUpdate.Add_Click({ Invoke-SelfUpdate; $Global:Notify.BalloonTipTitle='MCMF Endpoint Agent'; $Global:Notify.BalloonTipText="Updating to the latest agent from $($Cfg.MCMFIP)… the service restarts on the new version shortly."; $Global:Notify.ShowBalloonTip(6000) })
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

Write-Log 'tray UI started (settings/status only; telemetry handled by the background service)'
[System.Windows.Forms.Application]::Run()
