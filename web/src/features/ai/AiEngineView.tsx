'use client';

import { useRef, useState, useEffect } from 'react';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import {
  useAiStatus, useAgentStatus, useAiChat,
  useAiAssistant, useRca, useAiAnalyze, useApprovalInsight, useAutomationSuggest,
} from '@/lib/hooks';
import { useTabParam } from '@/lib/useTabParam';
import { AnomaliesPanel } from './anomalies';
import { ValidationPanel } from './validation';

const SCOPES: { key: string; label: string; icon: string }[] = [
  { key: 'fleet', label: 'Fleet', icon: '🗄' },
  { key: 'monitoring', label: 'Monitoring', icon: '📡' },
  { key: 'security', label: 'Security', icon: '🛡' },
  { key: 'cost', label: 'Cost / FinOps', icon: '💰' },
  { key: 'compliance', label: 'Compliance', icon: '⚖' },
];

const SUGGESTIONS = [
  'How many resources do I have and where are they?',
  'What are my top security risks right now?',
  'Where is my cloud spend going this month?',
  'Which workloads are overloaded or idle?',
  'Are all my guest agents online?',
];

/** Renders LLM plain-text output with light structure (headings / bullets). */
function AiText({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm leading-relaxed text-muted-light">
      {text.split('\n').map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} className="h-1" />;
        const heading = /^(#+\s|[0-9]+[.)]\s|\*\*|[A-Z][A-Za-z /&]+:$)/.test(t) && t.length < 60;
        const bullet = /^[-*•]\s/.test(t);
        if (bullet) return <div key={i} className="flex gap-2 pl-1"><span className="text-brand">•</span><span>{t.replace(/^[-*•]\s/, '')}</span></div>;
        if (heading) return <div key={i} className="pt-1 font-semibold text-white">{t.replace(/\*\*/g, '').replace(/^#+\s/, '')}</div>;
        return <div key={i}>{t}</div>;
      })}
    </div>
  );
}

function SourceBadge({ source, model }: { source?: string; model?: string }) {
  const native = source === 'native';
  const local = native || source === 'local' || source === 'engine-synth';
  const rules = source === 'rules' || !!source?.includes('fallback');
  const color = local ? '#10b981' : rules ? '#f59e0b' : '#3b82f6';
  const label = native ? 'instant · on-prem' : local ? `${source} · ${model}` : rules ? 'heuristic' : `${model ?? source}`;
  return <span className="pill" style={{ background: `${color}1a`, color }}>{label}</span>;
}

// ─────────────────────────────── Agent chat ───────────────────────────────
type Msg = { role: 'user' | 'ai'; text: string; engine?: string; model?: string };

