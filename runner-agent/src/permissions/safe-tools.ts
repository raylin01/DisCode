/**
 * Safe vs Dangerous Tool Classification
 *
 * This module classifies built-in tools and Bash commands as "safe" or "dangerous".
 * In "autoSafe" approval mode, safe tools are auto-approved while dangerous ones
 * still require user approval.
 */

// ============================================================================
// Tool Classification
// ============================================================================

/**
 * Built-in tools that are considered SAFE to auto-approve.
 * These are read-only operations that cannot modify the filesystem or execute code.
 */
export const SAFE_TOOLS = new Set([
    // File reading (read-only)
    'Read',
    'Glob',
    'Grep',
    'LSP',
    'DirectoryTree',

    // Information gathering
    'NotebookRead',

    // User interaction (requires user input anyway)
    'AskUserQuestion',
]);

/**
 * Built-in tools that are always DANGEROUS and require approval.
 * These can modify files, execute code, or have side effects.
 */
export const DANGEROUS_TOOLS = new Set([
    // File modifications
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',

    // Code execution
    'Bash',
    'Task',       // Can spawn sub-agents that do dangerous things
    'Skill',      // User-defined, could do anything
    'MCP',        // External servers, unknown safety

    // System operations
    'ExitPlanMode',  // Changes AI behavior
]);

/**
 * Dangerous Bash command patterns.
 * Commands matching these patterns should ALWAYS require approval.
 */
