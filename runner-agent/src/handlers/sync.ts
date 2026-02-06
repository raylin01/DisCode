import { 
    SyncProjectsMessage, 
    SyncSessionsMessage 
} from '../../../shared/types.js';
import { getSyncService } from '../services/sync-service.js';

export async function handleSyncProjects(
    _data: SyncProjectsMessage['data']
): Promise<void> {
    const syncService = getSyncService();
    if (syncService) {
        await syncService.handleSyncProjects();
    }
}

export async function handleSyncSessions(
    data: SyncSessionsMessage['data']
): Promise<void> {
    const syncService = getSyncService();
    if (syncService) {
        await syncService.handleSyncSessions(data.projectPath);
    }
}