function ChatPanel() {
  const chat = useAiChat();
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, chat.isPending]);

  const send = (text?: string) => {
    const m = (text ?? input).trim();
    if (!m || chat.isPending) return;
    setMsgs((x) => [...x, { role: 'user', text: m }]);
    setInput('');
    chat.mutate(m, {
      onSuccess: (d) => setMsgs((x) => [...x, { role: 'ai', text: d.answer, engine: d.engine, model: d.model }]),
      onError: () => setMsgs((x) => [...x, { role: 'ai', text: '⚠ The agent could not respond — it may still be loading the model. Try again in a moment.' }]),
    });
  };

  return (
    <div className="card flex flex-col" style={{ height: '64vh' }}>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {msgs.length === 0 && !chat.isPending && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-purple text-2xl">🤖</span>
            <div className="text-sm font-medium text-white">Ask about your whole estate</div>
            <div className="max-w-md text-2xs text-muted">An instant assistant reads your live inventory, monitoring, security, cost, compliance and agent data, then answers — no model to load.</div>
            <div className="mt-1 flex max-w-lg flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-card px-3 py-1 text-2xs text-muted-light hover:border-brand/50 hover:text-white">{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'user' ? (
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">{m.text}</div>
            ) : (
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-card/60 px-3.5 py-2.5">
                <AiText text={m.text} />
                {m.engine && <div className="mt-1.5"><SourceBadge source={m.engine} model={m.model} /></div>}
              </div>
            )}
          </div>
        ))}
        {chat.isPending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-card/60 px-3.5 py-2.5 text-2xs text-muted">
              <span className="flex gap-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.2s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.1s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand" /></span>
              checking your live data…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-border p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask the agent about inventory, cost, security, monitoring…" disabled={chat.isPending}
          className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-white disabled:opacity-60" />
        <button onClick={() => send()} disabled={chat.isPending || !input.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{chat.isPending ? '…' : 'Send'}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────── Engine tools ───────────────────────────────
function EngineTools() {
  const analyze = useAiAnalyze();
  const assistant = useAiAssistant();
  const rca = useRca();
  const automation = useAutomationSuggest();
  const approval = useApprovalInsight();
  const [scope, setScope] = useState('fleet');
  const [prompt, setPrompt] = useState('');

  return (
    <div className="grid gap-4">
      <Card title="AI Analysis & Reasoning"
        action={<button onClick={() => analyze.mutate(scope)} disabled={analyze.isPending} className="rounded-lg bg-brand px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{analyze.isPending ? 'Reasoning…' : 'Run analysis'}</button>}>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {SCOPES.map((sc) => (
            <button key={sc.key} onClick={() => setScope(sc.key)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${scope === sc.key ? 'border-brand bg-brand/15 text-white' : 'border-border bg-card text-muted-light hover:text-white'}`}>
              {sc.icon} {sc.label}
            </button>
          ))}
        </div>
        {analyze.isPending && <div className="text-2xs text-muted">Reasoning over live signals… (first run loads the model, ~10–30s).</div>}
        {analyze.data && (
          <div className="space-y-3">
            <div className="flex items-center gap-2"><span className="text-sm font-semibold text-white">{analyze.data.label}</span><SourceBadge source={analyze.data.source} model={analyze.data.model} /></div>
            <div className="rounded-lg border border-brand/20 bg-brand/5 p-3"><AiText text={analyze.data.analysis} /></div>
            <details className="text-2xs text-muted"><summary className="cursor-pointer hover:text-white">Live signals used ({analyze.data.signals.length})</summary>
              <ul className="mt-1 space-y-0.5 pl-3">{analyze.data.signals.map((sig, i) => <li key={i} className="list-disc text-muted-light">{sig}</li>)}</ul></details>
          </div>
        )}
        {!analyze.data && !analyze.isPending && <div className="text-2xs text-muted">Pick a domain and run an AI assessment over live fleet, monitoring, security, cost and compliance signals.</div>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Root-Cause Analysis"
          action={<button onClick={() => rca.mutate({})} disabled={rca.isPending} className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-light hover:text-white disabled:opacity-50">{rca.isPending ? 'Analysing…' : 'Analyse latest alert'}</button>}>
          {rca.data ? (
            <div className="space-y-2"><SourceBadge source={rca.data.source} model={rca.data.model} />
              <div className="rounded-lg border border-border bg-card/50 p-3"><AiText text={rca.data.narrative} /></div>
              {rca.data.evidence?.length > 0 && <details className="text-2xs text-muted"><summary className="cursor-pointer hover:text-white">Correlated evidence ({rca.data.evidence.length})</summary><ul className="mt-1 space-y-0.5 pl-3">{rca.data.evidence.map((e, i) => <li key={i} className="list-disc text-muted-light">{e}</li>)}</ul></details>}
            </div>
          ) : <div className="text-2xs text-muted">Correlates SIEM, events and metric outliers, then writes the root cause + remediation.</div>}
        </Card>

        <Card title="Automation Engine — AI Suggestions"
          action={<button onClick={() => automation.mutate()} disabled={automation.isPending} className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-light hover:text-white disabled:opacity-50">{automation.isPending ? 'Thinking…' : 'Suggest rules'}</button>}>
          {automation.data ? (
            <div className="space-y-2"><SourceBadge source={automation.data.source} model={automation.data.model} /><div className="rounded-lg border border-border bg-card/50 p-3"><AiText text={automation.data.suggestions} /></div></div>
          ) : <div className="text-2xs text-muted">Proposes WHEN→THEN automation rules from recurring alerts, incidents and load patterns.</div>}
        </Card>

        <Card title="Approval Decision Support"
          action={<button onClick={() => approval.mutate(undefined)} disabled={approval.isPending} className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-light hover:text-white disabled:opacity-50">{approval.isPending ? 'Assessing…' : 'Assess pending'}</button>}>
          {approval.data ? (approval.data.found ? (
            <div className="space-y-2"><div className="flex items-center gap-2 text-xs text-muted-light">Action: <span className="font-medium text-white">{approval.data.action}</span><SourceBadge source={approval.data.source} model={approval.data.model} /></div><div className="rounded-lg border border-border bg-card/50 p-3"><AiText text={approval.data.recommendation} /></div></div>
          ) : <div className="text-2xs text-muted">{approval.data.recommendation}</div>) : <div className="text-2xs text-muted">Assesses blast radius + risk of the latest pending change and recommends approve / reject.</div>}
        </Card>

        <Card title="Quick Ask (single-shot)">
          <div className="flex gap-2">
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && prompt.trim() && assistant.mutate(prompt)} placeholder="One-off question…" className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-white" />
            <button onClick={() => prompt.trim() && assistant.mutate(prompt)} disabled={assistant.isPending || !prompt.trim()} className="rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white disabled:opacity-50">{assistant.isPending ? '…' : 'Ask'}</button>
          </div>
          {assistant.data && <div className="mt-3 rounded-lg border border-border bg-card/50 p-3"><AiText text={assistant.data.answer} /></div>}
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────── Shell ───────────────────────────────
export function AiEngineView() {
  const status = useAiStatus();
  const agent = useAgentStatus();
  const [tab, setTab] = useTabParam<'chat' | 'tools' | 'anomalies' | 'validation'>('aitab', 'chat', ['chat', 'tools', 'anomalies', 'validation']);

  if (status.isLoading) return <LoadingState rows={5} />;
  if (status.isError) return <ErrorState />;
  const s = status.data!;
  const ready = !!agent.data?.ok;
  const cloudLlm = s.llm && s.provider !== 'free' && s.provider !== 'local';

  return (
    <div className="grid gap-4">
      <div className="card card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-purple text-xl">🧠</span>
            <div>
              <h1 className="text-lg font-semibold text-white">Cloud AI Engine</h1>
              <p className="text-2xs text-muted">Instant on-prem assistant — answers from your live inventory, monitoring, security, cost, compliance &amp; guest agents. No model to load, no waiting.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="pill" style={{ background: ready ? '#10b98122' : '#f59e0b22', color: ready ? '#10b981' : '#f59e0b' }}>● {ready ? 'Ready' : 'Starting'}</span>
            <span className="pill bg-card text-muted-light">native engine</span>
            {cloudLlm && <span className="pill bg-card text-muted-light">+ {s.model}</span>}
          </div>
        </div>
      </div>

      <div className="flex w-fit gap-1 rounded-lg border border-border bg-card p-1">
        {([['chat', '💬 Agent Chat'], ['tools', '🛠 Engine Tools'], ['anomalies', '📈 Anomalies'], ['validation', '🧪 Validation']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-4 py-1.5 text-sm transition ${tab === k ? 'bg-brand text-white' : 'text-muted-light hover:text-white'}`}>{label}</button>
        ))}
      </div>

      {tab === 'chat' ? <ChatPanel /> : tab === 'tools' ? <EngineTools /> : tab === 'anomalies' ? <AnomaliesPanel /> : <ValidationPanel />}
    </div>
  );
}
