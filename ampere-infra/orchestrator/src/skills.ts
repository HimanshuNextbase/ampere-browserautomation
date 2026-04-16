import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as incus from './incus.js';
import { createLogger } from '@ampere/shared/logger';
import { isCustomSkill, getCustomSkillContent } from './custom-skill-content.js';
import { toErrorMessage } from '@ampere/shared/errors';
const log = createLogger('orchestrator');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function pushSearxngSkill(container: string, serverIp?: string): Promise<void> {
  const slog = log.child({ containerName: container, serverIp, step: 'push_searxng_skill' });
  const skillName = 'searxng';
  const skillSource = path.join(__dirname, 'skills', skillName);
  const destDir = '/root/.openclaw/skills/searxng';

  slog.info('skills.push.start', { skillSource, destDir });

  if (!fs.existsSync(skillSource)) {
    slog.error('skills.push.source_missing', { skillSource });
    throw new Error(`Skill source directory not found: ${skillSource}`);
  }

  const filesToPush: Array<{ destPath: string; content: string }> = [];

  function gatherFiles(dir: string, baseDir: string) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        gatherFiles(fullPath, baseDir);
      } else {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const content = fs.readFileSync(fullPath, 'utf-8');
        filesToPush.push({ destPath: `${destDir}/${relativePath}`, content });
      }
    }
  }

  gatherFiles(skillSource, skillSource);
  slog.info('skills.push.files_gathered', { fileCount: filesToPush.length, files: filesToPush.map((f) => f.destPath) });

  await incus.pushFilesBatch(container, filesToPush, serverIp);
  slog.info('skills.push.done', { fileCount: filesToPush.length });
}

export async function pushStealthProxySkill(container: string, serverIp?: string): Promise<void> {
  const slog = log.child({ containerName: container, serverIp, step: 'push_stealth_proxy_skill' });
  const skillName = 'camoufox-browser';
  const skillSource = path.join(__dirname, 'skills', skillName);
  const destDir = '/root/.openclaw/skills/camoufox-browser';

  slog.info('skills.push.start', { skillSource, destDir });

  if (!fs.existsSync(skillSource)) {
    slog.error('skills.push.source_missing', { skillSource });
    throw new Error(`Skill source directory not found: ${skillSource}`);
  }

  const filesToPush: Array<{ destPath: string; content: string }> = [];

  function gatherFiles(dir: string, baseDir: string) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        gatherFiles(fullPath, baseDir);
      } else {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const content = fs.readFileSync(fullPath, 'utf-8');
        filesToPush.push({ destPath: `${destDir}/${relativePath}`, content });
      }
    }
  }

  gatherFiles(skillSource, skillSource);
  slog.info('skills.push.files_gathered', { fileCount: filesToPush.length, files: filesToPush.map((f) => f.destPath) });

  await incus.pushFilesBatch(container, filesToPush, serverIp);
  slog.info('skills.push.done', { fileCount: filesToPush.length });
}

// ─── Single skill installation ───────────────────────────────

/**
 * Install a single skill into a container by skill ID.
 * Used by skill-routes.ts when user clicks "Install" on a specific skill.
 */
