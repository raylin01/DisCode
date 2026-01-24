/**
 * WebSocket Handlers
 * 
 * Handles all WebSocket messages from runner agents.
 */

import { WebSocketServer } from 'ws';
import { EmbedBuilder, WebhookClient, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { getConfig } from '../config.js';
import {
    createToolUseEmbed,
    createOutputEmbed,
    createActionItemEmbed,
    createRunnerOfflineEmbed,
} from '../utils/embeds.js';
import {
    getOrCreateRunnerChannel,
} from '../utils/channels.js';
import type { WebSocketMessage, RunnerInfo, Session } from '../../../shared/types.ts';

const config = getConfig();

/**
 * Create and configure the WebSocket server
 */
export function createWebSocketServer(port: number): WebSocketServer {
    const wss = new WebSocketServer({ port, noServer: false });

    wss.on('listening', () => {
        console.log(`WebSocket server listening on port ${port}`);
    });

    wss.on('error', (error: Error) => {
        if ((error as any).code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use. Please stop the other process or change DISCODE_WS_PORT.`);
            process.exit(1);
        } else {
            console.error('WebSocket server error:', error);
        }
    });

    wss.on('connection', (ws, req) => {


        ws.on('message', async (data: Buffer) => {
            try {
                const message: WebSocketMessage = JSON.parse(data.toString());

                await handleWebSocketMessage(ws, message);
            } catch (error) {
                console.error('Error handling WebSocket message:', error);
            }
        });

        ws.on('close', async () => {

            // Remove connection
            for (const [runnerId, connection] of botState.runnerConnections.entries()) {
                if (connection === ws) {
                    botState.runnerConnections.delete(runnerId);
                    storage.updateRunnerStatus(runnerId, 'offline');

                    // Notify owner about runner going offline
                    const runner = storage.getRunner(runnerId);
                    if (runner) {
                        await endAllRunnerSessions(runner);
                        await notifyRunnerOffline(runner);
                    }


                    break;
                }
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });

    return wss;
}

/**
 * End all sessions for a runner when it goes offline
 */
async function endAllRunnerSessions(runner: RunnerInfo): Promise<void> {
    const sessions = storage.getRunnerSessions(runner.runnerId);

    for (const session of sessions) {
        if (session.status === 'active') {
            // Mark session as ended
            session.status = 'ended';
            storage.updateSession(session.sessionId, session);

            // Archive the thread
            try {
                const thread = await botState.client.channels.fetch(session.threadId);
                if (thread && thread.isThread()) {
                    await thread.setArchived(true);

                }
            } catch (error) {
                console.error(`Failed to archive thread for session ${session.sessionId}:`, error);
            }
        }
    }
}

/**
 * Notify when a runner goes offline
 */
async function notifyRunnerOffline(runner: RunnerInfo): Promise<void> {
    if (!runner.ownerId) {
        console.error('Runner has no ownerId, cannot notify:', runner.runnerId);
        return;
    }

    // Only send notification if bot is ready
    if (!botState.isBotReady) {

        return;
    }

    // Try to send DM to owner (may fail if user has DMs disabled)
    try {
        const user = await botState.client.users.fetch(runner.ownerId);
        await user.send({
            embeds: [createRunnerOfflineEmbed(runner)]
        });
    } catch (error: any) {
        if (error.code === 50007) {
            console.log(`Could not send DM to user ${runner.ownerId} (DMs disabled or bot blocked)`);
        } else {
            console.error('Failed to send DM to runner owner:', error);
        }
    }

    // Send notification to the runner's private channel
    if (runner.privateChannelId) {
        try {
            const channel = await botState.client.channels.fetch(runner.privateChannelId);
            if (channel && 'send' in channel) {
                const sessions = storage.getRunnerSessions(runner.runnerId);
                const endedSessions = sessions.filter(s => s.status === 'ended');

                const embed = new EmbedBuilder()
                    .setColor(0xFF6600)
                    .setTitle('Runner Offline - Sessions Ended')
                    .setDescription(`The runner \`${runner.name}\` has gone offline.\n\n**${endedSessions.length} active session(s) automatically ended.**`)
                    .addFields(
                        { name: 'Status', value: '🔴 Offline', inline: true },
                        { name: 'Sessions Ended', value: `${endedSessions.length}`, inline: true },
                        { name: 'Action', value: 'Start a new session when the Runner Agent comes back online', inline: false }
                    )
                    .setTimestamp();

                await channel.send({ embeds: [embed] });

            }
        } catch (error) {
            console.error('Failed to send notification to runner channel:', error);
        }
    }
}

/**
 * Notify when a runner comes online
 */
export async function notifyRunnerOnline(runner: RunnerInfo, wasReclaimed: boolean = false): Promise<void> {
    if (!runner.privateChannelId) {

        return;
    }

    if (!botState.isBotReady) {

        return;
    }

    try {
        const channel = await botState.client.channels.fetch(runner.privateChannelId);
        if (channel && 'send' in channel) {
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
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

            await channel.send({ embeds: [embed] });

        }
    } catch (error) {
        console.error('Failed to send runner online notification:', error);
    }
}

/**
 * Main WebSocket message handler
 */
