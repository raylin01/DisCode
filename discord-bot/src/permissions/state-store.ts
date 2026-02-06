import { PermissionUIState } from './ui-state.js';
import type { PermissionScope } from '../../../runner-agent/src/types/permissions.js';

/**
 * Permission request data from runner-agent
 */
export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  runnerId: string;
  toolName: string;
  toolInput: Record<string, any>;
  suggestions: any[];
  isPlanMode: boolean;
  isQuestion: boolean;
  currentScope: PermissionScope;
  blockedPath?: string;
  decisionReason?: string;
  timestamp: string;
}

/**
 * Stored state for a permission request
 */
export interface RequestState {
  request: PermissionRequest;
  uiState: PermissionUIState;
  timestamp: number;
  status: 'pending' | 'completed';
}

/**
 * Store for permission request UI states
 * Handles cleanup and provides access to pending permission data
 */
export class PermissionStateStore {
  private states: Map<string, RequestState> = new Map();
  private readonly TTL = 1000 * 60 * 15; // 15 minutes
  private readonly COMPLETION_TTL = 1000 * 30; // 30 seconds to keep completed requests

  /**
   * Save a permission request with UI state
   */
  save(request: PermissionRequest): void {
    const uiState = new PermissionUIState(request.currentScope || 'session');

    this.states.set(request.requestId, {
      request,
      uiState,
      timestamp: Date.now(),
      status: 'pending'
    });

    // Schedule cleanup for this request
    setTimeout(() => {
      // Only delete if still pending or very old
      const state = this.states.get(request.requestId);
      if (state && state.status === 'pending') {
         this.delete(request.requestId);
      }
    }, this.TTL);
  }

  /**
   * Mark a request as completed and schedule cleanup
   */
  complete(requestId: string): void {
      const state = this.states.get(requestId);
      if (state) {
          state.status = 'completed';
          // Keep it for a bit to handle race conditions/duplicate clicks
          setTimeout(() => {
              this.delete(requestId);
          }, this.COMPLETION_TTL);
      }
  }

  /**
   * Get state for a request
   */
  get(requestId: string): RequestState | undefined {
    return this.states.get(requestId);
  }

  /**
   * Get UI state for a request
   */
  getUIState(requestId: string): PermissionUIState | undefined {
    const state = this.states.get(requestId);
    return state?.uiState;
  }

  /**
   * Cycle scope for a request and return new scope
   */
  cycleScope(requestId: string): PermissionScope {
    const state = this.states.get(requestId);
    if (!state) {
      throw new Error(`No state found for request: ${requestId}`);
    }

    return state.uiState.cycleScope();
  }

  /**
   * Get current scope for a request
   */
  getCurrentScope(requestId: string): PermissionScope {
    const state = this.states.get(requestId);
    return state?.uiState.scope || 'session';
  }

  /**
   * Delete a request
   */
  delete(requestId: string): void {
    this.states.delete(requestId);
  }

  /**
   * Clean up expired states
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, state] of this.states.entries()) {
      if (now - state.timestamp > this.TTL) {
        this.states.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get all pending requests
   */
  getAll(): Map<string, RequestState> {
    return new Map(this.states);
  }

  /**
   * Get count of pending requests
   */
  get size(): number {
    return this.states.size;
  }
}

// Global singleton instance
export const permissionStateStore = new PermissionStateStore();
