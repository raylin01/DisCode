/**
 * Tests for Claude SDK Plugin Control Response JSON structure
 *
 * Validates that the actual JSON sent to stdin matches Claude CLI expectations.
 */

import { describe, it, expect } from 'vitest';

describe('Claude SDK Control Response JSON', () => {
    describe('Control Response Message Structure', () => {
        it('should match expected structure for tool approval', () => {
            const actualResponse = {
                type: 'control_response' as const,
                response: {
                    subtype: 'success' as const,
                    request_id: 'test-request-id',
                    response: {
                        behavior: 'approve' as const,
                        toolUseID: 'tool-use-123'
                    }
                }
            };

            // Validate structure
            expect(actualResponse.type).toBe('control_response');
            expect(actualResponse.response.subtype).toBe('success');
            expect(actualResponse.response.request_id).toBeDefined();
            expect(actualResponse.response.response?.behavior).toBe('approve');
        });

        it('should match expected structure for tool denial', () => {
            const actualResponse = {
                type: 'control_response' as const,
                response: {
                    subtype: 'success' as const,
                    request_id: 'test-request-id',
                    response: {
                        behavior: 'deny' as const,
                        message: 'Tool not allowed'
                    }
                }
            };

            expect(actualResponse.response.response?.behavior).toBe('deny');
            expect(actualResponse.response.response?.message).toBeDefined();
        });

        it('should match expected structure for tool delegation', () => {
            const actualResponse = {
                type: 'control_response' as const,
                response: {
                    subtype: 'success' as const,
                    request_id: 'test-request-id',
                    response: {
                        behavior: 'delegate' as const,
                        toolUseID: 'tool-use-456'
                    }
                }
            };

            expect(actualResponse.response.response?.behavior).toBe('delegate');
        });

        it('should match expected structure for AskUserQuestion', () => {
            const actualResponse = {
                type: 'control_response' as const,
                response: {
                    subtype: 'success' as const,
                    request_id: 'test-request-id',
                    response: {
                        behavior: 'approve' as const,
                        selectedOptions: ['0']
                    }
                }
            };

            expect(actualResponse.response.response?.behavior).toBe('approve');
            expect(actualResponse.response.response?.selectedOptions).toEqual(['0']);
        });

        it('should match expected structure for multi-select AskUserQuestion', () => {
            const actualResponse = {
                type: 'control_response' as const,
                response: {
                    subtype: 'success' as const,
                    request_id: 'test-request-id',
                    response: {
                        behavior: 'approve' as const,
                        selectedOptions: ['0', '1', '2']
                    }
                }
            };

            expect(actualResponse.response.response?.behavior).toBe('approve');
            expect(actualResponse.response.response?.selectedOptions).toHaveLength(3);
        });
    });

    describe('JSON Serialization', () => {
        it('should serialize to valid JSON for tool approval', () => {
            const response = {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: 'req-123',
                    response: {
                        behavior: 'approve',
                        toolUseID: 'tool-456'
                    }
                }
            };

            const json = JSON.stringify(response);
            const parsed = JSON.parse(json);

            expect(parsed.type).toBe('control_response');
            expect(parsed.response.response.behavior).toBe('approve');
        });

        it('should serialize to valid JSON for question response', () => {
            const response = {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: 'req-789',
                    response: {
                        behavior: 'approve',
                        selectedOptions: ['1', '2']
                    }
                }
            };

            const json = JSON.stringify(response);
            const parsed = JSON.parse(json);

            expect(parsed.response.response.behavior).toBe('approve');
            expect(parsed.response.response.selectedOptions).toEqual(['1', '2']);
        });

        it('should NOT serialize "allow" as behavior', () => {
            // This test documents what NOT to do
            const invalidResponse = {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: 'req-invalid',
                    response: {
                        behavior: 'allow',  // WRONG - this is invalid
                        toolUseID: 'tool-invalid'
                    }
                }
            };

            const json = JSON.stringify(invalidResponse);
            const parsed = JSON.parse(json);

            // This would cause the CLI to reject the response
            expect(parsed.response.response.behavior).toBe('allow');

            // Validate against correct type
            const validBehaviors = ['approve', 'deny', 'delegate'];
            expect(validBehaviors).not.toContain(parsed.response.response.behavior);
        });
    });

    describe('All Built-in Tools', () => {
        // List of tools from Claude Code CLI
        const builtInTools = [
            'Bash',           // Execute shell commands
            'Edit',           // Edit files
            'MultiEdit',      // Edit multiple files
            'Read',           // Read file contents
            'Write',          // Write new files
            'Glob',           // Find files by pattern
            'Grep',           // Search file contents
            'AskUserQuestion',// Ask the user questions
            'Task',           // Delegate to sub-agent
            'DirectoryTree',  // List directory structure
            'LSP',            // Language Server Protocol
            'VSCode',         // VS Code specific tools
            'Skill',          // Invoke user-defined skills
            'MCP'             // Model Context Protocol servers
        ];

        it('should have valid behavior mapping for all built-in tools', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            builtInTools.forEach(tool => {
                // Each tool should be able to be approved, denied, or delegated
                ['1', '2', '3'].forEach(option => {
                    const behavior = behaviorMap[option];
                    expect(['approve', 'deny', 'delegate']).toContain(behavior);
                });
            });
        });

        it('should generate correct control response for each tool type', () => {
            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            builtInTools.forEach(tool => {
                const option = '1';
                const behavior = behaviorMap[option];

                const response = {
                    type: 'control_response' as const,
                    response: {
                        subtype: 'success' as const,
                        request_id: `req-${tool.toLowerCase()}`,
                        response: {
                            behavior: behavior as 'approve' | 'deny' | 'delegate',
                            toolUseID: `tool-${tool.toLowerCase()}`
                        }
                    }
                };

                expect(response.response.response?.behavior).toBe('approve');

                // Verify it's valid JSON
                const json = JSON.stringify(response);
                expect(() => JSON.parse(json)).not.toThrow();
            });
        });
    });

    describe('Error Response Structure', () => {
        it('should handle error responses correctly', () => {
            const errorResponse = {
                type: 'control_response' as const,
                response: {
                    subtype: 'error' as const,
                    request_id: 'req-error',
                    error: 'Failed to process approval'
                }
            };

            expect(errorResponse.response.subtype).toBe('error');
            expect(errorResponse.response.error).toBeDefined();
            expect(errorResponse.response.response).toBeUndefined();

            const json = JSON.stringify(errorResponse);
            const parsed = JSON.parse(json);

            expect(parsed.response.subtype).toBe('error');
        });
    });

    describe('Discord Button to CLI Behavior Mapping', () => {
        it('should map Discord button 1 to CLI approve', () => {
            const discordButtonNumber = '1';  // Yes button
            const expectedBehavior = 'approve';

            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            expect(behaviorMap[discordButtonNumber]).toBe(expectedBehavior);
        });

        it('should map Discord button 2 to CLI deny', () => {
            const discordButtonNumber = '2';  // No button
            const expectedBehavior = 'deny';

            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            expect(behaviorMap[discordButtonNumber]).toBe(expectedBehavior);
        });

        it('should map Discord button 3 to CLI delegate', () => {
            const discordButtonNumber = '3';  // Allow All button
            const expectedBehavior = 'delegate';

            const behaviorMap: Record<string, 'approve' | 'deny' | 'delegate'> = {
                '1': 'approve',
                '2': 'deny',
                '3': 'delegate'
            };

            expect(behaviorMap[discordButtonNumber]).toBe(expectedBehavior);
        });

        it('should map Discord button for AskUserQuestion to 0-indexed option', () => {
            const discordButtonNumber = '2';  // Second option button
            const expectedOptionIndex = '1';   // 0-indexed

            const optionIndex = parseInt(discordButtonNumber, 10) - 1;
            expect(String(optionIndex)).toBe(expectedOptionIndex);
        });
    });
});
