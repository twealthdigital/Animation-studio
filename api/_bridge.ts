import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';

export interface PendingBatch {
  batchId: string;
  sessionId: string;
  sceneId: string;
  sceneName: string;
  source: string;
  commands: unknown[];
  createdAt: number;
  status: string;
}

export interface AiSessionRecord {
  sessionId: string;
  label: string;
  sceneId: string;
  sceneName: string;
  createdAt: number;
  lastActivityAt: number;
  batchCount: number;
  state: Record<string, unknown> | null;
}

interface PendingAckWaiter {
  resolve: (payload: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StoredCloudProject {
  syncCode: string;
  projectName: string;
  updatedAt: number;
  project: Record<string, unknown>;
  assets: unknown[];
}

interface BridgeMemoryStore {
  enabled: boolean;
  token: string;
  sessionCounter: number;
  sessions: Record<string, AiSessionRecord>;
  lastState: Record<string, unknown> | null;
  lastStateUpdatedAt: number;
  sseClients: Set<Response>;
  waiters: Map<string, PendingAckWaiter>;
  pendingBatches: PendingBatch[];
  history: PendingBatch[];
  ackResults: Map<string, Record<string, unknown>>;
  cloudProjects: Record<string, StoredCloudProject>;
}

const DATA_DIR = path.join(process.cwd(), '.stagecraft-data');
const BRIDGE_DISK_FILE = path.join(DATA_DIR, 'bridge-store.json');

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
      sessionCounter: 0,
      sessions: {},
      lastState: null,
      lastStateUpdatedAt: 0,
      sseClients: new Set<Response>(),
      waiters: new Map<string, PendingAckWaiter>(),
      pendingBatches: [],
      history: [],
      ackResults: new Map<string, Record<string, unknown>>(),
      cloudProjects: {},
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
  sessionCounter: number;
  sessions: Record<string, AiSessionRecord>;
  lastState: Record<string, unknown> | null;
  lastStateUpdatedAt: number;
  pendingBatches: PendingBatch[];
}

function pruneOldSessions(store: BridgeMemoryStore): void {
  const keys = Object.keys(store.sessions);
  if (keys.length <= 24) return;
  keys
    .sort((a, b) => store.sessions[a].lastActivityAt - store.sessions[b].lastActivityAt)
    .slice(0, keys.length - 24)
    .forEach((k) => {
      delete store.sessions[k];
    });
}

async function loadPersistedBridge(): Promise<BridgeMemoryStore> {
  const store = getStore();
  let raw: string | null = null;

  if (getKvConfig()) {
    const kvRaw = await kvCommand(['GET', 'stagecraft:ai:bridge']);
    if (typeof kvRaw === 'string' && kvRaw) raw = kvRaw;
  } else {
    try {
      raw = await fs.readFile(BRIDGE_DISK_FILE, 'utf8');
    } catch {
      // Read-only / missing local file is expected on serverless
    }
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSnapshot>;
      if (typeof parsed.enabled === 'boolean') store.enabled = parsed.enabled;
      if (typeof parsed.token === 'string' && parsed.token && !process.env.STAGECRAFT_TOKEN?.trim()) {
        store.token = parsed.token;
      }
      if (typeof parsed.sessionCounter === 'number' && parsed.sessionCounter > store.sessionCounter) {
        store.sessionCounter = parsed.sessionCounter;
      }
      if (parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [sid, srec] of Object.entries(parsed.sessions)) {
          if (!store.sessions[sid] || srec.lastActivityAt >= store.sessions[sid].lastActivityAt) {
            store.sessions[sid] = srec;
          }
        }
      }
      if (parsed.lastState && typeof parsed.lastState === 'object') store.lastState = parsed.lastState;
      if (typeof parsed.lastStateUpdatedAt === 'number') store.lastStateUpdatedAt = parsed.lastStateUpdatedAt;
      if (Array.isArray(parsed.pendingBatches) && parsed.pendingBatches.length > 0) {
        const known = new Set(store.pendingBatches.map((b) => b.batchId));
        for (const pb of parsed.pendingBatches) {
          if (!known.has(pb.batchId)) store.pendingBatches.push(pb);
        }
      }
    } catch {
      // Ignore corrupt snapshot
    }
  }
  return store;
}

