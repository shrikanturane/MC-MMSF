'use strict';
// MCMF Terraform runner microservice. Isolated worker: the api POSTs a job (rendered .tf + creds +
// action) and this runs `terraform init/plan/apply/destroy` in a per-job workdir, returning logs +
// outputs. Kept dependency-free (Node built-ins only) and capped to MAX_CONCURRENT parallel runs so a
// heavy apply can never starve the rest of the platform.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORK = process.env.TF_WORK_DIR || '/work';
const MAX = Number(process.env.MAX_CONCURRENT || 2);
let running = 0;
const queue = [];

function sh(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, opts);
    let out = '';
    const cap = (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); };
    p.stdout.on('data', cap);
    p.stderr.on('data', cap);
    p.on('close', (code) => resolve({ code, out }));
    p.on('error', (e) => resolve({ code: -1, out: out + '\n' + String(e) }));
  });
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '');

async function provision({ id, files, env, action }) {
  const dir = path.join(WORK, safe(id));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, safe(name)), String(content));
  const e = { ...process.env, ...(env || {}), TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_PLUGIN_CACHE_DIR: '/plugins' };
  const opts = { cwd: dir, env: e };

  const init = await sh('terraform', ['init', '-input=false', '-no-color'], opts);
  if (init.code !== 0) return { ok: false, stage: 'init', log: init.out };

  if (action === 'apply') {
    const ap = await sh('terraform', ['apply', '-input=false', '-no-color', '-auto-approve'], opts);
    let outputs = {};
    if (ap.code === 0) { const o = await sh('terraform', ['output', '-json', '-no-color'], opts); try { outputs = JSON.parse(o.out); } catch (_) { /* none */ } }
    return { ok: ap.code === 0, stage: 'apply', log: ap.out, outputs };
  }
  if (action === 'destroy') {
    const d = await sh('terraform', ['destroy', '-input=false', '-no-color', '-auto-approve'], opts);
    return { ok: d.code === 0, stage: 'destroy', log: d.out };
  }
  // default: plan
  const pl = await sh('terraform', ['plan', '-input=false', '-no-color'], opts);
  return { ok: pl.code === 0, stage: 'plan', log: pl.out };
}

function gate(fn) {
  return new Promise((resolve) => {
    const task = () => { running++; Promise.resolve().then(fn).then((r) => { running--; resolve(r); next(); }, (err) => { running--; resolve({ ok: false, log: String(err) }); next(); }); };
    if (running < MAX) task(); else queue.push(task);
  });
}
function next() { if (queue.length && running < MAX) queue.shift()(); }

http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, running, queued: queue.length })); }
  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', async () => {
      let job;
      try { job = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('{"ok":false,"log":"bad json"}'); }
      const result = await gate(() => provision(job));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(8080, () => console.log(`tf-runner listening on :8080 (max ${MAX} concurrent)`));
