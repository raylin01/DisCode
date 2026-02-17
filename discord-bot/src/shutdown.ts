/**
 * Shutdown and Error Handling
 *
 * Contains global error handlers and graceful shutdown logic.
 */

/**
 * Sets up global error handlers for the process
 */
export function setupGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
  });
}
