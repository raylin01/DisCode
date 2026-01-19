
import http from 'http';
import { EventEmitter } from 'events';
import { getPluginManager } from '../plugins/index.js';

export interface HookEvent {
    type: string;
    sessionId: string;
    cwd: string;
    tool?: string;
    toolInput?: any;
    toolResponse?: any;
    menuId?: string;
    timestamp: number;
    [key: string]: any;
}

export class HookServer extends EventEmitter {
    private server: http.Server | null = null;
    private port: number;

    constructor(port: number = 3000) {
        super();
        this.port = port;
    }

    start(): void {
        if (this.server) return;

        this.server = http.createServer((req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405);
                res.end('Method Not Allowed');
                return;
            }

            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });

            req.on('end', () => {
                try {
                    const event = JSON.parse(body) as HookEvent;
                    this.handleEvent(event);
                    res.writeHead(200);
                    res.end('OK');
                } catch (error) {
                    console.error('Failed to parse hook event:', error);
                    res.writeHead(400);
                    res.end('Bad Request');
                }
            });
        });

        this.server.listen(this.port, () => {
            console.log(`[HookServer] Listening on port ${this.port}`);
        });

        this.server.on('error', (err) => {
            console.error('[HookServer] Error:', err);
        });
    }

    stop(): void {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    private handleEvent(event: HookEvent): void {
        const pluginManager = getPluginManager();

        // Log event for debugging
        console.log(`[HookServer] Received ${event.type} for session ${event.sessionId || 'unknown'}`);

        // Forward to PluginManager
        // We emit a special 'hook_event' that plugins can listen to
        pluginManager.emit('hook_event', event);
    }
}

// Singleton instance
let hookServer: HookServer | null = null;

export function getHookServer(): HookServer {
    if (!hookServer) {
        // Default to port 3000, but allow env override
        const port = parseInt(process.env.DISCORDE_HOOK_PORT || '3000', 10);
        hookServer = new HookServer(port);
    }
    return hookServer;
}