async function handleWebSocketMessage(ws: any, message: WebSocketMessage): Promise<void> {
    switch (message.type) {
        case 'register':
            await handleRegister(ws, message.data);
            break;

        case 'heartbeat':
            await handleHeartbeat(ws, message.data);
            break;

        case 'approval_request':
            await handleApprovalRequest(ws, message.data);
            break;

        case 'output':
            await handleOutput(message.data);
            break;

        case 'action_item':
            await handleActionItem(message.data);
            break;

        case 'metadata':
            await handleMetadata(message.data);
            break;

        case 'session_ready':
            await handleSessionReady(message.data);
            break;

        case 'status':
            await handleRunnerStatusUpdate(message.data);
            break;

        case 'session_discovered':
            await handleSessionDiscovered(message.data);
            break;

        case 'terminal_list':
            await handleTerminalList(message.data);
            break;

        case 'discord_action':
            await handleDiscordAction(message.data);
            break;

        case 'assistant_output':
            await handleAssistantOutput(message.data);
            break;

        case 'spawn_thread':
            await handleSpawnThread(ws, message.data);
            break;

        default:
            console.log('Unknown message type:', message.type);
    }
}

/**
 * Handle runner registration
 */
async function handleRegister(ws: any, data: any): Promise<void> {
    // Validate token
    const tokenInfo = storage.validateToken(data.token);

    if (!tokenInfo) {
        console.error(`Runner ${data.runnerId} attempted to register with invalid token`);
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Invalid token' }
        }));
        ws.close();
        return;
    }

    // Check if this token is already in use by a DIFFERENT runner
    const allRunners = Object.values(storage.data.runners);
    const tokenInUse = allRunners.find(r => r.token === data.token && r.runnerId !== data.runnerId);

    if (tokenInUse) {
        if (tokenInUse.status === 'online') {
            console.error(`Token already in use by ONLINE runner ${tokenInUse.runnerId}, rejecting registration from ${data.runnerId}`);
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: `Token already in use by online runner '${tokenInUse.name}'. Stop the other instance first or wait for it to go offline.` }
            }));
            ws.close();
            return;
        }

        // Allow takeover of offline runner
        console.log(`Token used by OFFLINE runner ${tokenInUse.runnerId}, allowing takeover by ${data.runnerId}`);
        const oldRunnerId = tokenInUse.runnerId;
        storage.deleteRunner(oldRunnerId);

        tokenInUse.runnerId = data.runnerId;
        tokenInUse.name = data.runnerName;
        tokenInUse.status = 'online';
        tokenInUse.lastHeartbeat = new Date().toISOString();
        tokenInUse.cliTypes = data.cliTypes;
        tokenInUse.defaultWorkspace = data.defaultWorkspace;

        if (!tokenInUse.privateChannelId) {
            try {
                tokenInUse.privateChannelId = await getOrCreateRunnerChannel(tokenInUse, tokenInfo.guildId);
            } catch (error) {
                console.error(`Failed to create private channel for reclaimed runner: ${error}`);
            }
        }

        storage.registerRunner(tokenInUse);
        botState.runnerConnections.set(data.runnerId, ws);
        console.log(`Reclaimed offline runner: ${data.runnerId} (old: ${oldRunnerId}, CLI types: ${data.cliTypes.join(', ')})`);

        await notifyRunnerOnline(tokenInUse, true);

        ws.send(JSON.stringify({
            type: 'registered',
            data: { runnerId: data.runnerId, cliTypes: data.cliTypes, reclaimed: true }
        }));
        return;
    }

    // Check if runner already exists
    const existingRunner = storage.getRunner(data.runnerId);

    if (existingRunner) {
        existingRunner.cliTypes = data.cliTypes;
        existingRunner.status = 'online';
        existingRunner.lastHeartbeat = new Date().toISOString();
        if (data.defaultWorkspace) existingRunner.defaultWorkspace = data.defaultWorkspace;
        // Update assistantEnabled from registration message
        existingRunner.assistantEnabled = data.assistantEnabled ?? true;

        if (!existingRunner.privateChannelId) {
            try {
                existingRunner.privateChannelId = await getOrCreateRunnerChannel(existingRunner, tokenInfo.guildId);
            } catch (error) {
                console.error(`Failed to create private channel for existing runner: ${error}`);
            }
        }

        storage.registerRunner(existingRunner);
        botState.runnerConnections.set(data.runnerId, ws);
        console.log(`Runner ${data.runnerId} re-registered (CLI types: ${data.cliTypes.join(', ')})`);

        await notifyRunnerOnline(existingRunner, false);
    } else {
        if (!tokenInfo.userId) {
            console.error('Token does not have a valid userId, cannot register runner');
            ws.send(JSON.stringify({
                type: 'error',
                data: { message: 'Invalid token: missing user ID. Please regenerate your token with /generate-token' }
            }));
            ws.close();
            return;
        }

        const newRunner: RunnerInfo = {
            runnerId: data.runnerId,
            name: data.runnerName,
            ownerId: tokenInfo.userId,
            token: data.token,
            status: 'online',
            lastHeartbeat: new Date().toISOString(),
            authorizedUsers: [tokenInfo.userId],
            cliTypes: data.cliTypes,
            defaultWorkspace: data.defaultWorkspace,
            assistantEnabled: data.assistantEnabled ?? true
        };

        try {
            newRunner.privateChannelId = await getOrCreateRunnerChannel(newRunner, tokenInfo.guildId);
        } catch (error) {
            console.error(`Failed to create private channel for runner: ${error}`);
        }

        storage.registerRunner(newRunner);
        botState.runnerConnections.set(data.runnerId, ws);
        console.log(`New runner registered: ${data.runnerId} (CLI types: ${data.cliTypes.join(', ')})`);

        await notifyRunnerOnline(newRunner, false);
    }

    ws.send(JSON.stringify({
        type: 'registered',
        data: { runnerId: data.runnerId, cliTypes: data.cliTypes }
    }));
}

/**
 * Handle runner heartbeat
 */
