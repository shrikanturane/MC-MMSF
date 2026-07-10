'use client';

import { Board } from '@/features/board/Board';
import type { BoardPanel } from '@/lib/types';

const SEED: BoardPanel[] = [
  { i: 'kpis', kind: 'mgmt-kpis', title: 'Overview', x: 0, y: 0, w: 12, h: 4 },
  { i: 'cloud', kind: 'cloud-dist', title: 'Cloud Distribution', x: 0, y: 4, w: 6, h: 5 },
  { i: 'cost', kind: 'cost-dist', title: 'Cost Distribution', x: 6, y: 4, w: 6, h: 5 },
  { i: 'sec', kind: 'security-overview', title: 'Security Overview', x: 0, y: 9, w: 6, h: 5 },
  { i: 'drivers', kind: 'cost-drivers', title: 'Top Cost Drivers', x: 6, y: 9, w: 6, h: 6 },
  { i: 'inc', kind: 'incidents', title: 'Recent Incidents', x: 0, y: 15, w: 6, h: 6 },
  { i: 'reqs', kind: 'requests', title: 'Provisioning Requests', x: 6, y: 15, w: 6, h: 6 },
  { i: 'rules', kind: 'rules', title: 'Alert Rules', x: 0, y: 26, w: 12, h: 6 },
  { i: 'vms', kind: 'vms', title: 'Virtual Machines', x: 0, y: 32, w: 12, h: 9 },
];

export function ManagementView() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-panel px-4 py-3">
        <div className="text-sm font-semibold text-white">Multi-Cloud Management Framework</div>
        <div className="text-2xs text-muted">Fully customizable — every panel is a live widget. Drag to rearrange, resize from the corner, switch charts, add/remove. Saved automatically.</div>
      </div>
      <Board boardKey="management" seed={SEED} />
    </div>
  );
}
