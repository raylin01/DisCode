import { 
    SyncProjectsMessage, 
    SyncSessionsMessage,
    SyncStatusRequestMessage,
    SyncSessionMessagesMessage
} from '../../../shared/types.js';
import { getSyncService } from '../services/sync-service.js';

export async function handleSyncProjects(
    _data: SyncProjectsMessage['data']
): Promise<void> {
    const syncService = getSyncService();
    if (syncService) {
        void syncService.handleSyncProjects(_data.requestId);
    }
}

export async function handleSyncSessions(
    data: SyncSessionsMessage['data']
): Promise<void> {
    const syncService = getSyncService();
    if (syncService) {
        void syncService.handleSyncSessions(data.projectPath, data.requestId);
    }
}

export async function handleSyncStatusRequest(
    data: SyncStatusRequestMessage['data']
): Promise<void> {
    const syncService = getSyncService();
    if (!syncService) return;

    syncService.sendStatusResponse(data.requestId);
}

export async function handleSyncSessionMessages(
    data: SyncSessionMessagesMessage['data']
): Promise<void> {
    const syncService = getSyncService();
    if (!syncService) return;
    void syncService.handleSyncSessionMessages(data.sessionId, data.projectPath, data.requestId);
}
