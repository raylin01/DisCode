/**
 * Squire Session Wrapper
 *
 * Wraps a DisCode session with Squire enhancements.
 */

import type { Squire, Workspace } from '../../../squire/squire/src/index.js';

export interface BaseSession {
  sessionId: string;
  isActive: boolean;
  sendMessage(content: string): Promise<void>;
  sendThinking(content: string): Promise<void>;
  sendToolUse(name: string, input: Record<string, unknown>): Promise<void>;
  sendToolResult(toolCallId: string, result: string): Promise<void>;
}

export interface SquireSessionOptions {
  threadId: string;
  projectPath: string;
}

export class SquireSession implements BaseSession {
  private baseSession: BaseSession;
  private squire: Squire;
  private workspace: Workspace;

  constructor(
    baseSession: BaseSession,
    squire: Squire,
    options: SquireSessionOptions
  ) {
    this.baseSession = baseSession;
    this.squire = squire;
    this.workspace = this.getOrCreateWorkspace(options);
  }

  private getOrCreateWorkspace(options: SquireSessionOptions): Workspace {
    // Check if workspace exists for this DisCode thread
    let workspace = this.squire.getWorkspaceBySource('discode_thread', options.threadId);

    if (!workspace) {
      workspace = this.squire.createWorkspace({
        name: `DisCode: ${options.threadId}`,
        source: 'discode_thread',
        sourceId: options.threadId,
        context: {
          projectPath: options.projectPath,
        },
      });
    }

    return workspace;
  }

  get sessionId(): string {
    return this.baseSession.sessionId;
  }

  get isActive(): boolean {
    return this.baseSession.isActive;
  }

  getWorkspace(): Workspace {
    return this.workspace;
  }

  async sendMessage(content: string): Promise<void> {
    // Search memory for relevant context before sending
    const memories = await this.squire.recall(content, 3);

    if (memories.length > 0) {
      console.log(`[SquireSession] Found ${memories.length} relevant memories`);
      // TODO: Inject memories into context
    }

    await this.baseSession.sendMessage(content);
  }

  async sendThinking(content: string): Promise<void> {
    await this.baseSession.sendThinking(content);
  }

  async sendToolUse(name: string, input: Record<string, unknown>): Promise<void> {
    await this.baseSession.sendToolUse(name, input);
  }

  async sendToolResult(toolCallId: string, result: string): Promise<void> {
    await this.baseSession.sendToolResult(toolCallId, result);
  }

  /**
   * Store a memory in this workspace
   */
  async remember(content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.squire.remember(content, {
      workspaceId: this.workspace.workspaceId,
      metadata,
    });
  }

  /**
   * Search memories
   */
  async recall(query: string, limit?: number) {
    return this.squire.recall(query, limit);
  }

  /**
   * Schedule a task for this workspace
   */
  async scheduleTask(description: string, schedule: { type: string; value: string | number }) {
    return this.squire.scheduleTask({
      workspaceId: this.workspace.workspaceId,
      description,
      schedule: schedule as never,
    });
  }
}
