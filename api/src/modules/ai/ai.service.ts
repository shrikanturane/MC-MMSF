import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { rankCauses } from '../aiops/rca-ranker';

type AiProvider = 'free' | 'local' | 'anthropic' | 'openai' | 'gemini';

const DEFAULT_MODEL: Record<Exclude<AiProvider, 'free' | 'local'>, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
};
const PROVIDER_LABEL: Record<AiProvider, string> = {
  free: 'Free (built-in)',
  local: 'Local LLM',
  anthropic: 'Claude (Anthropic)',
  openai: 'ChatGPT (OpenAI)',
  gemini: 'Gemini (Google)',
};

const DEFAULT_LOCAL_MODEL = 'llama3.2:1b';

@Injectable()
export class AiService {
  private readonly log = new Logger('AI');
  constructor(private readonly prisma: PrismaService) {}

  private ollamaUrl(): string {
    return (process.env.OLLAMA_URL || 'http://ollama:11434').replace(/\/$/, '');
  }
  private localEnabled(): boolean {
    return !!(process.env.OLLAMA_URL || process.env.AI_LOCAL_MODEL) || (process.env.AI_PROVIDER || '').toLowerCase() === 'local';
  }

  /** Active provider: explicit AI_PROVIDER, else local (on-prem Qwen) if enabled, else cloud key, else free. */
  private provider(): AiProvider {
    const p = (process.env.AI_PROVIDER || '').trim().toLowerCase();
    if (p === 'free' || p === 'local' || p === 'anthropic' || p === 'openai' || p === 'gemini') return p as AiProvider;
    if (this.localEnabled()) return 'local';
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.GEMINI_API_KEY) return 'gemini';
    return 'free';
  }
  private keyFor(p: AiProvider): string {
    if (p === 'anthropic') return (process.env.ANTHROPIC_API_KEY || '').trim();
    if (p === 'openai') return (process.env.OPENAI_API_KEY || '').trim();
    if (p === 'gemini') return (process.env.GEMINI_API_KEY || '').trim();
    return '';
  }
  private model(p: AiProvider): string {
    if (p === 'free') return 'built-in';
    if (p === 'local') return (process.env.AI_LOCAL_MODEL || '').trim() || DEFAULT_LOCAL_MODEL;
    return (process.env.AI_MODEL || '').trim() || DEFAULT_MODEL[p as Exclude<AiProvider, 'free' | 'local'>];
  }
  /** Free + local always "configured" (no key); cloud providers need their key. */
  configured() {
    const p = this.provider();
    return p === 'free' || p === 'local' || !!this.keyFor(p);
  }
  /** True when a real LLM is available (local Qwen counts). */
  private useLlm() {
    const p = this.provider();
    if (p === 'local') return true;
    return p !== 'free' && !!this.keyFor(p);
  }

  status() {
    const p = this.provider();
    return { configured: this.configured(), provider: p, providerLabel: PROVIDER_LABEL[p], model: this.model(p), llm: this.useLlm(), local: p === 'local', rate: this.rateState() };
  }

  /** Liveness + model-presence of the local engine (Ollama). */
  async health() {
    const want = this.model('local');
    if (this.provider() !== 'local') return { ok: false, enabled: false, model: want, detail: 'local engine not the active provider' };
    try {
      const res = await fetch(`${this.ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, enabled: true, model: want, detail: `HTTP ${res.status}` };
      const j = (await res.json()) as { models?: { name: string }[] };
      const names = (j.models ?? []).map((m) => m.name);
      const base = want.split(':')[0];
      const present = names.some((n) => n === want || n.startsWith(base));
      return { ok: true, enabled: true, model: want, present, models: names };
    } catch (e) {
      return { ok: false, enabled: true, model: want, detail: String((e as Error)?.message ?? e) };
    }
  }

  /** Connectivity test for Settings → Integrations: pings the ACTIVE provider with a tiny prompt. */
  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    const p = this.provider();
    if (p === 'free') return { ok: true, detail: 'Built-in native assistant active (no external LLM) — always available, instant.' };
    if (p === 'local') {
      const h = (await this.health()) as { ok?: boolean; detail?: string };
      return { ok: !!h.ok, detail: h.ok ? `Local Ollama engine reachable (model ${this.model('local')}).` : (h.detail || 'Local engine unreachable — check OLLAMA_URL and that the model is pulled.') };
    }
    if (!this.keyFor(p)) return { ok: false, detail: `No API key set for provider "${p}". Add the key in the AI integration.` };
    try {
      const out = await this.complete('You are a connectivity test for MCMF.', 'Reply with exactly: OK', 12);
      return { ok: true, detail: `${PROVIDER_LABEL[p]} responded with model "${this.model(p)}"${out ? ` ("${out.trim().slice(0, 24)}")` : ''}. First call after idle can take ~1-2 min on NVIDIA cold start; then it's fast.` };
    } catch (e) {
      return { ok: false, detail: `${PROVIDER_LABEL[p]} call failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
  }

  /** Provider-agnostic completion. Routes to local Qwen / Claude / OpenAI / Gemini. Throws on error. */
  private async complete(system: string, prompt: string, maxTokens = 800): Promise<string> {
    const p = this.provider();
    if (p === 'local') return this.local(system, prompt, maxTokens);
    if (p === 'anthropic') return this.anthropic(system, prompt, maxTokens);
    if (p === 'openai') return this.openai(system, prompt, maxTokens);
    if (p === 'gemini') return this.gemini(system, prompt, maxTokens);
    throw new Error('no LLM provider configured');
  }

  // ── Cloud-LLM rate guardrail ───────────────────────────────────────────────
  // Protects the free NVIDIA tier (and any paid key) from runaway usage, and lets
  // every AI feature degrade gracefully to the instant native engine instead of
  // erroring. Caps are configurable in Settings → Integrations (0 = unlimited).
  private llmCalls: number[] = []; // ms timestamps of recent cloud attempts (sliding window)
  private llmCooldownUntil = 0; // set when the provider returns 429 — back off for a while
  private intEnv(key: string, dflt: number): number {
    const n = parseInt((process.env[key] || '').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  }
  private rlPerMin(): number { return this.intEnv('AI_RATE_PER_MIN', 20); }
  private rlPerDay(): number { return this.intEnv('AI_RATE_PER_DAY', 1000); }

  /** Snapshot of guardrail usage (for status() / UI). */
  private rateState() {
    const now = Date.now();
    this.llmCalls = this.llmCalls.filter((t) => t > now - 86_400_000);
    const lastMin = this.llmCalls.filter((t) => t > now - 60_000).length;
    const coolingMs = Math.max(0, this.llmCooldownUntil - now);
    return { perMin: this.rlPerMin(), perDay: this.rlPerDay(), usedLastMin: lastMin, usedToday: this.llmCalls.length, coolingDownSec: Math.ceil(coolingMs / 1000) };
  }

  /** Is the cloud LLM allowed right now? false → caller falls back to the native engine. */
  private llmGate(): { open: boolean; reason?: string } {
    const now = Date.now();
    if (now < this.llmCooldownUntil) return { open: false, reason: `provider rate-limited; cooling down ${Math.ceil((this.llmCooldownUntil - now) / 1000)}s` };
    const s = this.rateState();
    if (s.perMin && s.usedLastMin >= s.perMin) return { open: false, reason: `cap ${s.perMin}/min reached` };
    if (s.perDay && s.usedToday >= s.perDay) return { open: false, reason: `cap ${s.perDay}/day reached` };
    return { open: true };
  }

  /** Guarded completion: returns the LLM text, or null to signal "use the native engine".
   *  null when: no LLM configured, the guardrail is closed (cap/cooldown), or the call errors.
   *  A 429/quota error trips a cooldown so we stop hammering a rate-limited provider. */
  private async tryComplete(system: string, prompt: string, maxTokens: number): Promise<string | null> {
    if (!this.useLlm()) return null;
    const gate = this.llmGate();
    if (!gate.open) { this.log.warn(`AI guardrail: skipping LLM (${gate.reason}) → native engine`); return null; }
    this.llmCalls.push(Date.now());
    try {
      const out = await this.complete(system, prompt, maxTokens);
      return out || null;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/\b429\b|rate.?limit|too many requests|quota|insufficient|overloaded|503/i.test(msg)) {
        const cool = Math.max(15_000, this.intEnv('AI_COOLDOWN_MS', 120_000));
        this.llmCooldownUntil = Date.now() + cool;
        this.log.warn(`AI provider rate-limited (${msg.slice(0, 140)}) → native engine; cooling down ${Math.round(cool / 1000)}s`);
      } else {
        this.log.warn(`AI provider error (${msg.slice(0, 140)}) → native engine`);
      }
      return null;
    }
  }

  /** Note shown when a configured LLM was wanted but we served the native engine instead. */
  private degradedNote(): string | undefined {
    if (!this.useLlm()) return undefined; // genuine free mode — not a degradation
    const cooling = this.llmCooldownUntil > Date.now();
    return `Cloud AI ${cooling ? 'rate-limited' : 'temporarily unavailable'} — showing the instant native engine result (auto-retries shortly).`;
  }

  /** Local on-prem inference via Ollama's chat API (Qwen2.5-1.5B-Instruct by default). */
  private async local(system: string, prompt: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.ollamaUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model('local'),
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        options: { num_predict: maxTokens, temperature: 0.3, top_p: 0.9 },
      }),
      signal: AbortSignal.timeout(150_000), // CPU inference can be slow on first token
    });
    if (!res.ok) throw new Error(`Local LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { message?: { content?: string } };
    const out = (j.message?.content ?? '').trim();
    if (!out) throw new Error('Local LLM returned empty response (model may still be loading)');
    return out;
  }

  private async anthropic(system: string, prompt: string, maxTokens: number): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.keyFor('anthropic'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model('anthropic'), max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  }

  private async openai(system: string, prompt: string, maxTokens: number): Promise<string> {
    // OpenAI-compatible — base URL is configurable so the same path serves OpenAI, NVIDIA's free NIM
    // API (https://integrate.api.nvidia.com/v1), Groq, Together, OpenRouter, a local vLLM, etc.
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.keyFor('openai')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model('openai'), max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (j.choices?.[0]?.message?.content ?? '').trim();
  }

  private async gemini(system: string, prompt: string, maxTokens: number): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model('gemini')}:generateContent?key=${this.keyFor('gemini')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((x) => x.text).join('\n').trim();
  }

  /** Free built-in assistant: keyword-routed MCMF navigation help (no external LLM). */
  private freeAnswer(prompt: string, ctx: string): string {
    const q = prompt.toLowerCase();
    const hints: [RegExp, string][] = [
      [/cost|spend|billing|finops|carbon|co2/, '💰 Cost & Carbon: open FinOps & Carbon for cost allocation, budgets, savings and the estimated carbon footprint.'],
      [/alert|threshold|rule/, '🔔 Alerts: Security & Alerting → Automation. Add alert rules; they fire on live metrics.'],
      [/monitor|ping|uptime|\bip\b|host/, '📡 Monitoring: Monitoring → Telemetry & Hosts → IP/Host Monitor (+ Add).'],
      [/provision|deploy|\bvm\b|disk|vpn|network/, '🛠 Provisioning: Network/Inventory → Provision Resource (governed by approvals).'],
      [/agent|cpu|memory|ram/, '🖥 Agents: Help → Guest Agent to deploy; metrics appear in Monitoring + IP monitors.'],
      [/security|finding|zero.?trust|posture/, '🛡 Security: the Security page → Zero-Trust Posture + Cloud Findings.'],
      [/approv/, '🛂 Approvals: the Approvals page — admins approve/reject provisioning requests.'],
      [/report/, '📄 Reports: Reports → New report; schedule daily/weekly email delivery.'],
      [/console|rdp|ssh|remote/, '🖧 Remote access: VMs table → Console (in-browser RDP/SSH) or download .rdp.'],
      [/notif|email|whatsapp|slack|channel/, '📨 Notifications: Security & Alerting → Notification Channels (email, Slack, WhatsApp, PagerDuty, webhook).'],
    ];
    const matched = hints.filter(([re]) => re.test(q)).map(([, h]) => h);
    const base = matched.length
      ? matched.join('\n')
      : 'I can point you to the right MCMF screen. Ask about cost, alerts, monitoring, provisioning, agents, security, approvals, reports, remote console, or notifications.';
    return `${base}\n\n${ctx}\n\n— MCMF assistant. For free-form AI-written answers, add a cloud AI key in Settings → Integrations.`;
  }

  /** A snapshot of live platform state used to ground the assistant. */
  private async context(): Promise<string> {
    const [resources, alerts, incidents, conns, agents] = await Promise.all([
      this.prisma.resource.count(),
      this.prisma.alert.count({ where: { status: 'active' } }),
      this.prisma.incident.count({ where: { status: { not: 'resolved' } } }),
      this.prisma.cloudConnection.findMany({ select: { provider: true, status: true } }),
      this.prisma.agent.count(),
    ]);
    const clouds = conns.map((c) => `${c.provider}:${c.status}`).join(', ') || 'none';
    return `Live state — resources: ${resources}, active alerts: ${alerts}, open incidents: ${incidents}, connections: ${clouds}, guest agents: ${agents}.`;
  }

  private readonly appSystem =
    'You are the MCMF Cloud AI Engine — embedded in a Multi-Cloud Management Framework that manages AWS, Azure, GCP, Docker, VMware/Nutanix and on-prem hosts. ' +
    'Capabilities the user has: Inventory, Monitoring (CPU/mem/disk/net, IP/host monitors), Security (findings, zero-trust, alert rules, automation), FinOps cost + carbon, Networking & topology, Provisioning (VM/network/disk/VPN with approvals), in-browser RDP/SSH console, guest agents, SIEM + AIOps. ' +
    'Answer concisely and practically. When the user asks how to do something in MCMF, give the exact navigation path and steps. If you are unsure or it needs live data you do not have, say so.';

  /** Cross-app assistant — answers any question/process help, grounded in MCMF + live state. */
  async assistant(prompt: string) {
    const p = String(prompt ?? '').trim();
    if (!p) return { configured: this.configured(), provider: this.provider(), answer: 'Ask me anything about your clouds or how to do something in MCMF.' };
    const ctx = await this.context();
    const answer = await this.tryComplete(this.appSystem, `${ctx}\n\nUser question: ${p}`, 900);
    if (answer) return { configured: true, provider: this.provider(), model: this.model(this.provider()), answer };
    // No LLM, capped, cooling down, or errored → instant native engine.
    return { configured: true, provider: 'free', answer: this.freeAnswer(p, ctx), note: this.degradedNote() };
  }

  /**
   * Root-cause analysis for an alert/incident. Rule-based correlation + deterministic
   * ranked candidates always; LLM narrative via the engine. `skipLlm` (validation
   * suite) returns the rules-only result immediately — the top-k scoring only needs
   * the ranker, and 15 sequential LLM narratives would blow the gateway timeout.
   */
  async rca(body: { alertId?: string; incidentId?: string; skipLlm?: boolean }) {
    const alert = body?.alertId ? await this.prisma.alert.findUnique({ where: { id: body.alertId } }) : null;
    const incident = body?.incidentId ? await this.prisma.incident.findUnique({ where: { id: body.incidentId } }) : null;
    const subject = alert ?? incident ?? (await this.prisma.alert.findFirst({ where: { status: 'active' }, orderBy: { raisedAt: 'desc' } }));
    if (!subject) return { source: 'rules', model: this.model(this.provider()), narrative: 'No active alert or incident to analyse.', evidence: [] };

    const title = (subject as any).title as string;
    const resourceName = (subject as any).resourceName as string | undefined;
    const when = ((subject as any).raisedAt ?? (subject as any).openedAt ?? new Date()) as Date;
    const since = new Date(when.getTime() - 30 * 60_000);

    const [siem, events, hot] = await Promise.all([
      this.prisma.siemEvent.findMany({ where: { ts: { gte: since }, ...(resourceName ? { OR: [{ host: resourceName }, { message: { contains: resourceName } }] } : {}) }, orderBy: { ts: 'desc' }, take: 15 }),
      this.prisma.eventLog.findMany({ where: { ts: { gte: since } }, orderBy: { ts: 'desc' }, take: 15 }),
      this.prisma.resource.findMany({ where: { type: 'compute', status: 'running', OR: [{ cpuPct: { gte: 85 } }, { memoryPct: { gte: 85 } }] }, select: { name: true, cpuPct: true, memoryPct: true } }),
    ]);

    const evidence = [
      ...siem.map((e) => `SIEM ${e.level}: ${e.message} (${e.host ?? e.source})`),
      ...events.map((e) => `Event ${e.severity}: ${e.title}`),
      ...hot.map((r) => `Hot resource: ${r.name} CPU ${r.cpuPct?.toFixed(0)}% / Mem ${r.memoryPct?.toFixed(0)}%`),
    ].slice(0, 20);

    // Deterministic ranked candidate causes — the scoreable verdict (top-k accuracy /
    // precision@1 in the validation suite); the narrative below stays the human story.
    const candidates = rankCauses({ title, metric: (subject as any).metric ?? null, resourceName, value: (subject as any).value ?? null }, evidence);

    const prompt = `Alert/incident: "${title}"${resourceName ? ` on ${resourceName}` : ''}, fired ${when.toISOString()}.\n\nCorrelated evidence (last 30 min):\n${evidence.map((e) => `- ${e}`).join('\n') || '- (none found)'}\n\nGive the most likely ROOT CAUSE and 3-5 concrete remediation steps. Be specific and concise.`;
    const llm = body?.skipLlm
      ? null
      : await this.tryComplete('You are a senior SRE performing root-cause analysis on cloud infrastructure incidents. Be precise, evidence-based, and actionable.', prompt, 700);
    if (llm) return { source: this.provider() === 'local' ? 'local' : 'llm', model: this.model(this.provider()), narrative: llm, evidence, candidates };
    const narrative = `Rule-based correlation for "${title}"${resourceName ? ` on ${resourceName}` : ''}: ${evidence.length} correlated signal(s) in the 30 min before it fired. ` +
      (evidence.length ? `Most likely related to: ${evidence.slice(0, 3).join('; ')}. ` : 'No strongly correlated signals found. ') +
      (this.useLlm() ? '' : 'Add a cloud AI key (Settings → Integrations) for an AI-written root-cause narrative.');
    return { source: 'rules', model: this.useLlm() ? this.model(this.provider()) : 'built-in', narrative, evidence, candidates, note: this.degradedNote() };
  }

  // ───────────────── MCMF native assistant — instant, deterministic, no model ─────────────────
  // Purpose-built for this platform: detect intent + entities from the question, query live data,
  // and compose a precise natural-language answer. Sub-second, zero hallucination, no GPU/LLM.
  private static readonly PROVIDER_ALIASES: Record<string, string> = {
    aws: 'aws', amazon: 'aws', ec2: 'aws', azure: 'azure', microsoft: 'azure', gcp: 'gcp', google: 'gcp',
    docker: 'docker', linux: 'linux', windows: 'windows', vmware: 'vmware', esxi: 'esxi', nutanix: 'nutanix', proxmox: 'proxmox', kvm: 'kvm',
  };
  private money(n: number, cur: string) { return `${cur} ${Math.round(n).toLocaleString('en-US')}`; }

  /** Always-ready: the native assistant needs no model to load. */
  async agentStatus() {
    return { ok: true, engine: 'native', model: 'mcmf-native', crew: true, db: true, llm: this.useLlm() };
  }

  /** Compact live-platform snapshot used to GROUND the LLM so it never invents names/numbers. */
  private async liveContext(): Promise<string> {
    const P = this.prisma;
    const fiveMin = new Date(Date.now() - 5 * 60_000);
    const [vms, conns, sev, incidents, online, totalA] = await Promise.all([
      P.resource.findMany({ where: { type: 'compute' as any }, select: { name: true, provider: true, status: true, cpuPct: true, memoryPct: true, diskPct: true, monthlyCost: true, properties: true }, take: 80 }),
      P.cloudConnection.findMany({ select: { provider: true, monthlyCost: true, currency: true } }),
      P.securityFinding.groupBy({ by: ['severity'], where: { status: 'open' }, _count: true }).catch(() => [] as any[]),
      P.incident.findMany({ where: { status: { not: 'resolved' } }, orderBy: { openedAt: 'desc' }, take: 8, select: { title: true, severity: true } }).catch(() => [] as any[]),
      P.agent.count({ where: { lastSeenAt: { gte: fiveMin } } }),
      P.agent.count(),
    ]);
    const cur = conns.find((c) => c.currency)?.currency ?? 'USD';
    const cost = conns.reduce((s, c) => s + (c.monthlyCost ?? 0), 0);
    const vmLines = vms.map((r) => {
      const p = (r.properties ?? {}) as any;
      const os = p.osVersion || p.os || '?';
      const ip = p.privateIp || p.ip || p.publicIp || '';
      return `${r.name} | ${r.provider} | ${os} | ${r.status} | cpu ${Math.round(r.cpuPct ?? 0)}% mem ${Math.round(r.memoryPct ?? 0)}% disk ${Math.round(r.diskPct ?? 0)}% | ${cur} ${Math.round(r.monthlyCost ?? 0)}/mo${ip ? ' | ' + ip : ''}`;
    });
    return [
      `VMs (${vms.length}) [name | provider | OS | status | metrics | cost | ip]:`,
      ...vmLines,
      ``,
      `Cost: ${cur} ${Math.round(cost)}/mo total; by provider ${conns.filter((c) => (c.monthlyCost ?? 0) > 0).map((c) => `${c.provider}=${Math.round(c.monthlyCost ?? 0)}`).join(', ') || 'n/a'}`,
      `Security: open findings ${sev.map((s: any) => `${s.severity}=${s._count}`).join(', ') || 'none'}`,
      `Incidents (open): ${incidents.length ? incidents.map((i: any) => `${i.title} (${i.severity})`).join('; ') : 'none'}`,
      `Guest agents online: ${online}/${totalA}`,
    ].join('\n');
  }

  /** MCMF assistant. Native intent engine grounds + answers instantly; when a cloud LLM (NVIDIA/…) is
   *  configured it answers free-form GROUNDED in the live snapshot, falling back to native on miss. */
  async agentChat(message: string) {
    const raw = String(message ?? '').trim();
    if (!raw) return { answer: 'Ask me about your inventory, cost, security, monitoring, compliance or guest agents.', engine: 'native', model: 'mcmf-native' };
    const m = raw.toLowerCase();
    const intents = this.detectIntents(m);
    const blocks: string[] = [];
    for (const it of intents) {
      const b = await this.answerIntent(it, m).catch(() => null);
      if (b) blocks.push(b);
    }
    if (!blocks.length) blocks.push(await this.answerIntent('overview', m));
    const nativeAnswer = blocks.join('\n\n');

    if (this.useLlm()) {
      const ctx = await this.liveContext().catch(() => '');
      const sys =
        'You are the MCMF Cloud AI Engine, a multi-cloud operations assistant. Answer the user using ONLY the LIVE DATA and the pre-computed STRUCTURED FINDINGS provided — use the real names, numbers and statuses, never invent any. ' +
        'If the data does not contain the answer, say what is missing and point to the relevant MCMF screen (Inventory, OS Inventory, Monitoring, Security, FinOps, Activity). Be concise and well-structured (short bullets or a small table).';
      const prompt = `LIVE DATA:\n${ctx}\n\nSTRUCTURED FINDINGS (already computed for this question):\n${nativeAnswer}\n\nUser question: ${raw}`;
      const llm = await this.tryComplete(sys, prompt, 800);
      if (llm) return { answer: llm, engine: 'llm', model: this.model(this.provider()), provider: this.provider(), intents };
    }
    return { answer: nativeAnswer, engine: 'native', model: 'mcmf-native', intents, ...(this.useLlm() ? { note: this.degradedNote() } : {}) };
  }

  private detectIntents(m: string): string[] {
    const map: [string, RegExp][] = [
      ['cost', /\b(cost|costs|spend|spending|bill|billing|finops|expensive|price|pricing|budget)\b/],
      ['carbon', /\b(carbon|co2|emission|emissions|sustainab|green|footprint)\b/],
      ['security', /\b(security|secure|risk|risks|finding|findings|vulnerab|threat|cve|exposed|exposure|attack|posture|firewall)\b/],
      ['idle', /\b(idle|underused|underutil|waste|wasted|unused|right-?siz|optimi[sz]e|save|savings)\b/],
      ['monitoring', /\b(incident|incidents|cpu|memory|ram|load|overload|overloaded|performance|health|down|outage|slow|hot)\b/],
      ['agents', /\b(agent|agents|endpoint|endpoints|telemetry)\b/],
      ['compliance', /\b(complian|policy|policies|violation|violations|governance|audit|untagged|tag)\b/],
      ['inventory', /\b(resource|resources|asset|assets|vm|vms|server|servers|instance|instances|inventory|running|stopped|how many|count|provider|providers|cloud)\b/],
      ['help', /\b(how do i|how to|how can i|where is|where do|navigate|guide|help)\b/],
      ['greeting', /\b(hi|hello|hey|thanks|thank you)\b/],
    ];
    // Per-VM listing takes precedence: "list windows VMs with CPU/disk", "show servers and memory",
    // "which linux machines are running". A LIST verb + a machine noun, or a machine noun + a metric.
    const wantsList = /\b(list|show|display|give me|which|what are|name|names)\b/.test(m);
    const machine = /\b(vm|vms|server|servers|machine|machines|instance|instances|host|hosts|windows|linux)\b/.test(m);
    const metric = /\b(cpu|disk|memory|mem|ram|utili[sz]|usage|load)\b/.test(m);
    const isCount = /\bhow many\b|\bcount\b/.test(m);
    if (!isCount && ((wantsList && machine) || (machine && metric))) return ['vmlist'];

    const hits = map.filter(([, re]) => re.test(m)).map(([k]) => k);
    const data = hits.filter((h) => !['help', 'greeting'].includes(h));
    if (data.length) return data.slice(0, 3);
    if (hits.includes('help')) return ['help'];
    if (hits.includes('greeting')) return ['greeting'];
    return ['overview'];
  }

  private extractProvider(m: string): string | null {
    for (const [k, v] of Object.entries(AiService.PROVIDER_ALIASES)) if (new RegExp(`\\b${k}\\b`).test(m)) return v;
    return null;
  }
  private extractStatus(m: string): string | null {
    if (/\brunning\b/.test(m)) return 'running';
    if (/\bstopped\b|\bdeallocated\b/.test(m)) return 'stopped';
    if (/\bterminated\b/.test(m)) return 'terminated';
    return null;
  }
  private extractOs(m: string): string | null {
    if (/\bwindows?\b|\bwin\b|\bwindows server\b/.test(m)) return 'windows';
    if (/\blinux\b|\bunix\b|ubuntu|debian|rhel|red\s?hat|centos|suse|sles|fedora|rocky|alma|amazon linux|oracle linux/.test(m)) return 'linux';
    return null;
  }
  private osFamilyOf(props: any): string {
    const o = String(props?.osVersion || props?.os || props?.osType || props?.platform || props?.guestOS || '').toLowerCase();
    if (/win/.test(o)) return 'windows';
    if (/ubuntu|debian|rhel|red\s?hat|centos|suse|sles|fedora|rocky|alma|amazon|oracle|linux|unix/.test(o)) return 'linux';
    if (/mac|darwin/.test(o)) return 'macos';
    return 'other';
  }

  private async answerIntent(intent: string, m: string): Promise<string> {
    const P = this.prisma;
    if (intent === 'greeting') return "👋 I'm your MCMF assistant. Try “how many resources do I have”, “what's my monthly cost”, “top security risks”, or “which workloads are idle”.";
    if (intent === 'help') return 'I answer about: inventory (counts by cloud/type/status), cost & savings, security findings & risks, monitoring & incidents, guest agents, and compliance — just ask in plain English.';

    if (intent === 'vmlist') {
      const osF = this.extractOs(m); const prov = this.extractProvider(m); const status = this.extractStatus(m);
      const cloudProv = prov && ['aws', 'azure', 'gcp', 'docker', 'vmware', 'nutanix', 'kvm', 'proxmox', 'esxi'].includes(prov) ? prov : null;
      const rows = await P.resource.findMany({ where: { type: 'compute' as any }, select: { name: true, provider: true, status: true, cpuPct: true, memoryPct: true, diskPct: true, properties: true } });
      let list = rows.filter((r) => {
        if (osF && this.osFamilyOf(r.properties) !== osF) return false;
        if (cloudProv && r.provider !== (cloudProv as any)) return false;
        if (status && r.status !== (status as any)) return false;
        return true;
      });
      const scope = `${osF ? osF.charAt(0).toUpperCase() + osF.slice(1) + ' ' : ''}VM${list.length === 1 ? '' : 's'}${cloudProv ? ' on ' + cloudProv.toUpperCase() : ''}${status ? ' (' + status + ')' : ''}`;
      if (!list.length) return `🖥 No ${scope} found. (I have ${rows.length} VM(s) total — try without a filter, or check the spelling of the cloud/OS.)`;
      list = list.sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0)).slice(0, 25);
      const lines = list.map((r) => {
        const ver = (r.properties as any)?.osVersion;
        return `• ${r.name} (${r.provider}${ver ? ' · ' + ver : ''}) — CPU ${Math.round(r.cpuPct ?? 0)}% · Mem ${Math.round(r.memoryPct ?? 0)}% · Disk ${Math.round(r.diskPct ?? 0)}% · ${r.status}`;
      });
      return `🖥 ${list.length} ${scope}:\n${lines.join('\n')}\n\n(CPU/Mem/Disk are 0% for powered-off VMs and for cloud VMs without a guest agent or cloud metrics. Open OS Inventory for the full drill-down.)`;
    }

    if (intent === 'inventory' || intent === 'overview') {
      const prov = this.extractProvider(m); const status = this.extractStatus(m);
      const where: any = {}; if (prov) where.provider = prov; if (status) where.status = status;
      const [total, byProv, byStatus, byType] = await Promise.all([
        P.resource.count({ where }),
        P.resource.groupBy({ by: ['provider'], where, _count: true }),
        P.resource.groupBy({ by: ['status'], where, _count: true }),
        P.resource.groupBy({ by: ['type'], where, _count: true }),
      ]);
      const sc = (a: any, b: any) => b._count - a._count;
      const provTxt = byProv.sort(sc).map((r: any) => `${r.provider} ${r._count}`).join(', ');
      const statusTxt = byStatus.sort(sc).map((r: any) => `${r.status} ${r._count}`).join(', ');
      const typeTxt = byType.sort(sc).map((r: any) => `${r.type} ${r._count}`).join(', ');
      const scope = `${status ? status + ' ' : ''}${prov ? prov.toUpperCase() + ' ' : ''}`.trim();
      const head = intent === 'overview' ? `You have ${total} resources${scope ? ` (${scope})` : ''} across your clouds.` : `📦 Inventory — ${total} ${scope ? scope + ' ' : ''}resource(s).`;
      return `${head}\n• By provider: ${provTxt}\n• By status: ${statusTxt}\n• By type: ${typeTxt}`;
    }

    if (intent === 'cost') {
      const conns = await P.cloudConnection.findMany({ select: { provider: true, monthlyCost: true, currency: true } });
      const cur = conns.find((c) => c.currency)?.currency ?? 'USD';
      const total = conns.reduce((s, c) => s + (c.monthlyCost ?? 0), 0);
      const byProv = conns.filter((c) => (c.monthlyCost ?? 0) > 0).sort((a, b) => (b.monthlyCost ?? 0) - (a.monthlyCost ?? 0)).map((c) => `${c.provider} ${this.money(c.monthlyCost ?? 0, cur)}`).join(', ') || 'no billing data yet';
      const top = await P.resource.findMany({ where: { monthlyCost: { gt: 0 } }, orderBy: { monthlyCost: 'desc' }, take: 5, select: { name: true, provider: true, monthlyCost: true } });
      const topTxt = top.map((r) => `${r.name} (${r.provider}) ${this.money(r.monthlyCost, cur)}/mo`).join('; ');
      const topLine = topTxt ? `\n• Top drivers: ${topTxt}` : '';
      return `💰 Cost — total monthly spend is ${this.money(total, cur)}.\n• By provider: ${byProv}${topLine}\nOpen FinOps & Carbon for budgets, forecast and savings.`;
    }

    if (intent === 'security') {
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const [sev, top, risks] = await Promise.all([
        P.securityFinding.groupBy({ by: ['severity'], where: { status: 'open' }, _count: true }),
        P.securityFinding.findMany({ where: { status: 'open' }, orderBy: { detectedAt: 'desc' }, take: 5, select: { title: true, severity: true, provider: true } }),
        P.networkRisk.findMany({ orderBy: { ts: 'desc' }, take: 3, select: { resourceName: true, ruleName: true, severity: true, ports: true } }),
      ]);
      const totalF = sev.reduce((s, x: any) => s + x._count, 0);
      const sevTxt = sev.sort((a, b) => order[a.severity] - order[b.severity]).map((s: any) => `${s.severity} ${s._count}`).join(', ') || 'none';
      const topTxt = top.map((f) => `[${f.severity}] ${f.title} (${f.provider})`).join('; ');
      const riskTxt = risks.map((r) => `[${r.severity}] ${r.resourceName}/${r.ruleName} ports ${r.ports}`).join('; ');
      return `🛡 Security — ${totalF} open finding(s): ${sevTxt}.\n• Recent: ${topTxt || 'none'}${riskTxt ? `\n• Risky network rules: ${riskTxt}` : ''}\nOpen Security for the full posture and remediation.`;
    }

    if (intent === 'monitoring') {
      const fiveMin = new Date(Date.now() - 5 * 60_000);
      const [inc, hot, online, totalA] = await Promise.all([
        P.incident.findMany({ where: { status: { not: 'resolved' } }, orderBy: { openedAt: 'desc' }, take: 5, select: { title: true, severity: true } }),
        P.resource.findMany({ where: { status: 'running', OR: [{ cpuPct: { gte: 80 } }, { memoryPct: { gte: 80 } }] }, orderBy: { cpuPct: 'desc' }, take: 5, select: { name: true, cpuPct: true, memoryPct: true } }),
        P.agent.count({ where: { lastSeenAt: { gte: fiveMin } } }),
        P.agent.count(),
      ]);
      const incTxt = inc.length ? inc.map((i) => `${i.title} (${i.severity})`).join('; ') : 'none open';
      const hotTxt = hot.length ? hot.map((r) => `${r.name} CPU ${Math.round(r.cpuPct)}%/mem ${Math.round(r.memoryPct)}%`).join('; ') : 'none';
      return `📡 Monitoring — ${inc.length} open incident(s): ${incTxt}.\n• Agents online: ${online}/${totalA}\n• High-load resources: ${hotTxt}`;
    }

    if (intent === 'idle') {
      const idle = await P.resource.findMany({ where: { status: 'running', type: { in: ['compute', 'container', 'database'] as any }, cpuPct: { lt: 10 } }, orderBy: { monthlyCost: 'desc' }, take: 8, select: { name: true, provider: true, monthlyCost: true, cpuPct: true } });
      const cur = (await P.cloudConnection.findFirst({ where: { currency: { not: null } }, select: { currency: true } }))?.currency ?? 'USD';
      if (!idle.length) return '✅ No idle compute detected — your running workloads are all above 10% CPU.';
      const save = idle.reduce((s, r) => s + (r.monthlyCost ?? 0), 0) * 0.7;
      const list = idle.slice(0, 6).map((r) => `${r.name} (${r.provider}) ${Math.round(r.cpuPct)}% CPU, ${this.money(r.monthlyCost ?? 0, cur)}/mo`).join('; ');
      return `🪫 Idle / underused — ${idle.length} running resource(s) under 10% CPU.\n• ${list}\n• Estimated savings if right-sized/stopped: ~${this.money(save, cur)}/mo.`;
    }

    if (intent === 'agents') {
      const fiveMin = new Date(Date.now() - 5 * 60_000);
      const rows = await P.agent.findMany({ orderBy: { name: 'asc' }, select: { name: true, os: true, cpuPct: true, memPct: true, lastSeenAt: true } });
      if (!rows.length) return '🖥 No guest agents enrolled yet. Add one from Command Center → Guest Agents.';
      const online = rows.filter((r) => r.lastSeenAt && r.lastSeenAt >= fiveMin).length;
      const list = rows.slice(0, 8).map((r) => `${r.name} (${r.os ?? '?'}) ${r.lastSeenAt && r.lastSeenAt >= fiveMin ? 'online' : 'offline'} — CPU ${Math.round(r.cpuPct ?? 0)}%/mem ${Math.round(r.memPct ?? 0)}%`).join('; ');
      return `🖥 Guest agents — ${online}/${rows.length} online.\n• ${list}`;
    }

    if (intent === 'compliance') {
      const [byEnv, recent] = await Promise.all([
        P.policyViolation.groupBy({ by: ['environment'], _count: true }),
        P.policyViolation.findMany({ orderBy: { ts: 'desc' }, take: 5, select: { resourceName: true, environment: true, detail: true } }),
      ]);
      const total = byEnv.reduce((s, x: any) => s + x._count, 0);
      if (!total) return '⚖ Compliance — no open policy violations. 🎉';
      const envTxt = byEnv.map((e: any) => `${e.environment} ${e._count}`).join(', ');
      const recentTxt = recent.map((v) => `${v.resourceName} [${v.environment}]${v.detail ? ` — ${v.detail}` : ''}`).join('; ');
      return `⚖ Compliance — ${total} policy violation(s).\n• By environment: ${envTxt}\n• Recent: ${recentTxt}\nOpen Governance for policies and remediation.`;
    }

    if (intent === 'carbon') {
      return '🌱 Estimated carbon is in FinOps & Carbon → Carbon: monthly tCO₂e, energy, weighted grid intensity, per-region/provider breakdowns and decarbonisation tips.';
    }

    return this.answerIntent('overview', m);
  }

  // ───────────────────────── Cloud AI Engine — cross-platform reasoning ─────────────────────────
  private readonly SCOPES = ['fleet', 'monitoring', 'security', 'cost', 'compliance'] as const;

  /** Gather a focused, factual snapshot for a given analysis domain. */
  private async scopeSignals(scope: string): Promise<{ label: string; signals: string[] }> {
    if (scope === 'monitoring') {
      const [incidents, hot, agents, agentsTotal] = await Promise.all([
        this.prisma.incident.findMany({ where: { status: { not: 'resolved' } }, orderBy: { openedAt: 'desc' }, take: 8, select: { title: true, severity: true } }),
        this.prisma.resource.findMany({ where: { status: 'running', OR: [{ cpuPct: { gte: 80 } }, { memoryPct: { gte: 80 } }] }, orderBy: { cpuPct: 'desc' }, take: 8, select: { name: true, cpuPct: true, memoryPct: true } }),
        this.prisma.agent.count({ where: { lastSeenAt: { gte: new Date(Date.now() - 5 * 60_000) } } }),
        this.prisma.agent.count(),
      ]);
      return {
        label: 'Monitoring & Reliability',
        signals: [
          `Open incidents: ${incidents.length}` + (incidents.length ? ` — ${incidents.map((i) => `${i.title} (${i.severity})`).join('; ')}` : ''),
          `Agents online: ${agents}/${agentsTotal}`,
          ...hot.map((r) => `High load: ${r.name} CPU ${Math.round(r.cpuPct)}% / Mem ${Math.round(r.memoryPct)}%`),
        ],
      };
    }
    if (scope === 'security') {
      const [bySev, risks, recent] = await Promise.all([
        this.prisma.securityFinding.groupBy({ by: ['severity'], where: { status: 'open' }, _count: true }),
        this.prisma.networkRisk.findMany({ orderBy: { ts: 'desc' }, take: 6, select: { resourceName: true, ruleName: true, severity: true, ports: true } }),
        this.prisma.securityFinding.findMany({ where: { status: 'open' }, orderBy: { detectedAt: 'desc' }, take: 6, select: { title: true, severity: true, provider: true } }),
      ]);
      return {
        label: 'Security Posture',
        signals: [
          `Open findings by severity: ${bySev.map((s) => `${s.severity}=${s._count}`).join(', ') || 'none'}`,
          ...recent.map((f) => `Finding [${f.severity}] ${f.title} (${f.provider})`),
          ...risks.map((r) => `Risky rule [${r.severity}] ${r.resourceName}/${r.ruleName} ports ${r.ports}`),
        ],
      };
    }
    if (scope === 'cost') {
      const [conns, top] = await Promise.all([
        this.prisma.cloudConnection.findMany({ select: { provider: true, monthlyCost: true, currency: true } }),
        this.prisma.resource.findMany({ where: { status: 'running' }, orderBy: { monthlyCost: 'desc' }, take: 6, select: { name: true, provider: true, monthlyCost: true, cpuPct: true } }),
      ]);
      const cur = conns.find((c) => c.currency)?.currency ?? 'USD';
      const total = conns.reduce((s, c) => s + (c.monthlyCost ?? 0), 0);
      const idle = top.filter((r) => r.cpuPct < 10);
      return {
        label: 'Cost & Efficiency (FinOps)',
        signals: [
          `Total monthly spend: ${cur} ${Math.round(total)}`,
          `Spend by provider: ${conns.map((c) => `${c.provider}=${Math.round(c.monthlyCost ?? 0)}`).join(', ')}`,
          ...top.map((r) => `Top cost: ${r.name} (${r.provider}) ${cur} ${Math.round(r.monthlyCost)}/mo @ ${Math.round(r.cpuPct)}% CPU`),
          idle.length ? `Idle-but-billed candidates: ${idle.map((r) => r.name).join(', ')}` : 'No obviously idle high-cost resources.',
        ],
      };
    }
    if (scope === 'compliance') {
      const [violations, byEnv] = await Promise.all([
        this.prisma.policyViolation.findMany({ orderBy: { ts: 'desc' }, take: 10, select: { resourceName: true, environment: true, detail: true } }),
        this.prisma.policyViolation.groupBy({ by: ['environment'], _count: true }),
      ]);
      return {
        label: 'Governance & Compliance',
        signals: [
          `Policy violations by environment: ${byEnv.map((e) => `${e.environment}=${e._count}`).join(', ') || 'none'}`,
          ...violations.map((v) => `Violation: ${v.resourceName} [${v.environment}] ${v.detail ?? ''}`),
        ],
      };
    }
    // fleet (default)
    const [byProvider, byStatus, agents] = await Promise.all([
      this.prisma.resource.groupBy({ by: ['provider'], _count: true }),
      this.prisma.resource.groupBy({ by: ['status'], _count: true }),
      this.prisma.agent.count(),
    ]);
    return {
      label: 'Fleet Overview',
      signals: [
        `Resources by provider: ${byProvider.map((p) => `${p.provider}=${p._count}`).join(', ')}`,
        `Resources by status: ${byStatus.map((s) => `${s.status}=${s._count}`).join(', ')}`,
        `Guest agents: ${agents}`,
      ],
    };
  }

  /** AI analysis + reasoning for a platform domain. LLM-written when the engine is up, heuristic otherwise. */
  async analyze(scopeIn?: string) {
    const scope = (this.SCOPES as readonly string[]).includes(scopeIn ?? '') ? (scopeIn as string) : 'fleet';
    const { label, signals } = await this.scopeSignals(scope);
    const cleaned = signals.filter(Boolean);
    const system = 'You are the MCMF Cloud AI Engine, an autonomous multi-cloud SRE + SecOps + FinOps analyst. Reason over the signals and produce: (1) a 2-sentence assessment, (2) the top 3 risks or issues, (3) a prioritised, concrete action list. Be specific and brief. Use plain text with short headings.';
    const prompt = `Domain: ${label}\n\nLive signals:\n${cleaned.map((s) => `- ${s}`).join('\n')}\n\nAnalyse and advise.`;
    const analysis = await this.tryComplete(system, prompt, 650);
    if (analysis) return { scope, label, model: this.model(this.provider()), source: this.provider() === 'local' ? 'local' : 'llm', analysis, signals: cleaned };
    return { scope, label, model: this.useLlm() ? this.model(this.provider()) : 'built-in', source: 'rules', analysis: `Summary for ${label}:\n- ${cleaned.join('\n- ')}`, signals: cleaned, note: this.degradedNote() };
  }

  /** AI analysis of the latest VAPT / cloud-security findings: prioritised risk, attack paths, concrete
   *  remediation + an executive summary — GROUNDED in the real findings the scanners produced (no
   *  invented CVEs). The scan itself stays with Nmap/cloud-native; this is the analyst layer on top. */
  async vaptAnalysis() {
    const findings = await this.prisma.securityFinding.findMany({
      where: { status: 'open' },
      orderBy: { detectedAt: 'desc' },
      take: 150,
      select: { title: true, type: true, severity: true, provider: true, resourceName: true, source: true },
    });
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    const bySeverity: Record<string, number> = {};
    for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const sevTxt = Object.entries(bySeverity).sort((a, b) => (order[a[0]] ?? 9) - (order[b[0]] ?? 9)).map(([s, n]) => `${s}=${n}`).join(', ') || 'none';

    if (!findings.length) {
      return { source: 'rules', model: 'built-in', count: 0, bySeverity, analysis: 'No open security findings. Run an External VAPT scan (or Refresh findings) first, then re-run the AI analysis.' };
    }

    const lines = sorted.slice(0, 90).map((f) => `[${f.severity}] ${f.type} — ${f.title}${f.resourceName ? ` on ${f.resourceName}` : ''} (${f.provider}${f.source ? '/' + f.source : ''})`);
    const system =
      'You are a senior penetration tester writing the analysis section of a VAPT report. You are given FINDINGS already produced by scanners (Nmap NSE / cloud-native). ' +
      'Use ONLY the findings provided — do NOT invent CVEs, ports or hosts. Produce plain text with short headings: ' +
      '(1) Executive summary (2-3 sentences) with an overall risk rating; (2) Top prioritised risks, most exploitable / highest blast-radius first, each with a one-line why; ' +
      '(3) Likely attack paths that chain findings together; (4) Concrete remediation per top risk (scope the NSG/security-group port, enable NLA, disable legacy TLS, patch the CVE, etc.). Be specific and concise.';
    const prompt = `Open findings: ${findings.length} (${sevTxt}).\n\nFINDINGS:\n${lines.join('\n')}\n\nWrite the VAPT analysis.`;
    const analysis = await this.tryComplete(system, prompt, 900);
    if (analysis) return { source: this.provider() === 'local' ? 'local' : 'llm', model: this.model(this.provider()), count: findings.length, bySeverity, analysis };

    const top = sorted.slice(0, 12).map((f) => `• [${f.severity}] ${f.title}${f.resourceName ? ` — ${f.resourceName}` : ''} (${f.provider})`).join('\n');
    const native = `VAPT findings — ${findings.length} open (${sevTxt}).\n\nHighest severity first:\n${top}\n\nRemediate top-down: close/scope exposed ports in the cloud NSG/security-group + OS firewall, disable legacy services & TLS, and patch flagged CVEs at the source.`;
    return { source: 'rules', model: this.useLlm() ? this.model(this.provider()) : 'built-in', count: findings.length, bySeverity, analysis: native, note: this.degradedNote() };
  }

  /** AI release notes for a build: infer Features / Changes / Fixes from its changed file list. */
  async releaseNotes(body: { files?: { p: string; c: string }[]; version?: string }) {
    const files = Array.isArray(body?.files) ? body.files.slice(0, 200) : [];
    if (!files.length) return { source: 'rules', model: 'built-in', notes: 'No changed files were recorded for this build (config/data-only deploy or initial baseline).' };
    const list = files.map((f) => `${f.c === '+' ? 'added' : f.c === '-' ? 'removed' : 'modified'} ${f.p}`).join('\n');
    const system =
      'You are a release manager writing changelog notes for ONE software build. You are given the list of changed source files. ' +
      'Infer the feature area from each path (features/security = Security & Alerting, connectors = cloud discovery, modules/ai = AI Engine, OsInventory = OS Inventory, prisma/schema = database, components/app/lib = web UI). ' +
      'Write concise notes grouped under headings: "✨ Features", "🔧 Changes & improvements", "🐛 Fixes". 4–10 bullets total. Be specific where the path makes it clear, but do NOT fabricate details the paths do not imply — when unsure, describe the area updated. Plain text.';
    const prompt = `Build ${body.version ?? ''} — changed files:\n${list}\n\nWrite the release notes.`;
    const out = await this.tryComplete(system, prompt, 600);
    if (out) return { source: this.provider() === 'local' ? 'local' : 'llm', model: this.model(this.provider()), notes: out };
    return { source: 'rules', model: this.useLlm() ? this.model(this.provider()) : 'built-in', notes: 'AI engine is busy — use the feature-area summary shown on the build; retry the AI release notes shortly.', note: this.degradedNote() };
  }

  /** Tailored AI "how to fix" for a SINGLE security finding (per-finding remediation on click). */
  async remediation(f: { title?: string; type?: string; provider?: string; resourceName?: string }) {
    const title = String(f?.title ?? '').trim().slice(0, 300);
    if (!title) return { source: 'rules', model: 'built-in', steps: 'No finding specified.' };
    const system =
      'You are a cloud security engineer. For the SINGLE finding given, output plain text: (1) one line on the risk / why it matters; ' +
      '(2) numbered, specific remediation steps — exact cloud/OS actions (NSG / security-group rule, OS firewall, service config, disk encryption, patch version); ' +
      '(3) a one-line how-to-verify. Be concrete and concise. Do not invent CVEs or details not implied by the finding.';
    const prompt = `Finding: "${title}"\nType: ${f.type ?? 'n/a'} · Provider: ${f.provider ?? 'n/a'}${f.resourceName ? ` · Resource: ${f.resourceName}` : ''}\n\nHow do I fix this?`;
    const out = await this.tryComplete(system, prompt, 450);
    if (out) return { source: this.provider() === 'local' ? 'local' : 'llm', model: this.model(this.provider()), steps: out };
    return { source: 'rules', model: this.useLlm() ? this.model(this.provider()) : 'built-in', steps: 'AI engine is busy — the built-in remediation shown is the recommended fix; retry the AI deep-dive shortly.', note: this.degradedNote() };
  }

  /** AI risk assessment + recommendation for a pending approval (decision support for the workflow). */
  async approvalInsight(id?: string) {
    const req = id
      ? await this.prisma.approvalRequest.findUnique({ where: { id } })
      : await this.prisma.approvalRequest.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' } });
    if (!req) return { found: false, model: this.model(this.provider()), recommendation: 'No pending approval to assess.' };
    const facts = `Action: ${req.action}\nTitle: ${req.title}\nResource: ${req.resourceName ?? req.resourceRef ?? 'n/a'}\nRequested by: ${req.requestedByEmail}\nPayload: ${JSON.stringify(req.payload).slice(0, 500)}`;
    const system = 'You are the MCMF Cloud AI Engine assisting an approver. Given a change-approval request, assess blast radius and risk, then give a clear recommendation: APPROVE or REJECT (or APPROVE WITH CAUTION), with a one-line justification and any checks to run first. Be concise.';
    const llm = await this.tryComplete(system, facts, 350);
    if (llm) return { found: true, id: req.id, action: req.action, model: this.model(this.provider()), source: this.provider() === 'local' ? 'local' : 'llm', recommendation: llm };
    const risky = /delete|destroy|terminate|remediate|provision/.test(req.action);
    return { found: true, id: req.id, action: req.action, model: this.useLlm() ? this.model(this.provider()) : 'built-in', source: 'rules', recommendation: `${risky ? '⚠ Elevated-risk action — verify blast radius and ownership before approving.' : 'Standard action — low blast radius.'}\n${facts}`, note: this.degradedNote() };
  }

  /** AI-proposed automation rules from current operational patterns (feeds the automation engine). */
  async automationSuggest() {
    const [topAlerts, incidents, hot] = await Promise.all([
      this.prisma.alert.groupBy({ by: ['title'], where: { status: 'active' }, _count: true, orderBy: { _count: { title: 'desc' } }, take: 6 }).catch(() => [] as any[]),
      this.prisma.incident.count({ where: { status: { not: 'resolved' } } }),
      this.prisma.resource.count({ where: { status: 'running', cpuPct: { gte: 85 } } }),
    ]);
    const signals = [
      `Recurring active alerts: ${topAlerts.map((a: any) => `${a.title} x${a._count}`).join(', ') || 'none'}`,
      `Open incidents: ${incidents}`,
      `Sustained-high-CPU resources: ${hot}`,
    ];
    const system = 'You are the MCMF Cloud AI Engine. From the operational signals, propose 3-4 concrete automation rules in the form "WHEN <trigger> THEN <action>" that MCMF could run (alert rules, auto-remediation, scaling, notifications, scheduled power-off). One line each, plus a 4-word rationale. Be specific.';
    const llm = await this.tryComplete(system, `Signals:\n${signals.map((s) => `- ${s}`).join('\n')}`, 450);
    if (llm) return { model: this.model(this.provider()), source: this.provider() === 'local' ? 'local' : 'llm', suggestions: llm, signals };
    return { model: this.useLlm() ? this.model(this.provider()) : 'built-in', source: 'rules', suggestions: signals.join('\n'), signals, note: this.degradedNote() };
  }
}
