/**
 * Runner Agent Configuration
 *
 * Loads configuration from:
 * 1. Config file (./config.json or DISCODE_CONFIG_PATH)
 * 2. Environment variables (override file values)
 *
 * Secrets (DISCODE_TOKEN) must always be in environment.
 */
export interface TmuxConfig {
    pollInterval: number;
    healthCheckInterval: number;
    sessionDiscoveryInterval: number;
    discoveryEnabled: boolean;
}
export interface AssistantConfig {
    enabled: boolean;
    folder?: string;
    plugin: 'tmux' | 'print';
}
export interface RunnerConfig {
    botWsUrl: string;
    token: string;
    runnerName: string;
    httpPort: number;
    defaultWorkspace?: string;
    cliTypes: ('claude' | 'gemini')[];
    heartbeatInterval: number;
    reconnectDelay: number;
    approvalTimeout: number;
    sessionReadyTimeout: number;
    cliSearchPaths: string[];
    tmux: TmuxConfig;
    assistant: AssistantConfig;
}
interface FileConfig {
    botWsUrl?: string;
    runnerName?: string;
    httpPort?: number;
    defaultWorkspace?: string;
    cliTypes?: string[];
    heartbeatInterval?: number;
    reconnectDelay?: number;
    approvalTimeout?: number;
    sessionReadyTimeout?: number;
    cliSearchPaths?: string[];
    tmux?: Partial<TmuxConfig>;
    assistant?: Partial<AssistantConfig>;
}
export declare function loadConfigFile(): FileConfig;
export declare function parseCliTypes(input: string | string[] | undefined): ('claude' | 'gemini')[];
export declare function parseSearchPaths(envInput: string | undefined, fileInput: string[] | undefined): string[];
export declare function loadConfig(): RunnerConfig;
export declare function getConfig(): RunnerConfig;
export declare function resetConfig(): void;
export {};
