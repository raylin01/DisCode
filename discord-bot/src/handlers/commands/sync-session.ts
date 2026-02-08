/**
 * Sync Session Messages Command
 *
 * Request full message sync for a specific session from the runner.
 */

import { ChatInputCommandInteraction } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createErrorEmbed, createInfoEmbed } from '../../utils/embeds.js';
import { getSessionSyncService } from '../../services/session-sync.js';

export async function handleSyncSession(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const sessionIdOption = interaction.options.getString('session');
    const projectPathOption = interaction.options.getString('project');
    const runnerIdOption = interaction.options.getString('runner');

    let runnerId: string | undefined;
    let sessionId: string | undefined;
    let projectPath: string | undefined;

    // Try to resolve from session sync (synced sessions)
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        const syncEntry = sessionSync.getSessionByThreadId(interaction.channelId);
        if (syncEntry) {
            runnerId = syncEntry.runnerId;
            sessionId = syncEntry.session.claudeSessionId;
            projectPath = syncEntry.projectPath;
        }
    }

    // Fallback: active session in this thread (bot-owned)
    if (!sessionId) {
        const session = Object.values(storage.data.sessions).find(
            s => s.threadId === interaction.channelId && s.status === 'active'
        );
        if (session) {
            runnerId = session.runnerId;
            sessionId = session.sessionId;
            projectPath = session.folderPath;
        }
    }

    // Explicit overrides
    if (sessionIdOption) sessionId = sessionIdOption;
    if (projectPathOption) projectPath = projectPathOption;
    if (runnerIdOption) runnerId = runnerIdOption;

    if (!sessionId || !projectPath || !runnerId) {
        await interaction.editReply({
            embeds: [createErrorEmbed(
                'Missing Context',
                'Could not resolve session/project/runner. Provide `session`, `project`, and `runner` options or run this command from the session thread.'
            )]
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')]
        });
        return;
    }

    const ws = botState.runnerConnections.get(runnerId);
    if (!ws) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Runner Offline', 'The runner is not connected.')]
        });
        return;
    }

    ws.send(JSON.stringify({
        type: 'sync_session_messages',
        data: {
            runnerId,
            sessionId,
            projectPath,
            requestId: `sync_session_${sessionId}_${Date.now()}`
        }
    }));

    await interaction.editReply({
        embeds: [createInfoEmbed('Sync Requested', `Requested full message sync for session \`${sessionId.slice(0, 8)}\`.`)]
    });
}
