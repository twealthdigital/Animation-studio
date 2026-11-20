import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';

export interface PendingBatch {
  batchId: string;
  source: string;
  commands: unknown[];
  createdAt: number;
  status: string;
}

interface PendingAckWaiter {
  resolve: (payload: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeMemoryStore {
  enabled: boolean;
  token: string;
  lastState: Record<string, unknown> | null;
  lastStateUpdatedAt: number;
  sseClients: Set<Response>;
  waiters: Map<string, PendingAckWaiter>;
  pendingBatches: PendingBatch[];
  history: PendingBatch[];
  ackResults: Map<string, Record<string, unknown>>;
}

function createToken(): string {
  const envTok = process.env.STAGECRAFT_TOKEN?.trim();
  if (envTok) return envTok;
  return `sc_${crypto.randomBytes(16).toString('hex')}`;
}

function getStore(): BridgeMemoryStore {
  const g = globalThis as unknown as { __stagecraftAiStore?: BridgeMemoryStore };
  if (!g.__stagecraftAiStore) {
    g.__stagecraftAiStore = {
      enabled: Boolean(process.env.STAGECRAFT_TOKEN?.trim()),
      token: createToken(),
      lastState: null,
      lastStateUpdatedAt: 0,
      sseClients: new Set<Response>(),
      waiters: new Map<string, PendingAckWaiter>(),
      pendingBatches: [],
      history: [],
      ackResults: new Map<string, Record<string, unknown>>(),
    };
  }
  return g.__stagecraftAiStore;
}

// Optional Vercel KV / Upstash Redis REST persistence for multi-lambda Vercel deployments
function getKvConfig(): { url: string; token: string } | null {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (url && token) return { url: url.replace(/\/$/, ''), token };
  return null;
}

async function kvCommand(args: unknown[]): Promise<unknown> {
  const kv = getKvConfig();
  if (!kv) return null;
  try {
    const res = await fetch(kv.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kv.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: unknown };
    return data.result ?? null;
  } catch {
    return null;
  }
}

interface PersistedSnapshot {
  enabled: boolean;
  token: string;
  lastState: Record<string, unknown> | null;
  lastStateUpdatedAt: number;
  pendingBatches: PendingBatch[];
}

async function loadPersistedBridge(): Promise<BridgeMemoryStore> {
  const store = getStore();
  if (!getKvConfig()) return store;
  const raw = await kvCommand(['GET', 'stagecraft:ai:bridge']);
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSnapshot>;
      if (typeof parsed.enabled === 'boolean') store.enabled = parsed.enabled;
      if (typeof parsed.token === 'string' && parsed.token) store.token = parsed.token;
      if (parsed.lastState && typeof parsed.lastState === 'object') store.lastState = parsed.lastState;
      if (typeof parsed.lastStateUpdatedAt === 'number') store.lastStateUpdatedAt = parsed.lastStateUpdatedAt;
      if (Array.isArray(parsed.pendingBatches)) store.pendingBatches = parsed.pendingBatches;
    } catch {
      // Ignore corrupt KV data
    }
  }
  return store;
}

async function savePersistedBridge(store: BridgeMemoryStore): Promise<void> {
  if (!getKvConfig()) return;
  const payload: PersistedSnapshot = {
    enabled: store.enabled,
    token: store.token,
    lastState: store.lastState,
    lastStateUpdatedAt: store.lastStateUpdatedAt,
    pendingBatches: store.pendingBatches.slice(-25),
  };
  await kvCommand(['SET', 'stagecraft:ai:bridge', JSON.stringify(payload), 'EX', 86400]);
}

function broadcastSse(store: BridgeMemoryStore, eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of store.sseClients) {
    try {
      res.write(payload);
    } catch {
      store.sseClients.delete(res);
    }
  }
}

function extractRequestAuth(req: Request): { token: string; key: string } {
  const auth = req.headers.authorization;
  let token = '';
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    token = auth.slice(7).trim();
  }
  const headerTok = req.headers['x-stagecraft-token'];
  if (!token && typeof headerTok === 'string' && headerTok.trim()) {
    token = headerTok.trim();
  }
  if (!token && typeof req.query.token === 'string' && req.query.token.trim()) {
    token = req.query.token.trim();
  }
  const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  return { token, key };
}

