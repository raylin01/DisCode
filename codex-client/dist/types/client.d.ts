import { EventEmitter } from 'events';
import { ThreadStartParams, ThreadStartResponse, ThreadResumeParams, ThreadResumeResponse, ThreadForkParams, ThreadForkResponse, ThreadArchiveParams, ThreadArchiveResponse, ThreadUnarchiveParams, ThreadUnarchiveResponse, ThreadSetNameParams, ThreadSetNameResponse, ThreadCompactStartParams, ThreadCompactStartResponse, ThreadRollbackParams, ThreadRollbackResponse, ThreadListParams, ThreadListResponse, ThreadLoadedListParams, ThreadLoadedListResponse, ThreadReadParams, ThreadReadResponse, ModelListParams, ModelListResponse, SetDefaultModelParams, SetDefaultModelResponse, AppsListParams, AppsListResponse, SkillsListParams, SkillsListResponse, SkillsRemoteReadParams, SkillsRemoteReadResponse, SkillsRemoteWriteParams, SkillsRemoteWriteResponse, SkillsConfigWriteParams, SkillsConfigWriteResponse, ConfigReadParams, ConfigReadResponse, ConfigValueWriteParams, ConfigBatchWriteParams, ConfigRequirements, TurnStartParams, TurnStartResponse, TurnInterruptParams, TurnInterruptResponse } from './types.js';
export interface CodexClientOptions {
    codexPath?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    analyticsDefaultEnabled?: boolean;
    clientInfo?: {
        name?: string;
        title?: string;
        version?: string;
    };
    capabilities?: {
        experimentalApi?: boolean;
    };
}
export declare class CodexClient extends EventEmitter {
    private proc;
    private rl;
    private initialized;
    private initPromise;
    private requestCounter;
    private pending;
    private readonly options;
    constructor(options?: CodexClientOptions);
    start(): Promise<void>;
    private startInternal;
    private handleLine;
    private handleResponse;
    private nextId;
    private sendRaw;
    sendRequest<T = any>(method: string, params: any): Promise<T>;
    sendResponse(id: string | number, result: any): void;
    sendError(id: string | number, error: any): void;
    startThread(params: ThreadStartParams): Promise<ThreadStartResponse>;
    resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
    forkThread(params: ThreadForkParams): Promise<ThreadForkResponse>;
    archiveThread(params: ThreadArchiveParams): Promise<ThreadArchiveResponse>;
    unarchiveThread(params: ThreadUnarchiveParams): Promise<ThreadUnarchiveResponse>;
    setThreadName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse>;
    compactThread(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse>;
    rollbackThread(params: ThreadRollbackParams): Promise<ThreadRollbackResponse>;
    listThreads(params?: ThreadListParams): Promise<ThreadListResponse>;
    listLoadedThreads(params?: ThreadLoadedListParams): Promise<ThreadLoadedListResponse>;
    readThread(params: ThreadReadParams): Promise<ThreadReadResponse>;
    listModels(params?: ModelListParams): Promise<ModelListResponse>;
    setDefaultModel(params: SetDefaultModelParams): Promise<SetDefaultModelResponse>;
    listApps(params?: AppsListParams): Promise<AppsListResponse>;
    listSkills(params?: SkillsListParams): Promise<SkillsListResponse>;
    readRemoteSkills(params?: SkillsRemoteReadParams): Promise<SkillsRemoteReadResponse>;
    writeRemoteSkill(params: SkillsRemoteWriteParams): Promise<SkillsRemoteWriteResponse>;
    writeSkillConfig(params: SkillsConfigWriteParams): Promise<SkillsConfigWriteResponse>;
    readConfig(params: ConfigReadParams): Promise<ConfigReadResponse>;
    writeConfigValue(params: ConfigValueWriteParams): Promise<any>;
    batchWriteConfig(params: ConfigBatchWriteParams): Promise<any>;
    readConfigRequirements(): Promise<ConfigRequirements>;
    startTurn(params: TurnStartParams): Promise<TurnStartResponse>;
    interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse>;
    shutdown(): Promise<void>;
    private rejectAll;
}
