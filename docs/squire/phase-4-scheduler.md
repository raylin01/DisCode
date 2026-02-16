# Phase 4: Scheduler (Daemon Mode)

**Goal:** Implement a task scheduler that allows Squire to run as a persistent daemon and self-schedule tasks.

## Overview

The scheduler provides:
- **Persistent daemon mode** - Squire runs continuously
- **Self-scheduling** - Agent can schedule its own tasks via `schedule_task` tool
- **Multiple schedule types** - once, interval, cron
- **SQLite persistence** - Tasks survive restarts

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       SCHEDULER                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Task      │  │   Poll      │  │   Task      │              │
│  │   Storage   │  │   Loop      │  │   Executor  │              │
│  │  (SQLite)   │  │             │  │             │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│         │                │                │                      │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    TASK QUEUE                                ││
│  │  - Check due tasks every pollInterval                       ││
│  │  - Execute tasks in workspace context                        ││
│  │  - Store results and update nextRunAt                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Files to Create

```
squire/src/scheduler/
├── scheduler.ts            # Main Scheduler class
├── storage.ts              # SQLite task persistence
├── executor.ts             # Task execution
├── parser.ts               # Schedule expression parser
├── schema.sql              # Database schema
└── types.ts                # Scheduler-specific types
```

## Database Schema (schema.sql)

```sql
-- Scheduled tasks
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  description TEXT NOT NULL,
  schedule_type TEXT NOT NULL,  -- 'once', 'interval', 'cron'
  schedule_value TEXT NOT NULL, -- ISO timestamp, milliseconds, or cron expr
  status TEXT DEFAULT 'pending',
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  result_output TEXT,
  result_error TEXT,
  result_success INTEGER,
  result_completed_at TIMESTAMP,
  run_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON scheduled_tasks(workspace_id);

-- Task execution history
CREATE TABLE IF NOT EXISTS task_history (
  history_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  success INTEGER,
  output TEXT,
  error TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id);
CREATE INDEX IF NOT EXISTS idx_history_started ON task_history(started_at);
```

## Schedule Parser (parser.ts)

```typescript
import type { TaskSchedule } from '../types.js';

export interface ParsedSchedule {
  type: 'once' | 'interval' | 'cron';
  nextRunAt: Date;
  intervalMs?: number;
  cronExpression?: string;
}

export function parseSchedule(schedule: TaskSchedule, baseDate: Date = new Date()): ParsedSchedule {
  switch (schedule.type) {
    case 'once':
      return parseOnceSchedule(schedule.value as string, baseDate);

    case 'interval':
      return parseIntervalSchedule(schedule.value as number, baseDate);

    case 'cron':
      return parseCronSchedule(schedule.value as string, baseDate);

    default:
      throw new Error(`Unknown schedule type: ${(schedule as any).type}`);
  }
}

function parseOnceSchedule(value: string, baseDate: Date): ParsedSchedule {
  const date = new Date(value);

  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date for 'once' schedule: ${value}`);
  }

  return {
    type: 'once',
    nextRunAt: date
  };
}

function parseIntervalSchedule(valueMs: number, baseDate: Date): ParsedSchedule {
  if (typeof valueMs !== 'number' || valueMs <= 0) {
    throw new Error(`Invalid interval: ${valueMs}`);
  }

  return {
    type: 'interval',
    nextRunAt: new Date(baseDate.getTime() + valueMs),
    intervalMs: valueMs
  };
}

function parseCronSchedule(expression: string, baseDate: Date): ParsedSchedule {
  // Simplified cron parser - in production use a library like cron-parser
  // For now, just validate format
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  // Use a cron library for actual calculation
  // For MVP, we'll use a simple approximation
  const nextRun = calculateNextCronRun(expression, baseDate);

  return {
    type: 'cron',
    nextRunAt: nextRun,
    cronExpression: expression
  };
}

function calculateNextCronRun(expression: string, baseDate: Date): Date {
  // TODO: Use proper cron library (cron-parser or node-cron)
  // For MVP, return 1 hour from now
  console.warn('[Scheduler] Cron parsing not fully implemented, defaulting to 1 hour');
  return new Date(baseDate.getTime() + 60 * 60 * 1000);
}