function isAuthorized(store: BridgeMemoryStore, req: Request, res: Response): boolean {
  const { token, key } = extractRequestAuth(req);
  const envConnectorKey = process.env.CONNECTOR_KEY?.trim();
  const envStageToken = process.env.STAGECRAFT_TOKEN?.trim();

  // If user configured CONNECTOR_KEY env var on Vercel and passed ?key=...
  if (envConnectorKey && key && key === envConnectorKey) {
    return true;
  }

  // If user configured STAGECRAFT_TOKEN env var and passed Bearer or ?token=...
  if (envStageToken && token && token === envStageToken) {
    return true;
  }

  if (!store.enabled) {
    res.status(403).json({
      ok: false,
      error: 'AI Live Access is disabled in Stagecraft 3D. Open AI Access and turn it ON.',
    });
    return false;
  }

  if (!token || token !== store.token) {
    res.status(401).json({
      ok: false,
      error: 'Invalid or missing AI token. Pass Authorization: Bearer <token> or ?token=<token>.',
    });
    return false;
  }
  return true;
}

export const COMMAND_SCHEMA_SUMMARY = {
  commands: [
    { op: 'select', targetKind: 'character|body-part|prop|light|camera|none', id: 'string', nodeId: 'optional string' },
    { op: 'move', targetId: 'string', nodeId: 'optional string', position: { x: 0, y: 0, z: 0 }, relative: false },
    { op: 'rotate', targetId: 'string', nodeId: 'optional string', rotationDeg: { x: 0, y: 0, z: 0 }, relative: false },
    { op: 'scale', targetId: 'string', nodeId: 'optional string', scale: { x: 1, y: 1, z: 1 } },
    { op: 'set_color', targetId: 'string', nodeId: 'optional string', color: '#hex', emissive: 'optional #hex' },
    { op: 'pose_part', characterId: 'string', nodeId: 'string (or nodeName)', rotationDeg: { x: 0, y: 0, z: 0 }, position: 'optional vec3', scale: 'optional vec3' },
    { op: 'reset_part', characterId: 'string', nodeId: 'string' },
    { op: 'detach_part', characterId: 'string', nodeId: 'string' },
    { op: 'ungroup_all', characterId: 'string' },
    { op: 'add_keyframe', targetId: 'string', nodeId: 'optional string', time: 'number (seconds)', easing: 'smooth|linear|easeIn|easeOut|easeInOut|step' },
    { op: 'add_prop', kind: 'box|sphere|cylinder|cone|podium|desk|chair|lamp|tree', name: 'string', color: '#hex', position: { x: 0, y: 0, z: 0 } },
    { op: 'delete_target', targetId: 'string' },
    { op: 'add_wall', side: 'back|left|right|front', color: '#hex', height: 8 },
    { op: 'update_stage', floorShape: 'square|rectangle|circle|polygon', floorSides: 4, floorSize: 28, floorColor: '#hex', showClouds: true, cloudColor: '#hex', floorLockEnabled: true, backgroundColor: '#hex' },
    { op: 'update_light', lightId: 'string', color: '#hex', intensity: 1.4, position: { x: 4, y: 8, z: 6 } },
    { op: 'set_camera_pose', position: { x: 0, y: 3, z: 12 }, target: { x: 0, y: 1.5, z: 0 }, fov: 40 },
    { op: 'set_time', time: 'number (seconds)' },
    { op: 'play', speed: 1 },
    { op: 'pause' },
    { op: 'bake_html_motion', characterId: 'string' },
    { op: 'rename_scene', name: 'string' },
  ],
};

