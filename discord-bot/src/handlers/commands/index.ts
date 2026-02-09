/**
 * Command Handler Index
 * 
 * Re-exports all command handlers and provides the main dispatcher.
 */

// Token commands
export { handleGenerateToken } from './token.js';

// Runner commands
export {
    handleListRunners,
    handleMyAccess,
    handleListAccess,
    handleShareRunner,
    handleUnshareRunner,
    handleRunnerStatus,
    handleRunnerHealth,
    handleRunnerLogs,
    handleActionItems,
    handleListClis,
} from './runner.js';

// Session commands
// Session commands
export {
    handleCreateSession,
    handleStatus,
    handleEndSession,
    handleUnwatch,
    handleRespawnSession,
    endSession,
} from './session.js';

export { handleResumeSession } from './resume.js';
export { handleCodexThreads, handleResumeCodex } from './codex.js';
export { handleRegisterProject } from './register-project.js';
export { handleDeleteProject } from './delete-project.js';

// Terminal commands
export {
    handleTerminals,
    handleWatch,
} from './terminal.js';

// Interrupt command
export { handleInterrupt } from './interrupt.js';

// Assistant command
export { handleAssistantCommand } from './assistant.js';

// Sync Projects command
export { handleSyncProjects } from './sync-projects.js';
export { handleSyncSession } from './sync-session.js';

// Session control commands
export {
    handleSetModel,
    handleSetPermissionMode,
    handleSetThinkingTokens
} from './session-control.js';
