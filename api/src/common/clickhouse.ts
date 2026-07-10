/**
 * Shared ClickHouse HTTP-interface helpers (extracted from DatabaseService so the
 * aiops metrics store and the log store use one client). ClickHouse is optional
 * infrastructure — callers must treat failures as soft (catch and degrade).
 */

export const CH_DB = 'mcmf';

export const chUrl = (): string => (process.env.CLICKHOUSE_URL || 'http://clickhouse:8123').replace(/\/$/, '');

/** Run a SQL statement over the HTTP interface. `json=true` parses the response body. */
export async function chQuery(sql: string, json = false): Promise<any> {
  const res = await fetch(`${chUrl()}/`, { method: 'POST', body: sql, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return json && text ? JSON.parse(text) : text;
}

/** Bulk-insert rows into a table (JSONEachRow). */
export async function chInsertRows(table: string, rows: Record<string, any>[]): Promise<void> {
  if (!rows.length) return;
  const body = `INSERT INTO ${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await fetch(`${chUrl()}/`, { method: 'POST', body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ClickHouse insert ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** ClickHouse DateTime literal (UTC, second precision). */
export function chTs(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 19).replace('T', ' ');
}
