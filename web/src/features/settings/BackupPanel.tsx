'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { PasswordInput } from '@/components/PasswordInput';
import { useBackup, useRestore } from '@/lib/hooks';

/**
 * Admin: encrypted backup & restore of cloud connections, the credential vault, and notification
 * integrations — with their secrets. The backup is sealed with a passphrase (independent of the
 * server key) so it's portable; keep the passphrase safe — it cannot be recovered.
 */
export function BackupPanel() {
  const backup = useBackup();
  const restore = useRestore();
  const [bp, setBp] = useState('');
  const [bp2, setBp2] = useState('');
  const [bmsg, setBmsg] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [rp, setRp] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [rmsg, setRmsg] = useState<{ ok: boolean; text: string } | null>(null);

  const inp = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none';

  const doBackup = async () => {
    setBmsg(null);
    if (bp.length < 8) { setBmsg('Passphrase must be at least 8 characters.'); return; }
    if (bp !== bp2) { setBmsg('Passphrases do not match.'); return; }
    try {
      const r = await backup.mutateAsync(bp);
      const blob = new Blob([r.file], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mcmf-backup-${new Date().toISOString().slice(0, 10)}.mcmfbackup`;
      a.click();
      URL.revokeObjectURL(a.href);
      setBmsg(`Backup downloaded: ${r.counts.connections} connections · ${r.counts.vault} vault · ${r.counts.channels} channels · ${r.counts.integrations} integrations. Keep the passphrase safe.`);
      setBp(''); setBp2('');
    } catch (e) { setBmsg((e as Error).message); }
  };

  const doRestore = async () => {
    setRmsg(null);
    if (!file) { setRmsg({ ok: false, text: 'Choose a .mcmfbackup file.' }); return; }
    if (!rp) { setRmsg({ ok: false, text: 'Enter the backup passphrase.' }); return; }
    try {
      const text = await file.text();
      const r = await restore.mutateAsync({ file: text, passphrase: rp });
      setRmsg({ ok: true, text: `Restored: ${r.restored.connections} connections · ${r.restored.vault} vault · ${r.restored.channels} channels · ${r.restored.integrations} integrations${r.exportedAt ? ` (backup from ${new Date(r.exportedAt).toLocaleString()})` : ''}.` });
      setRp(''); setAccepted(false);
    } catch (e) { setRmsg({ ok: false, text: (e as Error).message }); }
  };

  return (
    <Card title="Backup & Restore" className="col-span-12">
      <div className="grid gap-5 text-xs md:grid-cols-2">
        {/* Backup */}
        <div className="space-y-2">
          <div className="font-medium text-white">Create encrypted backup</div>
          <div className="text-2xs text-muted">Exports cloud connections, the credential vault and notification integrations — <b className="text-white">including their secrets</b> — into one passphrase-encrypted file (AES-256-GCM).</div>
          <PasswordInput value={bp} onChange={(e) => setBp(e.target.value)} placeholder="Backup passphrase (min 8 chars)" autoComplete="new-password" className={inp} />
          <PasswordInput value={bp2} onChange={(e) => setBp2(e.target.value)} placeholder="Confirm passphrase" autoComplete="new-password" className={inp} />
          <button onClick={doBackup} disabled={backup.isPending} className="rounded-md bg-brand px-3 py-1.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{backup.isPending ? 'Building…' : '⤓ Download backup'}</button>
          {bmsg && <div className="text-2xs text-muted-light">{bmsg}</div>}
          <div className="text-2xs text-warning">⚠ The passphrase cannot be recovered — store it safely. The file contains your secrets, protected only by this passphrase.</div>
        </div>

        {/* Restore */}
        <div className="space-y-2 md:border-l md:border-border md:pl-5">
          <div className="font-medium text-white">Restore from backup</div>
          <div className="text-2xs text-muted">Imports/merges connections, vault & integrations from a <span className="font-mono">.mcmfbackup</span> file. Existing entries with the same key are overwritten; secrets are re-sealed under this server's key.</div>
          <input type="file" accept=".mcmfbackup,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-2xs text-muted file:mr-2 file:rounded file:border-0 file:bg-card file:px-2 file:py-1 file:text-brand" />
          <PasswordInput value={rp} onChange={(e) => setRp(e.target.value)} placeholder="Backup passphrase" autoComplete="off" className={inp} />
          <label className="flex items-start gap-2 text-2xs text-muted-light"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 accent-brand" /> I understand this overwrites matching connections, vault entries and integrations.</label>
          <button onClick={doRestore} disabled={restore.isPending || !accepted} className="rounded-md border border-warning/50 bg-warning/10 px-3 py-1.5 text-2xs font-medium text-warning hover:bg-warning/20 disabled:opacity-50">{restore.isPending ? 'Restoring…' : '↥ Restore'}</button>
          {rmsg && <div className={`text-2xs ${rmsg.ok ? 'text-success' : 'text-danger'}`}>{rmsg.text}</div>}
        </div>
      </div>
    </Card>
  );
}
