import { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { getCategoryManager } from '../../services/category-manager.js';
import { storage } from '../../storage.js';

export async function handleSyncProjects(
    interaction: ChatInputCommandInteraction | ButtonInteraction, 
    userId: string,
    explicitRunnerId?: string
): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
        let targetRunnerId = explicitRunnerId;
        
        // Try getting from options if chat command
        if (!targetRunnerId && interaction.isChatInputCommand()) {
            targetRunnerId = interaction.options.getString('runner') || undefined;
        }

        // Check if we have a runner ID
        if (targetRunnerId) {
            if (!storage.canUserAccessRunner(userId, targetRunnerId)) {
                await interaction.editReply('❌ You do not have access to this runner.');
                return;
            }
        } else {
            // Use local runner context if possible, or fail
            // For now, we require runner ID or infer from channel if possible (not implemented yet)
            // But usually this command is run from runner control channel
            
            // Try to find runner from category
            const categoryManager = getCategoryManager();
            // TODO: In Phase 4 we will map channel -> runner more robustly
            // For now, require runner ID
            await interaction.editReply('❌ Please specify a runner ID.');
            return;
        }

        const sessionSync = getSessionSyncService();
        if (!sessionSync) {
            await interaction.editReply('❌ Session sync service not initialized.');
            return;
        }

        // Run sync
        await interaction.editReply('🔄 Requesting project sync from runner...');
        
        await sessionSync.syncProjects(targetRunnerId);

        // We don't get the projects back immediately, they come via WebSocket.
        // The user will see channels appear.
        await interaction.editReply('✅ Sync requested! Project channels will appear/update shortly.');

    } catch (error) {
        console.error('Error handling sync-projects:', error);
        await interaction.editReply('❌ An error occurred while syncing projects.');
    }
}
