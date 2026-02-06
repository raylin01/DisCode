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

/**
 * Format tool input as structured embed fields instead of raw JSON.
 * Shows description first, then command/other fields for better readability.
 */
function formatToolInputAsFields(toolName: string, toolInput: unknown): { name: string; value: string; inline: boolean }[] {
    const fields: { name: string; value: string; inline: boolean }[] = [];
    
    if (!toolInput || typeof toolInput !== 'object') {
        const str = String(toolInput).substring(0, 1000);
        return [{ name: 'Input', value: `\`${str}\``, inline: false }];
    }

    const input = toolInput as Record<string, unknown>;
    
    // Show description first (if present) for context
    if ('description' in input && input.description) {
        fields.push({
            name: 'Description',
            value: String(input.description).substring(0, 1000),
            inline: false
        });
    }

    // Handle Bash/command tool patterns
    if ('command' in input && input.command) {
        const cmd = String(input.command);
        // Use code block for longer commands, inline code for short ones
        const formattedCmd = cmd.length > 80 
            ? `\`\`\`bash\n${cmd.substring(0, 900)}\n\`\`\`` 
            : `\`${cmd.substring(0, 200)}\``;
        fields.push({
            name: 'Command',
            value: formattedCmd,
            inline: false
        });
    }

    // Handle file path operations
    if ('file' in input || 'path' in input || 'filePath' in input || 'file_path' in input) {
        const filePath = String(input.file || input.path || input.filePath || input.file_path);
        fields.push({
            name: 'File Target',
            // Use header syntax for "bigger" look, plus code block for clarity
            value: `### \`${filePath}\``,
            inline: false
        });
    }

    // Handle content/code fields
    if ('content' in input && input.content) {
        const content = String(input.content);
        const preview = content.length > 300 
            ? content.substring(0, 300) + '...' 
            : content;
        fields.push({
            name: 'Content Preview',
            value: `\`\`\`\n${preview}\n\`\`\``,
            inline: false
        });
    }

    // Add any remaining fields not already handled
    const handledKeys = new Set(['description', 'command', 'file', 'path', 'filePath', 'content']);
    for (const [key, value] of Object.entries(input)) {
        if (handledKeys.has(key)) continue;
        
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        const truncated = strValue.length > 200 ? strValue.substring(0, 200) + '...' : strValue;
        
        // Capitalize key for display
        const displayKey = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
        fields.push({
            name: displayKey,
            value: `\`${truncated}\``,
            inline: strValue.length < 50
        });
    }

    // Fallback if no fields were extracted
    if (fields.length === 0) {
        const fallback = JSON.stringify(toolInput, null, 2).substring(0, 1000);
        return [{ name: 'Input', value: `\`\`\`json\n${fallback}\n\`\`\``, inline: false }];
    }

    return fields;
}

export function createToolUseEmbed(runner: RunnerInfo, toolName: string, toolInput: unknown): EmbedBuilder {
    const inputFields = formatToolInputAsFields(toolName, toolInput);

    return new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle('Tool Use Approval Required')
        .addFields(
            { name: 'Runner', value: `\`${runner.name}\``, inline: true },
            { name: 'Tool', value: `\`${toolName}\``, inline: true },
            ...inputFields
        )
        .setTimestamp()
        .setFooter({ text: `Runner ID: ${runner.runnerId}` });
}

/**
 * Detect and format markdown tables in content.
 * Discord doesn't render markdown tables, so we wrap them in code blocks
 * to preserve alignment.
 */
export function formatContentWithTables(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let inTable = false;
    let tableLines: string[] = [];

    // Regex to detect table rows (lines with | as column separators)
    const tableRowPattern = /^\|.*\|$/;
    // Regex to detect table separator row (e.g., |---|---|)
    const tableSeparatorPattern = /^\|[\s-:|]+\|$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const isTableLine = tableRowPattern.test(line) || tableSeparatorPattern.test(line);

        if (isTableLine) {
            if (!inTable) {
                // Starting a new table
                inTable = true;
                tableLines = [];
            }
            tableLines.push(lines[i]); // Keep original spacing
        } else {
            if (inTable) {
                // End of table, wrap in code block
                result.push('```');
                result.push(...tableLines);
                result.push('```');
                inTable = false;
                tableLines = [];
            }
            result.push(lines[i]);
        }
    }

    // Handle table at end of content
    if (inTable && tableLines.length > 0) {
        result.push('```');
        result.push(...tableLines);
        result.push('```');
    }

    return result.join('\n');
}

export function createOutputEmbed(outputType: string, content: string): EmbedBuilder {
    const colors: Record<string, number> = {
        stdout: COLORS.DARK,
        stderr: COLORS.ORANGE,
        info: COLORS.INFO,
        thinking: COLORS.BLURPLE,
        edit: COLORS.WARNING,
        tool_use: COLORS.WARNING,
        tool_result: COLORS.SUCCESS,
        todos: COLORS.SUCCESS,
        error: COLORS.ERROR
    };

    const titles: Record<string, string> = {
        stdout: 'CLI Output',
        stderr: 'Error Output',
        info: 'Info',
        thinking: 'Thinking',
        edit: 'Editing File',
        tool_use: 'Tool Request',
        tool_result: 'Tool Result',
        todos: 'Todo List',
        error: 'System Error'
    };

    const color = colors[outputType] || COLORS.DARK;
    const title = titles[outputType] || outputType.toUpperCase();
    
    // Format tables if present in stdout/info output
    const formattedContent = (outputType === 'stdout' || outputType === 'info')
        ? formatContentWithTables(content)
        : content;

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(formattedContent.substring(0, 4096))
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

export function createApprovalDecisionEmbed(
    allowed: boolean,
    toolName: string,
    username: string,
    detail?: string,
    toolInput?: Record<string, any>
): EmbedBuilder {
    const description = detail
        ? `Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}\n\n**Choice:** ${detail}`
        : `Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}`;

    const embed = new EmbedBuilder()
        .setColor(allowed ? COLORS.SUCCESS : COLORS.ERROR)
        .setTitle(allowed ? '✅ Allowed' : '❌ Denied')
        .setDescription(description)
        .setTimestamp();

    // Add tool input as a field if provided
    if (toolInput && Object.keys(toolInput).length > 0) {
        const inputStr = formatToolInputForEmbed(toolInput);
        embed.addFields({
            name: 'Tool Input',
            value: inputStr,
            inline: false
        });
    }

    return embed;
}

/**
 * Format tool input for display in embed
 */
function formatToolInputForEmbed(input: Record<string, any>): string {
    if (!input || Object.keys(input).length === 0) {
        return 'No input parameters';
    }

    const lines: string[] = [];
    for (const [key, value] of Object.entries(input)) {
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        // Truncate long values
        const truncated = strValue.length > 300 ? `${strValue.slice(0, 300)}...` : strValue;
        lines.push(`**${key}**: \`${truncated}\``);
    }

    return lines.join('\n').slice(0, 1000); // Discord field value max is 1024
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
