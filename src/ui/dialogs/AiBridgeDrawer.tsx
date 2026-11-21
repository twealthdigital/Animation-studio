import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AiBridgeLogEntry,
  AiBridgeStateSnapshot,
  AiSessionSummary,
  SceneCreationEvent,
  SceneEventCause,
} from '../../core/types';
import { buildUniversalAiPrompt } from '../../engine/AiBridgeExecutor';
import { StudioButton, StudioSlider } from '../components/Primitives';

interface AiBridgeDrawerProps {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
  requireAuth: boolean;
  token: string;
  tokenRevoked: boolean;
  tokenUpdatedAt: number;
  singleClientLock: boolean;
  multiClientWarning: string | null;
  multiStudioWarning: string | null;
  connectedStudios: number;
  paused: boolean;
  stepDelayMs: number;
  autoHighlight: boolean;
  autoSwitchSession: boolean;
  activeSceneId: string;
  sessions: AiSessionSummary[];
  sceneEvents: SceneCreationEvent[];
  queueLength: number;
  logs: AiBridgeLogEntry[];
  snapshot: AiBridgeStateSnapshot;
  canUndoAiBatch: boolean;
  onToggleEnabled: (next: boolean) => void;
  onToggleRequireAuth: (next: boolean) => void;
  onRegenerateToken: () => void;
  onRevokeToken: () => void;
  onToggleSingleClientLock: (next: boolean) => void;
  onDismissMultiClientWarning: () => void;
  onTogglePaused: () => void;
  onChangeStepDelay: (ms: number) => void;
  onToggleAutoHighlight: (next: boolean) => void;
  onToggleAutoSwitchSession: (next: boolean) => void;
  onSelectSessionScene: (sceneId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onUndoLastAiBatch: () => void;
  onClearLogs: () => void;
  onRunManualJson: (rawText: string) => void;
}

type DrawerTab = 'connect' | 'watch-log' | 'events' | 'run-json';

const EXAMPLE_AI_JSON = `{
  "source": "Manual AI JSON",
  "commands": [
    { "op": "update_stage", "floorShape": "square", "floorColor": "#1e293b", "showClouds": true, "cloudColor": "#93c5fd" },
    { "op": "add_prop", "kind": "podium", "name": "Spotlight Stage", "color": "#e8702a", "position": { "x": 0, "y": 0, "z": 0 } },
    { "op": "set_time", "time": 2.0 }
  ]
}`;

const CAUSE_BADGE_STYLES: Record<SceneEventCause, string> = {
  new_session: 'border-[#166534] bg-[#14532d]/40 text-[#4ade80]',
  create_session: 'border-[#166534] bg-[#14532d]/40 text-[#4ade80]',
  reconnect: 'border-[#1d4ed8] bg-[#1e3a8a]/30 text-[#93c5fd]',
  timeout: 'border-[#92400e] bg-[#78350f]/30 text-[#fbbf24]',
  another_client: 'border-[#991b1b] bg-[#7f1d1d]/40 text-[#fca5a5]',
  rejected_auto_create: 'border-[#92400e] bg-[#78350f]/30 text-[#fcd34d]',
  scene_mismatch: 'border-[#991b1b] bg-[#7f1d1d]/40 text-[#fca5a5]',
  scene_deleted: 'border-[#4b5563] bg-[#374151]/40 text-[#d1d5db]',
  token_rotated: 'border-[#6d28d9] bg-[#4c1d95]/40 text-[#c4b5fd]',
  token_revoked: 'border-[#991b1b] bg-[#7f1d1d]/40 text-[#fca5a5]',
};

export function AiBridgeDrawer({
  open,
  onClose,
  enabled,
  requireAuth,
  token,
  tokenRevoked,
  tokenUpdatedAt,
  singleClientLock,
  multiClientWarning,
  multiStudioWarning,
  connectedStudios,
  paused,
  stepDelayMs,
  autoHighlight,
  autoSwitchSession,
  activeSceneId,
  sessions,
  sceneEvents,
  queueLength,
  logs,
  snapshot,
  canUndoAiBatch,
  onToggleEnabled,
  onToggleRequireAuth,
  onRegenerateToken,
  onRevokeToken,
  onToggleSingleClientLock,
  onDismissMultiClientWarning,
  onTogglePaused,
  onChangeStepDelay,
  onToggleAutoHighlight,
  onToggleAutoSwitchSession,
  onSelectSessionScene,
  onDeleteSession,
  onUndoLastAiBatch,
  onClearLogs,
  onRunManualJson,
}: AiBridgeDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>('connect');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState(EXAMPLE_AI_JSON);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const effectiveDisplayToken = tokenRevoked || !token ? 'TOKEN_REVOKED_ROTATE_TO_GENERATE' : token;

  const mcpSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'stagecraft-3d': requireAuth
              ? {
                  type: 'http',
                  url: `${origin}/api/mcp`,
                  headers: {
                    Authorization: `Bearer ${effectiveDisplayToken}`,
                  },
                }
              : {
                  type: 'http',
                  url: `${origin}/api/mcp`,
                },
          },
        },
        null,
        2,
      ),
    [origin, requireAuth, effectiveDisplayToken],
  );

  const claudeConnectorUrl = useMemo(
    () =>
      !requireAuth
        ? `${origin}/api/mcp`
        : tokenRevoked || !token
          ? 'Token revoked — click "Rotate Token" below to generate a new URL'
          : `${origin}/api/mcp?token=${encodeURIComponent(token)}`,
    [origin, requireAuth, token, tokenRevoked],
  );

  const curlSnippet = useMemo(
    () =>
      requireAuth
        ? `curl -X POST "${origin}/api/ai/commands" \\\n  -H "Authorization: Bearer ${effectiveDisplayToken}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sceneId":"${snapshot.sceneId}","source":"External AI","commands":[{"op":"add_prop","kind":"box","name":"AI Box","color":"#e8702a","position":{"x":0,"y":0,"z":0}}]}'`
        : `curl -X POST "${origin}/api/ai/commands" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sceneId":"${snapshot.sceneId}","source":"External AI","commands":[{"op":"add_prop","kind":"box","name":"AI Box","color":"#e8702a","position":{"x":0,"y":0,"z":0}}]}'`,
    [origin, requireAuth, effectiveDisplayToken, snapshot.sceneId],
  );

  if (!open) return null;

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      // Fallback ignored
    }
  };

  const boundSessions = sessions.filter((s) => s.bound && s.sceneId);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="AI Live Access & Watch Mode"
      className="fixed right-3 top-14 z-50 flex max-h-[calc(100vh-70px)] w-[450px] max-w-[95vw] flex-col rounded-md border border-[#383e49] bg-[#191b1f] text-xs text-[#e6e8ec] shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#2a2e36] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#e8702a]" aria-hidden="true" />
          <div>
            <div className="font-semibold text-[#e6e8ec]">AI Live Access &amp; Watch Mode</div>
            <div className="text-[10px] text-[#98a0ad]">
              {!enabled
                ? 'Bridge Paused · Enable to connect external AIs'
                : requireAuth
                  ? tokenRevoked
                    ? 'Token Revoked · Generate a new token to reconnect'
                    : 'Token Auth Required · 1 Session = 1 Stable Scene'
                  : 'Free Open Access · Anyone can connect without signing in'}
              {connectedStudios > 0 ? ` · ${connectedStudios} tab(s) synced` : ''}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AI Bridge Drawer"
          className="flex h-6 w-6 items-center justify-center rounded text-[#98a0ad] hover:bg-[#2a2e36] hover:text-white"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Multi-Client / Multi-Tab Warning Banner */}
      {(multiClientWarning || multiStudioWarning) && (
        <div className="border-b border-[#7f2d2d] bg-[#2a1717] px-3.5 py-2 text-[11px] text-[#fecaca] space-y-1">
          {multiClientWarning && (
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f87171]" />
                <span>{multiClientWarning}</span>
              </div>
              <button
                type="button"
                onClick={onDismissMultiClientWarning}
                className="shrink-0 text-[10px] text-[#fca5a5] hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}
          {multiStudioWarning && (
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fbbf24]" />
              <span className="text-[#fde68a]">{multiStudioWarning}</span>
            </div>
          )}
        </div>
      )}

      {/* Master Enable & Watch Controls */}
      <div className="space-y-2.5 border-b border-[#2a2e36] bg-[#14161a] px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggleEnabled(e.target.checked)}
              className="accent-[#e8702a]"
            />
            <span>Allow External AI Access</span>
          </label>
          <span
            className={`rounded px-2 py-0.5 font-mono-code text-[10px] font-semibold ${
              tokenRevoked
                ? 'border border-[#7f2d2d] bg-[#2a1717] text-[#f87171]'
                : enabled
                  ? 'border border-[#166534] bg-[#14532d]/40 text-[#4ade80]'
                  : 'border border-[#383e49] bg-[#1f232b] text-[#98a0ad]'
            }`}
          >
            {!enabled ? 'PAUSED' : requireAuth ? (tokenRevoked ? 'REVOKED' : 'TOKEN ON') : 'OPEN ACCESS'}
          </span>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[#cbd5e1]">
          <input
            type="checkbox"
            checked={requireAuth}
            onChange={(e) => onToggleRequireAuth(e.target.checked)}
            className="accent-[#e8702a]"
          />
          <span>Require Token Auth (off = free open access, no sign-in)</span>
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[#cbd5e1]">
          <input
            type="checkbox"
            checked={singleClientLock}
            onChange={(e) => onToggleSingleClientLock(e.target.checked)}
            className="accent-[#e8702a]"
          />
          {singleClientLock ? (
            <ShieldCheck className="h-3.5 w-3.5 text-[#4ade80]" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5 text-[#fbbf24]" />
          )}
          <span>Lock token to one active AI session (rejects 2nd client)</span>
        </label>

        {/* Watch Mode Controls */}
        <div className="rounded border border-[#2a2e36] bg-[#191b1f] p-2 space-y-2">
          <div className="flex items-center justify-between gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#98a0ad]">
              Watch Mode ({queueLength} queued)
            </span>
            <div className="flex items-center gap-1">
              <StudioButton size="xs" onClick={onTogglePaused}>
                {paused ? <Play className="h-3 w-3 text-[#4ade80]" /> : <Pause className="h-3 w-3 text-[#f59e0b]" />}
                <span>{paused ? 'Resume AI' : 'Pause AI'}</span>
              </StudioButton>
              <StudioButton size="xs" disabled={!canUndoAiBatch} onClick={onUndoLastAiBatch}>
                <RotateCcw className="h-3 w-3" />
                <span>Undo AI</span>
              </StudioButton>
            </div>
          </div>

          <StudioSlider
            label="Step Delay"
            value={stepDelayMs}
            min={0}
            max={1200}
            step={50}
            displayValue={`${stepDelayMs} ms`}
            onChange={onChangeStepDelay}
          />

          <label className="flex items-center gap-2 text-[11px] text-[#98a0ad]">
            <input
              type="checkbox"
              checked={autoHighlight}
              onChange={(e) => onToggleAutoHighlight(e.target.checked)}
              className="accent-[#e8702a]"
            />
            <span>Auto-select &amp; highlight each part as the AI edits it</span>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[#98a0ad]">
            <input
              type="checkbox"
              checked={autoSwitchSession}
              onChange={(e) => onToggleAutoSwitchSession(e.target.checked)}
              className="accent-[#e8702a]"
            />
            <span>Auto-switch viewport when a new session is explicitly created</span>
          </label>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#2a2e36] bg-[#16181c] px-2 pt-1.5 gap-1">
        {(
          [
            { id: 'connect', label: 'Connect' },
            { id: 'watch-log', label: `Log (${logs.length})` },
            { id: 'events', label: `Events (${sceneEvents.length})` },
            { id: 'run-json', label: 'Run JSON' },
          ] as { id: DrawerTab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-t px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
              tab === t.id
                ? 'border border-b-0 border-[#2a2e36] bg-[#191b1f] text-[#e8702a]'
                : 'text-[#98a0ad] hover:text-[#e6e8ec]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {tab === 'connect' && (
          <>
            {/* Claude Remote Connector URL */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">1. Claude Remote Connector URL</span>
                <span className="rounded bg-[#2b211a] px-1.5 py-0.5 text-[9px] font-semibold text-[#e8702a]">
                  {requireAuth ? 'TOKEN AUTH' : 'NO SIGN-IN NEEDED'}
                </span>
              </div>
              <p className="text-[11px] text-[#98a0ad]">
                In Claude (Pro/Max/Team): <strong className="text-[#e6e8ec]">Settings → Connectors → Add custom connector</strong>:
              </p>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded border border-[#2a2e36] bg-[#101215] px-2 py-1 font-mono-code text-[10px] text-[#e6e8ec]">
                  {claudeConnectorUrl}
                </code>
                <StudioButton
                  variant="primary"
                  size="xs"
                  disabled={requireAuth && (tokenRevoked || !token)}
                  onClick={() => void copyText('claude-url', claudeConnectorUrl)}
                >
                  {copiedId === 'claude-url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'claude-url' ? 'Copied' : 'Copy URL'}</span>
                </StudioButton>
              </div>
              <p className="text-[10px] text-[#4ade80]">
                1 Session = 1 Scene: Scenes are only created on explicit <code>new_session</code> / <code>create_session</code> and stay bound across reconnects until deleted.
              </p>
            </div>

            {/* Active Bound AI Sessions */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">
                  Bound AI Sessions ({boundSessions.length})
                </span>
                <span className="text-[10px] text-[#98a0ad]">Stable until deleted</span>
              </div>
              {boundSessions.length === 0 ? (
                <div className="rounded border border-dashed border-[#2a2e36] p-2 text-[11px] text-[#6b7280]">
                  No bound scene sessions yet. Claude can call <code>new_session</code> or pass an existing <code>sceneId</code>.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {boundSessions.map((sess) => {
                    const isWatching = sess.sceneId === activeSceneId;
                    return (
                      <div
                        key={sess.sessionId}
                        className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 ${
                          isWatching
                            ? 'border-[#e8702a] bg-[#2a211c]'
                            : 'border-[#2a2e36] bg-[#101215]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-medium text-[#e6e8ec]">
                              {sess.sceneName ?? sess.label}
                            </span>
                            {sess.status && (
                              <span
                                className={`rounded px-1 py-0.2 font-mono-code text-[8px] uppercase ${
                                  sess.status === 'active'
                                    ? 'bg-[#14532d]/50 text-[#4ade80]'
                                    : sess.status === 'idle'
                                      ? 'bg-[#1e3a8a]/40 text-[#93c5fd]'
                                      : 'bg-[#78350f]/40 text-[#fbbf24]'
                                }`}
                              >
                                {sess.status}
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono-code text-[9px] text-[#98a0ad]">
                            {sess.sessionId} · {sess.sceneId} · {sess.batchCount} batch(es)
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <StudioButton
                            size="xs"
                            variant={isWatching ? 'primary' : 'default'}
                            onClick={() => sess.sceneId && onSelectSessionScene(sess.sceneId)}
                          >
                            <span>{isWatching ? 'Watching' : 'Watch'}</span>
                          </StudioButton>
                          <button
                            type="button"
                            title="Delete session binding"
                            aria-label={`Delete session ${sess.sessionId}`}
                            onClick={() => onDeleteSession(sess.sessionId)}
                            className="flex h-6 w-6 items-center justify-center rounded border border-[#2a2e36] text-[#98a0ad] hover:border-[#7f2d2d] hover:bg-[#2a1717] hover:text-[#f87171]"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Token Security, Rotation & Revocation */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#e6e8ec]">2. MCP Token Security</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onRegenerateToken}
                    className="flex items-center gap-1 text-[10px] text-[#98a0ad] hover:text-[#e8702a]"
                  >
                    <RefreshCw className="h-2.5 w-2.5" />
                    <span>Rotate Token</span>
                  </button>
                  <button
                    type="button"
                    disabled={tokenRevoked}
                    onClick={onRevokeToken}
                    className="flex items-center gap-1 text-[10px] text-[#f87171] hover:underline disabled:opacity-40"
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                    <span>Revoke Token</span>
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded border border-[#2a2e36] bg-[#101215] px-2 py-1 font-mono-code text-[10px] text-[#e6e8ec]">
                  {tokenRevoked || !token ? 'REVOKED (all prior tokens invalidated)' : token}
                </code>
                <StudioButton
                  size="xs"
                  disabled={tokenRevoked || !token}
                  onClick={() => void copyText('token', token)}
                >
                  {copiedId === 'token' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'token' ? 'Copied' : 'Token'}</span>
                </StudioButton>
              </div>
              {tokenUpdatedAt > 0 && (
                <div className="text-[10px] text-[#6b7280]">
                  Last rotated/revoked: {new Date(tokenUpdatedAt).toLocaleString()}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                <StudioButton
                  size="xs"
                  onClick={() => void copyText('openapi', `${origin}/api/ai/openapi.json`)}
                >
                  {copiedId === 'openapi' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'openapi' ? 'Copied URL' : 'OpenAPI URL (GPT)'}</span>
                </StudioButton>
                <StudioButton size="xs" onClick={() => void copyText('curl', curlSnippet)}>
                  {copiedId === 'curl' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'curl' ? 'Copied cURL' : 'Copy cURL Test'}</span>
                </StudioButton>
              </div>
            </div>

            {/* Universal Chat AI Copy */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">3. Any Chat AI (Free Claude, ChatGPT, Gemini)</span>
              </div>
              <p className="text-[11px] text-[#98a0ad]">
                Copies your current 3D scene JSON (with <code>sceneId</code>) + instructions for <strong className="text-[#e6e8ec]">Run JSON</strong>.
              </p>
              <StudioButton
                size="xs"
                className="w-full"
                onClick={() =>
                  void copyText('prompt', buildUniversalAiPrompt(origin, effectiveDisplayToken, snapshot))
                }
              >
                {copiedId === 'prompt' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span>
                  {copiedId === 'prompt' ? 'Copied AI Prompt + Scene State!' : 'Copy Universal AI Prompt + Live Scene'}
                </span>
              </StudioButton>
            </div>

            {/* MCP Config */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">4. MCP Config (Claude Desktop / Cursor / Windsurf)</span>
                <StudioButton
                  size="xs"
                  disabled={requireAuth && (tokenRevoked || !token)}
                  onClick={() => void copyText('mcp', mcpSnippet)}
                >
                  {copiedId === 'mcp' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'mcp' ? 'Copied' : 'Copy MCP'}</span>
                </StudioButton>
              </div>
              <pre className="max-h-32 overflow-auto rounded border border-[#2a2e36] bg-[#101215] p-2 font-mono-code text-[10px] text-[#98a0ad]">
                {mcpSnippet}
              </pre>
            </div>
          </>
        )}

        {tab === 'watch-log' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#98a0ad]">Live stream of AI edit actions</span>
              {logs.length > 0 && (
                <button
                  type="button"
                  onClick={onClearLogs}
                  className="flex items-center gap-1 text-[10px] text-[#98a0ad] hover:text-white"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              )}
            </div>
            {logs.length === 0 ? (
              <div className="rounded border border-dashed border-[#2a2e36] p-4 text-center text-[11px] text-[#6b7280]">
                No AI edits yet. Enable access above or paste JSON commands in Run JSON to watch live edits.
              </div>
            ) : (
              <div className="space-y-1.5">
                {logs.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded border border-[#2a2e36] bg-[#14161a] px-2.5 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[#e6e8ec]">{entry.summary}</span>
                      <span
                        className={`font-mono-code text-[9px] uppercase ${
                          entry.status === 'applied'
                            ? 'text-[#4ade80]'
                            : entry.status === 'error'
                              ? 'text-[#f87171]'
                              : entry.status === 'running'
                                ? 'text-[#e8702a]'
                                : 'text-[#98a0ad]'
                        }`}
                      >
                        {entry.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-[#6b7280]">
                      <span className="truncate">
                        {entry.source}
                        {entry.sceneName ? ` · ${entry.sceneName}` : ''}
                      </span>
                      <span className="font-mono-code shrink-0">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'events' && (
          <div className="space-y-2">
            <div className="text-[11px] text-[#98a0ad]">
              Scene-creation, reconnect, timeout &amp; conflict audit log
            </div>
            {sceneEvents.length === 0 ? (
              <div className="rounded border border-dashed border-[#2a2e36] p-4 text-center text-[11px] text-[#6b7280]">
                No scene-creation or session events recorded yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {sceneEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className="rounded border border-[#2a2e36] bg-[#14161a] px-2.5 py-2 text-[11px] space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono-code text-[9px] uppercase ${
                          CAUSE_BADGE_STYLES[ev.cause] ?? 'border-[#383e49] text-[#98a0ad]'
                        }`}
                      >
                        {ev.cause}
                      </span>
                      <span className="font-mono-code text-[10px] text-[#6b7280]">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-[#e6e8ec]">{ev.detail}</div>
                    {(ev.sessionId || ev.sceneId) && (
                      <div className="font-mono-code text-[9px] text-[#98a0ad] truncate">
                        {ev.sessionId ? `sess: ${ev.sessionId}` : ''}
                        {ev.sessionId && ev.sceneId ? ' · ' : ''}
                        {ev.sceneId ? `scene: ${ev.sceneId}` : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'run-json' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#98a0ad]">
                Paste AI output (raw JSON or ```json``` block)
              </span>
              <button
                type="button"
                onClick={() => {
                  setJsonInput(EXAMPLE_AI_JSON);
                  setJsonError(null);
                }}
                className="text-[10px] text-[#e8702a] hover:underline"
              >
                Load Example
              </button>
            </div>
            <textarea
              value={jsonInput}
              onChange={(e) => {
                setJsonInput(e.target.value);
                setJsonError(null);
              }}
              rows={9}
              spellCheck={false}
              className="w-full rounded border border-[#2a2e36] bg-[#101215] p-2 font-mono-code text-[11px] text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
            />
            {jsonError && (
              <div className="rounded border border-[#7f2d2d] bg-[#2a1717] p-2 text-[11px] text-[#f3b3b3]">
                {jsonError}
              </div>
            )}
            <StudioButton
              variant="primary"
              size="xs"
              className="w-full"
              onClick={() => {
                try {
                  onRunManualJson(jsonInput);
                  setJsonError(null);
                  setTab('watch-log');
                } catch (err) {
                  setJsonError(err instanceof Error ? err.message : 'Invalid JSON commands');
                }
              }}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>Watch AI Execute Commands Live</span>
            </StudioButton>
          </div>
        )}
      </div>
    </div>
  );
}