export function calculateNextRun(
  schedule: TaskSchedule,
  lastRunAt: Date
): Date {
  const parsed = parseSchedule(schedule, lastRunAt);

  if (parsed.type === 'once') {
    // Once tasks don't repeat
    throw new Error('Once tasks cannot be rescheduled');
  }

  if (parsed.type === 'interval' && parsed.intervalMs) {
    return new Date(lastRunAt.getTime() + parsed.intervalMs);
  }

  if (parsed.type === 'cron' && parsed.cronExpression) {
    return calculateNextCronRun(parsed.cronExpression, lastRunAt);
  }

  throw new Error('Could not calculate next run');
}

// Helper to create common schedules
export const schedules = {
  inMinutes: (minutes: number): TaskSchedule => ({
    type: 'interval',
    value: minutes * 60 * 1000
  }),

  inHours: (hours: number): TaskSchedule => ({
    type: 'interval',
    value: hours * 60 * 60 * 1000
  }),

  inDays: (days: number): TaskSchedule => ({
    type: 'interval',
    value: days * 24 * 60 * 60 * 1000
  }),

  atTime: (hour: number, minute: number = 0): TaskSchedule => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);

    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    return { type: 'once', value: target.toISOString() };
  },

  daily: (hour: number, minute: number = 0): TaskSchedule => ({
    type: 'cron',
    value: `${minute} ${hour} * * *`
  }),

  hourly: (): TaskSchedule => ({
    type: 'cron',
    value: '0 * * * *'
  })
};
```

## Task Storage (storage.ts)

```typescript
import Database from 'better-sqlite3';
import crypto from 'crypto';
import type { ScheduledTask, TaskResult } from '../types.js';
import { parseSchedule, calculateNextRun } from './parser.js';

const SCHEMA = `...`; // Schema SQL from above

export class TaskStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  create(
    workspaceId: string,
    description: string,
    schedule: TaskSchedule
  ): ScheduledTask {
    const parsed = parseSchedule(schedule);
    const taskId = crypto.randomUUID();

    const task: ScheduledTask = {
      taskId,
      workspaceId,
      description,
      schedule,
      status: 'pending',
      nextRunAt: parsed.nextRunAt.toISOString(),
      createdAt: new Date().toISOString()
    };

    this.db.prepare(`
      INSERT INTO scheduled_tasks (
        task_id, workspace_id, description,
        schedule_type, schedule_value,
        next_run_at, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      workspaceId,
      description,
      schedule.type,
      String(schedule.value),
      task.nextRunAt,
      task.status,
      task.createdAt
    );

    return task;
  }

  get(taskId: string): ScheduledTask | null {
    const row = this.db.prepare(`
      SELECT * FROM scheduled_tasks WHERE task_id = ?
    `).get(taskId) as any;

    return row ? this.rowToTask(row) : null;
  }

  getByWorkspace(workspaceId: string): ScheduledTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE workspace_id = ?
      ORDER BY next_run_at ASC
    `).all(workspaceId) as any[];

    return rows.map(r => this.rowToTask(r));
  }

  getDueTasks(now: Date = new Date()): ScheduledTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status IN ('pending', 'running')
        AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(now.toISOString()) as any[];

    return rows.map(r => this.rowToTask(r));
  }

  updateStatus(taskId: string, status: ScheduledTask['status']): void {
    this.db.prepare(`
      UPDATE scheduled_tasks SET status = ? WHERE task_id = ?
    `).run(status, taskId);
  }

  recordResult(taskId: string, result: TaskResult): void {
    this.db.prepare(`
      UPDATE scheduled_tasks SET
        status = ?,
        last_run_at = ?,
        result_output = ?,
        result_error = ?,
        result_success = ?,
        result_completed_at = ?,
        run_count = run_count + 1
      WHERE task_id = ?
    `).run(
      result.success ? 'pending' : 'failed',
      result.completedAt,
      result.output || null,
      result.error || null,
      result.success ? 1 : 0,
      result.completedAt,
      taskId
    );

    // For recurring tasks, calculate next run
    const task = this.get(taskId);
    if (task && task.schedule.type !== 'once' && result.success) {
      const nextRun = calculateNextRun(task.schedule, new Date(result.completedAt));
      this.setNextRun(taskId, nextRun);
    }
  }

  setNextRun(taskId: string, nextRunAt: Date): void {
    this.db.prepare(`
      UPDATE scheduled_tasks SET next_run_at = ?, status = 'pending' WHERE task_id = ?
    `).run(nextRunAt.toISOString(), taskId);
  }

  delete(taskId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM scheduled_tasks WHERE task_id = ?
    `).run(taskId);

    return result.changes > 0;
  }

  recordHistory(entry: {
    taskId: string;
    startedAt: string;
    completedAt: string;
    success: boolean;
    output?: string;
    error?: string;
    durationMs: number;
  }): void {
    this.db.prepare(`
      INSERT INTO task_history (
        history_id, task_id, started_at, completed_at,
        success, output, error, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      entry.taskId,
      entry.startedAt,
      entry.completedAt,
      entry.success ? 1 : 0,
      entry.output || null,
      entry.error || null,
      entry.durationMs
    );
  }

  private rowToTask(row: any): ScheduledTask {
    return {
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      description: row.description,
      schedule: {
        type: row.schedule_type,
        value: row.schedule_type === 'interval'
          ? parseInt(row.schedule_value, 10)
          : row.schedule_value
      },
      status: row.status,
      lastRunAt: row.last_run_at || undefined,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      result: row.result_success !== null ? {
        success: row.result_success === 1,
        output: row.result_output || undefined,
        error: row.result_error || undefined,
        completedAt: row.result_completed_at
      } : undefined
    };
  }
}
```

## Task Executor (executor.ts)

```typescript
import type { ScheduledTask, TaskResult } from '../types.js';
import type { Squire } from '../squire.js';
import type { TaskStorage } from './storage.js';

