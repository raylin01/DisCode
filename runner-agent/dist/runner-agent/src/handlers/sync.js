import { getSyncService } from '../services/sync-service.js';
export async function handleSyncProjects(_data) {
    const syncService = getSyncService();
    if (syncService) {
        await syncService.handleSyncProjects();
    }
}
export async function handleSyncSessions(data) {
    const syncService = getSyncService();
    if (syncService) {
        await syncService.handleSyncSessions(data.projectPath);
    }
}
