# Phase 2: Memory System

**Goal:** Implement local embeddings and vector search for persistent memory.

## Overview

The memory system provides:
- **Local embeddings** via node-llama-cpp (no API calls, fully private)
- **Vector search** via sqlite-vec extension
- **Hybrid search** combining vector similarity + full-text search
- **Memory persistence** with configurable retention

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MEMORY MANAGER                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Embedding │  │   Vector    │  │    FTS      │              │
│  │   Provider  │  │   Search    │  │   Search    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    SQLITE + SQLITE-VEC                       ││
│  │  - memory_chunks (id, content, embedding, metadata)         ││
│  │  - memory_fts (FTS5 virtual table)                          ││
│  │  - embedding_cache (hash -> embedding)                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Files to Create

```
squire/src/memory/
├── manager.ts              # Main MemoryManager class
├── embeddings.ts           # Embedding providers (local + API)
├── search.ts               # Hybrid search implementation
├── schema.sql              # Database schema
└── types.ts                # Memory-specific types
```

## Database Schema (schema.sql)

```sql
-- Main memory storage
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  workspace_id TEXT,
  embedding BLOB,            -- sqlite-vec format
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  access_count INTEGER DEFAULT 0
);

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id,
  content,
  source,
  tokenize='porter unicode61'
);

-- Embedding cache (avoid re-computing)
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash TEXT PRIMARY KEY,
  embedding BLOB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_chunks(source);
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_chunks(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_chunks(expires_at);

-- Trigger to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_fts (id, content, source) VALUES (
    NEW.id, NEW.content, NEW.source
  );
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_chunks BEGIN
  DELETE FROM memory_fts WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_chunks BEGIN
  UPDATE memory_fts SET content = NEW.content, source = NEW.source WHERE id = NEW.id;
END;
```

## Embedding Provider (embeddings.ts)

```typescript
import { getLlama, Llama, LlamaModel, LlamaEmbeddingContext } from 'node-llama-cpp';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { MemoryConfig } from '../types.js';

const DEFAULT_MODEL = 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf';
const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'squire', 'models');
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimension(): number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private config: MemoryConfig;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private embedContext: LlamaEmbeddingContext | null = null;
  private lastUsed: number = 0;
  private unloadTimer: NodeJS.Timeout | null = null;
  private modelPath: string;

  constructor(config: MemoryConfig, dataDir: string) {
    this.config = config;
    this.modelPath = config.embeddingModel || DEFAULT_MODEL;

    // Ensure cache directory exists
    if (!fs.existsSync(MODEL_CACHE_DIR)) {
      fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.embedContext) {
      this.scheduleUnload();
      return;
    }

    console.log('[Embeddings] Loading model...');

    this.llama = await getLlama();
    this.model = await this.llama.loadModel({
      modelPath: this.modelPath,
      useMmap: true
    });

    this.embedContext = await this.model.createEmbeddingContext({
      contextSize: 512
    });

    console.log('[Embeddings] Model loaded');
    this.scheduleUnload();
  }

  private scheduleUnload(): void {
    this.lastUsed = Date.now();

    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
    }

    this.unloadTimer = setTimeout(() => {
      if (Date.now() - this.lastUsed >= INACTIVITY_TIMEOUT_MS) {
        this.unload();
      }
    }, INACTIVITY_TIMEOUT_MS);
  }

  private unload(): void {
    if (this.embedContext) {
      console.log('[Embeddings] Unloading model due to inactivity');
      this.embedContext = null;
      this.model = null;
      this.llama = null;
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureLoaded();

    const embedding = await this.embedContext!.getEmbeddingFor(text);
    return Array.from(embedding.vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureLoaded();

    const results = await Promise.all(
      texts.map(t => this.embedContext!.getEmbeddingFor(t))
    );

    return results.map(e => Array.from(e.vector));
  }

  getDimension(): number {
    // embeddinggemma-300M produces 256-dimensional vectors
    return 256;
  }
}

// Optional: API-based providers for users who prefer them
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: text
      })
    });

    const data = await response.json();
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    const data = await response.json();
    return data.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
  }

  getDimension(): number {
    return this.model.includes('large') ? 3072 : 1536;
  }
}

export function createEmbeddingProvider(config: MemoryConfig, dataDir: string): EmbeddingProvider {
  switch (config.provider) {
    case 'local':
      return new LocalEmbeddingProvider(config, dataDir);
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY required for OpenAI embedding provider');
      }
      return new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY, config.embeddingModel);
    default:
      return new LocalEmbeddingProvider(config, dataDir);
  }
}
```

## Search Implementation (search.ts)

