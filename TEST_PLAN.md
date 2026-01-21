# DisCode Test Plan

## Overview

This document outlines the comprehensive unit testing strategy for the DisCode project.

**Framework:** Vitest
**Coverage Goal:** 80% statements, 75% branches, 85% functions, 80% lines
**Estimated Test Count:** 400-500 tests total

## Quick Start

```bash
# Install dependencies
cd runner-agent && npm install
cd ../discord-bot && npm install

# Run tests
npm test                 # Run all tests
npm test:coverage        # Run with coverage report
npm test:watch           # Watch mode
```

## Test Structure

```
runner-agent/tests/
├── unit/
│   ├── utils.test.ts
│   ├── config.test.ts
│   ├── terminal-session.test.ts
│   ├── parsers/
│   │   ├── claude-parser.test.ts
│   │   ├── gemini-parser.test.ts
│   │   ├── generic-parser.test.ts
│   │   └── index.test.ts
│   └── handlers/
├── fixtures/
│   └── output-samples.txt
└── setup.ts

discord-bot/tests/
├── unit/
│   ├── storage.test.ts
│   ├── config.test.ts
│   └── utils/
│       ├── channels.test.ts
│       └── embeds.test.ts
└── setup.ts
```

## Priority Levels

### HIGH Priority (90%+ coverage)
- **runner-agent:**
  - `utils.ts` - Path utilities, ANSI stripping
  - `config.ts` - Configuration loading
  - `terminal-session.ts` - PTY session management
  - `parsers/` - Output parsing logic

- **discord-bot:**
  - `storage.ts` - YAML persistence
  - `config.ts` - Bot configuration
  - `utils/embeds.ts` - Discord embeds
  - `utils/channels.ts` - Channel management

### MEDIUM Priority (75%+ coverage)
- WebSocket/HTTP handlers
- Plugin manager
- Discord command handlers

### LOW Priority (50%+ or skip)
- Main entry points
- Simple event wiring
- Type definitions

## Key Test Cases

### runner-agent/src/utils.ts
- `generateRunnerId()` - Consistent IDs, format validation
- `stripAnsi()` - ANSI removal, OSC sequences
- `findCliPath()` - CLI discovery, path resolution
- `expandPath()` - ~ expansion, relative paths
- `validateOrCreateFolder()` - Folder validation/creation

### runner-agent/src/terminal-session.ts
- Session lifecycle (start, ready, exit)
- PTY communication (write, sendMessage)
- Event emission (output, ready, exit)
- Buffer management

### runner-agent/src/plugins/parsers/
- `detectReady()` - Prompt detection
- `detectPermissionPrompt()` - Approval parsing
- `cleanOutput()` - Output sanitization
- `parseTokensFromOutput()` - Token extraction

### discord-bot/src/storage.ts
- Token generation/validation
- Runner registration/status
- Session management
- YAML persistence
- Data cleanup

### discord-bot/src/utils/
- `channels.ts` - Channel creation/permissions
- `embeds.ts` - Discord embed formatting

## Mocking Strategy

### File System
```typescript
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn()
}));
```

### Environment Variables
```typescript
process.env.DISCORDE_TOKEN = 'test-token';
// Reset after test
delete process.env.DISCORDE_TOKEN;
```

### Singletons
```typescript
import { resetConfig } from './config';
beforeEach(() => resetConfig());
```

## Coverage Reports

Coverage reports are generated in `coverage/` directory:
- `index.html` - HTML report
- `lcov.info` - CI integration

## Continuous Integration

Tests run automatically on:
- Every push
- Every pull request
- Coverage reported to Codecov

## Timeline

- **Week 1:** Setup + utility/config/storage tests
- **Week 2:** Parser + terminal session tests
- **Week 3:** Handler + Discord utility tests
- **Week 4:** Integration tests + coverage refinement

## Full Test Plan

For detailed test cases for every function, see the comprehensive analysis output from the test planning agent.

---

**Status:** 📝 Planning Complete
**Next Step:** Set up Vitest configuration and implement first tests
