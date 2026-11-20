import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

interface PendingAckWaiter {
  resolve: (payload: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createToken(): string {
  return `sc_${crypto.randomBytes(16).toString('hex')}`;
}

const aiBridge = {
  enabled: false,
  token: createToken(),
  lastState: null as Record<string, unknown> | null,
  lastStateUpdatedAt: 0,
  sseClients: new Set<Response>(),
  waiters: new Map<string, PendingAckWaiter>(),
  history: [] as {
    batchId: string;
    source: string;
    commands: unknown[];
    createdAt: number;
    status: string;
  }[],
};

function broadcastSse(eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of aiBridge.sseClients) {
    try {
      res.write(payload);
    } catch {
      aiBridge.sseClients.delete(res);
    }
  }
}

function extractBearerToken(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const headerTok = req.headers['x-stagecraft-token'];
  if (typeof headerTok === 'string' && headerTok.trim()) {
    return headerTok.trim();
  }
  const queryTok = req.query.token;
  if (typeof queryTok === 'string' && queryTok.trim()) {
    return queryTok.trim();
  }
  return '';
}

function requireAiAccess(req: Request, res: Response): boolean {
  if (!aiBridge.enabled) {
    res.status(403).json({
      ok: false,
      error: 'AI Live Access is disabled in Stagecraft 3D. Enable it in the AI Access drawer.',
    });
    return false;
  }
  const provided = extractBearerToken(req);
  if (!provided || provided !== aiBridge.token) {
    res.status(401).json({
      ok: false,
      error: 'Invalid or missing AI Access token. Pass Authorization: Bearer <token>.',
    });
    return false;
  }
  return true;
}

const COMMAND_SCHEMA_SUMMARY = {
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

function dispatchCommandsToStudio(
  commands: unknown[],
  source: string,
  waitForAck: boolean,
): Promise<Record<string, unknown>> {
  const batchId = `aibatch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  aiBridge.history.unshift({
    batchId,
    source,
    commands,
    createdAt: Date.now(),
    status: aiBridge.sseClients.size > 0 ? 'dispatched' : 'queued-no-studio',
  });
  if (aiBridge.history.length > 50) aiBridge.history.length = 50;

  broadcastSse('ai:command', { batchId, source, commands, dispatchedAt: Date.now() });

  if (!waitForAck || aiBridge.sseClients.size === 0) {
    return Promise.resolve({
      ok: true,
      batchId,
      queued: commands.length,
      studioConnected: aiBridge.sseClients.size > 0,
      note:
        aiBridge.sseClients.size === 0
          ? 'No active Stagecraft 3D tab connected yet; open the studio in a browser.'
          : 'Dispatched asynchronously to Stagecraft 3D.',
    });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      aiBridge.waiters.delete(batchId);
      resolve({
        ok: true,
        batchId,
        queued: commands.length,
        timedOutWaitingForSlowMo: true,
        note: 'Commands are executing in Watch Mode (Slow-Motion or Paused).',
        state: aiBridge.lastState,
      });
    }, 3500);

    aiBridge.waiters.set(batchId, { resolve, timer });
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Permissive CORS for external AI tools, local agents, and browser callers
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Stagecraft-Token');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Studio UI config routes
  app.get('/api/ai/config', (_req, res) => {
    res.json({
      ok: true,
      enabled: aiBridge.enabled,
      token: aiBridge.token,
      connectedStudios: aiBridge.sseClients.size,
      recentBatches: aiBridge.history.slice(0, 15),
    });
  });

  app.post('/api/ai/config', (req, res) => {
    const body = (req.body ?? {}) as { enabled?: boolean; regenerateToken?: boolean };
    if (typeof body.enabled === 'boolean') {
      aiBridge.enabled = body.enabled;
    }
    if (body.regenerateToken) {
      aiBridge.token = createToken();
    }
    broadcastSse('ai:config', {
      enabled: aiBridge.enabled,
      connectedStudios: aiBridge.sseClients.size,
    });
    res.json({
      ok: true,
      enabled: aiBridge.enabled,
      token: aiBridge.token,
      connectedStudios: aiBridge.sseClients.size,
    });
  });

  // Studio SSE stream
  app.get('/api/ai/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    aiBridge.sseClients.add(res);
    res.write(
      `event: ai:connected\ndata: ${JSON.stringify({
        enabled: aiBridge.enabled,
        connectedStudios: aiBridge.sseClients.size,
      })}\n\n`,
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      aiBridge.sseClients.delete(res);
    });
  });

  // Studio pushes live compact scene snapshot
  app.post('/api/ai/sync-state', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body === 'object') {
      aiBridge.lastState = body;
      aiBridge.lastStateUpdatedAt = Date.now();
    }
    res.json({ ok: true, connectedStudios: aiBridge.sseClients.size });
  });

  // Studio acknowledges command batch completion
  app.post('/api/ai/ack', (req, res) => {
    const body = (req.body ?? {}) as {
      batchId?: string;
      ok?: boolean;
      results?: unknown[];
      error?: string;
      state?: Record<string, unknown>;
    };
    if (body.state && typeof body.state === 'object') {
      aiBridge.lastState = body.state;
      aiBridge.lastStateUpdatedAt = Date.now();
    }
    if (body.batchId) {
      const entry = aiBridge.history.find((h) => h.batchId === body.batchId);
      if (entry) entry.status = body.ok === false ? 'error' : 'completed';
      const waiter = aiBridge.waiters.get(body.batchId);
      if (waiter) {
        clearTimeout(waiter.timer);
        aiBridge.waiters.delete(body.batchId);
        waiter.resolve({
          ok: body.ok !== false,
          batchId: body.batchId,
          results: body.results ?? [],
          error: body.error,
          state: aiBridge.lastState,
        });
      }
    }
    res.json({ ok: true });
  });

  // External AI: Read full live scene state
  app.get('/api/ai/state', (req, res) => {
    if (!requireAiAccess(req, res)) return;
    res.json({
      ok: true,
      studioConnected: aiBridge.sseClients.size > 0,
      updatedAt: aiBridge.lastStateUpdatedAt,
      state: aiBridge.lastState,
      commandSchema: COMMAND_SCHEMA_SUMMARY,
    });
  });

  // External AI: Execute live edit commands while user watches
  app.post('/api/ai/commands', async (req, res) => {
    if (!requireAiAccess(req, res)) return;
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
      commands,
      typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'External AI',
      waitForAck,
    );
    res.json(result);
  });

  // External AI: MCP (Model Context Protocol) JSON-RPC 2.0 endpoint for Claude Desktop / Cursor / Windsurf
  app.post('/api/ai/mcp', async (req, res) => {
    if (!requireAiAccess(req, res)) return;
    const rpc = (req.body ?? {}) as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    const id = rpc.id ?? null;

    if (rpc.method === 'initialize') {
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stagecraft-3d-live-bridge', version: '1.0.0' },
        },
      });
      return;
    }

    if (rpc.method === 'notifications/initialized') {
      res.json({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (rpc.method === 'tools/list') {
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'get_studio_state',
              description:
                'Inspect the active Stagecraft 3D scene: all characters, rig joints/parts, props, stage floor/walls/clouds, lights, cameras, playhead time, and supported command formats.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
              name: 'execute_studio_commands',
              description:
                'Send live 3D editing commands to Stagecraft 3D so the user can watch every edit animate live in the viewport.',
              inputSchema: {
                type: 'object',
                properties: {
                  source: { type: 'string', description: 'Optional AI agent label shown in Watch Mode log.' },
                  commands: {
                    type: 'array',
                    description: 'Ordered list of Stagecraft 3D edit commands.',
                    items: { type: 'object' },
                  },
                },
                required: ['commands'],
              },
            },
          ],
        },
      });
      return;
    }

    if (rpc.method === 'tools/call') {
      const toolName = String(rpc.params?.name ?? '');
      const toolArgs = (rpc.params?.arguments ?? {}) as Record<string, unknown>;

      if (toolName === 'get_studio_state') {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    studioConnected: aiBridge.sseClients.size > 0,
                    state: aiBridge.lastState,
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

      if (toolName === 'execute_studio_commands') {
        const commands = Array.isArray(toolArgs.commands) ? toolArgs.commands : [];
        const source = typeof toolArgs.source === 'string' ? toolArgs.source : 'MCP AI Agent';
        const outcome = await dispatchCommandsToStudio(commands, source, true);
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
  });

  // External AI: OpenAPI 3.1 schema for ChatGPT Actions & HTTP agents
  app.get('/api/ai/openapi.json', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${PORT}`;
    const baseUrl = `${proto}://${host}`;
    res.json({
      openapi: '3.1.0',
      info: {
        title: 'Stagecraft 3D Live AI Bridge',
        version: '1.0.0',
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

  if (IS_PROD) {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Stagecraft 3D] Server + AI Bridge listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Stagecraft server:', err);
  process.exit(1);
});