```typescript
import Database from 'better-sqlite3';
import type { MemoryEntry, MemorySearchResult } from '../types.js';

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  source?: string;
  workspaceId?: string;
  hybridWeight?: number; // 0 = FTS only, 1 = vector only, 0.5 = balanced
}

export class HybridSearch {
  private db: Database.Database;
  private embeddingProvider: EmbeddingProvider;

  constructor(db: Database.Database, embeddingProvider: EmbeddingProvider) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
  }

  async search(query: string, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const {
      limit = 10,
      minScore = 0.5,
      source,
      workspaceId,
      hybridWeight = 0.6 // Slight preference for semantic search
    } = options;

    // Get vector results
    const queryEmbedding = await this.embeddingProvider.embed(query);
    const vectorResults = this.vectorSearch(queryEmbedding, limit * 2);

    // Get FTS results
    const ftsResults = this.ftsSearch(query, limit * 2, source, workspaceId);

    // Combine scores
    return this.combineResults(vectorResults, ftsResults, hybridWeight)
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  private vectorSearch(embedding: number[], limit: number): Map<string, number> {
    const results = new Map<string, number>();

    // sqlite-vec cosine similarity query
    const rows = this.db.prepare(`
      SELECT
        id,
        vec_distance_cosine(embedding, ?) as distance
      FROM memory_chunks
      WHERE embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ?
    `).all(this.embeddingToBlob(embedding), limit);

    for (const row of rows as any[]) {
      // Convert distance to similarity score (0-1)
      const similarity = 1 - row.distance;
      results.set(row.id, similarity);
    }

    return results;
  }

  private ftsSearch(query: string, limit: number, source?: string, workspaceId?: string): Map<string, number> {
    const results = new Map<string, number>();

    // Escape special FTS characters
    const escapedQuery = query.replace(/['"-]/g, ' ').trim();

    let sql = `
      SELECT
        m.id,
        bm25(memory_fts) as score
      FROM memory_fts fts
      JOIN memory_chunks m ON fts.id = m.id
      WHERE memory_fts MATCH ?
    `;

    const params: any[] = [escapedQuery];

    if (source) {
      sql += ' AND m.source = ?';
      params.push(source);
    }

    if (workspaceId) {
      sql += ' AND m.workspace_id = ?';
      params.push(workspaceId);
    }

    sql += ` ORDER BY score ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);

    // BM25 returns negative scores; normalize to 0-1
    const maxScore = Math.max(...(rows as any[]).map(r => Math.abs(r.score)));

    for (const row of rows as any[]) {
      const normalizedScore = Math.abs(row.score) / (maxScore || 1);
      results.set(row.id, normalizedScore);
    }

    return results;
  }

  private combineResults(
    vectorResults: Map<string, number>,
    ftsResults: Map<string, number>,
    hybridWeight: number
  ): MemorySearchResult[] {
    const allIds = new Set([...vectorResults.keys(), ...ftsResults.keys()]);
    const combined: MemorySearchResult[] = [];

    for (const id of allIds) {
      const vectorScore = vectorResults.get(id) || 0;
      const ftsScore = ftsResults.get(id) || 0;

      const combinedScore = (vectorScore * hybridWeight) + (ftsScore * (1 - hybridWeight));

      // Fetch entry details
      const row = this.db.prepare('SELECT * FROM memory_chunks WHERE id = ?').get(id) as any;

      if (row) {
        combined.push({
          entry: {
            id: row.id,
            content: row.content,
            source: row.source,
            workspaceId: row.workspace_id,
            metadata: JSON.parse(row.metadata || '{}'),
            createdAt: row.created_at,
            expiresAt: row.expires_at
          },
          score: combinedScore
        });
      }
    }

    return combined.sort((a, b) => b.score - a.score);
  }

  private embeddingToBlob(embedding: number[]): Buffer {
    // sqlite-vec expects float32 array
    const buffer = Buffer.alloc(embedding.length * 4);
    for (let i = 0; i < embedding.length; i++) {
      buffer.writeFloatLE(embedding[i], i * 4);
    }
    return buffer;
  }
}
```

## Memory Manager (manager.ts)

```typescript
import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import type { MemoryEntry, MemorySearchResult, MemoryConfig } from '../types.js';
import { createEmbeddingProvider, EmbeddingProvider } from './embeddings.js';
import { HybridSearch, SearchOptions } from './search.js';

const SCHEMA = `...`; // Schema SQL from above

export class MemoryManager {
  private config: MemoryConfig;
  private db: Database.Database;
  private embeddingProvider: EmbeddingProvider;
  private search: HybridSearch;
  private dataDir: string;

