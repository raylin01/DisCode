/**
 * Token Command Handlers
 * 
 * Handlers for token-related commands.
 */

import { EmbedBuilder } from 'discord.js';
import { storage } from '../../storage.js';

/**
 * Handle /generate-token command
 */
export async function handleGenerateToken(interaction: any, userId: string, guildId: string): Promise<void> {
    const tokenInfo = storage.generateToken(userId, guildId);

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Token Generated')
        .setDescription('Use this token to connect your Runner Agent')
        .addFields(
            { name: 'Token', value: `\`\`\`${tokenInfo.token}\`\`\``, inline: false },
            { name: 'Warning', value: 'Keep this token secret! Anyone with this token can access your runners.', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `Created at ${new Date(tokenInfo.createdAt).toLocaleString()}` });

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}
