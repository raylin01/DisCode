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

  const pending = botState.pendingApprovals.get(requestId);
  if (pending?.runnerId) {
    runnerIds.add(pending.runnerId);
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

export async function attemptPermissionReissue(options: ReissueOptions): Promise<{ requested: boolean; targetRunnerIds: string[] }> {
  const { requestId } = options;
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
        reason: options.reason || 'manual'
      }
    }));
    requested = true;
  }

  return { requested, targetRunnerIds };
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
