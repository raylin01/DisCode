import { describe, it, expect } from 'vitest';
import { extractSessionIdFromRequestId, resolveSessionIdForRequest } from '../../src/handlers/approval-request-utils';
import type { PendingApprovalRequestInfo } from '../../src/types';

function makePending(sessionId: string, requestId: string): PendingApprovalRequestInfo {
  return {
    requestId,
    runnerId: 'runner-1',
    sessionId,
    toolName: 'Bash',
    toolInput: {},
    timestamp: new Date().toISOString(),
    firstSeenAt: Date.now(),
    lastSentAt: Date.now(),
    resendCount: 0
  };
}

describe('extractSessionIdFromRequestId', () => {
  it('extracts sessionId from canonical request format', () => {
    const requestId = '11111111-2222-3333-4444-555555555555-1739584000000';
    expect(extractSessionIdFromRequestId(requestId)).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('handles request IDs with random suffix', () => {
    const requestId = 'abc123-session-1739584000000-a1b2c3d4';
    expect(extractSessionIdFromRequestId(requestId)).toBe('abc123-session');
  });

  it('returns undefined for unknown formats', () => {
    expect(extractSessionIdFromRequestId('req_manual_123')).toBeUndefined();
  });
});

describe('resolveSessionIdForRequest', () => {
  it('prefers explicit sessionId when provided', () => {
    const pending = new Map<string, PendingApprovalRequestInfo>();
    pending.set('req-1', makePending('from-map', 'req-1'));

    const resolved = resolveSessionIdForRequest(
      { requestId: 'req-1', sessionId: 'explicit-session' },
      pending
    );

    expect(resolved).toBe('explicit-session');
  });

  it('uses pending request map when sessionId is omitted', () => {
    const pending = new Map<string, PendingApprovalRequestInfo>();
    pending.set('req-1', makePending('map-session', 'req-1'));

    const resolved = resolveSessionIdForRequest({ requestId: 'req-1' }, pending);
    expect(resolved).toBe('map-session');
  });

  it('falls back to requestId parsing when map lookup misses', () => {
    const pending = new Map<string, PendingApprovalRequestInfo>();
    const requestId = 's-123-1739584000000';

    const resolved = resolveSessionIdForRequest({ requestId }, pending);
    expect(resolved).toBe('s-123');
  });
});
