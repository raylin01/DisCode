import type { PluginOptions } from '../plugins/base.js';

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

export function resolveClaudeCommand(
    cliPath: string,
    options?: PluginOptions
): { command: string; args: string[] } {
    const isScript = SCRIPT_EXTENSIONS.some((ext) => cliPath.endsWith(ext));
    if (!isScript) {
        return { command: cliPath, args: [] };
    }

    const executable = options?.executable || 'node';
    const executableArgs = options?.executableArgs || [];
    return {
        command: executable,
        args: [...executableArgs, cliPath]
    };
}

export function shellEscape(value: string): string {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}