async function savePersistedBridge(store: BridgeMemoryStore): Promise<void> {
  pruneOldSessions(store);
  const payload: PersistedSnapshot = {
    enabled: store.enabled,
    token: store.token,
    sessionCounter: store.sessionCounter,
    sessions: store.sessions,
    lastState: store.lastState,
    lastStateUpdatedAt: store.lastStateUpdatedAt,
    pendingBatches: store.pendingBatches.slice(-30),
  };
  const serialized = JSON.stringify(payload);
  if (getKvConfig()) {
    await kvCommand(['SET', 'stagecraft:ai:bridge', serialized, 'EX', 86400]);
  } else {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(BRIDGE_DISK_FILE, serialized, 'utf8');
    } catch {
      // Ignore on read-only serverless filesystems
    }
  }
}

function buildStarterSessionState(
  sessionId: string,
  sceneId: string,
  sceneName: string,
  baseState: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    sessionId,
    projectName: typeof baseState?.projectName === 'string' ? baseState.projectName : 'Stagecraft Project',
    sceneId,
    sceneName,
    duration: 10,
    currentTime: 0,
    isPlaying: false,
    backgroundColor: '#17191f',
    stageConfig: {
      floorShape: 'square',
      floorSides: 4,
      floorSize: 28,
      floorColor: '#1b1e24',
      floorRoughness: 0.88,
      gridColor: '#3a404d',
      gridSecondaryColor: '#262a33',
      showClouds: true,
      cloudColor: '#cbd5e1',
      cloudOpacity: 0.42,
      floorLockEnabled: true,
      walls: [],
    },
    camera: {
      position: { x: 0, y: 3.2, z: 11.5 },
      target: { x: 0, y: 1.4, z: 0 },
      fov: 40,
    },
    selection: { kind: 'none' },
    characters: [],
    props: [],
    lights: [
      {
        id: 'light_hemi_default',
        name: 'Ambient Hemisphere',
        kind: 'ambient',
        color: '#cbe2ff',
        intensity: 0.75,
        position: { x: 0, y: 8, z: 0 },
      },
      {
        id: 'light_key_default',
        name: 'Key Directional',
        kind: 'directional',
        color: '#ffe6cc',
        intensity: 1.45,
        position: { x: 5, y: 9, z: 7 },
      },
      {
        id: 'light_rim_default',
        name: 'Rim Directional',
        kind: 'directional',
        color: '#8bb8ff',
        intensity: 0.65,
        position: { x: -6, y: 4, z: -6 },
      },
    ],
  };
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

function createFreshAiSession(
  store: BridgeMemoryStore,
  requestedLabel?: string,
  requestedSessionId?: string,
): { session: AiSessionRecord; createdBatch: PendingBatch } {
  store.sessionCounter += 1;
  const num = store.sessionCounter;
  const sessionId =
    requestedSessionId && requestedSessionId.trim()
      ? requestedSessionId.trim()
      : `sc_sess_${crypto.randomBytes(6).toString('hex')}`;
  const cleanLabel = requestedLabel?.trim()
    ? `${requestedLabel.trim()} #${num}`
    : `Claude Session #${num}`;
  const sceneId = `scene_ai_${crypto.randomBytes(4).toString('hex')}`;
  const sceneName = cleanLabel;
  const now = Date.now();

  const session: AiSessionRecord = {
    sessionId,
    label: cleanLabel,
    sceneId,
    sceneName,
    createdAt: now,
    lastActivityAt: now,
    batchCount: 0,
    state: buildStarterSessionState(sessionId, sceneId, sceneName, store.lastState),
  };

  store.sessions[sessionId] = session;

  // Queue immediate scene creation in Stagecraft Studio so UI creates the isolated scene ASAP
  const createdBatch: PendingBatch = {
    batchId: `aibatch_${now}_${crypto.randomBytes(3).toString('hex')}`,
    sessionId,
    sceneId,
    sceneName,
    source: cleanLabel,
    commands: [
      {
        op: 'create_session',
        sessionId,
        sceneId,
        sceneName,
      },
    ],
    createdAt: now,
    status: 'queued',
  };
  store.pendingBatches.push(createdBatch);
  if (store.pendingBatches.length > 50) store.pendingBatches = store.pendingBatches.slice(-50);
  broadcastSse(store, 'ai:command', {
    ...createdBatch,
    dispatchedAt: now,
  });

  return { session, createdBatch };
}