export async function pushSingleSkill(container: string, skillId: string, serverIp?: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(skillId)) {
    throw new Error(`Invalid skillId: ${skillId}`);
  }
  const slog = log.child({ containerName: container, serverIp, skillId, step: 'push_single_skill' });
  const workspaceDir = '/root/.openclaw/workspace';

  if (skillId === 'claude-seo') {
    const { getCustomSkillContent: getContent } = await import('./custom-skill-content.js');
    const wrapperContent = getContent('claude-seo');
    if (wrapperContent) {
      await incus.pushFilesBatch(
        container,
        [{ destPath: `${workspaceDir}/skills/claude-seo/SKILL.md`, content: wrapperContent }],
        serverIp,
      );
    }
    await incus.execCommand(
      container,
      [
        'bash',
        '-c',
        'curl -fsSL https://raw.githubusercontent.com/AgriciDaniel/claude-seo/main/install.sh | bash 2>&1 | tail -5',
      ],
      serverIp,
      180_000,
    );
    slog.info('single_skill.installed', { method: 'claude-seo-special' });
  } else if (isCustomSkill(skillId)) {
    const content = getCustomSkillContent(skillId)!;
    await incus.pushFilesBatch(
      container,
      [{ destPath: `${workspaceDir}/skills/${skillId}/SKILL.md`, content }],
      serverIp,
    );
    slog.info('single_skill.installed', { method: 'custom' });
  } else {
    await incus.execCommand(
      container,
      ['bash', '-c', `clawhub install ${skillId} --yes 2>&1 | tail -3`],
      serverIp,
      90_000,
    );
    slog.info('single_skill.installed', { method: 'clawhub' });
  }
}

// ─── Persona-based skill installation ────────────────────────

/**
 * Install persona-specific skills into a container via clawhub.
 * Best-effort: logs failures but never blocks provisioning.
 */
export async function pushPersonaSkills(container: string, persona: string, serverIp?: string): Promise<void> {
  const { getPersonaDefaults } = await import('./persona/index.js');
  const slog = log.child({ containerName: container, serverIp, persona, step: 'push_persona_skills' });

  const defaults = getPersonaDefaults(persona as any);
  const skills = defaults.skills;

  if (!skills || skills.length === 0) {
    slog.info('persona_skills.skip', { reason: 'no_skills_for_persona' });
    return;
  }

  slog.info('persona_skills.start', { count: skills.length, skills });

  let installed = 0;
  let failed = 0;

  const workspaceDir = '/root/.openclaw/workspace';

  for (const skill of skills) {
    try {
      if (skill === 'claude-seo') {
        // Special install: run claude-seo install.sh in container + push OpenClaw wrapper SKILL.md
        const { getCustomSkillContent: getContent } = await import('./custom-skill-content.js');
        const wrapperContent = getContent('claude-seo');
        if (wrapperContent) {
          await incus.pushFilesBatch(
            container,
            [{ destPath: `${workspaceDir}/skills/claude-seo/SKILL.md`, content: wrapperContent }],
            serverIp,
          );
        }
        // Run install.sh to set up full claude-seo suite (Python deps, sub-skills, agents) in ~/.claude/
        await incus.execCommand(
          container,
          [
            'bash',
            '-c',
            'curl -fsSL https://raw.githubusercontent.com/AgriciDaniel/claude-seo/main/install.sh | bash 2>&1 | tail -5',
          ],
          serverIp,
          180_000, // 3 min — clones repo + installs Python deps
        );
        installed++;
        slog.info('persona_skills.claude_seo_installed', { skill, progress: `${installed}/${skills.length}` });
      } else if (isCustomSkill(skill)) {
        // Ampere-hosted custom skill — push SKILL.md directly
        const content = getCustomSkillContent(skill)!;
        await incus.pushFilesBatch(
          container,
          [{ destPath: `${workspaceDir}/skills/${skill}/SKILL.md`, content }],
          serverIp,
        );
        installed++;
        slog.info('persona_skills.custom_pushed', { skill, progress: `${installed}/${skills.length}` });
      } else {
        // Clawhub skill — install via CLI
        await incus.execCommand(
          container,
          ['bash', '-c', `clawhub install ${skill} --yes 2>&1 | tail -3`],
          serverIp,
          90_000, // 90s per skill
        );
        installed++;
        slog.info('persona_skills.installed', { skill, progress: `${installed}/${skills.length}` });
      }
    } catch (err: unknown) {
      failed++;
      slog.warn('persona_skills.install_failed', { skill, error: toErrorMessage(err) });
      // Non-fatal — continue with remaining skills
    }
  }

  slog.info('persona_skills.done', { installed, failed, total: skills.length });
}
