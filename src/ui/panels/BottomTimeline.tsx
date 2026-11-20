import React, { useMemo, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Film,
  Group,
  Key,
  Layers,
  PanelBottomClose,
  PanelBottomOpen,
  Pause,
  Play,
  Repeat,
  SkipBack,
  Square,
  StepBack,
  StepForward,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  ActionClip,
  AssetRecord,
  AudioClipData,
  EasingType,
  PanelCollapseState,
  SceneData,
  SelectionTarget,
  StudioMode,
  Vec3Keyframe,
} from '../../core/types';
import { formatTimecode } from '../../utils/timeUtils';
import { ContextMenu, type ContextMenuItem, CustomSelect, IconButton, StudioButton } from '../components/Primitives';
import { GraphEditor } from './GraphEditor';

export interface KeyframeRef {
  kind: 'pos' | 'rot' | 'scale' | 'cam' | 'facial' | 'node' | 'group-pos';
  instanceId?: string;
  groupId?: string;
  nodeId?: string;
  keyframeId: string;
}

interface BottomTimelineProps {
  height: number;
  collapseState: PanelCollapseState;
  onChangeCollapseState: (state: PanelCollapseState) => void;
  studioMode: StudioMode;
  scene: SceneData;
  assets: AssetRecord[];
  currentTime: number;
  fps: number;
  playbackSpeed: number;
  loopPlayback: boolean;
  autoKey: boolean;
  isPlaying: boolean;
  previewFullStory: boolean;
  selection: SelectionTarget;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onRestart: () => void;
  onStepFrame: (dir: -1 | 1) => void;
  onJumpKeyframe: (dir: 'prev' | 'next') => void;
  onChangeFps: (fps: number) => void;
  onChangePlaybackSpeed: (speed: number) => void;
  onToggleLoop: () => void;
  onToggleAutoKey: () => void;
  onToggleWorkArea: () => void;
  onTogglePreviewScope: (fullStory: boolean) => void;
  onChangeDuration?: (duration: number) => void;
  onSelectTarget: (target: SelectionTarget) => void;
  onMoveAudioClip: (clipId: string, startTime: number, duration?: number) => void;
  onDeleteAudioClip: (clipId: string) => void;
  onMoveActionClip: (instanceId: string, clipId: string, startTime: number, duration?: number) => void;
  onDeleteActionClip: (instanceId: string, clipId: string) => void;
  onDeleteKeyframe: (target: KeyframeRef) => void;
  onMoveKeyframe?: (target: KeyframeRef, nextTime: number) => void;
  onSetKeyframeEasing?: (targets: KeyframeRef[], easing: EasingType) => void;
  onDuplicateOrPasteKeys?: (targets: KeyframeRef[], targetTime: number) => void;
  onBatchKeyframes: (op: 'shift-left' | 'shift-right' | 'stretch-half' | 'stretch-double' | 'reverse' | 'ease-smooth') => void;
  onUpdateCharacterVec3Keys: (
    instanceId: string,
    channel: 'pos' | 'rot' | 'scale',
    nextKeys: Vec3Keyframe[],
  ) => void;
  onUpdateNodeRotKeys: (instanceId: string, nodeId: string, nextKeys: Vec3Keyframe[]) => void;
  onUpdateGroupVec3Keys?: (
    groupId: string,
    channel: 'pos' | 'rot' | 'scale',
    nextKeys: Vec3Keyframe[],
  ) => void;
  onToggleCharacterMute: (instanceId: string) => void;
}

function keyRefUid(ref: KeyframeRef): string {
  return `${ref.kind}:${ref.instanceId ?? ''}:${ref.groupId ?? ''}:${ref.nodeId ?? ''}:${ref.keyframeId}`;
}

