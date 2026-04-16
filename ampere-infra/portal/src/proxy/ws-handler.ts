import WebSocket from 'ws';
import { FastifyInstance } from 'fastify';
import { verifyFirebaseToken } from '../auth.js';
import { createLogger } from '@ampere/shared/logger';
import { setAgent, removeAgent } from './agent-store.js';
import { toErrorMessage } from '@ampere/shared/errors';

const log = createLogger('proxy-agent:ws');

/**
 * Register the WebSocket relay endpoint for desktop proxy agents.
 *
 * Flow: Desktop App ←→ Portal (this relay) ←→ Container browser-server (port 9222)
 *
 * The portal authenticates the desktop, resolves the user's container,
 * then pipes all WS messages bidirectionally (hello, connect-request,
 * tunnel-data, etc.) without interpreting them.
 */
export function registerProxyWebSocket(
  app: FastifyInstance,
  resolveInstanceId: (userId: string) => Promise<string>,
  orchestratorFetch: (path: string, opts?: any, userId?: string) => Promise<any>,
): void {
  app.get('/api/my/proxy-agent', { websocket: true }, async (socket, req) => {
    // --- Auth ---
    const url = new URL(req.url, 'http://localhost');
    const token =
      url.searchParams.get('token') ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    if (!token) {
      socket.close(4001, 'Authentication required');
      return;
    }

    let firebaseUser: any;
    try {
      firebaseUser = await verifyFirebaseToken(token);
      if (!firebaseUser?.uid) throw new Error('no uid');
    } catch (err: unknown) {
      log.debug('ws_handler.slice_failed', { error: toErrorMessage(err) });
      socket.close(4001, 'Invalid token');
      return;
    }

    const userId = firebaseUser.uid;
    log.info('proxy_relay.auth_ok', { userId, email: firebaseUser.email });

    // --- Resolve container ---
    let instanceId: string;
    let browserInfo: any;
    try {
      instanceId = await resolveInstanceId(userId);
      // Use dedicated browser-info endpoint (not gateway-info — token must not be client-facing)
      browserInfo = await orchestratorFetch(`/instances/${encodeURIComponent(instanceId)}/browser-info`, {}, userId);
    } catch (err: unknown) {
      log.error('proxy_relay.instance_lookup_failed', { userId, error: toErrorMessage(err) });
      socket.close(4002, 'Instance lookup failed');
      return;
    }

    if (!browserInfo || browserInfo.error || !browserInfo.server_ip) {
      socket.send(JSON.stringify({ type: 'error', message: 'Instance not available' }));
      socket.close(4003, 'Instance not available');
      return;
    }

    // Connect to the browser-server WS via Caddy reverse proxy (unix socket)
    // Route key uses instance_id (matching Caddy route /browser/<instance_id>/*)
    const caddyPort = 8443;
    const browserToken = browserInfo.browser_server_token || '';
    const tokenParam = browserToken ? `?token=${encodeURIComponent(browserToken)}` : '';
    const containerWsUrl = `ws://${browserInfo.server_ip}:${caddyPort}/browser/${browserInfo.instance_id}/ws${tokenParam}`;
    log.info('proxy_relay.connecting_upstream', {
      userId,
      containerWsUrl: containerWsUrl.replace(/token=[^&]+/, 'token=***'),
      instanceId: browserInfo.instance_id,
    });

    const upstream = new WebSocket(containerWsUrl);
    let closed = false;

    const cleanup = (code?: number, reason?: string) => {
      if (closed) return;
      closed = true;
      removeAgent(userId);
      try {
        upstream.close();
      } catch (err: unknown) {
        /* best-effort */
      }
      try {
        socket.close(code || 1001, reason || 'Proxy relay closed');
      } catch (err: unknown) {
        /* best-effort */
      }
    };

    // Upstream connect timeout
    const connectTimeout = setTimeout(() => {
      if (upstream.readyState !== WebSocket.OPEN) {
        log.error('proxy_relay.connect_timeout', { userId, containerWsUrl });
        socket.send(JSON.stringify({ type: 'error', message: 'Browser server connection timed out' }));
        cleanup(4012, 'Upstream connect timeout');
      }
    }, 10000);

    const pendingToUpstream: (string | Buffer)[] = [];

    // --- Desktop → Container ---
    socket.on('message', (data: any) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        // Buffer messages until upstream is open
        pendingToUpstream.push(data);
      }
    });

    socket.on('close', (code: number, reason: any) => {
      log.info('proxy_relay.desktop_closed', { userId, code, reason: reason?.toString() });
      cleanup();
    });

    socket.on('error', (err: Error) => {
      log.error('proxy_relay.desktop_error', { userId, error: toErrorMessage(err) });
      cleanup();
    });

    // --- Container → Desktop ---
    upstream.on('open', () => {
      clearTimeout(connectTimeout);
      log.info('proxy_relay.upstream_open', { userId, buffered: pendingToUpstream.length });

      // Track agent as connected
      setAgent(userId, {
        ws: socket as any,
        agentId: `relay-${Date.now()}`,
        userId,
        proxyPort: 9222,
        connectedAt: new Date(),
        lastPing: new Date(),
      });

      // Flush buffered messages
      for (const msg of pendingToUpstream) {
        upstream.send(msg);
      }
      pendingToUpstream.length = 0;
    });

    upstream.on('message', (data: any) => {
      if (!closed && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    });

    upstream.on('close', (code: number, reason: any) => {
      log.info('proxy_relay.upstream_closed', { userId, code, reason: reason?.toString() });
      cleanup();
    });

    upstream.on('error', (err: Error) => {
      log.error('proxy_relay.upstream_error', { userId, error: toErrorMessage(err) });
      cleanup();
    });
  });
}
