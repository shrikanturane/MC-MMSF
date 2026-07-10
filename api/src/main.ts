import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

/**
 * Fail CLOSED on placeholder/weak secrets — in EVERY environment, not just production.
 * The credential-sealing + JWT-signing key must never be a value that ships in the repo,
 * otherwise a public build runs on a globally-known key (forged admin tokens, decryptable
 * credentials). No constant fallback exists anywhere; this is the single startup gate.
 */
function checkSecrets() {
  const key = process.env.APP_ENCRYPTION_KEY || '';
  const weakKey = !key || key.includes('change-me') || key.length < 32;
  if (weakKey) {
    throw new Error(
      'APP_ENCRYPTION_KEY is missing or weak. Set a strong, STABLE 32+ char secret before starting — ' +
        'it seals stored cloud credentials and signs auth tokens. Generate one: `openssl rand -hex 32`. See .env.example.',
    );
  }
  if (process.env.NODE_ENV === 'production' && /:(mcmf|postgres|password)@/.test(process.env.DATABASE_URL || '')) {
    throw new Error('Refusing to start in production with a default database password. Set a strong POSTGRES_PASSWORD / DATABASE_URL.');
  }
}

async function bootstrap() {
  checkSecrets();
  // Disable the default body parser so we can raise the limit (logo / background uploads up to ~8 MB).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '12mb' }));
  app.use(urlencoded({ extended: true, limit: '12mb' }));
  // Global input validation — strips unknown props and coerces typed DTO params (no-op for `any` bodies).
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));

  // Behind the nginx TLS proxy → trust X-Forwarded-* so req.ip is the real client.
  try {
    (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);
  } catch {
    /* non-express adapter — ignore */
  }

  // Baseline security headers (dependency-free; HSTS omitted until TLS is terminated).
  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  app.setGlobalPrefix('api');
  // Production: ALLOW_ALL_ORIGINS=1 reflects any request origin so the UI works from any network /
  // host / IP / domain. Otherwise restrict to the configured WEB_ORIGIN allowlist. Agent telemetry
  // (server-to-server with the x-agent-key) is not subject to CORS and is already accepted from any
  // network on this 0.0.0.0 listener.
  const allowAllOrigins = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_ALL_ORIGINS ?? '').toLowerCase());
  // Auth is a Bearer token in localStorage (never an ambient cookie), so credentialed CORS is
  // unnecessary. When reflecting ANY origin (ALLOW_ALL_ORIGINS, used by HA replicas), do NOT set
  // credentials — reflecting arbitrary origins WITH credentials is the footgun; without it there is none.
  app.enableCors({
    origin: allowAllOrigins ? true : (process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3000']),
    credentials: !allowAllOrigins,
  });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');

  // In-browser remote console: bridge browser WebSocket (/guac) ↔ guacd ↔ target VM.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const GuacamoleLite = require('guacamole-lite');
    const key = String(process.env.APP_ENCRYPTION_KEY).slice(0, 32).padEnd(32, '0'); // guaranteed set by checkSecrets()
    const httpServer = app.getHttpServer();
    new GuacamoleLite(
      { server: httpServer, path: '/guac' },
      { host: process.env.GUACD_HOST || 'guacd', port: Number(process.env.GUACD_PORT || 4822) },
      { crypt: { cypher: 'AES-256-CBC', key }, log: { level: 'ERRORS' } },
    );
    // eslint-disable-next-line no-console
    console.log('Guacamole console bridge attached at /guac');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Guacamole bridge not started: ${String((e as Error)?.message ?? e)}`);
  }

  // Outbound-agent console tunnel: the agent dials this WS back per console session; we bridge it to
  // the guacd-facing relay listener (see AgentTunnelHub). Pure outbound — no inbound port on the host.
  // guacamole-lite grabs ALL upgrades on this server, so we take over routing: /api/agent/tunnel →
  // our WS, everything else → guacamole-lite's original upgrade handler(s).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WebSocketServer } = require('ws');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentTunnelHub } = require('./modules/agent/agent-tunnel.hub');
    const hub = app.get(AgentTunnelHub);
    const httpServer = app.getHttpServer();
    const guacUpgrade = httpServer.listeners('upgrade').slice();
    httpServer.removeAllListeners('upgrade');
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (ws: any, req: any) => {
      try {
        const u = new URL(req.url, 'http://x');
        const session = u.searchParams.get('session') || '';
        const k = u.searchParams.get('k') || '';
        if (!hub.authKey(k) || !hub.has(session)) { ws.close(); return; }
        hub.attachAgentWs(session, ws);
      } catch { try { ws.close(); } catch { /* */ } }
    });
    httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const path = String(req.url || '').split('?')[0];
      if (path === '/api/agent/tunnel') {
        wss.handleUpgrade(req, socket, head, (ws: any) => wss.emit('connection', ws, req));
      } else {
        for (const l of guacUpgrade) (l as any).call(httpServer, req, socket, head);
      }
    });
    // eslint-disable-next-line no-console
    console.log('Agent console tunnel attached at /api/agent/tunnel');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Agent tunnel not started: ${String((e as Error)?.message ?? e)}`);
  }

  // eslint-disable-next-line no-console
  console.log(`MCMF API listening on http://0.0.0.0:${port}/api`);
}
bootstrap();
