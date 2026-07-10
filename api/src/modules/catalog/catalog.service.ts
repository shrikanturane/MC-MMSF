import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as http from 'node:http';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptJson } from '../../connectors/crypto';
import { ConnectionsService } from '../connections/connections.service';
import { CATALOG, CatalogTemplate } from './catalog.templates';

const RUNNER = process.env.TF_RUNNER_URL || 'http://tf-runner:8080';
const clip = (s: unknown) => String(s ?? '').slice(-40000);

/**
 * Service Catalog: renders a template + inputs to Terraform, ships it to the tf-runner microservice to
 * plan/apply/destroy, and persists each run as a ProvisionJob. Cloud creds come from the selected
 * CloudConnection (decrypted, mapped to the provider's standard env vars) — the demo needs none.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService, private readonly connections: ConnectionsService) {}

  catalog() { return CATALOG.map(({ tf: _tf, ...meta }) => meta); }
  jobs() { return this.prisma.provisionJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }); }
  job(id: string) { return this.prisma.provisionJob.findUnique({ where: { id } }); }

  private tpl(key: string): CatalogTemplate {
    const t = CATALOG.find((c) => c.key === key);
    if (!t) throw new BadRequestException('unknown template');
    return t;
  }

  private coerce(t: CatalogTemplate, inputs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const inp of t.inputs) {
      let v = inputs?.[inp.key];
      if (v === undefined || v === '') v = inp.default;
      if (v === undefined) throw new BadRequestException(`missing required input: ${inp.label}`);
      out[inp.key] = inp.type === 'number' ? Number(v) : String(v);
    }
    return out;
  }

  /** Decrypt the chosen connection's creds and map to the provider's Terraform env vars. */
  private async credEnv(t: CatalogTemplate, connectionId?: string | null): Promise<Record<string, string>> {
    if (t.cloud === 'demo') return {};
    if (!connectionId) throw new BadRequestException(`select a ${t.cloud.toUpperCase()} cloud connection for this template`);
    const conn = await this.prisma.cloudConnection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new BadRequestException('cloud connection not found');
    const c = decryptJson<Record<string, string>>(conn.credentials);
    if (t.cloud === 'aws') return { AWS_ACCESS_KEY_ID: c.accessKeyId ?? '', AWS_SECRET_ACCESS_KEY: c.secretAccessKey ?? '', AWS_REGION: c.region ?? 'us-east-1' };
    if (t.cloud === 'azure') return { ARM_CLIENT_ID: c.clientId ?? '', ARM_CLIENT_SECRET: c.clientSecret ?? '', ARM_TENANT_ID: c.tenantId ?? '', ARM_SUBSCRIPTION_ID: c.subscriptionId ?? '' };
    if (t.cloud === 'gcp') return { GOOGLE_CREDENTIALS: c.serviceAccountKey ?? '', GOOGLE_PROJECT: c.project ?? '' };
    return {};
  }

  private runner(payload: unknown): Promise<{ ok: boolean; log?: string; outputs?: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL('/run', RUNNER);
      const data = JSON.stringify(payload);
      const req = http.request(
        { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 600_000 },
        (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ ok: false, log: b }); } }); },
      );
      req.on('error', (e) => reject(new BadRequestException(`tf-runner unreachable: ${String((e as Error).message)}`)));
      req.on('timeout', () => { req.destroy(); reject(new BadRequestException('tf-runner timed out (the plan/apply took too long)')); });
      req.write(data); req.end();
    });
  }

  private files(t: CatalogTemplate, inputs: Record<string, unknown>) {
    return { 'main.tf': t.tf, 'terraform.tfvars.json': JSON.stringify(inputs) };
  }

  async plan(body: { template?: string; inputs?: Record<string, unknown>; connectionId?: string; title?: string }, actor: string) {
    const t = this.tpl(String(body?.template ?? ''));
    const inputs = this.coerce(t, body?.inputs ?? {});
    const env = await this.credEnv(t, body?.connectionId);
    const est = t.estMonthly?.(inputs) ?? { usd: 0, note: '' };
    const job = await this.prisma.provisionJob.create({ data: { template: t.key, title: body?.title?.trim() || t.name, cloud: t.cloud, connectionId: body?.connectionId ?? null, inputs: inputs as any, estCostMonthly: est.usd, costNote: est.note, status: 'planned', requestedBy: actor } });
    const r = await this.runner({ id: job.id, action: 'plan', files: this.files(t, inputs), env });
    return this.prisma.provisionJob.update({ where: { id: job.id }, data: { planLog: clip(r.log), status: r.ok ? 'pending_apply' : 'plan_failed' } });
  }

  async apply(id: string, actor: string) {
    const job = await this.prisma.provisionJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('job not found');
    if (job.status !== 'pending_apply') throw new BadRequestException('only a successfully-planned job can be applied');
    // Maker-checker (segregation of duties): when enabled, whoever planned it can't also apply it.
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    if ((org as any)?.makerChecker && job.requestedBy && actor && job.requestedBy === actor) {
      throw new BadRequestException('Maker-checker is enabled — you planned this, so a different user must review and apply it.');
    }
    const t = this.tpl(job.template);
    const env = await this.credEnv(t, job.connectionId);
    await this.prisma.provisionJob.update({ where: { id }, data: { status: 'applying', approvedBy: actor } });
    const r = await this.runner({ id: job.id, action: 'apply', files: this.files(t, job.inputs as any), env });
    const updated = await this.prisma.provisionJob.update({ where: { id }, data: { applyLog: clip(r.log), outputs: (r.outputs ?? {}) as any, status: r.ok ? 'applied' : 'apply_failed' } });
    // Inventory linkage: on a successful cloud apply, refresh that connection's discovery so the new
    // resource shows up in Cloud Inventory (fire-and-forget — never block/​fail the apply on it).
    if (r.ok && job.connectionId && t.cloud !== 'demo') this.connections.sync(job.connectionId).catch(() => undefined);
    return updated;
  }

  async destroy(id: string, actor: string) {
    const job = await this.prisma.provisionJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('job not found');
    const t = this.tpl(job.template);
    const env = await this.credEnv(t, job.connectionId);
    const r = await this.runner({ id: job.id, action: 'destroy', files: this.files(t, job.inputs as any), env });
    return this.prisma.provisionJob.update({ where: { id }, data: { applyLog: clip(r.log), status: r.ok ? 'destroyed' : job.status, approvedBy: actor } });
  }
}
