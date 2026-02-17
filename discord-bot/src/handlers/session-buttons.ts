/**
 * Session Creation Button Handlers
 *
 * Main handler registration and routing for session creation wizard buttons.
 * Delegates to session-wizard.ts for the actual handler implementations.
 *
 * Wizard flow:
 *   runner selection -> CLI type -> (auto-mapped SDK plugin) -> folder -> review/customize -> start
 *
 * SDK-ONLY: TMUX/Print/Stream plugins are deprecated. CLI types automatically map
 * to their SDK plugin (claude->claude-sdk, gemini->gemini-sdk, codex->codex-sdk).
 * Terminal sessions use 'tmux' plugin as before.
 */

import { ButtonInteraction } from 'discord.js';
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
    handleCreateFolderRetry,
    getRunnerIdFromContext,
    getProjectPathFromContext,
    getProjectChannelIdFromContext,
    resolveSessionCreationState
} from './session-wizard.js';

// Re-export context helpers for use in other modules (e.g., dashboard-buttons)
export {
    getRunnerIdFromContext,
    getProjectPathFromContext,
    getProjectChannelIdFromContext,
    resolveSessionCreationState
};

// Re-export wizard handlers for external use if needed
export {
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
};

// ---------------------------------------------------------------------------
// Main Button Handler Router
// ---------------------------------------------------------------------------

/**
 * Routes session button interactions to their appropriate handlers.
 * This is the main entry point for all session-related button clicks.
 */
export async function handleSessionButton(interaction: ButtonInteraction, customId: string): Promise<void> {
    const userId = interaction.user.id;

    // Runner selection
    if (customId.startsWith('session_runner_')) {
        return handleRunnerSelection(interaction, userId, customId);
    }

    // CLI type selection
    if (customId.startsWith('session_cli_')) {
        return handleCliSelection(interaction, userId, customId);
    }

    // Plugin selection (legacy, backward compat)
    if (customId.startsWith('session_plugin_')) {
        return handlePluginSelection(interaction, userId, customId);
    }

    // Navigation: Back to runners
    if (customId === 'session_back_runners') {
        return handleBackToRunners(interaction, userId);
    }

    // Navigation: Back to CLI selection
    if (customId === 'session_back_cli') {
        return handleBackToCli(interaction, userId);
    }

    // Navigation: Back to plugin selection (maps to CLI selection in SDK-only mode)
    if (customId === 'session_back_plugin') {
        return handleBackToPlugin(interaction, userId);
    }

    // Folder selection
    if (customId === 'session_custom_folder') {
        return handleCustomFolder(interaction, userId);
    }

    if (customId === 'session_default_folder') {
        return handleDefaultFolder(interaction, userId);
    }

    // Cancel session creation
    if (customId === 'session_cancel') {
        return handleSessionCancel(interaction, userId);
    }

    // Review screen
    if (customId === 'session_review') {
        await interaction.deferUpdate().catch(() => {});
        return handleSessionReview(interaction, userId);
    }

    // Customize settings
    if (customId === 'session_customize') {
        await interaction.deferUpdate().catch(() => {});
        return handleCustomizeSettings(interaction, userId);
    }

    // Session settings buttons (approval mode, permissions, etc.)
    if (customId.startsWith('session_settings_') && !customId.includes(':')) {
        return handleSessionSettings(interaction, userId, customId);
    }

    // Session settings modals (model, max turns, etc.)
    if (customId.startsWith('session_settings_modal:')) {
        return handleSessionSettingsModal(interaction, userId, customId);
    }

    // Model picker
    if (customId === 'session_pick_model') {
        await interaction.deferUpdate().catch(() => {});
        return handleSessionModelPicker(interaction, userId);
    }

    if (customId === 'session_pick_model_refresh') {
        await interaction.deferUpdate().catch(() => {});
        return handleSessionModelPicker(interaction, userId, true);
    }

    // Model selection from dropdown
    if (customId === 'session_select_model') {
        return handleSessionModelSelected(interaction, userId);
    }

    // Start session
    if (customId === 'session_start') {
        return handleStartSession(interaction, userId);
    }

    // Prompt button (for existing sessions)
    if (customId.startsWith('prompt_')) {
        return handlePromptButton(interaction, userId, customId);
    }

    // Create folder retry (for existing sessions)
    if (customId.startsWith('create_folder_')) {
        return handleCreateFolderRetry(interaction, userId, customId);
    }

    // Unknown button - log warning but don't crash
    console.warn(`[SessionButtons] Unknown button customId: ${customId}`);
}