function listSessionSummaries(store: BridgeMemoryStore) {
  return Object.values(store.sessions)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((s) => ({
      sessionId: s.sessionId,
      label: s.label,
      sceneId: s.sceneId,
      sceneName: s.sceneName,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      batchCount: s.batchCount,
    }));
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

  if (envConnectorKey && key && key === envConnectorKey) {
    return true;
  }

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
    { op: 'create_session', sceneName: 'optional string', note: 'Starts a new isolated scene session immediately.' },
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
  session: AiSessionRecord,
  commands: unknown[],
  source: string,
  waitForAck: boolean,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const batchId = `aibatch_${now}_${crypto.randomBytes(3).toString('hex')}`;
  session.lastActivityAt = now;
  session.batchCount += 1;

  const batch: PendingBatch = {
    batchId,
    sessionId: session.sessionId,
    sceneId: session.sceneId,
    sceneName: session.sceneName,
    source,
    commands,
    createdAt: now,
    status: 'queued',
  };

  store.pendingBatches.push(batch);
  if (store.pendingBatches.length > 50) {
    store.pendingBatches = store.pendingBatches.slice(-50);
  }
  store.history.unshift(batch);
  if (store.history.length > 60) store.history.length = 60;

  await savePersistedBridge(store);
  broadcastSse(store, 'ai:command', {
    ...batch,
    dispatchedAt: now,
  });

  if (!waitForAck) {
    return {
      ok: true,
      sessionId: session.sessionId,
      sceneId: session.sceneId,
      sceneName: session.sceneName,
      batchId,
      queued: commands.length,
      note: 'Dispatched to your isolated Stagecraft 3D Watch Mode session.',
    };
  }

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
        sessionId: session.sessionId,
        sceneId: session.sceneId,
        sceneName: session.sceneName,
        batchId,
        queued: commands.length,
        note: 'Commands queued for live execution in your isolated Stagecraft 3D session.',
        state: session.state ?? store.lastState,
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

function resolveOrCreateSession(
  store: BridgeMemoryStore,
  req: Request,
  explicitSessionId?: string,
  clientLabel?: string,
): { session: AiSessionRecord; createdNew: boolean } {
  const headerSess =
    typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';
  const querySess = typeof req.query.session === 'string' ? req.query.session.trim() : '';
  const candidateId = explicitSessionId?.trim() || headerSess || querySess;

  if (candidateId && store.sessions[candidateId]) {
    const existing = store.sessions[candidateId];
    existing.lastActivityAt = Date.now();
    return { session: existing, createdNew: false };
  }

  const { session } = createFreshAiSession(store, clientLabel, candidateId || undefined);
  return { session, createdNew: true };
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

  if (rpc.method === 'initialize') {
    // Always create a brand-new isolated session on initialize (unless caller explicitly pinned ?session=)
    const clientInfo = (rpc.params?.clientInfo ?? {}) as { name?: string };
    const clientLabel = typeof clientInfo.name === 'string' && clientInfo.name.trim()
      ? clientInfo.name.trim()
      : 'Claude';
    const pinnedQuerySess = typeof req.query.session === 'string' ? req.query.session.trim() : '';
    const { session } = pinnedQuerySess && store.sessions[pinnedQuerySess]
      ? { session: store.sessions[pinnedQuerySess] }
      : createFreshAiSession(store, clientLabel, pinnedQuerySess || undefined);
    session.lastActivityAt = Date.now();
    await savePersistedBridge(store);

    res.setHeader('Mcp-Session-Id', session.sessionId);
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'stagecraft-3d-live-bridge',
          version: '1.2.0',
        },
        instructions: `Connected to your own isolated Stagecraft 3D session (${session.sessionId} -> scene "${session.sceneName}"). Multiple AIs can work simultaneously without interference. Call get_state first, then run_commands.`,
      },
    });
    return;
  }

  const headerSess =
    typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';
  const querySess = typeof req.query.session === 'string' ? req.query.session.trim() : '';
  const activeSessionId = headerSess || querySess || `sc_sess_${crypto.randomBytes(6).toString('hex')}`;
  res.setHeader('Mcp-Session-Id', activeSessionId);

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
          'Read THIS Claude session’s isolated Stagecraft 3D scene (auto-creates your own session & scene immediately if needed so other AIs never interfere). Call this before issuing commands so real IDs are used.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Optional explicit session ID (defaults to your MCP session).' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'run_commands',
        description:
          'Send live editing commands exclusively to THIS session’s isolated Stagecraft 3D scene while the user watches in real time. Never blocks or interferes with other Claude sessions.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Optional explicit session ID.' },
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
      {
        name: 'new_session',
        description:
          'Create a brand-new isolated Stagecraft 3D session & fresh scene immediately so you can work independently without colliding with any other Claude or scene.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional name for the new scene/session.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'list_sessions',
        description: 'List active isolated AI sessions in Stagecraft 3D.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ];
    res.json({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (rpc.method === 'tools/call') {
    const toolName = String(rpc.params?.name ?? '');
    const toolArgs = (rpc.params?.arguments ?? {}) as Record<string, unknown>;

    if (toolName === 'new_session') {
      const requestedName = typeof toolArgs.name === 'string' ? toolArgs.name.trim() : undefined;
      const { session } = createFreshAiSession(store, requestedName);
      await savePersistedBridge(store);
      res.setHeader('Mcp-Session-Id', session.sessionId);
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: true,
                  sessionId: session.sessionId,
                  sceneId: session.sceneId,
                  sceneName: session.sceneName,
                  state: session.state,
                  note: 'New isolated Stagecraft session & scene created. You can work immediately without interfering with other sessions.',
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

    if (toolName === 'list_sessions') {
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  currentSessionId: activeSessionId,
                  sessions: listSessionSummaries(store),
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

    if (toolName === 'get_state' || toolName === 'get_studio_state') {
      const argSessionId = typeof toolArgs.sessionId === 'string' ? toolArgs.sessionId : undefined;
      const { session, createdNew } = resolveOrCreateSession(store, req, argSessionId, 'Claude');
      if (createdNew) await savePersistedBridge(store);
      res.setHeader('Mcp-Session-Id', session.sessionId);
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  sessionId: session.sessionId,
                  sceneId: session.sceneId,
                  sceneName: session.sceneName,
                  isolatedSession: true,
                  studioConnected: store.sseClients.size > 0 || Date.now() - store.lastStateUpdatedAt < 15000,
                  state: session.state ?? store.lastState,
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
      const argSessionId = typeof toolArgs.sessionId === 'string' ? toolArgs.sessionId : undefined;
      const { session } = resolveOrCreateSession(store, req, argSessionId, 'Claude');
      res.setHeader('Mcp-Session-Id', session.sessionId);
      const commands = Array.isArray(toolArgs.commands) ? toolArgs.commands : [];
      const source = typeof toolArgs.source === 'string' && toolArgs.source.trim()
        ? toolArgs.source.trim()
        : session.label;
      const outcome = await dispatchCommandsToStudio(store, session, commands, source, true);
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

async function saveCloudProject(store: BridgeMemoryStore, payload: StoredCloudProject): Promise<'kv' | 'disk' | 'memory'> {
  store.cloudProjects[payload.syncCode] = payload;
  const serialized = JSON.stringify(payload);
  if (getKvConfig()) {
    await kvCommand(['SET', `stagecraft:project:${payload.syncCode}`, serialized, 'EX', 60 * 60 * 24 * 30]);
    const listRaw = await kvCommand(['GET', 'stagecraft:projects:index']);
    const list: { syncCode: string; projectName: string; updatedAt: number }[] =
      typeof listRaw === 'string' && listRaw ? (JSON.parse(listRaw) as typeof list) : [];
    const nextList = [
      { syncCode: payload.syncCode, projectName: payload.projectName, updatedAt: payload.updatedAt },
      ...list.filter((i) => i.syncCode !== payload.syncCode),
    ].slice(0, 40);
    await kvCommand(['SET', 'stagecraft:projects:index', JSON.stringify(nextList), 'EX', 60 * 60 * 24 * 30]);
    return 'kv';
  }
  try {
    const projDir = path.join(DATA_DIR, 'projects');
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, `${payload.syncCode}.json`), serialized, 'utf8');
    return 'disk';
  } catch {
    return 'memory';
  }
}

async function loadCloudProject(store: BridgeMemoryStore, syncCode: string): Promise<StoredCloudProject | null> {
  const cleanCode = syncCode.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
  if (!cleanCode) return null;
  if (getKvConfig()) {
    const raw = await kvCommand(['GET', `stagecraft:project:${cleanCode}`]);
    if (typeof raw === 'string' && raw) {
      return JSON.parse(raw) as StoredCloudProject;
    }
  }
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'projects', `${cleanCode}.json`), 'utf8');
    return JSON.parse(raw) as StoredCloudProject;
  } catch {
    // Fallback to memory
  }
  return store.cloudProjects[cleanCode] ?? null;
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

  // Studio UI reads config + active isolated AI sessions
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
      sessions: listSessionSummaries(store),
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
      sessions: listSessionSummaries(store),
    });
    res.json({
      ok: true,
      enabled: store.enabled,
      token: store.token,
      connectedStudios: store.sseClients.size,
      sessions: listSessionSummaries(store),
    });
  });

  // Explicit REST endpoint to create a new isolated AI session ASAP
  app.post('/api/ai/sessions', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const body = (req.body ?? {}) as { name?: string; label?: string };
    const { session } = createFreshAiSession(store, body.name ?? body.label);
    await savePersistedBridge(store);
    res.json({
      ok: true,
      sessionId: session.sessionId,
      sceneId: session.sceneId,
      sceneName: session.sceneName,
      state: session.state,
    });
  });

  // Studio SSE stream
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
        sessions: listSessionSummaries(store),
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

  // Studio pushes live scene snapshot (active scene + per-session isolated scene snapshots)
  app.post('/api/ai/sync-state', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      state?: Record<string, unknown>;
      sessionSnapshots?: Record<string, Record<string, unknown>>;
      enabled?: boolean;
      token?: string;
    };

    const nextState = body.state && typeof body.state === 'object' ? body.state : null;
    if (nextState) {
      store.lastState = nextState;
      store.lastStateUpdatedAt = Date.now();
      const activeSceneId = typeof nextState.sceneId === 'string' ? nextState.sceneId : '';
      for (const s of Object.values(store.sessions)) {
        if (s.sceneId === activeSceneId) {
          s.state = nextState;
          if (typeof nextState.sceneName === 'string') s.sceneName = nextState.sceneName;
        }
      }
    }

    if (body.sessionSnapshots && typeof body.sessionSnapshots === 'object') {
      for (const [sid, snap] of Object.entries(body.sessionSnapshots)) {
        if (store.sessions[sid] && snap && typeof snap === 'object') {
          store.sessions[sid].state = snap;
          if (typeof snap.sceneName === 'string') store.sessions[sid].sceneName = snap.sceneName;
        }
      }
    }

    if (typeof body.enabled === 'boolean') {
      store.enabled = body.enabled;
    }
    if (typeof body.token === 'string' && body.token.trim() && !process.env.STAGECRAFT_TOKEN?.trim()) {
      store.token = body.token.trim();
    }
    await savePersistedBridge(store);
    res.json({
      ok: true,
      connectedStudios: Math.max(1, store.sseClients.size),
      sessions: listSessionSummaries(store),
    });
  });

  // Studio serverless poll endpoint (also re-hydrates cold containers with enabled/token)
  app.get('/api/ai/poll', async (req, res) => {
    const store = await loadPersistedBridge();
    const qEnabled = req.query.enabled;
    const qToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    let changed = false;

    if (qEnabled === '1' && !store.enabled) {
      store.enabled = true;
      changed = true;
    }
    if (qToken && !process.env.STAGECRAFT_TOKEN?.trim() && store.token !== qToken) {
      store.token = qToken;
      changed = true;
    }

    const afterMs = Number(req.query.after ?? 0) || 0;
    const batches = store.pendingBatches.filter((b) => b.createdAt > afterMs);
    if (batches.length > 0) {
      store.pendingBatches = store.pendingBatches.filter((b) => !batches.some((x) => x.batchId === b.batchId));
      changed = true;
    }
    if (changed) {
      await savePersistedBridge(store);
    }
    res.json({
      ok: true,
      enabled: store.enabled,
      batches,
      sessions: listSessionSummaries(store),
    });
  });

  // Studio acknowledges command batch completion
  app.post('/api/ai/ack', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      batchId?: string;
      sessionId?: string;
      ok?: boolean;
      results?: unknown[];
      error?: string;
      state?: Record<string, unknown>;
    };
    if (body.state && typeof body.state === 'object') {
      if (body.sessionId && store.sessions[body.sessionId]) {
        store.sessions[body.sessionId].state = body.state;
        store.sessions[body.sessionId].lastActivityAt = Date.now();
      } else {
        store.lastState = body.state;
      }
      store.lastStateUpdatedAt = Date.now();
    }
    if (body.batchId) {
      const entry = store.history.find((h) => h.batchId === body.batchId);
      if (entry) entry.status = body.ok === false ? 'error' : 'completed';
      const ackPayload: Record<string, unknown> = {
        ok: body.ok !== false,
        sessionId: body.sessionId,
        batchId: body.batchId,
        results: body.results ?? [],
        error: body.error,
        state: (body.sessionId && store.sessions[body.sessionId]?.state) || store.lastState,
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

  // External AI: Read live scene state (isolated per session if ?session= passed, or auto-creates new session)
  app.get('/api/ai/state', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const { session, createdNew } = resolveOrCreateSession(store, req, undefined, 'HTTP AI');
    if (createdNew) await savePersistedBridge(store);
    res.json({
      ok: true,
      sessionId: session.sessionId,
      sceneId: session.sceneId,
      sceneName: session.sceneName,
      studioConnected: store.sseClients.size > 0 || Date.now() - store.lastStateUpdatedAt < 15000,
      updatedAt: session.lastActivityAt,
      state: session.state ?? store.lastState,
      commandSchema: COMMAND_SCHEMA_SUMMARY,
    });
  });

  // External AI: Send live commands (isolated per session)
  app.post('/api/ai/commands', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const body = (req.body ?? {}) as {
      sessionId?: string;
      commands?: unknown[];
      source?: string;
      wait?: boolean;
    };
    const commands = Array.isArray(body.commands) ? body.commands : [];
    if (commands.length === 0) {
      res.status(400).json({ ok: false, error: 'Provide a non-empty "commands" array.' });
      return;
    }
    const { session } = resolveOrCreateSession(
      store,
      req,
      body.sessionId,
      typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'External AI',
    );
    const waitForAck = req.query.wait !== 'false' && body.wait !== false;
    const result = await dispatchCommandsToStudio(
      store,
      session,
      commands,
      typeof body.source === 'string' && body.source.trim() ? body.source.trim() : session.label,
      waitForAck,
    );
    res.json(result);
  });

  // Cross-Device Cloud Project Sync Endpoints
  app.post('/api/projects/save', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      syncCode?: string;
      project?: Record<string, unknown>;
      assets?: unknown[];
    };
    if (!body.project || typeof body.project !== 'object') {
      res.status(400).json({ ok: false, error: 'Missing project payload.' });
      return;
    }
    const rawCode = typeof body.syncCode === 'string' ? body.syncCode.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase() : '';
    const syncCode = rawCode || `SC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const payload: StoredCloudProject = {
      syncCode,
      projectName: typeof body.project.name === 'string' ? body.project.name : 'Stagecraft Project',
      updatedAt: Date.now(),
      project: body.project,
      assets: Array.isArray(body.assets) ? body.assets : [],
    };
    const persistedVia = await saveCloudProject(store, payload);
    res.json({
      ok: true,
      syncCode,
      projectName: payload.projectName,
      updatedAt: payload.updatedAt,
      persistedVia,
    });
  });

  app.get('/api/projects', async (_req, res) => {
    const store = await loadPersistedBridge();
    if (getKvConfig()) {
      const raw = await kvCommand(['GET', 'stagecraft:projects:index']);
      if (typeof raw === 'string' && raw) {
        res.json({ ok: true, persistedVia: 'kv', projects: JSON.parse(raw) });
        return;
      }
    }
    const list = Object.values(store.cloudProjects)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ syncCode: p.syncCode, projectName: p.projectName, updatedAt: p.updatedAt }));
    res.json({ ok: true, persistedVia: getKvConfig() ? 'kv' : 'memory', projects: list });
  });

  app.get('/api/projects/:syncCode', async (req, res) => {
    const store = await loadPersistedBridge();
    const loaded = await loadCloudProject(store, String(req.params.syncCode ?? ''));
    if (!loaded) {
      res.status(404).json({ ok: false, error: 'No synced project found for that code.' });
      return;
    }
    res.json({ ok: true, ...loaded });
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
    res.json({
      ok: true,
      name: 'stagecraft-3d-live-bridge',
      transport: 'streamable-http',
      multiSession: true,
    });
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
        version: '1.2.0',
        description:
          'Allows multiple external AI assistants to create isolated sessions and edit Stagecraft 3D scenes in parallel without interfering with each other.',
      },
      servers: [{ url: baseUrl }],
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ BearerAuth: [] }],
      paths: {
        '/api/ai/sessions': {
          post: {
            operationId: 'createAiSession',
            summary: 'Create a brand-new isolated AI scene session immediately',
            responses: { '200': { description: 'Created isolated session and starter state' } },
          },
        },
        '/api/ai/state': {
          get: {
            operationId: 'getStudioState',
            summary: 'Read the live 3D scene state for a session',
            responses: { '200': { description: 'Current studio snapshot' } },
          },
        },
        '/api/ai/commands': {
          post: {
            operationId: 'executeStudioCommands',
            summary: 'Apply one or more live edits to an isolated Stagecraft 3D session',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['commands'],
                    properties: {
                      sessionId: { type: 'string' },
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
