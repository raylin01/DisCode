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
export function generateRunnerId(token, runnerName) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const shortHash = hash.substring(0, 12);
    return `runner_${runnerName.replace(/\s+/g, '_').toLowerCase()}_${shortHash}`;
}
/**
 * Strip ANSI escape sequences from text
 */
export function stripAnsi(text) {
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
export async function findCliPath(cliType, searchPaths) {
    for (const dir of searchPaths) {
        const fullPath = `${dir}/${cliType}`;
        try {
            if (fs.existsSync(fullPath)) {
                console.log(`Found ${cliType} at ${fullPath}`);
                return fullPath;
            }
        }
        catch (error) {
            // Path doesn't exist or isn't accessible
        }
    }
    return null;
}
/**
 * Expand path - handles ~ and relative paths
 */
export function expandPath(rawPath, defaultWorkspace) {
    let cwd = rawPath;
    // Handle ~ expansion
    if (cwd.startsWith('~')) {
        cwd = cwd.replace(/^~/, os.homedir());
    }
    // Handle relative paths
    else if (!path.isAbsolute(cwd)) {
        if (defaultWorkspace) {
            cwd = path.join(defaultWorkspace, cwd);
        }
        else {
            cwd = path.resolve(process.cwd(), cwd);
        }
    }
    return cwd;
}
/**
 * Validate folder exists, optionally create it
 */
export function validateOrCreateFolder(folderPath, create = false) {
    if (fs.existsSync(folderPath)) {
        return { exists: true };
    }
    if (create) {
        try {
            fs.mkdirSync(folderPath, { recursive: true });
            return { exists: true };
        }
        catch (e) {
            return { exists: false, error: `Failed to create folder: ${e}` };
        }
    }
    return { exists: false, error: `Folder does not exist: ${folderPath}` };
}