export class TaskExecutor {
  private squire: Squire;
  private storage: TaskStorage;
  private running: Map<string, Promise<void>> = new Map();

  constructor(squire: Squire, storage: TaskStorage) {
    this.squire = squire;
    this.storage = storage;
  }

  async execute(task: ScheduledTask): Promise<TaskResult> {
    const startedAt = new Date().toISOString();

    // Check if already running
    if (this.running.has(task.taskId)) {
      return {
        success: false,
        error: 'Task is already running',
        completedAt: startedAt
      };
    }

    // Mark as running
    this.storage.updateStatus(task.taskId, 'running');

    const execution = this.runTask(task);
    this.running.set(task.taskId, execution);

    try {
      await execution;
    } finally {
      this.running.delete(task.taskId);
    }

    // Get result from storage (updated by runTask)
    const updated = this.storage.get(task.taskId);
    return updated?.result || {
      success: false,
      error: 'Task result not found',
      completedAt: new Date().toISOString()
    };
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    const startedAt = new Date().toISOString();
    let result: TaskResult;

    try {
      // Get workspace
      const workspace = this.squire.getWorkspace(task.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${task.workspaceId}`);
      }

      // Execute task via squire
      const message = await this.squire.sendMessage(
        task.workspaceId,
        `[Scheduled Task] ${task.description}`
      );

      result = {
        success: true,
        output: message.content,
        completedAt: new Date().toISOString()
      };

    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      };
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - new Date(startedAt).getTime();

    // Record result
    this.storage.recordResult(task.taskId, result);
    this.storage.recordHistory({
      taskId: task.taskId,
      startedAt,
      completedAt: result.completedAt,
      success: result.success,
      output: result.output,
      error: result.error,
      durationMs
    });
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }
}
```

## Main Scheduler (scheduler.ts)

```typescript
import type { ScheduledTask, TaskSchedule } from '../types.js';
import type { Squire } from '../squire.js';
import { TaskStorage } from './storage.js';
import { TaskExecutor } from './executor.js';

export class Scheduler {
  private pollInterval: number;
  private storage: TaskStorage;
  private executor: TaskExecutor;
  private squire: Squire;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;

  constructor(pollInterval: number, db: Database.Database, squire: Squire) {
    this.pollInterval = pollInterval;
    this.storage = new TaskStorage(db);
    this.executor = new TaskExecutor(squire, this.storage);
    this.squire = squire;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    console.log(`[Scheduler] Started (poll interval: ${this.pollInterval}ms)`);

    // Run initial check
    await this.poll();

    // Start poll loop
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollInterval);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('[Scheduler] Stopped');
  }

  private async poll(): Promise<void> {
    const dueTasks = this.storage.getDueTasks();

    if (dueTasks.length === 0) {
      return;
    }

    console.log(`[Scheduler] Executing ${dueTasks.length} due tasks`);

    // Execute tasks concurrently (but limit concurrency)
    const maxConcurrent = 3;
    const batches: ScheduledTask[][] = [];

    for (let i = 0; i < dueTasks.length; i += maxConcurrent) {
      batches.push(dueTasks.slice(i, i + maxConcurrent));
    }

    for (const batch of batches) {
      await Promise.all(batch.map(task => this.executeTask(task)));
    }
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    console.log(`[Scheduler] Executing task: ${task.description}`);

    try {
      await this.executor.execute(task);
    } catch (error) {
      console.error(`[Scheduler] Task failed: ${task.taskId}`, error);
    }
  }

  // Public API for scheduling
  schedule(options: {
    workspaceId: string;
    description: string;
    schedule: TaskSchedule;
  }): ScheduledTask {
    return this.storage.create(
      options.workspaceId,
      options.description,
      options.schedule
    );
  }

  getTask(taskId: string): ScheduledTask | null {
    return this.storage.get(taskId);
  }

  getTasks(workspaceId?: string): ScheduledTask[] {
    if (workspaceId) {
      return this.storage.getByWorkspace(workspaceId);
    }

    // Get all tasks
    const rows = this.storage.db.prepare(`
      SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC
    `).all() as any[];

    return rows.map(r => this.storage.get(r.task_id)).filter(Boolean) as ScheduledTask[];
  }

  cancelTask(taskId: string): boolean {
    if (this.executor.isRunning(taskId)) {
      console.warn(`[Scheduler] Cannot cancel running task: ${taskId}`);
      return false;
    }

    return this.storage.delete(taskId);
  }
}
```

## Schedule Tools for Agent

```typescript
// squire/src/mcp/schedule-tools.ts

export const scheduleTools = [
  {
    name: 'schedule_task',
    description: 'Schedule a task to run in the future',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What task to perform'
        },
        inMinutes: {
          type: 'number',
          description: 'Run in N minutes'
        },
        inHours: {
          type: 'number',
          description: 'Run in N hours'
        },
        atTime: {
          type: 'string',
          description: 'Run at specific time (HH:MM format)'
        },
        daily: {
          type: 'string',
          description: 'Run daily at time (HH:MM format)'
        }
      },
      required: ['description']
    }
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceOnly: {
          type: 'boolean',
          description: 'Only show tasks for current workspace'
        }
      }
    }
  },
  {
    name: 'cancel_task',
    description: 'Cancel a scheduled task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'ID of task to cancel'
        }
      },
      required: ['taskId']
    }
  }
];
```

## Usage Example

```typescript
import { Squire } from './squire.js';

const squire = new Squire({
  squireId: 'my-squire',
  daemonMode: true,
  pollInterval: 60000  // Check every minute
});

await squire.start();

// Schedule a task
const task = await squire.scheduleTask({
  workspaceId: 'workspace-123',
  description: 'Check for new GitHub issues and summarize',
  schedule: {
    type: 'interval',
    value: 6 * 60 * 60 * 1000  // Every 6 hours
  }
});

console.log(`Scheduled: ${task.taskId}`);

// Later, the task will execute automatically...
```

## Testing

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSchedule, schedules } from '../dist/scheduler/parser.js';

test('Parses interval schedule', () => {
  const result = parseSchedule({ type: 'interval', value: 60000 });
  assert.strictEqual(result.type, 'interval');
  assert.strictEqual(result.intervalMs, 60000);
});

test('Parses once schedule', () => {
  const future = new Date(Date.now() + 3600000);
  const result = parseSchedule({ type: 'once', value: future.toISOString() });
  assert.strictEqual(result.type, 'once');
  assert.ok(result.nextRunAt.getTime() > Date.now());
});

test('Helper schedules work', () => {
  const hourly = schedules.inHours(1);
  assert.strictEqual(hourly.type, 'interval');
  assert.strictEqual(hourly.value, 3600000);
});
```

## Dependencies

No new dependencies beyond better-sqlite3 already in use.

## Next Phase

- **Phase 5**: Workspace management for channel isolation