  constructor(config: MemoryConfig, dataDir: string) {
    this.config = config;
    this.dataDir = dataDir;
  }

  async initialize(): Promise<void> {
    const dbPath = path.join(this.dataDir, 'memory.db');
    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    this.db.loadExtension(path.join(this.dataDir, 'sqlite-vec'));

    // Create schema
    this.db.exec(SCHEMA);

    // Initialize embedding provider
    this.embeddingProvider = createEmbeddingProvider(this.config, this.dataDir);

    // Initialize search
    this.search = new HybridSearch(this.db, this.embeddingProvider);

    // Clean up expired memories
    this.cleanExpired();

    console.log('[Memory] Initialized');
  }

  async add(
    content: string,
    options?: {
      source?: MemoryEntry['source'];
      workspaceId?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<MemoryEntry> {
    const id = crypto.randomUUID();
    const source = options?.source || 'user';
    const workspaceId = options?.workspaceId || null;
    const metadata = options?.metadata || {};

    // Compute embedding
    const embedding = await this.embeddingProvider.embed(content);
    const embeddingBlob = this.embeddingToBlob(embedding);

    // Calculate expiration
    const expiresAt = this.config.retentionDays
      ? new Date(Date.now() + this.config.retentionDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Insert
    this.db.prepare(`
      INSERT INTO memory_chunks (id, content, source, workspace_id, embedding, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, content, source, workspaceId, embeddingBlob, JSON.stringify(metadata), expiresAt);

    return {
      id,
      content,
      source,
      workspaceId: workspaceId || undefined,
      embedding,
      metadata,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt || undefined
    };
  }

  async search(query: string, limit?: number, options?: Omit<SearchOptions, 'limit'>): Promise<MemorySearchResult[]> {
    return this.search.search(query, { ...options, limit });
  }

  get(id: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM memory_chunks WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      content: row.content,
      source: row.source,
      workspaceId: row.workspace_id,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memory_chunks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  forget(query: string, limit?: number): number {
    // Find matching memories
    const results = this.search.search(query, { limit: limit || 10 });

    // Delete them
    let deleted = 0;
    for (const result of results) {
      if (this.delete(result.entry.id)) {
        deleted++;
      }
    }

    return deleted;
  }

  reflect(): void {
    // Summarize and consolidate memories
    // This would be called periodically to compress old memories
    // TODO: Implement memory consolidation
  }

  private cleanExpired(): void {
    const result = this.db.prepare(`
      DELETE FROM memory_chunks
      WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
    `).run();

    if (result.changes > 0) {
      console.log(`[Memory] Cleaned ${result.changes} expired memories`);
    }
  }

  private embeddingToBlob(embedding: number[]): Buffer {
    const buffer = Buffer.alloc(embedding.length * 4);
    for (let i = 0; i < embedding.length; i++) {
      buffer.writeFloatLE(embedding[i], i * 4);
    }
    return buffer;
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
```

## Memory Tools for Agent

These are MCP-like tools the agent can use:

```typescript
// squire/src/mcp/memory-tools.ts

export const memoryTools = [
  {
    name: 'memory_remember',
    description: 'Store a fact or piece of information in long-term memory',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The information to remember' },
        source: { type: 'string', enum: ['user', 'squire', 'skill', 'document'] }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_recall',
    description: 'Search memories for relevant information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'Max results', default: 5 }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_forget',
    description: 'Remove memories matching a query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Which memories to forget' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_reflect',
    description: 'Summarize and consolidate old memories',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];
```

## Dependencies

```json
{
  "dependencies": {
    "node-llama-cpp": "^3.0.0",
    "better-sqlite3": "^11.0.0"
  }
}
```

**Note on sqlite-vec:** Requires the sqlite-vec extension to be compiled for your platform. Consider bundling prebuilt binaries or using a package like `sqlite-vec-prebuild`.

## Testing

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryManager } from '../dist/memory/manager.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('Memory stores and retrieves', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-'));

  const memory = new MemoryManager({
    enabled: true,
    provider: 'local',
    retentionDays: 30
  }, tempDir);

  await memory.initialize();

  // Store
  await memory.remember('User prefers dark mode in all applications');

  // Retrieve
  const results = await memory.recall('UI preferences');
  assert.ok(results.length > 0);
  assert.ok(results[0].entry.content.includes('dark mode'));

  memory.close();
  fs.rmSync(tempDir, { recursive: true });
});

test('Hybrid search combines vector and FTS', async () => {
  // ... test hybrid search specifically
});
```

## Next Phase

- **Phase 3**: Skills system with YAML frontmatter
