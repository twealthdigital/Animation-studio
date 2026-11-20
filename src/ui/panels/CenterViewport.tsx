import React from 'react';
import {
  AlignCenterHorizontal,
  Bone,
  Camera,
  Crosshair,
  Expand,
  Globe,
  Grid3x3,
  Layers,
  Magnet,
  Maximize2,
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
  { value: 'all', label: 'Filter: All' },
  { value: 'character', label: 'Filter: Characters' },
  { value: 'body-part', label: 'Filter: Body Parts' },
  { value: 'ik-handle', label: 'Filter: IK Handles' },
  { value: 'group', label: 'Filter: Groups' },
  { value: 'prop', label: 'Filter: Props' },
  { value: 'light', label: 'Filter: Lights' },
  { value: 'camera', label: 'Filter: Camera' },
  { value: 'waypoint', label: 'Filter: Path Points' },
];

const CAMERA_PRESETS: { value: EditorCameraPreset; label: string }[] = [
  { value: 'free', label: 'Angle: Free' },
  { value: 'front', label: 'Angle: Front' },
  { value: 'back', label: 'Angle: Back' },
  { value: 'left', label: 'Angle: Left' },
  { value: 'right', label: 'Angle: Right' },
  { value: 'top', label: 'Angle: Top' },
  { value: 'bottom', label: 'Angle: Bottom' },
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
            label="Select Tool (Q)"
            note="Pick objects or double-click a character to pose joints (Q)"
            active={gizmoMode === 'select'}
            onClick={() => onChangeGizmoMode('select')}
          >
            <MousePointer className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Move Gizmo (G)"
            note="Translate selected object in 3D space (G)"
            active={gizmoMode === 'translate'}
            onClick={() => onChangeGizmoMode('translate')}
          >
            <Move className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Rotate Gizmo (R)"
            note="Rotate object or locked child joint around pivot (R)"
            active={gizmoMode === 'rotate'}
            onClick={() => onChangeGizmoMode('rotate')}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Scale Gizmo (S)"
            note="Resize selected object or group (S)"
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
            note="Toggle World vs Character Local rotation/move axes (L)"
            onClick={() => onChangeGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world')}
          >
            <Globe className="h-3 w-3" aria-hidden="true" />
            <span>{gizmoSpace === 'local' ? 'Local' : 'World'}</span>
          </StudioButton>

          {/* Snap Toggle */}
          <IconButton
            label={`Snap (${snapSettings.enabled ? 'On' : 'Off'})`}
            note="Snap position & rotation steps cleanly"
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
                  title={`Constrain gizmo to ${ax.toUpperCase()} axis`}
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
            title="Restrict viewport clicks to a specific item type"
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
              label="Toggle Rig & Joint Links"
              note="Show/hide bone hierarchy links, sockets, axis rings & IK handles"
              active={showRigOverlay}
              onClick={onToggleRigOverlay}
            >
              <Bone className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          )}

          {multiSelectedCount >= 2 && (
            <div className="flex items-center gap-1 ml-1 rounded border border-[#e8702a]/60 bg-[#2a211c] px-1.5 py-0.5">
              <Layers className="h-3 w-3 text-[#e8702a]" aria-hidden="true" />
              <span className="text-[10px] font-semibold text-[#f5b489]">{multiSelectedCount}</span>
              <button
                type="button"
                title="Group Selected Items (Ctrl+G)"
                onClick={onGroupSelection}
                className="rounded bg-[#e8702a] px-1.5 py-0.5 text-[10px] font-semibold text-[#121316] hover:bg-[#f07f3c]"
              >
                Group
              </button>
              <button
                type="button"
                title="Align X"
                onClick={() => onAlignMultiSelection('align-x')}
                className="rounded px-1 text-[10px] text-[#e6e8ec] hover:bg-[#383e49]"
              >
                <AlignCenterHorizontal className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Snap all to Floor Y=0"
                onClick={() => onAlignMultiSelection('ground-y')}
                className="rounded px-1 text-[10px] text-[#e6e8ec] hover:bg-[#383e49]"
              >
                <Grid3x3 className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="mx-1 h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

          {/* Editor Camera Angle Presets, Persp/Ortho & Focus */}
          <select
            aria-label="Editor camera angle preset"
            title="Snap editor camera to Front, Back, Left, Right, Top, or Bottom view"
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
            note="Toggle Editor Perspective vs Orthographic projection"
            onClick={onToggleEditorProjection}
          >
            <Camera className="h-3 w-3" aria-hidden="true" />
            <span>{editorProjection === 'orthographic' ? 'Ortho' : 'Persp'}</span>
          </StudioButton>

          <IconButton
            label="Focus Hovered/Selected (F)"
            note="Zoom smoothly onto hovered part or active selection (F)"
            onClick={onFocusTarget}
          >
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Frame All Stage (Shift+F)"
            note="Frame all characters & props in viewport (Shift+F)"
            onClick={onFrameAll}
          >
            <Expand className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Reset Editor View"
            note="Reset editor orbit camera to default hero view"
            onClick={onResetEditorCamera}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>

          <IconButton
            label="Animation Suggestions (Tab)"
            note="Show context-aware animation prediction HUD (Tab)"
            active={tabHud.open}
            onClick={onToggleTabHud}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[#98a0ad] shrink-0">
          <span className="font-medium text-[#e6e8ec]">{sceneName}</span>
          <span aria-hidden="true">·</span>
          <span>{viewMode === 'scene' ? 'Final Cam' : 'Editor'}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {characterCount} chars{propCount > 0 ? ` · ${propCount} props` : ''}
          </span>
        </div>
      </div>

      {/* Dedicated WebGL Canvas Host */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={mountRef}
          data-testid="viewport-canvas-host"
          className="h-full w-full"
        />

        {/* Pose Mode Floating Banner */}
        {poseModeInstanceId && (
          <div
            data-testid="pose-mode-banner"
            className="pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded border border-[#e8702a] bg-[#1a1512] px-3 py-1.5 text-xs shadow-xl"
          >
            <Bone className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span className="font-semibold text-[#f5b489]">
              Pose Mode{poseModeCharName ? `: ${poseModeCharName}` : ''}
            </span>
            <span className="text-[11px] text-[#cbd5e1]">
              Drag part or rings to rotate · Joints locked
            </span>
            <StudioButton size="xs" variant="primary" onClick={onExitPoseMode}>
              Exit Pose (Esc)
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
            className="pointer-events-none absolute z-20 max-w-[230px] rounded border border-[#3a404c] bg-[#181a1f] px-2.5 py-1.5 shadow-xl"
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
