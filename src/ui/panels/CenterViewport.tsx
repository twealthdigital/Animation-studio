import React, { useEffect, useState } from 'react';
import {
  AlignCenterHorizontal,
  Bone,
  BoxSelect,
  Camera,
  Check,
  Crosshair,
  Expand,
  Globe,
  Grid3x3,
  Layers,
  Lock,
  Magnet,
  Maximize2,
  Minus,
  Mouse,
  MousePointer,
  Move,
  Plus,
  RotateCcw,
  RotateCw,
  Ruler,
  Sparkles,
  Unlock,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AxisConstraint,
  CameraOrientationState,
  EditorCameraPreset,
  GizmoMode,
  GizmoSpace,
  HoverTargetInfo,
  LiveSizeInfo,
  SelectionFilter,
  SizeUnit,
  SnapSettings,
  StudioMode,
  TabPrediction,
} from '../../core/types';
import type { CameraViewMode } from '../../engine/StudioEngine';
import {
  ContextMenu,
  type ContextMenuItem,
  CustomSelect,
  IconButton,
  StudioButton,
} from '../components/Primitives';
import { TabSuggestionHud } from '../dialogs/TabSuggestionHud';

interface CenterViewportProps {
  mountRef: React.RefObject<HTMLDivElement | null>;
  studioMode: StudioMode;
  viewMode: CameraViewMode;
  gizmoMode: GizmoMode;
  gizmoSpace: GizmoSpace;
  axisConstraint: AxisConstraint;
  snapSettings: SnapSettings;
  selectionFilter: SelectionFilter;
  showRigOverlay: boolean;
  floorLockEnabled: boolean;
  multiSelectedCount: number;
  multiSelectedNodeCount?: number;
  hoverInfo: HoverTargetInfo | null;
  liveSizeInfo: LiveSizeInfo | null;
  sizeUnit: SizeUnit;
  cameraOrientation: CameraOrientationState;
  poseModeInstanceId: string | null;
  poseModeCharName?: string | null;
  editorProjection: 'perspective' | 'orthographic';
  editorCameraPreset: EditorCameraPreset;
  onChangeGizmoMode: (mode: GizmoMode) => void;
  onChangeGizmoSpace: (space: GizmoSpace) => void;
  onChangeAxisConstraint: (axis: AxisConstraint) => void;
  onToggleSnap: () => void;
  onToggleFloorLock: () => void;
  onChangeSelectionFilter: (filter: SelectionFilter) => void;
  onToggleRigOverlay: () => void;
  onChangeSizeUnit: (unit: SizeUnit) => void;
  onApplyTargetSize: (targetValue: number, unit: SizeUnit) => void;
  onAlignMultiSelection: (mode: 'align-x' | 'align-z' | 'distribute-x' | 'ground-y') => void;
  onGroupSelection: () => void;
  onResetEditorCamera: () => void;
  onToggleEditorProjection: () => void;
  onChangeEditorCameraPreset: (preset: EditorCameraPreset) => void;
  onFocusTarget: () => void;
  onFrameAll: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onExitPoseMode: () => void;
  onToggleTabHud: () => void;
  tabHud: {
    open: boolean;
    predictions: TabPrediction[];
    activeIndex: number;
    previewActive: boolean;
    onSelectIndex: (idx: number) => void;
    onTogglePreview: (pred: TabPrediction) => void;
    onApply: (pred: TabPrediction) => void;
    onDismiss: () => void;
  };
  viewportContextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;
  onCloseContextMenu: () => void;
  sceneName: string;
  characterCount: number;
  propCount: number;
  beginnerTip?: string | null;
  isolatedIframeHtml?: { instanceId: string; name: string; html: string } | null;
  onRegisterIframe?: (instanceId: string, el: HTMLIFrameElement | null) => void;
}

const FILTER_OPTIONS: { value: SelectionFilter; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'character', label: 'Characters' },
  { value: 'body-part', label: 'Body Joints' },
  { value: 'ik-handle', label: 'IK Handles' },
  { value: 'group', label: 'Groups' },
  { value: 'prop', label: 'Props' },
  { value: 'light', label: 'Lights' },
  { value: 'camera', label: 'Camera' },
  { value: 'waypoint', label: 'Path Points' },
];

