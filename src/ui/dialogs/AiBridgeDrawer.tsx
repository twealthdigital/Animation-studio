import { useMemo, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { AiBridgeLogEntry, AiBridgeStateSnapshot } from '../../core/types';
import { buildUniversalAiPrompt } from '../../engine/AiBridgeExecutor';
import { StudioButton, StudioSlider } from '../components/Primitives';

interface AiBridgeDrawerProps {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
  token: string;
  connectedStudios: number;
  paused: boolean;
  stepDelayMs: number;
  autoHighlight: boolean;
  queueLength: number;
  logs: AiBridgeLogEntry[];
  snapshot: AiBridgeStateSnapshot;
  canUndoAiBatch: boolean;
  onToggleEnabled: (next: boolean) => void;
  onRegenerateToken: () => void;
  onTogglePaused: () => void;
  onChangeStepDelay: (ms: number) => void;
  onToggleAutoHighlight: (next: boolean) => void;
  onUndoLastAiBatch: () => void;
  onClearLogs: () => void;
  onRunManualJson: (rawText: string) => void;
}

type DrawerTab = 'connect' | 'watch-log' | 'run-json';

const EXAMPLE_AI_JSON = `{
  "source": "Manual AI JSON",
  "commands": [
    { "op": "update_stage", "floorShape": "square", "floorColor": "#1e293b", "showClouds": true, "cloudColor": "#93c5fd" },
    { "op": "add_prop", "kind": "podium", "name": "Spotlight Stage", "color": "#e8702a", "position": { "x": 0, "y": 0, "z": 0 } },
    { "op": "set_time", "time": 2.0 }
  ]
}`;

export function AiBridgeDrawer({
  open,
  onClose,
  enabled,
  token,
  connectedStudios,
  paused,
  stepDelayMs,
  autoHighlight,
  queueLength,
  logs,
  snapshot,
  canUndoAiBatch,
  onToggleEnabled,
  onRegenerateToken,
  onTogglePaused,
  onChangeStepDelay,
  onToggleAutoHighlight,
  onUndoLastAiBatch,
  onClearLogs,
  onRunManualJson,
}: AiBridgeDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>('connect');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState(EXAMPLE_AI_JSON);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const mcpSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'stagecraft-3d': {
              type: 'http',
              url: `${origin}/api/mcp`,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          },
        },
        null,
        2,
      ),
    [origin, token],
  );

  const claudeConnectorUrl = useMemo(
    () => `${origin}/api/mcp?token=${encodeURIComponent(token || 'YOUR_TOKEN')}`,
    [origin, token],
  );

  const curlSnippet = useMemo(
    () =>
      `curl -X POST "${origin}/api/ai/commands" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"source":"External AI","commands":[{"op":"add_prop","kind":"box","name":"AI Box","color":"#e8702a","position":{"x":0,"y":0,"z":0}}]}'`,
    [origin, token],
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

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="AI Live Access & Watch Mode"
      className="fixed right-3 top-14 z-50 flex max-h-[calc(100vh-70px)] w-[430px] max-w-[95vw] flex-col rounded-md border border-[#383e49] bg-[#191b1f] text-xs text-[#e6e8ec] shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#2a2e36] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#e8702a]" aria-hidden="true" />
          <div>
            <div className="font-semibold text-[#e6e8ec]">AI Live Access &amp; Watch Mode</div>
            <div className="text-[10px] text-[#98a0ad]">
              {enabled ? 'Bridge Active · External AIs can edit live' : 'Bridge Locked · Enable to connect external AIs'}
              {connectedStudios > 0 ? ` · ${connectedStudios} viewport synced` : ''}
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
              enabled
                ? 'border border-[#166534] bg-[#14532d]/40 text-[#4ade80]'
                : 'border border-[#383e49] bg-[#1f232b] text-[#98a0ad]'
            }`}
          >
            {enabled ? 'LIVE ON' : 'LOCKED'}
          </span>
        </div>

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
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#2a2e36] bg-[#16181c] px-2 pt-1.5 gap-1">
        {(
          [
            { id: 'connect', label: 'Connect Any AI' },
            { id: 'watch-log', label: `Watch Log (${logs.length})` },
            { id: 'run-json', label: 'Paste & Run JSON' },
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
            {/* Claude Remote Connector URL (Built directly into this app!) */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">1. Claude Remote Connector URL</span>
                <span className="rounded bg-[#2b211a] px-1.5 py-0.5 text-[9px] font-semibold text-[#e8702a]">
                  NO EXTRA REPO NEEDED
                </span>
              </div>
              <p className="text-[11px] text-[#98a0ad]">
                Built right into this server! In Claude (Pro/Max/Team): <strong className="text-[#e6e8ec]">Settings → Connectors → Add custom connector</strong> and paste this URL:
              </p>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded border border-[#2a2e36] bg-[#101215] px-2 py-1 font-mono-code text-[10px] text-[#e6e8ec]">
                  {claudeConnectorUrl}
                </code>
                <StudioButton
                  variant="primary"
                  size="xs"
                  onClick={() => void copyText('claude-url', claudeConnectorUrl)}
                >
                  {copiedId === 'claude-url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'claude-url' ? 'Copied' : 'Copy URL'}</span>
                </StudioButton>
              </div>
            </div>

            {/* Universal Chat AI Copy */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">2. Any Chat AI (Free Claude, ChatGPT, Gemini)</span>
              </div>
              <p className="text-[11px] text-[#98a0ad]">
                Copies your current 3D scene JSON + instructions so any free chat AI can output JSON commands to paste into <strong className="text-[#e6e8ec]">Paste &amp; Run JSON</strong>.
              </p>
              <StudioButton
                size="xs"
                className="w-full"
                onClick={() =>
                  void copyText('prompt', buildUniversalAiPrompt(origin, token, snapshot))
                }
              >
                {copiedId === 'prompt' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span>
                  {copiedId === 'prompt' ? 'Copied AI Prompt + Scene State!' : 'Copy Universal AI Prompt + Live Scene'}
                </span>
              </StudioButton>
            </div>

            {/* Token & Live Endpoint */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">3. Live REST API &amp; Token</span>
                <button
                  type="button"
                  onClick={onRegenerateToken}
                  className="flex items-center gap-1 text-[10px] text-[#98a0ad] hover:text-[#e8702a]"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  <span>New Token</span>
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded border border-[#2a2e36] bg-[#101215] px-2 py-1 font-mono-code text-[10px] text-[#e6e8ec]">
                  {token}
                </code>
                <StudioButton size="xs" onClick={() => void copyText('token', token)}>
                  {copiedId === 'token' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copiedId === 'token' ? 'Copied' : 'Token'}</span>
                </StudioButton>
              </div>
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

            {/* MCP Config */}
            <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#e6e8ec]">4. MCP Config (Claude Desktop / Cursor / Windsurf)</span>
                <StudioButton size="xs" onClick={() => void copyText('mcp', mcpSnippet)}>
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
                No AI edits yet. Enable access above or paste JSON commands in the next tab to watch live edits.
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
                      <span>{entry.source}</span>
                      <span className="font-mono-code">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
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
