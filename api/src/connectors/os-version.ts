// Derive a clean OS-version label from each cloud's image metadata so the OS Inventory shows real
// versions (Windows Server 2022, Ubuntu 22.04, RHEL 9) instead of just the family. Output strings
// are shaped to feed agent.service osInventory()'s universal version parser.

/** Azure: storageProfile.imageReference { publisher, offer, sku }. */
export function azureOsVersion(ref: any): string | undefined {
  if (!ref) return undefined;
  const blob = `${ref.publisher ?? ''} ${ref.offer ?? ''} ${ref.sku ?? ''}`.toLowerCase();
  const sku = String(ref.sku ?? '').toLowerCase();
  if (/windowsserver|windows-server/.test(blob) || /^\d{4}[-_]/.test(sku)) {
    const y = (blob.match(/(20\d\d)/) ?? [])[1];
    if (y) return `Windows Server ${y}`;
  }
  if (/windows[-_ ]?11|win11/.test(blob)) return 'Windows 11';
  if (/windows[-_ ]?10|win10/.test(blob)) return 'Windows 10';
  if (/ubuntu/.test(blob)) { const v = (blob.match(/(\d{2})[_.](\d{2})/) ?? [])[0]?.replace('_', '.'); return v ? `Ubuntu ${v}` : 'Ubuntu'; }
  if (/rhel|red[\s-]?hat/.test(blob)) { const v = (sku.match(/(\d+)(?:[_.](\d+))?/) ?? [])[0]?.replace('_', '.'); return v ? `RHEL ${v}` : 'RHEL'; }
  if (/sles|suse/.test(blob)) { const v = (blob.match(/(\d+)/) ?? [])[1]; return v ? `SLES ${v}` : 'SUSE'; }
  if (/debian/.test(blob)) { const v = (blob.match(/debian[-_]?(\d+)/) ?? [])[1]; return v ? `Debian ${v}` : 'Debian'; }
  if (/centos/.test(blob)) { const v = (blob.match(/(\d+)/) ?? [])[1]; return v ? `CentOS ${v}` : 'CentOS'; }
  if (/oracle/.test(blob)) return 'Oracle Linux';
  const raw = `${ref.offer ?? ''} ${ref.sku ?? ''}`.trim();
  return raw || undefined;
}

/** AWS: AMI Name (+ PlatformDetails as a family fallback). */
export function awsOsVersion(imageName?: string, platformDetails?: string): string | undefined {
  const n = String(imageName ?? '');
  const pd = String(platformDetails ?? '');
  let m: RegExpMatchArray | null;
  if ((m = n.match(/Windows_Server-(\d{4})/i))) return `Windows Server ${m[1]}`;
  if ((m = n.match(/RHEL[-_ ](\d+(?:\.\d+)?)/i))) return `RHEL ${m[1]}`;
  if ((m = n.match(/ubuntu[-/ ].*?(\d{2}\.\d{2})/i))) return `Ubuntu ${m[1]}`;
  if (/al2023|amazon[-_ ]linux[-_ ]2023/i.test(n)) return 'Amazon Linux 2023';
  if (/amzn2|amazon[-_ ]linux[-_ ]2/i.test(n)) return 'Amazon Linux 2';
  if ((m = n.match(/suse[-_ ]sles[-_ ](\d+)/i))) return `SLES ${m[1]}`;
  if ((m = n.match(/debian[-_ ](\d+)/i))) return `Debian ${m[1]}`;
  if ((m = n.match(/centos[-_ ](\d+)/i))) return `CentOS ${m[1]}`;
  if ((m = n.match(/rocky[-_ ](\d+)/i))) return `Rocky Linux ${m[1]}`;
  if (/windows/i.test(pd)) return 'Windows';
  if (/red hat/i.test(pd)) return 'RHEL';
  if (/suse/i.test(pd)) return 'SLES';
  if (/ubuntu/i.test(pd)) return 'Ubuntu';
  return undefined;
}

/** GCP: disks[].licenses URLs (e.g. .../rhel-cloud/.../rhel-9-server, .../windows-server-2022-dc). */
export function gcpOsVersion(licenses?: string[]): string | undefined {
  for (const url of licenses ?? []) {
    const s = String(url).toLowerCase();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/windows-server-(\d{4})/))) return `Windows Server ${m[1]}`;
    if ((m = s.match(/windows-(10|11)/))) return `Windows ${m[1]}`;
    if ((m = s.match(/ubuntu-(\d{2})(\d{2})/))) return `Ubuntu ${m[1]}.${m[2]}`;
    if ((m = s.match(/rhel-(\d+)/))) return `RHEL ${m[1]}`;
    if ((m = s.match(/rocky-linux-(\d+)/))) return `Rocky Linux ${m[1]}`;
    if ((m = s.match(/debian-(\d+)/))) return `Debian ${m[1]}`;
    if ((m = s.match(/sles-(\d+)/))) return `SLES ${m[1]}`;
    if ((m = s.match(/centos-(?:stream-)?(\d+)/))) return `CentOS ${m[1]}`;
    if (/\bcos\b|container-optimized/.test(s)) return 'Container-Optimized OS';
  }
  return undefined;
}
