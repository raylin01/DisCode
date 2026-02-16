import { storage } from '../storage.js';
import * as botState from '../state.js';
import { getSessionSyncService } from './session-sync.js';
import { buildSessionStartOptions } from '../utils/session-options.js';
import type { Session } from '../../../shared/types.ts';

type SyncedCliType = 'claude' | 'codex' | 'gemini';

interface AttachInitialMessage {
  content: string;
  username: string;
  attachments?: Array<{
    name: string;
    url: string;
    contentType?: string;
    size?: number;
  }>;
}

export interface AttachSyncedSessionParams {
  threadId: string;
  userId: string;
  initialMessage?: AttachInitialMessage;
  expectApprovalReplay?: boolean;
}

export interface AttachSyncedSessionResult {
  ok: boolean;
  reason?:
    | 'not_synced_thread'
    | 'access_denied'
    | 'runner_offline'
    | 'runner_unavailable'
    | 'session_sync_unavailable';
  runnerId?: string;
  sessionId?: string;
  projectPath?: string;
  cliType?: SyncedCliType;
}

const ATTACH_APPROVAL_FALLBACK_MS = parseInt(process.env.DISCODE_ATTACH_APPROVAL_TIMEOUT_MS || '15000', 10);

async function postAttachApprovalFallbackNotice(threadId: string): Promise<void> {
  try {
    const channel = await botState.client.channels.fetch(threadId);
    if (!channel || !('send' in channel)) return;
    await channel.send({
      content: 'ℹ️ Session control attached, but no approval prompt arrived yet. If this approval does not replay, continue in the original client or retry **Attach To Approve**.'
    });
  } catch (error) {
    console.error('[SyncedSessionControl] Failed to post attach fallback notice:', error);
  }
}

export function clearAttachApprovalFallback(sessionId: string): void {
  const pending = botState.pendingSyncedAttachFallbacks.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  botState.pendingSyncedAttachFallbacks.delete(sessionId);
}

export function scheduleAttachApprovalFallback(sessionId: string, threadId: string): void {
  clearAttachApprovalFallback(sessionId);

  const timeout = setTimeout(() => {
    botState.pendingSyncedAttachFallbacks.delete(sessionId);
    void postAttachApprovalFallbackNotice(threadId);
  }, ATTACH_APPROVAL_FALLBACK_MS);

  botState.pendingSyncedAttachFallbacks.set(sessionId, { threadId, timeout });
}

export async function attachSyncedSessionControl(
  params: AttachSyncedSessionParams
): Promise<AttachSyncedSessionResult> {
  const sessionSync = getSessionSyncService();
  if (!sessionSync) {
    return { ok: false, reason: 'session_sync_unavailable' };
  }

  const syncEntry = sessionSync.getSessionByThreadId(params.threadId);
  if (!syncEntry) {
    return { ok: false, reason: 'not_synced_thread' };
  }

  const syncedCliType: SyncedCliType = syncEntry.session.cliType === 'codex'
    ? 'codex'
    : syncEntry.session.cliType === 'gemini'
    ? 'gemini'
    : 'claude';
  const syncedPlugin = syncedCliType === 'codex'
    ? 'codex-sdk'
    : syncedCliType === 'gemini'
    ? 'gemini-sdk'
    : 'claude-sdk';
  const externalSessionId = syncEntry.session.externalSessionId;

  const runner = storage.getRunner(syncEntry.runnerId);
  if (!runner || !storage.canUserAccessRunner(params.userId, syncEntry.runnerId)) {
    return { ok: false, reason: 'access_denied' };
  }

  if (runner.status !== 'online') {
    return { ok: false, reason: 'runner_offline', runnerId: runner.runnerId };
  }

  const ws = botState.runnerConnections.get(runner.runnerId);
  if (!ws) {
    return { ok: false, reason: 'runner_unavailable', runnerId: runner.runnerId };
  }

  let sessionObj = storage.getSession(externalSessionId);
  if (!sessionObj) {
    const createdSession: Session = {
      sessionId: externalSessionId,
      runnerId: runner.runnerId,
      channelId: syncEntry.session.threadId || params.threadId,
      threadId: syncEntry.session.threadId || params.threadId,
      createdAt: new Date().toISOString(),
      status: 'active',
      cliType: syncedCliType,
      plugin: syncedPlugin,
      folderPath: syncEntry.projectPath,
      creatorId: params.userId,
      interactionToken: ''
    };
    storage.createSession(createdSession);
    sessionObj = createdSession;
  } else {
    sessionObj.status = 'active';
    storage.updateSession(sessionObj.sessionId, sessionObj);
  }

  sessionSync.markSessionAsOwned(externalSessionId, syncedCliType);
  botState.sessionStatuses.set(externalSessionId, 'working');

  const startOptions = buildSessionStartOptions(
    runner,
    undefined,
    { resumeSessionId: externalSessionId },
    syncedCliType
  );
  sessionObj.options = startOptions;
  storage.updateSession(sessionObj.sessionId, sessionObj);

  ws.send(JSON.stringify({
    type: 'session_start',
    data: {
      sessionId: externalSessionId,
      runnerId: runner.runnerId,
      cliType: syncedCliType,
      plugin: syncedPlugin,
      folderPath: syncEntry.projectPath,
      resume: true,
      options: startOptions
    }
  }));

  const hasInitialContent = Boolean(params.initialMessage?.content?.trim());
  const hasInitialAttachments = Boolean(params.initialMessage?.attachments && params.initialMessage.attachments.length > 0);
  if (params.initialMessage && (hasInitialContent || hasInitialAttachments)) {
    ws.send(JSON.stringify({
      type: 'user_message',
      data: {
        sessionId: externalSessionId,
        userId: params.userId,
        username: params.initialMessage.username,
        content: params.initialMessage.content,
        attachments: params.initialMessage.attachments && params.initialMessage.attachments.length > 0
          ? params.initialMessage.attachments
          : undefined,
        timestamp: new Date().toISOString()
      }
    }));
  }

  botState.streamingMessages.delete(externalSessionId);

  if (params.expectApprovalReplay) {
    scheduleAttachApprovalFallback(externalSessionId, syncEntry.session.threadId || params.threadId);
  }

  return {
    ok: true,
    runnerId: runner.runnerId,
    sessionId: externalSessionId,
    projectPath: syncEntry.projectPath,
    cliType: syncedCliType
  };
}