export function BottomTimeline({
  height,
  collapseState,
  onChangeCollapseState,
  studioMode,
  scene,
  assets,
  currentTime,
  fps,
  playbackSpeed,
  loopPlayback,
  autoKey,
  isPlaying,
  previewFullStory,
  selection,
  onSeek,
  onTogglePlay,
  onStop,
  onRestart,
  onStepFrame,
  onJumpKeyframe,
  onChangeFps,
  onChangePlaybackSpeed,
  onToggleLoop,
  onToggleAutoKey,
  onToggleWorkArea,
  onTogglePreviewScope,
  onChangeDuration,
  onSelectTarget,
  onMoveAudioClip,
  onDeleteAudioClip,
  onMoveActionClip,
  onDeleteActionClip,
  onDeleteKeyframe,
  onMoveKeyframe,
  onSetKeyframeEasing,
  onDuplicateOrPasteKeys,
  onBatchKeyframes,
  onUpdateCharacterVec3Keys,
  onUpdateNodeRotKeys,
  onUpdateGroupVec3Keys,
  onToggleCharacterMute,
}: BottomTimelineProps) {
  const [timelineView, setTimelineView] = useState<'tracks' | 'graph'>('tracks');
  const [pxPerSec, setPxPerSec] = useState(64);
  const [expandedChars, setExpandedChars] = useState<Record<string, boolean>>({});
  const [selectedKeys, setSelectedKeys] = useState<KeyframeRef[]>([]);
  const [copiedKeys, setCopiedKeys] = useState<KeyframeRef[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const tracksScrollRef = useRef<HTMLDivElement>(null);

  const selectedKeySet = useMemo(() => new Set(selectedKeys.map(keyRefUid)), [selectedKeys]);

  const currentFrame = Math.round(currentTime * fps);
  const trackWidth = Math.max(600, scene.duration * pxPerSec + 120);
  const labelColWidth = 212;

  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const rulerTicks = useMemo(() => {
    const step = pxPerSec >= 90 ? 0.5 : pxPerSec >= 40 ? 1 : 2;
    const ticks: number[] = [];
    for (let t = 0; t <= scene.duration + 0.001; t += step) {
      ticks.push(Number(t.toFixed(2)));
    }
    return ticks;
  }, [scene.duration, pxPerSec]);

  // Collapsed bar (28px)
  if (collapseState === 'collapsed') {
    return (
      <footer
        className="flex h-7 shrink-0 items-center justify-between border-t border-[#2a2e36] bg-[#191b1f] px-2.5"
        aria-label="Timeline Collapsed"
        data-testid="timeline-collapsed-bar"
      >
        <div className="flex items-center gap-1.5">
          <IconButton label={isPlaying ? 'Pause (Space)' : 'Play (Space)'} active={isPlaying} onClick={onTogglePlay}>
            {isPlaying ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
          </IconButton>
          <span className="font-mono-code text-[11px] text-[#e6e8ec]">
            {formatTimecode(currentTime)} <span className="text-[#6b7280]">/ {formatTimecode(scene.duration)}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <StudioButton size="xs" onClick={() => onChangeCollapseState('compact')}>
            Compact
          </StudioButton>
          <IconButton label="Expand Timeline" onClick={() => onChangeCollapseState('expanded')}>
            <PanelBottomOpen className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>
      </footer>
    );
  }

  const scrubFromClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const t = Math.max(0, Math.min(scene.duration, x / pxPerSec));
    onSeek(t);
  };

  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const targetEl = e.currentTarget;
    targetEl.setPointerCapture(e.pointerId);
    scrubFromClientX(e.clientX, targetEl);

    const onMove = (ev: PointerEvent) => scrubFromClientX(ev.clientX, targetEl);
    const onUp = () => {
      targetEl.removeEventListener('pointermove', onMove);
      targetEl.removeEventListener('pointerup', onUp);
    };
    targetEl.addEventListener('pointermove', onMove);
    targetEl.addEventListener('pointerup', onUp);
  };

  const startClipDrag = (
    e: React.PointerEvent,
    initialStart: number,
    initialDur: number,
    mode: 'move' | 'resize',
    onUpdate: (newStart: number, newDur: number) => void,
  ) => {
    e.stopPropagation();
    const originX = e.clientX;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      const dt = dx / pxPerSec;
      if (mode === 'move') {
        const nextStart = Math.max(0, Math.round((initialStart + dt) * 20) / 20);
        onUpdate(nextStart, initialDur);
      } else {
        const nextDur = Math.max(0.2, Math.round((initialDur + dt) * 20) / 20);
        onUpdate(initialStart, nextDur);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selectKeyframe = (ref: KeyframeRef, shiftKey: boolean) => {
    const uid = keyRefUid(ref);
    if (shiftKey) {
      setSelectedKeys((prev) =>
        prev.some((p) => keyRefUid(p) === uid)
          ? prev.filter((p) => keyRefUid(p) !== uid)
          : [...prev, ref],
      );
    } else {
      setSelectedKeys([ref]);
    }
  };

  const startKeyframeDrag = (e: React.PointerEvent, ref: KeyframeRef, initialTime: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectKeyframe(ref, e.shiftKey);
    const originX = e.clientX;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved || !onMoveKeyframe) return;
      const dt = dx / pxPerSec;
      const snapped = Math.max(0, Math.min(scene.duration, Math.round((initialTime + dt) * 20) / 20));
      onMoveKeyframe(ref, snapped);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        onSeek(initialTime);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const openKeyframeCtxAt = (x: number, y: number, ref: KeyframeRef, time: number, label: string) => {
    selectKeyframe(ref, false);
    const activeTargets = selectedKeySet.has(keyRefUid(ref)) && selectedKeys.length > 1 ? selectedKeys : [ref];
    setCtxMenu({
      x,
      y,
      items: [
        { label: `Jump to ${time.toFixed(2)}s`, onClick: () => onSeek(time) },
        {
          label: 'Copy Keyframe',
          onClick: () => setCopiedKeys(activeTargets),
        },
        ...(onDuplicateOrPasteKeys
          ? [
              {
                label: 'Duplicate +0.5s',
                onClick: () => onDuplicateOrPasteKeys([ref], Math.min(scene.duration, time + 0.5)),
              },
            ]
          : []),
        ...(onSetKeyframeEasing
          ? [
              { label: 'Easing: Smooth', dividerAbove: true, onClick: () => onSetKeyframeEasing(activeTargets, 'smooth') },
              { label: 'Easing: Linear', onClick: () => onSetKeyframeEasing(activeTargets, 'linear') },
              { label: 'Easing: Step (Hold)', onClick: () => onSetKeyframeEasing(activeTargets, 'step') },
              { label: 'Easing: Bezier', onClick: () => onSetKeyframeEasing(activeTargets, 'bezier') },
            ]
          : []),
        {
          label: `Delete ${label}`,
          danger: true,
          dividerAbove: true,
          onClick: () => {
            for (const t of activeTargets) onDeleteKeyframe(t);
            setSelectedKeys([]);
          },
        },
      ],
    });
  };

  const openKeyframeContextMenu = (e: React.MouseEvent, ref: KeyframeRef, time: number, label: string) => {
    e.preventDefault();
    e.stopPropagation();
    openKeyframeCtxAt(e.clientX, e.clientY, ref, time, label);
  };

  const renderKeyframeDiamond = (
    ref: KeyframeRef,
    time: number,
    colorClass: string,
    title: string,
    shape: 'diamond' | 'circle' = 'diamond',
    topClass = 'top-2',
  ) => {
    const isSel = selectedKeySet.has(keyRefUid(ref));
    return (
      <button
        key={keyRefUid(ref)}
        type="button"
        aria-label={title}
        data-studio-note={`${title} · Drag to retime, Shift+F10 or Right-Click for easing/delete`}
        onPointerDown={(e) => startKeyframeDrag(e, ref, time)}
        onContextMenu={(e) => openKeyframeContextMenu(e, ref, time, title)}
        onKeyDown={(e) => {
          if (e.shiftKey && e.key === 'F10') {
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openKeyframeCtxAt(r.left + 4, r.bottom + 4, ref, time, title);
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            e.stopPropagation();
            onDeleteKeyframe(ref);
            setSelectedKeys([]);
          }
        }}
        style={{ left: time * pxPerSec - 5 }}
        className={`absolute ${topClass} h-2.5 w-2.5 ${shape === 'diamond' ? 'rotate-45' : 'rounded-full'} border cursor-ew-resize transition-transform ${
          isSel
            ? 'z-10 scale-125 border-white bg-[#fbbf24] shadow-[0_0_0_2px_rgba(251,191,36,0.3)]'
            : `border-[#121316] ${colorClass} hover:scale-125`
        }`}
      />
    );
  };

  const renderAudioClip = (clip: AudioClipData, accent: string) => {
    const selected = selection.kind === 'audio-clip' && selection.clipId === clip.id;
    const asset = assetMap.get(clip.assetId);
    const left = clip.startTime * pxPerSec;
    const width = Math.max(24, clip.duration * pxPerSec);
    const peaks = asset?.waveformPeaks;

    return (
      <div
        key={clip.id}
        role="button"
        tabIndex={0}
        aria-label={`Audio clip ${clip.name}`}
        style={{ left, width }}
        onPointerDown={(e) => {
          onSelectTarget({ kind: 'audio-clip', clipId: clip.id });
          if (e.button === 0) {
            startClipDrag(e, clip.startTime, clip.duration, 'move', (s, d) =>
              onMoveAudioClip(clip.id, s, d),
            );
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Seek to Clip Start', onClick: () => onSeek(clip.startTime) },
              { label: 'Delete Clip', danger: true, onClick: () => onDeleteAudioClip(clip.id) },
            ],
          });
        }}
        className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded border px-1.5 text-[10px] cursor-grab active:cursor-grabbing ${
          selected
            ? 'border-[#e8702a] bg-[#2f231c] text-[#ffffff]'
            : 'border-[#383e49] bg-[#21252e] text-[#e6e8ec]'
        }`}
      >
        {peaks && peaks.length > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center opacity-35 px-0.5">
            {peaks.slice(0, 48).map((p, i) => (
              <div
                key={i}
                style={{
                  height: `${Math.max(12, Math.round(p * 100))}%`,
                  backgroundColor: accent,
                }}
                className="flex-1 mx-[0.5px] rounded-xs"
              />
            ))}
          </div>
        )}
        <span className="relative z-10 truncate font-medium">
          {clip.muted ? `[Muted] ${clip.name}` : clip.name}
        </span>
        <div
          onPointerDown={(e) =>
            startClipDrag(e, clip.startTime, clip.duration, 'resize', (s, d) =>
              onMoveAudioClip(clip.id, s, d),
            )
          }
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-[#e8702a]"
        />
      </div>
    );
  };

  const renderActionClip = (instanceId: string, clip: ActionClip) => {
    const selected =
      selection.kind === 'action-clip' &&
      selection.instanceId === instanceId &&
      selection.clipId === clip.id;
    const left = clip.startTime * pxPerSec;
    const width = Math.max(24, clip.duration * pxPerSec);

    return (
      <div
        key={clip.id}
        role="button"
        tabIndex={0}
        aria-label={`Action clip ${clip.label}`}
        style={{ left, width }}
        onPointerDown={(e) => {
          onSelectTarget({ kind: 'action-clip', instanceId, clipId: clip.id });
          if (e.button === 0) {
            startClipDrag(e, clip.startTime, clip.duration, 'move', (s, d) =>
              onMoveActionClip(instanceId, clip.id, s, d),
            );
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Seek to Action', onClick: () => onSeek(clip.startTime) },
              {
                label: 'Delete Action Clip',
                danger: true,
                onClick: () => onDeleteActionClip(instanceId, clip.id),
              },
            ],
          });
        }}
        className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded border px-1.5 text-[10px] cursor-grab active:cursor-grabbing ${
          selected
            ? 'border-[#e8702a] bg-[#36261d] text-white'
            : clip.kind === 'preset'
              ? 'border-[#2f4b43] bg-[#1a2c27] text-[#a7f3d0]'
              : 'border-[#3d4656] bg-[#242b38] text-[#e6e8ec]'
        }`}
      >
        <span className="truncate font-medium">{clip.label}</span>
        <div
          onPointerDown={(e) =>
            startClipDrag(e, clip.startTime, clip.duration, 'resize', (s, d) =>
              onMoveActionClip(instanceId, clip.id, s, d),
            )
          }
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-[#e8702a]"
        />
      </div>
    );
  };

  const musicClips = scene.audioClips.filter((c) => c.role === 'music' || c.role === 'ambient');
  const sfxClips = scene.audioClips.filter((c) => c.role === 'sfx');
  const workArea = scene.workArea;
  const effectiveHeight = collapseState === 'compact' ? 40 : height;

  return (
    <footer
      style={{ height: effectiveHeight }}
      className="flex shrink-0 flex-col border-t border-[#2a2e36] bg-[#191b1f]"
      aria-label="Timeline"
      data-testid={collapseState === 'compact' ? 'timeline-compact-bar' : 'timeline-expanded'}
    >
      {/* Transport Header */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[#2a2e36] px-2.5 overflow-x-auto">
        <div className="flex items-center gap-1 shrink-0">
          <IconButton label="Restart (Home)" onClick={onRestart}>
            <SkipBack className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton label="Previous Keyframe" onClick={() => onJumpKeyframe('prev')}>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton label="Step Back 1 Frame" onClick={() => onStepFrame(-1)}>
            <StepBack className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            active={isPlaying}
            onClick={onTogglePlay}
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </IconButton>
          <IconButton label="Step Forward 1 Frame" onClick={() => onStepFrame(1)}>
            <StepForward className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton label="Next Keyframe" onClick={() => onJumpKeyframe('next')}>
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton label="Stop" onClick={onStop}>
            <Square className="h-3 w-3" aria-hidden="true" />
          </IconButton>

          <span className="ml-1.5 flex items-center gap-1 font-mono-code text-xs text-[#e6e8ec]">
            <span>{formatTimecode(currentTime)}</span>
            <span className="text-[#6b7280]">/</span>
            {onChangeDuration ? (
              <label className="inline-flex items-center gap-0.5 rounded border border-[#2a2e36] bg-[#14161a] px-1 py-0.5 text-[11px] text-[#98a0ad] hover:border-[#383e49]" title="Timeline Duration (seconds, 1–3600)">
                <input
                  type="number"
                  min={1}
                  max={3600}
                  step={1}
                  aria-label="Timeline Duration Seconds"
                  value={Math.round(scene.duration * 10) / 10}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next) && next >= 1) {
                      onChangeDuration(Math.min(3600, next));
                    }
                  }}
                  className="w-11 bg-transparent text-right font-mono-code text-[11px] text-[#e6e8ec] focus:text-[#e8702a] focus:outline-none"
                />
                <span>s</span>
              </label>
            ) : (
              <span className="text-[#6b7280]">{formatTimecode(scene.duration)}</span>
            )}
            <span className="ml-1 text-[10px] text-[#98a0ad]">F{currentFrame}</span>
          </span>

          <div className="mx-1.5 h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

          <StudioButton
            size="xs"
            variant={autoKey ? 'primary' : 'default'}
            note="Auto-Key: Automatically record keyframes when adjusting characters or joints"
            onClick={onToggleAutoKey}
          >
            <Key className="h-3 w-3" aria-hidden="true" />
            <span>Auto-Key</span>
          </StudioButton>

          <IconButton
            label={loopPlayback ? 'Loop Playback: On' : 'Loop Playback: Off'}
            active={loopPlayback}
            onClick={onToggleLoop}
          >
            <Repeat className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <StudioButton
            size="xs"
            variant={previewFullStory ? 'selected' : 'default'}
            note="Toggle playback scope between active Scene and All Scenes"
            onClick={() => onTogglePreviewScope(!previewFullStory)}
          >
            <Film className="h-3 w-3" aria-hidden="true" />
            <span>{previewFullStory ? 'All Scenes' : 'Scene'}</span>
          </StudioButton>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {selectedKeys.length > 0 && collapseState === 'expanded' && (
            <div className="flex items-center gap-1 rounded border border-[#3a3022] bg-[#211b14] px-1.5 py-0.5">
              <span className="text-[10px] text-[#f2c4a2]">{selectedKeys.length} key</span>
              <IconButton label="Copy Selected Keys" onClick={() => setCopiedKeys(selectedKeys)}>
                <Copy className="h-3 w-3" aria-hidden="true" />
              </IconButton>
              {copiedKeys.length > 0 && onDuplicateOrPasteKeys && (
                <IconButton label="Paste Keys @ Playhead" onClick={() => onDuplicateOrPasteKeys(copiedKeys, currentTime)}>
                  <ClipboardPaste className="h-3 w-3" aria-hidden="true" />
                </IconButton>
              )}
              {onSetKeyframeEasing && (
                <div className="w-20">
                  <CustomSelect
                    ariaLabel="Set selected keyframes easing"
                    size="xs"
                    value=""
                    placeholder="Ease..."
                    options={[
                      { value: 'smooth', label: 'Smooth' },
                      { value: 'linear', label: 'Linear' },
                      { value: 'step', label: 'Step' },
                      { value: 'bezier', label: 'Bezier' },
                    ]}
                    onChange={(val) => {
                      if (!val) return;
                      onSetKeyframeEasing(selectedKeys, val as EasingType);
                    }}
                  />
                </div>
              )}
              <IconButton
                label="Delete Selected Keys"
                onClick={() => {
                  for (const k of selectedKeys) onDeleteKeyframe(k);
                  setSelectedKeys([]);
                }}
              >
                <Trash2 className="h-3 w-3 text-[#f87171]" aria-hidden="true" />
              </IconButton>
            </div>
          )}

          {collapseState === 'expanded' && (
            <div className="flex items-center rounded border border-[#2a2e36] bg-[#14161a] p-0.5">
              <button
                type="button"
                data-studio-note="View stacked tracks & diamond keyframes"
                onClick={() => setTimelineView('tracks')}
                className={`flex h-5 items-center gap-1 rounded px-2 text-[10px] font-medium ${
                  timelineView === 'tracks' ? 'bg-[#2a2f3a] text-[#ffffff] font-semibold' : 'text-[#98a0ad] hover:text-[#e6e8ec]'
                }`}
              >
                <Layers className="h-3 w-3" aria-hidden="true" />
                <span>Tracks</span>
              </button>
              <button
                type="button"
                data-studio-note="Edit motion speed & interpolation curves directly"
                onClick={() => setTimelineView('graph')}
                className={`flex h-5 items-center gap-1 rounded px-2 text-[10px] font-medium ${
                  timelineView === 'graph' ? 'bg-[#e8702a] text-[#121316] font-semibold' : 'text-[#98a0ad] hover:text-[#e6e8ec]'
                }`}
              >
                <Activity className="h-3 w-3" aria-hidden="true" />
                <span>Curves</span>
              </button>
            </div>
          )}

          {collapseState === 'expanded' && studioMode === 'advanced' && timelineView === 'tracks' && (
            <div className="flex items-center gap-1">
              <StudioButton size="xs" note="Shift character keyframes earlier by 0.5s" onClick={() => onBatchKeyframes('shift-left')}>
                -0.5s
              </StudioButton>
              <StudioButton size="xs" note="Shift character keyframes later by 0.5s" onClick={() => onBatchKeyframes('shift-right')}>
                +0.5s
              </StudioButton>
              <StudioButton size="xs" note="Scale character keyframe timing by 1.5x" onClick={() => onBatchKeyframes('stretch-double')}>
                1.5x
              </StudioButton>
              <StudioButton size="xs" note="Reverse keyframe timing order" onClick={() => onBatchKeyframes('reverse')}>
                Rev
              </StudioButton>
              <StudioButton
                size="xs"
                variant={workArea?.enabled ? 'selected' : 'default'}
                note="Restrict playback & looping to highlighted Work Area range"
                onClick={onToggleWorkArea}
              >
                Work
              </StudioButton>
            </div>
          )}

          <div className="w-16" data-studio-note="Project timeline frame rate (FPS)">
            <CustomSelect
              ariaLabel="Timeline FPS"
              size="xs"
              value={String(fps)}
              options={[
                { value: '24', label: '24fps' },
                { value: '30', label: '30fps' },
                { value: '60', label: '60fps' },
              ]}
              onChange={(val) => onChangeFps(Number(val))}
            />
          </div>

          <div className="w-14" data-studio-note="Preview playback speed multiplier">
            <CustomSelect
              ariaLabel="Playback speed"
              size="xs"
              value={String(playbackSpeed)}
              options={[
                { value: '0.5', label: '0.5x' },
                { value: '1', label: '1.0x' },
                { value: '1.5', label: '1.5x' },
                { value: '2', label: '2.0x' },
              ]}
              onChange={(val) => onChangePlaybackSpeed(Number(val))}
            />
          </div>

          {collapseState === 'expanded' && timelineView === 'tracks' && (
            <>
              <IconButton label="Zoom out timeline" onClick={() => setPxPerSec((z) => Math.max(24, z - 16))}>
                <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
              <span className="w-10 text-center font-mono-code text-[10px] text-[#98a0ad]">{pxPerSec}px</span>
              <IconButton label="Zoom in timeline" onClick={() => setPxPerSec((z) => Math.min(180, z + 16))}>
                <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            </>
          )}

          {/* Collapse / Expand Timeline Buttons */}
          {collapseState === 'compact' ? (
            <IconButton label="Expand Timeline Tracks" onClick={() => onChangeCollapseState('expanded')}>
              <PanelBottomOpen className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          ) : (
            <>
              <IconButton label="Compact Timeline (Transport Only)" onClick={() => onChangeCollapseState('compact')}>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
              <IconButton label="Collapse Timeline Bar" onClick={() => onChangeCollapseState('collapsed')}>
                <PanelBottomClose className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            </>
          )}
        </div>
      </div>

      {/* Main Timeline Body (hidden in compact mode) */}
      {collapseState === 'expanded' &&
        (timelineView === 'graph' ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <GraphEditor
              scene={scene}
              currentTime={currentTime}
              onSeek={onSeek}
              onUpdateCharacterVec3Keys={onUpdateCharacterVec3Keys}
              onUpdateNodeRotKeys={onUpdateNodeRotKeys}
              onUpdateGroupVec3Keys={onUpdateGroupVec3Keys}
            />
          </div>
        ) : (
          <div ref={tracksScrollRef} className="relative flex-1 overflow-auto">
            <div style={{ minWidth: labelColWidth + trackWidth }} className="relative">
              {/* Ruler Row */}
              <div className="sticky top-0 z-20 flex h-7 border-b border-[#2a2e36] bg-[#16181c]">
                <div
                  style={{ width: labelColWidth }}
                  className="sticky left-0 z-30 flex shrink-0 items-center justify-between border-r border-[#2a2e36] bg-[#16181c] px-3 text-[11px] font-medium text-[#98a0ad]"
                >
                  <span className="truncate">Tracks ({scene.name})</span>
                </div>
                <div
                  style={{ width: trackWidth }}
                  onPointerDown={handleRulerPointerDown}
                  className="relative h-full cursor-ew-resize select-none"
                >
                  {workArea?.enabled && (
                    <div
                      style={{
                        left: workArea.start * pxPerSec,
                        width: Math.max(12, (workArea.end - workArea.start) * pxPerSec),
                      }}
                      className="pointer-events-none absolute top-0 bottom-0 bg-[#e8702a]/15 border-x border-[#e8702a]/50"
                    />
                  )}
                  {rulerTicks.map((t) => (
                    <div
                      key={t}
                      style={{ left: t * pxPerSec }}
                      className="absolute top-0 bottom-0 border-l border-[#2a2e36] pl-1 pt-1 font-mono-code text-[10px] text-[#6b7280]"
                    >
                      {t}s
                    </div>
                  ))}
                  {/* Playhead Handle */}
                  <div
                    style={{ left: currentTime * pxPerSec }}
                    className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-[#e8702a]"
                  >
                    <div className="-ml-1.5 h-2.5 w-3.5 rounded-b bg-[#e8702a]" />
                  </div>
                </div>
              </div>

              {/* Camera Keyframes & Switch Row */}
              <div className="flex h-7 border-b border-[#242830] bg-[#181a1f]">
                <button
                  type="button"
                  onClick={() => onSelectTarget({ kind: 'camera' })}
                  style={{ width: labelColWidth }}
                  className={`sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-[#2a2e36] bg-[#181a1f] px-3 text-left text-[11px] ${
                    selection.kind === 'camera' ? 'text-[#e8702a] font-semibold' : 'text-[#e6e8ec]'
                  }`}
                >
                  <Camera className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">Camera &amp; Cuts</span>
                </button>
                <div style={{ width: trackWidth }} className="relative h-full">
                  {scene.camera.keyframes.map((kf) =>
                    renderKeyframeDiamond(
                      { kind: 'cam', keyframeId: kf.id },
                      kf.time,
                      'bg-[#e8702a]',
                      `Camera key @ ${kf.time.toFixed(2)}s`,
                    ),
                  )}
                  {(scene.cameraSwitches ?? []).map((sw) => (
                    <button
                      key={sw.id}
                      type="button"
                      title={`Camera Switch @ ${sw.time.toFixed(2)}s`}
                      onClick={() => onSeek(sw.time)}
                      style={{ left: sw.time * pxPerSec - 4 }}
                      className="absolute top-1 h-4 w-2 rounded-xs bg-[#facc15]"
                    />
                  ))}
                </div>
              </div>

              {/* Logical Group Keyframe Rows */}
              {(scene.groups ?? []).map((grp) => (
                <div key={grp.id} className="flex h-7 border-b border-[#242830] bg-[#171a21]">
                  <button
                    type="button"
                    onClick={() => onSelectTarget({ kind: 'group', groupId: grp.id })}
                    style={{ width: labelColWidth }}
                    className={`sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-[#2a2e36] bg-[#171a21] px-3 text-left text-[11px] ${
                      selection.kind === 'group' && selection.groupId === grp.id
                        ? 'text-[#2dd4bf] font-semibold'
                        : 'text-[#cbd5e1]'
                    }`}
                  >
                    <Group className="h-3.5 w-3.5 shrink-0 text-[#2dd4bf]" aria-hidden="true" />
                    <span className="truncate">{grp.name}</span>
                  </button>
                  <div style={{ width: trackWidth }} className="relative h-full">
                    {grp.positionKeyframes.map((kf) =>
                      renderKeyframeDiamond(
                        { kind: 'group-pos', groupId: grp.id, keyframeId: kf.id },
                        kf.time,
                        'bg-[#2dd4bf]',
                        `${grp.name} Pos @ ${kf.time.toFixed(2)}s`,
                      ),
                    )}
                  </div>
                </div>
              ))}

              {/* Per-Character Expandable Track Groups */}
              {scene.characters.map((char) => {
                const dialogueClips = scene.audioClips.filter(
                  (c) => c.role === 'dialogue' && c.characterInstanceId === char.id,
                );
                const isSelected =
                  selection.kind === 'character' && selection.instanceId === char.id;
                const isExpanded = expandedChars[char.id] ?? true;
                const nodeTracks = (char.nodeTracks ?? []).filter((nt) => nt.rotationKeyframes.length > 0);
                const nodeKeyCount = nodeTracks.reduce((acc, nt) => acc + nt.rotationKeyframes.length, 0);

                return (
                  <div key={char.id} className="border-b border-[#2a2e36]">
                    {/* Character Summary Header Track */}
                    <div className="flex h-7 border-b border-[#22262e] bg-[#1b1e24]">
                      <div
                        style={{ width: labelColWidth }}
                        className="sticky left-0 z-10 flex shrink-0 items-center justify-between border-r border-[#2a2e36] bg-[#1b1e24] px-2"
                      >
                        <div className="flex items-center gap-1 min-w-0">
                          <button
                            type="button"
                            aria-label={isExpanded ? `Collapse ${char.name} tracks` : `Expand ${char.name} tracks`}
                            onClick={() =>
                              setExpandedChars((prev) => ({ ...prev, [char.id]: !isExpanded }))
                            }
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[#98a0ad] hover:bg-[#262a33] hover:text-white"
                          >
                            {isExpanded ? (
                              <ChevronUp className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-3 w-3" aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelectTarget({ kind: 'character', instanceId: char.id })}
                            className={`truncate text-left text-[11px] font-semibold ${
                              isSelected ? 'text-[#e8702a]' : 'text-[#e6e8ec]'
                            }`}
                          >
                            {char.name}
                          </button>
                        </div>
                        <IconButton
                          label={char.audioProfile.muted ? `Unmute ${char.name}` : `Mute ${char.name}`}
                          onClick={() => onToggleCharacterMute(char.id)}
                        >
                          {char.audioProfile.muted ? (
                            <VolumeX className="h-3 w-3 text-[#6b7280]" aria-hidden="true" />
                          ) : (
                            <Volume2 className="h-3 w-3" aria-hidden="true" />
                          )}
                        </IconButton>
                      </div>
                      <div style={{ width: trackWidth }} className="relative h-full">
                        {char.positionKeyframes.map((kf) =>
                          renderKeyframeDiamond(
                            { kind: 'pos', instanceId: char.id, keyframeId: kf.id },
                            kf.time,
                            'bg-[#60a5fa]',
                            `Position @ ${kf.time.toFixed(2)}s`,
                            'diamond',
                            'top-1.5',
                          ),
                        )}
                        {char.rotationKeyframes.map((kf) =>
                          renderKeyframeDiamond(
                            { kind: 'rot', instanceId: char.id, keyframeId: kf.id },
                            kf.time,
                            'bg-[#a78bfa]',
                            `Rotation @ ${kf.time.toFixed(2)}s`,
                            'diamond',
                            'bottom-1',
                          ),
                        )}
                        {(char.facialKeyframes ?? []).map((fk) =>
                          renderKeyframeDiamond(
                            { kind: 'facial', instanceId: char.id, keyframeId: fk.id },
                            fk.time,
                            'bg-[#f472b6]',
                            `Facial @ ${fk.time.toFixed(2)}s`,
                            'circle',
                            'top-1',
                          ),
                        )}
                      </div>
                    </div>

                    {/* Expanded Sub-Tracks: Position, Rotation, Scale, Facial, Individual Bone/Node Tracks */}
                    {isExpanded && (
                      <>
                        {char.positionKeyframes.length > 0 && (
                          <div className="flex h-6 border-b border-[#20232b] bg-[#16181e]">
                            <div
                              style={{ width: labelColWidth }}
                              className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-[#2a2e36] bg-[#16181e] pl-7 pr-2 text-[10px] text-[#93c5fd]"
                            >
                              <span className="h-1.5 w-1.5 rotate-45 bg-[#60a5fa]" />
                              <span>Position</span>
                            </div>
                            <div style={{ width: trackWidth }} className="relative h-full">
                              {char.positionKeyframes.map((kf) =>
                                renderKeyframeDiamond(
                                  { kind: 'pos', instanceId: char.id, keyframeId: kf.id },
                                  kf.time,
                                  'bg-[#60a5fa]',
                                  `${char.name} Pos @ ${kf.time.toFixed(2)}s`,
                                  'diamond',
                                  'top-1.5',
                                ),
                              )}
                            </div>
                          </div>
                        )}

                        {char.rotationKeyframes.length > 0 && (
                          <div className="flex h-6 border-b border-[#20232b] bg-[#16181e]">
                            <div
                              style={{ width: labelColWidth }}
                              className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-[#2a2e36] bg-[#16181e] pl-7 pr-2 text-[10px] text-[#c4b5fd]"
                            >
                              <span className="h-1.5 w-1.5 rotate-45 bg-[#a78bfa]" />
                              <span>Rotation</span>
                            </div>
                            <div style={{ width: trackWidth }} className="relative h-full">
                              {char.rotationKeyframes.map((kf) =>
                                renderKeyframeDiamond(
                                  { kind: 'rot', instanceId: char.id, keyframeId: kf.id },
                                  kf.time,
                                  'bg-[#a78bfa]',
                                  `${char.name} Rot @ ${kf.time.toFixed(2)}s`,
                                  'diamond',
                                  'top-1.5',
                                ),
                              )}
                            </div>
                          </div>
                        )}

                        {(char.facialKeyframes ?? []).length > 0 && (
                          <div className="flex h-6 border-b border-[#20232b] bg-[#16181e]">
                            <div
                              style={{ width: labelColWidth }}
                              className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-[#2a2e36] bg-[#16181e] pl-7 pr-2 text-[10px] text-[#f9a8d4]"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-[#f472b6]" />
                              <span>Facial</span>
                            </div>
                            <div style={{ width: trackWidth }} className="relative h-full">
                              {(char.facialKeyframes ?? []).map((fk) =>
                                renderKeyframeDiamond(
                                  { kind: 'facial', instanceId: char.id, keyframeId: fk.id },
                                  fk.time,
                                  'bg-[#f472b6]',
                                  `${char.name} Facial @ ${fk.time.toFixed(2)}s`,
                                  'circle',
                                  'top-1.5',
                                ),
                              )}
                            </div>
                          </div>
                        )}

                        {nodeTracks.map((nt) => (
                          <div key={nt.nodeId} className="flex h-6 border-b border-[#20232b] bg-[#15181e]">
                            <button
                              type="button"
                              onClick={() =>
                                onSelectTarget({
                                  kind: 'body-part',
                                  instanceId: char.id,
                                  nodeId: nt.nodeId,
                                  nodeName: nt.nodeName,
                                })
                              }
                              style={{ width: labelColWidth }}
                              className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-[#2a2e36] bg-[#15181e] pl-7 pr-2 text-left text-[10px] text-[#6ee7b7] hover:text-white"
                            >
                              <span className="h-1.5 w-1.5 rotate-45 bg-[#34d399]" />
                              <span className="truncate">{nt.nodeName}</span>
                            </button>
                            <div style={{ width: trackWidth }} className="relative h-full">
                              {nt.rotationKeyframes.map((nk) =>
                                renderKeyframeDiamond(
                                  { kind: 'node', instanceId: char.id, nodeId: nt.nodeId, keyframeId: nk.id },
                                  nk.time,
                                  'bg-[#34d399]',
                                  `${nt.nodeName} @ ${nk.time.toFixed(2)}s`,
                                  'diamond',
                                  'top-1.5',
                                ),
                              )}
                            </div>
                          </div>
                        ))}
                      </>
                    )}

                    {/* Collapsed summary pill when sub-tracks hidden & node keys exist */}
                    {!isExpanded && nodeKeyCount > 0 && (
                      <div className="flex h-6 border-b border-[#22262e] bg-[#171a20]">
                        <div
                          style={{ width: labelColWidth }}
                          className="sticky left-0 z-10 flex shrink-0 items-center border-r border-[#2a2e36] bg-[#171a20] pl-7 pr-2 text-[10px] text-[#98a0ad]"
                        >
                          Body Parts ({nodeKeyCount} keys)
                        </div>
                        <div style={{ width: trackWidth }} className="relative h-full">
                          {nodeTracks.flatMap((nt) =>
                            nt.rotationKeyframes.map((nk) =>
                              renderKeyframeDiamond(
                                { kind: 'node', instanceId: char.id, nodeId: nt.nodeId, keyframeId: nk.id },
                                nk.time,
                                'bg-[#34d399]',
                                `${nt.nodeName} @ ${nk.time.toFixed(2)}s`,
                                'diamond',
                                'top-1.5',
                              ),
                            ),
                          )}
                        </div>
                      </div>
                    )}

                    {/* Actions & Presets Track */}
                    <div className="flex h-7 border-b border-[#22262e] bg-[#16181d]">
                      <div
                        style={{ width: labelColWidth }}
                        className="sticky left-0 z-10 flex shrink-0 items-center border-r border-[#2a2e36] bg-[#16181d] pl-7 pr-2 text-[11px] text-[#98a0ad]"
                      >
                        Actions &amp; Presets
                      </div>
                      <div style={{ width: trackWidth }} className="relative h-full">
                        {char.actionClips.map((clip) => renderActionClip(char.id, clip))}
                      </div>
                    </div>

                    {/* Character Dialogue Track */}
                    <div className="flex h-7 bg-[#16181d]">
                      <div
                        style={{ width: labelColWidth }}
                        className="sticky left-0 z-10 flex shrink-0 items-center border-r border-[#2a2e36] bg-[#16181d] pl-7 pr-2 text-[11px] text-[#98a0ad]"
                        title={`Dialogue (${char.audioProfile.voiceLabel})`}
                      >
                        <span className="truncate">Dialogue ({char.audioProfile.voiceLabel})</span>
                      </div>
                      <div style={{ width: trackWidth }} className="relative h-full">
                        {dialogueClips.map((clip) => renderAudioClip(clip, '#e8702a'))}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Props Keyframe Tracks */}
              {(scene.props ?? []).length > 0 && (
                <div className="border-b border-[#2a2e36]">
                  {(scene.props ?? []).map((prop) => (
                    <div key={prop.id} className="flex h-6 border-b border-[#22262e] bg-[#17191e]">
                      <button
                        type="button"
                        onClick={() => onSelectTarget({ kind: 'prop', propId: prop.id })}
                        style={{ width: labelColWidth }}
                        title={`Prop: ${prop.name}`}
                        className="sticky left-0 z-10 flex shrink-0 items-center border-r border-[#2a2e36] bg-[#17191e] px-3 text-left text-[10px] text-[#98a0ad] hover:text-[#e6e8ec]"
                      >
                        <span className="truncate">Prop: {prop.name}</span>
                      </button>
                      <div style={{ width: trackWidth }} className="relative h-full">
                        {prop.positionKeyframes.map((kf) => (
                          <button
                            key={kf.id}
                            type="button"
                            title={`Prop key @ ${kf.time.toFixed(2)}s`}
                            onClick={() => onSeek(kf.time)}
                            style={{ left: kf.time * pxPerSec - 4 }}
                            className="absolute top-1.5 h-2 w-2 rotate-45 bg-[#fbbf24]"
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Global Background Music & SFX Tracks */}
              <div className="flex h-7 border-b border-[#22262e] bg-[#17191e]">
                <div
                  style={{ width: labelColWidth }}
                  className="sticky left-0 z-10 flex shrink-0 items-center border-r border-[#2a2e36] bg-[#17191e] px-3 text-[11px] text-[#98a0ad]"
                >
                  Background Music
                </div>
                <div style={{ width: trackWidth }} className="relative h-full">
                  {musicClips.map((clip) => renderAudioClip(clip, '#38bdf8'))}
                </div>
              </div>

              <div className="flex h-7 border-b border-[#22262e] bg-[#17191e]">
                <div
                  style={{ width: labelColWidth }}
                  className="sticky left-0 z-10 flex shrink-0 items-center border-r border-[#2a2e36] bg-[#17191e] px-3 text-[11px] text-[#98a0ad]"
                >
                  Sound Effects
                </div>
                <div style={{ width: trackWidth }} className="relative h-full">
                  {sfxClips.map((clip) => renderAudioClip(clip, '#4ade80'))}
                </div>
              </div>

              {/* Full-height Playhead Line */}
              <div
                style={{ left: labelColWidth + currentTime * pxPerSec }}
                className="pointer-events-none absolute top-7 bottom-0 z-10 w-px bg-[#e8702a]"
              />
            </div>
          </div>
        ))}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </footer>
  );
}
