import { safeEditReply } from './interaction-safety.js';
import { attachSyncedSessionControl } from '../services/synced-session-control.js';
import { createSuccessEmbed } from '../utils/embeds.js';

export async function handleSyncAttachControlButton(interaction: any, userId: string): Promise<void> {
    const result = await attachSyncedSessionControl({
        threadId: interaction.channelId,
        userId,
        expectApprovalReplay: true
    });

    if (result.ok) {
        const channel = interaction.channel;
        if (channel && 'send' in channel) {
            await channel.send({
                embeds: [createSuccessEmbed(
                    'Synced Session Attached',
                    'Control is now attached to this synced session. Approval prompts will appear here when tools need permission.'
                )]
            }).catch((error: any) => console.error('[SyncedSessionControl] Failed to post attach confirmation:', error));
        }
        await safeEditReply(interaction, {
            content: '✅ Attached synced session control. Approval prompts will now flow through this thread when tools request permission.'
        });
        return;
    }

    if (result.reason === 'access_denied') {
        await safeEditReply(interaction, {
            content: '❌ You do not have access to attach this synced session.'
        });
        return;
    }

    if (result.reason === 'runner_offline') {
        await safeEditReply(interaction, {
            content: '❌ Runner is offline. Bring it online, then try attaching again.'
        });
        return;
    }

    if (result.reason === 'runner_unavailable') {
        await safeEditReply(interaction, {
            content: '❌ Runner connection is unavailable. Please try again in a moment.'
        });
        return;
    }

    await safeEditReply(interaction, {
        content: 'ℹ️ This thread is not a synced session, or session sync is unavailable.'
    });
}
