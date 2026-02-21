import { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { storage } from '../../storage.js';
import { safeDeferReply, safeEditReply } from '../interaction-safety.js';
import { getProjectPathFromContext, getRunnerIdFromContext } from '../session-context.js';

export async function handleSyncProjects(
    interaction: ChatInputCommandInteraction | ButtonInteraction, 
    userId: string,
    explicitRunnerId?: string
): Promise<void> {
    try {
        const acknowledged = await safeDeferReply(
            interaction,
            'Buttons expired. Please use the latest dashboard to sync projects.'
        );
        if (!acknowledged) return;

        let targetRunnerId = explicitRunnerId;
        let targetProjectPath: string | undefined;
        
        // Try getting from options if chat command
        if (!targetRunnerId && interaction.isChatInputCommand()) {
            targetRunnerId = interaction.options.getString('runner') || undefined;
        }

        const hasExplicitRunner = !!targetRunnerId;
        if (!targetRunnerId) {
            targetRunnerId = await getRunnerIdFromContext(interaction);
            targetProjectPath = await getProjectPathFromContext(interaction);
        }

        if (!targetRunnerId) {
            await safeEditReply(interaction, {
                content: '❌ Could not infer runner from this channel. Use `runner:` or run in a runner-control/project channel.'
            });
            return;
        }

        if (!storage.canUserAccessRunner(userId, targetRunnerId)) {
            await safeEditReply(interaction, { content: '❌ You do not have access to this runner.' });
            return;
        }

        const sessionSync = getSessionSyncService();
        if (!sessionSync) {
            await safeEditReply(interaction, { content: '❌ Session sync service not initialized.' });
            return;
        }

        if (!hasExplicitRunner && targetProjectPath) {
            await safeEditReply(interaction, { content: `🔄 Syncing current project sessions...\n\`${targetProjectPath}\`` });
            await sessionSync.ensureProjectStateForRunner(targetRunnerId, targetProjectPath);
            const requestId = await sessionSync.syncProjectSessions(targetRunnerId, targetProjectPath);
            if (!requestId) {
                await safeEditReply(interaction, { content: '❌ Runner is offline or unavailable.' });
                return;
            }
            await safeEditReply(interaction, { content: '✅ Project sync requested. Sessions will update shortly.' });
            return;
        }

        await safeEditReply(interaction, { content: '🔄 Requesting project discovery sync from runner...' });
        const requestId = await sessionSync.syncProjects(targetRunnerId);
        if (!requestId) {
            await safeEditReply(interaction, { content: '❌ Runner is offline or unavailable.' });
            return;
        }
        await safeEditReply(interaction, { content: '✅ Sync requested! Project channels will appear/update shortly.' });

    } catch (error) {
        console.error('Error handling sync-projects:', error);
        await safeEditReply(interaction, { content: '❌ An error occurred while syncing projects.' });
    }
}
