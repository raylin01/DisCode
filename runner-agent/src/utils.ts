/**
 * Utility Functions for Runner Agent
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Generate consistent runner ID from token (same token = same ID)
 * This prevents duplicate runners on restart
 */
export function generateRunnerId(token: string, runnerName: string): string {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const shortHash = hash.substring(0, 12);
    return `runner_${runnerName.replace(/\s+/g, '_').toLowerCase()}_${shortHash}`;
}

/**
 * Strip ANSI escape sequences from text
 */
export function stripAnsi(text: string): string {
    return text
        .replace(/\x1b\[[0-9;]*[mGKH]/g, '')
        .replace(/\x1b\[[0-9;]*[0-9;]*[mGKH]/g, '')
        .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
        .replace(/\x1b\][0-9];[^\x07]*\x07/g, '')
        .replace(/\x1b\][0-9];[^\x1b]*\x1b\\/g, '');
}

/**
 * Find CLI executable path
 */
export async function findCliPath(
    cliType: 'claude' | 'gemini' | 'codex',
    searchPaths: string[]
): Promise<string | null> {
    for (const dir of searchPaths) {
        const fullPath = `${dir}/${cliType}`;
        try {
            if (fs.existsSync(fullPath)) {
                console.log(`Found ${cliType} at ${fullPath}`);
                return fullPath;
            }
        } catch (error) {
            // Path doesn't exist or isn't accessible
        }
    }

    if (cliType === 'codex') {
        const codexFromExtension = findCodexCliFromExtensions();
        if (codexFromExtension) {
            console.log(`Found codex via VS Code extension at ${codexFromExtension}`);
            return codexFromExtension;
        }
    }

    return null;
}

function findCodexCliFromExtensions(): string | null {
    const home = os.homedir();
    const extensionBases = [
        path.join(home, '.vscode', 'extensions'),
        path.join(home, '.vscode-insiders', 'extensions'),
        path.join(home, '.vscode-oss', 'extensions'),
        path.join(home, '.vscode-server', 'extensions'),
        path.join(home, '.vscode-server-insiders', 'extensions'),
        path.join(home, '.cursor', 'extensions')
    ];

    const prefixes = ['openai.chatgpt', 'openai.codex'];
    const candidates: Array<{ path: string; mtimeMs: number }> = [];

    for (const base of extensionBases) {
        if (!fs.existsSync(base)) continue;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const name = entry.name.toLowerCase();
            if (!prefixes.some(prefix => name === prefix || name.startsWith(`${prefix}-`))) continue;

            const extDir = path.join(base, entry.name);
            const found = findCodexBinaryInExtensionDir(extDir);
            if (found) {
                try {
                    const stat = fs.statSync(found);
                    candidates.push({ path: found, mtimeMs: stat.mtimeMs });
                } catch {
                    candidates.push({ path: found, mtimeMs: 0 });
                }
            }
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].path;
}

function findCodexBinaryInExtensionDir(extensionDir: string): string | null {
    const binDir = path.join(extensionDir, 'extension', 'bin');
    if (!fs.existsSync(binDir)) return null;

    const direct = path.join(binDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(direct)) return direct;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(binDir, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(binDir, entry.name, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Expand path - handles ~ and relative paths
 */
export function expandPath(rawPath: string, defaultWorkspace?: string): string {
    let cwd = rawPath;

    // Handle ~ expansion
    if (cwd.startsWith('~')) {
        cwd = cwd.replace(/^~/, os.homedir());
    }
    // Handle relative paths
    else if (!path.isAbsolute(cwd)) {
        if (defaultWorkspace) {
            cwd = path.join(defaultWorkspace, cwd);
        } else {
            cwd = path.resolve(process.cwd(), cwd);
        }
    }

    return cwd;
}

/**
 * Validate folder exists, optionally create it
 */
export function validateOrCreateFolder(
    folderPath: string,
    create: boolean = false
): { exists: boolean; error?: string } {
    if (fs.existsSync(folderPath)) {
        return { exists: true };
    }

    if (create) {
        try {
            fs.mkdirSync(folderPath, { recursive: true });
            return { exists: true };
        } catch (e) {
            return { exists: false, error: `Failed to create folder: ${e}` };
        }
    }

    return { exists: false, error: `Folder does not exist: ${folderPath}` };
}
