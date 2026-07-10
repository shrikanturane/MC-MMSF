'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export const PALETTE = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316'];

const AXIS = { stroke: '#475569', fontSize: 10 };
const TOOLTIP_STYLE = {
  background: '#0d1320',
  border: '1px solid #1e293b',
  borderRadius: 8,
  fontSize: 12,
  color: '#e2e8f0',
};

export function AreaTrend({
  data,
  color = '#3b82f6',
  height = 140,
  unit = '',
}: {
  data: { ts: string; value: number }[];
  color?: string;
  height?: number;
  unit?: string;
}) {
  const id = `g-${color.replace('#', '')}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 5, right: 6, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="ts"
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => new Date(v).getHours() + 'h'}
          minTickGap={24}
        />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => new Date(v as string).toLocaleTimeString()}
          formatter={(v) => [`${v}${unit}`, '']}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${id})`}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function StackedBars({
  data,
  keys,
  height = 220,
}: {
  data: Record<string, number | string>[];
  keys: { key: string; color: string }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 5, right: 6, left: -18, bottom: 0 }}>
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#ffffff08' }} />
        {keys.map((k, i) => (
          <Bar
            key={k.key}
            dataKey={k.key}
            stackId="a"
            fill={k.color}
            radius={i === keys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoryBar({ data, height = 200 }: { data: { label: string; value: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 5, right: 6, left: -18, bottom: 0 }}>
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval={0} angle={data.length > 5 ? -25 : 0} textAnchor={data.length > 5 ? 'end' : 'middle'} height={data.length > 5 ? 40 : 20} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#ffffff08' }} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoryPie({ data, height = 200, donut = true, fmt }: { data: { label: string; value: number }[]; height?: number; donut?: boolean; fmt?: (n: number) => string }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  // Pie + an inline legend so every slice is identifiable (label · value · %).
  return (
    <div className="flex items-center gap-3" style={{ height }}>
      <div className="shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={donut ? '55%' : 0} outerRadius="90%" paddingAngle={donut ? 2 : 0} stroke="none">
              {data.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, n) => [`${fmt ? fmt(v) : v} (${Math.round((v / total) * 100)}%)`, n]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-0 flex-1 space-y-1 overflow-y-auto pr-1" style={{ maxHeight: height }}>
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2 text-2xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate capitalize text-muted-light" title={d.label}>{d.label}</span>
            <span className="shrink-0 font-medium text-white">{fmt ? fmt(d.value) : d.value}</span>
            <span className="w-8 shrink-0 text-right text-muted">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Gauge({ value, max = 100, color = '#3b82f6', height = 180 }: { value: number; max?: number; color?: string; height?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadialBarChart innerRadius="70%" outerRadius="100%" data={[{ value: pct, fill: color }]} startAngle={210} endAngle={-30}>
        <RadialBar background={{ fill: '#1e293b' }} dataKey="value" cornerRadius={8} />
        <text x="50%" y="58%" textAnchor="middle" className="fill-white" style={{ fontSize: 22, fontWeight: 600 }}>
          {Math.round(value)}
          {max === 100 ? '%' : ''}
        </text>
      </RadialBarChart>
    </ResponsiveContainer>
  );
}

export function Donut({
  data,
  height = 200,
}: {
  data: { name: string; value: number; color: string }[];
  height?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div className="flex items-center gap-3" style={{ height }}>
      <div className="shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={2} stroke="none">
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toLocaleString()} (${Math.round((v / total) * 100)}%)`, '']} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-0 flex-1 space-y-1 overflow-y-auto pr-1" style={{ maxHeight: height }}>
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2 text-2xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d.color }} />
            <span className="min-w-0 flex-1 truncate capitalize text-muted-light" title={d.name}>{d.name}</span>
            <span className="shrink-0 font-medium text-white">${d.value.toLocaleString()}</span>
            <span className="w-8 shrink-0 text-right text-muted">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
