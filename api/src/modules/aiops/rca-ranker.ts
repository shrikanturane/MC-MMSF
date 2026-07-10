/**
 * Deterministic RCA cause ranker — turns an alert/incident + correlated evidence
 * into a RANKED list of candidate root causes, so RCA quality is measurable as
 * top-k accuracy / precision@1 against seeded ground truth (thesis tests 5.1/5.4).
 *
 * Pure: same subject + evidence → same ranking. The LLM narrative (ai.service)
 * stays for the human explanation; this list is the scoreable verdict.
 */

export interface RcaSubject {
  title: string;
  metric?: string | null;
  resourceName?: string | null;
  value?: number | null;
}

export interface RankedCause {
  cause: string; // stable id, e.g. 'cpu-saturation'
  label: string;
  score: number; // 0..1 normalized
  rationale: string;
}

interface CauseDef {
  cause: string;
  label: string;
  metric?: string; // subject.metric that strongly implies this cause
  keywords: RegExp; // evidence text signature
}

/** Cause catalogue — keyword signatures over evidence lines + the subject metric. */
const CAUSES: CauseDef[] = [
  { cause: 'cpu-saturation', label: 'CPU saturation / runaway workload', metric: 'cpu', keywords: /\bcpu\b|processor|load average|high cpu/i },
  { cause: 'memory-pressure', label: 'Memory pressure / leak', metric: 'memory', keywords: /\bmem(ory)?\b|oom|out of memory|swap/i },
  { cause: 'disk-full', label: 'Disk capacity exhaustion', metric: 'disk', keywords: /\bdisk\b|storage full|no space|volume|filesystem/i },
  { cause: 'network-anomaly', label: 'Network anomaly / connectivity loss', metric: 'network', keywords: /\bnet(work)?\b|latency|unreachable|packet|jitter|timeout|down\b/i },
  { cause: 'cost-spike', label: 'Cost / billing spike', metric: 'cost', keywords: /\bcost\b|billing|spend|budget|anomal(y|ous) cost/i },
  { cause: 'power-state', label: 'VM powered off / host offline', keywords: /power(ed)? off|vm_power_off|agent offline|host offline|stopped/i },
  { cause: 'security-event', label: 'Security event / unauthorized activity', keywords: /siem critical|unauthorized|brute|failed login|intrusion|malware|attack/i },
];

/**
 * Rank candidate causes. Scoring (deterministic):
 *   +3.0  subject metric matches the cause's metric
 *   +1.0  per evidence line matching the cause signature (cap 5)
 *   +1.5  subject title matches the cause signature
 * Normalized to 0..1 against the max achievable (9.5); top 5 returned.
 */
export function rankCauses(subject: RcaSubject, evidence: string[]): RankedCause[] {
  const MAX = 9.5;
  const ranked = CAUSES.map((def) => {
    let score = 0;
    const why: string[] = [];
    if (def.metric && subject.metric && subject.metric.toLowerCase().startsWith(def.metric)) {
      score += 3;
      why.push(`alert metric '${subject.metric}'`);
    }
    let hits = 0;
    for (const line of evidence) if (def.keywords.test(line)) hits++;
    if (hits > 0) {
      score += Math.min(hits, 5);
      why.push(`${hits} corroborating signal(s)`);
    }
    if (def.keywords.test(subject.title)) {
      score += 1.5;
      why.push('alert title match');
    }
    return {
      cause: def.cause,
      label: def.label,
      score: Math.round((score / MAX) * 1000) / 1000,
      rationale: why.join(', ') || 'no direct signal',
    };
  })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.cause.localeCompare(b.cause)); // stable tie-break
  return ranked.slice(0, 5);
}
