import { sendMail } from './mailer';

/**
 * Email the OTHER administrators that an approval request is pending their sign-off (maker-checker).
 * Best-effort + non-blocking — never throws into the request flow.
 */
export async function notifyApprovers(adminEmails: string[], title: string, requesterEmail: string, baseUrl: string): Promise<void> {
  const to = [...new Set((adminEmails || []).filter(Boolean))];
  if (!to.length) return;
  const link = `${(baseUrl || '').replace(/\/$/, '')}/approvals`;
  const subject = `[MCMF] Approval needed: ${title}`;
  const text = `${requesterEmail} raised an approval request that needs another administrator's sign-off:\n\n  ${title}\n\nReview & approve it in MCMF → Approvals: ${link}\n\nNote: with maker-checker on, the requester cannot approve their own request — a different administrator must.`;
  for (const addr of to) { try { await sendMail({ to: addr, subject, text }); } catch { /* best-effort */ } }
}

/** Send a WhatsApp text via the Meta Cloud API. Throws if not configured or on API error. */
export async function sendWhatsapp(to: string, text: string): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('WhatsApp not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)');
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g, ''), type: 'text', text: { body: text } }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

/**
 * Best-effort notify a person over email AND WhatsApp — both options, independently.
 * Never throws; returns which channels actually delivered.
 */
export async function notifyPerson(
  p: { email?: string | null; phone?: string | null },
  subject: string,
  body: string,
): Promise<string[]> {
  const sent: string[] = [];
  if (p.email) {
    try { await sendMail({ to: p.email, subject, text: body }); sent.push('email'); } catch { /* best-effort */ }
  }
  if (p.phone && p.phone.replace(/[^0-9]/g, '').length >= 8) {
    try { await sendWhatsapp(p.phone, `${subject}\n\n${body}`); sent.push('whatsapp'); } catch { /* best-effort */ }
  }
  return sent;
}
