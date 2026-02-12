import { describe, it, expect } from 'vitest';
import {
  pruneExpiredPendingApprovalRequests,
  toApprovalRequestPayload,
  PENDING_APPROVAL_TTL_MS
} from '../../src/permissions/pending-requests';
import type { PendingApprovalRequestInfo } from '../../src/types';

function createPending(overrides?: Partial<PendingApprovalRequestInfo>): PendingApprovalRequestInfo {
  const now = Date.now();
  return {
    requestId: 'req-1',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    options: ['Allow', 'Deny'],
    isMultiSelect: false,
    hasOther: false,
    suggestions: [],
    blockedPath: undefined,
    decisionReason: undefined,
    timestamp: new Date(now).toISOString(),
    firstSeenAt: now,
    lastSentAt: now,
    resendCount: 0,
    ...overrides
  };
}

describe('pruneExpiredPendingApprovalRequests', () => {
  it('removes only expired pending requests', () => {
    const now = Date.now();
    const pending = new Map<string, PendingApprovalRequestInfo>([
      ['old', createPending({ requestId: 'old', firstSeenAt: now - PENDING_APPROVAL_TTL_MS - 1 })],
      ['fresh', createPending({ requestId: 'fresh', firstSeenAt: now - 1000 })]
    ]);

    const removed = pruneExpiredPendingApprovalRequests(pending, now);

    expect(removed).toBe(1);
    expect(pending.has('old')).toBe(false);
    expect(pending.has('fresh')).toBe(true);
  });
});

describe('toApprovalRequestPayload', () => {
  it('returns the expected approval payload shape', () => {
    const pending = createPending();
    const payload = toApprovalRequestPayload(pending, '2026-02-12T00:00:00.000Z');

    expect(payload).toEqual({
      runnerId: 'runner-1',
      sessionId: 'session-1',
      requestId: 'req-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      options: ['Allow', 'Deny'],
      isMultiSelect: false,
      hasOther: false,
      suggestions: [],
      blockedPath: undefined,
      decisionReason: undefined,
      timestamp: '2026-02-12T00:00:00.000Z'
    });
  });
});
