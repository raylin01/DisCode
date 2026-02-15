import fs from 'fs';
import path from 'path';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { permissionStateStore } from './state-store.js';

type ReissueReason =
  | 'interaction_expired'
  | 'missing_local_state'
  | 'runner_reconnect'
  | 'manual';

interface ReissueOptions {
  requestId: string;
  runnerId?: string;
  channelId?: string;
  reason?: ReissueReason;
}

const STORAGE_PATH = process.env.DISCODE_STORAGE_PATH || './data';
const PERMISSION_REISSUE_LOCK_DIR = path.join(STORAGE_PATH, 'permission-reissue-locks');
const PERMISSION_REISSUE_COOLDOWN_MS = parseInt(process.env.DISCODE_PERMISSION_REISSUE_COOLDOWN_MS || '5000', 10);
let lastPermissionReissueCleanup = 0;

function ensurePermissionReissueLockDir(): void {
  if (!fs.existsSync(PERMISSION_REISSUE_LOCK_DIR)) {
    fs.mkdirSync(PERMISSION_REISSUE_LOCK_DIR, { recursive: true });
  }
}

function cleanupPermissionReissueLocks(nowMs: number): void {
  if (nowMs - lastPermissionReissueCleanup < 60000) return;
  lastPermissionReissueCleanup = nowMs;

  try {
    ensurePermissionReissueLockDir();
    const files = fs.readdirSync(PERMISSION_REISSUE_LOCK_DIR);
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const lockPath = path.join(PERMISSION_REISSUE_LOCK_DIR, file);
      try {
        const stat = fs.statSync(lockPath);
        if (nowMs - stat.mtimeMs > PERMISSION_REISSUE_COOLDOWN_MS) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Ignore per-file cleanup failures.
      }
    }
  } catch {
    // Ignore cleanup failures to avoid blocking reissue flow.
  }
}

function tryClaimPermissionReissue(requestId: string, reason: ReissueReason): boolean {
  const nowMs = Date.now();
  cleanupPermissionReissueLocks(nowMs);

  try {
    ensurePermissionReissueLockDir();
    const safeReason = reason.replace(/[^a-z0-9_-]/gi, '_');
    const safeRequestId = requestId.replace(/[^a-z0-9_-]/gi, '_');
    const lockPath = path.join(PERMISSION_REISSUE_LOCK_DIR, `${safeRequestId}__${safeReason}.lock`);
    fs.writeFileSync(lockPath, String(nowMs), { flag: 'wx' });
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    console.error('[Permissions] Failed to claim permission reissue lock:', error);
    // Fail open so lock issues do not block reissue.
    return true;
  }
}

function inferSessionIdFromRequestId(requestId: string): string | null {
  const match = requestId.match(/^(.+)-\d{13}(?:-[a-f0-9]{8})?$/i);
  return match ? match[1] : null;
}

function gatherCandidateRunnerIds(requestId: string, options?: ReissueOptions): string[] {
  const runnerIds = new Set<string>();

  if (options?.runnerId) {
    runnerIds.add(options.runnerId);
  }

  const requestState = permissionStateStore.get(requestId);
  if (requestState?.request?.runnerId) {
    runnerIds.add(requestState.request.runnerId);
  }

  const inferredSessionId = inferSessionIdFromRequestId(requestId);
  if (inferredSessionId) {
    const session = storage.getSession(inferredSessionId);
    if (session?.runnerId) {
      runnerIds.add(session.runnerId);
    }
  }

  if (options?.channelId) {
    const threadSessions = storage.getSessionsByThreadId(options.channelId);
    if (threadSessions.length > 0 && threadSessions[0]?.runnerId) {
      runnerIds.add(threadSessions[0].runnerId);
    }
  }

  if (runnerIds.size === 0) {
    for (const runnerId of botState.runnerConnections.keys()) {
      runnerIds.add(runnerId);
    }
  }

  return Array.from(runnerIds);
}

export async function attemptPermissionReissue(options: ReissueOptions): Promise<{ requested: boolean; targetRunnerIds: string[]; deduped: boolean }> {
  const { requestId } = options;
  const reason = options.reason || 'manual';

  if (!tryClaimPermissionReissue(requestId, reason)) {
    return { requested: true, targetRunnerIds: [], deduped: true };
  }

  const targetRunnerIds = gatherCandidateRunnerIds(requestId, options);

  let requested = false;
  for (const runnerId of targetRunnerIds) {
    const ws = botState.runnerConnections.get(runnerId);
    if (!ws) continue;

    ws.send(JSON.stringify({
      type: 'permission_sync_request',
      data: {
        runnerId,
        requestId,
        reason
      }
    }));
    requested = true;
  }

  return { requested, targetRunnerIds, deduped: false };
}

export function extractPermissionRequestId(customId: string): string | null {
  if (!customId) return null;

  if (customId.startsWith('allow_all_')) return customId.slice('allow_all_'.length);
  if (customId.startsWith('allow_')) return customId.slice('allow_'.length);
  if (customId.startsWith('deny_')) return customId.slice('deny_'.length);
  if (customId.startsWith('scope_')) return customId.slice('scope_'.length);
  if (customId.startsWith('tell_')) return customId.slice('tell_'.length);
  if (customId.startsWith('other_')) return customId.slice('other_'.length);

  if (customId.startsWith('perm_')) {
    const parts = customId.split('_');
    return parts.length >= 3 ? parts.slice(2).join('_') : null;
  }

  if (customId.startsWith('option_')) {
    const lastUnderscoreIndex = customId.lastIndexOf('_');
    if (lastUnderscoreIndex <= 'option_'.length) return null;
    return customId.substring('option_'.length, lastUnderscoreIndex);
  }

  if (customId.startsWith('multiselect_submit_')) {
    return customId.slice('multiselect_submit_'.length);
  }

  if (customId.startsWith('multiselect_')) {
    const prefix = 'multiselect_';
    const lastUnderscoreIndex = customId.lastIndexOf('_');
    if (lastUnderscoreIndex <= prefix.length) return null;
    return customId.substring(prefix.length, lastUnderscoreIndex);
  }

  return null;
}
