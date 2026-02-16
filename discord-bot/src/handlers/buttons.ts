/**
 * Button Interaction Dispatcher
 *
 * Thin router that delegates button clicks to focused handler modules.
 * All logic has been moved to:
 *   - approval-buttons.ts   (allow/deny/scope/tell/option/allowAll)
 *   - question-buttons.ts   (multiselect toggle/submit, other)
 *   - session-buttons.ts    (session creation wizard)
 *   - dashboard-buttons.ts  (runner stats, project sessions, sync)
 *   - permission-buttons.ts (unified perm_ buttons)
 *   - config.ts             (runner config)
 */

import {

    safeDeferReply,
    safeDeferUpdate,
    safeEditReply
} from './interaction-safety.js';
import { extractPermissionRequestId } from '../permissions/reissue.js';
import { attemptPermissionReissue } from '../permissions/reissue.js';
import { handlePermissionButton } from './permission-buttons.js';
import { handleRunnerConfig, handleConfigAction } from './config.js';
import { handleSyncProjects } from './commands/sync-projects.js';

// Modular handlers
import {
    handleApprovalButton,
    handleAllowAll,
    handleScopeButton,
    handleTellClaude,
    handleOptionButton
} from './approval-buttons.js';

import {
    handleMultiSelectToggle,
    handleMultiSelectSubmit,
    handleOtherButton
} from './question-buttons.js';

import {
    handleRunnerSelection,
    handleCliSelection,
    handlePluginSelection,
    handleBackToRunners,
    handleBackToCli,
    handleBackToPlugin,
    handleCustomFolder,
    handleDefaultFolder,
    handleSessionCancel,
    handleSessionReview,
    handleCustomizeSettings,
    handleSessionSettings,
    handleSessionSettingsModal,
    handleSessionModelPicker,
    handleSessionModelSelected,
    handleStartSession,
    handlePromptButton,
    handleCreateFolderRetry
} from './session-buttons.js';

import {
    handleRunnerStats,
    handleListSessionsButton,
    handleNewSessionButton,
    handleSyncSessionsButton,
    parseProjectDashboardContext
} from './dashboard-buttons.js';
import { handleSyncAttachControlButton } from './synced-session-buttons.js';

// Re-export for external consumers
export { handleSessionReview } from './session-buttons.js';

// ---------------------------------------------------------------------------
// Auto-defer logic
// ---------------------------------------------------------------------------

function getAutoDeferMode(customId: string): 'reply' | 'update' | null {
    const isConfigModal = customId.startsWith('config:') && customId.split(':')[2] === 'modal';
    const isModalTrigger =
        customId.startsWith('prompt_') ||
        customId.startsWith('other_') ||
        customId.startsWith('tell_') ||
        customId.startsWith('perm_tell_') ||
        customId === 'session_custom_folder' ||
        customId.startsWith('session_settings_modal:') ||
        isConfigModal;

    if (isModalTrigger) return null;

    if (customId.startsWith('new_session:')) return 'reply';
    if (customId.startsWith('list_sessions:')) return 'reply';
    if (customId.startsWith('sync_sessions:')) return 'reply';
    if (customId.startsWith('sync_projects:')) return 'reply';
    if (customId === 'sync_attach_control') return 'reply';
    if (customId.startsWith('runner_stats:')) return 'reply';
    if (customId.startsWith('create_folder_')) return 'reply';

    if (customId.startsWith('runner_config:')) return 'update';
    if (customId.startsWith('config:')) return 'update';
    if (customId.startsWith('perm_')) return 'update';
    if (customId.startsWith('allow_')) return 'update';
    if (customId.startsWith('deny_')) return 'update';
    if (customId.startsWith('scope_')) return 'update';
    if (customId.startsWith('option_')) return 'update';
    if (customId.startsWith('multiselect_')) return 'update';
    if (customId.startsWith('session_')) return 'update';

    return 'update';
}