async function handleHeartbeat(ws: any, data: any): Promise<void> {
    storage.updateRunnerStatus(data.runnerId, 'online');

    if (!botState.runnerConnections.has(data.runnerId)) {
        botState.runnerConnections.set(data.runnerId, ws);

    }
}

/**
 * Create multi-select or single-select buttons for AskUserQuestion
 * @returns Object with rows array and multiSelectState if applicable
 */
function createQuestionButtons(data: any, requestId: string): { rows: ActionRowBuilder<ButtonBuilder>[], multiSelectState: any } {
    let rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let multiSelectState: any = null;

    if (data.options && data.options.length > 0) {
        const isMultiSelect = data.isMultiSelect === true;
        const hasOther = data.hasOther === true;

        // Debug logging to verify flags
        console.log(`[Approval] Creating buttons - isMultiSelect=${isMultiSelect}, hasOther=${hasOther}`);

        if (isMultiSelect) {
            // Multi-select: create toggleable buttons + Submit button
            const optionButtons = data.options.map((option: string, index: number) => {
                const optionNumber = index + 1;
                return new ButtonBuilder()
                    .setCustomId(`multiselect_${requestId}_${optionNumber}`)
                    .setLabel(option)
                    .setStyle(ButtonStyle.Secondary); // Start unselected (gray)
            });

            // Add "Other" button if hasOther is true
            if (hasOther) {
                optionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`other_${requestId}`)
                        .setLabel('Other...')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            // Add Submit button
            const submitButton = new ButtonBuilder()
                .setCustomId(`multiselect_submit_${requestId}`)
                .setLabel('✅ Submit')
                .setStyle(ButtonStyle.Success);

            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...optionButtons));
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(submitButton));

            // Create multi-select state for caller to store
            multiSelectState = {
                requestId,
                sessionId: data.sessionId,
                runnerId: data.runnerId,
                selectedOptions: new Set(),
                options: data.options,
                isMultiSelect: true,
                hasOther: hasOther,
                toolName: data.toolName,
                timestamp: new Date()
            };
        } else {
            // Single-select: add "Other" button if hasOther is true
            const buttons = data.options.map((option: string, index: number) => {
                const optionNumber = index + 1;
                let style = ButtonStyle.Secondary;
                if (index === 0) style = ButtonStyle.Success;
                else if (index === data.options.length - 1 && !hasOther) style = ButtonStyle.Danger;
                else style = ButtonStyle.Primary;

                return new ButtonBuilder()
                    .setCustomId(`option_${requestId}_${optionNumber}`)
                    .setLabel(option)
                    .setStyle(style);
            });

            // Add "Other" button if hasOther is true (for single-select)
            if (hasOther) {
                buttons.push(
                    new ButtonBuilder()
                        .setCustomId(`other_${requestId}`)
                        .setLabel('Other...')
                        .setStyle(ButtonStyle.Danger)
                );
            }

            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
        }
    }

    return { rows, multiSelectState };
}

/**
 * Handle approval request from runner
 */
