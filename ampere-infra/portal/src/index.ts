import { createLogger } from '@ampere/shared/logger';
const log = createLogger('portal');

import cors from '@fastify/cors';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { getFirebaseAdmin } from './auth.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerProxyPlugin } from './proxy/index.js';
import { registerSSEChatRoutes } from './sse-chat.js';
import oauthRoutes from './oauth.js';
import { resolveInstanceId, orchestratorFetch } from './helpers.js';

// Route modules
import publicRoutes from './routes/public.js';
import instanceRoutes from './routes/instance.js';
import billingRoutes from './routes/billing.js';
import chatRoutes from './routes/chat.js';
import settingsRoutes from './routes/settings/index.js';
import adminRoutes from './routes/admin.js';
import attributionRoutes from './routes/attribution.js';
import { integrationRoutes } from './integration/index.js';
import terminalRoutes from './routes/terminal.js'; // Web Terminal — comment out to disable
import secretsRoutes from './routes/secrets.js';
import vaultRoutes from './routes/vault.js';
import teamRoutes from './routes/teams/index.js';
import usersRoutes from './routes/users.js';
import webhookRoutes from './routes/webhook.js';
import skillsRoutes from './routes/skills.js';
import { env } from '@ampere/shared/env';

const PORT = parseInt(process.env.PORTAL_PORT || '3003', 10);

// ─── Main ───────────────────────────────────────────────────

async function main() {
  // Initialize Firebase Admin SDK
  await getFirebaseAdmin();

  const app = Fastify({ logger: true });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } }); // 30MB to allow 25MB imports
  const prodOrigins = [
    'https://api.ampere.sh',
    'https://ampere.infinitycorp.tech',
    'https://www.ampere.sh',
    'https://ampere.sh',
  ];
  const devOrigins =
    env.isProduction
      ? []
      : ['http://localhost:3000', 'http://localhost:3001', 'http://89.167.62.65', 'http://89.167.62.65:3000'];
  await app.register(cors, {
    origin: [...prodOrigins, ...devOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  // ─── WebSocket support (for stealth proxy relay) ──────────
  const websocket = await import('@fastify/websocket');
  await app.register(websocket.default);
  // ─── Workspace (direct filesystem via execInInstance) ─────
  await registerWorkspaceRoutes(app);

  // ─── Stealth Proxy (desktop app network proxy) ─────────────
  await registerProxyPlugin(app, resolveInstanceId, orchestratorFetch);
  // ─── SSE Chat (REST + SSE alternative to WS proxy) ────────
  registerSSEChatRoutes(app);
  app.register(oauthRoutes);
  app.register(integrationRoutes);

  // ─── Health ───────────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', service: 'portal', timestamp: new Date().toISOString() }));

  // ─── Route Modules ────────────────────────────────────────
  app.register(publicRoutes);
  app.register(instanceRoutes);
  app.register(billingRoutes);
  app.register(chatRoutes);
  app.register(settingsRoutes);
  app.register(adminRoutes);
  app.register(attributionRoutes);
  app.register(terminalRoutes); // Web Terminal — comment out to disable
  app.register(secretsRoutes); // Secret sharing (bot → user)
  app.register(vaultRoutes); // Vault (user → bot via /secret command)
  app.register(teamRoutes); // Teams V0
  app.register(usersRoutes); // User profile with team enrichment
  app.register(webhookRoutes); // External webhooks (Anthropic status page)
  app.register(skillsRoutes); // Agentplace skill install/uninstall/list

  // ─── Global Error Handler ──────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    log.error('unhandled_route_error', {
      url: request.url,
      method: request.method,
      error: error.message,
      stack: error.stack,
    });
    reply.status(error.statusCode || 500).send({
      error: 'Internal server error',
      message: !env.isProduction ? error.message : undefined,
    });
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  log.info('boot.listening', { port: PORT });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('unhandled_rejection', { reason: String(reason) });
});
