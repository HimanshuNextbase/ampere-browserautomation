import { FastifyInstance } from 'fastify';
import { getErrorStatus } from '../../errors.js';
import * as instances from '../../instances.js';
import { toErrorMessage } from '@ampere/shared/errors';
import { createLogger } from '@ampere/shared/logger';


const log = createLogger('features');
export default async function featuresRoutes(fastify: FastifyInstance) {
  // ─── ClawhHub Marketplace ──────────

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/instances/:id/clawhub/explore',
    async (req, reply) => {
      try {
        const limit = parseInt(req.query.limit || '30');
        const output = await instances.execInInstance(req.params.id, `clawhub explore --limit ${limit} 2>&1`);
        const skills = output
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('-'))
          .map((line) => {
            const match = line.match(/^(\S+)\s+(v[\d.]+)\s+(.+?)\s{2,}(.*)$/);
            if (match)
              return { slug: match[1], version: match[2], updated: match[3].trim(), description: match[4].trim() };
            const simple = line.match(/^(\S+)\s+(v[\d.]+)\s+(.+)$/);
            if (simple) return { slug: simple[1], version: simple[2], updated: simple[3].trim(), description: '' };
            return null;
          })
          .filter(Boolean);
        return { skills };
      } catch (err: unknown) {
        log.debug('features.features_routes_error_handled', { error: toErrorMessage(err) });
        reply.code(500);
        return { error: toErrorMessage(err) };
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { slug: string } }>(
    '/instances/:id/clawhub/install',
    async (req, reply) => {
      try {
        const { slug } = req.body;
        if (!slug || typeof slug !== 'string') {
          reply.code(400);
          return { error: 'slug required' };
        }
        const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '');
        const output = await instances.execInInstance(
          req.params.id,
          `clawhub install ${safeSlug} --no-input --force --dir /root/.openclaw/skills 2>&1`,
        );
        return { ok: true, output };
      } catch (err: unknown) {
        log.debug('features.install_skill_failed', { error: toErrorMessage(err) });
        reply.code(500);
        return { error: toErrorMessage(err) };
      }
    },
  );

  // ─── On-Demand Feature Installation ──────────────────────

  fastify.post<{ Params: { id: string; feature: string } }>('/instances/:id/features/:feature', async (req, reply) => {
    try {
      const force = (req.query as any)?.force === 'true';
      const credentialRef = (req.body as any)?.credentialRef;
      const result = await instances.installFeature(req.params.id, req.params.feature, { force, credentialRef });
      reply.code(202);
      return result;
    } catch (err: unknown) {
      log.debug('features.credential_ref_error_handled', { error: toErrorMessage(err) });
      const code = getErrorStatus(err as Error);
      reply.code(code);
      return { error: toErrorMessage(err) };
    }
  });

  fastify.delete<{ Params: { id: string; feature: string } }>(
    '/instances/:id/features/:feature',
    async (req, reply) => {
      try {
        const result = await instances.removeFeature(req.params.id, req.params.feature);
        return result;
      } catch (err: unknown) {
        log.debug('features.remove_feature_failed', { error: toErrorMessage(err) });
        const code = getErrorStatus(err as Error);
        reply.code(code);
        return { error: toErrorMessage(err) };
      }
    },
  );

  fastify.get<{ Params: { id: string } }>('/instances/:id/features', async (req, reply) => {
    try {
      return instances.getFeatureStatus(req.params.id);
    } catch (err: unknown) {
      log.debug('features.get_feature_status_failed', { error: toErrorMessage(err) });
      reply.code(404);
      return { error: toErrorMessage(err) };
    }
  });
}
