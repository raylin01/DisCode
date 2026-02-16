# Client Package Publishing Checklist

## Preflight

1. Confirm npm login:

```bash
npm whoami
```

2. Build and test each package:

```bash
cd claude-client && npm run test
cd ../codex-client && npm run test
cd ../gemini-client && npm run test
```

3. Dry-run package tarballs:

```bash
npm_config_cache=/tmp/discode-npm-cache npm pack --dry-run
```

## Publish

From each package root:

```bash
npm publish --access public
```

## Verify

1. Install in a fresh temp project.
2. Verify `import` and `require` both work.
3. Check npm README rendering and package metadata.
