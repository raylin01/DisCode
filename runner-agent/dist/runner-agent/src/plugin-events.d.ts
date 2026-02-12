/**
 * Plugin Event Wiring
 *
 * Connects PluginManager events to WebSocket for Discord communication.
 */
import type { PluginManager } from './plugins/index.js';
import type { WebSocketManager } from './websocket.js';
export declare function wirePluginEvents(pluginManager: PluginManager, wsManager: WebSocketManager): void;
