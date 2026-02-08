import type { PluginOptions } from '../plugins/base.js';

const THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high', 'auto', 'default_on']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits']);

function coerceNumber(value: any): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function coerceStringArray(value: any): string[] | undefined {
    if (Array.isArray(value)) {
        return value.map(v => String(v)).filter(Boolean);
    }
    return undefined;
}

export interface NormalizedOptionsResult {
    options: PluginOptions;
    warnings: string[];
}

export function normalizeClaudeOptions(input: PluginOptions | undefined): NormalizedOptionsResult {
    const options: PluginOptions = { ...(input || {}) };
    const warnings: string[] = [];

    if (options.thinkingLevel && !THINKING_LEVELS.has(options.thinkingLevel)) {
        warnings.push(`Invalid thinkingLevel "${options.thinkingLevel}".`);
        delete options.thinkingLevel;
    }

    if (options.permissionMode && !PERMISSION_MODES.has(options.permissionMode)) {
        warnings.push(`Invalid permissionMode "${options.permissionMode}".`);
        delete options.permissionMode;
    }

    const maxTurns = coerceNumber(options.maxTurns);
    if (options.maxTurns !== undefined) {
        if (!maxTurns || maxTurns <= 0) {
            warnings.push('Invalid maxTurns; expected positive number.');
            delete options.maxTurns;
        } else {
            options.maxTurns = Math.floor(maxTurns);
        }
    }

    const maxBudgetUsd = coerceNumber(options.maxBudgetUsd);
    if (options.maxBudgetUsd !== undefined) {
        if (!maxBudgetUsd || maxBudgetUsd <= 0) {
            warnings.push('Invalid maxBudgetUsd; expected positive number.');
            delete options.maxBudgetUsd;
        } else {
            options.maxBudgetUsd = maxBudgetUsd;
        }
    }

    const maxThinkingTokens = coerceNumber(options.maxThinkingTokens);
    if (options.maxThinkingTokens !== undefined) {
        if (!maxThinkingTokens || maxThinkingTokens <= 0) {
            warnings.push('Invalid maxThinkingTokens; expected positive number.');
            delete options.maxThinkingTokens;
        } else {
            options.maxThinkingTokens = Math.floor(maxThinkingTokens);
        }
    }

    if (options.model && typeof options.model !== 'string') {
        warnings.push('Invalid model; expected string.');
        delete options.model;
    }

    if (options.fallbackModel && typeof options.fallbackModel !== 'string') {
        warnings.push('Invalid fallbackModel; expected string.');
        delete options.fallbackModel;
    }

    if (options.model && options.fallbackModel && options.model === options.fallbackModel) {
        warnings.push('fallbackModel cannot match model.');
        delete options.fallbackModel;
    }

    if (options.agent && typeof options.agent !== 'string') {
        warnings.push('Invalid agent; expected string.');
        delete options.agent;
    }

    if (options.includePartialMessages !== undefined && typeof options.includePartialMessages !== 'boolean') {
        warnings.push('Invalid includePartialMessages; expected boolean.');
        delete options.includePartialMessages;
    }

    if (options.permissionPromptTool !== undefined && typeof options.permissionPromptTool !== 'boolean') {
        warnings.push('Invalid permissionPromptTool; expected boolean.');
        delete options.permissionPromptTool;
    }

    if (options.permissionPromptToolName !== undefined && typeof options.permissionPromptToolName !== 'string') {
        warnings.push('Invalid permissionPromptToolName; expected string.');
        delete options.permissionPromptToolName;
    }

    if (options.allowDangerouslySkipPermissions !== undefined && typeof options.allowDangerouslySkipPermissions !== 'boolean') {
        warnings.push('Invalid allowDangerouslySkipPermissions; expected boolean.');
        delete options.allowDangerouslySkipPermissions;
    }

    if (options.persistSession !== undefined && typeof options.persistSession !== 'boolean') {
        warnings.push('Invalid persistSession; expected boolean.');
        delete options.persistSession;
    }

    if (options.resumeSessionId !== undefined && typeof options.resumeSessionId !== 'string') {
        warnings.push('Invalid resumeSessionId; expected string.');
        delete options.resumeSessionId;
    }

    if (options.resumeSessionAt !== undefined && typeof options.resumeSessionAt !== 'string') {
        warnings.push('Invalid resumeSessionAt; expected string.');
        delete options.resumeSessionAt;
    }

    if (options.forkSession !== undefined && typeof options.forkSession !== 'boolean') {
        warnings.push('Invalid forkSession; expected boolean.');
        delete options.forkSession;
    }

    if (options.betas !== undefined) {
        const betas = coerceStringArray(options.betas);
        if (!betas) {
            warnings.push('Invalid betas; expected string array.');
            delete options.betas;
        } else {
            options.betas = betas;
        }
    }

    if (options.allowedTools !== undefined) {
        const allowed = coerceStringArray(options.allowedTools);
        if (!allowed) {
            warnings.push('Invalid allowedTools; expected string array.');
            delete options.allowedTools;
        } else {
            options.allowedTools = allowed;
        }
    }

    if (options.disallowedTools !== undefined) {
        const disallowed = coerceStringArray(options.disallowedTools);
        if (!disallowed) {
            warnings.push('Invalid disallowedTools; expected string array.');
            delete options.disallowedTools;
        } else {
            options.disallowedTools = disallowed;
        }
    }

    if (options.tools !== undefined) {
        if (options.tools === 'default') {
            // ok
        } else if (Array.isArray(options.tools)) {
            options.tools = options.tools.map(v => String(v)).filter(Boolean);
        } else {
            warnings.push('Invalid tools; expected string array or "default".');
            delete options.tools;
        }
    }

    if (options.mcpServers !== undefined && (typeof options.mcpServers !== 'object' || Array.isArray(options.mcpServers))) {
        warnings.push('Invalid mcpServers; expected object.');
        delete options.mcpServers;
    }

    if (options.strictMcpConfig !== undefined && typeof options.strictMcpConfig !== 'boolean') {
        warnings.push('Invalid strictMcpConfig; expected boolean.');
        delete options.strictMcpConfig;
    }

    if (options.settingSources !== undefined) {
        const sources = coerceStringArray(options.settingSources);
        if (!sources) {
            warnings.push('Invalid settingSources; expected string array.');
            delete options.settingSources;
        } else {
            options.settingSources = sources;
        }
    }

    if (options.additionalDirectories !== undefined) {
        const dirs = coerceStringArray(options.additionalDirectories);
        if (!dirs) {
            warnings.push('Invalid additionalDirectories; expected string array.');
            delete options.additionalDirectories;
        } else {
            options.additionalDirectories = dirs;
        }
    }

    if (options.plugins !== undefined) {
        if (!Array.isArray(options.plugins) || options.plugins.some(p => !p || p.type !== 'local' || typeof p.path !== 'string')) {
            warnings.push('Invalid plugins; expected array of { type: "local", path: string }.');
            delete options.plugins;
        }
    }

    if (options.jsonSchema !== undefined) {
        const schemaType = typeof options.jsonSchema;
        if (schemaType !== 'string' && schemaType !== 'object') {
            warnings.push('Invalid jsonSchema; expected string or object.');
            delete options.jsonSchema;
        }
    }

    if (options.extraArgs !== undefined && (typeof options.extraArgs !== 'object' || Array.isArray(options.extraArgs))) {
        warnings.push('Invalid extraArgs; expected object.');
        delete options.extraArgs;
    }

    if (options.sandbox !== undefined && typeof options.sandbox !== 'string') {
        warnings.push('Invalid sandbox; expected string.');
        delete options.sandbox;
    }

    if (options.enableFileCheckpointing !== undefined && typeof options.enableFileCheckpointing !== 'boolean') {
        warnings.push('Invalid enableFileCheckpointing; expected boolean.');
        delete options.enableFileCheckpointing;
    }

    if (options.executable !== undefined && typeof options.executable !== 'string') {
        warnings.push('Invalid executable; expected string.');
        delete options.executable;
    }

    if (options.executableArgs !== undefined) {
        const args = coerceStringArray(options.executableArgs);
        if (!args) {
            warnings.push('Invalid executableArgs; expected string array.');
            delete options.executableArgs;
        } else {
            options.executableArgs = args;
        }
    }

    return { options, warnings };
}
