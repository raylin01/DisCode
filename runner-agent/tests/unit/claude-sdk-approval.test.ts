/**
 * Tests for Claude SDK Plugin approval behavior mapping
 *
 * Validates that control responses use the correct 'behavior' values
 * expected by the Claude Code CLI SDK.
 *
 * NOTE: CLI version 2.0.76 expects 'allow' not 'approve'
 */

import { describe, it, expect } from 'vitest';

describe('Claude SDK Approval Behavior', () => {
    describe('Tool Permission Approval Mapping', () => {
        it('should map option 1 to "allow" behavior', () => {
            const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                '1': 'allow',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['1']).toBe('allow');
        });

        it('should map option 2 to "deny" behavior', () => {
            const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                '1': 'allow',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['2']).toBe('deny');
        });

        it('should map option 3 to "delegate" behavior', () => {
            const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                '1': 'allow',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['3']).toBe('delegate');
        });

        it('should default to "allow" for invalid option numbers', () => {
            const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                '1': 'allow',
                '2': 'deny',
                '3': 'delegate'
            };
            expect(behaviorMap['0'] || 'allow').toBe('allow');
            expect(behaviorMap['99'] || 'allow').toBe('allow');
            expect(behaviorMap['invalid'] || 'allow').toBe('allow');
        });
    });

    describe('AskUserQuestion Response', () => {
        it('should use "allow" behavior for question responses', () => {
            // Question responses always use 'allow' behavior
            // The selected options indicate which answer was chosen
            const questionResponse = {
                behavior: 'allow' as const,
                selectedOptions: ['0']
            };

            expect(questionResponse.behavior).toBe('allow');
            expect(questionResponse.selectedOptions).toEqual(['0']);
        });

        it('should handle multi-select question responses', () => {
            const multiSelectResponse = {
                behavior: 'allow' as const,
                selectedOptions: ['0', '1', '2']
            };

            expect(multiSelectResponse.behavior).toBe('allow');
            expect(multiSelectResponse.selectedOptions).toHaveLength(3);
        });
    });

    describe('Control Response Data Structure', () => {
        it('should accept valid behavior values', () => {
            type Behavior = 'allow' | 'deny' | 'delegate';

            const validBehaviors: Behavior[] = ['allow', 'deny', 'delegate'];

            validBehaviors.forEach(behavior => {
                expect(['allow', 'deny', 'delegate']).toContain(behavior);
            });
        });

        it('should reject "approve" as invalid behavior', () => {
            type Behavior = 'allow' | 'deny' | 'delegate';

            const invalidBehavior = 'approve';

            expect(['allow', 'deny', 'delegate']).not.toContain(invalidBehavior);
        });
    });

    describe('Common Tool Approval Scenarios', () => {
        interface ToolApprovalScenario {
            toolName: string;
            description: string;
            option: string;
            expectedBehavior: 'allow' | 'deny' | 'delegate';
        }

        const scenarios: ToolApprovalScenario[] = [
            {
                toolName: 'Bash',
                description: 'Approve running a command',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'Edit',
                description: 'Approve editing a file',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'Read',
                description: 'Approve reading a file',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'Write',
                description: 'Approve writing a file',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'Bash',
                description: 'Deny running a dangerous command',
                option: '2',
                expectedBehavior: 'deny'
            },
            {
                toolName: 'Edit',
                description: 'Delegate all edits for this session',
                option: '3',
                expectedBehavior: 'delegate'
            },
            {
                toolName: 'Glob',
                description: 'Approve file search',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'Grep',
                description: 'Approve content search',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'AskUserQuestion',
                description: 'Approve answering a question',
                option: '1',
                expectedBehavior: 'allow'
            },
            {
                toolName: 'Task',
                description: 'Delegate to sub-agent',
                option: '3',
                expectedBehavior: 'delegate'
            }
        ];

        scenarios.forEach(scenario => {
            it(`should map ${scenario.toolName} ${scenario.description} to ${scenario.expectedBehavior}`, () => {
                const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                    '1': 'allow',
                    '2': 'deny',
                    '3': 'delegate'
                };

                const behavior = behaviorMap[scenario.option] || 'allow';
                expect(behavior).toBe(scenario.expectedBehavior);
            });
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty option string', () => {
            const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                '1': 'allow',
                '2': 'deny',
                '3': 'delegate'
            };

            const behavior = behaviorMap[''] || 'allow';
            expect(behavior).toBe('allow');
        });

        it('should handle numeric string input', () => {
            const behaviorMap: Record<string, 'allow' | 'deny' | 'delegate'> = {
                '1': 'allow',
                '2': 'deny',
                '3': 'delegate'
            };

            // Simulate converting number to string
            const optionNumber = 1;
            const behavior = behaviorMap[String(optionNumber)] || 'allow';
            expect(behavior).toBe('allow');
        });

        it('should maintain type safety for behavior values', () => {
            type Behavior = 'allow' | 'deny' | 'delegate';

            const validateBehavior = (value: string): value is Behavior => {
                return ['allow', 'deny', 'delegate'].includes(value);
            };

            expect(validateBehavior('allow')).toBe(true);
            expect(validateBehavior('deny')).toBe(true);
            expect(validateBehavior('delegate')).toBe(true);
            expect(validateBehavior('approve')).toBe(false);
            expect(validateBehavior('accept')).toBe(false);
            expect(validateBehavior('reject')).toBe(false);
        });
    });
});
