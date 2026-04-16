import { getDb, type InstanceRow } from './db.js';
import { selectInstanceById, updateInstanceFeaturesById } from './db-statements.js';
import { INSTANCE_STATUS as S, isStatus, ACTIVE_STATUSES } from '@ampere/shared/instance-status';
import * as incus from './incus.js';
import {
  installSearxngNative,
  planHasSearxng,
  installQmd,
  planHasQmd,
  qmdConfigForPlan,
  FEATURE_STALE_TIMEOUTS_MS,
} from './setup/index.js';
import { generateConfig } from './config-gen.js';
import { PLANS } from './servers.js';
import * as firestore from './firestore.js';
import { pushSearxngSkill, pushStealthProxySkill } from './skills.js';
import { getConnectionById, isConnectionFeature } from './connections.js';
import { installConnection, removeConnection } from './connection-installer.js';
import * as caddy from './caddy.js';
import {
  log,
  GATEWAY_PORT,
  CONTAINER_PROXY_URL,
  PROXY_HOST_URL,
  resolveInstance,
  getServerIpForInstance,
  parseFeatures,
  getUserSelectedModel,
  getActiveInstancesOnServer,
} from './instance-helpers.js';
import { smartGatewayRestart } from './instance-health.js';
import { toErrorMessage } from '@ampere/shared/errors';

// ─── On-Demand Feature Installation ─────────────────────────