async function handleApprovalRequest(ws: any, data: any): Promise<void> {


    const runner = storage.getRunner(data.runnerId);
    if (!runner) {
        console.error('[Approval] Unknown runner:', data.runnerId);
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: { requestId: data.requestId, allow: false, message: `Unknown runner: ${data.runnerId}` }
        }));
        return;
    }

    // Check if this is an assistant session
    if (data.sessionId && data.sessionId.startsWith('assistant-')) {
        console.log(`[Approval] Handling assistant usage approval for ${data.sessionId}`);

        const channel = await botState.client.channels.fetch(runner.privateChannelId);
        if (!channel || !('send' in channel)) {
            console.error('[Approval] Invalid private channel for assistant');
            return;
        }

        // Create buttons using shared helper
        const { rows, multiSelectState } = createQuestionButtons(data, data.requestId);

        // Store multi-select state if applicable
        if (multiSelectState) {
            botState.multiSelectState.set(data.requestId, multiSelectState);
        }

        // If no options/AskUserQuestion, add default approval buttons
        if (rows.length === 0) {
            const allowButton = new ButtonBuilder()
                .setCustomId(`allow_${data.requestId}`)
                .setLabel('✅ Allow Once')
                .setStyle(ButtonStyle.Success);

            const denyButton = new ButtonBuilder()
                .setCustomId(`deny_${data.requestId}`)
                .setLabel('❌ Deny')
                .setStyle(ButtonStyle.Danger);

            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(allowButton, denyButton));
        }

        // Create embed
        const toolInputStr = typeof data.toolInput === 'string'
            ? data.toolInput
            : JSON.stringify(data.toolInput, null, 2);

        const embed = new EmbedBuilder()
            .setColor(0xFFD700) // Warning color
            .setTitle('Tool Use Approval Required')
            .addFields(
                { name: 'Runner', value: `\`${runner.name}\``, inline: true },
                { name: 'Tool', value: `\`${data.toolName}\``, inline: true },
                { name: 'Input', value: `\`\`\`json\n${toolInputStr.substring(0, 1000)}\n\`\`\``, inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Runner ID: ${runner.runnerId}` });

        const message = await channel.send({
            embeds: [embed],
            components: rows
        });

        botState.pendingApprovals.set(data.requestId, {
            requestId: data.requestId,
            runnerId: data.runnerId,
            sessionId: data.sessionId,
            messageId: message.id,
            channelId: runner.privateChannelId,
            toolName: data.toolName,
            toolInput: data.toolInput,
            timestamp: new Date(),
            options: data.options,
            isMultiSelect: data.isMultiSelect,
            hasOther: data.hasOther
        });
        return;
    }

    const session = storage.getSession(data.sessionId);
    if (!session) {
        console.error('[Approval] Unknown session:', data.sessionId);
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: { requestId: data.requestId, allow: false, message: `Unknown session: ${data.sessionId}. Please start a new session in Discord.` }
        }));
        return;
    }

    // Check if this tool is auto-approved for this session
    const sessionAllowedTools = botState.allowedTools.get(data.sessionId);
    if (sessionAllowedTools && sessionAllowedTools.has(data.toolName)) {

        ws.send(JSON.stringify({
            type: 'approval_response',
            data: { requestId: data.requestId, allow: true, message: `Auto-approved (tool ${data.toolName} was previously allowed for all)` }
        }));
        return;
    }

    // Send to the thread
    const thread = await botState.client.channels.fetch(session.threadId);
    if (!thread || !('send' in thread)) {
        console.error('Invalid thread');
        return;
    }

    // Create buttons using shared helper
    const { rows, multiSelectState } = createQuestionButtons(data, data.requestId);

    // Store multi-select state if applicable
    if (multiSelectState) {
        botState.multiSelectState.set(data.requestId, multiSelectState);
    }

    // If no options/AskUserQuestion, add default approval buttons for regular sessions
    if (rows.length === 0) {
        const allowButton = new ButtonBuilder()
            .setCustomId(`allow_${data.requestId}`)
            .setLabel('✅ Allow Once')
            .setStyle(ButtonStyle.Success);

        const allowAllButton = new ButtonBuilder()
            .setCustomId(`allow_all_${data.requestId}`)
            .setLabel('✅ Allow All (This Tool)')
            .setStyle(ButtonStyle.Primary);

        const modifyButton = new ButtonBuilder()
            .setCustomId(`modify_${data.requestId}`)
            .setLabel('✏️ Modify')
            .setStyle(ButtonStyle.Secondary);

        const denyButton = new ButtonBuilder()
            .setCustomId(`deny_${data.requestId}`)
            .setLabel('❌ Deny')
            .setStyle(ButtonStyle.Danger);

        rows.push(new ActionRowBuilder<ButtonBuilder>()
            .addComponents(allowButton, allowAllButton, modifyButton, denyButton));
    }

    const embed = createToolUseEmbed(runner, data.toolName, data.toolInput);

    // Build ping content based on config
    const userMention = session.creatorId ? `<@${session.creatorId}>` : '';
    const atHere = config.notifications.useAtHere && config.notifications.pingOnApproval ? '@here ' : '';
    const pingContent = config.notifications.pingOnApproval
        ? `${atHere}${userMention} Approval needed!`
        : 'Approval needed!';

    const message = await thread.send({
        content: pingContent,
        embeds: [embed],
        components: rows
    });

    botState.pendingApprovals.set(data.requestId, {
        userId: runner.ownerId,
        channelId: session.threadId,
        messageId: message.id,
        runnerId: data.runnerId,
        sessionId: data.sessionId,
        toolName: data.toolName,
        toolInput: data.toolInput,
        options: data.options,
        isMultiSelect: data.isMultiSelect,
        hasOther: data.hasOther,
        requestId: data.requestId,
        timestamp: new Date()
    });


}

/**
 * Handle output from runner
 */
async function handleOutput(data: any): Promise<void> {
    const session = storage.getSession(data.sessionId);
    if (!session) return;

    const thread = await botState.client.channels.fetch(session.threadId);
    if (!thread || !('send' in thread)) return;

    const outputType = data.outputType || 'stdout';
    const now = Date.now();

    const streaming = botState.streamingMessages.get(data.sessionId);

    // Clear streaming state if output type changes (e.g., stdout → tool_use)
    // This ensures tool output creates a new message instead of appending to text
    if (streaming && streaming.outputType !== outputType) {
        console.log(`[Output] Output type changed from ${streaming.outputType} to ${outputType}, clearing streaming state`);
        botState.streamingMessages.delete(data.sessionId);
    }

    // Edit the most recent message if we have an active streaming state for this session
    // The streaming state is cleared when isComplete=true, so the next message starts fresh
    const shouldStream = !!botState.streamingMessages.get(data.sessionId);

    // Accumulate content for this session
    const currentStreaming = botState.streamingMessages.get(data.sessionId);
    const accumulatedContent = currentStreaming ? (currentStreaming.accumulatedContent || '') + data.content : data.content;

    const embed = createOutputEmbed(outputType, accumulatedContent);

    if (shouldStream) {
        try {
            const message = await thread.messages.fetch(currentStreaming!.messageId);
            await message.edit({ embeds: [embed] });

            botState.streamingMessages.set(data.sessionId, {
                messageId: currentStreaming!.messageId,
                lastUpdateTime: now,
                content: data.content,
                outputType: outputType,
                accumulatedContent: accumulatedContent
            });
        } catch (error) {
            console.error('Error editing message:', error);
            const newMessage = await thread.send({ embeds: [embed] });
            botState.streamingMessages.set(data.sessionId, {
                messageId: newMessage.id,
                lastUpdateTime: now,
                content: data.content,
                outputType: outputType,
                accumulatedContent: accumulatedContent
            });
        }
    } else {
        if (outputType === 'error' && data.content.includes('Folder') && data.content.includes('does not exist')) {
            const createFolderButton = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`create_folder_${data.sessionId}`)
                        .setLabel('Create Folder & Retry')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('📁')
                );

            await thread.send({
                embeds: [embed],
                components: [createFolderButton]
            });
        } else {
            const sentMessage = await thread.send({ embeds: [embed] });
            botState.streamingMessages.set(data.sessionId, {
                messageId: sentMessage.id,
                lastUpdateTime: now,
                content: data.content,
                outputType: outputType,
                accumulatedContent: accumulatedContent
            });
        }
    }

    // Clear streaming state when message is complete, so next message starts fresh
    if (data.isComplete) {
        botState.streamingMessages.delete(data.sessionId);
    }
}

/**
 * Handle action item from runner
 */
async function handleActionItem(data: any): Promise<void> {
    const session = storage.getSession(data.sessionId);
    if (!session) return;

    const channel = await botState.client.channels.fetch(session.channelId);
    if (!channel || !('send' in channel)) return;

    const items = botState.actionItems.get(session.sessionId) || [];
    items.push(data.actionItem);
    botState.actionItems.set(session.sessionId, items);

    const embed = createActionItemEmbed(data.actionItem);
    await channel.send({ embeds: [embed] });
}

/**
 * Handle metadata from runner
 */
async function handleMetadata(data: any): Promise<void> {
    const streaming = botState.streamingMessages.get(data.sessionId);
    if (!streaming || !data.activity) return;

    const session = storage.getSession(data.sessionId);
    if (!session) return;

    try {
        const thread = await botState.client.channels.fetch(session.threadId);
        if (!thread || !('messages' in thread)) return;

        const message = await thread.messages.fetch(streaming.messageId);
        if (!message || message.embeds.length === 0) return;

        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setFooter({ text: `Status: ${data.activity}` });

        await message.edit({ embeds: [embed] });
    } catch (error) {
        // Ignore errors
    }
}

/**
 * Handle session ready notification
 */
async function handleSessionReady(data: any): Promise<void> {
    const { runnerId, sessionId } = data;


    const session = storage.getSession(sessionId);
    if (!session) {
        console.error(`[handleSessionReady] Session not found: ${sessionId}`);
        return;
    }

    // Mark session as active
    session.status = 'active';
    storage.updateSession(session.sessionId, session);

    const runner = storage.getRunner(runnerId);

    try {
        const thread = await botState.client.channels.fetch(session.threadId);
        if (thread && thread.isThread()) {
            const readyEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('Session Ready!')
                .setDescription(`Connected to \`${runner?.name}\`. You can now start typing commands.`)
                .addFields({
                    name: 'Working Directory',
                    value: `\`${session.folderPath}\``,
                    inline: true
                })
                .setTimestamp();

            // Determine ping content
            const userMention = session.creatorId ? `<@${session.creatorId}>` : '';
            const atHere = config.notifications.useAtHere ? '@here ' : '';
            const content = `${atHere}${userMention} Session is ready!`;

            // Create "Go to Thread" button for ephemeral message
            const goToThreadButton = new ButtonBuilder()
                .setLabel('Go to Thread')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${thread.guildId}/${thread.id}`)
                .setEmoji('💬');

            const buttonRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(goToThreadButton);

            await thread.send({
                content,
                embeds: [readyEmbed]
            });

            // Update ephemeral message if we have the token
            if (session.interactionToken && botState.client.application) {
                try {
                    const webhook = new WebhookClient({ id: botState.client.application.id, token: session.interactionToken });
                    await webhook.editMessage('@original', {
                        embeds: [readyEmbed],
                        components: [buttonRow]
                    });

                } catch (error) {
                    console.error('Failed to update ephemeral message:', error);
                }
            }
        }
    } catch (error) {
        console.error(`[handleSessionReady] Failed to notify thread:`, error);
    }
}


/**
 * Handle runner status update
 */
async function handleRunnerStatusUpdate(data: any): Promise<void> {
    const { runnerId, sessionId, status, currentTool, isCommandRunning } = data;

    const previousStatus = botState.sessionStatuses.get(sessionId);
    botState.sessionStatuses.set(sessionId, status);

    const session = storage.getSession(sessionId);
    if (!session) return;

    // Detect command completion (working -> idle)
    if (previousStatus === 'working' && status === 'idle' && config.notifications.pingOnCompletion) {
        try {
            const thread = await botState.client.channels.fetch(session.threadId);
            if (thread && 'send' in thread) {
                const userMention = session.creatorId ? `<@${session.creatorId}>` : '';
                const atHere = config.notifications.useAtHere ? '@here ' : '';

                // Only ping if the command wasn't just "status" or something trivial if we could detect that
                // For now, ping on any return to idle usually means command done

                await thread.send({
                    content: `${atHere}${userMention} Command finished.`
                });
            }
        } catch (error) {
            console.error('[Status] Failed to send completion ping:', error);
        }
    }

    // TODO: Add visual status updates to thread if needed

}

/**
 * Handle session discovered (for watched terminals)
 */
async function handleSessionDiscovered(data: any): Promise<void> {
    const { runnerId, sessionId, exists, cwd } = data;

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        console.error(`[handleSessionDiscovered] Unknown runner: ${runnerId}`);
        return;
    }

    if (!exists) {
        console.log(`[handleSessionDiscovered] Session ${sessionId} does not exist on runner ${runnerId}`);
        return;
    }

    // Check if we already have this session
    const existingSession = storage.getSession(sessionId);
    if (existingSession) {
        // Check if this session was already active - if so, no need for restoration message
        const wasAlreadyActive = existingSession.status === 'active';

        console.log(`[handleSessionDiscovered] Session ${sessionId} already exists (status: ${existingSession.status}), updating CWD to: ${cwd}`);
        if (cwd) {
            existingSession.folderPath = cwd;
        }
        // Ensure status is active
        existingSession.status = 'active';
        storage.updateSession(existingSession.sessionId, existingSession);

        // Only notify if session was previously NOT active (i.e., was ended/offline and is now restored)
        // Skip notification for sessions that are already active (just created through Discord)
        if (!wasAlreadyActive && existingSession.threadId && existingSession.channelId) {
            try {
                const channel = await botState.client.channels.fetch(existingSession.channelId);
                if (channel && 'threads' in channel) {
                    const thread = await (channel as any).threads.fetch(existingSession.threadId);
                    if (thread) {
                        // Unarchive thread if needed
                        if (thread.archived) {
                            await thread.setArchived(false);
                        }

                        // Re-add the creator to the thread (they may have been removed when archived)
                        if (existingSession.creatorId) {
                            try {
                                await thread.members.add(existingSession.creatorId);
                            } catch (addErr) {
                                console.warn(`[handleSessionDiscovered] Could not add creator to thread:`, addErr);
                            }
                        }

                        const shouldPing = config.notifications.useAtHere;
                        await thread.send({
                            content: shouldPing ? '@here Session Connection Restored!' : undefined,
                            embeds: [{
                                title: 'Session Connection Restored',
                                description: `The runner agent has reconnected to this session.\nYou can continue using it.`,
                                color: 0x57F287 // Green
                            }]
                        });
                        console.log(`[handleSessionDiscovered] Notified existing thread ${existingSession.threadId} of restoration`);
                    }
                }
            } catch (err) {
                console.error(`[handleSessionDiscovered] Failed to notify existing thread:`, err);
            }
        } else if (wasAlreadyActive) {
            console.log(`[handleSessionDiscovered] Session ${sessionId} was already active, skipping restoration notification`);
        }
        return;
    }

    // Check if this is a 'discode-' session that we might already know by its short ID
    // The tmux session name format is: discode-{first8charsOfUUID}
    if (sessionId.startsWith('discode-')) {
        const shortId = sessionId.replace('discode-', '');
        const existingByShortId = storage.getSessionByShortId(shortId);

        if (existingByShortId) {
            // Check if the session was already active - skip restoration message if so
            const wasAlreadyActive = existingByShortId.status === 'active';

            console.log(`[handleSessionDiscovered] Found existing session ${existingByShortId.sessionId} for restored ${sessionId} (status: ${existingByShortId.status}). Session already tracked.`);

            // Session already exists in storage - just update status if needed
            existingByShortId.status = 'active';
            storage.updateSession(existingByShortId.sessionId, existingByShortId);

            // Only post restoration message if session was previously NOT active
            if (!wasAlreadyActive && existingByShortId.threadId && existingByShortId.channelId) {
                try {
                    const channel = await botState.client.channels.fetch(existingByShortId.channelId);
                    if (channel && 'threads' in channel) {
                        const thread = await (channel as any).threads.fetch(existingByShortId.threadId);
                        if (thread) {
                            // Unarchive thread if needed
                            if (thread.archived) {
                                await thread.setArchived(false);
                            }

                            // Re-add the creator to the thread (they may have been removed when archived)
                            if (existingByShortId.creatorId) {
                                try {
                                    await thread.members.add(existingByShortId.creatorId);
                                } catch (addErr) {
                                    console.warn(`[handleSessionDiscovered] Could not add creator to thread:`, addErr);
                                }
                            }

                            const shouldPing = config.notifications.useAtHere;
                            await thread.send({
                                content: shouldPing ? '@here Session Connection Restored!' : undefined,
                                embeds: [{
                                    title: 'Session Connection Restored',
                                    description: `The runner agent has reconnected to this session.\nYou can continue using it.`,
                                    color: 0x57F287 // Green
                                }]
                            });
                            console.log(`[handleSessionDiscovered] Notified existing thread ${existingByShortId.threadId} of restoration`);
                        }
                    }
                } catch (error) {
                    console.error(`[handleSessionDiscovered] Failed to notify thread:`, error);
                }
            } else if (wasAlreadyActive) {
                console.log(`[handleSessionDiscovered] Session ${existingByShortId.sessionId} was already active, skipping restoration notification`);
            }

            return;
        }
    }

    console.log(`[handleSessionDiscovered] New session discovered: ${sessionId} (CWD: ${cwd || 'unknown'})`);
    // Session discovered but not tracked - create new session tracking
    console.log(`[handleSessionDiscovered] Discovered orphaned session ${sessionId} on runner ${runnerId}`);

    // We don't know the creator ID or original CLI type since it's an orphan
    // Default to the runner owner and 'generic' CLI
    const ownerId = runner.ownerId;
    if (!ownerId) return;

    // Use a default folder if CWD is unknown
    const folderPath = cwd || runner.defaultWorkspace || '.';

    // Create session structure
    const session: Session = {
        sessionId: sessionId,
        runnerId: runner.runnerId,
        channelId: runner.privateChannelId || '',
        threadId: '', // Will create below
        createdAt: new Date().toISOString(),
        status: 'active',
        cliType: 'generic', // Best guess
        folderPath: folderPath,
    };

    try {
        // Need to find the channel
        let channelId = runner.privateChannelId;
        if (!channelId) {
            // Try to recover channel
            // This requires an interaction or knowing the guild... 
            // If we don't have the channel ID, we can't really restore it easily without more info
            console.error(`[handleSessionDiscovered] Cannot restore session ${sessionId}: runner has no private channel`);
            return;
        }

        const channel = await botState.client.channels.fetch(channelId);
        if (!channel || !('threads' in channel)) {
            console.error(`[handleSessionDiscovered] Cannot restore session ${sessionId}: invalid channel`);
            return;
        }

        const textChannel = channel as any; // Cast to TextChannel

        // Create a new thread for this restored session
        const thread = await textChannel.threads.create({
            name: `${session.cliType.toUpperCase()}-${Date.now()}`, // Use CLI type for consistent naming
            type: 12, // PrivateThread
            invitable: false,
            reason: `Restored session ${sessionId}`
        });

        session.threadId = thread.id;
        session.channelId = channel.id;

        // Save session
        storage.createSession(session);
        botState.actionItems.set(session.sessionId, []);

        // Add owner
        await thread.members.add(ownerId);

        console.log(`[handleSessionDiscovered] Restored session ${sessionId} to thread ${thread.id}`);

        // Notify
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Session Restored')
            .setDescription(`Found existing session \`${sessionId}\` on runner. Reconnected!`)
            .addFields(
                { name: 'Working Directory', value: `\`${folderPath}\``, inline: true },
                { name: 'Note', value: 'This session was recovered from the runner.', inline: false }
            )
            .setTimestamp();

        await thread.send({ content: `<@${ownerId}>`, embeds: [embed] });

    } catch (error) {
        console.error(`[handleSessionDiscovered] Failed to restore session:`, error);
    }

    // Auto-watch the session
    // This ensures we start receiving output immediately
    try {
        console.log(`[handleSessionDiscovered] Attempting to auto-watch session ${sessionId} on runner ${runnerId}`);
        const ws = botState.runnerConnections.get(runnerId);
        if (ws) {
            console.log(`[handleSessionDiscovered] Sending watch_terminal request for ${sessionId}`);
            ws.send(JSON.stringify({
                type: 'watch_terminal',
                data: {
                    sessionId: sessionId,
                    runnerId: runnerId
                }
            }));
        } else {
            console.warn(`[handleSessionDiscovered] No WebSocket connection for runner ${runnerId}, cannot auto-watch`);
        }
    } catch (error) {
        console.error(`[handleSessionDiscovered] Failed to auto-watch session:`, error);
    }
}



