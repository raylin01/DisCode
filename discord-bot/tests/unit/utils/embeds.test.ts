import { describe, it, expect, beforeEach } from 'vitest';
import {
    createToolUseEmbed,
    createOutputEmbed,
    createActionItemEmbed,
    createSessionStartEmbed,
    createApprovalDecisionEmbed,
    createRunnerOfflineEmbed,
    createRunnerOnlineEmbed,
    createSessionInactiveEmbed,
    createInfoEmbed,
    createErrorEmbed,
    createSuccessEmbed,
    createSendPromptButton,
    createCommandRunningEmbed,
    createExecutionCompleteEmbed,
    createSessionDiscoveredEmbed,
    createSessionReactivatedEmbed
} from '../../../src/utils/embeds';
import type { RunnerInfo, Session } from '../../../shared/types.ts';

describe('Embeds Utils', () => {
    describe('createToolUseEmbed', () => {
        let mockRunner: RunnerInfo;

        beforeEach(() => {
            mockRunner = {
                runnerId: 'runner-123',
                name: 'test-runner',
                ownerId: 'user-1',
                token: 'token-abc',
                status: 'online',
                lastHeartbeat: new Date().toISOString(),
                authorizedUsers: ['user-1'],
                cliTypes: ['claude']
            };
        });

        it('should create embed with correct structure', () => {
            const embed = createToolUseEmbed(mockRunner, 'bash', { command: 'ls' });

            expect(embed.data).toMatchObject({
                color: 0xFFD700, // WARNING color
                title: 'Tool Use Approval Required'
            });
            expect(embed.data.fields?.length).toBe(3);
        });

        it('should include runner name field', () => {
            const embed = createToolUseEmbed(mockRunner, 'bash', { command: 'ls' });

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Runner',
                value: '`test-runner`',
                inline: true
            });
        });

        it('should include tool name field', () => {
            const embed = createToolUseEmbed(mockRunner, 'bash', { command: 'ls' });

            expect(embed.data.fields?.[1]).toMatchObject({
                name: 'Tool',
                value: '`bash`',
                inline: true
            });
        });

        it('should include tool input as JSON code block', () => {
            const embed = createToolUseEmbed(mockRunner, 'bash', { command: 'ls', args: ['-la'] });

            expect(embed.data.fields?.[2]).toMatchObject({
                name: 'Input',
                value: expect.stringContaining('```json'),
                inline: false
            });
        });

        it('should truncate long tool input to 1000 characters', () => {
            const longInput = { data: 'x'.repeat(2000) };
            const embed = createToolUseEmbed(mockRunner, 'bash', longInput);

            const inputField = embed.data.fields?.[2];
            expect(inputField?.value.length).toBeLessThanOrEqual(1000 + 20); // 1000 + markdown wrapper
        });

        it('should include timestamp', () => {
            const embed = createToolUseEmbed(mockRunner, 'bash', { command: 'ls' });

            expect(embed.data.timestamp).toBeTruthy();
        });

        it('should include runner ID in footer', () => {
            const embed = createToolUseEmbed(mockRunner, 'bash', { command: 'ls' });

            expect(embed.data.footer?.text).toBe('Runner ID: runner-123');
        });
    });

    describe('createOutputEmbed', () => {
        it('should create stdout embed with correct color and title', () => {
            const embed = createOutputEmbed('stdout', 'output here');

            expect(embed.data.color).toBe(0x2B2D31); // DARK color
            expect(embed.data.title).toBe('CLI Output');
        });

        it('should create stderr embed with correct color and title', () => {
            const embed = createOutputEmbed('stderr', 'error here');

            expect(embed.data.color).toBe(0xFF6600); // ORANGE color
            expect(embed.data.title).toBe('Error Output');
        });

        it('should create tool_use embed with correct color and title', () => {
            const embed = createOutputEmbed('tool_use', 'tool request');

            expect(embed.data.color).toBe(0xFFD700); // WARNING color
            expect(embed.data.title).toBe('Tool Request');
        });

        it('should create tool_result embed with correct color and title', () => {
            const embed = createOutputEmbed('tool_result', 'tool result');

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
            expect(embed.data.title).toBe('Tool Result');
        });

        it('should create error embed with correct color and title', () => {
            const embed = createOutputEmbed('error', 'system error');

            expect(embed.data.color).toBe(0xFF0000); // ERROR color
            expect(embed.data.title).toBe('System Error');
        });

        it('should use uppercase title for unknown output types', () => {
            const embed = createOutputEmbed('unknown_type', 'content');

            expect(embed.data.title).toBe('UNKNOWN_TYPE');
            expect(embed.data.color).toBe(0x2B2D31); // Default DARK color
        });

        it('should include content as description', () => {
            const embed = createOutputEmbed('stdout', 'test output');

            expect(embed.data.description).toBe('test output');
        });

        it('should truncate long content to 4096 characters', () => {
            const longContent = 'x'.repeat(5000);
            const embed = createOutputEmbed('stdout', longContent);

            expect(embed.data.description?.length).toBe(4096);
        });

        it('should include timestamp', () => {
            const embed = createOutputEmbed('stdout', 'output');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createActionItemEmbed', () => {
        it('should create embed with warning color', () => {
            const embed = createActionItemEmbed('Test action item');

            expect(embed.data.color).toBe(0xFFD700); // WARNING color
        });

        it('should create embed with correct title', () => {
            const embed = createActionItemEmbed('Test action item');

            expect(embed.data.title).toBe('Action Item Detected');
        });

        it('should include action item as description', () => {
            const embed = createActionItemEmbed('Do this thing');

            expect(embed.data.description).toBe('Do this thing');
        });

        it('should include timestamp', () => {
            const embed = createActionItemEmbed('Test');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createSessionStartEmbed', () => {
        let mockRunner: RunnerInfo;
        let mockSession: Session;

        beforeEach(() => {
            mockRunner = {
                runnerId: 'runner-123',
                name: 'test-runner',
                ownerId: 'user-1',
                token: 'token-abc',
                status: 'online',
                lastHeartbeat: new Date().toISOString(),
                authorizedUsers: ['user-1'],
                cliTypes: ['claude']
            };
            mockSession = {
                sessionId: 'session-456',
                runnerId: 'runner-123',
                cliType: 'claude',
                folderPath: '/home/user/project',
                channelId: 'channel-1',
                threadId: 'thread-1',
                createdAt: new Date().toISOString(),
                status: 'active'
            };
        });

        it('should create embed with success color', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
        });

        it('should create embed with correct title', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.title).toBe('Session Started');
        });

        it('should include runner name field', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Runner',
                value: '`test-runner`',
                inline: true
            });
        });

        it('should include CLI type field', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[1]).toMatchObject({
                name: 'CLI',
                value: 'CLAUDE',
                inline: true
            });
        });

        it('should include session ID field', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[2]).toMatchObject({
                name: 'Session ID',
                value: '`session-456`',
                inline: false
            });
        });

        it('should include working folder when provided', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[3]).toMatchObject({
                name: 'Working Folder',
                value: expect.stringContaining('/home/user/project'),
                inline: false
            });
        });

        it('should not include working folder when not provided', () => {
            const sessionWithoutFolder = { ...mockSession, folderPath: undefined };
            const embed = createSessionStartEmbed(mockRunner, sessionWithoutFolder);

            const folderField = embed.data.fields?.find(f => f.name === 'Working Folder');
            expect(folderField).toBeUndefined();
        });

        it('should include timestamp', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.timestamp).toBeTruthy();
        });

        it('should include footer text', () => {
            const embed = createSessionStartEmbed(mockRunner, mockSession);

            expect(embed.data.footer?.text).toBe('Type your prompt to start using the CLI');
        });
    });

    describe('createApprovalDecisionEmbed', () => {
        it('should create allowed embed with success color', () => {
            const embed = createApprovalDecisionEmbed(true, 'bash', 'user1');

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
            expect(embed.data.title).toBe('✅ Allowed');
        });

        it('should create denied embed with error color', () => {
            const embed = createApprovalDecisionEmbed(false, 'bash', 'user1');

            expect(embed.data.color).toBe(0xFF0000); // ERROR color
            expect(embed.data.title).toBe('❌ Denied');
        });

        it('should include description without detail', () => {
            const embed = createApprovalDecisionEmbed(true, 'bash', 'user1');

            expect(embed.data.description).toBe('Tool `bash` was allowed by user1');
        });

        it('should include description with detail', () => {
            const embed = createApprovalDecisionEmbed(true, 'bash', 'user1', 'Always allow');

            expect(embed.data.description).toBe('Tool `bash` was allowed by user1\n\n**Choice:** Always allow');
        });

        it('should format denied decision with detail', () => {
            const embed = createApprovalDecisionEmbed(false, 'bash', 'user1', 'Block this tool');

            expect(embed.data.description).toBe('Tool `bash` was denied by user1\n\n**Choice:** Block this tool');
        });

        it('should include timestamp', () => {
            const embed = createApprovalDecisionEmbed(true, 'bash', 'user1');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createRunnerOfflineEmbed', () => {
        let mockRunner: RunnerInfo;

        beforeEach(() => {
            mockRunner = {
                runnerId: 'runner-123',
                name: 'test-runner',
                ownerId: 'user-1',
                token: 'token-abc',
                status: 'offline',
                lastHeartbeat: new Date().toISOString(),
                authorizedUsers: ['user-1'],
                cliTypes: ['claude']
            };
        });

        it('should create embed with error color', () => {
            const embed = createRunnerOfflineEmbed(mockRunner);

            expect(embed.data.color).toBe(0xFF0000); // ERROR color
        });

        it('should create embed with correct title', () => {
            const embed = createRunnerOfflineEmbed(mockRunner);

            expect(embed.data.title).toBe('Runner Offline');
        });

        it('should include runner name in description', () => {
            const embed = createRunnerOfflineEmbed(mockRunner);

            expect(embed.data.description).toContain('test-runner');
        });

        it('should include runner ID field', () => {
            const embed = createRunnerOfflineEmbed(mockRunner);

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Runner ID',
                value: '`runner-123`',
                inline: true
            });
        });

        it('should include last seen field with formatted date', () => {
            const heartbeat = new Date('2025-01-21T10:30:00Z');
            mockRunner.lastHeartbeat = heartbeat.toISOString();
            const embed = createRunnerOfflineEmbed(mockRunner);

            expect(embed.data.fields?.[1]).toMatchObject({
                name: 'Last Seen',
                value: expect.any(String),
                inline: true
            });
        });

        it('should include timestamp', () => {
            const embed = createRunnerOfflineEmbed(mockRunner);

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createRunnerOnlineEmbed', () => {
        let mockRunner: RunnerInfo;

        beforeEach(() => {
            mockRunner = {
                runnerId: 'runner-123',
                name: 'test-runner',
                ownerId: 'user-1',
                token: 'token-abc',
                status: 'online',
                lastHeartbeat: new Date().toISOString(),
                authorizedUsers: ['user-1'],
                cliTypes: ['claude', 'gemini']
            };
        });

        it('should create embed with success color', () => {
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
        });

        it('should create embed with correct title', () => {
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.title).toBe('🟢 Runner Online');
        });

        it('should include runner name in description', () => {
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.description).toContain('test-runner');
        });

        it('should include status field', () => {
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Status',
                value: '🟢 Online',
                inline: true
            });
        });

        it('should include CLI types field', () => {
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.fields?.[1]).toMatchObject({
                name: 'CLI Types',
                value: 'claude, gemini',
                inline: true
            });
        });

        it('should show N/A when no CLI types', () => {
            mockRunner.cliTypes = [];
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.fields?.[1]).toMatchObject({
                name: 'CLI Types',
                value: 'N/A',
                inline: true
            });
        });

        it('should include reclamation note when wasReclaimed is true', () => {
            const embed = createRunnerOnlineEmbed(mockRunner, true);

            const noteField = embed.data.fields?.find(f => f.name === 'Note');
            expect(noteField).toMatchObject({
                name: 'Note',
                value: 'Runner was restarted and reclaimed from previous offline state.',
                inline: false
            });
        });

        it('should not include reclamation note when wasReclaimed is false', () => {
            const embed = createRunnerOnlineEmbed(mockRunner, false);

            const noteField = embed.data.fields?.find(f => f.name === 'Note');
            expect(noteField).toBeUndefined();
        });

        it('should include timestamp', () => {
            const embed = createRunnerOnlineEmbed(mockRunner);

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createSessionInactiveEmbed', () => {
        let mockRunner: RunnerInfo;
        let mockSession: Session;

        beforeEach(() => {
            mockRunner = {
                runnerId: 'runner-123',
                name: 'test-runner',
                ownerId: 'user-1',
                token: 'token-abc',
                status: 'offline',
                lastHeartbeat: new Date().toISOString(),
                authorizedUsers: ['user-1'],
                cliTypes: ['claude']
            };
            mockSession = {
                sessionId: 'session-456',
                runnerId: 'runner-123',
                cliType: 'claude',
                channelId: 'channel-1',
                threadId: 'thread-1',
                createdAt: new Date().toISOString(),
                status: 'active'
            };
        });

        it('should create embed with orange color', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.color).toBe(0xFF6600); // ORANGE color
        });

        it('should create embed with correct title', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.title).toBe('Session Inactive - Runner Offline');
        });

        it('should include runner name in description', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.description).toContain('test-runner');
        });

        it('should include runner status field', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Runner Status',
                value: '🔴 Offline',
                inline: true
            });
        });

        it('should include session ID field', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[1]).toMatchObject({
                name: 'Session ID',
                value: '`session-456`',
                inline: true
            });
        });

        it('should include CLI type field', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.fields?.[2]).toMatchObject({
                name: 'CLI Type',
                value: 'CLAUDE',
                inline: true
            });
        });

        it('should include timestamp', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.timestamp).toBeTruthy();
        });

        it('should include footer text', () => {
            const embed = createSessionInactiveEmbed(mockRunner, mockSession);

            expect(embed.data.footer?.text).toBe('The Runner Agent needs to be restarted to resume this session');
        });
    });

    describe('createInfoEmbed', () => {
        it('should create embed with info color', () => {
            const embed = createInfoEmbed('Info Title', 'Info description');

            expect(embed.data.color).toBe(0x0099FF); // INFO color
        });

        it('should set title', () => {
            const embed = createInfoEmbed('Test Title', 'Test description');

            expect(embed.data.title).toBe('Test Title');
        });

        it('should set description', () => {
            const embed = createInfoEmbed('Test Title', 'Test description');

            expect(embed.data.description).toBe('Test description');
        });

        it('should include timestamp', () => {
            const embed = createInfoEmbed('Test', 'description');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createErrorEmbed', () => {
        it('should create embed with error color', () => {
            const embed = createErrorEmbed('Error Title', 'Error description');

            expect(embed.data.color).toBe(0xFF0000); // ERROR color
        });

        it('should set title', () => {
            const embed = createErrorEmbed('Test Title', 'Test description');

            expect(embed.data.title).toBe('Test Title');
        });

        it('should set description', () => {
            const embed = createErrorEmbed('Test Title', 'Test description');

            expect(embed.data.description).toBe('Test description');
        });

        it('should include timestamp', () => {
            const embed = createErrorEmbed('Test', 'description');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createSuccessEmbed', () => {
        it('should create embed with success color', () => {
            const embed = createSuccessEmbed('Success Title', 'Success description');

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
        });

        it('should set title', () => {
            const embed = createSuccessEmbed('Test Title', 'Test description');

            expect(embed.data.title).toBe('Test Title');
        });

        it('should set description', () => {
            const embed = createSuccessEmbed('Test Title', 'Test description');

            expect(embed.data.description).toBe('Test description');
        });

        it('should include timestamp', () => {
            const embed = createSuccessEmbed('Test', 'description');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createSendPromptButton', () => {
        it('should create action row with button', () => {
            const actionRow = createSendPromptButton('session-123');

            expect(actionRow).toHaveProperty('components');
        });

        it('should create button with primary style', () => {
            const actionRow = createSendPromptButton('session-123');
            const button = actionRow.components[0];

            expect(button.data.style).toBe(1); // ButtonStyle.Primary
        });

        it('should set button label', () => {
            const actionRow = createSendPromptButton('session-123');
            const button = actionRow.components[0];

            expect(button.data.label).toBe('Send Prompt');
        });

        it('should set custom ID with session ID', () => {
            const actionRow = createSendPromptButton('session-123');
            const button = actionRow.components[0];

            expect(button.data.custom_id).toBe('prompt_session-123');
        });

        it('should set emoji', () => {
            const actionRow = createSendPromptButton('session-123');
            const button = actionRow.components[0];

            expect(button.data.emoji?.name).toBe('💬');
        });
    });

    describe('createCommandRunningEmbed', () => {
        it('should create embed with orange color', () => {
            const embed = createCommandRunningEmbed();

            expect(embed.data.color).toBe(0xFF6600); // ORANGE color
        });

        it('should create embed with correct title', () => {
            const embed = createCommandRunningEmbed();

            expect(embed.data.title).toBe('Command Running');
        });

        it('should set description', () => {
            const embed = createCommandRunningEmbed();

            expect(embed.data.description).toBe('A command is executing in the terminal...');
        });

        it('should include timestamp', () => {
            const embed = createCommandRunningEmbed();

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createExecutionCompleteEmbed', () => {
        it('should create embed with success color', () => {
            const embed = createExecutionCompleteEmbed();

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
        });

        it('should create embed with correct title', () => {
            const embed = createExecutionCompleteEmbed();

            expect(embed.data.title).toBe('Execution Complete');
        });

        it('should set description', () => {
            const embed = createExecutionCompleteEmbed();

            expect(embed.data.description).toBe('Ready for next command.');
        });

        it('should include timestamp', () => {
            const embed = createExecutionCompleteEmbed();

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createSessionDiscoveredEmbed', () => {
        it('should create embed with blurple color', () => {
            const embed = createSessionDiscoveredEmbed('session-123');

            expect(embed.data.color).toBe(0x5865F2); // BLURPLE color
        });

        it('should create embed with correct title', () => {
            const embed = createSessionDiscoveredEmbed('session-123');

            expect(embed.data.title).toBe('Session Discovered');
        });

        it('should include session ID in description', () => {
            const embed = createSessionDiscoveredEmbed('session-123');

            expect(embed.data.description).toContain('session-123');
        });

        it('should include working directory when provided', () => {
            const embed = createSessionDiscoveredEmbed('session-123', '/home/user/project');

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Working Directory',
                value: '`/home/user/project`',
                inline: false
            });
        });

        it('should not include working directory when not provided', () => {
            const embed = createSessionDiscoveredEmbed('session-123');

            const cwdField = embed.data.fields?.find(f => f.name === 'Working Directory');
            expect(cwdField).toBeUndefined();
        });

        it('should include timestamp', () => {
            const embed = createSessionDiscoveredEmbed('session-123');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });

    describe('createSessionReactivatedEmbed', () => {
        it('should create embed with success color', () => {
            const embed = createSessionReactivatedEmbed('session-123');

            expect(embed.data.color).toBe(0x00FF00); // SUCCESS color
        });

        it('should create embed with correct title', () => {
            const embed = createSessionReactivatedEmbed('session-123');

            expect(embed.data.title).toBe('Session Reactivated');
        });

        it('should include session ID in description', () => {
            const embed = createSessionReactivatedEmbed('session-123');

            expect(embed.data.description).toContain('session-123');
        });

        it('should include working directory when provided', () => {
            const embed = createSessionReactivatedEmbed('session-123', '/home/user/project');

            expect(embed.data.fields?.[0]).toMatchObject({
                name: 'Working Directory',
                value: '`/home/user/project`',
                inline: false
            });
        });

        it('should not include working directory when not provided', () => {
            const embed = createSessionReactivatedEmbed('session-123');

            const cwdField = embed.data.fields?.find(f => f.name === 'Working Directory');
            expect(cwdField).toBeUndefined();
        });

        it('should include timestamp', () => {
            const embed = createSessionReactivatedEmbed('session-123');

            expect(embed.data.timestamp).toBeTruthy();
        });
    });
});
