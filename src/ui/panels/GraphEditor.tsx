import React, { useMemo, useRef, useState } from 'react';
import { Link2, Plus, Scissors, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { BezierHandle2D, EasingType, SceneData, Vec3, Vec3Keyframe } from '../../core/types';
import { evaluateNumberTrack, sortByTime } from '../../animation/Interpolation';
import { createId } from '../../utils/ids';
import { clamp } from '../../utils/math';
import { CustomSelect, IconButton, StudioButton } from '../components/Primitives';

interface GraphEditorProps {
  scene: SceneData;
  currentTime: number;
  onSeek: (t: number) => void;
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
}

interface ChannelOption {
  id: string;
  label: string;
  axis: 'x' | 'y' | 'z';
  keyframes: Vec3Keyframe[];
  applyUpdate: (next: Vec3Keyframe[]) => void;
}

const EASING_LIST: { value: EasingType; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'smooth', label: 'Smooth' },
  { value: 'step', label: 'Step (Hold)' },
  { value: 'easeIn', label: 'Ease In' },
  { value: 'easeOut', label: 'Ease Out' },
  { value: 'easeInOut', label: 'Ease In & Out' },
  { value: 'bezier', label: 'Cubic Bezier' },
];

export function GraphEditor({
  scene,
  currentTime,
  onSeek,
  onUpdateCharacterVec3Keys,
  onUpdateNodeRotKeys,
  onUpdateGroupVec3Keys,
}: GraphEditorProps) {
  const channels = useMemo<ChannelOption[]>(() => {
    const out: ChannelOption[] = [];
    for (const ch of scene.characters) {
      for (const axis of ['x', 'y', 'z'] as const) {
        out.push({
          id: `${ch.id}:pos:${axis}`,
          label: `${ch.name} · Position ${axis.toUpperCase()} (${ch.positionKeyframes.length})`,
          axis,
          keyframes: ch.positionKeyframes,
          applyUpdate: (next) => onUpdateCharacterVec3Keys(ch.id, 'pos', next),
        });
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        out.push({
          id: `${ch.id}:rot:${axis}`,
          label: `${ch.name} · Rotation ${axis.toUpperCase()} (${ch.rotationKeyframes.length})`,
          axis,
          keyframes: ch.rotationKeyframes,
          applyUpdate: (next) => onUpdateCharacterVec3Keys(ch.id, 'rot', next),
        });
      }
      for (const nt of ch.nodeTracks ?? []) {
        for (const axis of ['x', 'y', 'z'] as const) {
          out.push({
            id: `${ch.id}:node:${nt.nodeId}:${axis}`,
            label: `${ch.name} · ${nt.nodeName} Rot ${axis.toUpperCase()} (${nt.rotationKeyframes.length})`,
            axis,
            keyframes: nt.rotationKeyframes,
            applyUpdate: (next) => onUpdateNodeRotKeys(ch.id, nt.nodeId, next),
          });
        }
      }
    }
    if (onUpdateGroupVec3Keys) {
      for (const grp of scene.groups ?? []) {
        for (const axis of ['x', 'y', 'z'] as const) {
          out.push({
            id: `grp:${grp.id}:pos:${axis}`,
            label: `Group: ${grp.name} · Pos ${axis.toUpperCase()} (${grp.positionKeyframes.length})`,
            axis,
            keyframes: grp.positionKeyframes,
            applyUpdate: (next) => onUpdateGroupVec3Keys(grp.id, 'pos', next),
          });
        }
      }
    }
    return out;
  }, [scene.characters, scene.groups, onUpdateCharacterVec3Keys, onUpdateNodeRotKeys, onUpdateGroupVec3Keys]);

  const [selectedChannelId, setSelectedChannelId] = useState<string>('');
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [zoomY, setZoomY] = useState(1);
  const [timeZoom, setTimeZoom] = useState(1);
  const [timeOffset, setTimeOffset] = useState(0);
  const [tangentMode, setTangentMode] = useState<'smooth' | 'broken'>('smooth');
  const svgRef = useRef<SVGSVGElement>(null);

  const activeChannel =
    channels.find((c) => c.id === selectedChannelId) ??
    channels.find((c) => c.keyframes.length > 0) ??
    channels[0] ??
    null;

  const sortedKeys = useMemo(
    () => (activeChannel ? sortByTime(activeChannel.keyframes) : []),
    [activeChannel],
  );

  const selectedKeyIndex = sortedKeys.findIndex((k) => k.id === selectedKeyId);
  const selectedKey = selectedKeyIndex >= 0 ? sortedKeys[selectedKeyIndex] : sortedKeys[0] ?? null;

  const viewDuration = Math.max(0.5, scene.duration / timeZoom);
  const viewStart = clamp(timeOffset, 0, Math.max(0, scene.duration - viewDuration));
  const viewEnd = Math.min(scene.duration, viewStart + viewDuration);

  const { minVal, maxVal } = useMemo(() => {
    if (!activeChannel || sortedKeys.length === 0) return { minVal: -5, maxVal: 5 };
    const vals = sortedKeys.map((k) => k.value[activeChannel.axis]);
    const lo = Math.min(...vals, -1);
    const hi = Math.max(...vals, 1);
    const pad = Math.max(1, (hi - lo) * 0.25) / zoomY;
    const mid = (lo + hi) / 2;
    const half = Math.max(0.6, ((hi - lo) / 2) / zoomY + pad);
    return { minVal: mid - half, maxVal: mid + half };
  }, [activeChannel, sortedKeys, zoomY]);

  const width = 680;
  const height = 148;
  const padLeft = 40;
  const padRight = 16;
  const padTop = 12;
  const padBottom = 18;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const timeToX = (t: number) =>
    padLeft + ((t - viewStart) / Math.max(0.1, viewEnd - viewStart)) * plotW;
  const valToY = (v: number) => {
    const span = Math.max(0.01, maxVal - minVal);
    return padTop + (1 - (v - minVal) / span) * plotH;
  };
  const xToTime = (px: number) =>
    clamp(viewStart + ((px - padLeft) / plotW) * (viewEnd - viewStart), 0, scene.duration);
  const yToVal = (py: number) =>
    minVal + (1 - clamp((py - padTop) / plotH, 0, 1)) * (maxVal - minVal);

  const curvePath = useMemo(() => {
    if (!activeChannel || sortedKeys.length === 0) return '';
    const numKeys = sortedKeys.map((k) => ({
      id: k.id,
      time: k.time,
      value: k.value[activeChannel.axis],
      easing: k.easing,
      handleIn: k.handleIn,
      handleOut: k.handleOut,
    }));
    const steps = 140;
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = viewStart + (i / steps) * (viewEnd - viewStart);
      const v = evaluateNumberTrack(numKeys, t, 0);
      pts.push(`${i === 0 ? 'M' : 'L'} ${timeToX(t).toFixed(1)} ${valToY(v).toFixed(1)}`);
    }
    return pts.join(' ');
  }, [activeChannel, sortedKeys, viewStart, viewEnd, minVal, maxVal]);

  const handleDragPoint = (kf: Vec3Keyframe, e: React.PointerEvent) => {
    if (!activeChannel || !svgRef.current) return;
    e.stopPropagation();
    setSelectedKeyId(kf.id);
    const svgRect = svgRef.current.getBoundingClientRect();

    const onMove = (ev: PointerEvent) => {
      const rx = ((ev.clientX - svgRect.left) / svgRect.width) * width;
      const ry = ((ev.clientY - svgRect.top) / svgRect.height) * height;
      const nextTime = Number(xToTime(rx).toFixed(2));
      const nextVal = Number(yToVal(ry).toFixed(3));
      const updated = activeChannel.keyframes.map((k) =>
        k.id === kf.id
          ? { ...k, time: nextTime, value: { ...k.value, [activeChannel.axis]: nextVal } as Vec3 }
          : k,
      );
      activeChannel.applyUpdate(updated);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleDragBezierHandle = (
    kfIdx: number,
    side: 'in' | 'out',
    e: React.PointerEvent,
  ) => {
    if (!activeChannel || !svgRef.current) return;
    e.stopPropagation();
    const kf = sortedKeys[kfIdx];
    if (!kf) return;
    setSelectedKeyId(kf.id);
    const prevKf = sortedKeys[kfIdx - 1];
    const nextKf = sortedKeys[kfIdx + 1];
    const svgRect = svgRef.current.getBoundingClientRect();
    const axis = activeChannel.axis;

    const onMove = (ev: PointerEvent) => {
      const rx = ((ev.clientX - svgRect.left) / svgRect.width) * width;
      const ry = ((ev.clientY - svgRect.top) / svgRect.height) * height;
      const dragTime = xToTime(rx);
      const dragVal = yToVal(ry);

      let nextIn: BezierHandle2D = kf.handleIn ?? { x: 0.35, y: 0.0 };
      let nextOut: BezierHandle2D = kf.handleOut ?? { x: 0.35, y: 0.0 };

      if (side === 'in' && prevKf) {
        const dt = Math.max(0.05, kf.time - prevKf.time);
        const dv = kf.value[axis] - prevKf.value[axis];
        const hx = clamp((kf.time - dragTime) / dt, 0.02, 0.98);
        const hy = Math.abs(dv) > 1e-4 ? clamp((kf.value[axis] - dragVal) / dv, -2, 2) : 0;
        nextIn = { x: Number(hx.toFixed(3)), y: Number(hy.toFixed(3)) };
        if (tangentMode === 'smooth' && nextKf) {
          nextOut = { x: nextIn.x, y: nextIn.y };
        }
      } else if (side === 'out' && nextKf) {
        const dt = Math.max(0.05, nextKf.time - kf.time);
        const dv = nextKf.value[axis] - kf.value[axis];
        const hx = clamp((dragTime - kf.time) / dt, 0.02, 0.98);
        const hy = Math.abs(dv) > 1e-4 ? clamp((dragVal - kf.value[axis]) / dv, -2, 2) : 0;
        nextOut = { x: Number(hx.toFixed(3)), y: Number(hy.toFixed(3)) };
        if (tangentMode === 'smooth' && prevKf) {
          nextIn = { x: nextOut.x, y: nextOut.y };
        }
      }

      const updated = activeChannel.keyframes.map((k) => {
        if (k.id === kf.id) {
          return {
            ...k,
            easing: side === 'in' ? ('bezier' as const) : k.easing,
            handleIn: nextIn,
            handleOut: nextOut,
          };
        }
        // Segment [kf, nextKf] reads easing from nextKf.easing
        if (side === 'out' && nextKf && k.id === nextKf.id) {
          return { ...k, easing: 'bezier' as const };
        }
        return k;
      });
      activeChannel.applyUpdate(updated);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleAddKeyAtPlayhead = () => {
    if (!activeChannel) return;
    const baseVal: Vec3 = sortedKeys[0]?.value ?? { x: 0, y: 0, z: 0 };
    const snapT = Number(currentTime.toFixed(2));
    const filtered = activeChannel.keyframes.filter((k) => Math.abs(k.time - snapT) > 0.04);
    const created: Vec3Keyframe = {
      id: createId('kf'),
      time: snapT,
      value: { ...baseVal },
      easing: 'smooth',
      handleIn: { x: 0.35, y: 0 },
      handleOut: { x: 0.35, y: 0 },
    };
    activeChannel.applyUpdate([...filtered, created]);
    setSelectedKeyId(created.id);
  };

  return (
    <div className="flex h-full flex-col bg-[#15171b] text-xs" data-testid="graph-editor">
      {/* Controls Bar */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-[#2a2e36] bg-[#181a1f] px-3 overflow-x-auto">
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          {channels.length > 0 ? (
            <div className="w-52 max-w-[240px]">
              <CustomSelect
                ariaLabel="Graph editor property channel"
                size="xs"
                value={activeChannel?.id ?? ''}
                options={channels.map((ch) => ({ value: ch.id, label: ch.label }))}
                onChange={(val) => setSelectedChannelId(val)}
              />
            </div>
          ) : (
            <span className="text-[11px] text-[#6b7280]">Add a character to inspect property curves</span>
          )}

          {activeChannel && (
            <StudioButton size="xs" onClick={handleAddKeyAtPlayhead}>
              <Plus className="h-3 w-3" aria-hidden="true" />
              <span>Key @ {currentTime.toFixed(1)}s</span>
            </StudioButton>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {selectedKey && activeChannel && (
            <>
              <div className="w-28">
                <CustomSelect
                  ariaLabel="Selected keyframe curve mode"
                  value={selectedKey.easing}
                  options={EASING_LIST}
                  onChange={(easing) => {
                    const updated = activeChannel.keyframes.map((k) =>
                      k.id === selectedKey.id
                        ? {
                            ...k,
                            easing: easing as EasingType,
                            handleOut: k.handleOut ?? { x: 0.35, y: 0.0 },
                            handleIn: k.handleIn ?? { x: 0.35, y: 0.0 },
                          }
                        : k,
                    );
                    activeChannel.applyUpdate(updated);
                  }}
                />
              </div>
              <StudioButton
                size="xs"
                variant={tangentMode === 'smooth' ? 'selected' : 'default'}
                note="Toggle Bezier handle symmetry (Smooth mirrored vs Broken independent)"
                onClick={() => setTangentMode((m) => (m === 'smooth' ? 'broken' : 'smooth'))}
              >
                {tangentMode === 'smooth' ? (
                  <Link2 className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Scissors className="h-3 w-3" aria-hidden="true" />
                )}
                <span>{tangentMode === 'smooth' ? 'Smooth' : 'Broken'}</span>
              </StudioButton>
              <IconButton
                label="Delete selected curve keyframe"
                onClick={() => {
                  activeChannel.applyUpdate(activeChannel.keyframes.filter((k) => k.id !== selectedKey.id));
                  setSelectedKeyId(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            </>
          )}

          <div className="h-4 w-px bg-[#2a2e36]" aria-hidden="true" />
          <IconButton
            label="Zoom Out Time"
            onClick={() => setTimeZoom((z) => Math.max(1, Number((z - 0.5).toFixed(2))))}
          >
            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <span className="text-[10px] font-mono-code text-[#98a0ad]">T{timeZoom.toFixed(1)}x</span>
          <IconButton
            label="Zoom In Time"
            onClick={() => setTimeZoom((z) => Math.min(4, Number((z + 0.5).toFixed(2))))}
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          {timeZoom > 1 && (
            <input
              type="range"
              aria-label="Pan curve time range"
              min={0}
              max={Math.max(0.1, scene.duration - viewDuration)}
              step={0.1}
              value={viewStart}
              onChange={(e) => setTimeOffset(Number(e.target.value))}
              className="w-16 accent-[#e8702a]"
            />
          )}

          <div className="h-4 w-px bg-[#2a2e36]" aria-hidden="true" />
          <IconButton label="Zoom Out Curve Value" onClick={() => setZoomY((z) => Math.max(0.4, z - 0.25))}>
            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton label="Zoom In Curve Value" onClick={() => setZoomY((z) => Math.min(4, z + 0.25))}>
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      {/* SVG Curve Canvas */}
      <div className="relative min-h-0 flex-1 overflow-hidden p-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="h-full w-full select-none rounded border border-[#242830] bg-[#121316]"
          onPointerDown={(e) => {
            if (!svgRef.current) return;
            const rect = svgRef.current.getBoundingClientRect();
            const rx = ((e.clientX - rect.left) / rect.width) * width;
            onSeek(xToTime(rx));
          }}
        >
          {/* Horizontal grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const y = padTop + frac * plotH;
            const val = maxVal - frac * (maxVal - minVal);
            return (
              <g key={frac}>
                <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#22262e" strokeWidth={1} />
                <text x={4} y={y + 3} fill="#6b7280" fontSize="9" fontFamily="monospace">
                  {val.toFixed(1)}
                </text>
              </g>
            );
          })}

          {/* Vertical time labels */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const t = viewStart + frac * (viewEnd - viewStart);
            const x = timeToX(t);
            return (
              <g key={`t_${frac}`}>
                <line x1={x} y1={padTop} x2={x} y2={height - padBottom} stroke="#1d2028" strokeWidth={1} />
                <text x={x - 8} y={height - 4} fill="#6b7280" fontSize="8.5" fontFamily="monospace">
                  {t.toFixed(1)}s
                </text>
              </g>
            );
          })}

          {/* Curve polyline */}
          {curvePath && <path d={curvePath} fill="none" stroke="#e8702a" strokeWidth={2} />}

          {/* Keyframe points + Interactive Bezier Handles */}
          {activeChannel &&
            sortedKeys.map((kf, idx) => {
              const axis = activeChannel.axis;
              const cx = timeToX(kf.time);
              const cy = valToY(kf.value[axis]);
              const isSel = selectedKey?.id === kf.id;
              const prevKf = sortedKeys[idx - 1];
              const nextKf = sortedKeys[idx + 1];

              const hIn = kf.handleIn ?? { x: 0.35, y: 0.0 };
              const hOut = kf.handleOut ?? { x: 0.35, y: 0.0 };

              const inTime = prevKf ? kf.time - hIn.x * (kf.time - prevKf.time) : kf.time - 0.3;
              const inVal = prevKf
                ? kf.value[axis] - hIn.y * (kf.value[axis] - prevKf.value[axis])
                : kf.value[axis];
              const outTime = nextKf ? kf.time + hOut.x * (nextKf.time - kf.time) : kf.time + 0.3;
              const outVal = nextKf
                ? kf.value[axis] + hOut.y * (nextKf.value[axis] - kf.value[axis])
                : kf.value[axis];

              const inX = prevKf ? timeToX(inTime) : cx - 22;
              const inY = prevKf ? valToY(inVal) : cy;
              const outX = nextKf ? timeToX(outTime) : cx + 22;
              const outY = nextKf ? valToY(outVal) : cy;

              return (
                <g key={kf.id}>
                  {isSel && prevKf && (
                    <>
                      <line x1={cx} y1={cy} x2={inX} y2={inY} stroke="#60a5fa" strokeWidth={1} strokeDasharray="2 2" />
                      <circle
                        cx={inX}
                        cy={inY}
                        r={4}
                        fill="#60a5fa"
                        stroke="#121316"
                        strokeWidth={1}
                        className="cursor-grab"
                        data-testid="bezier-handle-in"
                        onPointerDown={(e) => handleDragBezierHandle(idx, 'in', e)}
                      />
                    </>
                  )}
                  {isSel && nextKf && (
                    <>
                      <line x1={cx} y1={cy} x2={outX} y2={outY} stroke="#60a5fa" strokeWidth={1} strokeDasharray="2 2" />
                      <circle
                        cx={outX}
                        cy={outY}
                        r={4}
                        fill="#60a5fa"
                        stroke="#121316"
                        strokeWidth={1}
                        className="cursor-grab"
                        data-testid="bezier-handle-out"
                        onPointerDown={(e) => handleDragBezierHandle(idx, 'out', e)}
                      />
                    </>
                  )}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isSel ? 5.5 : 4}
                    fill={isSel ? '#ffffff' : '#e8702a'}
                    stroke="#121316"
                    strokeWidth={1.5}
                    className="cursor-move"
                    data-testid="graph-keyframe-point"
                    onPointerDown={(e) => handleDragPoint(kf, e)}
                  />
                </g>
              );
            })}

          {/* Playhead vertical cursor */}
          {currentTime >= viewStart && currentTime <= viewEnd && (
            <line
              x1={timeToX(currentTime)}
              y1={padTop}
              x2={timeToX(currentTime)}
              y2={height - padBottom}
              stroke="#60a5fa"
              strokeWidth={1.2}
            />
          )}
        </svg>
      </div>
    </div>
  );
}