/**
 * Handle terminal list response
 */
async function handleTerminalList(data: any): Promise<void> {
    const { runnerId, terminals } = data;


    // Find the pending request for this runner
    const pendingRequest = botState.pendingTerminalListRequests.get(runnerId);
    if (!pendingRequest) {
        console.log(`[handleTerminalList] No pending request for runner ${runnerId}`);
        return;
    }

    // Remove from pending
    botState.pendingTerminalListRequests.delete(runnerId);

    try {
        const webhook = new WebhookClient({
            id: pendingRequest.applicationId,
            token: pendingRequest.interactionToken
        });

        if (!terminals || terminals.length === 0) {
            await webhook.editMessage('@original', {
                content: `📺 **Terminal List for \`${pendingRequest.runnerName}\`**\n\nNo active terminals found.`
            });
        } else {
            const terminalList = terminals.map((t: string) => `• \`${t}\``).join('\n');
            await webhook.editMessage('@original', {
                content: `📺 **Terminal List for \`${pendingRequest.runnerName}\`**\n\n${terminalList}\n\n_Use \`/watch session:<name>\` to connect to a terminal._`
            });
        }


    } catch (error) {
        console.error(`[handleTerminalList] Failed to update response:`, error);
    }
}

/**
 * Handle discord actions triggered from CLI skills
 */
