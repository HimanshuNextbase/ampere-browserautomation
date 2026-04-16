import { getDb, type InstanceRow } from './db.js';
import { selectInstanceById, selectServerById, updateInstancePlanById } from './db-statements.js';
import { INSTANCE_STATUS as S, TERMINAL_STATUSES, PROVISIONING_STATUSES } from '@ampere/shared/instance-status';
import * as incus from './incus.js';
import { sshExec } from './incus.js';
import * as caddy from './caddy.js';
import { ensureHostOpenClaw, lockOpenClawPackage } from './setup/index.js';
import {
  assignServer,
  PLANS,
  canUpgradeInPlace,
  upgradeUser,
  reconcileServerCounters,
  type UserPlan,
  type ServerRow,
} from './servers.js';
import * as firestore from './firestore.js';
import {
  type InstanceResponse,
  toResponse,
  getServerIpForInstance,
  parseFeatures,
  resolveInstance,
  getActiveInstancesOnServer,
  notifyDiscord,
} from './instance-helpers.js';
import { ensurePortalDeviceInPairedJson } from './instance-provisioning.js';
import type { ContainerResources } from './instance-config.js';
import type { InstanceContainerFeatures, InstanceIdContainerIp } from './types/db-rows.js';
import { createLogger } from '@ampere/shared/logger';
import { env } from '@ampere/shared/env';
import { toErrorMessage } from '@ampere/shared/errors';
const log = createLogger('orchestrator');

export type { ContainerResources } from './instance-config.js';

// ─── Plan Upgrade ───────────────────────────────────────────

export async function upgradeInstance(id: string, newPlanName: string): Promise<InstanceResponse> {
  const db = getDb();
  const row = selectInstanceById.stmt.get(id) as InstanceRow | undefined;
  if (!row) throw new Error('Instance not found');
  if (row.status === S.DELETED) throw new Error('Instance is deleted');

  const currentPlan = PLANS[row.plan || 'free'] || PLANS['free'];
  const newPlan = PLANS[newPlanName];
  if (!newPlan) throw new Error(`Unknown plan: ${newPlanName}`);

  if (!row.server_id) throw new Error('Instance has no server assigned');

  if (!canUpgradeInPlace(row.server_id, currentPlan, newPlan)) {
    throw new Error('Not enough capacity on current server for this upgrade.');
  }

  const serverIp = getServerIpForInstance(row);

  await upgradeUser(row.server_id, currentPlan, newPlan);

  if (row.container_name) {
    await incus.applyPlanLimits(row.container_name, newPlan, serverIp);
    await incus.incusExec(
      ['config', 'device', 'set', row.container_name, 'root', `size=${newPlan.disk_gb}GB`],
      serverIp,
    );

    await incus.restartContainer(row.container_name, serverIp);
    await new Promise((r) => setTimeout(r, 3000));
    await incus.startGateway(row.container_name, serverIp);
    if (serverIp)
      try {
        await incus.ensureProxyDevice(row.container_name, serverIp);
      } catch (err: unknown) {
        log.debug('instance_resize.upgrade_instance_best_effort', { error: toErrorMessage(err) });
        /* best-effort */
      }
  }

  updateInstancePlanById.stmt.run(newPlanName, row.id);
  await firestore.updateUser(row.user_id || id, { plan: newPlanName }).catch(() => {
    /* best-effort: firestore user sync is non-critical */
  });
  await firestore.updateInstanceDoc(row.user_id || id, id, { plan: newPlanName }).catch(() => {
    /* best-effort: firestore instance sync is non-critical */
  });

  return toResponse(selectInstanceById.stmt.get(id) as InstanceRow);
}

// ─── Resize & Migration ─────────────────────────────────────

