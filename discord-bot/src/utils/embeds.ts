/**
 * Discord Embed Creators
 * 
 * All embed builder functions for consistent Discord message formatting.
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import type { RunnerInfo, Session } from '../../../shared/types.ts';

// Color constants
const COLORS = {
    SUCCESS: 0x00FF00,
    ERROR: 0xFF0000,
    WARNING: 0xFFD700,
    INFO: 0x0099FF,
    DARK: 0x2B2D31,
    ORANGE: 0xFF6600,
    BLURPLE: 0x5865F2,
} as const;

export function createToolUseEmbed(runner: RunnerInfo, toolName: string, toolInput: unknown): EmbedBuilder {
    const toolInputStr = JSON.stringify(toolInput, null, 2).substring(0, 1000);

    return new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle('Tool Use Approval Required')
        .addFields(
            { name: 'Runner', value: `\`${runner.name}\``, inline: true },
            { name: 'Tool', value: `\`${toolName}\``, inline: true },
            { name: 'Input', value: `\`\`\`json\n${toolInputStr}\n\`\`\``, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `Runner ID: ${runner.runnerId}` });
}

export function createOutputEmbed(outputType: string, content: string): EmbedBuilder {
    const colors: Record<string, number> = {
        stdout: COLORS.DARK,
        stderr: COLORS.ORANGE,
        tool_use: COLORS.WARNING,
        tool_result: COLORS.SUCCESS,
        error: COLORS.ERROR
    };

    const titles: Record<string, string> = {
        stdout: 'CLI Output',
        stderr: 'Error Output',
        tool_use: 'Tool Request',
        tool_result: 'Tool Result',
        error: 'System Error'
    };

    const color = colors[outputType] || COLORS.DARK;
    const title = titles[outputType] || outputType.toUpperCase();

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(content.substring(0, 4096))
        .setTimestamp();
}

export function createActionItemEmbed(actionItem: string): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle('Action Item Detected')
        .setDescription(actionItem)
        .setTimestamp();
}

export function createSessionStartEmbed(runner: RunnerInfo, session: Session): EmbedBuilder {
    const fields = [
        { name: 'Runner', value: `\`${runner.name}\``, inline: true },
        { name: 'CLI', value: session.cliType.toUpperCase(), inline: true },
        { name: 'Session ID', value: `\`${session.sessionId}\``, inline: false }
    ];

    if (session.folderPath) {
        fields.push({ name: 'Working Folder', value: `\`\`\`${session.folderPath}\`\`\``, inline: false });
    }

    return new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('Session Started')
        .addFields(...fields)
        .setTimestamp()
        .setFooter({ text: 'Type your prompt to start using the CLI' });
}

export function createApprovalDecisionEmbed(allowed: boolean, toolName: string, username: string, detail?: string): EmbedBuilder {
    const description = detail
        ? `Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}\n\n**Choice:** ${detail}`
        : `Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}`;

    return new EmbedBuilder()
        .setColor(allowed ? COLORS.SUCCESS : COLORS.ERROR)
        .setTitle(allowed ? '✅ Allowed' : '❌ Denied')
        .setDescription(description)
        .setTimestamp();
}

export function createRunnerOfflineEmbed(runner: RunnerInfo): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Runner Offline')
        .setDescription(`Your runner \`${runner.name}\` has gone offline.\n\nCheck that the Runner Agent is still running.`)
        .addFields(
            { name: 'Runner ID', value: `\`${runner.runnerId}\``, inline: true },
            { name: 'Last Seen', value: new Date(runner.lastHeartbeat).toLocaleString(), inline: true }
        )
        .setTimestamp();
}

export function createRunnerOnlineEmbed(runner: RunnerInfo, wasReclaimed: boolean = false): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('🟢 Runner Online')
        .setDescription(`Runner \`${runner.name}\` is now online and ready.`)
        .addFields(
            { name: 'Status', value: '🟢 Online', inline: true },
            { name: 'CLI Types', value: runner.cliTypes.join(', ') || 'N/A', inline: true }
        )
        .setTimestamp();

    if (wasReclaimed) {
        embed.addFields({
            name: 'Note',
            value: 'Runner was restarted and reclaimed from previous offline state.',
            inline: false
        });
    }

    return embed;
}

export function createSessionInactiveEmbed(runner: RunnerInfo, session: Session): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.ORANGE)
        .setTitle('Session Inactive - Runner Offline')
        .setDescription(`The runner for this session (\`${runner.name}\`) has gone offline.\n\n**This session is paused until the runner comes back online.**\n\nMessages sent will be queued and delivered when the runner reconnects.`)
        .addFields(
            { name: 'Runner Status', value: '🔴 Offline', inline: true },
            { name: 'Session ID', value: `\`${session.sessionId}\``, inline: true },
            { name: 'CLI Type', value: session.cliType.toUpperCase(), inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'The Runner Agent needs to be restarted to resume this session' });
}

export function createInfoEmbed(title: string, description: string): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
}

export function createErrorEmbed(title: string, description: string): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
}

export function createSuccessEmbed(title: string, description: string): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
}

export function createSendPromptButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setLabel('Send Prompt')
                .setStyle(ButtonStyle.Primary)
                .setCustomId(`prompt_${sessionId}`)
                .setEmoji('💬')
        );
}

export function createCommandRunningEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.ORANGE)
        .setTitle('Command Running')
        .setDescription('A command is executing in the terminal...')
        .setTimestamp();
}

export function createExecutionCompleteEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('Execution Complete')
        .setDescription('Ready for next command.')
        .setTimestamp();
}

export function createSessionDiscoveredEmbed(sessionId: string, cwd?: string): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(COLORS.BLURPLE)
        .setTitle('Session Discovered')
        .setDescription(`Found existing tmux session \`${sessionId}\`. Attached Discord thread.`)
        .setTimestamp();

    if (cwd) {
        embed.addFields({ name: 'Working Directory', value: `\`${cwd}\``, inline: false });
    }

    return embed;
}

export function createSessionReactivatedEmbed(sessionId: string, cwd?: string): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('Session Reactivated')
        .setDescription(`Runner restarted and found existing tmux session \`${sessionId}\`. Thread reactivated.`)
        .setTimestamp();

    if (cwd) {
        embed.addFields({ name: 'Working Directory', value: `\`${cwd}\``, inline: false });
    }

    return embed;
}