async function handleDiscordAction(data: any): Promise<void> {
    const { action, sessionId, content, name, description } = data;


    const session = storage.getSession(sessionId);
    if (!session) {
        console.error(`[DiscordAction] Session not found: ${sessionId}`);
        return;
    }

    const thread = await botState.client.channels.fetch(session.threadId);
    if (!thread || !('send' in thread)) {
        console.error(`[DiscordAction] Thread not found or invalid: ${session.threadId}`);
        return;
    }

    try {
        if (action === 'send_message') {
            const { embeds, files } = data;

            // Process files if present
            const messageFiles = [];
            if (files && Array.isArray(files)) {
                for (const f of files) {
                    if (f.name && f.content) {
                        messageFiles.push({
                            attachment: Buffer.from(f.content, 'base64'),
                            name: f.name
                        });
                    }
                }
            }

            await thread.send({ content, embeds, files: messageFiles.length > 0 ? messageFiles : undefined });
        } else if (action === 'update_channel') {
            console.log(`[DiscordAction] Updating channel ${session.threadId} with name: "${name}"`);

            // Update thread name
            if (name) {
                // Thread names must be 1-100 chars
                const safeName = name.substring(0, 100);
                if ('setName' in thread) {
                    try {
                        await (thread as any).setName(safeName);
                        console.log(`[DiscordAction] Channel renamed to: ${safeName}`);
                    } catch (err: any) {
                        console.error(`[DiscordAction] Failed to rename channel:`, err);
                        // If it's a rate limit error, notify user
                        if (err.code === 20016) { // Slowmode/Rate limit
                            await thread.send({
                                content: `⚠️ Could not rename channel: Rate limited. Please wait a few minutes.`
                            });
                        }
                    }
                } else {
                    console.warn(`[DiscordAction] Channel ${session.threadId} does not support setName`);
                }
            }
            // Update thread description (send as message)
            if (description) {
                await thread.send({
                    embeds: [{
                        title: 'Session Goal Update',
                        description: description,
                        color: 0x3498db
                    }]
                });
            }
        }
    } catch (error) {
        console.error(`[DiscordAction] Failed to execute action ${action}:`, error);
        await thread.send({
            content: `⚠️ Failed to execute skill action: ${error instanceof Error ? error.message : String(error)}`
        });
    }
}

