#!/usr/bin/env node
/**
 * MCMF live audit — validates a RUNNING deployment end-to-end and (optionally)
 * executes the thesis validation suites, producing a machine-readable report.
 *
 *   node mcmf-live-audit.mjs                                   # defaults to https://localhost, /api prefix
 *   node mcmf-live-audit.mjs --base https://host[:port] --api /api
 *   node mcmf-live-audit.mjs --user admin@x.y --pass '…' --json live-report.json
 *   node mcmf-live-audit.mjs --user … --pass '…' --code 123456          # if 2FA is on
 *   node mcmf-live-audit.mjs --token <jwt>                              # skip login
 *   node mcmf-live-audit.mjs --user … --pass '…' --run                  # + run suites (RCA/correlation/CIEM + 5-trial anomaly battery)
 *   node mcmf-live-audit.mjs --user … --pass '…' --full                 # + full battery (30 trials, all types, threshold sweep) — takes minutes
 *
 * Read-only unless --run/--full (suites are seeded, self-cleaning, never touch live data).
 * Requires Node >= 18 (global fetch). Dev uses a self-signed cert → TLS verification is
 * disabled FOR THIS PROCESS ONLY.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const BASE = (opt('base', 'https://localhost')).replace(/\/$/, '');
const API = BASE + (opt('api', '/api').replace(/\/$/, '') || '');
const USER = opt('user', opt('email', null));
const PASS = opt('pass', null);
const CODE = opt('code', null);
let TOKEN = opt('token', null);
const RUN = flag('run') || flag('full');
const FULL = flag('full');
const TRIALS = Number(opt('trials', FULL ? 30 : 5));
const JSON_OUT = opt('json', null);
const TIMEOUT = Number(opt('timeout', 30000));

// ── plumbing ────────────────────────────────────────────────────────────────
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', d: '\x1b[90m', w: '\x1b[97m', x: '\x1b[0m' };
const report = { base: BASE, api: API, startedAt: new Date().toISOString(), checks: [], suites: {}, summary: {} };
let pass = 0, warn = 0, fail = 0;

function check(section, name, status, detail) {
  const icon = status === 'PASS' ? `${C.g}✓` : status === 'WARN' ? `${C.y}⚠` : status === 'INFO' ? `${C.b}ℹ` : `${C.r}✗`;
  console.log(`  ${icon} ${C.x}${name}${detail ? `${C.d} — ${detail}${C.x}` : ''}`);
  report.checks.push({ section, name, status, detail: detail ?? null });
  if (status === 'PASS') pass++;
  else if (status === 'WARN' || status === 'INFO') warn += status === 'WARN' ? 1 : 0;
  else fail++;
}
const section = (t) => console.log(`\n${C.w}${t}${C.x}`);

async function http(method, path, body, timeoutMs = TIMEOUT) {
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}
const get = (p, t) => http('GET', p, undefined, t);
const post = (p, b, t) => http('POST', p, b ?? {}, t);
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

// ── audit ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`${C.w}MCMF live audit${C.x} ${C.d}→ ${BASE} (api ${API})${C.x}`);

  // 1. Connectivity
  section('1. Connectivity');
  try {
    const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(TIMEOUT) });
    check('connectivity', 'Web UI reachable', res.ok ? 'PASS' : 'FAIL', `HTTP ${res.status}`);
  } catch (e) { check('connectivity', 'Web UI reachable', 'FAIL', String(e.message ?? e)); }
  try {
    const r = await get('/auth/me');
    // 401 = API up + auth guard working; anything else at this stage is unusual.
    check('connectivity', 'API reachable (auth guard active)', r.status === 401 || r.status === 200 ? 'PASS' : 'FAIL', `GET /auth/me → ${r.status}`);
  } catch (e) { check('connectivity', 'API reachable', 'FAIL', String(e.message ?? e)); }

  // 2. Authentication
  section('2. Authentication');
  if (!TOKEN && USER && PASS) {
    try {
      const login = await post('/auth/login', { email: USER, password: PASS });
      if (login.data?.twoFactorRequired) {
        if (!CODE) {
          check('auth', 'Login', 'WARN', '2FA required — re-run with --code <totp> (continuing unauthenticated)');
        } else {
          const v = await post('/auth/2fa/verify', { challenge: login.data.challenge, code: CODE });
          if (v.data?.token) { TOKEN = v.data.token; check('auth', 'Login + 2FA', 'PASS', `as ${v.data.user?.email} (${v.data.user?.role})`); }
          else check('auth', 'Login + 2FA', 'FAIL', `verify → ${v.status}`);
        }
      } else if (login.data?.token) {
        TOKEN = login.data.token;
        check('auth', 'Login', 'PASS', `as ${login.data.user?.email} (${login.data.user?.role})`);
      } else check('auth', 'Login', 'FAIL', `HTTP ${login.status} ${JSON.stringify(login.data)?.slice(0, 120)}`);
    } catch (e) { check('auth', 'Login', 'FAIL', String(e.message ?? e)); }
  } else if (TOKEN) {
    const me = await get('/auth/me');
    check('auth', 'Token accepted', me.status === 200 ? 'PASS' : 'FAIL', me.status === 200 ? `as ${me.data?.email} (${me.data?.role})` : `HTTP ${me.status}`);
  } else {
    check('auth', 'Credentials', 'WARN', 'no --user/--pass/--token — auth-protected data will be skipped');
  }
  report.authenticated = !!TOKEN;

  // 3. Deployed feature surface (present = 200/401/403; missing = 404)
  section('3. Deployed feature surface');
  const surface = [
    ['/finops/overview', 'FinOps'],
    ['/aiops/anomalies', 'Anomaly engine (PR #176)'],
    ['/aiops/validation', 'Validation suite (PR #177)'],
    ['/aiops/suppressions', 'Suppression windows (2.4)'],
    ['/aiops/correlations', 'Cross-cloud correlation (5.3)'],
    ['/ciem/findings', 'CIEM entitlements (6.3/6.4)'],
    ['/ai/status', 'AI engine'],
  ];
  const missing = [];
  for (const [path, label] of surface) {
    try {
      const r = await get(path);
      const present = r.status !== 404;
      if (!present) missing.push(label);
      check('surface', label, present ? 'PASS' : 'FAIL', `${path} → ${r.status}${present ? '' : ' (not deployed)'}`);
    } catch (e) { check('surface', label, 'FAIL', String(e.message ?? e)); }
  }
  report.missingFeatures = missing;

  // 4. Authenticated evidence (read-only)
  if (TOKEN && missing.length === 0) {
    section('4. Cost coverage (thesis 1.1)');
    const fin = await get('/finops/overview');
    if (fin.status === 200 && fin.data) {
      const by = fin.data.byProvider ?? [];
      const withCost = by.filter((p) => (p.value ?? p.amount ?? 0) > 0);
      report.costCoverage = { providers: by.length, withCost: withCost.length, detail: by };
      check('cost', `Providers reporting cost: ${withCost.length}/${by.length}`,
        by.length > 0 && withCost.length === by.length ? 'PASS' : withCost.length > 0 ? 'WARN' : 'FAIL',
        by.map((p) => `${p.key}: ${(p.value ?? p.amount ?? 0).toFixed?.(0) ?? p.value}`).join(', ') || 'no providers');
      check('cost', 'Billing source', fin.data.realBilling ? 'PASS' : 'WARN', fin.data.realBilling ? 'live billing API' : 'estimated from inventory (enable provider billing for live data)');
    } else check('cost', 'FinOps overview', 'FAIL', `HTTP ${fin.status}`);

    section('5. Validation evidence (thesis test matrix)');
    const val = await get('/aiops/validation');
    if (val.status === 200 && val.data) {
      report.validation = val.data;
      for (const t of val.data.map ?? []) {
        const status = t.status === 'evidence' ? 'PASS' : t.status === 'ready' ? 'WARN' : 'INFO';
        const metric = typeof t.metric === 'string' ? t.metric : t.metric ? JSON.stringify(t.metric).slice(0, 110) : 'no result yet';
        check('validation', `[${t.id}] ${t.name}`, status, metric);
      }
      const q = val.data.quality?.live;
      if (q) check('validation', 'Live review labels', 'INFO', `${q.confirmed}✓ / ${q.dismissed}✗ / ${q.unreviewed} unreviewed → precision ${pct(q.precision)}`);
      const inv = val.data.inventoryLatency;
      if (inv) check('validation', '[3.1] Inventory latency', inv.count > 0 ? 'PASS' : 'WARN', inv.count > 0 ? `median ${inv.medianSec}s over ${inv.count} discoveries` : 'no timed discoveries yet (create a resource while connected)');
    } else check('validation', 'Validation summary', 'FAIL', `HTTP ${val.status}`);
  } else if (TOKEN && missing.length) {
    check('validation', 'Evidence audit skipped', 'WARN', `deploy the missing features first: ${missing.join(', ')}`);
  }

  // 5. Suite execution (--run / --full)
  if (RUN && TOKEN && missing.length === 0) {
    section(`6. Executing validation suites ${FULL ? '(FULL battery — several minutes)' : `(quick: ${TRIALS} trials)`}`);
    const suites = [
      ['anomaly', () => post('/aiops/eval/run', { trials: TRIALS, resourceTypes: ['compute', 'storage', 'database'], sweep: FULL }, 30 * 60_000)],
      ['rca', () => post('/aiops/eval/rca', {}, 10 * 60_000)],
      ['correlation', () => post('/aiops/eval/correlation', {}, 5 * 60_000)],
      ['ciem', () => post('/ciem/eval/run', {}, 5 * 60_000)],
    ];
    for (const [name, run] of suites) {
      const t0 = Date.now();
      try {
        const r = await run();
        const ms = Date.now() - t0;
        if (r.status !== 200 && r.status !== 201) { check('suites', `${name} suite`, 'FAIL', `HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`); continue; }
        report.suites[name] = r.data;
        const d = r.data ?? {};
        if (name === 'anomaly') {
          const agg = d.aggregate?.precision ? ` | ${d.trials} trials: precision ${d.aggregate.precision.mean}±${d.aggregate.precision.sd}` : '';
          check('suites', 'Anomaly battery', d.pilotCase?.startsWith('PASS') && d.suppressionCase?.startsWith('PASS') ? 'PASS' : 'WARN',
            `P ${d.precision} R ${d.recall} FP ${d.fpRate} MTTD ${d.mttdSeconds}s${agg} | 1.2 ${d.pilotCase?.split('—')[0]?.trim()} | 2.4 ${d.suppressionCase?.split('—')[0]?.trim()} (${Math.round(ms / 1000)}s)`);
          if (d.mttdByType) check('suites', '  MTTD by type (2.5)', 'INFO', Object.entries(d.mttdByType).map(([k, v]) => `${k}: ${v != null ? Math.round(v / 60) + 'min' : '—'}`).join(', '));
          if (d.prCurve) check('suites', '  PR curve (2.6)', 'INFO', d.prCurve.map((p) => `z${p.threshold}: P${p.precision}/R${p.recall}`).join(' '));
        } else if (name === 'rca') {
          check('suites', 'RCA eval (5.1/5.4)', d.topK?.k1 >= 0.8 ? 'PASS' : 'WARN',
            `top-1 ${pct(d.topK?.k1)} top-3 ${pct(d.topK?.k3)} top-5 ${pct(d.topK?.k5)} | precision@1 ${pct(d.precisionAt1)} | ${d.meanDiagnosisMs}ms/diagnosis over ${d.incidents} incidents`);
        } else if (name === 'correlation') {
          check('suites', 'Correlation eval (5.3)', d.verdict?.startsWith('PASS') ? 'PASS' : 'WARN', `${d.verdict} | recall ${pct(d.recall)} precision ${pct(d.precision)}`);
        } else if (name === 'ciem') {
          check('suites', 'CIEM eval (6.3/6.4)', d.verdict?.startsWith('PASS') ? 'PASS' : 'WARN',
            `${d.verdict} | P ${pct(d.precision)} R ${pct(d.recall)} | consistency ${pct(d.consistency?.consistencyPct)} over ${d.consistency?.multiCloudIdentities} multi-cloud identities`);
        }
      } catch (e) { check('suites', `${name} suite`, 'FAIL', String(e.message ?? e)); }
    }
  } else if (RUN && !TOKEN) {
    check('suites', 'Suite execution skipped', 'WARN', 'suites are admin-only — provide --user/--pass or --token');
  }

  // Summary
  report.summary = { pass, warn, fail, finishedAt: new Date().toISOString() };
  section('Summary');
  console.log(`  ${C.g}${pass} pass${C.x} · ${C.y}${warn} warn${C.x} · ${fail ? C.r : C.d}${fail} fail${C.x}`);
  if (JSON_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`  ${C.d}report → ${JSON_OUT}${C.x}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`${C.r}audit crashed:${C.x}`, e);
  process.exit(2);
});