export async function resizeInstance(id: string): Promise<InstanceResponse> {
  const db = getDb();
  const row = selectInstanceById.stmt.get(id) as InstanceRow | undefined;
  if (!row) throw new Error('Instance not found');
  const RESIZE_BLOCKED_STATUSES = [S.DELETED, S.DELETING, S.MIGRATING, ...PROVISIONING_STATUSES, S.RESTARTING];
  if (RESIZE_BLOCKED_STATUSES.includes(row.status)) throw new Error(`Cannot resize: instance is ${row.status}`);
  if (!row.server_id) throw new Error('Instance has no server assigned');

  // Read plan from Firestore (source of truth)
  let planName = row.plan || 'free';
  if (row.user_id) {
    try {
      const firestorePlan = await firestore.getSecureUserPlan(row.user_id);
      if (firestorePlan) planName = firestorePlan;
    } catch (e) {
      log.warn('resize.could_not', { userId: row.user_id, name: planName });
    }
  }

  const newPlan = PLANS[planName];
  if (!newPlan) throw new Error(`Unknown plan: ${planName}`);

  const currentPlan = PLANS[row.plan || 'free'] || PLANS['free'];

  // If same plan specs, just update DB and return
  if (
    newPlan.ram_mb === currentPlan.ram_mb &&
    newPlan.cpu === currentPlan.cpu &&
    newPlan.disk_gb === currentPlan.disk_gb
  ) {
    if (row.plan !== planName) {
      updateInstancePlanById.stmt.run(planName, id);
    }
    return toResponse(selectInstanceById.stmt.get(id) as InstanceRow);
  }

  // Check if in-place resize is possible
  const isUpgrade = newPlan.ram_mb > currentPlan.ram_mb || newPlan.disk_gb > currentPlan.disk_gb;

  if (!isUpgrade || canUpgradeInPlace(row.server_id, currentPlan, newPlan)) {
    return await resizeInPlace(row, planName, currentPlan, newPlan);
  } else {
    // Migration is long-running (~60-90s). Run in background so the caller (webhook) isn't blocked.
    // Set status to 'migrating' immediately and return — caller can poll instance status.
    db.prepare(`UPDATE instances SET status = '${S.MIGRATING}', updated_at = datetime('now') WHERE id = ?`).run(row.id);
    migrateInstance(row, planName, newPlan).catch((err) => {
      log.error('migrate.background_migration', { instanceId: row.id, error: toErrorMessage(err) });
    });
    return toResponse(selectInstanceById.stmt.get(row.id) as InstanceRow);
  }
}

async function resizeInPlace(
  row: InstanceRow,
  planName: string,
  currentPlan: UserPlan,
  newPlan: UserPlan,
): Promise<InstanceResponse> {
  const db = getDb();
  const serverIp = getServerIpForInstance(row);

  log.info('resize.inplace_on', { instanceId: row.id, plan: row.plan, name: planName, serverIp: serverIp });

  if (row.container_name && serverIp) {
    await incus.applyPlanLimits(row.container_name, newPlan, serverIp);

    // Disk quota only on ZFS/btrfs (not dir pool)
    const server = selectServerById.stmt.get(row.server_id) as ServerRow | undefined;
    if (server?.storage_driver && server.storage_driver !== 'dir') {
      await incus.incusExec(
        ['config', 'device', 'set', row.container_name, 'root', `size=${newPlan.disk_gb}GB`],
        serverIp,
      );
    }
  }

  updateInstancePlanById.stmt.run(planName, row.id);
  reconcileServerCounters(row.server_id!);

  log.info('resize.done', { instanceId: row.id, name: planName });
  return toResponse(selectInstanceById.stmt.get(row.id) as InstanceRow);
}

