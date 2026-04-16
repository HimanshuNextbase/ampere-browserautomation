import { FastifyInstance } from 'fastify';
import { getInstanceAndServer } from '../helpers.js';
import * as instances from '../../instances.js';
import { GATEWAY_PORT_NUM } from './helpers.js';
import { toErrorMessage } from '@ampere/shared/errors';
import { createLogger } from '@ampere/shared/logger';


const log = createLogger('logs');
export default async function logsRoutes(fastify: FastifyInstance) {
  // ─── Gateway Info ────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/instances/:id/gateway-info', async (req, reply) => {
    const result = getInstanceAndServer(req.params.id);
    if (!result) {
      reply.code(404);
      return { error: 'Instance not found' };
    }
    const { getProxyUrl, getWsUrl, CADDY_PROXY_PORT } = await import('../../caddy.js');
    const serverIp = result.serverIp;

    return {
      gateway_token: result.instance.gateway_token,
      container_ip: result.instance.container_ip,
      server_ip: serverIp,
      gateway_port: GATEWAY_PORT_NUM,
      caddy_proxy_port: CADDY_PROXY_PORT,
      proxy_url: serverIp ? getProxyUrl(serverIp, result.instance.id) : null,
      ws_url: serverIp ? getWsUrl(serverIp, result.instance.id) : null,
      status: result.instance.status,
      instance_id: result.instance.id,
    };
  });

  // ─── Browser Info (internal, server-side only) ─────────

  fastify.get<{ Params: { id: string } }>('/instances/:id/browser-info', async (req, reply) => {
    const result = getInstanceAndServer(req.params.id);
    if (!result) {
      reply.code(404);
      return { error: 'Instance not found' };
    }
    return {
      server_ip: result.serverIp,
      browser_server_token: result.instance.browser_server_token || null,
      container_name: result.instance.container_name,
      instance_id: result.instance.id,
    };
  });

  // ─── Logs ──────────────────────────────────────────────

  fastify.get<{ Params: { id: string }; Querystring: { tail?: string } }>('/instances/:id/logs', async (req, reply) => {
    try {
      const tail = parseInt(req.query.tail || '100', 10);
      const logs = await instances.getInstanceLogs(req.params.id, tail);
      return { logs };
    } catch (err: unknown) {
      log.debug('logs.get_proxy_url_error_handled', { error: toErrorMessage(err) });
      reply.code(404);
      return { error: toErrorMessage(err) };
    }
  });

  // ─── Cron Jobs ─────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/instances/:id/crons', async (req, reply) => {
    const result = getInstanceAndServer(req.params.id);
    if (!result) {
      reply.code(404);
      return { error: 'Instance not found' };
    }
    try {
      const output = await instances.execInInstance(
        req.params.id,
        `openclaw cron list --json 2>/dev/null || echo "[]"`,
      );
      try {
        return JSON.parse(output);
      } catch (err: unknown) {
        return { jobs: [], raw: output };
      }
    } catch (err: unknown) {
      log.debug('logs.list_cron_jobs_failed', { error: toErrorMessage(err) });
      reply.code(500);
      return { error: toErrorMessage(err) };
    }
  });

  fastify.post<{ Params: { id: string }; Body: { action: string; jobId?: string; enabled?: boolean } }>(
    '/instances/:id/crons/action',
    async (req, reply) => {
      const result = getInstanceAndServer(req.params.id);
      if (!result) {
        reply.code(404);
        return { error: 'Instance not found' };
      }
      const { action, jobId, enabled } = req.body;
      try {
        let cmd = '';
        if (action === 'toggle' && jobId !== undefined) {
          cmd = enabled
            ? `openclaw cron enable ${jobId} 2>&1 && echo '{"ok":true}' || echo '{"error":"enable failed"}'`
            : `openclaw cron disable ${jobId} 2>&1 && echo '{"ok":true}' || echo '{"error":"disable failed"}'`;
        } else if (action === 'run' && jobId !== undefined) {
          cmd = `openclaw cron run ${jobId} 2>&1 && echo '{"ok":true,"ran":true}' || echo '{"error":"run failed"}'`;
        } else {
          reply.code(400);
          return { error: 'Invalid action' };
        }
        const output = await instances.execInInstance(req.params.id, cmd);
        try {
          return JSON.parse(output);
        } catch (err: unknown) {
          return { ok: true, raw: output };
        }
      } catch (err: unknown) {
        log.debug('logs.manage_cron_job_failed', { error: toErrorMessage(err) });
        reply.code(500);
        return { error: toErrorMessage(err) };
      }
    },
  );

  // ─── Commands Discovery ─────────────────────────────────────
  fastify.get('/instances/:id/commands', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { getCommandsWithCache } = await import('../../commands-discovery.js');
      const commands = await getCommandsWithCache(id);
      reply.send({ commands });
    } catch (err: unknown) {
      log.debug('logs.get_proxy_url_request_failed', { error: toErrorMessage(err) });
      reply.code(500).send({ error: toErrorMessage(err) });
    }
  });
}
