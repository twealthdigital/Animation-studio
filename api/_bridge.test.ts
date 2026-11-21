import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import { mountAiBridge, resetBridgeStoreForTests } from './_bridge';

let tmpDir: string;
let server: Server;
let baseUrl: string;
let token: string;

async function mcpCall(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  tok?: string,
  query = '',
) {
  const res = await fetch(`${baseUrl}/api/mcp${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    body,
  };
}

function parseToolJson(rpcBody: Record<string, unknown>): Record<string, unknown> {
  const result = rpcBody.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('Stagecraft MCP Bridge Open Access & Stability', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stagecraft-bridge-test-'));
    process.env.STAGECRAFT_BRIDGE_DIR = tmpDir;
    resetBridgeStoreForTests();

    const app = express();
    app.use(express.json({ limit: '5mb' }));
    mountAiBridge(app);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const cfgRes = await fetch(`${baseUrl}/api/ai/config`);
    const cfg = (await cfgRes.json()) as { token: string; enabled: boolean; requireAuth: boolean; singleClientLock: boolean };
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.requireAuth, false);
    assert.equal(cfg.singleClientLock, false);
    token = cfg.token;

    await fetch(`${baseUrl}/api/ai/sync-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId: 'tab_studio_1',
        enabled: true,
        state: {
          sceneId: 'scene_user_main',
          sceneName: 'Main User Scene',
          characters: [{ id: 'char_hero', name: 'Hero' }],
          props: [],
        },
        knownScenes: [
          {
            sceneId: 'scene_user_main',
            sceneName: 'Main User Scene',
            duration: 10,
            charactersCount: 1,
            propsCount: 0,
          },
        ],
      }),
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetBridgeStoreForTests();
    delete process.env.STAGECRAFT_BRIDGE_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('allows Claude custom connector to connect freely without sign-in, token, or auth headers', async () => {
    const probe = await fetch(`${baseUrl}/api/mcp`);
    assert.equal(probe.status, 200);
    const probeJson = (await probe.json()) as { ok: boolean; openAccess: boolean };
    assert.equal(probeJson.ok, true);
    assert.equal(probeJson.openAccess, true);

    // Multiple completely unauthenticated clients can initialize and create sessions freely
    const init1 = await mcpCall('initialize', { clientInfo: { name: 'claude-ai' } }, { 'X-Client-Id': 'user-1' });
    assert.equal(init1.status, 200);
    const sid1 = init1.sessionId!;
    assert.match(sid1, /^sc_sess_/);

    const init2 = await mcpCall('initialize', { clientInfo: { name: 'cursor-ai' } }, { 'X-Client-Id': 'user-2' });
    assert.equal(init2.status, 200);
    const sid2 = init2.sessionId!;
    assert.match(sid2, /^sc_sess_/);

    const ns1 = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Free Scene 1' } },
      { 'Mcp-Session-Id': sid1, 'X-Client-Id': 'user-1' },
    );
    assert.equal(parseToolJson(ns1.body).ok, true);

    const ns2 = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Free Scene 2' } },
      { 'Mcp-Session-Id': sid2, 'X-Client-Id': 'user-2' },
    );
    assert.equal(parseToolJson(ns2.body).ok, true);
  });

  test('never auto-creates scenes from initialize, get_state, or run_commands', async () => {
    const init = await mcpCall('initialize', { clientInfo: { name: 'claude-ai' } });
    assert.equal(init.status, 200);
    const sid = init.sessionId!;
    assert.match(sid, /^sc_sess_/);

    const gs = await mcpCall(
      'tools/call',
      { name: 'get_state', arguments: {} },
      { 'Mcp-Session-Id': sid },
    );
    const gsJson = parseToolJson(gs.body);
    assert.equal(gsJson.ok, false);
    assert.equal(gsJson.errorCode, 'NO_SCENE_BOUND');

    const rc = await mcpCall(
      'tools/call',
      { name: 'run_commands', arguments: { commands: [{ op: 'add_prop', kind: 'box', name: 'Box' }] } },
      { 'Mcp-Session-Id': sid },
    );
    const rcJson = parseToolJson(rc.body);
    assert.equal(rcJson.ok, false);
    assert.equal(rcJson.errorCode, 'NO_SCENE_BOUND');

    const ls = await mcpCall('tools/call', { name: 'list_sessions', arguments: {} }, { 'Mcp-Session-Id': sid });
    const lsJson = parseToolJson(ls.body);
    const sessions = lsJson.sessions as { bound: boolean; sceneId: string | null }[];
    assert.equal(sessions.every((s) => !s.bound && s.sceneId === null), true);
  });

  test('new_session binds one session to one immutable scene across reconnects and cold restarts', async () => {
    const init = await mcpCall('initialize', { clientInfo: { name: 'claude-ai' } });
    const sid = init.sessionId!;

    const created = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Night City' } },
      { 'Mcp-Session-Id': sid },
    );
    const createdJson = parseToolJson(created.body);
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.sessionId, sid);
    const sceneId = createdJson.sceneId as string;
    assert.match(sceneId, /^scene_ai_/);

    const ls = await mcpCall('tools/call', { name: 'list_sessions', arguments: {} }, { 'Mcp-Session-Id': sid });
    const lsJson = parseToolJson(ls.body);
    const sessions = lsJson.sessions as { sessionId: string; sceneId: string; bound: boolean }[];
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sid);
    assert.equal(sessions[0].sceneId, sceneId);
    assert.equal(sessions[0].bound, true);

    const reinit = await mcpCall(
      'initialize',
      { clientInfo: { name: 'claude-ai' } },
      { 'Mcp-Session-Id': sid },
    );
    assert.equal(reinit.sessionId, sid);

    const hb = await mcpCall(
      'tools/call',
      { name: 'heartbeat', arguments: { sceneId } },
      { 'Mcp-Session-Id': sid },
    );
    const hbJson = parseToolJson(hb.body);
    assert.equal(hbJson.ok, true);
    assert.equal(hbJson.sceneId, sceneId);

    resetBridgeStoreForTests();
    const gsAfterRestart = await mcpCall(
      'tools/call',
      { name: 'get_state', arguments: { sceneId } },
      { 'Mcp-Session-Id': sid },
    );
    const gsJson = parseToolJson(gsAfterRestart.body);
    assert.equal(gsJson.ok, true);
    assert.equal(gsJson.sessionId, sid);
    assert.equal(gsJson.sceneId, sceneId);
    assert.equal((gsJson.state as { characters?: unknown[] })?.characters?.length ?? 0, 0);
  });

  test('enforces explicit sceneId validation and rejects mismatched sceneId', async () => {
    const init = await mcpCall('initialize', { clientInfo: { name: 'claude-ai' } });
    const sid = init.sessionId!;
    const created = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Scene A' } },
      { 'Mcp-Session-Id': sid },
    );
    const sceneA = parseToolJson(created.body).sceneId as string;

    const wrongGet = await mcpCall(
      'tools/call',
      { name: 'get_state', arguments: { sceneId: 'scene_user_main' } },
      { 'Mcp-Session-Id': sid },
    );
    const wrongJson = parseToolJson(wrongGet.body);
    assert.equal(wrongJson.ok, false);
    assert.equal(wrongJson.errorCode, 'SCENE_MISMATCH');

    const wrongCmd = await mcpCall(
      'tools/call',
      {
        name: 'run_commands',
        arguments: {
          sceneId: 'scene_other_999',
          commands: [{ op: 'add_prop', kind: 'box', name: 'Stray Box' }],
        },
      },
      { 'Mcp-Session-Id': sid },
    );
    const wrongCmdJson = parseToolJson(wrongCmd.body);
    assert.equal(wrongCmdJson.ok, false);
    assert.equal(wrongCmdJson.errorCode, 'SCENE_MISMATCH');

    const rightGet = await mcpCall(
      'tools/call',
      { name: 'get_state', arguments: { sceneId: sceneA } },
      { 'Mcp-Session-Id': sid },
    );
    assert.equal(parseToolJson(rightGet.body).ok, true);
  });

  test('enforces single-client lock when explicitly enabled', async () => {
    await fetch(`${baseUrl}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ singleClientLock: true }),
    });

    const init1 = await mcpCall(
      'initialize',
      { clientInfo: { name: 'claude-ai' } },
      { 'X-Client-Id': 'client-alpha' },
    );
    const sid1 = init1.sessionId!;
    await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Alpha Scene' } },
      { 'Mcp-Session-Id': sid1, 'X-Client-Id': 'client-alpha' },
    );

    const init2 = await mcpCall(
      'initialize',
      { clientInfo: { name: 'cursor-agent' } },
      { 'X-Client-Id': 'client-beta' },
    );
    assert.equal(init2.status, 409);

    const poll2 = await fetch(`${baseUrl}/api/ai/poll?tabId=tab_studio_2`);
    const poll2Json = (await poll2.json()) as { multiStudioWarning: string | null };
    assert.ok(poll2Json.multiStudioWarning?.includes('2 Stagecraft Studio browser tabs'));
  });

  test('returns per-command results for large batches instead of only queued', async () => {
    const init = await mcpCall('initialize', { clientInfo: { name: 'claude-ai' } });
    const sid = init.sessionId!;
    const created = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Batch Scene' } },
      { 'Mcp-Session-Id': sid },
    );
    const sceneId = parseToolJson(created.body).sceneId as string;

    await fetch(`${baseUrl}/api/ai/poll?tabId=tab_studio_1`);

    const commands = Array.from({ length: 30 }, (_, idx) => ({
      op: 'add_prop',
      kind: 'box',
      name: `Prop_${idx}`,
    }));

    const runPromise = mcpCall(
      'tools/call',
      { name: 'run_commands', arguments: { sceneId, commands } },
      { 'Mcp-Session-Id': sid },
    );

    await new Promise((r) => setTimeout(r, 80));
    const pollRes = await fetch(`${baseUrl}/api/ai/poll?tabId=tab_studio_1`);
    const pollData = (await pollRes.json()) as {
      batches: { batchId: string; sceneId: string; commands: unknown[] }[];
    };
    const batch = pollData.batches.find((b) => b.commands.length === 30);
    assert.ok(batch);

    const perCmdResults = commands.map((c, index) => ({
      index,
      op: c.op,
      ok: index !== 17,
      summary: index === 17 ? 'Simulated error on prop 17' : `Added ${c.name}`,
    }));

    await fetch(`${baseUrl}/api/ai/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: batch!.batchId,
        sessionId: sid,
        sceneId,
        appliedSceneId: sceneId,
        ok: false,
        results: perCmdResults,
        state: { sceneId, sceneName: 'Batch Scene', props: Array(29).fill({}) },
      }),
    });

    const runRes = await runPromise;
    const outcome = parseToolJson(runRes.body);
    assert.equal(outcome.status, 'partial_error');
    assert.equal(outcome.totalCommands, 30);
    assert.equal(outcome.succeededCount, 29);
    assert.equal(outcome.failedCount, 1);
    assert.equal(outcome.sceneMatch, true);
    assert.equal(Array.isArray(outcome.results), true);
    assert.equal((outcome.results as unknown[]).length, 30);

    const fetched = await mcpCall(
      'tools/call',
      { name: 'get_batch_result', arguments: { batchId: batch!.batchId } },
      { 'Mcp-Session-Id': sid },
    );
    const fetchedJson = parseToolJson(fetched.body);
    assert.equal(fetchedJson.totalCommands, 30);
    assert.equal(fetchedJson.failedCount, 1);
  });

  test('supports optional token auth, rotation, and revocation when enabled', async () => {
    await fetch(`${baseUrl}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireAuth: true }),
    });

    const oldToken = token;

    const rotRes = await fetch(`${baseUrl}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerateToken: true }),
    });
    const rotData = (await rotRes.json()) as { token: string; tokenRevoked: boolean };
    assert.ok(rotData.token);
    assert.notEqual(rotData.token, oldToken);
    assert.equal(rotData.tokenRevoked, false);

    await fetch(`${baseUrl}/api/ai/poll?tabId=tab_studio_1&token=${encodeURIComponent(oldToken)}`);

    const oldCall = await mcpCall('tools/call', { name: 'list_sessions', arguments: {} }, {}, oldToken);
    assert.equal(oldCall.status, 401);
    assert.equal(oldCall.body.errorCode, 'TOKEN_REVOKED');

    const newCall = await mcpCall('tools/call', { name: 'list_sessions', arguments: {} }, {}, rotData.token);
    assert.equal(newCall.status, 200);

    const revRes = await fetch(`${baseUrl}/api/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revokeToken: true }),
    });
    const revData = (await revRes.json()) as { tokenRevoked: boolean; enabled: boolean };
    assert.equal(revData.tokenRevoked, true);
    assert.equal(revData.enabled, false);

    const afterRevoke = await mcpCall('tools/call', { name: 'list_sessions', arguments: {} }, {}, rotData.token);
    assert.equal(afterRevoke.status, 403);
  });

  test('session stays bound until explicitly deleted, then allows new session', async () => {
    const init = await mcpCall('initialize', { clientInfo: { name: 'claude-ai' } });
    const sid = init.sessionId!;
    await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'First Scene' } },
      { 'Mcp-Session-Id': sid },
    );

    const dup = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Second Scene' } },
      { 'Mcp-Session-Id': sid },
    );
    assert.equal(parseToolJson(dup.body).errorCode, 'SESSION_ALREADY_BOUND');

    const del = await mcpCall(
      'tools/call',
      { name: 'delete_session', arguments: { sessionId: sid } },
      { 'Mcp-Session-Id': sid },
    );
    assert.equal(parseToolJson(del.body).ok, true);

    const created2 = await mcpCall(
      'tools/call',
      { name: 'new_session', arguments: { name: 'Fresh Scene' } },
      { 'Mcp-Session-Id': sid },
    );
    assert.equal(parseToolJson(created2.body).ok, true);
  });
});