async function dispatchCommandsToStudio(
  store: BridgeMemoryStore,
  commands: unknown[],
  source: string,
  waitForAck: boolean,
): Promise<Record<string, unknown>> {
  const batchId = `aibatch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const batch: PendingBatch = {
    batchId,
    source,
    commands,
    createdAt: Date.now(),
    status: 'queued',
  };

  store.pendingBatches.push(batch);
  if (store.pendingBatches.length > 40) {
    store.pendingBatches = store.pendingBatches.slice(-40);
  }
  store.history.unshift(batch);
  if (store.history.length > 50) store.history.length = 50;

  await savePersistedBridge(store);
  broadcastSse(store, 'ai:command', { batchId, source, commands, dispatchedAt: Date.now() });

  if (!waitForAck) {
    return {
      ok: true,
      batchId,
      queued: commands.length,
      note: 'Dispatched to Stagecraft 3D Watch Mode queue.',
    };
  }

  // Wait up to 3.5s for active browser viewport to ack (via in-memory waiter or KV ack polling)
  return new Promise((resolve) => {
    const kv = getKvConfig();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      store.waiters.delete(batchId);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({
        ok: true,
        batchId,
        queued: commands.length,
        note: 'Commands queued for live execution in the open Stagecraft 3D tab.',
        state: store.lastState,
      });
    }, 3500);

    store.waiters.set(batchId, {
      timer: timeout,
      resolve: (payload) => {
        cleanup();
        clearTimeout(timeout);
        resolve(payload);
      },
    });

    if (kv) {
      pollTimer = setInterval(async () => {
        const rawAck = await kvCommand(['GET', `stagecraft:ai:ack:${batchId}`]);
        if (typeof rawAck === 'string' && rawAck) {
          try {
            const parsedAck = JSON.parse(rawAck) as Record<string, unknown>;
            cleanup();
            clearTimeout(timeout);
            resolve(parsedAck);
          } catch {
            // Ignore
          }
        }
      }, 220);
    }
  });
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const store = await loadPersistedBridge();
  if (!isAuthorized(store, req, res)) return;

  const rpc = (req.body ?? {}) as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = rpc.id ?? null;

  const sessionId =
    (typeof req.headers['mcp-session-id'] === 'string' && req.headers['mcp-session-id']) ||
    `sc_sess_${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('Mcp-Session-Id', sessionId);

  if (rpc.method === 'initialize') {
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'stagecraft-3d-live-bridge', version: '1.1.0' },
      },
    });
    return;
  }

  if (rpc.method === 'notifications/initialized' || rpc.method === 'ping') {
    if (id === null) {
      res.status(202).end();
      return;
    }
    res.json({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (rpc.method === 'tools/list') {
    const tools = [
      {
        name: 'get_state',
        description:
          'Read the current Stagecraft 3D scene: stage, camera, lights, characters, rig parts/nodes, props, and selection. Call this before issuing commands so real IDs are used.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'run_commands',
        description:
          'Send live editing commands to Stagecraft 3D so the user watches every change animate in real time. Supports select, move, rotate, scale, set_color, pose_part, add_prop, add_wall, update_stage, update_light, add_keyframe, set_camera_pose, set_time, play, pause, bake_html_motion.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Optional AI name shown in Watch Mode log.' },
            commands: {
              type: 'array',
              description: 'Ordered list of Stagecraft 3D edit commands.',
              items: { type: 'object' },
            },
          },
          required: ['commands'],
        },
      },
    ];
    res.json({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (rpc.method === 'tools/call') {
    const toolName = String(rpc.params?.name ?? '');
    const toolArgs = (rpc.params?.arguments ?? {}) as Record<string, unknown>;

    if (toolName === 'get_state' || toolName === 'get_studio_state') {
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  studioConnected: store.sseClients.size > 0 || Date.now() - store.lastStateUpdatedAt < 15000,
                  state: store.lastState,
                  commandSchema: COMMAND_SCHEMA_SUMMARY,
                },
                null,
                2,
              ),
            },
          ],
        },
      });
      return;
    }

    if (toolName === 'run_commands' || toolName === 'execute_studio_commands') {
      const commands = Array.isArray(toolArgs.commands) ? toolArgs.commands : [];
      const source = typeof toolArgs.source === 'string' ? toolArgs.source : 'Claude / MCP AI';
      const outcome = await dispatchCommandsToStudio(store, commands, source, true);
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
        },
      });
      return;
    }

    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown MCP tool "${toolName}".` },
    });
    return;
  }

  res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unsupported MCP method "${rpc.method ?? ''}".` },
  });
}