/**
 * Handle assistant output from runner
 * Displays CLI output in the runner's main channel
 */
async function handleAssistantOutput(data: any): Promise<void> {
    const { runnerId, content, outputType, timestamp } = data;

    const runner = storage.getRunner(runnerId);
    if (!runner || !runner.privateChannelId) {
        console.error(`[AssistantOutput] Runner not found or no private channel: ${runnerId}`);
        return;
    }

    const channel = await botState.client.channels.fetch(runner.privateChannelId);
    if (!channel || !('send' in channel)) {
        console.error(`[AssistantOutput] Channel not found or invalid: ${runner.privateChannelId}`);
        return;
    }

    const now = Date.now();
    const STREAMING_TIMEOUT = 10000;

    const streaming = botState.assistantStreamingMessages.get(runnerId);
    const shouldStream = streaming &&
        (now - streaming.lastUpdateTime) < STREAMING_TIMEOUT &&
        streaming.outputType === (outputType || 'stdout');

    // Create embed for output
    const embed = createOutputEmbed(outputType || 'stdout', content);

    if (shouldStream) {
        try {
            // Edit the existing streaming message
            const message = await (channel as any).messages.fetch(streaming.messageId);
            await message.edit({ embeds: [embed] });

            botState.assistantStreamingMessages.set(runnerId, {
                messageId: streaming.messageId,
                lastUpdateTime: now,
                content: content,
                outputType: outputType || 'stdout'
            });
        } catch (error) {
            // If editing fails, send a new message
            console.error('[AssistantOutput] Error editing message:', error);
            const newMessage = await channel.send({ embeds: [embed] });
            botState.assistantStreamingMessages.set(runnerId, {
                messageId: newMessage.id,
                lastUpdateTime: now,
                content: content,
                outputType: outputType || 'stdout'
            });
        }
    } else {
        // Send a new message
        const sentMessage = await channel.send({ embeds: [embed] });
        botState.assistantStreamingMessages.set(runnerId, {
            messageId: sentMessage.id,
            lastUpdateTime: now,
            content: content,
            outputType: outputType || 'stdout'
        });
    }
}

