# DisCode Client Packages

DisCode uses three standalone npm packages for CLI integrations:

- [`@raylin01/claude-client`](https://github.com/raylin01/claude-client)
- [`@raylin01/codex-client`](https://github.com/raylin01/codex-client)
- [`@raylin01/gemini-client`](https://github.com/raylin01/gemini-client)

These packages can be used independently in any Node.js app.

## Which package should I use?

- Use `@raylin01/claude-client` for Claude Code stream-json control.
- Use `@raylin01/codex-client` for Codex app-server JSON-RPC integration.
- Use `@raylin01/gemini-client` for Gemini stream-json sessions and local session management.

## Real-world sample

DisCode consumes these clients in production-like plugin flows:

- [raylin01/DisCode](https://github.com/raylin01/DisCode)
