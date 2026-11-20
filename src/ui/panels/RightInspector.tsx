import { useMemo, useState } from 'react';
import {
  Bone,
  Camera,
  ChevronRight,
  Copy,
  Group,
  Key,
  Layers,
  Lightbulb,
  Link2,
  Lock,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RotateCcw,
  Route,
  Shapes,
  SlidersHorizontal,
  Smile,
  Trash2,
  Ungroup,
  Wand2,
} from 'lucide-react';
import type {
  ActionClip,
  AssetRecord,
  AudioClipData,
  CameraPose,
  CharacterInstanceData,
  EasingType,
  EnvironmentPresetId,
  FacialState,
  IkChainType,
  MotionPathCurveType,
  MotionPathData,
  PanelCollapseState,
  RigNodeInfo,
  SceneCameraItem,
  SceneData,
  SceneGroupData,
  SceneLightData,
  ScenePropData,
  SceneTransitionType,
  SelectionTarget,
  StudioMode,
  Transform3D,
  Vec3,
} from '../../core/types';
import { createDefaultMotionPath } from '../../core/types';
import type { CharacterCapabilities } from '../../characters/CharacterAdapter';
import { buildRigCompatibilityReport } from '../../animation/RigMapper';
import { type AnimationSuggestion } from '../../animation/MotionPresets';
import { reverseMotionPath, updatePointWithHandleSymmetry } from '../../animation/MotionPath';
import {
  type CameraFramingPresetId,
  computeCameraFramingPreset,
  ENVIRONMENT_PRESETS,
} from '../../engine/PropsFactory';
import { DEG_TO_RAD, RAD_TO_DEG } from '../../utils/math';
import {
  CustomSelect,
  IconButton,
  NumericInput,
  StudioButton,
  StudioSlider,
  WaveformCanvas,
} from '../components/Primitives';
import {
  BodyPartInspector,
  FacialAndVoiceSection,
  RigAndIkSection,
  SmartPresetsAndAssistantSection,
} from './RigAndFacialInspector';

export type CharInspectorTab = 'transform' | 'rig' | 'presets' | 'face';

interface RightInspectorProps {
  width: number;
  collapseState: PanelCollapseState;
  onChangeCollapseState: (state: PanelCollapseState) => void;
  activeCharTab: CharInspectorTab;
  onChangeCharTab: (tab: CharInspectorTab) => void;
  studioMode: StudioMode;
  activeScene: SceneData;
  currentTime: number;
  selection: SelectionTarget;
  selectedCharacter: CharacterInstanceData | null;
  selectedCharacterAsset: AssetRecord | null;
  selectedCharacterCaps: CharacterCapabilities | null;
  evaluatedTransform: Transform3D | null;
  evaluatedNodeRotations: Record<string, Vec3>;
  evaluatedFacial: FacialState | null;
  evaluatedCameraPose: CameraPose;
  selectedProp: ScenePropData | null;
  evaluatedPropTransform: Transform3D | null;
  selectedGroup: SceneGroupData | null;
  evaluatedGroupTransform: Transform3D | null;
  selectedLight: SceneLightData | null;
  evaluatedLightIntensity: number | null;
  selectedAudioClip: AudioClipData | null;
  selectedAudioAsset: AssetRecord | null;
  selectedActionClip: ActionClip | null;
  rigNodesByInstance: Record<string, RigNodeInfo[]>;
  onSelectTarget: (target: SelectionTarget) => void;
  onEnterPoseMode: (instanceId: string) => void;
  onUpdateCharacterMeta: (instanceId: string, patch: Partial<CharacterInstanceData>) => void;
  onUpdateCharacterTransform: (instanceId: string, transform: Transform3D) => void;
  onKeyCharacterTransform: (instanceId: string, easing: EasingType) => void;
  onUpdateNodeRotation: (instanceId: string, nodeId: string, nodeName: string, rot: Vec3) => void;
  onKeyNodeRotation: (instanceId: string, nodeId: string, nodeName: string, rot: Vec3, easing: EasingType) => void;
  onResetNodeRotation: (instanceId: string, nodeId: string) => void;
  onToggleNodeLock: (instanceId: string, nodeId: string) => void;
  onToggleNodeVisibility: (instanceId: string, nodeId: string) => void;
  onKeyFacialState: (instanceId: string, state: FacialState) => void;
  onPreviewCharacterAction: (instanceId: string, actionId: string, speed: number) => void;
  onSetCharacterMood: (instanceId: string, mood: string) => void;
  onAddActionClip: (instanceId: string, actionId: string, speed: number) => void;
  onAddPresetClip: (
    instanceId: string,
    presetId: string,
    opts: { startTime: number; duration: number; speed: number; blendIn: number },
  ) => void;
  onExecuteSuggestion: (sug: AnimationSuggestion) => void;
  onToggleMotionPath: (instanceId: string, enabled: boolean) => void;
  onUpdateMotionPathProps: (instanceId: string, patch: Partial<MotionPathData>) => void;
  onAddWaypoint: (instanceId: string) => void;
  onUpdateWaypoint: (
    instanceId: string,
    pointId: string,
    patch: { position?: Vec3; handleIn?: Vec3; handleOut?: Vec3; smooth?: boolean },
  ) => void;
  onDeleteWaypoint: (instanceId: string, pointId: string) => void;
  onOpenDialogueDialog: (instanceId: string) => void;
  onUpdateProp: (propId: string, patch: Partial<ScenePropData>) => void;
  onKeyPropTransform: (propId: string, easing: EasingType) => void;
  onUpdateGroup: (groupId: string, patch: Partial<SceneGroupData>) => void;
  onKeyGroupTransform: (groupId: string, easing: EasingType) => void;
  onDuplicateGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string) => void;
  onUpdateLight: (lightId: string, patch: Partial<SceneLightData>) => void;
  onKeyLightIntensity: (lightId: string) => void;
  onSelectCameraItem: (cameraId: string) => void;
  onAddCameraToScene: (projection: 'perspective' | 'orthographic') => void;
  onUpdateCameraItem: (cameraId: string, patch: Partial<SceneCameraItem>) => void;
  onAddCameraSwitch: (cameraId: string) => void;
  onUpdateCameraPose: (pose: CameraPose) => void;
  onKeyCamera: (easing: EasingType) => void;
  onCaptureEditorCamera: () => void;
  onApplyEnvironmentPreset: (presetId: EnvironmentPresetId) => void;
  onUpdateAudioClip: (clipId: string, patch: Partial<AudioClipData>) => void;
  onPreviewAudioClip: (clip: AudioClipData) => void;
  onDeleteAudioClip: (clipId: string) => void;
  onUpdateActionClip: (instanceId: string, clipId: string, patch: Partial<ActionClip>) => void;
  onDeleteActionClip: (instanceId: string, clipId: string) => void;
  onUpdateSceneProps: (patch: Partial<SceneData>) => void;
}

const EASING_OPTIONS: { value: EasingType; label: string }[] = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'linear', label: 'Linear' },
  { value: 'step', label: 'Step (Hold)' },
  { value: 'easeIn', label: 'Ease In' },
  { value: 'easeOut', label: 'Ease Out' },
  { value: 'easeInOut', label: 'Ease In & Out' },
  { value: 'bezier', label: 'Cubic Bezier' },
];

const CURVE_TYPE_OPTIONS: { value: MotionPathCurveType; label: string }[] = [
  { value: 'cubic', label: 'Cubic Bezier' },
  { value: 'quadratic', label: 'Quadratic Bezier' },
  { value: 'catmullrom', label: 'Catmull-Rom Spline' },
];