export function mountAiBridge(app: Express): void {
  // Permissive CORS for external AIs, Claude connectors, ChatGPT Actions, and browser callers
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Stagecraft-Token, Mcp-Session-Id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Studio UI reads config
  app.get('/api/ai/config', async (_req, res) => {
    const store = await loadPersistedBridge();
    res.json({
      ok: true,
      enabled: store.enabled,
      token: store.token,
      connectedStudios:
        store.sseClients.size > 0
          ? store.sseClients.size
          : Date.now() - store.lastStateUpdatedAt < 15000
            ? 1
            : 0,
      hasKvPersistence: Boolean(getKvConfig()),
      recentBatches: store.history.slice(0, 15),
    });
  });

  // Studio UI updates enable/token
  app.post('/api/ai/config', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      regenerateToken?: boolean;
      token?: string;
    };
    if (typeof body.enabled === 'boolean') {
      store.enabled = body.enabled;
    }
    if (body.regenerateToken && !process.env.STAGECRAFT_TOKEN?.trim()) {
      store.token = `sc_${crypto.randomBytes(16).toString('hex')}`;
    } else if (typeof body.token === 'string' && body.token.trim() && !process.env.STAGECRAFT_TOKEN?.trim()) {
      store.token = body.token.trim();
    }
    await savePersistedBridge(store);
    broadcastSse(store, 'ai:config', {
      enabled: store.enabled,
      connectedStudios: store.sseClients.size,
    });
    res.json({
      ok: true,
      enabled: store.enabled,
      token: store.token,
      connectedStudios: store.sseClients.size,
    });
  });

  // Studio SSE stream (works continuously on Node / server.ts; on Vercel, client also polls /api/ai/poll)
  app.get('/api/ai/stream', async (req, res) => {
    const store = await loadPersistedBridge();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    store.sseClients.add(res);
    res.write(
      `event: ai:connected\ndata: ${JSON.stringify({
        enabled: store.enabled,
        connectedStudios: store.sseClients.size,
      })}\n\n`,
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      store.sseClients.delete(res);
    });
  });

  // Studio pushes live compact scene snapshot (and re-hydrates cold serverless lambdas if needed)
  app.post('/api/ai/sync-state', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      state?: Record<string, unknown>;
      enabled?: boolean;
      token?: string;
    };

    const nextState = body.state && typeof body.state === 'object' ? body.state : (body as Record<string, unknown>);
    if (nextState && typeof nextState === 'object') {
      store.lastState = nextState;
      store.lastStateUpdatedAt = Date.now();
    }
    if (typeof body.enabled === 'boolean') {
      store.enabled = body.enabled;
    }
    if (typeof body.token === 'string' && body.token.trim() && !process.env.STAGECRAFT_TOKEN?.trim()) {
      store.token = body.token.trim();
    }
    await savePersistedBridge(store);
    res.json({ ok: true, connectedStudios: Math.max(1, store.sseClients.size) });
  });

  // Studio serverless poll endpoint (fetches queued AI command batches cleanly without holding SSE open)
  app.get('/api/ai/poll', async (req, res) => {
    const store = await loadPersistedBridge();
    const afterMs = Number(req.query.after ?? 0) || 0;
    const batches = store.pendingBatches.filter((b) => b.createdAt > afterMs);
    if (batches.length > 0) {
      store.pendingBatches = store.pendingBatches.filter((b) => !batches.some((x) => x.batchId === b.batchId));
      await savePersistedBridge(store);
    }
    res.json({
      ok: true,
      enabled: store.enabled,
      batches,
    });
  });

  // Studio acknowledges command batch completion
  app.post('/api/ai/ack', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      batchId?: string;
      ok?: boolean;
      results?: unknown[];
      error?: string;
      state?: Record<string, unknown>;
    };
    if (body.state && typeof body.state === 'object') {
      store.lastState = body.state;
      store.lastStateUpdatedAt = Date.now();
    }
    if (body.batchId) {
      const entry = store.history.find((h) => h.batchId === body.batchId);
      if (entry) entry.status = body.ok === false ? 'error' : 'completed';
      const ackPayload: Record<string, unknown> = {
        ok: body.ok !== false,
        batchId: body.batchId,
        results: body.results ?? [],
        error: body.error,
        state: store.lastState,
      };
      store.ackResults.set(body.batchId, ackPayload);
      if (getKvConfig()) {
        await kvCommand(['SET', `stagecraft:ai:ack:${body.batchId}`, JSON.stringify(ackPayload), 'EX', 120]);
      }
      const waiter = store.waiters.get(body.batchId);
      if (waiter) {
        waiter.resolve(ackPayload);
      }
    }
    await savePersistedBridge(store);
    res.json({ ok: true });
  });

  // External AI: Read live scene state
  app.get('/api/ai/state', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    res.json({
      ok: true,
      studioConnected: store.sseClients.size > 0 || Date.now() - store.lastStateUpdatedAt < 15000,
      updatedAt: store.lastStateUpdatedAt,
      state: store.lastState,
      commandSchema: COMMAND_SCHEMA_SUMMARY,
    });
  });

  // External AI: Send live commands
  app.post('/api/ai/commands', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const body = (req.body ?? {}) as {
      commands?: unknown[];
      source?: string;
      wait?: boolean;
    };
    const commands = Array.isArray(body.commands) ? body.commands : [];
    if (commands.length === 0) {
      res.status(400).json({ ok: false, error: 'Provide a non-empty "commands" array.' });
      return;
    }
    const waitForAck = req.query.wait !== 'false' && body.wait !== false;
    const result = await dispatchCommandsToStudio(
      store,
      commands,
      typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'External AI',
      waitForAck,
    );
    res.json(result);
  });

  // External AI: MCP endpoints (both /api/ai/mcp and /api/mcp for Claude custom connectors!)
  app.post('/api/ai/mcp', (req, res) => {
    void handleMcpPost(req, res);
  });
  app.post('/api/mcp', (req, res) => {
    void handleMcpPost(req, res);
  });

  const handleMcpGet = async (req: Request, res: Response) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const accept = String(req.headers.accept ?? '');
    if (accept.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(': stagecraft-mcp-ready\n\n');
      res.end();
      return;
    }
    res.json({ ok: true, name: 'stagecraft-3d-live-bridge', transport: 'streamable-http' });
  };
  app.get('/api/ai/mcp', (req, res) => {
    void handleMcpGet(req, res);
  });
  app.get('/api/mcp', (req, res) => {
    void handleMcpGet(req, res);
  });

  app.delete('/api/ai/mcp', (_req, res) => {
    res.status(204).end();
  });
  app.delete('/api/mcp', (_req, res) => {
    res.status(204).end();
  });

  // External AI: OpenAPI 3.1 schema for ChatGPT Actions & HTTP agents
  app.get('/api/ai/openapi.json', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;
    res.json({
      openapi: '3.1.0',
      info: {
        title: 'Stagecraft 3D Live AI Bridge',
        version: '1.1.0',
        description:
          'Allows any external AI assistant to inspect and edit the live 3D Stagecraft scene while the user watches in real time.',
      },
      servers: [{ url: baseUrl }],
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ BearerAuth: [] }],
      paths: {
        '/api/ai/state': {
          get: {
            operationId: 'getStudioState',
            summary: 'Read the full live 3D scene state and command schema',
            responses: { '200': { description: 'Current studio snapshot' } },
          },
        },
        '/api/ai/commands': {
          post: {
            operationId: 'executeStudioCommands',
            summary: 'Apply one or more live edits to Stagecraft 3D',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['commands'],
                    properties: {
                      source: { type: 'string' },
                      commands: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'Execution summary and updated state' } },
          },
        },
      },
    });
  });
}
