import { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { storage } from '../../storage.js';
import { safeDeferReply, safeEditReply } from '../interaction-safety.js';

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
        
        // Try getting from options if chat command
        if (!targetRunnerId && interaction.isChatInputCommand()) {
            targetRunnerId = interaction.options.getString('runner') || undefined;
        }

        // Check if we have a runner ID
        if (targetRunnerId) {
            if (!storage.canUserAccessRunner(userId, targetRunnerId)) {
                await safeEditReply(interaction, { content: '❌ You do not have access to this runner.' });
                return;
            }
        } else {
            // Use local runner context if possible, or fail
            // For now, we require runner ID or infer from channel if possible (not implemented yet)
            // But usually this command is run from runner control channel
            // TODO: In Phase 4 we will map channel -> runner more robustly
            // For now, require runner ID
            await safeEditReply(interaction, { content: '❌ Please specify a runner ID.' });
            return;
        }

        const sessionSync = getSessionSyncService();
        if (!sessionSync) {
            await safeEditReply(interaction, { content: '❌ Session sync service not initialized.' });
            return;
        }

        // Run sync
        await safeEditReply(interaction, { content: '🔄 Requesting project sync from runner...' });
        
        const requestId = await sessionSync.syncProjects(targetRunnerId);
        if (!requestId) {
            await safeEditReply(interaction, { content: '❌ Runner is offline or unavailable.' });
            return;
        }

        // We don't get the projects back immediately, they come via WebSocket.
        // The user will see channels appear.
        await safeEditReply(interaction, { content: '✅ Sync requested! Project channels will appear/update shortly.' });

    } catch (error) {
        console.error('Error handling sync-projects:', error);
        await safeEditReply(interaction, { content: '❌ An error occurred while syncing projects.' });
    }
}
