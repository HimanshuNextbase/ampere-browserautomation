import { FastifyInstance } from 'fastify';
import { verifyFirebaseToken } from '../auth.js';
import { getAgent } from './agent-store.js';
import { toErrorMessage } from '@ampere/shared/errors';
import { createLogger } from '@ampere/shared/logger';


const log = createLogger('http_routes');
/**
 * Register HTTP endpoints for proxy status checking.
 */
export function registerProxyHttpRoutes(app: FastifyInstance): void {
  app.get('/api/my/proxy-status', async (req: any, reply: any) => {
    const authHeader = req.headers.authorization as string | undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    let decoded: any;
    try {
      decoded = await verifyFirebaseToken(token);
      if (!decoded?.uid) throw new Error('no uid');
    } catch (err: unknown) {
      log.debug('http_routes.slice_error_handled', { error: toErrorMessage(err) });
      reply.status(401);
      return { error: 'Unauthorized' };
    }

    const agent = getAgent(decoded.uid);

    return {
      hasAgent: !!agent,
      agentId: agent?.agentId ?? null,
      proxyPort: agent?.proxyPort ?? null,
      connectedAt: agent?.connectedAt ?? null,
    };
  });
}