const CAMERA_PRESETS: { value: EditorCameraPreset; label: string }[] = [
  { value: 'free', label: '3D Orbit' },
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
];

const SIZE_UNIT_OPTIONS: { value: SizeUnit; label: string }[] = [
  { value: 'px', label: 'px' },
  { value: '%', label: '%' },
  { value: 'm', label: 'm' },
  { value: 'cm', label: 'cm' },
  { value: 'ft', label: 'ft' },
];

function computeDisplaySize(info: LiveSizeInfo, unit: SizeUnit): number {
  const refM = info.heightM > 0.02 ? info.heightM : Math.max(info.widthM, info.depthM);
  switch (unit) {
    case '%':
      return Math.round(info.scaleFactor * 100);
    case 'px':
      return Math.round(refM * 100);
    case 'cm':
      return Math.round(refM * 100);
    case 'ft':
      return Number((refM / 0.3048).toFixed(2));
    case 'm':
    default:
      return Number(refM.toFixed(2));
  }
}

interface CompassAxisSpec {
  id: string;
  label: string;
  preset: EditorCameraPreset;
  vec: [number, number, number];
  color: string;
  positive: boolean;
}

const COMPASS_AXES: CompassAxisSpec[] = [
  { id: '+x', label: 'X', preset: 'right', vec: [1, 0, 0], color: '#ef4444', positive: true },
  { id: '-x', label: '-X', preset: 'left', vec: [-1, 0, 0], color: '#7f1d1d', positive: false },
  { id: '+y', label: 'Y', preset: 'top', vec: [0, 1, 0], color: '#22c55e', positive: true },
  { id: '-y', label: '-Y', preset: 'bottom', vec: [0, -1, 0], color: '#14532d', positive: false },
  { id: '+z', label: 'Z', preset: 'front', vec: [0, 0, 1], color: '#3b82f6', positive: true },
  { id: '-z', label: '-Z', preset: 'back', vec: [0, 0, -1], color: '#1e3a8a', positive: false },
];

