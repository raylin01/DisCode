import { SyncProjectsMessage, SyncSessionsMessage } from '../../../shared/types.js';
export declare function handleSyncProjects(_data: SyncProjectsMessage['data']): Promise<void>;
export declare function handleSyncSessions(data: SyncSessionsMessage['data']): Promise<void>;
