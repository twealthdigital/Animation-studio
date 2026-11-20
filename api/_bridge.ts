import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';

export type SceneEventCause =
  | 'new_session'
  | 'create_session'
  | 'reconnect'
  | 'timeout'
  | 'another_client'
  | 'rejected_auto_create'
  | 'scene_deleted'
  | 'token_rotated'
  | 'token_revoked'
  | 'scene_mismatch';

export interface SceneCreationEvent {
  id: string;
  timestamp: number;
  cause: SceneEventCause;
  sessionId?: string | null;
  sceneId?: string | null;
  sceneName?: string | null;
  clientLabel?: string;
  clientFingerprint?: string;
  detail: string;
}

export interface PendingBatch {
  batchId: string;
  sessionId: string;
  sceneId: string;
  sceneName: string;
  source: string;
  commands: unknown[];
  createdAt: number;
  status: string;
  isSessionCreation?: boolean;
}

export interface AiSessionRecord {
  sessionId: string;
  label: string;
  sceneId: string | null;
  sceneName: string | null;
  createdAt: number;
  lastActivityAt: number;
  lastHeartbeatAt: number;
  leaseDurationMs: number;
  leaseExpiresAt: number;
  batchCount: number;
  clientFingerprint: string;
  clientLabel: string;
  timeoutLoggedAt?: number;
  state: Record<string, unknown> | null;
}

