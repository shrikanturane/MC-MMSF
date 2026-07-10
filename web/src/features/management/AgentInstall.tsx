'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui';
import { PROVIDER_COLORS, PROVIDER_LABELS, type Provider } from '@/lib/format';

interface AgentGuide {
  provider: Provider;
  title: string;
  intro: string;
  permission: string;
  steps: { label: string; cmd?: string }[];
}

const GUIDES: AgentGuide[] = [
  {
    provider: 'aws',
    title: 'CloudWatch Agent (EC2)',
    intro: 'Installs the CloudWatch Agent to publish mem_used_percent and disk_used_percent to the CWAgent namespace, which MCMF reads for memory/disk rules.',
    permission: 'Attach the managed policy CloudWatchAgentServerPolicy to the instance role.',
    steps: [
      { label: 'Install (Amazon Linux)', cmd: 'sudo yum install -y amazon-cloudwatch-agent' },
      { label: 'Install (Ubuntu/Debian)', cmd: 'sudo apt-get update && sudo apt-get install -y amazon-cloudwatch-agent' },
      {
        label: 'Write a minimal config (memory + disk %)',
        cmd: `sudo tee /opt/aws/amazon-cloudwatch-agent/etc/config.json >/dev/null <<'JSON'
{ "metrics": { "metrics_collected": {
  "mem":  { "measurement": ["mem_used_percent"] },
  "disk": { "measurement": ["disk_used_percent"], "resources": ["/"] }
}}}
JSON`,
      },
      {
        label: 'Start the agent with the config',
        cmd: 'sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json',
      },
      { label: 'Windows: install via SSM or the MSI, then use amazon-cloudwatch-agent-ctl with the same config.' },
    ],
  },
  {
    provider: 'azure',
    title: 'Azure Monitor Agent (VM Insights)',
    intro: 'Enable VM Insights so guest memory and logical-disk counters flow to Azure Monitor, which MCMF reads for memory/disk rules.',
    permission: 'Your service principal needs the Monitoring Contributor role (one-time, to deploy the agent + data collection rule).',
    steps: [
      { label: 'Portal (easiest): VM → Monitoring → Insights → Enable → choose/create a Data Collection Rule.' },
      {
        label: 'CLI: install the Linux agent extension',
        cmd: 'az vm extension set --name AzureMonitorLinuxAgent --publisher Microsoft.Azure.Monitor --resource-group <rg> --vm-name <vm>',
      },
      {
        label: 'CLI: install the Windows agent extension',
        cmd: 'az vm extension set --name AzureMonitorWindowsAgent --publisher Microsoft.Azure.Monitor --resource-group <rg> --vm-name <vm>',
      },
      { label: 'Associate a Data Collection Rule that collects "% Used Memory" and "% Used Space" (the Insights wizard does this automatically).' },
    ],
  },
  {
    provider: 'gcp',
    title: 'Ops Agent (Compute Engine)',
    intro: 'Installs the Ops Agent to publish agent.googleapis.com/memory/percent_used and disk/percent_used to Cloud Monitoring, which MCMF reads for memory/disk rules.',
    permission: 'The VM service account needs roles/monitoring.metricWriter (default on most VMs).',
    steps: [
      { label: 'Download the installer', cmd: 'curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh' },
      { label: 'Install', cmd: 'sudo bash add-google-cloud-ops-agent-repo.sh --also-install' },
      { label: 'Verify', cmd: 'sudo systemctl status google-cloud-ops-agent"*"' },
    ],
  },
];

export function AgentInstallModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Provider>('aws');
  const guide = GUIDES.find((g) => g.provider === tab)!;

  return (
    <Modal title="Enable memory & disk metrics" subtitle="Install the guest agent so memory/disk threshold rules get data" onClose={onClose} wide>
      <div className="mb-3 flex gap-2">
        {GUIDES.map((g) => (
          <button
            key={g.provider}
            onClick={() => setTab(g.provider)}
            className={`rounded-lg border px-3 py-1.5 text-xs ${tab === g.provider ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted-light hover:text-white'}`}
          >
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: PROVIDER_COLORS[g.provider] }} />
            {PROVIDER_LABELS[g.provider]}
          </button>
        ))}
      </div>

      <div className="text-sm font-semibold text-white">{guide.title}</div>
      <p className="mt-1 text-2xs text-muted-light">{guide.intro}</p>
      <div className="mt-2 rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-2xs text-muted-light">
        <b className="text-warning">Permission · </b>{guide.permission}
      </div>

      <ol className="mt-3 space-y-2.5">
        {guide.steps.map((s, i) => (
          <li key={i} className="text-2xs">
            <div className="mb-1 text-muted-light"><span className="text-muted">{i + 1}.</span> {s.label}</div>
            {s.cmd && <CodeBlock code={s.cmd} />}
          </li>
        ))}
      </ol>

      <div className="mt-3 text-2xs text-muted">
        After ~5 minutes the agent publishes data and your memory/disk rules start evaluating automatically — no MCMF change needed.
      </div>
    </Modal>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2.5 pr-10 font-mono text-2xs text-muted-light">{code}</pre>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="absolute right-1.5 top-1.5 rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-brand hover:text-white"
      >
        {copied ? '✓' : 'copy'}
      </button>
    </div>
  );
}
