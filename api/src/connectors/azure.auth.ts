import type { ProviderCredentials } from './adapter';

/** Client-credentials OAuth against Entra ID for the ARM (management.azure.com) audience. */
export async function getAzureToken(creds: ProviderCredentials): Promise<string> {
  const { tenantId, clientId, clientSecret } = creds;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('azure requires { tenantId, clientId, clientSecret }');
  }
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://management.azure.com/.default',
    }),
  });
  if (!res.ok) throw new Error(`azure token ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}