export interface KnownSceneRecord {
  sceneId: string;
  sceneName: string;
  updatedAt: number;
  duration?: number;
  charactersCount?: number;
  propsCount?: number;
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

interface StudioTabRecord {
  tabId: string;
  lastSeenAt: number;
  userAgent: string;
}

export interface BridgeMemoryStore {
  enabled: boolean;
  token: string;
  tokenRevoked: boolean;
  tokenUpdatedAt: number;
  envTokenOverridden: boolean;
  revokedTokenHashes: string[];
  singleClientLock: boolean;
  multiClientWarning: string | null;
  multiClientWarningAt: number;
  sessionCounter: number;
  sessions: Record<string, AiSessionRecord>;
  deletedSessionIds: string[];
  knownScenes: Record<string, KnownSceneRecord>;
  sceneEvents: SceneCreationEvent[];
  studioTabs: Record<string, StudioTabRecord>;
  lastState: Record<string, unknown> | null;
  lastStateUpdatedAt: number;
  sseClients: Set<Response>;
  waiters: Map<string, PendingAckWaiter>;
  pendingBatches: PendingBatch[];
  history: PendingBatch[];
  ackResults: Map<string, Record<string, unknown>>;
  cloudProjects: Record<string, StoredCloudProject>;
  hasLoadedSnapshot: boolean;
}

interface PersistedSnapshot {
  enabled: boolean;
  token: string;
  tokenRevoked: boolean;
  tokenUpdatedAt: number;
  envTokenOverridden: boolean;
  revokedTokenHashes: string[];
  singleClientLock: boolean;
  multiClientWarning: string | null;
  multiClientWarningAt: number;
  sessionCounter: number;
  sessions: Record<string, AiSessionRecord>;
  deletedSessionIds: string[];
  knownScenes: Record<string, KnownSceneRecord>;
  sceneEvents: SceneCreationEvent[];
  lastState: Record<string, unknown> | null;
  lastStateUpdatedAt: number;
  pendingBatches: PendingBatch[];
}

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const RECONNECT_IDLE_THRESHOLD_MS = 45 * 1000;
const STUDIO_TAB_TTL_MS = 20 * 1000;
const DEFAULT_ACK_TIMEOUT_MS = 25 * 1000;

function getDataDirCandidates(): string[] {
  if (process.env.STAGECRAFT_BRIDGE_DIR?.trim()) {
    return [process.env.STAGECRAFT_BRIDGE_DIR.trim()];
  }
  return [
    path.join(process.cwd(), '.stagecraft-data'),
    path.join(os.tmpdir(), 'stagecraft-data'),
  ];
}

function hashToken(tok: string): string {
  return crypto.createHash('sha256').update(tok).digest('hex').slice(0, 32);
}

function safeTokenEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createToken(): string {
  const envTok = process.env.STAGECRAFT_TOKEN?.trim();
  if (envTok) return envTok;
  return `sc_${crypto.randomBytes(16).toString('hex')}`;
}

export function resetBridgeStoreForTests(): void {
  const g = globalThis as unknown as { __stagecraftAiStore?: BridgeMemoryStore };
  delete g.__stagecraftAiStore;
}

function getStore(): BridgeMemoryStore {
  const g = globalThis as unknown as { __stagecraftAiStore?: BridgeMemoryStore };
  if (!g.__stagecraftAiStore) {
    g.__stagecraftAiStore = {
      enabled: Boolean(process.env.STAGECRAFT_TOKEN?.trim()),
      token: createToken(),
      tokenRevoked: false,
      tokenUpdatedAt: 0,
      envTokenOverridden: false,
      revokedTokenHashes: [],
      singleClientLock: true,
      multiClientWarning: null,
      multiClientWarningAt: 0,
      sessionCounter: 0,
      sessions: {},
      deletedSessionIds: [],
      knownScenes: {},
      sceneEvents: [],
      studioTabs: {},
      lastState: null,
      lastStateUpdatedAt: 0,
      sseClients: new Set<Response>(),
      waiters: new Map<string, PendingAckWaiter>(),
      pendingBatches: [],
      history: [],
      ackResults: new Map<string, Record<string, unknown>>(),
      cloudProjects: {},
      hasLoadedSnapshot: false,
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

function recordSceneEvent(
  store: BridgeMemoryStore,
  cause: SceneEventCause,
  detail: string,
  meta?: {
    sessionId?: string | null;
    sceneId?: string | null;
    sceneName?: string | null;
    clientLabel?: string;
    clientFingerprint?: string;
  },
): SceneCreationEvent {
  const ev: SceneCreationEvent = {
    id: `scev_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    timestamp: Date.now(),
    cause,
    sessionId: meta?.sessionId ?? null,
    sceneId: meta?.sceneId ?? null,
    sceneName: meta?.sceneName ?? null,
    clientLabel: meta?.clientLabel,
    clientFingerprint: meta?.clientFingerprint,
    detail,
  };
  store.sceneEvents.unshift(ev);
  if (store.sceneEvents.length > 100) {
    store.sceneEvents.length = 100;
  }
  return ev;
}

function pruneOldSessions(store: BridgeMemoryStore): void {
  const keys = Object.keys(store.sessions);
  if (keys.length <= 32) return;
  // Prefer pruning unbound or expired sessions first; keep active bound sessions intact
  const sorted = keys.sort((a, b) => {
    const sa = store.sessions[a];
    const sb = store.sessions[b];
    const aBound = sa.sceneId ? 1 : 0;
    const bBound = sb.sceneId ? 1 : 0;
    if (aBound !== bBound) return aBound - bBound;
    return sa.lastActivityAt - sb.lastActivityAt;
  });
  sorted.slice(0, keys.length - 32).forEach((k) => {
    delete store.sessions[k];
  });
}

async function readBridgeRawFromDisk(): Promise<string | null> {
  for (const dir of getDataDirCandidates()) {
    try {
      const raw = await fs.readFile(path.join(dir, 'bridge-store.json'), 'utf8');
      if (raw) return raw;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

async function writeBridgeRawToDisk(serialized: string): Promise<void> {
  for (const dir of getDataDirCandidates()) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'bridge-store.json'), serialized, 'utf8');
      return;
    } catch {
      // Fall back to os.tmpdir() on read-only serverless filesystems
    }
  }
}

function mergePersistedSnapshot(store: BridgeMemoryStore, parsed: Partial<PersistedSnapshot>): void {
  const deletedSet = new Set(store.deletedSessionIds);
  if (Array.isArray(parsed.deletedSessionIds)) {
    for (const id of parsed.deletedSessionIds) {
      if (typeof id === 'string' && id) deletedSet.add(id);
    }
  }
  store.deletedSessionIds = Array.from(deletedSet).slice(-64);

  const revokedSet = new Set(store.revokedTokenHashes);
  if (Array.isArray(parsed.revokedTokenHashes)) {
    for (const h of parsed.revokedTokenHashes) {
      if (typeof h === 'string' && h) revokedSet.add(h);
    }
  }
  store.revokedTokenHashes = Array.from(revokedSet).slice(-32);

  const parsedTokenUpdatedAt = typeof parsed.tokenUpdatedAt === 'number' ? parsed.tokenUpdatedAt : 0;
  if (parsedTokenUpdatedAt >= store.tokenUpdatedAt) {
    if (typeof parsed.enabled === 'boolean') store.enabled = parsed.enabled;
    if (typeof parsed.tokenRevoked === 'boolean') store.tokenRevoked = parsed.tokenRevoked;
    if (typeof parsed.envTokenOverridden === 'boolean') store.envTokenOverridden = parsed.envTokenOverridden;
    if (typeof parsed.token === 'string') {
      if (parsed.tokenRevoked) {
        store.token = '';
      } else if (parsed.token && (!process.env.STAGECRAFT_TOKEN?.trim() || parsed.envTokenOverridden)) {
        if (!revokedSet.has(hashToken(parsed.token))) {
          store.token = parsed.token;
        }
      }
    }
    store.tokenUpdatedAt = parsedTokenUpdatedAt;
  } else if (typeof parsed.enabled === 'boolean' && !store.hasLoadedSnapshot) {
    store.enabled = parsed.enabled;
  }

  if (typeof parsed.singleClientLock === 'boolean' && !store.hasLoadedSnapshot) {
    store.singleClientLock = parsed.singleClientLock;
  }
  if (typeof parsed.multiClientWarning === 'string' && !store.multiClientWarning) {
    store.multiClientWarning = parsed.multiClientWarning;
    store.multiClientWarningAt = typeof parsed.multiClientWarningAt === 'number' ? parsed.multiClientWarningAt : Date.now();
  }
  if (typeof parsed.sessionCounter === 'number' && parsed.sessionCounter > store.sessionCounter) {
    store.sessionCounter = parsed.sessionCounter;
  }

  if (parsed.sessions && typeof parsed.sessions === 'object') {
    for (const [sid, rawRec] of Object.entries(parsed.sessions)) {
      if (!rawRec || deletedSet.has(sid)) continue;
      const srec = rawRec as Partial<AiSessionRecord>;
      const existing = store.sessions[sid];
      const normalized: AiSessionRecord = {
        sessionId: sid,
        label: typeof srec.label === 'string' ? srec.label : 'Claude Session',
        sceneId: typeof srec.sceneId === 'string' && srec.sceneId ? srec.sceneId : null,
        sceneName: typeof srec.sceneName === 'string' && srec.sceneName ? srec.sceneName : null,
        createdAt: typeof srec.createdAt === 'number' ? srec.createdAt : Date.now(),
        lastActivityAt: typeof srec.lastActivityAt === 'number' ? srec.lastActivityAt : Date.now(),
        lastHeartbeatAt: typeof srec.lastHeartbeatAt === 'number' ? srec.lastHeartbeatAt : (srec.lastActivityAt ?? Date.now()),
        leaseDurationMs: typeof srec.leaseDurationMs === 'number' ? srec.leaseDurationMs : DEFAULT_LEASE_MS,
        leaseExpiresAt: typeof srec.leaseExpiresAt === 'number' ? srec.leaseExpiresAt : ((srec.lastActivityAt ?? Date.now()) + DEFAULT_LEASE_MS),
        batchCount: typeof srec.batchCount === 'number' ? srec.batchCount : 0,
        clientFingerprint: typeof srec.clientFingerprint === 'string' ? srec.clientFingerprint : '',
        clientLabel: typeof srec.clientLabel === 'string' ? srec.clientLabel : 'Claude',
        timeoutLoggedAt: typeof srec.timeoutLoggedAt === 'number' ? srec.timeoutLoggedAt : undefined,
        state: srec.state && typeof srec.state === 'object' ? srec.state : null,
      };
      if (!existing) {
        store.sessions[sid] = normalized;
      } else {
        // Never overwrite an already-bound sceneId with null or a different sceneId!
        if (!existing.sceneId && normalized.sceneId) {
          existing.sceneId = normalized.sceneId;
          existing.sceneName = normalized.sceneName;
        }
        if (normalized.lastActivityAt > existing.lastActivityAt) {
          existing.lastActivityAt = normalized.lastActivityAt;
          existing.lastHeartbeatAt = Math.max(existing.lastHeartbeatAt, normalized.lastHeartbeatAt);
          existing.leaseExpiresAt = Math.max(existing.leaseExpiresAt, normalized.leaseExpiresAt);
          existing.batchCount = Math.max(existing.batchCount, normalized.batchCount);
          if (normalized.state && (!existing.sceneId || normalized.state.sceneId === existing.sceneId)) {
            existing.state = normalized.state;
          }
        }
      }
    }
  }

  for (const delId of deletedSet) {
    delete store.sessions[delId];
  }

  if (parsed.knownScenes && typeof parsed.knownScenes === 'object') {
    for (const [scId, scRec] of Object.entries(parsed.knownScenes)) {
      if (!scRec || typeof scRec !== 'object') continue;
      const existing = store.knownScenes[scId];
      if (!existing || (scRec.updatedAt ?? 0) >= existing.updatedAt) {
        store.knownScenes[scId] = scRec;
      }
    }
  }

  if (Array.isArray(parsed.sceneEvents)) {
    const seen = new Set(store.sceneEvents.map((e) => e.id));
    for (const ev of parsed.sceneEvents) {
      if (ev && typeof ev.id === 'string' && !seen.has(ev.id)) {
        seen.add(ev.id);
        store.sceneEvents.push(ev);
      }
    }
    store.sceneEvents.sort((a, b) => b.timestamp - a.timestamp);
    if (store.sceneEvents.length > 100) store.sceneEvents.length = 100;
  }

  if (parsed.lastState && typeof parsed.lastState === 'object') {
    if (!store.lastState || (parsed.lastStateUpdatedAt ?? 0) >= store.lastStateUpdatedAt) {
      store.lastState = parsed.lastState;
    }
  }
  if (typeof parsed.lastStateUpdatedAt === 'number' && parsed.lastStateUpdatedAt > store.lastStateUpdatedAt) {
    store.lastStateUpdatedAt = parsed.lastStateUpdatedAt;
  }
  if (Array.isArray(parsed.pendingBatches) && parsed.pendingBatches.length > 0) {
    const known = new Set(store.pendingBatches.map((b) => b.batchId));
    for (const pb of parsed.pendingBatches) {
      if (!known.has(pb.batchId)) store.pendingBatches.push(pb);
    }
  }
  store.hasLoadedSnapshot = true;
}

async function loadPersistedBridge(): Promise<BridgeMemoryStore> {
  const store = getStore();
  let raw: string | null = null;

  if (getKvConfig()) {
    const kvRaw = await kvCommand(['GET', 'stagecraft:ai:bridge']);
    if (typeof kvRaw === 'string' && kvRaw) raw = kvRaw;
  } else {
    raw = await readBridgeRawFromDisk();
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedSnapshot>;
      mergePersistedSnapshot(store, parsed);
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
    token: store.tokenRevoked ? '' : store.token,
    tokenRevoked: store.tokenRevoked,
    tokenUpdatedAt: store.tokenUpdatedAt,
    envTokenOverridden: store.envTokenOverridden,
    revokedTokenHashes: store.revokedTokenHashes.slice(-32),
    singleClientLock: store.singleClientLock,
    multiClientWarning: store.multiClientWarning,
    multiClientWarningAt: store.multiClientWarningAt,
    sessionCounter: store.sessionCounter,
    sessions: store.sessions,
    deletedSessionIds: store.deletedSessionIds.slice(-64),
    knownScenes: store.knownScenes,
    sceneEvents: store.sceneEvents.slice(0, 100),
    lastState: store.lastState,
    lastStateUpdatedAt: store.lastStateUpdatedAt,
    pendingBatches: store.pendingBatches.slice(-30),
  };
  const serialized = JSON.stringify(payload);
  if (getKvConfig()) {
    await kvCommand(['SET', 'stagecraft:ai:bridge', serialized, 'EX', 86400]);
  } else {
    await writeBridgeRawToDisk(serialized);
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
    maxDuration: 3600,
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
        color: '#ffe6cc',
        kind: 'directional',
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

function computeClientFingerprint(req: Request, clientName?: string): string {
  const explicitClientId =
    typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'].trim() : '';
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].trim() : '';
  const basis = explicitClientId ? `cid:${explicitClientId}` : `ua:${clientName || ''}|${ua}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

function recordStudioTabHeartbeat(store: BridgeMemoryStore, req: Request, tabIdRaw?: unknown): void {
  const tabId =
    typeof tabIdRaw === 'string' && tabIdRaw.trim()
      ? tabIdRaw.trim()
      : typeof req.query.tabId === 'string' && req.query.tabId.trim()
        ? req.query.tabId.trim()
        : '';
  if (!tabId) return;
  const now = Date.now();
  store.studioTabs[tabId] = {
    tabId,
    lastSeenAt: now,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
  };
  for (const [k, v] of Object.entries(store.studioTabs)) {
    if (now - v.lastSeenAt > STUDIO_TAB_TTL_MS * 2) {
      delete store.studioTabs[k];
    }
  }
}

function getActiveStudioTabs(store: BridgeMemoryStore, now = Date.now()): StudioTabRecord[] {
  return Object.values(store.studioTabs).filter((t) => now - t.lastSeenAt <= STUDIO_TAB_TTL_MS);
}

function getActiveStudiosCount(store: BridgeMemoryStore, now = Date.now()): number {
  const tabCount = getActiveStudioTabs(store, now).length;
  if (tabCount > 0) return tabCount;
  if (store.sseClients.size > 0) return store.sseClients.size;
  return now - store.lastStateUpdatedAt < 15000 ? 1 : 0;
}

function isStudioConnected(store: BridgeMemoryStore, now = Date.now()): boolean {
  return getActiveStudiosCount(store, now) > 0;
}

function getMultiStudioWarning(store: BridgeMemoryStore, now = Date.now()): string | null {
  const tabs = getActiveStudioTabs(store, now);
  if (tabs.length > 1) {
    return `${tabs.length} Stagecraft Studio browser tabs are open with this bridge. Keep only one tab open so commands and scene state stay consistent.`;
  }
  return null;
}

function computeSessionStatus(s: AiSessionRecord, now = Date.now()): 'active' | 'idle' | 'expired' {
  if (now - s.lastActivityAt < 60_000) return 'active';
  if (now <= s.leaseExpiresAt) return 'idle';
  return 'expired';
}

function listSessionSummaries(store: BridgeMemoryStore) {
  const now = Date.now();
  return Object.values(store.sessions)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((s) => ({
      sessionId: s.sessionId,
      label: s.label,
      sceneId: s.sceneId,
      sceneName: s.sceneName,
      bound: Boolean(s.sceneId),
      status: computeSessionStatus(s, now),
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      leaseExpiresAt: s.leaseExpiresAt,
      batchCount: s.batchCount,
      clientLabel: s.clientLabel,
      clientFingerprint: s.clientFingerprint,
    }));
}

function listKnownSceneSummaries(store: BridgeMemoryStore) {
  return Object.values(store.knownScenes)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((sc) => ({
      sceneId: sc.sceneId,
      sceneName: sc.sceneName,
      updatedAt: sc.updatedAt,
      duration: sc.duration,
      charactersCount: sc.charactersCount,
      propsCount: sc.propsCount,
    }));
}

function getBoundSessions(store: BridgeMemoryStore): AiSessionRecord[] {
  return Object.values(store.sessions)
    .filter((s) => Boolean(s.sceneId) && !store.deletedSessionIds.includes(s.sessionId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function createUnboundSession(
  store: BridgeMemoryStore,
  clientLabel: string,
  clientFingerprint: string,
  requestedSessionId?: string,
): AiSessionRecord {
  const now = Date.now();
  const sessionId =
    requestedSessionId && requestedSessionId.trim() && !store.deletedSessionIds.includes(requestedSessionId.trim())
      ? requestedSessionId.trim()
      : `sc_sess_${crypto.randomBytes(6).toString('hex')}`;
  const session: AiSessionRecord = {
    sessionId,
    label: clientLabel || 'Claude',
    sceneId: null,
    sceneName: null,
    createdAt: now,
    lastActivityAt: now,
    lastHeartbeatAt: now,
    leaseDurationMs: DEFAULT_LEASE_MS,
    leaseExpiresAt: now + DEFAULT_LEASE_MS,
    batchCount: 0,
    clientFingerprint,
    clientLabel: clientLabel || 'Claude',
    state: null,
  };
  store.sessions[sessionId] = session;
  return session;
}

function createExplicitBoundSession(
  store: BridgeMemoryStore,
  cause: 'new_session' | 'create_session',
  opts: {
    requestedLabel?: string;
    bindToSessionId?: string;
    clientLabel: string;
    clientFingerprint: string;
    requestedSceneId?: string;
  },
): { session: AiSessionRecord; createdBatch: PendingBatch } {
  store.sessionCounter += 1;
  const num = store.sessionCounter;
  const cleanLabel = opts.requestedLabel?.trim()
    ? opts.requestedLabel.trim()
    : `Claude Session #${num}`;
  const now = Date.now();
  const sceneId =
    opts.requestedSceneId?.trim() || `scene_ai_${crypto.randomBytes(4).toString('hex')}`;
  const sceneName = cleanLabel;

  // If caller already holds an UNBOUND session, bind it in-place so their Mcp-Session-Id stays identical
  const existingUnbound =
    opts.bindToSessionId && store.sessions[opts.bindToSessionId] && !store.sessions[opts.bindToSessionId].sceneId
      ? store.sessions[opts.bindToSessionId]
      : null;

  const sessionId = existingUnbound
    ? existingUnbound.sessionId
    : `sc_sess_${crypto.randomBytes(6).toString('hex')}`;

  const starterState = buildStarterSessionState(sessionId, sceneId, sceneName, store.lastState);

  const session: AiSessionRecord = existingUnbound
    ? {
        ...existingUnbound,
        label: cleanLabel,
        sceneId,
        sceneName,
        lastActivityAt: now,
        lastHeartbeatAt: now,
        leaseExpiresAt: now + existingUnbound.leaseDurationMs,
        clientFingerprint: opts.clientFingerprint || existingUnbound.clientFingerprint,
        clientLabel: opts.clientLabel || existingUnbound.clientLabel,
        state: starterState,
      }
    : {
        sessionId,
        label: cleanLabel,
        sceneId,
        sceneName,
        createdAt: now,
        lastActivityAt: now,
        lastHeartbeatAt: now,
        leaseDurationMs: DEFAULT_LEASE_MS,
        leaseExpiresAt: now + DEFAULT_LEASE_MS,
        batchCount: 0,
        clientFingerprint: opts.clientFingerprint,
        clientLabel: opts.clientLabel,
        state: starterState,
      };

  store.sessions[sessionId] = session;
  store.knownScenes[sceneId] = {
    sceneId,
    sceneName,
    updatedAt: now,
    duration: 10,
    charactersCount: 0,
    propsCount: 0,
    state: starterState,
  };

  recordSceneEvent(
    store,
    cause,
    `Created scene "${sceneName}" (${sceneId}) bound to session ${sessionId}`,
    {
      sessionId,
      sceneId,
      sceneName,
      clientLabel: opts.clientLabel,
      clientFingerprint: opts.clientFingerprint,
    },
  );

  const createdBatch: PendingBatch = {
    batchId: `aibatch_${now}_${crypto.randomBytes(3).toString('hex')}`,
    sessionId,
    sceneId,
    sceneName,
    source: cleanLabel,
    isSessionCreation: true,
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

function touchSessionLease(
  store: BridgeMemoryStore,
  session: AiSessionRecord,
  clientLabel: string,
  clientFingerprint: string,
): void {
  const now = Date.now();
  if (session.sceneId && now > session.leaseExpiresAt && session.timeoutLoggedAt !== session.leaseExpiresAt) {
    session.timeoutLoggedAt = session.leaseExpiresAt;
    recordSceneEvent(
      store,
      'timeout',
      `Session ${session.sessionId} lease expired after idle; preserved binding to scene "${session.sceneName}" (${session.sceneId})`,
      {
        sessionId: session.sessionId,
        sceneId: session.sceneId,
        sceneName: session.sceneName,
        clientLabel,
        clientFingerprint,
      },
    );
  }
  if (session.sceneId && now - session.lastActivityAt >= RECONNECT_IDLE_THRESHOLD_MS) {
    recordSceneEvent(
      store,
      'reconnect',
      `Resumed bound session ${session.sessionId} on scene "${session.sceneName}" (${session.sceneId})`,
      {
        sessionId: session.sessionId,
        sceneId: session.sceneId,
        sceneName: session.sceneName,
        clientLabel,
        clientFingerprint,
      },
    );
  }
  session.lastActivityAt = now;
  session.lastHeartbeatAt = now;
  session.leaseExpiresAt = now + (session.leaseDurationMs || DEFAULT_LEASE_MS);
}

function checkMultiClientConflict(
  store: BridgeMemoryStore,
  opts: {
    incomingSessionId?: string;
    clientLabel: string;
    clientFingerprint: string;
    action: 'initialize' | 'new_session' | 'access';
  },
): { conflict: boolean; warning?: string; activeBound?: AiSessionRecord } {
  const now = Date.now();
  const bound = getBoundSessions(store);
  const activeBound = bound.find((s) => now < s.leaseExpiresAt) ?? bound[0];
  if (!activeBound) return { conflict: false };

  const sameSession = Boolean(opts.incomingSessionId && opts.incomingSessionId === activeBound.sessionId);
  if (sameSession) return { conflict: false, activeBound };

  const fpDiffers = Boolean(
    opts.clientFingerprint &&
    activeBound.clientFingerprint &&
    opts.clientFingerprint !== activeBound.clientFingerprint,
  );

  // If a DIFFERENT client fingerprint connects while an active session is leased, or any second client tries to create a new scene
  if (fpDiffers || opts.action === 'new_session') {
    const warning = `Another client ("${opts.clientLabel}") attempted ${opts.action} using this token while session ${activeBound.sessionId} is active on scene "${activeBound.sceneName}" (${activeBound.sceneId}).`;
    store.multiClientWarning = warning;
    store.multiClientWarningAt = now;
    recordSceneEvent(store, 'another_client', warning, {
      sessionId: opts.incomingSessionId ?? null,
      sceneId: activeBound.sceneId,
      sceneName: activeBound.sceneName,
      clientLabel: opts.clientLabel,
      clientFingerprint: opts.clientFingerprint,
    });
    broadcastSse(store, 'ai:warning', {
      multiClientWarning: warning,
      multiStudioWarning: getMultiStudioWarning(store, now),
    });
    if (store.singleClientLock) {
      return { conflict: true, warning, activeBound };
    }
    return { conflict: false, warning, activeBound };
  }

  return { conflict: false, activeBound };
}

function extractToken(req: Request): string {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xTok = req.headers['x-stagecraft-token'];
  if (typeof xTok === 'string' && xTok.trim()) return xTok.trim();
  const qTok = req.query.token;
  if (typeof qTok === 'string' && qTok.trim()) return qTok.trim();
  return '';
}

function isAuthorized(store: BridgeMemoryStore, req: Request, res: Response): boolean {
  const token = extractToken(req);
  const key =
    typeof req.query.key === 'string'
      ? req.query.key.trim()
      : typeof req.headers['x-connector-key'] === 'string'
        ? req.headers['x-connector-key'].trim()
        : '';

  const envConnectorKey = process.env.MCP_CONNECTOR_KEY?.trim();
  const envStageToken = process.env.STAGECRAFT_TOKEN?.trim();

  if (envConnectorKey && key && safeTokenEqual(key, envConnectorKey)) {
    if (!store.revokedTokenHashes.includes(hashToken(key))) {
      return true;
    }
  }

  if (!token) {
    res.status(401).json({
      ok: false,
      errorCode: 'MISSING_TOKEN',
      error: 'Missing AI token. Pass Authorization: Bearer <token> or ?token=<token>.',
    });
    return false;
  }

  if (store.revokedTokenHashes.includes(hashToken(token))) {
    res.status(401).json({
      ok: false,
      errorCode: 'TOKEN_REVOKED',
      error: 'This MCP token has been revoked or rotated. Copy the active token from Stagecraft 3D -> AI Access.',
    });
    return false;
  }

  if (store.tokenRevoked || !store.token) {
    res.status(401).json({
      ok: false,
      errorCode: 'TOKEN_REVOKED',
      error: 'MCP token is currently revoked. Generate a new token in Stagecraft 3D -> AI Access.',
    });
    return false;
  }

  const matchesStore = safeTokenEqual(token, store.token);
  const matchesEnv = Boolean(envStageToken && !store.envTokenOverridden && safeTokenEqual(token, envStageToken));

  if (!matchesStore && !matchesEnv) {
    res.status(401).json({
      ok: false,
      errorCode: 'INVALID_TOKEN',
      error: 'Invalid AI token. Pass Authorization: Bearer <token> or ?token=<token>.',
    });
    return false;
  }

  if (!store.enabled) {
    res.status(403).json({
      ok: false,
      errorCode: 'BRIDGE_DISABLED',
      error: 'AI Live Access is disabled in Stagecraft 3D. Open AI Access and turn it ON.',
    });
    return false;
  }

  return true;
}

export const COMMAND_SCHEMA_SUMMARY = {
  maxDurationSeconds: 3600,
  autoExpandsDurationOnKeyframes: true,
  commands: [
    { op: 'create_session', sceneName: 'optional string', note: 'Starts a new isolated scene session immediately.' },
    { op: 'set_duration', duration: 'number (1..3600 seconds, e.g. 60)' },
    { op: 'update_scene', duration: '1..3600', name: 'string', backgroundColor: '#hex', showGrid: true, environmentPreset: 'studio-dark|sunset-stage|daylight-cyclorama|neon-night|minimal-white', workArea: { enabled: true, start: 0, end: 60 } },
    { op: 'select', targetKind: 'character|body-part|prop|light|camera|group|none', id: 'string', nodeId: 'optional string' },
    { op: 'move', targetId: 'string', nodeId: 'optional string', position: { x: 0, y: 0, z: 0 }, relative: false, time: 'optional number (seconds)' },
    { op: 'rotate', targetId: 'string', nodeId: 'optional string', rotationDeg: { x: 0, y: 0, z: 0 }, relative: false, time: 'optional number (seconds)' },
    { op: 'scale', targetId: 'string', nodeId: 'optional string', scale: { x: 1, y: 1, z: 1 }, time: 'optional number (seconds)' },
    { op: 'set_color', targetId: 'string', nodeId: 'optional string', color: '#hex', emissive: 'optional #hex', roughness: '0..1', metalness: '0..1', opacity: '0..1' },
    { op: 'set_visibility', targetId: 'string', nodeId: 'optional string', visible: true },
    { op: 'duplicate_target', targetId: 'string', name: 'optional string', position: 'optional vec3' },
    { op: 'pose_part', characterId: 'string', nodeId: 'string (or nodeName)', rotationDeg: { x: 0, y: 0, z: 0 }, position: 'optional vec3', scale: 'optional vec3', time: 'optional number' },
    { op: 'reset_part', characterId: 'string', nodeId: 'string' },
    { op: 'detach_part', characterId: 'string', nodeId: 'string' },
    { op: 'ungroup_all', characterId: 'string' },
    { op: 'add_keyframe', targetId: 'string', nodeId: 'optional string', time: 'number (seconds, auto-extends duration)', position: 'optional vec3', rotationDeg: 'optional vec3', scale: 'optional vec3|number', easing: 'smooth|linear|easeIn|easeOut|easeInOut|step' },
    { op: 'delete_keyframe', targetId: 'string', nodeId: 'optional string', time: 'optional number (omit to clear all)' },
    { op: 'add_prop', kind: 'box|sphere|cylinder|cone|podium|desk|chair|lamp|tree', name: 'string', color: '#hex', position: { x: 0, y: 0, z: 0 }, rotationDeg: 'optional vec3', scale: 'optional vec3|number' },
    { op: 'delete_target', targetId: 'string' },
    { op: 'add_wall', side: 'back|left|right|front', color: '#hex', height: 8 },
    { op: 'remove_wall', wallId: 'string' },
    { op: 'update_stage', floorShape: 'square|rectangle|circle|polygon', floorSides: 4, floorSize: 28, floorColor: '#hex', gridColor: '#hex', showClouds: true, cloudColor: '#hex', cloudOpacity: 0.42, floorLockEnabled: true, backgroundColor: '#hex' },
    { op: 'add_light', lightKind: 'point|directional|spot|ambient', name: 'string', color: '#hex', intensity: 1.5, position: { x: 3, y: 6, z: 4 } },
    { op: 'update_light', lightId: 'string', color: '#hex', intensity: 1.4, position: { x: 4, y: 8, z: 6 }, visible: true },
    { op: 'delete_light', lightId: 'string' },
    { op: 'set_camera_pose', position: { x: 0, y: 3, z: 12 }, target: { x: 0, y: 1.5, z: 0 }, fov: 40 },
    { op: 'add_camera_keyframe', time: 'number (seconds, auto-extends duration)', position: { x: 0, y: 4, z: 10 }, target: { x: 0, y: 1.5, z: 0 }, fov: 40, easing: 'smooth|linear' },
    { op: 'add_action_clip', characterId: 'string', actionId: 'walk|run|wave|jump|dance|sit|idle|celebrate|nod', startTime: 0, duration: 3, speed: 1, mood: 'optional string' },
    { op: 'set_facial_expression', characterId: 'string', time: 'number', facialState: { smile: 0.8, mouthOpen: 0.4, blink: 0, surprise: 0 } },
    { op: 'update_motion_path', targetId: 'string', points: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], duration: 6, orientAlongPath: true, enabled: true },
    { op: 'create_group', name: 'string', memberIds: ['id1', 'id2'] },
    { op: 'ungroup_scene_group', groupId: 'string' },
    { op: 'set_time', time: 'number (seconds, auto-extends duration)' },
    { op: 'play', speed: 1 },
    { op: 'pause' },
    { op: 'bake_html_motion', characterId: 'string' },
    { op: 'rename_scene', name: 'string' },
  ],
};

function findSceneSnapshotById(
  store: BridgeMemoryStore,
  sceneId: string,
): { state: Record<string, unknown> | null; sceneName: string | null } {
  const known = store.knownScenes[sceneId];
  if (known) {
    return { state: known.state, sceneName: known.sceneName };
  }
  const boundSession = Object.values(store.sessions).find((s) => s.sceneId === sceneId);
  if (boundSession) {
    return { state: boundSession.state, sceneName: boundSession.sceneName };
  }
  if (store.lastState && store.lastState.sceneId === sceneId) {
    return {
      state: store.lastState,
      sceneName: typeof store.lastState.sceneName === 'string' ? store.lastState.sceneName : null,
    };
  }
  return { state: null, sceneName: null };
}

type ResolvedTargetResult =
  | {
      ok: true;
      session: AiSessionRecord | null;
      sessionId: string;
      sceneId: string;
      sceneName: string;
      state: Record<string, unknown> | null;
    }
  | {
      ok: false;
      httpStatus: number;
      errorCode: string;
      error: string;
      extra?: Record<string, unknown>;
    };

function resolveExistingTarget(
  store: BridgeMemoryStore,
  req: Request,
  opts: {
    explicitSessionId?: string;
    explicitSceneId?: string;
    clientLabel: string;
    clientFingerprint: string;
  },
): ResolvedTargetResult {
  const headerSess =
    typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';
  const querySess = typeof req.query.session === 'string' ? req.query.session.trim() : '';
  const candidateSessionId = opts.explicitSessionId?.trim() || headerSess || querySess;
  const requestedSceneId = opts.explicitSceneId?.trim() || '';

  const session = candidateSessionId ? store.sessions[candidateSessionId] ?? null : null;

  if (candidateSessionId && !session) {
    // Allow explicit sceneId recovery ONLY if caller gave a real existing sceneId
    if (requestedSceneId) {
      const found = findSceneSnapshotById(store, requestedSceneId);
      if (found.state || found.sceneName) {
        return {
          ok: true,
          session: null,
          sessionId: candidateSessionId,
          sceneId: requestedSceneId,
          sceneName: found.sceneName ?? requestedSceneId,
          state: found.state,
        };
      }
    }
    recordSceneEvent(
      store,
      'rejected_auto_create',
      `Session "${candidateSessionId}" was not found and auto-creation was blocked.`,
      {
        sessionId: candidateSessionId,
        sceneId: requestedSceneId || null,
        clientLabel: opts.clientLabel,
        clientFingerprint: opts.clientFingerprint,
      },
    );
    return {
      ok: false,
      httpStatus: 404,
      errorCode: 'SESSION_NOT_FOUND',
      error: `Session "${candidateSessionId}" is not registered. Call list_sessions to see active sessions/scenes, pass an explicit sceneId, or call new_session to create a new scene.`,
      extra: {
        sessions: listSessionSummaries(store),
        knownScenes: listKnownSceneSummaries(store),
      },
    };
  }

  // Enforce immutable session-to-scene binding when session already has a bound sceneId
  if (session && session.sceneId) {
    if (requestedSceneId && requestedSceneId !== session.sceneId) {
      recordSceneEvent(
        store,
        'scene_mismatch',
        `Blocked request targeting sceneId="${requestedSceneId}" because session ${session.sessionId} is bound to "${session.sceneId}".`,
        {
          sessionId: session.sessionId,
          sceneId: session.sceneId,
          sceneName: session.sceneName,
          clientLabel: opts.clientLabel,
          clientFingerprint: opts.clientFingerprint,
        },
      );
      return {
        ok: false,
        httpStatus: 409,
        errorCode: 'SCENE_MISMATCH',
        error: `Session "${session.sessionId}" is bound to scene "${session.sceneName ?? session.sceneId}" (${session.sceneId}), not "${requestedSceneId}". Refusing to swap or run in the wrong scene.`,
        extra: {
          boundSceneId: session.sceneId,
          boundSceneName: session.sceneName,
          requestedSceneId,
        },
      };
    }

    touchSessionLease(store, session, opts.clientLabel, opts.clientFingerprint);
    const found = findSceneSnapshotById(store, session.sceneId);
    const state =
      found.state && found.state.sceneId === session.sceneId
        ? found.state
        : session.state && session.state.sceneId === session.sceneId
          ? session.state
          : null;
    if (state) session.state = state;
    return {
      ok: true,
      session,
      sessionId: session.sessionId,
      sceneId: session.sceneId,
      sceneName: session.sceneName ?? found.sceneName ?? session.label,
      state,
    };
  }

  // Session is unbound (sceneId === null) OR no sessionId was passed
  const targetSceneId = requestedSceneId;
  if (!targetSceneId) {
    recordSceneEvent(
      store,
      'rejected_auto_create',
      `Blocked auto-creation from get_state/run_commands: no scene is bound to session "${candidateSessionId || 'none'}".`,
      {
        sessionId: candidateSessionId || null,
        clientLabel: opts.clientLabel,
        clientFingerprint: opts.clientFingerprint,
      },
    );
    return {
      ok: false,
      httpStatus: 400,
      errorCode: 'NO_SCENE_BOUND',
      error:
        'No scene is bound to this session yet. Call new_session (or create_session) to create a new scene, or pass an explicit sceneId from list_sessions.',
      extra: {
        sessionId: candidateSessionId || null,
        sessions: listSessionSummaries(store),
        knownScenes: listKnownSceneSummaries(store),
      },
    };
  }

  const found = findSceneSnapshotById(store, targetSceneId);
  if (!found.state && !found.sceneName) {
    return {
      ok: false,
      httpStatus: 404,
      errorCode: 'SCENE_NOT_FOUND',
      error: `Scene "${targetSceneId}" was not found. Call list_sessions to see available scenes or new_session to create one.`,
      extra: {
        requestedSceneId: targetSceneId,
        sessions: listSessionSummaries(store),
        knownScenes: listKnownSceneSummaries(store),
      },
    };
  }

  const resolvedName = found.sceneName ?? targetSceneId;
  if (session && !session.sceneId) {
    // Bind unbound session cleanly to the explicitly requested existing scene
    session.sceneId = targetSceneId;
    session.sceneName = resolvedName;
    if (found.state) session.state = found.state;
    touchSessionLease(store, session, opts.clientLabel, opts.clientFingerprint);
  }

  return {
    ok: true,
    session,
    sessionId: session?.sessionId ?? candidateSessionId ?? '',
    sceneId: targetSceneId,
    sceneName: resolvedName,
    state: found.state,
  };
}

function summarizeAckPayload(
  batch: PendingBatch,
  rawAck: Record<string, unknown>,
): Record<string, unknown> {
  const results = Array.isArray(rawAck.results) ? rawAck.results : [];
  const totalCommands = batch.commands.length;
  const succeededCount = results.filter(
    (r) => r && typeof r === 'object' && (r as { ok?: boolean }).ok === true,
  ).length;
  const failedCount = results.filter(
    (r) => r && typeof r === 'object' && (r as { ok?: boolean }).ok === false,
  ).length;
  const appliedSceneId =
    typeof rawAck.appliedSceneId === 'string' ? rawAck.appliedSceneId : batch.sceneId;
  const sceneMatch = appliedSceneId === batch.sceneId;
  const ok = rawAck.ok !== false && sceneMatch && failedCount === 0;
  const status = !sceneMatch
    ? 'stale_scene'
    : ok
      ? 'completed'
      : failedCount > 0 && succeededCount > 0
        ? 'partial_error'
        : 'error';

  return {
    ok,
    status,
    sessionId: batch.sessionId,
    sceneId: batch.sceneId,
    sceneName: batch.sceneName,
    appliedSceneId,
    sceneMatch,
    batchId: batch.batchId,
    totalCommands,
    succeededCount,
    failedCount,
    results,
    ...(typeof rawAck.error === 'string' ? { error: rawAck.error } : {}),
    state: rawAck.state ?? null,
  };
}

async function dispatchCommandsToStudio(
  store: BridgeMemoryStore,
  target: { session: AiSessionRecord | null; sessionId: string; sceneId: string; sceneName: string },
  commands: unknown[],
  source: string,
  waitForAck: boolean,
  isSessionCreation = false,
  waitTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (!isStudioConnected(store, now) && !isSessionCreation) {
    return {
      ok: false,
      status: 'studio_offline',
      errorCode: 'STUDIO_OFFLINE',
      studioConnected: false,
      sessionId: target.sessionId,
      sceneId: target.sceneId,
      sceneName: target.sceneName,
      error:
        'Stagecraft 3D browser tab is offline (studioConnected: false). Open Stagecraft 3D with AI Live Access enabled and try again.',
    };
  }

  const batchId = `aibatch_${now}_${crypto.randomBytes(3).toString('hex')}`;
  if (target.session) {
    target.session.lastActivityAt = now;
    target.session.lastHeartbeatAt = now;
    target.session.leaseExpiresAt = now + (target.session.leaseDurationMs || DEFAULT_LEASE_MS);
    target.session.batchCount += 1;

    if (target.session.state) {
      for (const rawCmd of commands) {
        if (!rawCmd || typeof rawCmd !== 'object') continue;
        const c = rawCmd as Record<string, unknown>;
        if ((c.op === 'set_duration' || c.op === 'update_scene') && typeof c.duration === 'number' && Number.isFinite(c.duration)) {
          target.session.state.duration = Math.max(1, Math.min(3600, c.duration));
        }
        if ((c.op === 'rename_scene' || c.op === 'update_scene') && typeof c.name === 'string' && c.name.trim()) {
          target.session.sceneName = c.name.trim();
          target.session.state.sceneName = c.name.trim();
        }
        if (typeof c.time === 'number' && Number.isFinite(c.time)) {
          const curDur = typeof target.session.state.duration === 'number' ? target.session.state.duration : 10;
          if (c.time > curDur) {
            target.session.state.duration = Math.max(curDur, Math.min(3600, Math.ceil(c.time)));
          }
        }
      }
    }
  }

  const batch: PendingBatch = {
    batchId,
    sessionId: target.sessionId,
    sceneId: target.sceneId,
    sceneName: target.sceneName,
    source,
    commands,
    createdAt: now,
    status: 'queued',
    isSessionCreation,
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
      status: 'queued',
      sessionId: target.sessionId,
      sceneId: target.sceneId,
      sceneName: target.sceneName,
      batchId,
      totalCommands: commands.length,
      note: 'Dispatched asynchronously. Call get_batch_result with batchId for per-command execution results.',
    };
  }

  const clampedWaitMs = Math.max(1500, Math.min(45000, waitTimeoutMs));

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
        ok: false,
        status: 'pending',
        timedOutWaitingForAck: true,
        sessionId: target.sessionId,
        sceneId: target.sceneId,
        sceneName: target.sceneName,
        batchId,
        totalCommands: commands.length,
        note: 'Batch is still executing in Stagecraft 3D. Call get_batch_result with this batchId to fetch per-command success/error results.',
      });
    }, clampedWaitMs);

    store.waiters.set(batchId, {
      timer: timeout,
      resolve: (payload) => {
        cleanup();
        clearTimeout(timeout);
        resolve(summarizeAckPayload(batch, payload));
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
            resolve(summarizeAckPayload(batch, parsedAck));
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

  if (rpc.method === 'initialize') {
    const clientInfo = (rpc.params?.clientInfo ?? {}) as { name?: string };
    const clientLabel =
      typeof clientInfo.name === 'string' && clientInfo.name.trim()
        ? clientInfo.name.trim()
        : 'Claude';
    const fp = computeClientFingerprint(req, clientLabel);
    const headerSess =
      typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';
    const querySess = typeof req.query.session === 'string' ? req.query.session.trim() : '';
    const requestedSessId = headerSess || querySess;

    const conflict = checkMultiClientConflict(store, {
      incomingSessionId: requestedSessId || undefined,
      clientLabel,
      clientFingerprint: fp,
      action: 'initialize',
    });

    if (conflict.conflict) {
      await savePersistedBridge(store);
      res.status(409).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32001,
          message: conflict.warning ?? 'Token is locked to another active client session.',
          data: {
            errorCode: 'CLIENT_CONFLICT',
            activeSessionId: conflict.activeBound?.sessionId,
            activeSceneId: conflict.activeBound?.sceneId,
            activeSceneName: conflict.activeBound?.sceneName,
          },
        },
      });
      return;
    }

    let session: AiSessionRecord;
    if (requestedSessId && store.sessions[requestedSessId]) {
      session = store.sessions[requestedSessId];
      touchSessionLease(store, session, clientLabel, fp);
    } else {
      // NEVER auto-create a scene on initialize! Create an unbound MCP connection record.
      session = createUnboundSession(store, clientLabel, fp, requestedSessId || undefined);
    }
    await savePersistedBridge(store);

    const bound = getBoundSessions(store);
    const existingNotice =
      !session.sceneId && bound.length > 0
        ? ` Active bound session(s) already exist: ${bound.map((b) => `${b.sessionId} -> scene "${b.sceneName}" (${b.sceneId})`).join(', ')}. To resume an existing scene, pass its sessionId or sceneId to get_state / run_commands.`
        : '';

    res.setHeader('Mcp-Session-Id', session.sessionId);
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'stagecraft-3d-live-bridge',
          version: '2.0.0',
        },
        instructions: session.sceneId
          ? `Resumed bound Stagecraft 3D session ${session.sessionId} -> scene "${session.sceneName}" (${session.sceneId}). Pass sceneId="${session.sceneId}" in get_state and run_commands to verify target scene.`
          : `Connected to Stagecraft 3D (${session.sessionId}). No scene was auto-created.${existingNotice} Call list_sessions to view existing scenes, pass an explicit sceneId to get_state / run_commands, or call new_session when you want a brand-new scene.`,
      },
    });
    return;
  }

  const headerSess =
    typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'].trim() : '';
  const querySess = typeof req.query.session === 'string' ? req.query.session.trim() : '';
  const activeSessionId = headerSess || querySess;
  if (activeSessionId) {
    res.setHeader('Mcp-Session-Id', activeSessionId);
  }

  if (rpc.method === 'notifications/initialized' || rpc.method === 'ping') {
    if (activeSessionId && store.sessions[activeSessionId]) {
      const s = store.sessions[activeSessionId];
      s.lastHeartbeatAt = Date.now();
      s.leaseExpiresAt = Date.now() + (s.leaseDurationMs || DEFAULT_LEASE_MS);
      await savePersistedBridge(store);
    }
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
          'Read the Stagecraft 3D scene state for a bound session or an explicit sceneId. Never auto-creates a blank scene.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Optional explicit session ID.' },
            sceneId: { type: 'string', description: 'Explicit scene ID to verify/target so commands never land in the wrong scene.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'run_commands',
        description:
          'Execute live editing commands in Stagecraft 3D and return per-command success/error results. Never auto-creates a scene unless an explicit create_session op is included. Always pass sceneId to guarantee the target scene.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Optional explicit session ID.' },
            sceneId: { type: 'string', description: 'Explicit target scene ID. Fails safely if mismatched.' },
            source: { type: 'string', description: 'Optional AI name shown in Watch Mode log.' },
            force: { type: 'boolean', description: 'Only for explicit create_session when overriding single-client lock.' },
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
          'Explicitly create a new Stagecraft 3D scene bound permanently to a session. One session stays bound to one scene until deleted.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional name for the new scene/session.' },
            force: { type: 'boolean', description: 'Set true only if intentionally creating an additional scene while another active session exists.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'create_session',
        description: 'Alias for new_session: explicitly create a new bound Stagecraft 3D scene session.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional name for the new scene/session.' },
            force: { type: 'boolean', description: 'Set true only if intentionally creating an additional scene while another active session exists.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'list_sessions',
        description: 'List all real active AI sessions, their bound scene IDs, Studio scenes, and recent scene-creation events.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'heartbeat',
        description: 'Renew the session lease and verify studioConnected and bound sceneId.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Optional session ID to renew.' },
            sceneId: { type: 'string', description: 'Optional scene ID to verify.' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'get_batch_result',
        description: 'Fetch per-command execution results for a previously queued batchId.',
        inputSchema: {
          type: 'object',
          properties: {
            batchId: { type: 'string', description: 'Batch ID returned by run_commands.' },
          },
          required: ['batchId'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_session',
        description: 'Delete an AI session binding so its slot can be freed.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session ID to delete.' },
          },
          required: ['sessionId'],
          additionalProperties: false,
        },
      },
    ];
    res.json({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (rpc.method === 'tools/call') {
    const toolName = String(rpc.params?.name ?? '');
    const toolArgs = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
    const fp = computeClientFingerprint(req, 'Claude');

    if (toolName === 'new_session' || toolName === 'create_session') {
      const requestedName =
        typeof toolArgs.name === 'string'
          ? toolArgs.name.trim()
          : typeof toolArgs.sceneName === 'string'
            ? toolArgs.sceneName.trim()
            : undefined;
      const force = toolArgs.force === true;
      const currentSess = activeSessionId ? store.sessions[activeSessionId] : undefined;

      // Prevent mutating an already-bound session onto a new scene unless force=true
      if (currentSess?.sceneId && !force) {
        const msg = `Session ${currentSess.sessionId} is already bound to scene "${currentSess.sceneName}" (${currentSess.sceneId}). Keeping existing binding. Pass force: true only if you intentionally want a separate session.`;
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: false,
                    errorCode: 'SESSION_ALREADY_BOUND',
                    sessionId: currentSess.sessionId,
                    sceneId: currentSess.sceneId,
                    sceneName: currentSess.sceneName,
                    error: msg,
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

      if (!force) {
        const conflict = checkMultiClientConflict(store, {
          incomingSessionId: activeSessionId || undefined,
          clientLabel: 'Claude',
          clientFingerprint: fp,
          action: 'new_session',
        });
        if (conflict.conflict) {
          await savePersistedBridge(store);
          res.json({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      errorCode: 'CLIENT_CONFLICT',
                      activeSessionId: conflict.activeBound?.sessionId,
                      activeSceneId: conflict.activeBound?.sceneId,
                      activeSceneName: conflict.activeBound?.sceneName,
                      error: conflict.warning,
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
      }

      const { session } = createExplicitBoundSession(
        store,
        toolName === 'create_session' ? 'create_session' : 'new_session',
        {
          requestedLabel: requestedName,
          bindToSessionId: !currentSess?.sceneId ? activeSessionId || undefined : undefined,
          clientLabel: 'Claude',
          clientFingerprint: fp,
        },
      );
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
                  bound: true,
                  leaseExpiresAt: session.leaseExpiresAt,
                  state: session.state,
                  note: `Created scene "${session.sceneName}" (${session.sceneId}) bound to session ${session.sessionId}.`,
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
      const now = Date.now();
      const currentSess = activeSessionId ? store.sessions[activeSessionId] : undefined;
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
                  currentSessionId: activeSessionId || null,
                  currentSessionBound: Boolean(currentSess?.sceneId),
                  currentSceneId: currentSess?.sceneId ?? null,
                  studioConnected: isStudioConnected(store, now),
                  activeStudiosCount: getActiveStudiosCount(store, now),
                  singleClientLock: store.singleClientLock,
                  multiClientWarning: store.multiClientWarning,
                  multiStudioWarning: getMultiStudioWarning(store, now),
                  sessions: listSessionSummaries(store),
                  knownScenes: listKnownSceneSummaries(store),
                  recentEvents: store.sceneEvents.slice(0, 20),
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

    if (toolName === 'heartbeat') {
      const argSessionId = typeof toolArgs.sessionId === 'string' ? toolArgs.sessionId : undefined;
      const argSceneId = typeof toolArgs.sceneId === 'string' ? toolArgs.sceneId : undefined;
      const resolved = resolveExistingTarget(store, req, {
        explicitSessionId: argSessionId,
        explicitSceneId: argSceneId,
        clientLabel: 'Claude',
        clientFingerprint: fp,
      });
      if (!resolved.ok) {
        await savePersistedBridge(store);
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ok: false, errorCode: resolved.errorCode, error: resolved.error, ...resolved.extra },
                  null,
                  2,
                ),
              },
            ],
          },
        });
        return;
      }
      await savePersistedBridge(store);
      const now = Date.now();
      res.setHeader('Mcp-Session-Id', resolved.sessionId);
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
                  sessionId: resolved.sessionId,
                  sceneId: resolved.sceneId,
                  sceneName: resolved.sceneName,
                  studioConnected: isStudioConnected(store, now),
                  leaseExpiresAt: resolved.session?.leaseExpiresAt ?? now + DEFAULT_LEASE_MS,
                  status: 'active',
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

    if (toolName === 'get_batch_result') {
      const batchId = typeof toolArgs.batchId === 'string' ? toolArgs.batchId.trim() : '';
      let ack = batchId ? store.ackResults.get(batchId) ?? null : null;
      if (!ack && batchId && getKvConfig()) {
        const rawAck = await kvCommand(['GET', `stagecraft:ai:ack:${batchId}`]);
        if (typeof rawAck === 'string' && rawAck) {
          ack = JSON.parse(rawAck) as Record<string, unknown>;
        }
      }
      const batch = store.history.find((h) => h.batchId === batchId);
      if (!ack) {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: false,
                    batchId,
                    status: batch?.status ?? 'not_found',
                    error: batch
                      ? 'Batch has not been acknowledged by Studio yet.'
                      : 'Batch ID not found.',
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
      const summarized = batch ? summarizeAckPayload(batch, ack) : ack;
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(summarized, null, 2) }],
        },
      });
      return;
    }

    if (toolName === 'delete_session') {
      const targetSid = typeof toolArgs.sessionId === 'string' ? toolArgs.sessionId.trim() : '';
      if (!targetSid || !store.sessions[targetSid]) {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ ok: false, errorCode: 'SESSION_NOT_FOUND', error: 'Session not found.' }) }],
          },
        });
        return;
      }
      const removed = store.sessions[targetSid];
      delete store.sessions[targetSid];
      if (!store.deletedSessionIds.includes(targetSid)) {
        store.deletedSessionIds.push(targetSid);
      }
      recordSceneEvent(
        store,
        'scene_deleted',
        `Deleted session ${targetSid} (was bound to scene "${removed.sceneName}" ${removed.sceneId ?? 'none'})`,
        { sessionId: targetSid, sceneId: removed.sceneId, sceneName: removed.sceneName },
      );
      await savePersistedBridge(store);
      broadcastSse(store, 'ai:config', {
        enabled: store.enabled,
        connectedStudios: getActiveStudiosCount(store),
        sessions: listSessionSummaries(store),
        sceneEvents: store.sceneEvents.slice(0, 30),
      });
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, deletedSessionId: targetSid }) }],
        },
      });
      return;
    }

    if (toolName === 'get_state' || toolName === 'get_studio_state') {
      const argSessionId = typeof toolArgs.sessionId === 'string' ? toolArgs.sessionId : undefined;
      const argSceneId = typeof toolArgs.sceneId === 'string' ? toolArgs.sceneId : undefined;
      const resolved = resolveExistingTarget(store, req, {
        explicitSessionId: argSessionId,
        explicitSceneId: argSceneId,
        clientLabel: 'Claude',
        clientFingerprint: fp,
      });
      if (!resolved.ok) {
        await savePersistedBridge(store);
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ok: false, errorCode: resolved.errorCode, error: resolved.error, ...resolved.extra },
                  null,
                  2,
                ),
              },
            ],
          },
        });
        return;
      }

      await savePersistedBridge(store);
      if (resolved.sessionId) res.setHeader('Mcp-Session-Id', resolved.sessionId);
      const now = Date.now();
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
                  sessionId: resolved.sessionId,
                  sceneId: resolved.sceneId,
                  sceneName: resolved.sceneName,
                  isolatedSession: true,
                  studioConnected: isStudioConnected(store, now),
                  activeStudiosCount: getActiveStudiosCount(store, now),
                  multiClientWarning: store.multiClientWarning,
                  multiStudioWarning: getMultiStudioWarning(store, now),
                  leaseExpiresAt: resolved.session?.leaseExpiresAt ?? now + DEFAULT_LEASE_MS,
                  state: resolved.state,
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
      const argSceneId = typeof toolArgs.sceneId === 'string' ? toolArgs.sceneId : undefined;
      const commands = Array.isArray(toolArgs.commands) ? toolArgs.commands : [];
      const source =
        typeof toolArgs.source === 'string' && toolArgs.source.trim()
          ? toolArgs.source.trim()
          : 'Claude';
      const force = toolArgs.force === true;

      if (commands.length === 0) {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ ok: false, errorCode: 'EMPTY_COMMANDS', error: 'Provide a non-empty commands array.' }) }],
          },
        });
        return;
      }

      const createCmd = commands.find(
        (c): c is Record<string, unknown> =>
          Boolean(c && typeof c === 'object' && (c as { op?: string }).op === 'create_session'),
      );

      if (createCmd) {
        const candidateSid = argSessionId?.trim() || activeSessionId || '';
        const existingSess = candidateSid ? store.sessions[candidateSid] : undefined;
        if (existingSess?.sceneId && !force) {
          res.json({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    errorCode: 'SESSION_ALREADY_BOUND',
                    sessionId: existingSess.sessionId,
                    sceneId: existingSess.sceneId,
                    error: `Session ${existingSess.sessionId} is already bound to scene ${existingSess.sceneId}.`,
                  }),
                },
              ],
            },
          });
          return;
        }
        if (!force) {
          const conflict = checkMultiClientConflict(store, {
            incomingSessionId: candidateSid || undefined,
            clientLabel: source,
            clientFingerprint: fp,
            action: 'new_session',
          });
          if (conflict.conflict) {
            await savePersistedBridge(store);
            res.json({
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: false,
                      errorCode: 'CLIENT_CONFLICT',
                      error: conflict.warning,
                    }),
                  },
                ],
              },
            });
            return;
          }
        }
        const { session } = createExplicitBoundSession(store, 'create_session', {
          requestedLabel:
            typeof createCmd.sceneName === 'string'
              ? createCmd.sceneName
              : typeof createCmd.name === 'string'
                ? createCmd.name
                : undefined,
          bindToSessionId: !existingSess?.sceneId ? candidateSid || undefined : undefined,
          clientLabel: source,
          clientFingerprint: fp,
          requestedSceneId: typeof createCmd.sceneId === 'string' ? createCmd.sceneId : undefined,
        });
        const remaining = commands.filter((c) => c !== createCmd);
        res.setHeader('Mcp-Session-Id', session.sessionId);
        if (remaining.length === 0) {
          await savePersistedBridge(store);
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
                      status: 'completed',
                      sessionId: session.sessionId,
                      sceneId: session.sceneId,
                      sceneName: session.sceneName,
                      results: [{ index: 0, op: 'create_session', ok: true, summary: `Created scene "${session.sceneName}" (${session.sceneId})` }],
                      state: session.state,
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
        const outcome = await dispatchCommandsToStudio(
          store,
          { session, sessionId: session.sessionId, sceneId: session.sceneId!, sceneName: session.sceneName! },
          remaining,
          source,
          true,
        );
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
          },
        });
        return;
      }

      const resolved = resolveExistingTarget(store, req, {
        explicitSessionId: argSessionId,
        explicitSceneId: argSceneId,
        clientLabel: source,
        clientFingerprint: fp,
      });
      if (!resolved.ok) {
        await savePersistedBridge(store);
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { ok: false, errorCode: resolved.errorCode, error: resolved.error, ...resolved.extra },
                  null,
                  2,
                ),
              },
            ],
          },
        });
        return;
      }

      if (resolved.sessionId) res.setHeader('Mcp-Session-Id', resolved.sessionId);
      const outcome = await dispatchCommandsToStudio(
        store,
        {
          session: resolved.session,
          sessionId: resolved.sessionId,
          sceneId: resolved.sceneId,
          sceneName: resolved.sceneName,
        },
        commands,
        resolved.session?.label ?? source,
        true,
      );
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          isError: outcome.ok === false,
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
  for (const dir of getDataDirCandidates()) {
    try {
      const projDir = path.join(dir, 'projects');
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(path.join(projDir, `${payload.syncCode}.json`), serialized, 'utf8');
      return 'disk';
    } catch {
      // Try next dir
    }
  }
  return 'memory';
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
  for (const dir of getDataDirCandidates()) {
    try {
      const raw = await fs.readFile(path.join(dir, 'projects', `${cleanCode}.json`), 'utf8');
      return JSON.parse(raw) as StoredCloudProject;
    } catch {
      // Fallback
    }
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
      'Content-Type, Authorization, X-Stagecraft-Token, Mcp-Session-Id, X-Client-Id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Studio UI reads config + active isolated AI sessions + diagnostics
  app.get('/api/ai/config', async (_req, res) => {
    const store = await loadPersistedBridge();
    const now = Date.now();
    res.json({
      ok: true,
      enabled: store.enabled,
      token: store.tokenRevoked ? '' : store.token,
      tokenRevoked: store.tokenRevoked,
      tokenUpdatedAt: store.tokenUpdatedAt,
      singleClientLock: store.singleClientLock,
      multiClientWarning: store.multiClientWarning,
      multiStudioWarning: getMultiStudioWarning(store, now),
      connectedStudios: getActiveStudiosCount(store, now),
      hasKvPersistence: Boolean(getKvConfig()),
      sessions: listSessionSummaries(store),
      knownScenes: listKnownSceneSummaries(store),
      sceneEvents: store.sceneEvents.slice(0, 40),
      recentBatches: store.history.slice(0, 15),
    });
  });

  // Studio UI updates enable/token/revocation/rotation/lock
  app.post('/api/ai/config', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      regenerateToken?: boolean;
      revokeToken?: boolean;
      token?: string;
      tokenUpdatedAt?: number;
      singleClientLock?: boolean;
      dismissWarning?: boolean;
    };

    if (body.revokeToken) {
      if (store.token) {
        const h = hashToken(store.token);
        if (!store.revokedTokenHashes.includes(h)) store.revokedTokenHashes.push(h);
      }
      const envTok = process.env.STAGECRAFT_TOKEN?.trim();
      if (envTok) {
        const eh = hashToken(envTok);
        if (!store.revokedTokenHashes.includes(eh)) store.revokedTokenHashes.push(eh);
      }
      store.token = '';
      store.tokenRevoked = true;
      store.enabled = false;
      store.envTokenOverridden = true;
      store.tokenUpdatedAt = Date.now();
      recordSceneEvent(
        store,
        'token_revoked',
        'MCP token was revoked; external AI access disabled and prior token invalidated.',
      );
    } else if (body.regenerateToken) {
      if (store.token) {
        const h = hashToken(store.token);
        if (!store.revokedTokenHashes.includes(h)) store.revokedTokenHashes.push(h);
      }
      const envTok = process.env.STAGECRAFT_TOKEN?.trim();
      if (envTok) {
        const eh = hashToken(envTok);
        if (!store.revokedTokenHashes.includes(eh)) store.revokedTokenHashes.push(eh);
      }
      store.token = `sc_${crypto.randomBytes(16).toString('hex')}`;
      store.tokenRevoked = false;
      store.envTokenOverridden = true;
      store.tokenUpdatedAt = Date.now();
      recordSceneEvent(
        store,
        'token_rotated',
        'MCP token was rotated; previous token was revoked.',
      );
    } else if (
      typeof body.token === 'string' &&
      body.token.trim() &&
      !store.tokenRevoked &&
      store.tokenUpdatedAt === 0 &&
      !store.revokedTokenHashes.includes(hashToken(body.token.trim())) &&
      !process.env.STAGECRAFT_TOKEN?.trim()
    ) {
      // Only hydrate cold empty server if server has never rotated/revoked yet
      store.token = body.token.trim();
      store.tokenUpdatedAt = typeof body.tokenUpdatedAt === 'number' ? body.tokenUpdatedAt : Date.now();
    }

    if (typeof body.enabled === 'boolean' && !body.revokeToken) {
      if (body.enabled && store.tokenRevoked) {
        // Re-enabling after revoke auto-generates a fresh token if needed
        store.token = `sc_${crypto.randomBytes(16).toString('hex')}`;
        store.tokenRevoked = false;
        store.tokenUpdatedAt = Date.now();
        recordSceneEvent(store, 'token_rotated', 'Generated fresh MCP token on re-enable after revoke.');
      }
      store.enabled = body.enabled;
    }

    if (typeof body.singleClientLock === 'boolean') {
      store.singleClientLock = body.singleClientLock;
    }
    if (body.dismissWarning) {
      store.multiClientWarning = null;
      store.multiClientWarningAt = 0;
    }

    await savePersistedBridge(store);
    const now = Date.now();
    const configPayload = {
      enabled: store.enabled,
      token: store.tokenRevoked ? '' : store.token,
      tokenRevoked: store.tokenRevoked,
      tokenUpdatedAt: store.tokenUpdatedAt,
      singleClientLock: store.singleClientLock,
      multiClientWarning: store.multiClientWarning,
      multiStudioWarning: getMultiStudioWarning(store, now),
      connectedStudios: getActiveStudiosCount(store, now),
      sessions: listSessionSummaries(store),
      sceneEvents: store.sceneEvents.slice(0, 40),
    };
    broadcastSse(store, 'ai:config', configPayload);
    res.json({ ok: true, ...configPayload });
  });

  // List sessions (authenticated for external AI)
  app.get('/api/ai/sessions', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const now = Date.now();
    res.json({
      ok: true,
      studioConnected: isStudioConnected(store, now),
      activeStudiosCount: getActiveStudiosCount(store, now),
      singleClientLock: store.singleClientLock,
      multiClientWarning: store.multiClientWarning,
      multiStudioWarning: getMultiStudioWarning(store, now),
      sessions: listSessionSummaries(store),
      knownScenes: listKnownSceneSummaries(store),
      recentEvents: store.sceneEvents.slice(0, 20),
    });
  });

  // Explicit REST endpoint to create a new bound AI session
  app.post('/api/ai/sessions', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const body = (req.body ?? {}) as { name?: string; label?: string; force?: boolean; sessionId?: string };
    const fp = computeClientFingerprint(req, body.label ?? body.name ?? 'HTTP AI');

    if (!body.force) {
      const conflict = checkMultiClientConflict(store, {
        incomingSessionId: body.sessionId,
        clientLabel: body.label ?? body.name ?? 'HTTP AI',
        clientFingerprint: fp,
        action: 'new_session',
      });
      if (conflict.conflict) {
        await savePersistedBridge(store);
        res.status(409).json({
          ok: false,
          errorCode: 'CLIENT_CONFLICT',
          activeSessionId: conflict.activeBound?.sessionId,
          activeSceneId: conflict.activeBound?.sceneId,
          activeSceneName: conflict.activeBound?.sceneName,
          error: conflict.warning,
        });
        return;
      }
    }

    const { session } = createExplicitBoundSession(store, 'new_session', {
      requestedLabel: body.name ?? body.label,
      clientLabel: body.label ?? 'HTTP AI',
      clientFingerprint: fp,
    });
    await savePersistedBridge(store);
    res.json({
      ok: true,
      sessionId: session.sessionId,
      sceneId: session.sceneId,
      sceneName: session.sceneName,
      bound: true,
      leaseExpiresAt: session.leaseExpiresAt,
      state: session.state,
    });
  });

  // Session heartbeat / lease renewal
  app.post('/api/ai/sessions/:sessionId/heartbeat', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const sid = String(req.params.sessionId ?? '').trim();
    const session = sid ? store.sessions[sid] : undefined;
    if (!session) {
      res.status(404).json({ ok: false, errorCode: 'SESSION_NOT_FOUND', error: `Session "${sid}" not found.` });
      return;
    }
    const fp = computeClientFingerprint(req, session.clientLabel);
    touchSessionLease(store, session, session.clientLabel, fp);
    await savePersistedBridge(store);
    const now = Date.now();
    res.json({
      ok: true,
      sessionId: session.sessionId,
      sceneId: session.sceneId,
      sceneName: session.sceneName,
      studioConnected: isStudioConnected(store, now),
      leaseExpiresAt: session.leaseExpiresAt,
      status: computeSessionStatus(session, now),
    });
  });

  // Delete/unbind an AI session (called by Studio UI or REST/MCP)
  app.delete('/api/ai/sessions/:sessionId', async (req, res) => {
    const store = await loadPersistedBridge();
    // Allow same-origin Studio UI without bearer header OR external callers with valid token
    const hasAuthHeader = Boolean(extractToken(req));
    if (hasAuthHeader && !isAuthorized(store, req, res)) return;
    const sid = String(req.params.sessionId ?? '').trim();
    const existing = sid ? store.sessions[sid] : undefined;
    if (!existing) {
      res.status(404).json({ ok: false, errorCode: 'SESSION_NOT_FOUND', error: 'Session not found.' });
      return;
    }
    delete store.sessions[sid];
    if (!store.deletedSessionIds.includes(sid)) {
      store.deletedSessionIds.push(sid);
    }
    recordSceneEvent(
      store,
      'scene_deleted',
      `Deleted session ${sid} (was bound to scene "${existing.sceneName}" ${existing.sceneId ?? 'none'})`,
      { sessionId: sid, sceneId: existing.sceneId, sceneName: existing.sceneName },
    );
    await savePersistedBridge(store);
    broadcastSse(store, 'ai:config', {
      enabled: store.enabled,
      connectedStudios: getActiveStudiosCount(store),
      sessions: listSessionSummaries(store),
      sceneEvents: store.sceneEvents.slice(0, 40),
    });
    res.json({ ok: true, deletedSessionId: sid, sessions: listSessionSummaries(store) });
  });

  // Studio notifies server when user deletes a scene in the UI
  app.post('/api/ai/scenes/deleted', async (req, res) => {
    const store = await loadPersistedBridge();
    const sceneId = typeof req.body?.sceneId === 'string' ? req.body.sceneId.trim() : '';
    if (!sceneId) {
      res.status(400).json({ ok: false, error: 'Missing sceneId.' });
      return;
    }
    delete store.knownScenes[sceneId];
    for (const [sid, sess] of Object.entries(store.sessions)) {
      if (sess.sceneId === sceneId) {
        delete store.sessions[sid];
        if (!store.deletedSessionIds.includes(sid)) store.deletedSessionIds.push(sid);
        recordSceneEvent(
          store,
          'scene_deleted',
          `Scene "${sess.sceneName}" (${sceneId}) was deleted in Studio; unbound session ${sid}.`,
          { sessionId: sid, sceneId, sceneName: sess.sceneName },
        );
      }
    }
    await savePersistedBridge(store);
    res.json({ ok: true, sessions: listSessionSummaries(store) });
  });

  // Fetch per-command results for a batchId
  app.get('/api/ai/batches/:batchId', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const batchId = String(req.params.batchId ?? '').trim();
    let ack = batchId ? store.ackResults.get(batchId) ?? null : null;
    if (!ack && batchId && getKvConfig()) {
      const rawAck = await kvCommand(['GET', `stagecraft:ai:ack:${batchId}`]);
      if (typeof rawAck === 'string' && rawAck) {
        ack = JSON.parse(rawAck) as Record<string, unknown>;
      }
    }
    const batch = store.history.find((h) => h.batchId === batchId);
    if (!ack) {
      res.status(batch ? 202 : 404).json({
        ok: false,
        batchId,
        status: batch?.status ?? 'not_found',
        error: batch ? 'Batch still executing in Studio.' : 'Batch ID not found.',
      });
      return;
    }
    res.json(batch ? summarizeAckPayload(batch, ack) : ack);
  });

  // Studio SSE stream
  app.get('/api/ai/stream', async (req, res) => {
    const store = await loadPersistedBridge();
    recordStudioTabHeartbeat(store, req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    store.sseClients.add(res);
    const now = Date.now();
    res.write(
      `event: ai:connected\ndata: ${JSON.stringify({
        enabled: store.enabled,
        tokenRevoked: store.tokenRevoked,
        tokenUpdatedAt: store.tokenUpdatedAt,
        singleClientLock: store.singleClientLock,
        multiClientWarning: store.multiClientWarning,
        multiStudioWarning: getMultiStudioWarning(store, now),
        connectedStudios: getActiveStudiosCount(store, now),
        sessions: listSessionSummaries(store),
        sceneEvents: store.sceneEvents.slice(0, 40),
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

  // Studio pushes live scene snapshot + persisted session bindings (never overwrites server token!)
  app.post('/api/ai/sync-state', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      tabId?: string;
      state?: Record<string, unknown>;
      sessionSnapshots?: Record<string, Record<string, unknown>>;
      knownScenes?: {
        sceneId: string;
        sceneName: string;
        duration?: number;
        charactersCount?: number;
        propsCount?: number;
        state?: Record<string, unknown>;
      }[];
      knownSessionBindings?: {
        sessionId: string;
        label?: string;
        sceneId: string;
        sceneName?: string;
        createdAt?: number;
        lastActivityAt?: number;
        batchCount?: number;
      }[];
      enabled?: boolean;
    };

    recordStudioTabHeartbeat(store, req, body.tabId);
    const now = Date.now();

    const nextState = body.state && typeof body.state === 'object' ? body.state : null;
    if (nextState) {
      store.lastState = nextState;
      store.lastStateUpdatedAt = now;
      const activeSceneId = typeof nextState.sceneId === 'string' ? nextState.sceneId : '';
      if (activeSceneId) {
        store.knownScenes[activeSceneId] = {
          sceneId: activeSceneId,
          sceneName: typeof nextState.sceneName === 'string' ? nextState.sceneName : activeSceneId,
          updatedAt: now,
          duration: typeof nextState.duration === 'number' ? nextState.duration : undefined,
          charactersCount: Array.isArray(nextState.characters) ? nextState.characters.length : undefined,
          propsCount: Array.isArray(nextState.props) ? nextState.props.length : undefined,
          state: nextState,
        };
      }
      for (const s of Object.values(store.sessions)) {
        if (s.sceneId && s.sceneId === activeSceneId) {
          s.state = nextState;
          if (typeof nextState.sceneName === 'string') s.sceneName = nextState.sceneName;
        }
      }
    }

    if (Array.isArray(body.knownScenes)) {
      for (const ks of body.knownScenes) {
        if (!ks || typeof ks.sceneId !== 'string' || !ks.sceneId) continue;
        const prev = store.knownScenes[ks.sceneId];
        store.knownScenes[ks.sceneId] = {
          sceneId: ks.sceneId,
          sceneName: ks.sceneName || prev?.sceneName || ks.sceneId,
          updatedAt: now,
          duration: ks.duration ?? prev?.duration,
          charactersCount: ks.charactersCount ?? prev?.charactersCount,
          propsCount: ks.propsCount ?? prev?.propsCount,
          state: ks.state ?? prev?.state ?? null,
        };
      }
    }

    // Re-hydrate persisted session->scene bindings on cold serverless restarts unless deleted
    if (Array.isArray(body.knownSessionBindings)) {
      for (const kb of body.knownSessionBindings) {
        if (!kb || !kb.sessionId || !kb.sceneId) continue;
        if (store.deletedSessionIds.includes(kb.sessionId)) continue;
        if (!store.sessions[kb.sessionId]) {
          store.sessions[kb.sessionId] = {
            sessionId: kb.sessionId,
            label: kb.label || kb.sceneName || 'Claude Session',
            sceneId: kb.sceneId,
            sceneName: kb.sceneName || kb.label || 'Claude Session',
            createdAt: kb.createdAt ?? now,
            lastActivityAt: kb.lastActivityAt ?? now,
            lastHeartbeatAt: now,
            leaseDurationMs: DEFAULT_LEASE_MS,
            leaseExpiresAt: now + DEFAULT_LEASE_MS,
            batchCount: kb.batchCount ?? 0,
            clientFingerprint: '',
            clientLabel: 'Claude',
            state: store.knownScenes[kb.sceneId]?.state ?? null,
          };
        }
      }
    }

    if (body.sessionSnapshots && typeof body.sessionSnapshots === 'object') {
      for (const [sid, snap] of Object.entries(body.sessionSnapshots)) {
        if (snap && typeof snap === 'object') {
          const snapSceneId = typeof snap.sceneId === 'string' ? snap.sceneId : '';
          if (snapSceneId) {
            store.knownScenes[snapSceneId] = {
              sceneId: snapSceneId,
              sceneName: typeof snap.sceneName === 'string' ? snap.sceneName : snapSceneId,
              updatedAt: now,
              duration: typeof snap.duration === 'number' ? snap.duration : undefined,
              charactersCount: Array.isArray(snap.characters) ? snap.characters.length : undefined,
              propsCount: Array.isArray(snap.props) ? snap.props.length : undefined,
              state: snap,
            };
          }
          if (store.sessions[sid] && (!store.sessions[sid].sceneId || store.sessions[sid].sceneId === snapSceneId)) {
            store.sessions[sid].state = snap;
            if (typeof snap.sceneName === 'string') store.sessions[sid].sceneName = snap.sceneName;
          }
        }
      }
    }

    if (typeof body.enabled === 'boolean' && !store.tokenRevoked) {
      store.enabled = body.enabled;
    }

    await savePersistedBridge(store);
    res.json({
      ok: true,
      enabled: store.enabled,
      token: store.tokenRevoked ? '' : store.token,
      tokenRevoked: store.tokenRevoked,
      tokenUpdatedAt: store.tokenUpdatedAt,
      singleClientLock: store.singleClientLock,
      multiClientWarning: store.multiClientWarning,
      multiStudioWarning: getMultiStudioWarning(store, now),
      connectedStudios: getActiveStudiosCount(store, now),
      sessions: listSessionSummaries(store),
      sceneEvents: store.sceneEvents.slice(0, 40),
    });
  });

  // Studio serverless poll endpoint (NEVER overwrites server token!)
  app.get('/api/ai/poll', async (req, res) => {
    const store = await loadPersistedBridge();
    recordStudioTabHeartbeat(store, req);
    const now = Date.now();
    store.lastStateUpdatedAt = Math.max(store.lastStateUpdatedAt, now);

    const qEnabled = req.query.enabled;
    let changed = false;
    if (qEnabled === '1' && !store.enabled && !store.tokenRevoked) {
      store.enabled = true;
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
      token: store.tokenRevoked ? '' : store.token,
      tokenRevoked: store.tokenRevoked,
      tokenUpdatedAt: store.tokenUpdatedAt,
      singleClientLock: store.singleClientLock,
      multiClientWarning: store.multiClientWarning,
      multiStudioWarning: getMultiStudioWarning(store, now),
      connectedStudios: getActiveStudiosCount(store, now),
      batches,
      sessions: listSessionSummaries(store),
      sceneEvents: store.sceneEvents.slice(0, 40),
    });
  });

  // Studio acknowledges command batch completion with per-command results
  app.post('/api/ai/ack', async (req, res) => {
    const store = await loadPersistedBridge();
    const body = (req.body ?? {}) as {
      batchId?: string;
      sessionId?: string;
      sceneId?: string;
      appliedSceneId?: string | null;
      ok?: boolean;
      results?: unknown[];
      error?: string;
      state?: Record<string, unknown>;
    };
    const now = Date.now();
    if (body.state && typeof body.state === 'object') {
      const stateSceneId = typeof body.state.sceneId === 'string' ? body.state.sceneId : '';
      if (stateSceneId) {
        store.knownScenes[stateSceneId] = {
          sceneId: stateSceneId,
          sceneName: typeof body.state.sceneName === 'string' ? body.state.sceneName : stateSceneId,
          updatedAt: now,
          duration: typeof body.state.duration === 'number' ? body.state.duration : undefined,
          charactersCount: Array.isArray(body.state.characters) ? body.state.characters.length : undefined,
          propsCount: Array.isArray(body.state.props) ? body.state.props.length : undefined,
          state: body.state,
        };
      }
      if (body.sessionId && store.sessions[body.sessionId]) {
        const s = store.sessions[body.sessionId];
        if (!s.sceneId || s.sceneId === stateSceneId) {
          s.state = body.state;
        }
        s.lastActivityAt = now;
      } else {
        store.lastState = body.state;
      }
      store.lastStateUpdatedAt = now;
    }
    if (body.batchId) {
      const entry = store.history.find((h) => h.batchId === body.batchId);
      const resultsArr = Array.isArray(body.results) ? body.results : [];
      const hasFailedCmd = resultsArr.some(
        (r) => r && typeof r === 'object' && (r as { ok?: boolean }).ok === false,
      );
      if (entry) {
        entry.status = body.ok === false ? 'error' : hasFailedCmd ? 'partial_error' : 'completed';
      }
      const ackPayload: Record<string, unknown> = {
        ok: body.ok !== false && !hasFailedCmd,
        sessionId: body.sessionId,
        sceneId: body.sceneId ?? entry?.sceneId,
        appliedSceneId: body.appliedSceneId ?? body.sceneId ?? entry?.sceneId,
        batchId: body.batchId,
        results: resultsArr,
        error: body.error,
        state:
          body.state ??
          (body.sessionId && store.sessions[body.sessionId]?.state) ??
          null,
      };
      store.ackResults.set(body.batchId, ackPayload);
      if (getKvConfig()) {
        await kvCommand(['SET', `stagecraft:ai:ack:${body.batchId}`, JSON.stringify(ackPayload), 'EX', 300]);
      }
      const waiter = store.waiters.get(body.batchId);
      if (waiter) {
        waiter.resolve(ackPayload);
      }
    }
    await savePersistedBridge(store);
    res.json({ ok: true });
  });

  // External AI: Read live scene state (NEVER auto-creates a scene!)
  app.get('/api/ai/state', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const fp = computeClientFingerprint(req, 'HTTP AI');
    const explicitSessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const explicitSceneId = typeof req.query.sceneId === 'string' ? req.query.sceneId : undefined;

    const resolved = resolveExistingTarget(store, req, {
      explicitSessionId,
      explicitSceneId,
      clientLabel: 'HTTP AI',
      clientFingerprint: fp,
    });
    await savePersistedBridge(store);

    if (!resolved.ok) {
      res.status(resolved.httpStatus).json({
        ok: false,
        errorCode: resolved.errorCode,
        error: resolved.error,
        ...resolved.extra,
      });
      return;
    }

    const now = Date.now();
    res.json({
      ok: true,
      sessionId: resolved.sessionId,
      sceneId: resolved.sceneId,
      sceneName: resolved.sceneName,
      studioConnected: isStudioConnected(store, now),
      updatedAt: resolved.session?.lastActivityAt ?? now,
      leaseExpiresAt: resolved.session?.leaseExpiresAt ?? now + DEFAULT_LEASE_MS,
      state: resolved.state,
      commandSchema: COMMAND_SCHEMA_SUMMARY,
    });
  });

  // External AI: Send live commands (NEVER auto-creates a scene unless create_session op is explicitly passed)
  app.post('/api/ai/commands', async (req, res) => {
    const store = await loadPersistedBridge();
    if (!isAuthorized(store, req, res)) return;
    const body = (req.body ?? {}) as {
      sessionId?: string;
      sceneId?: string;
      commands?: unknown[];
      source?: string;
      wait?: boolean;
      force?: boolean;
    };
    const commands = Array.isArray(body.commands) ? body.commands : [];
    if (commands.length === 0) {
      res.status(400).json({ ok: false, errorCode: 'EMPTY_COMMANDS', error: 'Provide a non-empty "commands" array.' });
      return;
    }

    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'External AI';
    const fp = computeClientFingerprint(req, source);
    const createCmd = commands.find(
      (c): c is Record<string, unknown> =>
        Boolean(c && typeof c === 'object' && (c as { op?: string }).op === 'create_session'),
    );

    if (createCmd) {
      if (!body.force) {
        const conflict = checkMultiClientConflict(store, {
          incomingSessionId: body.sessionId,
          clientLabel: source,
          clientFingerprint: fp,
          action: 'new_session',
        });
        if (conflict.conflict) {
          await savePersistedBridge(store);
          res.status(409).json({
            ok: false,
            errorCode: 'CLIENT_CONFLICT',
            error: conflict.warning,
          });
          return;
        }
      }
      const { session } = createExplicitBoundSession(store, 'create_session', {
        requestedLabel:
          typeof createCmd.sceneName === 'string'
            ? createCmd.sceneName
            : typeof createCmd.name === 'string'
              ? createCmd.name
              : source,
        bindToSessionId: body.sessionId,
        clientLabel: source,
        clientFingerprint: fp,
        requestedSceneId: typeof createCmd.sceneId === 'string' ? createCmd.sceneId : undefined,
      });
      const remaining = commands.filter((c) => c !== createCmd);
      if (remaining.length === 0) {
        await savePersistedBridge(store);
        res.json({
          ok: true,
          status: 'completed',
          sessionId: session.sessionId,
          sceneId: session.sceneId,
          sceneName: session.sceneName,
          results: [{ index: 0, op: 'create_session', ok: true, summary: `Created scene "${session.sceneName}" (${session.sceneId})` }],
          state: session.state,
        });
        return;
      }
      const waitForAck = req.query.wait !== 'false' && body.wait !== false;
      const result = await dispatchCommandsToStudio(
        store,
        { session, sessionId: session.sessionId, sceneId: session.sceneId!, sceneName: session.sceneName! },
        remaining,
        source,
        waitForAck,
      );
      res.json(result);
      return;
    }

    const resolved = resolveExistingTarget(store, req, {
      explicitSessionId: body.sessionId,
      explicitSceneId: body.sceneId,
      clientLabel: source,
      clientFingerprint: fp,
    });
    if (!resolved.ok) {
      await savePersistedBridge(store);
      res.status(resolved.httpStatus).json({
        ok: false,
        errorCode: resolved.errorCode,
        error: resolved.error,
        ...resolved.extra,
      });
      return;
    }

    const waitForAck = req.query.wait !== 'false' && body.wait !== false;
    const result = await dispatchCommandsToStudio(
      store,
      {
        session: resolved.session,
        sessionId: resolved.sessionId,
        sceneId: resolved.sceneId,
        sceneName: resolved.sceneName,
      },
      commands,
      resolved.session?.label ?? source,
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
      singleClientLock: store.singleClientLock,
      studioConnected: isStudioConnected(store),
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
        version: '2.0.0',
        description:
          'Allows external AI assistants to bind stably to a Stagecraft 3D scene with explicit sceneId validation, session leases, and per-command results.',
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
          get: {
            operationId: 'listAiSessions',
            summary: 'List real active sessions, bound sceneIds, and Studio scenes',
            responses: { '200': { description: 'Active sessions and known scenes' } },
          },
          post: {
            operationId: 'createAiSession',
            summary: 'Explicitly create a new bound AI scene session',
            responses: { '200': { description: 'Created bound session and starter state' } },
          },
        },
        '/api/ai/state': {
          get: {
            operationId: 'getStudioState',
            summary: 'Read the live 3D scene state for a bound session or explicit sceneId',
            responses: { '200': { description: 'Current studio snapshot' } },
          },
        },
        '/api/ai/commands': {
          post: {
            operationId: 'executeStudioCommands',
            summary: 'Apply live edits to an explicit sceneId / bound session and return per-command results',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['commands'],
                    properties: {
                      sessionId: { type: 'string' },
                      sceneId: { type: 'string' },
                      source: { type: 'string' },
                      commands: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'Per-command execution results and updated state' } },
          },
        },
      },
    });
  });
}
