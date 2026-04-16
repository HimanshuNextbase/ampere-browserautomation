import { FastifyInstance } from 'fastify';
import { createLogger } from '@ampere/shared/logger';
import { registerProxyWebSocket } from './ws-handler.js';
import { registerProxyHttpRoutes } from './http-routes.js';

const log = createLogger('proxy');

/**
 * Fastify plugin for the stealth proxy feature.
 *
 * Enable with ENABLE_STEALTH_PROXY=true (or =1).
 * When disabled, no routes are registered and no resources are consumed.
 */
export async function registerProxyPlugin(
  app: FastifyInstance,
  resolveInstanceId: (userId: string) => Promise<string>,
  orchestratorFetch: (path: string, opts?: any, userId?: string) => Promise<any>,
): Promise<void> {
  log.info('Stealth proxy — registering routes');
  registerProxyWebSocket(app, resolveInstanceId, orchestratorFetch);
  registerProxyHttpRoutes(app);
}

// Re-export public API for other modules
export { hasActiveAgent, getAgentStatus } from './agent-store.js';