export async function installFeature(
  instanceId: string,
  feature: string,
  options?: { force?: boolean; credentialRef?: string },
): Promise<{ status: string }> {
  const db = getDb();
  const row = resolveInstance(instanceId);
  if (!row) throw new Error('Instance not found');
  if (!isStatus(row.status, ...ACTIVE_STATUSES)) throw new Error('Instance must be running to install features');

  if (feature !== 'searxng' && feature !== 'qmd' && feature !== 'stealth-proxy' && !isConnectionFeature(feature))
    throw new Error(`Unknown feature: ${feature}`);

  const containerName = row.container_name;
  const serverIp = getServerIpForInstance(row);
  const userId = row.user_id;

  // Create a child logger with instance context baked in for all subsequent logs
  const flog = log.child({ containerName, instanceId: row.id, userId, serverIp, feature });

  // Plan gate: read current plan from Firestore (source of truth for subscriptions),
  // fall back to SQLite row.plan if Firestore is unavailable or user_id is missing.
  let currentPlan = row.plan || 'free';
  let planSource = 'sqlite';
  if (userId) {
    try {
      const fs = firestore.getFs();
      if (fs) {
        const secureDoc = await fs.collection('secureUsers').doc(userId).get();
        if (secureDoc.exists && secureDoc.data()?.plan) {
          currentPlan = secureDoc.data()!.plan as string;
          planSource = 'firestore:secureUsers';
        }
      } else {
        flog.warn('feature.plan_check.firestore_unavailable', { sqlitePlan: currentPlan });
      }
    } catch (fsErr: unknown) {
      flog.warn('feature.plan_check.firestore_error', { error: toErrorMessage(fsErr), sqlitePlan: currentPlan });
    }
  } else {
    flog.warn('feature.plan_check.no_user_id', { sqlitePlan: currentPlan });
  }

  flog.info('feature.plan_check', { currentPlan, planSource, sqlitePlan: row.plan || 'free' });

  // Per-feature plan gates
  if (feature === 'searxng' && !planHasSearxng(currentPlan)) {
    flog.warn('feature.plan_rejected', { currentPlan, planSource });
    throw new Error(`SearXNG requires a Starter plan or above (current: ${currentPlan})`);
  }
  if (feature === 'qmd' && !planHasQmd(currentPlan)) {
    flog.warn('feature.plan_rejected', { currentPlan, planSource });
    throw new Error(`QMD memory backend requires a Pro plan or above (8 GB+ RAM). Current: ${currentPlan}`);
  }

  if (feature === 'stealth-proxy') {
    if (currentPlan === 'free') {
      flog.warn('feature.plan_rejected', { currentPlan, planSource });
      throw new Error(`Stealth Proxy requires a paid plan (current: ${currentPlan})`);
    }
  }

  // Per-feature stale timeout — see FEATURE_STALE_TIMEOUTS_MS in plan-config.ts.
  // SearXNG: 10 min (installs in ~3 min). QMD: 1 hr (1.6 GB model download). Others: 10 min default.
  const STALE_INSTALL_TIMEOUT_MS = FEATURE_STALE_TIMEOUTS_MS[feature] ?? 10 * 60 * 1000;

  // Feature key mapping for DB storage (stealth-proxy → stealthProxy for backward compat)
  const featureKey = feature === 'stealth-proxy' ? 'stealthProxy' : feature;

  // ── Shared helper: atomically mark a feature as 'installing' ──
  const markFeatureInstalling = db.transaction((instanceIdForTx: string, forceInstall: boolean) => {
    const freshRowForTx = selectInstanceById.stmt.get(instanceIdForTx) as
      | InstanceRow
      | undefined;
    if (!freshRowForTx) throw new Error('Instance not found');

    const txFeatures = parseFeatures(freshRowForTx);

    if ((txFeatures as any)[featureKey] === 'installed' && !forceInstall) {
      throw new Error(`${feature} is already installed`);
    }

    if ((txFeatures as any)[featureKey] === 'installing' && !forceInstall) {
      // Check if the install is stale (e.g. server restarted mid-install)
      const updatedAt = freshRowForTx.updated_at ? new Date(freshRowForTx.updated_at + 'Z').getTime() : 0;
      const elapsed = Date.now() - updatedAt;
      if (elapsed < STALE_INSTALL_TIMEOUT_MS) {
        throw new Error(`${feature} installation is already in progress`);
      }
      flog.warn('feature.stale_install_detected', { elapsed_ms: elapsed, updatedAt: freshRowForTx.updated_at });
    }

    if (forceInstall && (txFeatures as any)[featureKey]) {
      flog.info('feature.force_reinstall', { previousState: (txFeatures as any)[featureKey] });
    }

    (txFeatures as any)[featureKey] = 'installing';
    updateInstanceFeaturesById.stmt.run(
      JSON.stringify(txFeatures),
      instanceIdForTx,
    );

    return freshRowForTx;
  });

  markFeatureInstalling(row.id, options?.force ?? false);
  flog.info('feature.install_started', { plan: currentPlan, planSource, force: options?.force ?? false });

  // ── Async install dispatch ──────────────────────────────────
  (async () => {
    const installStart = Date.now();
    try {
      if (feature === 'searxng') {
        // ── SearXNG Install ──
        flog.info('feature.step.searxng_native.start');
        const stepNativeStart = Date.now();
        await installSearxngNative(containerName, serverIp);
        flog.info('feature.step.searxng_native.done', { duration_ms: Date.now() - stepNativeStart });

        flog.info('feature.step.push_skill.start');
        const stepSkillStart = Date.now();
        await pushSearxngSkill(containerName, serverIp);
        flog.info('feature.step.push_skill.done', { duration_ms: Date.now() - stepSkillStart });
      } else if (feature === 'stealth-proxy') {
        // ── Stealth Proxy Install (Camoufox-based) ──
        const { execCommand } = await import('./incus.js');

        // Step 1: Install pip3 + Camoufox + dependencies + Xvfb (headed mode needs virtual display)
        // Note: libgtk-3-0, libdbus-glib-1-2, libasound2t64 are required for Camoufox/Firefox to launch
        flog.info('feature.step.install_camoufox.start');
        await execCommand(
          containerName,
          [
            'bash',
            '-c',
            'apt-get update -qq && apt-get install -y -qq python3-pip xvfb libgtk-3-0 libdbus-glib-1-2 libasound2t64 2>&1 | tail -3',
          ],
          serverIp,
          180_000,
        );
        await execCommand(
          containerName,
          ['bash', '-c', 'pip3 install --break-system-packages -q camoufox playwright 2>&1 | tail -5'],
          serverIp,
          300_000,
        );
        // Ensure Firefox binary exists — always run fetch (idempotent, skips if already present)
        await execCommand(containerName, ['bash', '-c', 'camoufox fetch 2>&1 | tail -5'], serverIp, 300_000);
        // Validate binary actually exists on disk (import alone doesn't guarantee binary)
        await execCommand(
          containerName,
          [
            'bash',
            '-c',
            'test -f /root/.cache/camoufox/camoufox-bin && echo "[OK] camoufox binary ready" || (echo "[FAIL] binary missing" && exit 1)',
          ],
          serverIp,
          30_000,
        );
        flog.info('feature.step.install_camoufox.done');

        // Step 2: Push camoufox-browser skill files (SKILL.md, EXAMPLES.md, browser-server.js, enhanced-camoufox.py, smart-login-v2.py)
        flog.info('feature.step.push_skill.start');
        await pushStealthProxySkill(containerName, serverIp);
        flog.info('feature.step.push_skill.done');

        // Step 3: Install npm deps for browser-server (desktop proxy relay)
        flog.info('feature.step.npm_install.start');
        await execCommand(
          containerName,
          [
            'bash',
            '-c',
            'cd /root/.openclaw/skills/camoufox-browser && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --production ws playwright-core 2>&1 | tail -5',
          ],
          serverIp,
          120_000,
        );
        flog.info('feature.step.npm_install.done');

        // Step 4: Generate auth token
        flog.info('feature.step.generate_token.start');
        const tokenOutput = await execCommand(
          containerName,
          ['bash', '-c', 'mkdir -p /data && openssl rand -hex 32 | tee /data/browser-server-token'],
          serverIp,
        );
        const browserToken = tokenOutput.trim();
        flog.info('feature.step.generate_token.done');

        // Step 5: Create Xvfb + browser-server systemd services (headed mode needs virtual display)
        const xvfbUnit = `[Unit]
Description=Xvfb Virtual Display
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
        await incus.pushFile(containerName, '/etc/systemd/system/xvfb.service', xvfbUnit, serverIp);

        const serviceUnit = `[Unit]
Description=Ampere Browser Server
After=network.target xvfb.service
Requires=xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/node /root/.openclaw/skills/camoufox-browser/browser-server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
`;
        await incus.pushFile(containerName, '/etc/systemd/system/browser-server.service', serviceUnit, serverIp);
        await execCommand(
          containerName,
          [
            'bash',
            '-c',
            'systemctl daemon-reload && systemctl enable xvfb browser-server && systemctl start xvfb browser-server',
          ],
          serverIp,
        );
        flog.info('feature.step.systemd_service.done');

        // Step 6: Add incus proxy device (unix socket → container port 9222)
        if (!serverIp) throw new Error('Server IP required for stealth-proxy install');
        const { sshExec: sshExecImport } = await import('./incus.js');
        const sockPath = `/run/ampere/${containerName}-browser.sock`;
        await sshExecImport(
          serverIp,
          `mkdir -p /run/ampere && incus config device add ${containerName} browser-proxy proxy listen=unix:${sockPath} connect=tcp:127.0.0.1:9222 mode=0666 2>/dev/null || true`,
        );
        flog.info('feature.step.incus_proxy.done', { sockPath });

        // Step 7: Add Caddy route for browser
        if (row.server_id) {
          const activeInstances = getActiveInstancesOnServer(row.server_id);
          const containerIp = row.container_ip || (await incus.getContainerIp(containerName, serverIp));
          await caddy.addRoute(serverIp, row.id, containerIp, activeInstances, {
            hasBrowser: true,
            refreshFn: () => getActiveInstancesOnServer(row.server_id!),
          });
        }
        flog.info('feature.step.caddy_route.done');

        // Step 8: Push browser automation docs + add reference in AGENTS.md
        flog.info('feature.step.push_browser_docs.start');
        const browserDocsMd = `# 🦊 Browser Automation — Camoufox

Camoufox is a stealth Firefox browser running as a **persistent API server** on port 9222.
Sessions persist across calls — sign in once, stay signed in forever.

## ⚡ Best Practice: Text First, Screenshot Second

Always get text/HTML content first — it's faster and cheaper.
Only screenshot when you need to see visual layout.

## How to Use

The browser runs as an HTTP API. All requests need the auth token:

\`\`\`bash
TOKEN=$(cat /data/browser-server-token)

# Browse a page and get screenshot
curl -X POST "http://localhost:9222/?token=$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com","sessionId":"default"}'

# Extract text content
curl -X POST "http://localhost:9222/?token=$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com","actions":[{"type":"getText","selector":"body"}],"screenshot":false}'

# Login (session persists for next calls)
curl -X POST "http://localhost:9222/?token=$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://site.com/login","sessionId":"mysite","actions":[{"type":"type","selector":"input[name=email]","text":"user@example.com"},{"type":"type","selector":"input[name=password]","text":"pass"},{"type":"click","selector":"button[type=submit]"},{"type":"waitForNavigation"}]}'

# Check proxy status
curl "http://localhost:9222/?token=$TOKEN"
\`\`\`

## Desktop Proxy (Residential IP)

- **desktopProxy: true** → Traffic routes through user's residential IP
- **desktopProxy: false** → Using server IP

## Full Documentation
- SKILL docs: \`/root/.openclaw/skills/camoufox-browser/SKILL.md\`
- Examples: \`/root/.openclaw/skills/camoufox-browser/EXAMPLES.md\`
`;
        // Write browser docs to separate file (idempotent — always overwrites)
        await incus.pushFile(containerName, '/root/.openclaw/workspace/docs/BROWSER.md', browserDocsMd, serverIp);

        // Add one-line reference in AGENTS.md if not already present
        const agentsRef = `
## 🦊 Browser Automation (Camoufox)

For ANY browser task, use the Camoufox browser API on port 9222.
All requests are POST with JSON body. Sessions persist across calls.
See docs/BROWSER.md for full usage guide and API reference.
`;
        // Write agents ref to temp file then append (avoids shell quoting issues with backticks/special chars)
        await incus.pushFile(containerName, '/tmp/browser-agents-ref.md', agentsRef, serverIp);
        await execCommand(
          containerName,
          [
            'bash',
            '-c',
            'grep -q "docs/BROWSER.md" /root/.openclaw/workspace/AGENTS.md 2>/dev/null || cat /tmp/browser-agents-ref.md >> /root/.openclaw/workspace/AGENTS.md; rm -f /tmp/browser-agents-ref.md',
          ],
          serverIp,
          10_000,
        );
        flog.info('feature.step.push_browser_docs.done');

        // Store browser token in dedicated DB column, mark feature as installed in features JSON
        const freshRowProxy = selectInstanceById.stmt.get(row.id) as InstanceRow;
        const proxyFeatures = parseFeatures(freshRowProxy);
        (proxyFeatures as any).stealthProxy = 'installed';
        delete (proxyFeatures as any).browserServerToken; // remove from features JSON
        db.prepare(
          "UPDATE instances SET features = ?, browser_server_token = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(JSON.stringify(proxyFeatures), browserToken, row.id);
        flog.info('feature.install_complete', { duration_ms: Date.now() - installStart });
        return; // stealth-proxy doesn't need config regen or gateway restart
      } else if (feature === 'qmd') {
        // ── QMD Install ──
        flog.info('feature.step.qmd_install.start');
        const stepQmdStart = Date.now();
        const qmdCfg = qmdConfigForPlan(currentPlan);
        await installQmd(containerName, serverIp, qmdCfg?.searchMode ?? 'query');
        flog.info('feature.step.qmd_install.done', { duration_ms: Date.now() - stepQmdStart });
      } else if (isConnectionFeature(feature)) {
        // ── MCP Connection Install ──
        const connectionDef = getConnectionById(feature);
        if (!connectionDef) throw new Error(`Connection definition not found: ${feature}`);

        // Credential reference: Portal sends credentialRef (connectionId), we fetch from Firestore
        const credentialRef = (options as any)?.credentialRef || feature;
        flog.info('feature.step.connection_install.start', { connectionId: feature, authType: connectionDef.authType });

        await installConnection(containerName, connectionDef, credentialRef, userId || '', serverIp);

        // Mark installed in DB
        const freshRowConn = selectInstanceById.stmt.get(row.id) as InstanceRow;
        const connFeatures = parseFeatures(freshRowConn);
        (connFeatures as any)[featureKey] = 'installed';
        updateInstanceFeaturesById.stmt.run(
          JSON.stringify(connFeatures),
          row.id,
        );

        // Restart gateway so OpenClaw picks up the new env vars + skill
        if (serverIp) {
          const gwOk = await smartGatewayRestart(containerName, serverIp, '[connection]');
          if (!gwOk) flog.warn('feature.step.connection_install.gateway_restart_failed');
        }

        flog.info('feature.install_complete', { duration_ms: Date.now() - installStart, connectionId: feature });
        return;
      }

      // ── Common post-install for searxng/qmd ──
      // Mark installed in DB
      const freshRow = selectInstanceById.stmt.get(row.id) as InstanceRow;
      const freshFeatures = parseFeatures(freshRow);
      (freshFeatures as any)[featureKey] = 'installed';
      updateInstanceFeaturesById.stmt.run(
        JSON.stringify(freshFeatures),
        row.id,
      );
      flog.info('feature.step.db_mark_installed');

      // Regenerate config with SEARXNG_URL
      flog.info('feature.step.config_regen.start');
      type InstanceRowWithUserMeta = InstanceRow & { user_meta?: string | null };

      let onboarding: { botName?: string; botPersonality?: string; botPurpose?: string; persona?: string } = {};
      const rowWithMeta = freshRow as InstanceRowWithUserMeta;
      if (rowWithMeta.user_meta) {
        try {
          onboarding = JSON.parse(rowWithMeta.user_meta);
        } catch (parseErr) {
          flog.warn('feature.step.config_regen.user_meta_parse_error', { error: String(parseErr) });
        }
      }

      const userModel = getUserSelectedModel(freshRow.user_id || freshRow.id);

      const newConfig = generateConfig({
        telegramBotToken: freshRow.telegram_bot_token || '',
        discordBotToken: freshRow.discord_bot_token || '',
        whatsappPhoneNumberId: freshRow.whatsapp_phone_number_id || '',
        whatsappAccessToken: freshRow.whatsapp_access_token || '',
        signalAccount: freshRow.signal_account || '',
        slackBotToken: freshRow.slack_bot_token || '',
        slackAppToken: freshRow.slack_app_token || '',
        internalApiKey: freshRow.internal_api_key,
        gatewayToken: freshRow.gateway_token,
        deviceAuthToken: freshRow.device_auth_token || undefined,
        gatewayPort: GATEWAY_PORT,
        proxyUrl: CONTAINER_PROXY_URL,
        botName: onboarding.botName,
        botPersonality: onboarding.botPersonality,
        botPurpose: onboarding.botPurpose,
        persona: onboarding.persona,
        plan: freshRow.plan,
        features: freshFeatures,
        model: userModel,
      });

      await incus.pushFile(containerName, '/root/.openclaw/openclaw.json', newConfig, serverIp);
      await incus.execCommand(containerName, ['chmod', '600', '/root/.openclaw/openclaw.json'], serverIp);
      flog.info('feature.step.config_regen.done');

      // Restart gateway
      flog.info('feature.step.gateway_restart.start');
      const gatewayOk = serverIp ? await smartGatewayRestart(containerName, serverIp, '[feature]') : false;
      if (!gatewayOk) {
        flog.error('feature.step.gateway_restart.failed');
        const restartRow = selectInstanceById.stmt.get(row.id) as InstanceRow;
        const restartFeatures = parseFeatures(restartRow);
        (restartFeatures as any)[featureKey] = 'error';
        updateInstanceFeaturesById.stmt.run(
          JSON.stringify(restartFeatures),
          row.id,
        );
        flog.error('feature.install_failed', {
          failedAt: 'gateway_restart',
          duration_ms: Date.now() - installStart,
        });
        return;
      }
      flog.info('feature.step.gateway_restart.done');

      flog.info('feature.install_complete', { duration_ms: Date.now() - installStart });
    } catch (err: unknown) {
      flog.error('feature.install_failed', {
        error: toErrorMessage(err),
        stack: (err as Error).stack,
        failedAt: 'async_install',
        duration_ms: Date.now() - installStart,
      });
      try {
        const errRow = selectInstanceById.stmt.get(row.id) as InstanceRow;
        const errFeatures = parseFeatures(errRow);
        (errFeatures as any)[featureKey] = 'error';
        updateInstanceFeaturesById.stmt.run(
          JSON.stringify(errFeatures),
          row.id,
        );
        flog.info('feature.db_marked_error');
      } catch (dbErr: unknown) {
        flog.error('feature.db_mark_error_failed', { error: (dbErr as Error)?.message || String(dbErr) });
      }
    }
  })();

  return { status: 'installing' };
}

/**
 * Recover features stuck in 'installing' state (e.g. server restarted mid-install).
 * Called on boot. Resets stale 'installing' to 'error' so users can retry.
 */
export function recoverStaleFeatureInstalls(): void {
  const db = getDb();
  // Use the shortest feature timeout as the SQL cutoff so we don't miss any.
  // Per-feature timeout filtering happens in the loop below.
  const MIN_STALE_TIMEOUT_MS = Math.min(...Object.values(FEATURE_STALE_TIMEOUTS_MS));
  const cutoff = new Date(Date.now() - MIN_STALE_TIMEOUT_MS).toISOString();

  const rows = db
    .prepare(
      `SELECT id, container_name, features, updated_at FROM instances
     WHERE features LIKE '%"installing"%' AND updated_at < ?`,
    )
    .all(cutoff) as InstanceRow[];

  for (const row of rows) {
    const features = parseFeatures(row);
    const updatedAt = row.updated_at ? new Date(row.updated_at + 'Z').getTime() : 0;
    const elapsed = Date.now() - updatedAt;
    let changed = false;
    for (const feat of Object.keys(FEATURE_STALE_TIMEOUTS_MS)) {
      if (features[feat] === 'installing') {
        const featureTimeout = FEATURE_STALE_TIMEOUTS_MS[feat];
        if (elapsed < featureTimeout) continue; // not yet stale for this feature
        features[feat] = 'error';
        changed = true;
        log.warn('feature.stale_install_recovered', {
          instanceId: row.id,
          containerName: row.container_name,
          feature: feat,
          stuckSince: row.updated_at,
          elapsedMs: elapsed,
          timeoutMs: featureTimeout,
        });
      }
    }
    if (changed) {
      updateInstanceFeaturesById.stmt.run(
        JSON.stringify(features),
        row.id,
      );
    }
  }

  if (rows.length > 0) {
    log.info('feature.stale_recovery_complete', { recoveredCount: rows.length });
  }
}

/** Remove a feature (connection) from an instance */
export async function removeFeature(instanceId: string, feature: string): Promise<{ status: string }> {
  const db = getDb();
  const row = resolveInstance(instanceId);
  if (!row) throw new Error('Instance not found');
  if (!isStatus(row.status, ...ACTIVE_STATUSES)) throw new Error('Instance must be running to remove features');

  if (!isConnectionFeature(feature)) throw new Error(`Cannot remove feature: ${feature}`);

  const containerName = row.container_name;
  const serverIp = getServerIpForInstance(row);
  const connectionDef = getConnectionById(feature);
  if (!connectionDef) throw new Error(`Connection definition not found: ${feature}`);

  // Remove connection from container
  await removeConnection(containerName, connectionDef, serverIp);

  // Update features in DB
  const features = parseFeatures(row);
  delete (features as any)[feature];
  updateInstanceFeaturesById.stmt.run(
    JSON.stringify(features),
    row.id,
  );

  // Restart gateway
  if (serverIp) {
    await smartGatewayRestart(containerName, serverIp, '[remove-feature]');
  }

  return { status: 'removed' };
}

/** Get current feature status for an instance */
export function getFeatureStatus(instanceId: string): Record<string, string> {
  const row = resolveInstance(instanceId);
  if (!row) throw new Error('Instance not found');
  return parseFeatures(row);
}