async function reissuePermissionFromInteraction(interaction: any, customId: string, reason: 'interaction_expired' | 'missing_local_state'): Promise<boolean> {
    const requestId = extractPermissionRequestId(customId);
    if (!requestId) return false;

    const { requested, deduped } = await attemptPermissionReissue({
        requestId,
        channelId: interaction?.channelId || interaction?.channel?.id,
        reason
    });

    if (!requested || deduped || !interaction?.channel?.isTextBased?.()) {
        return requested;
    }

    await interaction.channel.send({
        content: 'That permission interaction expired, so I requested a fresh approval prompt from the runner.'
    }).catch((error: any) => console.error('[Buttons] Failed to send reissue notice:', error));

    return requested;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleButtonInteraction(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const userId = interaction.user.id;


    const delayMs = Date.now() - (interaction.createdTimestamp || Date.now());
    if (delayMs > 1500) {
        console.warn(`[Buttons] Interaction delay ${delayMs}ms for ${customId}`);
    }

    // Auto-defer where appropriate
    const autoDefer = getAutoDeferMode(customId);
    if (autoDefer === 'reply') {
        console.log(`[Buttons] Auto-deferring (reply) for ${customId}`);
        const acknowledged = await safeDeferReply(
            interaction,
            'Buttons expired. Please use the latest dashboard or run /create-session.'
        );
        if (!acknowledged) {
            await reissuePermissionFromInteraction(interaction, customId, 'interaction_expired');
            return;
        }
    } else if (autoDefer === 'update') {
        const acknowledged = await safeDeferUpdate(
            interaction,
            'Buttons expired. Please use the latest session prompt or run /create-session.'
        );
        if (!acknowledged) {
            await reissuePermissionFromInteraction(interaction, customId, 'interaction_expired');
            return;
        }
    }

    // ── Prompt & Folder ──────────────────────────────────────────────────
    if (customId.startsWith('prompt_'))        { await handlePromptButton(interaction, userId, customId); return; }
    if (customId.startsWith('create_folder_')) { await handleCreateFolderRetry(interaction, userId, customId); return; }

    // ── Questions (multi-select, other) ──────────────────────────────────
    if (customId.startsWith('multiselect_') && !customId.startsWith('multiselect_submit_'))
        { await handleMultiSelectToggle(interaction, userId, customId); return; }
    if (customId.startsWith('multiselect_submit_'))
        { await handleMultiSelectSubmit(interaction, userId, customId); return; }
    if (customId.startsWith('other_'))
        { await handleOtherButton(interaction, userId, customId); return; }

    // ── Options (single-select) ──────────────────────────────────────────
    if (customId.startsWith('option_'))
        { await handleOptionButton(interaction, userId, customId); return; }

    // ── Permission buttons (new unified perm_ format) ────────────────────
    if (customId.startsWith('perm_'))
        { await handlePermissionButton(interaction, userId, customId); return; }

    // ── Approval buttons (allow/deny/scope/tell) ─────────────────────────
    if (customId.startsWith('scope_'))
        { await handleScopeButton(interaction, userId, customId); return; }
    if (customId.startsWith('tell_'))
        { await handleTellClaude(interaction, userId, customId); return; }
    if (customId.startsWith('allow_all_'))
        { await handleAllowAll(interaction, userId, customId); return; }
    if (customId.startsWith('allow_') || customId.startsWith('deny_'))
        { await handleApprovalButton(interaction, userId, customId); return; }

    // ── Session creation wizard ──────────────────────────────────────────
    if (customId.startsWith('session_runner_'))  { await handleRunnerSelection(interaction, userId, customId); return; }
    if (customId.startsWith('session_cli_'))     { await handleCliSelection(interaction, userId, customId); return; }
    if (customId.startsWith('session_plugin_'))  { await handlePluginSelection(interaction, userId, customId); return; }
    if (customId === 'session_back_runners')     { await handleBackToRunners(interaction, userId); return; }
    if (customId === 'session_back_cli')         { await handleBackToCli(interaction, userId); return; }
    if (customId === 'session_back_plugin')      { await handleBackToPlugin(interaction, userId); return; }
    if (customId === 'session_custom_folder')    { await handleCustomFolder(interaction, userId); return; }
    if (customId === 'session_cancel')           { await handleSessionCancel(interaction, userId); return; }
    if (customId === 'session_default_folder')   { await handleDefaultFolder(interaction, userId); return; }
    if (customId === 'session_start')            { await handleStartSession(interaction, userId); return; }
    if (customId === 'session_customize')        { await handleCustomizeSettings(interaction, userId); return; }
    if (customId === 'session_pick_model')       { await handleSessionModelPicker(interaction, userId, false); return; }
    if (customId === 'session_pick_model_refresh') { await handleSessionModelPicker(interaction, userId, true); return; }
    if (customId === 'session_select_model')     { await handleSessionModelSelected(interaction, userId); return; }
    if (customId === 'session_review')           { await handleSessionReview(interaction, userId); return; }
    if (customId.startsWith('session_settings_modal:')) { await handleSessionSettingsModal(interaction, userId, customId); return; }
    if (customId.startsWith('session_settings_'))      { await handleSessionSettings(interaction, userId, customId); return; }

    // ── Runner dashboard ─────────────────────────────────────────────────
    if (customId.startsWith('runner_config:'))  { const rid = customId.split(':')[1]; await handleRunnerConfig(interaction, userId, rid); return; }
    if (customId.startsWith('config:'))         { await handleConfigAction(interaction, userId, customId); return; }
    if (customId.startsWith('runner_stats:'))   { const rid = customId.split(':')[1]; await handleRunnerStats(interaction, userId, rid); return; }
    if (customId.startsWith('sync_projects:'))  { const rid = customId.split(':')[1]; await handleSyncProjects(interaction, userId, rid); return; }
    if (customId === 'sync_attach_control') { await handleSyncAttachControlButton(interaction, userId); return; }

    // ── Project dashboard ────────────────────────────────────────────────
    if (customId.startsWith('list_sessions:')) {
        const parsed = parseProjectDashboardContext(customId, 'list_sessions');
        if (!parsed) { await safeEditReply(interaction, { content: '❌ Invalid dashboard action.' }); return; }
        await handleListSessionsButton(interaction, userId, parsed.projectPath);
        return;
    }
    if (customId.startsWith('new_session:')) {
        const parsed = parseProjectDashboardContext(customId, 'new_session');
        if (!parsed) { await safeEditReply(interaction, { content: '❌ Invalid dashboard action.' }); return; }
        await handleNewSessionButton(interaction, userId, parsed.projectPath, parsed.runnerIdHint);
        return;
    }
    if (customId.startsWith('sync_sessions:')) {
        const parsed = parseProjectDashboardContext(customId, 'sync_sessions');
        if (!parsed) { await safeEditReply(interaction, { content: '❌ Invalid dashboard action.' }); return; }
        await handleSyncSessionsButton(interaction, userId, parsed.projectPath, parsed.runnerIdHint);
        return;
    }

    // ── Fallback ─────────────────────────────────────────────────────────
    const acknowledged = await safeDeferReply(interaction);
    if (!acknowledged) return;

    await safeEditReply(interaction, {
        content: '❓ Unknown action. Please try again or refresh the dashboard.'
    });
}