const FRAMING_PRESETS: { id: CameraFramingPresetId; label: string }[] = [
  { id: 'wide', label: 'Wide Shot' },
  { id: 'medium', label: 'Medium Shot' },
  { id: 'closeup', label: 'Close-Up' },
  { id: 'extreme-closeup', label: 'Extreme CU' },
  { id: 'ots', label: 'Over Shoulder' },
  { id: 'establishing', label: 'Establishing' },
  { id: 'tracking', label: '3/4 Tracking' },
];

export function RightInspector({
  width,
  collapseState,
  onChangeCollapseState,
  activeCharTab,
  onChangeCharTab,
  studioMode,
  activeScene,
  currentTime,
  selection,
  selectedCharacter,
  selectedCharacterAsset,
  selectedCharacterCaps,
  evaluatedTransform,
  evaluatedNodeRotations,
  evaluatedFacial,
  evaluatedCameraPose,
  selectedProp,
  evaluatedPropTransform,
  selectedGroup,
  evaluatedGroupTransform,
  selectedLight,
  evaluatedLightIntensity,
  selectedAudioClip,
  selectedAudioAsset,
  selectedActionClip,
  rigNodesByInstance,
  onSelectTarget,
  onEnterPoseMode,
  onUpdateCharacterMeta,
  onUpdateCharacterTransform,
  onKeyCharacterTransform,
  onUpdateNodeRotation,
  onKeyNodeRotation,
  onResetNodeRotation,
  onToggleNodeLock,
  onToggleNodeVisibility,
  onKeyFacialState,
  onPreviewCharacterAction,
  onSetCharacterMood,
  onAddActionClip,
  onAddPresetClip,
  onExecuteSuggestion,
  onToggleMotionPath,
  onUpdateMotionPathProps,
  onAddWaypoint,
  onUpdateWaypoint,
  onDeleteWaypoint,
  onOpenDialogueDialog,
  onUpdateProp,
  onKeyPropTransform,
  onUpdateGroup,
  onKeyGroupTransform,
  onDuplicateGroup,
  onUngroupGroup,
  onUpdateLight,
  onKeyLightIntensity,
  onSelectCameraItem,
  onAddCameraToScene,
  onUpdateCameraItem,
  onAddCameraSwitch,
  onUpdateCameraPose,
  onKeyCamera,
  onCaptureEditorCamera,
  onApplyEnvironmentPreset,
  onUpdateAudioClip,
  onPreviewAudioClip,
  onDeleteAudioClip,
  onUpdateActionClip,
  onDeleteActionClip,
  onUpdateSceneProps,
}: RightInspectorProps) {
  const [easing, setEasing] = useState<EasingType>('smooth');
  const [selectedActionId, setSelectedActionId] = useState<string>('');
  const [actionSpeed, setActionSpeed] = useState<number>(1);

  void selectedCharacterAsset;

  const selectedCharRigNodes = useMemo(
    () => (selectedCharacter ? rigNodesByInstance[selectedCharacter.id] ?? [] : []),
    [rigNodesByInstance, selectedCharacter],
  );

  const rigReport = useMemo(() => {
    if (!selectedCharacter) return null;
    return buildRigCompatibilityReport(selectedCharRigNodes, selectedCharacter.boneMap);
  }, [selectedCharacter, selectedCharRigNodes]);

  const renderMotionPathSection = (char: CharacterInstanceData) => {
    const mp = char.motionPath;
    const selectedWpId =
      selection.kind === 'waypoint' && selection.instanceId === char.id
        ? selection.pointId
        : mp.points[0]?.id;
    const selectedWp = mp.points.find((p) => p.id === selectedWpId) ?? null;

    const lookAtOptions: { value: string; label: string }[] = [
      { value: '', label: 'None (Follow Curve)' },
      ...activeScene.characters
        .filter((c) => c.id !== char.id)
        .map((c) => ({ value: c.id, label: `Character: ${c.name}` })),
      ...(activeScene.props ?? []).map((p) => ({ value: p.id, label: `Prop: ${p.name}` })),
    ];

    return (
      <div className="space-y-2.5 border-b border-[#2a2e36] pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
            <Route className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span>Motion Path</span>
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={mp.enabled}
              onChange={(e) => onToggleMotionPath(char.id, e.target.checked)}
              className="accent-[#e8702a]"
            />
            <span>Enable</span>
          </label>
        </div>

        {mp.enabled && (
          <div className="space-y-2">
            <CustomSelect
              label="Curve Type"
              value={mp.curveType ?? 'cubic'}
              options={CURVE_TYPE_OPTIONS}
              onChange={(curveType) => onUpdateMotionPathProps(char.id, { curveType })}
            />

            <div className="grid grid-cols-2 gap-1.5">
              <NumericInput
                label="In"
                min={0}
                value={mp.startTime}
                onChange={(startTime) => onUpdateMotionPathProps(char.id, { startTime })}
              />
              <NumericInput
                label="Dur"
                min={0.2}
                value={mp.duration}
                onChange={(duration) => onUpdateMotionPathProps(char.id, { duration })}
              />
            </div>

            <div className="flex flex-wrap gap-3 text-[11px] text-[#98a0ad]">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={mp.orientAlongPath}
                  onChange={(e) => onUpdateMotionPathProps(char.id, { orientAlongPath: e.target.checked })}
                  className="accent-[#e8702a]"
                />
                <span>Face Forward</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={Boolean(mp.closed)}
                  onChange={(e) => onUpdateMotionPathProps(char.id, { closed: e.target.checked })}
                  className="accent-[#e8702a]"
                />
                <span>Closed Loop</span>
              </label>
            </div>

            {studioMode === 'advanced' && (
              <>
                <StudioSlider
                  label="Turn Banking / Tilt"
                  min={0}
                  max={2}
                  step={0.1}
                  value={mp.banking ?? 0}
                  onChange={(banking) => onUpdateMotionPathProps(char.id, { banking })}
                />
                <CustomSelect
                  label="Look-At Target"
                  value={mp.lookAtTargetId ?? ''}
                  options={lookAtOptions}
                  onChange={(id) => onUpdateMotionPathProps(char.id, { lookAtTargetId: id || null })}
                />
                <StudioSlider
                  label="Manual Scrub Test"
                  min={0}
                  max={1}
                  step={0.02}
                  value={mp.scrubProgress ?? 0}
                  displayValue={mp.scrubProgress != null ? `${Math.round(mp.scrubProgress * 100)}%` : 'Auto'}
                  onChange={(scrubProgress) => onUpdateMotionPathProps(char.id, { scrubProgress })}
                />
                <div className="flex gap-1.5">
                  {mp.scrubProgress != null && (
                    <StudioButton
                      size="xs"
                      onClick={() => onUpdateMotionPathProps(char.id, { scrubProgress: null })}
                    >
                      Clear Scrub
                    </StudioButton>
                  )}
                  <StudioButton
                    size="xs"
                    className="flex-1"
                    onClick={() => onUpdateMotionPathProps(char.id, reverseMotionPath(mp))}
                  >
                    Reverse Path Direction
                  </StudioButton>
                </div>
              </>
            )}

            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-[#98a0ad]">Waypoints ({mp.points.length})</span>
              <StudioButton size="xs" onClick={() => onAddWaypoint(char.id)}>
                <Plus className="h-3 w-3" aria-hidden="true" />
                <span>Add Point</span>
              </StudioButton>
            </div>

            {selectedWp && (
              <div className="space-y-1.5 rounded border border-[#2a2e36] bg-[#15171b] p-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium text-[#e6e8ec]">
                    Point {mp.points.findIndex((p) => p.id === selectedWp.id) + 1}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <label className="flex items-center gap-1 text-[10px] text-[#98a0ad]">
                      <input
                        type="checkbox"
                        checked={selectedWp.smooth}
                        onChange={(e) =>
                          onUpdateWaypoint(char.id, selectedWp.id, { smooth: e.target.checked })
                        }
                        className="accent-[#e8702a]"
                      />
                      <span>Smooth</span>
                    </label>
                    <IconButton
                      label="Delete waypoint"
                      disabled={mp.points.length <= 2}
                      onClick={() => onDeleteWaypoint(char.id, selectedWp.id)}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <NumericInput
                    label="X"
                    value={selectedWp.position.x}
                    onChange={(x) =>
                      onUpdateWaypoint(char.id, selectedWp.id, {
                        position: { ...selectedWp.position, x },
                      })
                    }
                  />
                  <NumericInput
                    label="Y"
                    value={selectedWp.position.y}
                    onChange={(y) =>
                      onUpdateWaypoint(char.id, selectedWp.id, {
                        position: { ...selectedWp.position, y },
                      })
                    }
                  />
                  <NumericInput
                    label="Z"
                    value={selectedWp.position.z}
                    onChange={(z) =>
                      onUpdateWaypoint(char.id, selectedWp.id, {
                        position: { ...selectedWp.position, z },
                      })
                    }
                  />
                </div>
                {studioMode === 'advanced' && (mp.curveType ?? 'cubic') !== 'catmullrom' && (
                  <div className="grid grid-cols-3 gap-1 pt-1">
                    <NumericInput
                      label="Hx"
                      value={selectedWp.handleOut.x}
                      onChange={(hx) => {
                        const updated = updatePointWithHandleSymmetry(selectedWp, 'out', {
                          ...selectedWp.handleOut,
                          x: hx,
                        });
                        onUpdateWaypoint(char.id, selectedWp.id, {
                          handleIn: updated.handleIn,
                          handleOut: updated.handleOut,
                        });
                      }}
                    />
                    <NumericInput
                      label="Hy"
                      value={selectedWp.handleOut.y}
                      onChange={(hy) => {
                        const updated = updatePointWithHandleSymmetry(selectedWp, 'out', {
                          ...selectedWp.handleOut,
                          y: hy,
                        });
                        onUpdateWaypoint(char.id, selectedWp.id, {
                          handleIn: updated.handleIn,
                          handleOut: updated.handleOut,
                        });
                      }}
                    />
                    <NumericInput
                      label="Hz"
                      value={selectedWp.handleOut.z}
                      onChange={(hz) => {
                        const updated = updatePointWithHandleSymmetry(selectedWp, 'out', {
                          ...selectedWp.handleOut,
                          z: hz,
                        });
                        onUpdateWaypoint(char.id, selectedWp.id, {
                          handleIn: updated.handleIn,
                          handleOut: updated.handleOut,
                        });
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderCharacterTransformAndActions = (char: CharacterInstanceData) => {
    const t = evaluatedTransform ?? char.transform;
    const actions = selectedCharacterCaps?.actions ?? [];
    const moods = selectedCharacterCaps?.moods ?? [];
    const activeActId = actions.find((a) => a.id === selectedActionId)?.id ?? actions[0]?.id ?? '';
    const isLocked = Boolean(char.lockedProperties?.transform);

    return (
      <div className="space-y-4">
        {/* Identity */}
        <div className="space-y-2 border-b border-[#2a2e36] pb-3">
          <div className="flex items-end gap-1.5">
            <label className="block flex-1">
              <span className="text-[11px] text-[#98a0ad]">Character Name</span>
              <input
                type="text"
                value={char.name}
                onChange={(e) => onUpdateCharacterMeta(char.id, { name: e.target.value })}
                className="mt-1 h-7 w-full rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs font-medium text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
              />
            </label>
            <IconButton
              label={isLocked ? 'Unlock character transform' : 'Lock character transform'}
              active={isLocked}
              onClick={() =>
                onUpdateCharacterMeta(char.id, {
                  lockedProperties: { ...char.lockedProperties, transform: !isLocked },
                })
              }
            >
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </div>
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-xs text-[#e6e8ec]">
              <input
                type="checkbox"
                checked={char.visible}
                onChange={(e) => onUpdateCharacterMeta(char.id, { visible: e.target.checked })}
                className="accent-[#e8702a]"
              />
              <span>Visible</span>
            </label>
            {selectedCharacterCaps?.importMode === 'native-three-extraction' && (
              <label className="flex items-center gap-2 text-xs text-[#98a0ad]">
                <input
                  type="checkbox"
                  checked={char.includeStageProps}
                  onChange={(e) =>
                    onUpdateCharacterMeta(char.id, { includeStageProps: e.target.checked })
                  }
                  className="accent-[#e8702a]"
                />
                <span>HTML Backdrop</span>
              </label>
            )}
          </div>
        </div>

        {/* Transform & Keyframing */}
        <div className="space-y-2.5 border-b border-[#2a2e36] pb-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[#e6e8ec]">Transform</span>
            <span className="text-[10px] font-medium text-[#e8702a]">
              {char.positionKeyframes.length}P / {char.rotationKeyframes.length}R / {char.scaleKeyframes.length}S
            </span>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-[#98a0ad]">Position</div>
            <div className="grid grid-cols-3 gap-1.5">
              <NumericInput
                label="X"
                disabled={isLocked}
                value={t.position.x}
                onChange={(x) => onUpdateCharacterTransform(char.id, { ...t, position: { ...t.position, x } })}
              />
              <NumericInput
                label="Y"
                disabled={isLocked}
                value={t.position.y}
                onChange={(y) => onUpdateCharacterTransform(char.id, { ...t, position: { ...t.position, y } })}
              />
              <NumericInput
                label="Z"
                disabled={isLocked}
                value={t.position.z}
                onChange={(z) => onUpdateCharacterTransform(char.id, { ...t, position: { ...t.position, z } })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-[#98a0ad]">Rotation (deg)</div>
            <div className="grid grid-cols-3 gap-1.5">
              <NumericInput
                label="X"
                step={5}
                decimals={1}
                disabled={isLocked}
                value={t.rotation.x * RAD_TO_DEG}
                onChange={(x) =>
                  onUpdateCharacterTransform(char.id, { ...t, rotation: { ...t.rotation, x: x * DEG_TO_RAD } })
                }
              />
              <NumericInput
                label="Y"
                step={5}
                decimals={1}
                disabled={isLocked}
                value={t.rotation.y * RAD_TO_DEG}
                onChange={(y) =>
                  onUpdateCharacterTransform(char.id, { ...t, rotation: { ...t.rotation, y: y * DEG_TO_RAD } })
                }
              />
              <NumericInput
                label="Z"
                step={5}
                decimals={1}
                disabled={isLocked}
                value={t.rotation.z * RAD_TO_DEG}
                onChange={(z) =>
                  onUpdateCharacterTransform(char.id, { ...t, rotation: { ...t.rotation, z: z * DEG_TO_RAD } })
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-[#98a0ad]">Scale</div>
            <div className="grid grid-cols-3 gap-1.5">
              <NumericInput
                label="X"
                min={0.1}
                max={10}
                disabled={isLocked}
                value={t.scale.x}
                onChange={(x) => onUpdateCharacterTransform(char.id, { ...t, scale: { ...t.scale, x } })}
              />
              <NumericInput
                label="Y"
                min={0.1}
                max={10}
                disabled={isLocked}
                value={t.scale.y}
                onChange={(y) => onUpdateCharacterTransform(char.id, { ...t, scale: { ...t.scale, y } })}
              />
              <NumericInput
                label="Z"
                min={0.1}
                max={10}
                disabled={isLocked}
                value={t.scale.z}
                onChange={(z) => onUpdateCharacterTransform(char.id, { ...t, scale: { ...t.scale, z } })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <CustomSelect
              ariaLabel="Keyframe Easing"
              value={easing}
              options={EASING_OPTIONS}
              onChange={setEasing}
            />
            <StudioButton variant="primary" onClick={() => onKeyCharacterTransform(char.id, easing)}>
              <Key className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Key @ {currentTime.toFixed(1)}s</span>
            </StudioButton>
          </div>
        </div>

        {/* Native Character Actions & Moods */}
        <div className="space-y-2.5 border-b border-[#2a2e36] pb-3">
          <div className="font-semibold text-[#e6e8ec]">Actions &amp; Moods</div>
          {moods.length > 0 && (
            <CustomSelect
              label="Mood"
              value={char.currentMood}
              options={moods.map((m) => ({
                value: m,
                label: m.charAt(0).toUpperCase() + m.slice(1),
              }))}
              onChange={(m) => onSetCharacterMood(char.id, m)}
            />
          )}

          {actions.length > 0 ? (
            <div className="space-y-2">
              <CustomSelect
                label="Action"
                value={activeActId}
                options={actions.map((a) => ({ value: a.id, label: `${a.label} (${a.kind})` }))}
                onChange={setSelectedActionId}
              />
              <div className="grid grid-cols-2 gap-1.5">
                <NumericInput label="Spd" min={0.25} max={3} step={0.1} value={actionSpeed} onChange={setActionSpeed} />
                <StudioButton note="Preview native character action" onClick={() => onPreviewCharacterAction(char.id, activeActId, actionSpeed)}>
                  <Play className="h-3 w-3" aria-hidden="true" />
                  <span>Preview</span>
                </StudioButton>
              </div>
              <StudioButton
                className="w-full"
                note="Place this action clip on timeline at current playhead"
                onClick={() => onAddActionClip(char.id, activeActId, actionSpeed)}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Add Clip @ {currentTime.toFixed(1)}s</span>
              </StudioButton>
            </div>
          ) : (
            <p className="text-[11px] text-[#6b7280]">
              No native scripts. Use Pose Joints or Presets.
            </p>
          )}
        </div>

        {renderMotionPathSection(char)}

        {/* Structure & Materials Summary */}
        {selectedCharRigNodes.length > 0 && (
          <div className="space-y-1.5 border-t border-[#2a2e36] pt-2.5 text-[11px]">
            <div className="flex items-center justify-between font-semibold text-[#e6e8ec]">
              <span>Structure</span>
              <span className="font-mono-code text-[10px] text-[#98a0ad]">
                {selectedCharRigNodes.filter((n) => !n.isAuxiliary).length} joints · {rigReport?.rigKind ?? 'rig'}
              </span>
            </div>
            <StudioButton
              size="xs"
              className="w-full"
              note="Enter Pose Mode to drag & rotate joints directly without detaching"
              shortcut="Dbl-Click"
              onClick={() => onEnterPoseMode(char.id)}
            >
              <Bone className="h-3 w-3" aria-hidden="true" />
              <span>Pose Joints</span>
            </StudioButton>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {Array.from(
                new Set(selectedCharRigNodes.flatMap((n) => n.materials ?? [])),
              )
                .slice(0, 8)
                .map((mat, idx) => (
                  <span
                    key={idx}
                    className="rounded border border-[#2a2e36] bg-[#14161a] px-1.5 py-0.5 font-mono-code text-[10px] text-[#cbd5e1]"
                  >
                    {mat}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderCharacterInspector = (char: CharacterInstanceData) => {
    if (studioMode === 'beginner') {
      return (
        <div className="space-y-4">
          {renderCharacterTransformAndActions(char)}
          <div className="border-t border-[#2a2e36] pt-3">
            <SmartPresetsAndAssistantSection
              char={char}
              scene={activeScene}
              currentTime={currentTime}
              rigReport={rigReport}
              onAddPresetClip={onAddPresetClip}
              onExecuteSuggestion={onExecuteSuggestion}
            />
          </div>
          <div className="border-t border-[#2a2e36] pt-3">
            <FacialAndVoiceSection
              char={char}
              currentTime={currentTime}
              evaluatedFacial={evaluatedFacial!}
              onUpdateCharacterMeta={onUpdateCharacterMeta}
              onKeyFacialState={onKeyFacialState}
              onOpenDialogueDialog={onOpenDialogueDialog}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-1 rounded border border-[#2a2e36] bg-[#14161a] p-1">
          {(
            [
              ['transform', 'Pose'],
              ['rig', 'Rig/IK'],
              ['presets', 'AI/Move'],
              ['face', 'Face/Mic'],
            ] as [CharInspectorTab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onChangeCharTab(id)}
              className={`rounded py-1 text-[10px] font-medium transition-colors ${
                activeCharTab === id
                  ? 'bg-[#e8702a] text-[#121316] font-semibold'
                  : 'text-[#98a0ad] hover:text-[#e6e8ec]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeCharTab === 'transform' && renderCharacterTransformAndActions(char)}
        {activeCharTab === 'rig' && (
          <RigAndIkSection
            char={char}
            currentTime={currentTime}
            rigNodes={selectedCharRigNodes}
            rigReport={rigReport}
            evaluatedNodeRotations={evaluatedNodeRotations}
            onSelectNode={(nodeId, nodeName) =>
              onSelectTarget({ kind: 'body-part', instanceId: char.id, nodeId, nodeName })
            }
            onUpdateCharacterMeta={onUpdateCharacterMeta}
            onKeyNodeRotation={onKeyNodeRotation}
            onApplyPresetToTimeline={(instId, presetId) =>
              onAddPresetClip(instId, presetId, { startTime: currentTime, duration: 2, speed: 1, blendIn: 0.2 })
            }
            onExecuteSuggestion={onExecuteSuggestion}
            scene={activeScene}
          />
        )}
        {activeCharTab === 'presets' && (
          <SmartPresetsAndAssistantSection
            char={char}
            scene={activeScene}
            currentTime={currentTime}
            rigReport={rigReport}
            onAddPresetClip={onAddPresetClip}
            onExecuteSuggestion={onExecuteSuggestion}
          />
        )}
        {activeCharTab === 'face' && (
          <FacialAndVoiceSection
            char={char}
            currentTime={currentTime}
            evaluatedFacial={evaluatedFacial!}
            onUpdateCharacterMeta={onUpdateCharacterMeta}
            onKeyFacialState={onKeyFacialState}
            onOpenDialogueDialog={onOpenDialogueDialog}
          />
        )}
      </div>
    );
  };

  const renderIkHandleInspector = (instanceId: string, chain: IkChainType) => {
    const char = activeScene.characters.find((c) => c.id === instanceId);
    if (!char) return renderSceneInspector();
    const ik = char.ikTargets?.find((i) => i.chain === chain);
    if (!ik) return renderSceneInspector();

    const updateIk = (patch: Partial<typeof ik>) => {
      onUpdateCharacterMeta(char.id, {
        ikTargets: (char.ikTargets ?? []).map((item) =>
          item.chain === chain ? { ...item, ...patch } : item,
        ),
      });
    };

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
          <div>
            <div className="text-[10px] text-[#98a0ad]">{char.name} · IK Handle</div>
            <div className="font-semibold text-[#e6e8ec]">{chain}</div>
          </div>
          <StudioButton size="xs" onClick={() => onSelectTarget({ kind: 'character', instanceId: char.id })}>
            Character
          </StudioButton>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <NumericInput
            label="X"
            value={ik.target.x}
            onChange={(x) => updateIk({ target: { ...ik.target, x } })}
          />
          <NumericInput
            label="Y"
            value={ik.target.y}
            onChange={(y) => updateIk({ target: { ...ik.target, y } })}
          />
          <NumericInput
            label="Z"
            value={ik.target.z}
            onChange={(z) => updateIk({ target: { ...ik.target, z } })}
          />
        </div>
        <StudioSlider
          label="IK Weight"
          min={0}
          max={1}
          step={0.05}
          value={ik.weight}
          displayValue={`${Math.round(ik.weight * 100)}%`}
          onChange={(weight) => updateIk({ weight })}
        />
        <StudioButton
          variant="danger"
          className="w-full"
          onClick={() => updateIk({ enabled: false })}
        >
          Disable {chain} IK
        </StudioButton>
      </div>
    );
  };

  const renderPropInspector = (prop: ScenePropData) => {
    const t = evaluatedPropTransform ?? prop.transform;
    const attachTargetChar = activeScene.characters.find((c) => c.id === prop.parentAttachment?.targetId);
    const attachNodes = attachTargetChar ? rigNodesByInstance[attachTargetChar.id] ?? [] : [];

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
          <span className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
            <Shapes className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span>Prop: {prop.name}</span>
          </span>
        </div>

        <label className="block">
          <span className="text-[11px] text-[#98a0ad]">Prop Name</span>
          <input
            type="text"
            value={prop.name}
            onChange={(e) => onUpdateProp(prop.id, { name: e.target.value })}
            className="mt-1 h-7 w-full rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs text-[#e6e8ec]"
          />
        </label>

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={prop.visible}
              onChange={(e) => onUpdateProp(prop.id, { visible: e.target.checked })}
              className="accent-[#e8702a]"
            />
            <span>Visible</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-[#98a0ad]">Color</span>
            <input
              type="color"
              value={prop.color}
              onChange={(e) => onUpdateProp(prop.id, { color: e.target.value })}
              className="h-6 w-12 rounded border border-[#2e333d] bg-[#14161a]"
            />
          </label>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] text-[#98a0ad]">Position</div>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              value={t.position.x}
              onChange={(x) => onUpdateProp(prop.id, { transform: { ...t, position: { ...t.position, x } } })}
            />
            <NumericInput
              label="Y"
              value={t.position.y}
              onChange={(y) => onUpdateProp(prop.id, { transform: { ...t, position: { ...t.position, y } } })}
            />
            <NumericInput
              label="Z"
              value={t.position.z}
              onChange={(z) => onUpdateProp(prop.id, { transform: { ...t, position: { ...t.position, z } } })}
            />
          </div>
          <div className="text-[11px] text-[#98a0ad] pt-1">Rotation (deg)</div>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              step={5}
              decimals={1}
              value={t.rotation.x * RAD_TO_DEG}
              onChange={(x) =>
                onUpdateProp(prop.id, { transform: { ...t, rotation: { ...t.rotation, x: x * DEG_TO_RAD } } })
              }
            />
            <NumericInput
              label="Y"
              step={5}
              decimals={1}
              value={t.rotation.y * RAD_TO_DEG}
              onChange={(y) =>
                onUpdateProp(prop.id, { transform: { ...t, rotation: { ...t.rotation, y: y * DEG_TO_RAD } } })
              }
            />
            <NumericInput
              label="Z"
              step={5}
              decimals={1}
              value={t.rotation.z * RAD_TO_DEG}
              onChange={(z) =>
                onUpdateProp(prop.id, { transform: { ...t, rotation: { ...t.rotation, z: z * DEG_TO_RAD } } })
              }
            />
          </div>
          <div className="text-[11px] text-[#98a0ad] pt-1">Scale</div>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              min={0.1}
              value={t.scale.x}
              onChange={(x) => onUpdateProp(prop.id, { transform: { ...t, scale: { ...t.scale, x } } })}
            />
            <NumericInput
              label="Y"
              min={0.1}
              value={t.scale.y}
              onChange={(y) => onUpdateProp(prop.id, { transform: { ...t, scale: { ...t.scale, y } } })}
            />
            <NumericInput
              label="Z"
              min={0.1}
              value={t.scale.z}
              onChange={(z) => onUpdateProp(prop.id, { transform: { ...t, scale: { ...t.scale, z } } })}
            />
          </div>
        </div>

        <StudioButton variant="primary" className="w-full" onClick={() => onKeyPropTransform(prop.id, easing)}>
          <Key className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Key Prop @ {currentTime.toFixed(1)}s</span>
        </StudioButton>

        {/* Parent-Child Bone / Character Attachment */}
        <div className="space-y-2 border-t border-[#2a2e36] pt-3">
          <div className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
            <Link2 className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span>Parent / Hand Attachment</span>
          </div>
          <CustomSelect
            label="Attach To"
            value={prop.parentAttachment?.targetId ?? ''}
            options={[
              { value: '', label: 'None (World Stage)' },
              ...activeScene.characters.map((c) => ({ value: c.id, label: `Character: ${c.name}` })),
            ]}
            onChange={(targetId) => {
              if (!targetId) {
                onUpdateProp(prop.id, { parentAttachment: null });
              } else {
                onUpdateProp(prop.id, {
                  parentAttachment: {
                    targetId,
                    nodeId: '',
                    offset: { x: 0, y: 0.2, z: 0.3 },
                    rotationOffset: { x: 0, y: 0, z: 0 },
                  },
                });
              }
            }}
          />
          {prop.parentAttachment && attachNodes.length > 0 && (
            <>
              <CustomSelect
                label="Attach to Bone / Part"
                value={prop.parentAttachment.nodeId ?? ''}
                options={[
                  { value: '', label: 'Character Root' },
                  ...attachNodes.map((n) => ({ value: n.nodeId, label: n.name })),
                ]}
                onChange={(nodeId) =>
                  onUpdateProp(prop.id, {
                    parentAttachment: { ...prop.parentAttachment!, nodeId },
                  })
                }
              />
              <div className="grid grid-cols-3 gap-1">
                <NumericInput
                  label="Ox"
                  value={prop.parentAttachment.offset.x}
                  onChange={(x) =>
                    onUpdateProp(prop.id, {
                      parentAttachment: {
                        ...prop.parentAttachment!,
                        offset: { ...prop.parentAttachment!.offset, x },
                      },
                    })
                  }
                />
                <NumericInput
                  label="Oy"
                  value={prop.parentAttachment.offset.y}
                  onChange={(y) =>
                    onUpdateProp(prop.id, {
                      parentAttachment: {
                        ...prop.parentAttachment!,
                        offset: { ...prop.parentAttachment!.offset, y },
                      },
                    })
                  }
                />
                <NumericInput
                  label="Oz"
                  value={prop.parentAttachment.offset.z}
                  onChange={(z) =>
                    onUpdateProp(prop.id, {
                      parentAttachment: {
                        ...prop.parentAttachment!,
                        offset: { ...prop.parentAttachment!.offset, z },
                      },
                    })
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderLightInspector = (light: SceneLightData) => (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
        <span className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
          <Lightbulb className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
          <span>{light.name}</span>
        </span>
        <span className="text-[10px] uppercase text-[#98a0ad]">{light.kind}</span>
      </div>

      <label className="flex items-center justify-between text-xs">
        <span className="text-[#98a0ad]">Light Color</span>
        <input
          type="color"
          value={light.color}
          onChange={(e) => onUpdateLight(light.id, { color: e.target.value })}
          className="h-7 w-14 rounded border border-[#2e333d] bg-[#14161a]"
        />
      </label>

      <StudioSlider
        label="Intensity"
        min={0}
        max={5}
        step={0.05}
        value={evaluatedLightIntensity ?? light.intensity}
        onChange={(intensity) => onUpdateLight(light.id, { intensity })}
      />

      <StudioButton size="xs" variant="primary" className="w-full" onClick={() => onKeyLightIntensity(light.id)}>
        <Key className="h-3 w-3" aria-hidden="true" />
        <span>Key Intensity @ {currentTime.toFixed(1)}s</span>
      </StudioButton>

      {light.kind !== 'ambient' && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              value={light.position.x}
              onChange={(x) => onUpdateLight(light.id, { position: { ...light.position, x } })}
            />
            <NumericInput
              label="Y"
              value={light.position.y}
              onChange={(y) => onUpdateLight(light.id, { position: { ...light.position, y } })}
            />
            <NumericInput
              label="Z"
              value={light.position.z}
              onChange={(z) => onUpdateLight(light.id, { position: { ...light.position, z } })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={light.castShadow}
              onChange={(e) => onUpdateLight(light.id, { castShadow: e.target.checked })}
              className="accent-[#e8702a]"
            />
            <span>Cast Shadows</span>
          </label>
        </>
      )}
    </div>
  );

  const renderCameraInspector = () => {
    const cams = activeScene.cameras ?? [];
    const activeCamObj =
      cams.find((c) => c.id === (activeScene.activeCameraId ?? cams[0]?.id)) ?? cams[0];
    const subjectPos = selectedCharacter?.transform.position ?? activeScene.characters[0]?.transform.position;

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
          <span className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
            <Camera className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span>Scene Cameras</span>
          </span>
          <span className="text-[10px] text-[#98a0ad]">
            {activeScene.camera.keyframes.length} keys
          </span>
        </div>

        {cams.length > 0 && (
          <div className="space-y-1.5">
            <CustomSelect
              label="Active Camera"
              value={activeCamObj?.id ?? cams[0].id}
              options={cams.map((c) => ({ value: c.id, label: `${c.name} (${c.projection})` }))}
              onChange={onSelectCameraItem}
            />
            <div className="grid grid-cols-2 gap-1.5">
              <StudioButton size="xs" onClick={() => onAddCameraToScene('perspective')}>
                + Persp Cam
              </StudioButton>
              <StudioButton size="xs" onClick={() => onAddCameraToScene('orthographic')}>
                + Ortho Cam
              </StudioButton>
            </div>
            {activeCamObj && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-[#98a0ad]">Projection</span>
                <StudioButton
                  size="xs"
                  onClick={() =>
                    onUpdateCameraItem(activeCamObj.id, {
                      projection: activeCamObj.projection === 'perspective' ? 'orthographic' : 'perspective',
                    })
                  }
                >
                  {activeCamObj.projection === 'perspective' ? 'Perspective' : 'Orthographic'}
                </StudioButton>
              </div>
            )}
          </div>
        )}

        {/* 7 Cinematic Framing Presets */}
        <div className="space-y-1.5 border-t border-[#2a2e36] pt-3">
          <div className="text-[11px] font-medium text-[#98a0ad]">Cinematic Framing Presets</div>
          <div className="grid grid-cols-2 gap-1">
            {FRAMING_PRESETS.map((fp) => (
              <StudioButton
                key={fp.id}
                size="xs"
                onClick={() => onUpdateCameraPose(computeCameraFramingPreset(fp.id, subjectPos))}
              >
                {fp.label}
              </StudioButton>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] text-[#98a0ad]">Position</div>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              value={evaluatedCameraPose.position.x}
              onChange={(x) =>
                onUpdateCameraPose({
                  ...evaluatedCameraPose,
                  position: { ...evaluatedCameraPose.position, x },
                })
              }
            />
            <NumericInput
              label="Y"
              value={evaluatedCameraPose.position.y}
              onChange={(y) =>
                onUpdateCameraPose({
                  ...evaluatedCameraPose,
                  position: { ...evaluatedCameraPose.position, y },
                })
              }
            />
            <NumericInput
              label="Z"
              value={evaluatedCameraPose.position.z}
              onChange={(z) =>
                onUpdateCameraPose({
                  ...evaluatedCameraPose,
                  position: { ...evaluatedCameraPose.position, z },
                })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] text-[#98a0ad]">Look Target</div>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              value={evaluatedCameraPose.target.x}
              onChange={(x) =>
                onUpdateCameraPose({
                  ...evaluatedCameraPose,
                  target: { ...evaluatedCameraPose.target, x },
                })
              }
            />
            <NumericInput
              label="Y"
              value={evaluatedCameraPose.target.y}
              onChange={(y) =>
                onUpdateCameraPose({
                  ...evaluatedCameraPose,
                  target: { ...evaluatedCameraPose.target, y },
                })
              }
            />
            <NumericInput
              label="Z"
              value={evaluatedCameraPose.target.z}
              onChange={(z) =>
                onUpdateCameraPose({
                  ...evaluatedCameraPose,
                  target: { ...evaluatedCameraPose.target, z },
                })
              }
            />
          </div>
        </div>

        {activeCamObj?.projection === 'orthographic' ? (
          <StudioSlider
            label="Orthographic Zoom Size"
            min={2}
            max={20}
            step={0.5}
            value={activeCamObj.orthoSize ?? 6}
            onChange={(orthoSize) => onUpdateCameraItem(activeCamObj.id, { orthoSize })}
          />
        ) : (
          <StudioSlider
            label="Field of View"
            min={20}
            max={90}
            step={1}
            value={evaluatedCameraPose.fov}
            displayValue={`${Math.round(evaluatedCameraPose.fov)}°`}
            onChange={(fov) => onUpdateCameraPose({ ...evaluatedCameraPose, fov })}
          />
        )}

        <StudioButton className="w-full" onClick={onCaptureEditorCamera}>
          Match Current Editor View
        </StudioButton>

        {activeCamObj && (
          <StudioButton
            className="w-full"
            onClick={() => onAddCameraSwitch(activeCamObj.id)}
          >
            Cut to {activeCamObj.name} @ {currentTime.toFixed(1)}s
          </StudioButton>
        )}

        <div className="grid grid-cols-2 gap-2">
          <CustomSelect ariaLabel="Camera Easing" value={easing} options={EASING_OPTIONS} onChange={setEasing} />
          <StudioButton variant="primary" onClick={() => onKeyCamera(easing)}>
            <Key className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Key Camera</span>
          </StudioButton>
        </div>

        {activeCamObj && (
          <label className="flex items-center gap-2 text-xs text-[#98a0ad]">
            <input
              type="checkbox"
              checked={Boolean(activeCamObj.motionPath?.enabled)}
              onChange={(e) => {
                const mp = activeCamObj.motionPath ?? createDefaultMotionPath();
                onUpdateCameraItem(activeCamObj.id, {
                  motionPath: { ...mp, enabled: e.target.checked },
                });
              }}
              className="accent-[#e8702a]"
            />
            <span>Move Camera along Orbit Curve Path</span>
          </label>
        )}
      </div>
    );
  };

  const renderAudioInspector = (clip: AudioClipData) => (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
        <span className="truncate font-semibold text-[#e6e8ec]">{clip.name}</span>
        <IconButton label="Delete audio clip" onClick={() => onDeleteAudioClip(clip.id)}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      <WaveformCanvas peaks={selectedAudioAsset?.waveformPeaks} />
      {clip.dialogueText && (
        <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2 text-[11px] text-[#98a0ad]">
          “{clip.dialogueText}”
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumericInput label="In" min={0} value={clip.startTime} onChange={(startTime) => onUpdateAudioClip(clip.id, { startTime })} />
        <NumericInput label="Dur" min={0.1} value={clip.duration} onChange={(duration) => onUpdateAudioClip(clip.id, { duration })} />
        <NumericInput label="Trim" min={0} value={clip.trimStart} onChange={(trimStart) => onUpdateAudioClip(clip.id, { trimStart })} />
        <NumericInput label="Speed" min={0.5} max={2} step={0.05} value={clip.playbackRate ?? 1} onChange={(playbackRate) => onUpdateAudioClip(clip.id, { playbackRate })} />
        <NumericInput label="F-In" min={0} value={clip.fadeIn} onChange={(fadeIn) => onUpdateAudioClip(clip.id, { fadeIn })} />
        <NumericInput label="F-Out" min={0} value={clip.fadeOut} onChange={(fadeOut) => onUpdateAudioClip(clip.id, { fadeOut })} />
      </div>
      <StudioSlider
        label="Clip Volume"
        min={0}
        max={2}
        step={0.05}
        value={clip.volume}
        displayValue={`${Math.round(clip.volume * 100)}%`}
        onChange={(volume) => onUpdateAudioClip(clip.id, { volume })}
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-[#e6e8ec]">
          <input
            type="checkbox"
            checked={clip.muted}
            onChange={(e) => onUpdateAudioClip(clip.id, { muted: e.target.checked })}
            className="accent-[#e8702a]"
          />
          <span>Mute clip</span>
        </label>
        <StudioButton size="xs" onClick={() => onPreviewAudioClip(clip)}>
          <Play className="h-3 w-3" aria-hidden="true" />
          <span>Preview Audio</span>
        </StudioButton>
      </div>
    </div>
  );

  const renderActionClipInspector = (instanceId: string, clip: ActionClip) => (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
        <span className="font-semibold text-[#e6e8ec]">Action: {clip.label}</span>
        <IconButton label="Delete action clip" onClick={() => onDeleteActionClip(instanceId, clip.id)}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumericInput label="In" min={0} value={clip.startTime} onChange={(startTime) => onUpdateActionClip(instanceId, clip.id, { startTime })} />
        <NumericInput label="Dur" min={0.2} value={clip.duration} onChange={(duration) => onUpdateActionClip(instanceId, clip.id, { duration })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumericInput label="Spd" min={0.25} max={3} step={0.1} value={clip.speed} onChange={(speed) => onUpdateActionClip(instanceId, clip.id, { speed })} />
        <NumericInput label="Fade" min={0.05} max={1.5} step={0.05} value={clip.blendIn ?? 0.2} onChange={(blendIn) => onUpdateActionClip(instanceId, clip.id, { blendIn, blendOut: blendIn })} />
      </div>
    </div>
  );

  const renderSceneInspector = () => (
    <div className="space-y-4">
      <div className="border-b border-[#2a2e36] pb-2 font-semibold text-[#e6e8ec]">
        Scene Settings &amp; Environment
      </div>
      <label className="block">
        <span className="text-[11px] text-[#98a0ad]">Scene Name</span>
        <input
          type="text"
          value={activeScene.name}
          onChange={(e) => onUpdateSceneProps({ name: e.target.value })}
          className="mt-1 h-7 w-full rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs text-[#e6e8ec]"
        />
      </label>
      <NumericInput
        label="Dur"
        min={1}
        max={600}
        step={1}
        decimals={1}
        value={activeScene.duration}
        onChange={(duration) => onUpdateSceneProps({ duration })}
      />
      <CustomSelect
        label="Environment Lighting Preset"
        value={activeScene.environmentPreset ?? 'studio-dark'}
        options={ENVIRONMENT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(id) => onApplyEnvironmentPreset(id as EnvironmentPresetId)}
      />
      <label className="flex items-center justify-between text-xs">
        <span className="text-[#98a0ad]">Backdrop Color</span>
        <input
          type="color"
          value={activeScene.backgroundColor}
          onChange={(e) => onUpdateSceneProps({ backgroundColor: e.target.value })}
          className="h-7 w-14 cursor-pointer rounded border border-[#2e333d] bg-[#14161a] p-0.5"
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-[#e6e8ec]">
        <input
          type="checkbox"
          checked={activeScene.showGrid}
          onChange={(e) => onUpdateSceneProps({ showGrid: e.target.checked })}
          className="accent-[#e8702a]"
        />
        <span>Show studio floor grid</span>
      </label>
      <CustomSelect
        label="Scene Transition"
        value={activeScene.transition}
        options={[
          { value: 'cut', label: 'Cut (Instant)' },
          { value: 'fade', label: 'Fade to Black' },
        ]}
        onChange={(transition) => onUpdateSceneProps({ transition: transition as SceneTransitionType })}
      />
    </div>
  );

  const renderGroupInspector = (grp: SceneGroupData) => {
    const t = evaluatedGroupTransform ?? grp.transform;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-1 border-b border-[#2a2e36] pb-2">
          <span className="flex min-w-0 items-center gap-1.5 font-semibold text-[#e6e8ec]">
            <Group className="h-3.5 w-3.5 shrink-0 text-[#e8702a]" aria-hidden="true" />
            <span className="truncate">{grp.name}</span>
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <IconButton
              label="Duplicate Group"
              note="Clone group & all members"
              shortcut="Ctrl+D"
              onClick={() => onDuplicateGroup(grp.id)}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
            <StudioButton
              size="xs"
              note="Ungroup members keeping world positions"
              shortcut="Ctrl+Shift+G"
              onClick={() => onUngroupGroup(grp.id)}
            >
              <Ungroup className="h-3 w-3" aria-hidden="true" />
              <span>Ungroup</span>
            </StudioButton>
          </div>
        </div>

        <label className="block">
          <span className="text-[11px] text-[#98a0ad]">Group Name</span>
          <input
            type="text"
            value={grp.name}
            onChange={(e) => onUpdateGroup(grp.id, { name: e.target.value })}
            className="mt-1 h-7 w-full rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs text-[#e6e8ec]"
          />
        </label>

        <div className="flex items-center justify-between text-xs">
          <label className="flex items-center gap-2 text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={grp.visible}
              onChange={(e) => onUpdateGroup(grp.id, { visible: e.target.checked })}
              className="accent-[#e8702a]"
            />
            <span>Visible</span>
          </label>
          <label className="flex items-center gap-2 text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={grp.locked}
              onChange={(e) => onUpdateGroup(grp.id, { locked: e.target.checked })}
              className="accent-[#e8702a]"
            />
            <span>Locked</span>
          </label>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] text-[#98a0ad]">Group Transform</div>
          <div className="grid grid-cols-3 gap-1.5">
            <NumericInput
              label="X"
              disabled={grp.locked}
              value={t.position.x}
              onChange={(x) => onUpdateGroup(grp.id, { transform: { ...t, position: { ...t.position, x } } })}
            />
            <NumericInput
              label="Y"
              disabled={grp.locked}
              value={t.position.y}
              onChange={(y) => onUpdateGroup(grp.id, { transform: { ...t, position: { ...t.position, y } } })}
            />
            <NumericInput
              label="Z"
              disabled={grp.locked}
              value={t.position.z}
              onChange={(z) => onUpdateGroup(grp.id, { transform: { ...t, position: { ...t.position, z } } })}
            />
          </div>
          <div className="grid grid-cols-3 gap-1.5 pt-1">
            <NumericInput
              label="Rx"
              step={5}
              decimals={1}
              disabled={grp.locked}
              value={t.rotation.x * RAD_TO_DEG}
              onChange={(x) =>
                onUpdateGroup(grp.id, { transform: { ...t, rotation: { ...t.rotation, x: x * DEG_TO_RAD } } })
              }
            />
            <NumericInput
              label="Ry"
              step={5}
              decimals={1}
              disabled={grp.locked}
              value={t.rotation.y * RAD_TO_DEG}
              onChange={(y) =>
                onUpdateGroup(grp.id, { transform: { ...t, rotation: { ...t.rotation, y: y * DEG_TO_RAD } } })
              }
            />
            <NumericInput
              label="Rz"
              step={5}
              decimals={1}
              disabled={grp.locked}
              value={t.rotation.z * RAD_TO_DEG}
              onChange={(z) =>
                onUpdateGroup(grp.id, { transform: { ...t, rotation: { ...t.rotation, z: z * DEG_TO_RAD } } })
              }
            />
          </div>
        </div>

        <StudioButton variant="primary" className="w-full" onClick={() => onKeyGroupTransform(grp.id, easing)}>
          <Key className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Key Group @ {currentTime.toFixed(1)}s</span>
        </StudioButton>

        <div className="space-y-1 border-t border-[#2a2e36] pt-2.5">
          <div className="text-[11px] font-medium text-[#98a0ad]">Members ({grp.memberIds.length})</div>
          <div className="space-y-1">
            {grp.memberIds.map((mId) => {
              const ch = activeScene.characters.find((c) => c.id === mId);
              const pr = activeScene.props?.find((p) => p.id === mId);
              if (!ch && !pr) return null;
              return (
                <button
                  key={mId}
                  type="button"
                  onClick={() =>
                    ch
                      ? onSelectTarget({ kind: 'character', instanceId: ch.id })
                      : onSelectTarget({ kind: 'prop', propId: pr!.id })
                  }
                  className="flex w-full items-center justify-between rounded border border-[#2a2e36] bg-[#14161a] px-2 py-1 text-left text-[11px] text-[#e6e8ec] hover:border-[#e8702a]"
                >
                  <span className="truncate">{ch ? ch.name : pr!.name}</span>
                  <span className="text-[10px] text-[#6b7280]">{ch ? 'Char' : 'Prop'}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  if (collapseState === 'collapsed') {
    return (
      <aside
        className="flex w-6 shrink-0 flex-col items-center border-l border-[#2a2e36] bg-[#191b1f] py-2"
        aria-label="Collapsed Property Inspector"
      >
        <IconButton
          label="Expand Right Inspector"
          note="Restore Property Inspector"
          onClick={() => onChangeCollapseState('expanded')}
        >
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </aside>
    );
  }

  if (collapseState === 'compact') {
    return (
      <aside
        className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-l border-[#2a2e36] bg-[#191b1f] py-2"
        aria-label="Compact Inspector Rail"
      >
        <IconButton
          label="Expand Inspector"
          note="Expand Property Inspector"
          onClick={() => onChangeCollapseState('expanded')}
        >
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <div className="h-px w-6 bg-[#2a2e36]" />
        <IconButton
          label="Pose & Transform"
          note="Open Pose & Transform properties"
          active={activeCharTab === 'transform'}
          onClick={() => {
            onChangeCharTab('transform');
            onChangeCollapseState('expanded');
          }}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Rig & IK"
          note="Open Rigging & IK controls"
          active={activeCharTab === 'rig'}
          onClick={() => {
            onChangeCharTab('rig');
            onChangeCollapseState('expanded');
          }}
        >
          <Bone className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Motion Presets"
          note="Open Motion Presets & Assistant"
          active={activeCharTab === 'presets'}
          onClick={() => {
            onChangeCharTab('presets');
            onChangeCollapseState('expanded');
          }}
        >
          <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Face & Voice"
          note="Open Facial Expressions & Dialogue"
          active={activeCharTab === 'face'}
          onClick={() => {
            onChangeCharTab('face');
            onChangeCollapseState('expanded');
          }}
        >
          <Smile className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <div className="mt-auto">
          <IconButton
            label="Collapse Inspector"
            note="Minimize Inspector completely"
            onClick={() => onChangeCollapseState('collapsed')}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>
      </aside>
    );
  }

  let body: React.ReactNode;
  if (selection.kind === 'body-part' && selectedCharacter) {
    const nodeInfo = selectedCharRigNodes.find((n) => n.nodeId === selection.nodeId);
    body = (
      <BodyPartInspector
        char={selectedCharacter}
        nodeId={selection.nodeId}
        nodeName={selection.nodeName}
        nodeInfo={nodeInfo}
        currentTime={currentTime}
        rotation={evaluatedNodeRotations[selection.nodeId] ?? { x: 0, y: 0, z: 0 }}
        onUpdateNodeRotation={onUpdateNodeRotation}
        onKeyNodeRotation={onKeyNodeRotation}
        onResetNode={onResetNodeRotation}
        onToggleNodeLock={onToggleNodeLock}
        onToggleNodeVisibility={onToggleNodeVisibility}
        onBackToCharacter={() =>
          onSelectTarget({ kind: 'character', instanceId: selectedCharacter.id })
        }
      />
    );
  } else if (selection.kind === 'group' && selectedGroup) {
    body = renderGroupInspector(selectedGroup);
  } else if (selection.kind === 'ik-handle') {
    body = renderIkHandleInspector(selection.instanceId, selection.chain);
  } else if ((selection.kind === 'character' || selection.kind === 'waypoint') && selectedCharacter) {
    body = renderCharacterInspector(selectedCharacter);
  } else if (selection.kind === 'prop' && selectedProp) {
    body = renderPropInspector(selectedProp);
  } else if (selection.kind === 'light' && selectedLight) {
    body = renderLightInspector(selectedLight);
  } else if (selection.kind === 'camera') {
    body = renderCameraInspector();
  } else if (selection.kind === 'audio-clip' && selectedAudioClip) {
    body = renderAudioInspector(selectedAudioClip);
  } else if (selection.kind === 'action-clip' && selectedActionClip && selection.kind === 'action-clip') {
    body = renderActionClipInspector(selection.instanceId, selectedActionClip);
  } else {
    body = renderSceneInspector();
  }

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-l border-[#2a2e36] bg-[#191b1f]"
      aria-label="Property Inspector"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#2a2e36] px-2.5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-3.5 w-3.5 text-[#98a0ad]" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-[#e6e8ec]">Inspector</h2>
        </div>
        <div className="flex items-center gap-1">
          {selection.kind !== 'none' && (
            <button
              type="button"
              title="Clear selection to view Scene Settings"
              onClick={() => onSelectTarget({ kind: 'none' })}
              className="rounded px-1.5 py-0.5 text-[10px] text-[#98a0ad] hover:bg-[#252932] hover:text-[#e8702a]"
            >
              <RotateCcw className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
              Scene
            </button>
          )}
          <IconButton
            label="Compact Inspector"
            note="Collapse Inspector to icon rail"
            onClick={() => onChangeCollapseState('compact')}
          >
            <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs">{body}</div>
    </aside>
  );
}
