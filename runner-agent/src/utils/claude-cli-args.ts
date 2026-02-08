import type { PluginOptions } from '../plugins/base.js';

export function buildClaudeCliArgs(options?: PluginOptions): string[] {
    const args: string[] = [];
    const opts = options || {};

    if (opts.continueConversation) {
        args.push('--continue');
    }
    if (opts.resumeSessionId) {
        args.push('--resume', opts.resumeSessionId);
    }
    if (opts.forkSession) {
        args.push('--fork-session');
    }
    if (opts.resumeSessionAt) {
        args.push('--resume-session-at', opts.resumeSessionAt);
    }
    if (opts.persistSession === false) {
        args.push('--no-session-persistence');
    }
    if (opts.maxTurns) {
        args.push('--max-turns', String(opts.maxTurns));
    }
    if (opts.maxBudgetUsd) {
        args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.fallbackModel) {
        args.push('--fallback-model', opts.fallbackModel);
    }
    if (opts.agent) {
        args.push('--agent', opts.agent);
    }
    if (opts.betas && opts.betas.length > 0) {
        args.push('--betas', opts.betas.join(','));
    }
    if (opts.jsonSchema) {
        const schemaValue = typeof opts.jsonSchema === 'string'
            ? opts.jsonSchema
            : JSON.stringify(opts.jsonSchema);
        args.push('--json-schema', schemaValue);
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowedTools', opts.allowedTools.join(','));
    }
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
        args.push('--disallowedTools', opts.disallowedTools.join(','));
    }
    if (opts.tools !== undefined) {
        if (Array.isArray(opts.tools)) {
            args.push('--tools', opts.tools.length === 0 ? '' : opts.tools.join(','));
        } else {
            args.push('--tools', 'default');
        }
    }
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    }
    if (opts.settingSources && opts.settingSources.length > 0) {
        args.push('--setting-sources', opts.settingSources.join(','));
    }
    if (opts.strictMcpConfig) {
        args.push('--strict-mcp-config');
    }
    if (opts.permissionMode) {
        args.push('--permission-mode', opts.permissionMode);
    }
    if (opts.allowDangerouslySkipPermissions || opts.skipPermissions) {
        args.push('--allow-dangerously-skip-permissions');
    }
    if (opts.includePartialMessages !== false) {
        args.push('--include-partial-messages');
    }
    if (opts.permissionPromptToolName) {
        args.push('--permission-prompt-tool', opts.permissionPromptToolName);
    } else if (opts.permissionPromptTool) {
        args.push('--permission-prompt-tool', 'stdio');
    }
    if (opts.additionalDirectories && opts.additionalDirectories.length > 0) {
        for (const dir of opts.additionalDirectories) {
            args.push('--add-dir', dir);
        }
    }
    if (opts.plugins && opts.plugins.length > 0) {
        for (const plugin of opts.plugins) {
            if (plugin.type !== 'local') {
                throw new Error(`Unsupported plugin type: ${plugin.type}`);
            }
            args.push('--plugin-dir', plugin.path);
        }
    }

    const extraArgs = { ...(opts.extraArgs || {}) } as Record<string, any>;
    if (opts.sandbox) {
        let settingsObj: Record<string, any> = { sandbox: opts.sandbox };
        if (extraArgs.settings) {
            if (typeof extraArgs.settings === 'string') {
                try {
                    settingsObj = { ...JSON.parse(extraArgs.settings), sandbox: opts.sandbox };
                } catch (err) {
                    throw new Error('Failed to parse extraArgs.settings JSON while applying sandbox.');
                }
            } else if (typeof extraArgs.settings === 'object') {
                settingsObj = { ...extraArgs.settings, sandbox: opts.sandbox };
            } else {
                throw new Error('extraArgs.settings must be a string or object when sandbox is set.');
            }
        }
        extraArgs.settings = JSON.stringify(settingsObj);
    }

    for (const [key, value] of Object.entries(extraArgs)) {
        if (value === null) {
            args.push(`--${key}`);
        } else {
            const val = typeof value === 'string' ? value : JSON.stringify(value);
            args.push(`--${key}`, val);
        }
    }

    return args;
}
