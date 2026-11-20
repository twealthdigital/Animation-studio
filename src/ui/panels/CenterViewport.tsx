import React from 'react';
import {
  AlignCenterHorizontal,
  Bone,
  BoxSelect,
  Camera,
  Crosshair,
  Expand,
  Globe,
  Grid3x3,
  Layers,
  Magnet,
  Maximize2,
  Mouse,
  MousePointer,
  Move,
  RotateCcw,
  RotateCw,
  Sparkles,
} from 'lucide-react';
import type {
  AxisConstraint,
  EditorCameraPreset,
  GizmoMode,
  GizmoSpace,
  HoverTargetInfo,
  SelectionFilter,
  SnapSettings,
  StudioMode,
  TabPrediction,
} from '../../core/types';
import type { CameraViewMode } from '../../engine/StudioEngine';
import { ContextMenu, type ContextMenuItem, IconButton, StudioButton } from '../components/Primitives';
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
  multiSelectedCount: number;
  multiSelectedNodeCount?: number;
  hoverInfo: HoverTargetInfo | null;
  poseModeInstanceId: string | null;
  poseModeCharName?: string | null;
  editorProjection: 'perspective' | 'orthographic';
  editorCameraPreset: EditorCameraPreset;
  onChangeGizmoMode: (mode: GizmoMode) => void;
  onChangeGizmoSpace: (space: GizmoSpace) => void;
  onChangeAxisConstraint: (axis: AxisConstraint) => void;
  onToggleSnap: () => void;
  onChangeSelectionFilter: (filter: SelectionFilter) => void;
  onToggleRigOverlay: () => void;
  onAlignMultiSelection: (mode: 'align-x' | 'align-z' | 'distribute-x' | 'ground-y') => void;
  onGroupSelection: () => void;
  onResetEditorCamera: () => void;
  onToggleEditorProjection: () => void;
  onChangeEditorCameraPreset: (preset: EditorCameraPreset) => void;
  onFocusTarget: () => void;
  onFrameAll: () => void;
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
  { value: 'free', label: 'Free Orbit' },
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
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
  multiSelectedCount,
  multiSelectedNodeCount = 0,
  hoverInfo,
  poseModeInstanceId,
  poseModeCharName,
  editorProjection,
  editorCameraPreset,
  onChangeGizmoMode,
  onChangeGizmoSpace,
  onChangeAxisConstraint,
  onToggleSnap,
  onChangeSelectionFilter,
  onToggleRigOverlay,
  onAlignMultiSelection,
  onGroupSelection,
  onResetEditorCamera,
  onToggleEditorProjection,
  onChangeEditorCameraPreset,
  onFocusTarget,
  onFrameAll,
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
  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#121316]" aria-label="3D Viewport">
      {/* Compact Viewport Toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[#2a2e36] bg-[#16181c] px-2.5 text-xs overflow-x-auto">
        <div className="flex items-center gap-1 shrink-0">
          <IconButton
            label="Select Tool"
            note="Pick object or part · Drag outside object to marquee highlight · Double-click character to pose"
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
            note="Orbit camera freely with left-click drag without accidentally moving or highlighting parts"
            shortcut="H"
            active={gizmoMode === 'orbit'}
            onClick={() => onChangeGizmoMode('orbit')}
          >
            <Mouse className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Move Gizmo"
            note="Translate selected object, part, or group in 3D space"
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
            note="Resize selected object, component, or group"
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

          {/* Selection Filter */}
          <select
            aria-label="Viewport selection filter"
            data-studio-note="Filter viewport clicks by object or rig type"
            value={selectionFilter}
            onChange={(e) => onChangeSelectionFilter(e.target.value as SelectionFilter)}
            className="h-6 rounded border border-[#2e333d] bg-[#14161a] px-1.5 text-[11px] text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
          >
            {FILTER_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>

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

          {/* Editor Camera Angle Presets, Persp/Ortho & Focus */}
          <select
            aria-label="Editor camera angle preset"
            data-studio-note="Snap viewport camera to Front, Back, Side, or Top view"
            value={editorCameraPreset}
            onChange={(e) => onChangeEditorCameraPreset(e.target.value as EditorCameraPreset)}
            className="h-6 rounded border border-[#2e333d] bg-[#14161a] px-1.5 text-[11px] text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
          >
            {CAMERA_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

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
          <span>{viewMode === 'scene' ? 'Final Cam' : 'Editor'}</span>
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
          className={`h-full w-full ${
            gizmoMode === 'orbit'
              ? 'cursor-grab'
              : gizmoMode === 'box-select'
                ? 'cursor-crosshair'
                : ''
          }`}
        />

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
        {studioMode === 'beginner' && beginnerTip && !tabHud.open && (
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