async function migrateInstance(row: InstanceRow, planName: string, newPlan: UserPlan): Promise<InstanceResponse> {
  const db = getDb();
  const sourceServerIp = getServerIpForInstance(row);
  const excludeServerIds = [row.server_id!];
  const MAX_MIGRATE_ATTEMPTS = 10;

  log.info('migrate.start', { instanceId: row.id, sourceServerIp: sourceServerIp, plan: row.plan, name: planName });

  // Status already set to 'migrating' by caller (resizeInstance)

  // Stop gateway on source (but keep container running — ZFS unmounts rootfs when container stops)
  if (sourceServerIp && row.container_name) {
    try {
      await incus.execCommand(row.container_name, ['bash', '-c', 'openclaw gateway stop || true'], sourceServerIp);
    } catch (err: unknown) {
      log.debug('instance_resize.migrate_instance_gateway_check', { error: toErrorMessage(err) });
      /* gateway might not be running */
    }
  }

  // Determine source storage pool path
  const sourceServer = selectServerById.stmt.get(row.server_id) as ServerRow | undefined;
  const sourcePool = sourceServer?.storage_driver === 'btrfs' ? 'btrfs-pool' : 'default';
  const sourceRootfs = `/var/lib/incus/storage-pools/${sourcePool}/containers/${row.container_name}/`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_MIGRATE_ATTEMPTS; attempt++) {
    let targetServer: any;
    let targetServerIp: string;

    try {
      targetServer = await assignServer(newPlan, 'cx52', excludeServerIds);
      targetServerIp = targetServer.ip;
      log.info('migrate.attempt_target', { attempt: attempt, targetServerIp: targetServerIp, id: targetServer.id });
    } catch (err: unknown) {
      lastError = err as Error;
      log.error('migrate.none', { instanceId: row.id, error: toErrorMessage(err) });
      break;
    }

    try {
      // Create container on target (capacity check runs here — may reject if physically full)
      const targetServerRow = selectServerById.stmt.get(targetServer.id) as
        | ServerRow
        | undefined;
      const targetStorageDriver = targetServerRow?.storage_driver || 'dir';
      await incus.createContainer(
        {
          name: row.container_name,
          cpu: `${newPlan.cpu}`,
          memory: `${newPlan.ram_mb}MB`,
          disk: `${newPlan.disk_gb}GB`,
          cpuAllowance: newPlan.cpu_allowance,
          storageDriver: targetStorageDriver as 'dir' | 'zfs' | 'btrfs',
          useBaseImage: true, // rsync overwrites rootfs — skip slow golden image unpack
        },
        targetServerIp,
      );

      // Keep target container RUNNING during rsync — ZFS unmounts rootfs when stopped.
      // Target is a minimal base image with nothing important running.
      const targetRootfs = `/var/lib/incus/storage-pools/default/containers/${row.container_name}/`;

      // rsync via script file — avoids nested quote hell across multiple shell layers
      // Write a script to the source server, execute with SSH agent forwarding, then cleanup
      const sshKeyPath = env.SSH_KEY_PATH;
      const agentSock = `/tmp/ssh-migrate-${row.id}.sock`;
      const rsyncScriptName = `/tmp/migrate-rsync-${row.id}.sh`;

      const rsyncScript = [
        '#!/bin/bash',
        'set -e',
        `export RSYNC_RSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"`,
        `rsync -azHAX --delete --timeout=600 ${sourceRootfs}rootfs/ root@${targetServerIp}:${targetRootfs}rootfs/`,
      ].join('\n');
      const rsyncB64 = Buffer.from(rsyncScript).toString('base64');

      // Push script to source server
      const pushCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR -i ${sshKeyPath} root@${sourceServerIp} "echo '${rsyncB64}' | base64 -d > ${rsyncScriptName} && chmod +x ${rsyncScriptName}"`;

      // Execute script with SSH agent forwarding (needed for source→target rsync hop)
      // Use sh instead of bash — orchestrator Docker container doesn't have bash
      const execCmd = `SSH_AUTH_SOCK=${agentSock} ssh-agent -a ${agentSock} sh -c 'ssh-add ${sshKeyPath} 2>/dev/null && ssh -A -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 -o LogLevel=ERROR -i ${sshKeyPath} root@${sourceServerIp} bash ${rsyncScriptName}'; RC=$?; rm -f ${agentSock}; exit $RC`;

      // Cleanup script on source server
      const cleanupCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR -i ${sshKeyPath} root@${sourceServerIp} "rm -f ${rsyncScriptName}"`;

      const { exec: execCb } = await import('child_process');

      // Step 1: Push script
      await new Promise<void>((resolve, reject) => {
        execCb(pushCmd, { timeout: 30_000 }, (err: any, _stdout: string, stderr: string) => {
          if (err) {
            log.error('migrate.failed', { stderr: stderr });
            reject(new Error(`Failed to push rsync script: ${toErrorMessage(err)}`));
          } else {
            log.info('migrate.rsync_script', { sourceServerIp: sourceServerIp });
            resolve();
          }
        });
      });

      // Step 2: Execute rsync via agent forwarding
      await new Promise<void>((resolve, reject) => {
        execCb(execCmd, { timeout: 30 * 60 * 1000 }, (err: any, _stdout: string, stderr: string) => {
          if (err) {
            log.error('migrate.rsync_failed', { stderr: stderr });
            reject(new Error(`rsync failed: ${toErrorMessage(err)}`));
          } else {
            log.info('migrate.rsync_complete', { instanceId: row.id });
            resolve();
          }
        });
      });

      // Step 3: Cleanup script (best-effort)
      execCb(cleanupCmd, { timeout: 10_000 }, () => {});

      // Stop source container now that rsync is done (safe — data already copied)
      if (sourceServerIp && row.container_name) {
        try {
          await incus.incusExec(['stop', row.container_name, '--force'], sourceServerIp);
        } catch (e) {
          log.warn('migrate.could_not', { message: toErrorMessage(e) });
        }
      }

      // Restart target container to pick up rsynced files (clean process state)
      await incus.incusExec(['restart', row.container_name, '--force'], targetServerIp);
      await new Promise((r) => setTimeout(r, 5000));

      // Get new container IP (retry a few times — network may take a moment)
      let newIp = '';
      for (let ipRetry = 0; ipRetry < 10; ipRetry++) {
        const containers = await incus.listContainers(targetServerIp);
        const newContainer = containers.find((c: any) => c.name === row.container_name);
        newIp = newContainer?.ipv4 || '';
        if (newIp) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!newIp) {
        throw new Error(`Container ${row.container_name} has no IP after 20s on ${targetServerIp}`);
      }

      // Update Caddy on target server (add route + browser route if stealth-proxy installed)
      const activeOnTarget = db
        .prepare(
          `SELECT id, container_name, container_ip, features FROM instances WHERE server_id = ? AND status NOT IN ('${S.DELETED}', '${S.DELETING}')`,
        )
        .all(targetServer.id) as InstanceContainerFeatures[];
      const targetInstances = activeOnTarget.map((r) => {
        const f = r.features ? JSON.parse(r.features) : {};
        return {
          instanceId: r.id,
          containerIp: r.container_ip || '',
          containerName: r.container_name,
          hasBrowser: f.stealthProxy === 'installed',
        };
      });
      const rowFeatures = parseFeatures(row);
      const hasBrowser = rowFeatures.stealthProxy === 'installed';
      await caddy.addRoute(targetServerIp, row.id, newIp, targetInstances, {
        hasBrowser,
        refreshFn: () => {
          const fresh = db
            .prepare(
              `SELECT id, container_name, container_ip, features FROM instances WHERE server_id = ? AND status NOT IN ('${S.DELETED}', '${S.DELETING}')`,
            )
            .all(targetServer.id) as InstanceContainerFeatures[];
          return fresh.map((r) => {
            const f = r.features ? JSON.parse(r.features) : {};
            return {
              instanceId: r.id,
              containerIp: r.container_ip || '',
              containerName: r.container_name,
              hasBrowser: f.stealthProxy === 'installed',
            };
          });
        },
      });

      // Re-add browser proxy device on target if stealth-proxy is installed
      if (hasBrowser) {
        try {
          const sockPath = `/run/ampere/${row.container_name}-browser.sock`;
          await incus.sshExec(
            targetServerIp,
            `mkdir -p /run/ampere && incus config device add ${row.container_name} browser-proxy proxy listen=unix:${sockPath} connect=tcp:127.0.0.1:9222 mode=0666 2>/dev/null || true`,
          );
          log.info('migrate.browser_proxy', { containerName: row.container_name });
        } catch (e) {
          log.warn('migrate.could_not', { message: toErrorMessage(e) });
        }
      }

      // Lock OpenClaw version via bind mount (prevents AI agents from upgrading)
      try {
        await ensureHostOpenClaw(targetServerIp);
        await lockOpenClawPackage(row.container_name, targetServerIp);
        log.info('migrate.openclaw_version', { containerName: row.container_name });
      } catch (e) {
        log.warn('migrate.could_not', { message: toErrorMessage(e) });
      }

      // Start gateway — don't use startGateway() which has 60s timeout.
      // Migration cold boot can take 2-5 min. Start async and poll longer.
      const gwStartCmd = `#!/bin/bash\nnohup /root/start-openclaw.sh > /dev/null 2>&1 &\necho "Gateway PID: $!"`;
      const gwB64 = Buffer.from(gwStartCmd).toString('base64');
      await incus.sshExec(
        targetServerIp,
        [
          `echo '${gwB64}' | base64 -d > /tmp/start-gw-tmp`,
          `incus file push /tmp/start-gw-tmp ${row.container_name}/tmp/start-gw.sh`,
          `rm -f /tmp/start-gw-tmp`,
          `incus exec ${row.container_name} -- chmod +x /tmp/start-gw.sh`,
          `incus exec ${row.container_name} -- bash /tmp/start-gw.sh`,
        ].join(' && '),
        30_000,
      );

      // Wait up to 5 min for gateway to become healthy
      let gatewayHealthy = false;
      for (let i = 0; i < 300; i++) {
        try {
          if (await incus.isGatewayHealthy(row.container_name, targetServerIp)) {
            gatewayHealthy = true;
            break;
          }
        } catch (err: unknown) {
          log.debug('instance_resize.parse_retry_failed', { error: toErrorMessage(err) });
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!gatewayHealthy) {
        throw new Error(`Gateway failed to start in container ${row.container_name} after 5 min`);
      }

      // Update DB — migration confirmed successful
      db.prepare(
        `
        UPDATE instances SET
          server_id = ?,
          container_ip = ?,
          plan = ?,
          status = '${S.RUNNING}',
          error_message = NULL,
          retry_count = 0,
          updated_at = datetime('now')
        WHERE id = ?
      `,
      ).run(targetServer.id, newIp, planName, row.id);

      // Reconcile counters on both servers
      reconcileServerCounters(row.server_id!);
      reconcileServerCounters(targetServer.id);

      // Clean up source AFTER success confirmed — remove Caddy route + delete container
      if (sourceServerIp) {
        try {
          const activeOnSource = db
            .prepare(
              `SELECT id, container_ip FROM instances WHERE server_id = ? AND id != ? AND status NOT IN ('${S.DELETED}', '${S.DELETING}')`,
            )
            .all(row.server_id, row.id) as InstanceIdContainerIp[];
          const sourceInstances = activeOnSource.map((r) => ({ instanceId: r.id, containerIp: r.container_ip || '' }));
          await caddy.removeRoute(sourceServerIp, row.id, sourceInstances);
        } catch (e) {
          log.warn('migrate.could_not', { message: toErrorMessage(e) });
        }
        try {
          await incus.incusExec(['delete', row.container_name, '--force'], sourceServerIp);
        } catch (e) {
          log.warn('migrate.could_not', { message: toErrorMessage(e) });
        }
      }

      log.info('migrate.complete', { instanceId: row.id, targetServerIp: targetServerIp, name: planName });
      notifyDiscord('✅ Migration Complete', 0x00ff00, [
        { name: 'Instance', value: row.id, inline: true },
        { name: 'Plan', value: `${row.plan} → ${planName}`, inline: true },
        { name: 'Source → Target', value: `${sourceServerIp} → ${targetServerIp}`, inline: true },
      ]);
      return toResponse(selectInstanceById.stmt.get(row.id) as InstanceRow);
    } catch (err: unknown) {
      lastError = err as Error;
      const isCapacityError = toErrorMessage(err).includes('Server at capacity');
      log.warn('migrate.attempt_failed', {
        attempt: attempt,
        targetServerIp: targetServerIp!,
        error: toErrorMessage(err),
        isCapacityErrorwilltrynextserver: isCapacityError ? ' (will try next server)' : '',
      });

      // Clean up failed target container
      try {
        await incus.incusExec(['delete', row.container_name, '--force'], targetServerIp!);
      } catch (err: unknown) {
        log.debug('instance_resize.is_capacity_error_not_found', { error: toErrorMessage(err) });
        /* might not exist */
      }
      reconcileServerCounters(targetServer.id);

      // Add this server to exclusion list and try next
      excludeServerIds.push(targetServer.id);

      // Only retry on capacity errors — other errors (rsync, network) won't be fixed by a different server
      if (!isCapacityError) break;
    }
  }

  // All attempts failed — rollback: restart source container
  log.error('migrate.all_attempts', { instanceId: row.id });
  if (sourceServerIp && row.container_name) {
    try {
      // Container may still be running (gateway stopped) or stopped (if rsync succeeded but later step failed)
      // Start is idempotent — succeeds even if already running
      await incus.incusExec(['start', row.container_name], sourceServerIp).catch(() => {
        /* best-effort: container may already be running */
      });
      await new Promise((r) => setTimeout(r, 3000));
      await incus.startGateway(row.container_name, sourceServerIp);
      try {
        await incus.ensureProxyDevice(row.container_name, sourceServerIp);
      } catch (err: unknown) {
        log.debug('instance_resize.is_capacity_error_best_effort', { error: toErrorMessage(err) });
        /* best-effort */
      }
    } catch (rollbackErr: unknown) {
      log.error('migrate.rollback_also', { message: toErrorMessage(rollbackErr) });
    }
  }

  db.prepare(
    `UPDATE instances SET status = '${S.ERROR}', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(`Migration failed: ${lastError?.message}`, row.id);

  notifyDiscord('❌ Migration Failed', 0xff0000, [
    { name: 'Instance', value: row.id, inline: true },
    { name: 'Container', value: row.container_name || 'unknown', inline: true },
    { name: 'Plan', value: `${row.plan} → ${planName}`, inline: true },
    { name: 'Error', value: (lastError?.message || 'unknown').slice(0, 200) },
    { name: 'Source', value: sourceServerIp || 'unknown', inline: true },
    { name: 'Attempts', value: `${MAX_MIGRATE_ATTEMPTS}`, inline: true },
  ]);

  throw new Error(
    `Migration failed after ${MAX_MIGRATE_ATTEMPTS} attempts: ${lastError?.message}. Instance rolled back to source server.`,
  );
}

export async function getDiskUsage(id: string): Promise<{ usedBytes: number; usedGB: number; diskLimit: number }> {
  const db = getDb();
  const row = selectInstanceById.stmt.get(id) as InstanceRow | undefined;
  if (!row) throw new Error('Instance not found');
  if (row.status !== S.RUNNING) throw new Error('Instance must be running');

  const serverIp = getServerIpForInstance(row);
  if (!serverIp) throw new Error('No server IP');
  const output = await incus.execCommand(row.container_name, ['du', '-sb', '/root'], serverIp);
  const usedBytes = parseInt(output.trim().split('\t')[0]) || 0;
  const usedGB = Math.round((usedBytes / (1024 * 1024 * 1024)) * 100) / 100;
  const plan = PLANS[row.plan || 'free'] || PLANS['free'];

  return { usedBytes, usedGB, diskLimit: plan.disk_gb };
}

/**
 * Get lightweight resource usage for a container by reading cgroup v2 files directly.
 * This is very fast (~10-50ms) and uses minimal memory - just reading text files.
 */
export async function getContainerResources(id: string): Promise<ContainerResources> {
  const row = resolveInstance(id);
  if (!row) throw new Error('Instance not found');
  if (!row.container_name) throw new Error('Instance has no container');

  const serverIp = getServerIpForInstance(row);
  if (!serverIp) throw new Error('No server IP for instance');

  const containerName = row.container_name;

  // Single SSH command that reads all cgroup stats at once
  // cgroup v2 paths: memory.current, memory.max, cpu.stat
  // Uses sh (not bash) and awk (not bc) for compatibility with minimal containers
  const cmd = `incus exec ${containerName} -- sh -c '
    MEM_CURRENT=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)
    MEM_MAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 0)
    CPU_USAGE1=$(grep usage_usec /sys/fs/cgroup/cpu.stat 2>/dev/null | awk "{print \\$2}" || echo 0)
    CPU_COUNT=$(nproc 2>/dev/null || echo 1)
    sleep 1
    CPU_USAGE2=$(grep usage_usec /sys/fs/cgroup/cpu.stat 2>/dev/null | awk "{print \\$2}" || echo 0)
    CPU_DELTA=$((CPU_USAGE2 - CPU_USAGE1))
    CPU_PERCENT=$(awk "BEGIN {printf \\"%.2f\\", $CPU_DELTA / 1000000 / $CPU_COUNT * 100}" 2>/dev/null || echo 0)
    echo "mem_current:$MEM_CURRENT"
    echo "mem_max:$MEM_MAX"
    echo "cpu_count:$CPU_COUNT"
    echo "cpu_percent:$CPU_PERCENT"
  '`;

  const output = await sshExec(serverIp, cmd, 10_000);

  // Parse the output
  const lines = output.trim().split('\n');
  let memCurrent = 0;
  let memMax = 0;
  let cpuCount = 1;
  let cpuPercent = 0;

  for (const line of lines) {
    const [key, value] = line.split(':');
    if (!value) continue;
    const num = parseInt(value.trim(), 10) || 0;
    switch (key.trim()) {
      case 'mem_current':
        memCurrent = num;
        break;
      case 'mem_max':
        memMax = num;
        break;
      case 'cpu_count':
        cpuCount = num;
        break;
      case 'cpu_percent':
        cpuPercent = parseFloat(value.trim()) || 0;
        break;
    }
  }

  // Handle "max" value in cgroup (no limit)
  if (memMax === 0 || memMax > 1e18) {
    // Try to get from container config limits
    try {
      const configOutput = await incus.incusExec(['config', 'get', containerName, 'limits.memory'], serverIp, 5_000);
      const match = configOutput.match(/(\d+)/);
      if (match) {
        memMax = parseInt(match[1], 10) * 1024 * 1024; // Convert MB to bytes
      }
    } catch (err: unknown) {
      log.debug('instance_resize.get_container_resources_fallback', { error: toErrorMessage(err) });
      /* fallback below */
    }
  }

  // If still no limit, use a reasonable default based on plan
  if (memMax === 0 || memMax > 1e18) {
    const plan = PLANS[row.plan || 'free'] || PLANS['free'];
    memMax = plan.ram_mb * 1024 * 1024;
  }

  const memUsedPercent = memMax > 0 ? Math.round((memCurrent / memMax) * 100) : 0;

  // Get disk usage
  let diskUsedBytes = 0;
  let diskUsedGB = 0;
  let diskLimitGB = 0;
  try {
    const diskInfo = await getDiskUsage(id);
    diskUsedBytes = diskInfo.usedBytes;
    diskUsedGB = diskInfo.usedGB;
    diskLimitGB = diskInfo.diskLimit;
  } catch (err: unknown) {
    log.debug('instance_resize.get_container_resources_disk_info', { error: toErrorMessage(err) });
    /* disk info not available */
  }
  const diskUsedPercent = diskLimitGB > 0 ? Math.round((diskUsedGB / diskLimitGB) * 100) : 0;

  return {
    memory: {
      usedBytes: memCurrent,
      maxBytes: memMax,
      usedPercent: Math.min(memUsedPercent, 100),
      usedMB: Math.round(memCurrent / 1024 / 1024),
      maxMB: Math.round(memMax / 1024 / 1024),
    },
    cpu: {
      usagePercent: Math.min(Math.round(cpuPercent), 100 * cpuCount),
      cpuCount,
    },
    disk: {
      usedBytes: diskUsedBytes,
      usedGB: diskUsedGB,
      limitGB: diskLimitGB,
      usedPercent: Math.min(diskUsedPercent, 100),
    },
    timestamp: new Date().toISOString(),
  };
}
