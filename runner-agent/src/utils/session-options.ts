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

// Validation schema types
type Validator = (value: any, options: PluginOptions) => { valid: boolean; newValue?: any };
type FieldConfig = { validator: Validator; errorMsg: string };

function createPositiveNumberValidator(): Validator {
    return (value) => {
        const num = coerceNumber(value);
        return { valid: num !== undefined && num > 0, newValue: num };
    };
}

function createStringValidator(): Validator {
    return (value) => ({ valid: typeof value === 'string' });
}

function createBooleanValidator(): Validator {
    return (value) => ({ valid: typeof value === 'boolean' });
}

function createStringArrayValidator(): Validator {
    return (value) => {
        const arr = coerceStringArray(value);
        return { valid: arr !== undefined, newValue: arr };
    };
}

function createSetMemberValidator(allowed: Set<string>): Validator {
    return (value) => ({ valid: allowed.has(value) });
}

// Field validation configuration
const FIELD_CONFIGS: Record<string, FieldConfig> = {
    thinkingLevel: { validator: createSetMemberValidator(THINKING_LEVELS), errorMsg: 'Invalid thinkingLevel "{value}".' },
    permissionMode: { validator: createSetMemberValidator(PERMISSION_MODES), errorMsg: 'Invalid permissionMode "{value}".' },
    maxTurns: { validator: createPositiveNumberValidator(), errorMsg: 'Invalid maxTurns; expected positive number.' },
    maxBudgetUsd: { validator: createPositiveNumberValidator(), errorMsg: 'Invalid maxBudgetUsd; expected positive number.' },
    maxThinkingTokens: { validator: createPositiveNumberValidator(), errorMsg: 'Invalid maxThinkingTokens; expected positive number.' },
    model: { validator: createStringValidator(), errorMsg: 'Invalid model; expected string.' },
    fallbackModel: { validator: createStringValidator(), errorMsg: 'Invalid fallbackModel; expected string.' },
    agent: { validator: createStringValidator(), errorMsg: 'Invalid agent; expected string.' },
    includePartialMessages: { validator: createBooleanValidator(), errorMsg: 'Invalid includePartialMessages; expected boolean.' },
    permissionPromptTool: { validator: createBooleanValidator(), errorMsg: 'Invalid permissionPromptTool; expected boolean.' },
    permissionPromptToolName: { validator: createStringValidator(), errorMsg: 'Invalid permissionPromptToolName; expected string.' },
    allowDangerouslySkipPermissions: { validator: createBooleanValidator(), errorMsg: 'Invalid allowDangerouslySkipPermissions; expected boolean.' },
    persistSession: { validator: createBooleanValidator(), errorMsg: 'Invalid persistSession; expected boolean.' },
    resumeSessionId: { validator: createStringValidator(), errorMsg: 'Invalid resumeSessionId; expected string.' },
    resumeSessionAt: { validator: createStringValidator(), errorMsg: 'Invalid resumeSessionAt; expected string.' },
    forkSession: { validator: createBooleanValidator(), errorMsg: 'Invalid forkSession; expected boolean.' },
    betas: { validator: createStringArrayValidator(), errorMsg: 'Invalid betas; expected string array.' },
    allowedTools: { validator: createStringArrayValidator(), errorMsg: 'Invalid allowedTools; expected string array.' },
    disallowedTools: { validator: createStringArrayValidator(), errorMsg: 'Invalid disallowedTools; expected string array.' },
    settingSources: { validator: createStringArrayValidator(), errorMsg: 'Invalid settingSources; expected string array.' },
    additionalDirectories: { validator: createStringArrayValidator(), errorMsg: 'Invalid additionalDirectories; expected string array.' },
    executableArgs: { validator: createStringArrayValidator(), errorMsg: 'Invalid executableArgs; expected string array.' },
    strictMcpConfig: { validator: createBooleanValidator(), errorMsg: 'Invalid strictMcpConfig; expected boolean.' },
    enableFileCheckpointing: { validator: createBooleanValidator(), errorMsg: 'Invalid enableFileCheckpointing; expected boolean.' },
    executable: { validator: createStringValidator(), errorMsg: 'Invalid executable; expected string.' },
    sandbox: { validator: createStringValidator(), errorMsg: 'Invalid sandbox; expected string.' },
};

// Special validators that need custom logic
function validateTools(value: any): { valid: boolean; newValue?: any } {
    if (value === 'default') return { valid: true };
    if (Array.isArray(value)) {
        return { valid: true, newValue: value.map((v: any) => String(v)).filter(Boolean) };
    }
    return { valid: false };
}

function validateMcpServers(value: any): { valid: boolean } {
    return { valid: typeof value === 'object' && value !== null && !Array.isArray(value) };
}

function validatePlugins(value: any): { valid: boolean } {
    if (!Array.isArray(value)) return { valid: false };
    return { valid: value.every(p => p && p.type === 'local' && typeof p.path === 'string') };
}

function validateJsonSchema(value: any): { valid: boolean } {
    const t = typeof value;
    return { valid: t === 'string' || t === 'object' };
}

function validateExtraArgs(value: any): { valid: boolean } {
    return { valid: typeof value === 'object' && value !== null && !Array.isArray(value) };
}

export function normalizeClaudeOptions(input: PluginOptions | undefined): NormalizedOptionsResult {
    const options: PluginOptions = { ...(input || {}) };
    const warnings: string[] = [];

    // Validate standard fields using schema
    for (const [field, config] of Object.entries(FIELD_CONFIGS)) {
        if (options[field as keyof PluginOptions] === undefined) continue;

        const value = options[field as keyof PluginOptions];
        const result = config.validator(value, options);

        if (!result.valid) {
            warnings.push(config.errorMsg.replace('{value}', String(value)));
            delete options[field as keyof PluginOptions];
        } else if (result.newValue !== undefined) {
            (options as any)[field] = result.newValue;
        }
    }

    // Integer coercion for specific fields
    if (typeof options.maxTurns === 'number') {
        options.maxTurns = Math.floor(options.maxTurns);
    }
    if (typeof options.maxThinkingTokens === 'number') {
        options.maxThinkingTokens = Math.floor(options.maxThinkingTokens);
    }

    // Cross-field validation
    if (options.model && options.fallbackModel && options.model === options.fallbackModel) {
        warnings.push('fallbackModel cannot match model.');
        delete options.fallbackModel;
    }

    // Special field validations
    if (options.tools !== undefined) {
        const result = validateTools(options.tools);
        if (!result.valid) {
            warnings.push('Invalid tools; expected string array or "default".');
            delete options.tools;
        } else if (result.newValue !== undefined) {
            options.tools = result.newValue;
        }
    }

    if (options.mcpServers !== undefined) {
        if (!validateMcpServers(options.mcpServers).valid) {
            warnings.push('Invalid mcpServers; expected object.');
            delete options.mcpServers;
        }
    }

    if (options.plugins !== undefined) {
        if (!validatePlugins(options.plugins).valid) {
            warnings.push('Invalid plugins; expected array of { type: "local", path: string }.');
            delete options.plugins;
        }
    }

    if (options.jsonSchema !== undefined) {
        if (!validateJsonSchema(options.jsonSchema).valid) {
            warnings.push('Invalid jsonSchema; expected string or object.');
            delete options.jsonSchema;
        }
    }

    if (options.extraArgs !== undefined) {
        if (!validateExtraArgs(options.extraArgs).valid) {
            warnings.push('Invalid extraArgs; expected object.');
            delete options.extraArgs;
        }
    }

    return { options, warnings };
}
