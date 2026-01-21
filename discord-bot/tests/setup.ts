import { vi } from 'vitest';

// Mock process.exit to prevent test suite from exiting
const originalExit = process.exit;
process.exit = vi.fn((code?: number) => {
  throw new Error(`process.exit called with code: ${code}`);
}) as any;

// Reset process.exit mock after tests
afterAll(() => {
  process.exit = originalExit;
});

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Mock console methods to reduce noise (optional - comment out if debugging)
global.console = {
  ...console,
  error: vi.fn(),
  warn: vi.fn(),
  // Keep log for debugging test failures
  // log: vi.fn(),
  // info: vi.fn(),
};
