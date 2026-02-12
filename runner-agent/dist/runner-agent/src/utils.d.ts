/**
 * Utility Functions for Runner Agent
 */
/**
 * Generate consistent runner ID from token (same token = same ID)
 * This prevents duplicate runners on restart
 */
export declare function generateRunnerId(token: string, runnerName: string): string;
/**
 * Strip ANSI escape sequences from text
 */
export declare function stripAnsi(text: string): string;
/**
 * Find CLI executable path
 */
export declare function findCliPath(cliType: 'claude' | 'gemini', searchPaths: string[]): Promise<string | null>;
/**
 * Expand path - handles ~ and relative paths
 */
export declare function expandPath(rawPath: string, defaultWorkspace?: string): string;
/**
 * Validate folder exists, optionally create it
 */
export declare function validateOrCreateFolder(folderPath: string, create?: boolean): {
    exists: boolean;
    error?: string;
};