/**
 * Handle spawn thread request from assistant
 * Creates a new session and Discord thread
 */
async function handleSpawnThread(ws: any, data: any): Promise<void> {
    const { runnerId, folder, cliType, initialMessage } = data;

    console.log(`[SpawnThread] Received request from runner ${runnerId}`);
    console.log(`[SpawnThread] Folder: ${folder}, CLI: ${cliType}`);

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        console.error(`[SpawnThread] Unknown runner: ${runnerId}`);
        return;
    }

    if (!runner.privateChannelId) {
        console.error(`[SpawnThread] Runner has no private channel: ${runnerId}`);
        return;
    }

    // Determine CLI type
    let resolvedCliType: 'claude' | 'gemini' =
        cliType === 'auto' || !cliType
            ? runner.cliTypes[0]
            : cliType;

    if (!runner.cliTypes.includes(resolvedCliType)) {
        console.error(`[SpawnThread] CLI type '${resolvedCliType}' not available on runner`);
        resolvedCliType = runner.cliTypes[0];
    }

    try {
        // Get the private channel
        const channel = await botState.client.channels.fetch(runner.privateChannelId);
        if (!channel || !('threads' in channel)) {
            console.error(`[SpawnThread] Invalid channel: ${runner.privateChannelId}`);
            return;
        }

        // Generate session ID
        const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

        // Create Discord thread
        const folderName = folder.split('/').pop() || 'project';
        const threadName = `${resolvedCliType}-${folderName}`.substring(0, 100);

        const thread = await (channel as any).threads.create({
            name: threadName,
            autoArchiveDuration: 1440, // 24 hours
            reason: 'Spawned by assistant'
        });

        console.log(`[SpawnThread] Created thread ${thread.id}: ${threadName}`);

        // Create session record
        const session: Session = {
            sessionId,
            runnerId: runner.runnerId,
            channelId: runner.privateChannelId,
            threadId: thread.id,
            createdAt: new Date().toISOString(),
            status: 'active',
            cliType: resolvedCliType,
            folderPath: folder,
            creatorId: runner.ownerId
        };

        storage.createSession(session);

        // Send session_start to runner
        ws.send(JSON.stringify({
            type: 'session_start',
            data: {
                sessionId,
                runnerId: runner.runnerId,
                cliType: resolvedCliType,
                plugin: 'tmux',
                folderPath: folder,
                create: true
            }
        }));

        // Send initial message if provided
        if (initialMessage) {
            // Wait a bit for the session to start
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'user_message',
                    data: {
                        sessionId,
                        userId: 'assistant',
                        username: 'Assistant',
                        content: initialMessage,
                        timestamp: new Date().toISOString()
                    }
                }));
            }, 2000);
        }

        // Notify in the thread
        await thread.send({
            embeds: [{
                color: 0x00FF00,
                title: '🧵 Thread Spawned by Assistant',
                description: `The main assistant spawned this dedicated thread for:\n\`${folder}\``,
                fields: [
                    { name: 'CLI', value: resolvedCliType, inline: true },
                    { name: 'Session ID', value: sessionId.slice(0, 8), inline: true }
                ],
                timestamp: new Date().toISOString()
            }]
        });

        console.log(`[SpawnThread] Session ${sessionId} created successfully`);

    } catch (error) {
        console.error('[SpawnThread] Error creating thread:', error);
    }
}

// Export action items for external access
export { botState };