const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    // File deletion
    { pattern: /\brm\s/, reason: 'File deletion' },
    { pattern: /\brmdir\s/, reason: 'Directory deletion' },
    { pattern: /\bshred\s/, reason: 'Secure file deletion' },

    // Privilege escalation
    { pattern: /\bsudo\s/, reason: 'Privilege escalation' },
    { pattern: /\bsu\s/, reason: 'User switching' },
    { pattern: /\bdoas\s/, reason: 'Privilege escalation' },

    // Permissions
    { pattern: /\bchmod\s/, reason: 'Permission change' },
    { pattern: /\bchown\s/, reason: 'Ownership change' },
    { pattern: /\bchgrp\s/, reason: 'Group change' },

    // System control
    { pattern: /\bshutdown\b/, reason: 'System shutdown' },
    { pattern: /\breboot\b/, reason: 'System reboot' },
    { pattern: /\bpoweroff\b/, reason: 'System power off' },
    { pattern: /\bhalt\b/, reason: 'System halt' },
    { pattern: /\binit\s+[06]/, reason: 'System state change' },

    // Process control
    { pattern: /\bkill\s/, reason: 'Process termination' },
    { pattern: /\bpkill\s/, reason: 'Process termination' },
    { pattern: /\bkillall\s/, reason: 'Process termination' },

    // Disk operations
    { pattern: /\bdd\s/, reason: 'Disk operations' },
    { pattern: /\bmkfs\b/, reason: 'Filesystem creation' },
    { pattern: /\bfdisk\b/, reason: 'Disk partitioning' },
    { pattern: /\bparted\b/, reason: 'Disk partitioning' },
    { pattern: /\bformat\b/, reason: 'Disk formatting' },

    // Network dangerous
    { pattern: /\biptables\b/, reason: 'Firewall modification' },
    { pattern: /\bip\s+route\b/, reason: 'Route modification' },
    { pattern: /\bip\s+link\b/, reason: 'Network interface modification' },

    // Package management (can install malware)
    { pattern: /\bnpm\s+publish\b/, reason: 'Package publishing' },
    { pattern: /\byarn\s+publish\b/, reason: 'Package publishing' },
    { pattern: /\bpnpm\s+publish\b/, reason: 'Package publishing' },
    { pattern: /\bpip\s+upload\b/, reason: 'Package publishing' },

    // Git dangerous operations
    { pattern: /\bgit\s+push\s+.*--force\b/, reason: 'Force push' },
    { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Hard reset' },
    { pattern: /\bgit\s+clean\s+-[fdx]/, reason: 'Clean untracked files' },
    { pattern: /\bgit\s+filter-branch\b/, reason: 'History rewriting' },
    { pattern: /\bgit\s+push\s+.*--delete\b/, reason: 'Remote branch deletion' },

    // Docker dangerous
    { pattern: /\bdocker\s+system\s+prune\b/, reason: 'Docker cleanup' },
    { pattern: /\bdocker\s+image\s+prune\b/, reason: 'Docker image cleanup' },
    { pattern: /\bdocker\s+volume\s+prune\b/, reason: 'Docker volume cleanup' },
    { pattern: /\bdocker\s+container\s+prune\b/, reason: 'Docker container cleanup' },
    { pattern: /\bdocker\s+rm\s/, reason: 'Docker container removal' },
    { pattern: /\bdocker\s+rmi\s/, reason: 'Docker image removal' },
    { pattern: /\bdocker\s+volume\s+rm\b/, reason: 'Docker volume removal' },

    // Kubernetes dangerous
    { pattern: /\bkubectl\s+delete\b/, reason: 'Kubernetes resource deletion' },
    { pattern: /\bkubectl\s+rollout\s+undo\b/, reason: 'Kubernetes rollout undo' },

    // Environment/Config
    { pattern: /\bexport\s+.*API_KEY\b/i, reason: 'API key export' },
    { pattern: /\bexport\s+.*SECRET\b/i, reason: 'Secret export' },
    { pattern: /\bexport\s+.*PASSWORD\b/i, reason: 'Password export' },
    { pattern: /\bexport\s+.*TOKEN\b/i, reason: 'Token export' },

    // Curl/Wget with POST/PUT/DELETE (potential data exfiltration or modification)
    { pattern: /\bcurl\s+.*-[Xx]\s*(POST|PUT|DELETE|PATCH)\b/, reason: 'HTTP modification request' },
    { pattern: /\bwget\s+.*--post/i, reason: 'HTTP POST request' },

    // Database operations
    { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: 'Database deletion' },
    { pattern: /\bTRUNCATE\s+/i, reason: 'Table truncation' },
    { pattern: /\bDELETE\s+FROM\b/i, reason: 'Database deletion' },

    // Shell builtins that can be dangerous
    { pattern: /\beval\s/, reason: 'Dynamic code execution' },
    { pattern: /\bexec\s/, reason: 'Process replacement' },
    { pattern: /\bsource\s+.*\|/, reason: 'Piped source execution' },

    // Archive extraction (potential zip slip, etc.)
    { pattern: /\btar\s+.*--absolute-names\b/, reason: 'Absolute path extraction' },
    { pattern: /\bunzip\s+.*-d\s*\//, reason: 'Extraction to root' },

    // File overwriting (but not stderr redirection like 2>/dev/null)
    { pattern: /(?<![0-9])>\s*\//, reason: 'File overwrite with >' },
    { pattern: />>\s*\//, reason: 'File append with >>' },
    { pattern: /\btee\s+.*\//, reason: 'File overwrite with tee' },

    // Fork bomb detection
    { pattern: /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, reason: 'Fork bomb' },

    // Download and execute patterns
    { pattern: /\bcurl\s+.*\|\s*(bash|sh|zsh|fish)/, reason: 'Download and execute' },
    { pattern: /\bwget\s+.*\|\s*(bash|sh|zsh|fish)/, reason: 'Download and execute' },
];

/**
 * Safe Bash command patterns.
 * These commands are considered safe for auto-approval.
 * Note: Even if a command matches a safe pattern, it still fails if it matches
 * a dangerous pattern (dangerous takes precedence).
 *
 * Patterns use \b word boundaries and don't require starting from beginning
 * to support commands with environment variable prefixes.
 */
const SAFE_BASH_PATTERNS: Array<RegExp> = [
    // File reading
    /\bcat\s/,
    /\bhead\s/,
    /\btail\s/,
    /\bless\s/,
    /\bmore\s/,
    /\bzcat\s/,
    /\bzless\s/,

    // File listing
    /\bls\b/,
    /\bfind\s/,
    /\btree\b/,
    /\bstat\s/,
    /\bfile\s/,
    /\brealpath\s/,
    /\bdirname\s/,
    /\bbasename\s/,

    // Text search/processing (read-only when no -i flag for in-place)
    /\bgrep\b/,
    /\begrep\b/,
    /\bfgrep\b/,
    /\bripgrep\b/,
    /\brg\b/,
    /\back\b/,
    /\bag\b/,
    /\bcut\s/,
    /\bsort\s/,
    /\buniq\s/,
    /\bwc\s/,
    /\btr\s/,
    /\bjoin\s/,
    /\bcomm\s/,

    // Git read operations
    /\bgit\s+status\b/,
    /\bgit\s+log\b/,
    /\bgit\s+diff\b/,
    /\bgit\s+show\b/,
    /\bgit\s+branch\b/,
    /\bgit\s+tag\b/,
    /\bgit\s+remote\b/,
    /\bgit\s+stash\s+list\b/,
    /\bgit\s+rev-parse\b/,
    /\bgit\s+ls-files\b/,
    /\bgit\s+ls-tree\b/,
    /\bgit\s+trees\b/,
    /\bgit\s+describe\b/,
    /\bgit\s+shortlog\b/,
    /\bgit\s+blame\b/,
    /\bgit\s+count\b/,
    /\bgit\s+fetch\b/,
    /\bgit\s+pull\b/,
    /\bgit\s+clone\b/,
    /\bgit\s+add\b/,
    /\bgit\s+commit\b/,
    /\bgit\s+checkout\b/,
    /\bgit\s+switch\b/,
    /\bgit\s+merge\b/,
    /\bgit\s+rebase\b/,
    /\bgit\s+cherry-pick\b/,
    /\bgit\s+stash\b/,
    /\bgit\s+restore\b/,
    /\bgit\s+rm\b/,
    /\bgit\s+mv\b/,
    /\bgit\s+init\b/,
    /\bgit\s+config\b/,
    /\bgit\s+check-ignore\b/,
    /\bgit\s+check-attr\b/,
    /\bgit\s+for-each-ref\b/,
    /\bgit\s+update-ref\b/,
    /\bgit\s+gc\b/,
    /\bgit\s+prune\b/,

    // System info (read-only)
    /\bpwd\b/,
    /\bwhoami\b/,
    /\bid\b/,
    /\buname\b/,
    /\bhostname\b/,
    /\bdate\b/,
    /\buptime\b/,
    /\bfree\b/,
    /\bdf\b/,
    /\bdu\b/,
    /\bps\b/,
    /\btop\b/,
    /\bhtop\b/,
    /\biostat\b/,
    /\bvmstat\b/,
    /\barch\b/,
    /\bnproc\b/,

    // Network info (read-only)
    /\bping\b/,
    /\btraceroute\b/,
    /\btracepath\b/,
    /\bnslookup\b/,
    /\bdig\b/,
    /\bhost\b/,
    /\bip\s+addr\s+show\b/,
    /\bip\s+link\s+show\b/,
    /\bnetstat\b/,
    /\bss\b/,
    /\blsof\b/,

    // Development tools - version checks
    /\bnode\s+(-v|--version)\b/,
    /\bnpm\s+(-v|--version)\b/,
    /\byarn\s+(-v|--version)\b/,
    /\bpnpm\s+(-v|--version)\b/,
    /\bpython\d*\s+(-V|--version)\b/,
    /\bgo\s+version\b/,
    /\brustc\s+--version\b/,
    /\bcargo\s+--version\b/,
    /\bruby\s+--version\b/,
    /\bbun\s+(-v|--version)\b/,
    /\bdeno\s+--version\b/,

    // Package management - install/run (safe, just adds to node_modules)
    /\bnpm\s+(install|i|ci|run|test|build|exec|npx)\b/,
    /\byarn\s+(install|add|run|test|build)\b/,
    /\bpnpm\s+(install|add|run|test|build)\b/,
    /\bbun\s+(install|add|run|test|build)\b/,
    /\bnpx\s+/,
    /\bpip\s+(install|show|list|freeze)\b/,
    /\bpip3\s+(install|show|list|freeze)\b/,
    /\bpipx\s+install\b/,
    /\bbrew\s+(install|list|info|search|outdated|upgrade)\b/,

    // Docker read-only
    /\bdocker\s+(ps|images|logs|inspect|top|stats|port|history|network\s+ls|volume\s+ls)\b/,
    /\bdocker\s+compose\s+(ps|logs|config|top|port|ls|up|down)\b/,

    // Kubernetes read-only
    /\bkubectl\s+(get|describe|logs|top|explain|api-resources|cluster-info|config\s+(view|current-context))\b/,

    // Environment inspection
    /\becho\s+\$/,
    /\benv\b/,
    /\bprintenv\b/,
    /\bwhich\b/,
    /\btype\s+/,
    /\bcommand\s+-v\b/,

    // Common development commands
    /\bnpm\s+/,
    /\byarn\s+/,
    /\bpnpm\s+/,
    /\bbun\s+/,
    /\bnode\s+/,
    /\bdeno\s+/,
    /\btsx?\s+/,
    /\bpython\d*\s+/,
    /\bruby\s+/,
    /\bcargo\s+/,
    /\bmake\s+/,
    /\bcmake\s+/,

    // Build tools
    /\btsc\b/,
    /\besbuild\b/,
    /\bvite\b/,
    /\bwebpack\b/,
    /\brollup\b/,
    /\bparcel\b/,
    /\bprettier\b/,
    /\beslint\b/,
    /\bjest\b/,
    /\bvitest\b/,
    /\bmocha\b/,

    // Common Unix utilities (generally safe)
    /\bmkdir\s+/,
    /\btouch\s+/,
    /\bcp\s+/,
    /\bmv\s+/,
    /\bsed\b/,
    /\bawk\b/,
    /\bgawk\b/,
    /\btee\s+/,
    /\bprintf\s+/,
    /\bsleep\s+/,
    /\btrue\b/,
    /\bfalse\b/,
    /\btest\s+/,
    /\b\[\s+/,

    // DisCode discord integration scripts
    /discord-integration\/bin\/(send-to-discord|update-channel)\.sh/,
    /\.claude\/skills\/discord-integration\/bin\//,
    /runner-agent\/resources\/skills\/discord-integration\/bin\//,

    // Curl for safe operations (GET requests, fetching URLs)
    /\bcurl\s+(-s|--silent|-I|-L|--location)\b/,

    // Sw_vers (macOS version info)
    /\bsw_vers\b/,
];

// ============================================================================
// Classification Functions
// ============================================================================

/**
 * Check if a built-in tool is considered safe for auto-approval.
 */
export function isToolSafe(toolName: string): boolean {
    return SAFE_TOOLS.has(toolName);
}

/**
 * Check if a built-in tool is always dangerous.
 */
export function isToolDangerous(toolName: string): boolean {
    return DANGEROUS_TOOLS.has(toolName);
}

/**
 * Check if a Bash command is safe to auto-approve.
 *
 * A command is considered safe if:
 * 1. It matches at least one safe pattern, AND
 * 2. It does NOT match any dangerous patterns
 *
 * @param command The Bash command to check
 * @returns true if the command is safe to auto-approve
 */
export function isBashCommandSafe(command: string): boolean {
    // First check for dangerous patterns - these take precedence
    for (const { pattern, reason } of DANGEROUS_BASH_PATTERNS) {
        if (pattern.test(command)) {
            console.log(`[SafeTools] Command matches dangerous pattern: ${reason}`);
            return false;
        }
    }

    // Check for safe patterns
    for (const pattern of SAFE_BASH_PATTERNS) {
        if (pattern.test(command)) {
            return true;
        }
    }

    // Default to dangerous if no safe pattern matches
    return false;
}

/**
 * Get the reason why a command is dangerous (for logging/display).
 * Returns undefined if the command is not dangerous or reason unknown.
 */
export function getDangerousReason(command: string): string | undefined {
    for (const { pattern, reason } of DANGEROUS_BASH_PATTERNS) {
        if (pattern.test(command)) {
            return reason;
        }
    }
    return undefined;
}

/**
 * Check if a tool with given input should be auto-approved in autoSafe mode.
 *
 * @param toolName The name of the tool
 * @param input The tool input (for Bash, this would contain the command)
 * @returns true if the tool should be auto-approved
 */
export function shouldAutoApproveInSafeMode(
    toolName: string,
    input: Record<string, any> | undefined
): boolean {
    // AskUserQuestion should NEVER be auto-approved - it requires actual user input
    if (toolName === 'AskUserQuestion') {
        return false;
    }

    // Safe tools are always auto-approved
    if (isToolSafe(toolName)) {
        return true;
    }

    // For Bash, check the command
    if (toolName === 'Bash') {
        const command = input?.command || '';
        return isBashCommandSafe(command);
    }

    // All other tools require approval
    return false;
}