export function CenterViewport({
  mountRef,
  studioMode,
  viewMode,
  gizmoMode,
  gizmoSpace,
  axisConstraint,
  snapSettings,
  selectionFilter,
  showRigOverlay,
  floorLockEnabled,
  multiSelectedCount,
  multiSelectedNodeCount = 0,
  hoverInfo,
  liveSizeInfo,
  sizeUnit,
  cameraOrientation,
  poseModeInstanceId,
  poseModeCharName,
  editorProjection,
  editorCameraPreset,
  onChangeGizmoMode,
  onChangeGizmoSpace,
  onChangeAxisConstraint,
  onToggleSnap,
  onToggleFloorLock,
  onChangeSelectionFilter,
  onToggleRigOverlay,
  onChangeSizeUnit,
  onApplyTargetSize,
  onAlignMultiSelection,
  onGroupSelection,
  onResetEditorCamera,
  onToggleEditorProjection,
  onChangeEditorCameraPreset,
  onFocusTarget,
  onFrameAll,
  onZoomIn,
  onZoomOut,
  onExitPoseMode,
  onToggleTabHud,
  tabHud,
  viewportContextMenu,
  onCloseContextMenu,
  sceneName,
  characterCount,
  propCount,
  beginnerTip,
  isolatedIframeHtml,
  onRegisterIframe,
}: CenterViewportProps) {
  const [sizeDraft, setSizeDraft] = useState<string>('');
  const [sizeInputFocused, setSizeInputFocused] = useState(false);

  const computedLiveValue = liveSizeInfo ? computeDisplaySize(liveSizeInfo, sizeUnit) : null;

  useEffect(() => {
    if (!sizeInputFocused && computedLiveValue !== null) {
      setSizeDraft(String(computedLiveValue));
    }
  }, [computedLiveValue, sizeInputFocused]);

  const handleCommitSizeDraft = () => {
    const parsed = Number.parseFloat(sizeDraft);
    if (Number.isFinite(parsed) && parsed > 0) {
      onApplyTargetSize(parsed, sizeUnit);
    } else if (computedLiveValue !== null) {
      setSizeDraft(String(computedLiveValue));
    }
  };

  // Project 3D world axes onto the 2D Orientation Compass SVG
  const projectedAxes = COMPASS_AXES.map((ax) => {
    const [vx, vy, vz] = ax.vec;
    const sx =
      vx * cameraOrientation.right.x +
      vy * cameraOrientation.right.y +
      vz * cameraOrientation.right.z;
    const sy =
      vx * cameraOrientation.up.x +
      vy * cameraOrientation.up.y +
      vz * cameraOrientation.up.z;
    // Depth along camera look direction (more negative forward dot = closer to viewer)
    const depth = -(
      vx * cameraOrientation.forward.x +
      vy * cameraOrientation.forward.y +
      vz * cameraOrientation.forward.z
    );
    return {
      ...ax,
      x: 42 + sx * 27,
      y: 42 - sy * 27,
      depth,
    };
  }).sort((a, b) => a.depth - b.depth);

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#121316]" aria-label="3D Viewport">
      {/* Compact Viewport Toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[#2a2e36] bg-[#16181c] px-2.5 text-xs overflow-x-auto">
        <div className="flex items-center gap-1 shrink-0">
          <IconButton
            label="Select Tool"
            note="Click any part directly to select only that part · Double-click to toggle whole character · Click outside to clear"
            shortcut="Q"
            active={gizmoMode === 'select'}
            onClick={() => onChangeGizmoMode('select')}
          >
            <MousePointer className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Box Highlight Tool"
            note="Drag a highlight box anywhere to select multiple objects or body components"
            shortcut="B"
            active={gizmoMode === 'box-select'}
            onClick={() => onChangeGizmoMode('box-select')}
          >
            <BoxSelect className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Camera Orbit Mouse"
            note="Orbit camera freely with left-click drag (or use middle-mouse drag in any tool like Blender)"
            shortcut="O"
            active={gizmoMode === 'orbit'}
            onClick={() => onChangeGizmoMode('orbit')}
          >
            <Mouse className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Move Gizmo"
            note="Translate selected object, part, or group in 3D space (drag glides smoothly across stage; hold Shift for vertical)"
            shortcut="G"
            active={gizmoMode === 'translate'}
            onClick={() => onChangeGizmoMode('translate')}
          >
            <Move className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Rotate Gizmo"
            note="Rotate object, component, or child joint around locked socket"
            shortcut="R"
            active={gizmoMode === 'rotate'}
            onClick={() => onChangeGizmoMode('rotate')}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Scale Gizmo"
            note="Resize selected object, component, or group (or drag the golden 3D Scale Node corner handle)"
            shortcut="S"
            active={gizmoMode === 'scale'}
            onClick={() => onChangeGizmoMode('scale')}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <div className="mx-1 h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

          {/* World / Local Space */}
          <StudioButton
            size="xs"
            variant={gizmoSpace === 'local' ? 'selected' : 'default'}
            note="Switch gizmo between World axes and Character Local axes"
            shortcut="L"
            onClick={() => onChangeGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world')}
          >
            <Globe className="h-3 w-3" aria-hidden="true" />
            <span>{gizmoSpace === 'local' ? 'Local' : 'World'}</span>
          </StudioButton>

          {/* Snap Toggle */}
          <IconButton
            label={`Snap (${snapSettings.enabled ? 'On' : 'Off'})`}
            note="Snap position & rotation steps to grid increments"
            active={snapSettings.enabled}
            onClick={onToggleSnap}
          >
            <Magnet className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          {/* Floor Lock / Under-Floor Unlock Toggle */}
          <StudioButton
            size="xs"
            variant={!floorLockEnabled ? 'selected' : 'default'}
            note={
              floorLockEnabled
                ? 'Floor Locked: Objects stay above the floor. Click to unlock and allow moving objects underneath the floor'
                : 'Floor Unlocked: Objects and camera can freely go underneath the floor. Click to lock above floor'
            }
            onClick={onToggleFloorLock}
          >
            {floorLockEnabled ? (
              <Lock className="h-3 w-3 text-[#4ade80]" aria-hidden="true" />
            ) : (
              <Unlock className="h-3 w-3 text-[#f59e0b]" aria-hidden="true" />
            )}
            <span>{floorLockEnabled ? 'Floor Lock' : 'Under Floor'}</span>
          </StudioButton>

          {/* Axis Constraints */}
          {studioMode === 'advanced' && (
            <div className="flex items-center rounded border border-[#2a2e36] bg-[#14161a] p-0.5 ml-0.5">
              {(['all', 'x', 'y', 'z'] as AxisConstraint[]).map((ax) => (
                <button
                  key={ax}
                  type="button"
                  data-studio-note={
                    ax === 'all' ? 'Allow free movement on all axes' : `Lock gizmo to ${ax.toUpperCase()} axis only`
                  }
                  onClick={() => onChangeAxisConstraint(ax)}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-mono-code uppercase ${
                    axisConstraint === ax
                      ? 'bg-[#e8702a] text-[#121316] font-bold'
                      : 'text-[#98a0ad] hover:text-[#e6e8ec]'
                  }`}
                >
                  {ax}
                </button>
              ))}
            </div>
          )}

          <div className="mx-1 h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

          {/* Selection Filter (Custom Dropdown) */}
          <div className="w-24 shrink-0" data-studio-note="Filter viewport clicks by object or rig type">
            <CustomSelect
              ariaLabel="Viewport selection filter"
              size="xs"
              value={selectionFilter}
              options={FILTER_OPTIONS}
              onChange={(val) => onChangeSelectionFilter(val as SelectionFilter)}
            />
          </div>

          {studioMode === 'advanced' && (
            <IconButton
              label="Toggle Rig & Joint Overlay"
              note="Show/hide bone links, gimbal sockets, axis rings & IK handles"
              active={showRigOverlay}
              onClick={onToggleRigOverlay}
            >
              <Bone className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          )}

          {(multiSelectedCount >= 2 || multiSelectedNodeCount >= 2) && (
            <div className="flex items-center gap-1 ml-1 rounded border border-[#e8702a] bg-[#2e221b] px-1.5 py-0.5">
              <Layers className="h-3 w-3 text-[#e8702a]" aria-hidden="true" />
              <span className="text-[10px] font-semibold text-[#f7be97]">
                {multiSelectedNodeCount >= 2 ? `${multiSelectedNodeCount} parts` : multiSelectedCount}
              </span>
              <button
                type="button"
                data-studio-note={
                  multiSelectedNodeCount >= 2
                    ? 'Lock selected components into an editable part group without detaching'
                    : 'Combine selected items into a logical group'
                }
                data-studio-shortcut="Ctrl+G"
                onClick={onGroupSelection}
                className="rounded bg-[#e8702a] px-1.5 py-0.5 text-[10px] font-semibold text-[#121316] hover:bg-[#f07f3c]"
              >
                {multiSelectedNodeCount >= 2 ? 'Group Parts' : 'Group'}
              </button>
              {multiSelectedCount >= 2 && (
                <>
                  <button
                    type="button"
                    data-studio-note="Align selected items on X axis"
                    onClick={() => onAlignMultiSelection('align-x')}
                    className="rounded px-1 text-[10px] text-[#e6e8ec] hover:bg-[#383e49]"
                  >
                    <AlignCenterHorizontal className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-studio-note="Snap selected items to Floor Y=0"
                    onClick={() => onAlignMultiSelection('ground-y')}
                    className="rounded px-1 text-[10px] text-[#e6e8ec] hover:bg-[#383e49]"
                  >
                    <Grid3x3 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )}

          <div className="mx-1 h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

          {/* Editor Camera Angle Presets (Custom Dropdown) */}
          <div className="w-24 shrink-0" data-studio-note="Snap viewport camera to Front, Back, Side, or Top view">
            <CustomSelect
              ariaLabel="Editor camera angle preset"
              size="xs"
              value={editorCameraPreset}
              options={CAMERA_PRESETS}
              onChange={(val) => onChangeEditorCameraPreset(val as EditorCameraPreset)}
            />
          </div>

          <StudioButton
            size="xs"
            variant={editorProjection === 'orthographic' ? 'selected' : 'default'}
            note="Toggle Perspective vs flat Orthographic editing view"
            onClick={onToggleEditorProjection}
          >
            <Camera className="h-3 w-3" aria-hidden="true" />
            <span>{editorProjection === 'orthographic' ? 'Ortho' : 'Persp'}</span>
          </StudioButton>

          <IconButton
            label="Zoom In"
            note="Zoom viewport camera closer (Mouse Wheel Up / Pinch Out)"
            shortcut="+"
            onClick={onZoomIn}
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Zoom Out"
            note="Zoom viewport camera farther away (Mouse Wheel Down / Pinch In)"
            shortcut="-"
            onClick={onZoomOut}
          >
            <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Focus Target"
            note="Zoom tightly onto hovered part or active selection"
            shortcut="F"
            onClick={onFocusTarget}
          >
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Frame All"
            note="Frame all characters & props in viewport"
            shortcut="Shift+F"
            onClick={onFrameAll}
          >
            <Expand className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Reset Editor View"
            note="Reset orbit camera back to default stage view"
            onClick={onResetEditorCamera}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Animation Suggestions"
            note="Open next-step pose & motion predictions"
            shortcut="Tab"
            active={tabHud.open}
            onClick={onToggleTabHud}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[#98a0ad] shrink-0">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              poseModeInstanceId
                ? 'bg-[#2e221b] text-[#f7be97] border border-[#e8702a]/70'
                : 'bg-[#202329] text-[#98a0ad] border border-[#2e333d]'
            }`}
          >
            {poseModeInstanceId ? 'Pose' : 'Object'}
          </span>
          <span className="font-medium text-[#e6e8ec]">{sceneName}</span>
          <span aria-hidden="true">·</span>
          <span>{viewMode === 'scene' ? 'Final Cam' : cameraOrientation.viewLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {characterCount}c{propCount > 0 ? ` · ${propCount}p` : ''}
          </span>
        </div>
      </div>

      {/* Dedicated WebGL Canvas Host */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={mountRef}
          data-testid="viewport-canvas-host"
          className={`h-full w-full touch-none overscroll-none ${
            gizmoMode === 'orbit'
              ? 'cursor-grab'
              : gizmoMode === 'box-select'
                ? 'cursor-crosshair'
                : ''
          }`}
        />

        {/* Interactive Blender-Style 3D Orientation Compass & View Snapper (Top-Right) */}
        {viewMode === 'editor' && (
          <div
            data-testid="viewport-orientation-compass"
            className="pointer-events-auto absolute top-3 right-3 z-20 flex flex-col items-center rounded-md border border-[#2d323b] bg-[#16181c] p-2 shadow-xl select-none"
          >
            <svg width="84" height="84" viewBox="0 0 84 84" className="overflow-visible">
              <circle cx="42" cy="42" r="35" fill="#121418" stroke="#2a2e36" strokeWidth="1" />
              {/* Axis lines */}
              {projectedAxes
                .filter((a) => a.positive)
                .map((ax) => (
                  <line
                    key={`line-${ax.id}`}
                    x1="42"
                    y1="42"
                    x2={ax.x}
                    y2={ax.y}
                    stroke={ax.color}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                ))}
              {/* Clickable axis endpoints sorted back-to-front */}
              {projectedAxes.map((ax) => (
                <g
                  key={ax.id}
                  className="cursor-pointer"
                  onClick={() => onChangeEditorCameraPreset(ax.preset)}
                >
                  <title>{`Snap to ${ax.preset.charAt(0).toUpperCase() + ax.preset.slice(1)} View (${ax.label})`}</title>
                  <circle
                    cx={ax.x}
                    cy={ax.y}
                    r={ax.positive ? 8.5 : 6}
                    fill={ax.color}
                    stroke={ax.positive ? '#121316' : '#2a2e36'}
                    strokeWidth="1.2"
                  />
                  {ax.positive && (
                    <text
                      x={ax.x}
                      y={ax.y + 3.2}
                      textAnchor="middle"
                      fill="#ffffff"
                      fontSize="9"
                      fontWeight="700"
                      style={{ pointerEvents: 'none' }}
                    >
                      {ax.label}
                    </text>
                  )}
                </g>
              ))}
            </svg>

            <div className="mt-1 flex items-center gap-1">
              <span className="rounded bg-[#22262e] px-1.5 py-0.5 text-[10px] font-semibold text-[#e6e8ec]">
                {cameraOrientation.viewLabel}
              </span>
            </div>

            <div className="mt-1.5 grid grid-cols-3 gap-1 w-full">
              {(
                [
                  { preset: 'front' as EditorCameraPreset, label: 'Front' },
                  { preset: 'right' as EditorCameraPreset, label: 'Right' },
                  { preset: 'top' as EditorCameraPreset, label: 'Top' },
                ]
              ).map((v) => (
                <button
                  key={v.preset}
                  type="button"
                  onClick={() => onChangeEditorCameraPreset(v.preset)}
                  className={`rounded border px-1 py-0.5 text-[9px] font-medium transition-colors ${
                    cameraOrientation.viewLabel.toLowerCase() === v.preset
                      ? 'border-[#e8702a] bg-[#2e221b] text-[#f7be97]'
                      : 'border-[#2a2e36] bg-[#1c1f25] text-[#98a0ad] hover:text-[#e6e8ec]'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onResetEditorCamera}
              className="mt-1 w-full rounded border border-[#2a2e36] bg-[#1c1f25] py-0.5 text-[9px] font-medium text-[#cbd5e1] hover:border-[#3e4552] hover:bg-[#242830]"
            >
              Reset 3D View
            </button>
          </div>
        )}

        {/* Interactive Size Node Readout & Precision Unit Resize Bar (Bottom-Left) */}
        {viewMode === 'editor' && liveSizeInfo && !tabHud.open && (
          <div
            data-testid="viewport-size-control-bar"
            className={`pointer-events-auto absolute bottom-3 left-3 z-20 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs shadow-xl transition-colors ${
              liveSizeInfo.activeDragging
                ? 'border-[#f59e0b] bg-[#241b12]'
                : 'border-[#2e333d] bg-[#16181c]'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <Ruler
                className={`h-3.5 w-3.5 ${
                  liveSizeInfo.activeDragging ? 'text-[#fbbf24]' : 'text-[#e8702a]'
                }`}
                aria-hidden="true"
              />
              <span className="max-w-[110px] truncate text-[11px] font-semibold text-[#e6e8ec]">
                {liveSizeInfo.label}
              </span>
            </div>

            {/* Live Size Readout */}
            <div
              className={`rounded border px-1.5 py-0.5 font-mono-code text-[11px] font-semibold tabular-nums ${
                liveSizeInfo.activeDragging
                  ? 'border-[#f59e0b] bg-[#362511] text-[#fde68a]'
                  : 'border-[#2a2e36] bg-[#121418] text-[#7dd3fc]'
              }`}
              title="Live size readout (updates in real time as you drag the golden 3D Scale Node)"
            >
              {computedLiveValue} {sizeUnit}
              <span className="ml-1.5 text-[10px] font-normal text-[#98a0ad]">
                ({Math.round(liveSizeInfo.scaleFactor * 100)}% · {liveSizeInfo.heightM.toFixed(2)}m)
              </span>
            </div>

            {/* Precision Target Size Input + Unit Dropdown + Apply */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Decrease size by 10%"
                onClick={() => {
                  if (computedLiveValue !== null) {
                    onApplyTargetSize(Math.max(1, Number((computedLiveValue * 0.9).toFixed(2))), sizeUnit);
                  }
                }}
                className="flex h-6 w-6 items-center justify-center rounded border border-[#2e333d] bg-[#1e2127] text-[#cbd5e1] hover:bg-[#2a2f38]"
              >
                <Minus className="h-3 w-3" aria-hidden="true" />
              </button>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Target size value"
                value={sizeDraft}
                onFocus={() => setSizeInputFocused(true)}
                onChange={(e) => setSizeDraft(e.target.value)}
                onBlur={() => setSizeInputFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCommitSizeDraft();
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === 'Escape') {
                    if (computedLiveValue !== null) setSizeDraft(String(computedLiveValue));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="h-6 w-16 rounded border border-[#323844] bg-[#121418] px-1.5 text-right font-mono-code text-[11px] tabular-nums text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
              />
              <div className="w-14">
                <CustomSelect
                  ariaLabel="Size unit"
                  size="xs"
                  value={sizeUnit}
                  options={SIZE_UNIT_OPTIONS}
                  onChange={(val) => onChangeSizeUnit(val as SizeUnit)}
                />
              </div>
              <button
                type="button"
                aria-label="Increase size by 10%"
                onClick={() => {
                  if (computedLiveValue !== null) {
                    onApplyTargetSize(Number((computedLiveValue * 1.1).toFixed(2)), sizeUnit);
                  }
                }}
                className="flex h-6 w-6 items-center justify-center rounded border border-[#2e333d] bg-[#1e2127] text-[#cbd5e1] hover:bg-[#2a2f38]"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={handleCommitSizeDraft}
                className="flex h-6 items-center gap-1 rounded bg-[#e8702a] px-2 text-[11px] font-semibold text-[#121316] hover:bg-[#f07f3c]"
                title="Apply exact size (or press Enter)"
              >
                <Check className="h-3 w-3" aria-hidden="true" />
                <span>Set</span>
              </button>
            </div>
          </div>
        )}

        {/* Pose Mode Floating Banner */}
        {poseModeInstanceId && (
          <div
            data-testid="pose-mode-banner"
            className="pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded border border-[#e8702a] bg-[#1a1512] px-2.5 py-1 text-xs shadow-xl"
          >
            <Bone className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span className="font-semibold text-[#f7be97]">
              Pose{poseModeCharName ? `: ${poseModeCharName}` : ''}
            </span>
            <span className="text-[11px] text-[#cbd5e1]">
              Drag joint or rings · Socket-locked
            </span>
            <StudioButton size="xs" variant="primary" shortcut="Esc" onClick={onExitPoseMode}>
              Exit
            </StudioButton>
          </div>
        )}

        {/* Non-obstructive Hover Identification Tooltip */}
        {hoverInfo && !tabHud.open && (
          <div
            data-testid="viewport-hover-tooltip"
            style={{
              left: Math.max(12, hoverInfo.screenX + 14),
              top: Math.max(12, hoverInfo.screenY - 12),
            }}
            className="pointer-events-none absolute z-20 max-w-[230px] rounded border border-[#3a404c] bg-[#14161a] px-2.5 py-1.5 shadow-xl"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[11px] font-semibold text-[#e6e8ec]">
                {hoverInfo.title}
              </span>
              {hoverInfo.locked && (
                <span className="rounded bg-[#3a221d] px-1 py-0.5 text-[9px] font-semibold text-[#fca5a5]">
                  Locked
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-[#98a0ad]">
              {hoverInfo.description}
            </div>
          </div>
        )}

        {/* Tab-Triggered Animation Prediction HUD */}
        <TabSuggestionHud
          open={tabHud.open}
          predictions={tabHud.predictions}
          activeIndex={tabHud.activeIndex}
          previewActive={tabHud.previewActive}
          onSelectIndex={tabHud.onSelectIndex}
          onTogglePreview={tabHud.onTogglePreview}
          onApply={tabHud.onApply}
          onDismiss={tabHud.onDismiss}
        />

        {/* Beginner Mode Contextual Tip Footer */}
        {studioMode === 'beginner' && beginnerTip && !tabHud.open && !liveSizeInfo && (
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-md rounded border border-[#2a2e36] bg-[#16181c] px-3 py-1.5 text-[11px] text-[#e6e8ec] shadow-lg">
            <span className="font-semibold text-[#e8702a] mr-1.5">Tip:</span>
            <span>{beginnerTip}</span>
          </div>
        )}

        {/* Isolated HTML Sandbox Overlay (Mode B fallback for non-Three.js HTML characters) */}
        {isolatedIframeHtml && (
          <div className="pointer-events-auto absolute bottom-3 right-3 z-20 w-72 overflow-hidden rounded border border-[#383e49] bg-[#191b1f] shadow-xl">
            <div className="flex items-center justify-between border-b border-[#2a2e36] px-2.5 py-1.5 text-[11px]">
              <span className="truncate font-medium text-[#e6e8ec]">
                Sandbox: {isolatedIframeHtml.name}
              </span>
              <span className="text-[#98a0ad]">Mode B</span>
            </div>
            <iframe
              ref={(el) => onRegisterIframe?.(isolatedIframeHtml.instanceId, el)}
              title={`Isolated character ${isolatedIframeHtml.name}`}
              sandbox="allow-scripts"
              srcDoc={isolatedIframeHtml.html}
              className="h-48 w-full border-0 bg-[#121316]"
            />
          </div>
        )}

        {/* Viewport Context Menu (Right-click or Shift+F10) */}
        {viewportContextMenu && (
          <ContextMenu
            x={viewportContextMenu.x}
            y={viewportContextMenu.y}
            items={viewportContextMenu.items}
            onClose={onCloseContextMenu}
          />
        )}
      </div>
    </main>
  );
}
