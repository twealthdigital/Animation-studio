import { useState } from 'react';
import {
  Bone,
  FlipHorizontal2,
  Key,
  Layers,
  MessageSquarePlus,
  Play,
  Plus,
  RotateCcw,
  Smile,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import type {
  CharacterInstanceData,
  EasingType,
  FacialState,
  HumanoidSlot,
  IkChainType,
  IkTargetData,
  RigCompatibilityReport,
  RigNodeInfo,
  SavedPoseData,
  SceneData,
  Vec3,
} from '../../core/types';
import { createDefaultFacialState } from '../../core/types';
import {
  type AnimationSuggestion,
  LocalSmartAnimationAssistant,
  MOTION_PRESETS,
  UnconfiguredExternalAiProvider,
} from '../../animation/MotionPresets';
import { blendPoses, mirrorPoseRotations } from '../../animation/RigMapper';
import { createId } from '../../utils/ids';
import { DEG_TO_RAD, RAD_TO_DEG } from '../../utils/math';
import { CustomSelect, IconButton, NumericInput, StudioButton, StudioSlider } from '../components/Primitives';

const HUMANOID_SLOT_OPTIONS: { value: HumanoidSlot | ''; label: string }[] = [
  { value: '', label: 'Unmapped' },
  { value: 'hips', label: 'Hips / Pelvis' },
  { value: 'spine', label: 'Spine' },
  { value: 'chest', label: 'Chest' },
  { value: 'neck', label: 'Neck' },
  { value: 'head', label: 'Head' },
  { value: 'jaw', label: 'Jaw' },
  { value: 'leftUpperArm', label: 'Left Upper Arm' },
  { value: 'leftForearm', label: 'Left Forearm' },
  { value: 'leftHand', label: 'Left Hand' },
  { value: 'rightUpperArm', label: 'Right Upper Arm' },
  { value: 'rightForearm', label: 'Right Forearm' },
  { value: 'rightHand', label: 'Right Hand' },
  { value: 'leftThigh', label: 'Left Thigh' },
  { value: 'leftShin', label: 'Left Shin' },
  { value: 'leftFoot', label: 'Left Foot' },
  { value: 'rightThigh', label: 'Right Thigh' },
  { value: 'rightShin', label: 'Right Shin' },
  { value: 'rightFoot', label: 'Right Foot' },
];

const IK_CHAINS: { chain: IkChainType; label: string; defaultTarget: Vec3 }[] = [
  { chain: 'leftArm', label: 'Left Arm IK', defaultTarget: { x: 0.9, y: 2.3, z: 0.9 } },
  { chain: 'rightArm', label: 'Right Arm IK', defaultTarget: { x: -0.9, y: 2.3, z: 0.9 } },
  { chain: 'leftLeg', label: 'Left Leg IK', defaultTarget: { x: 0.4, y: 0.1, z: 0.2 } },
  { chain: 'rightLeg', label: 'Right Leg IK', defaultTarget: { x: -0.4, y: 0.1, z: 0.2 } },
  { chain: 'lookAt', label: 'Head Look-At IK', defaultTarget: { x: 0, y: 2.5, z: 3.5 } },
];

const FACIAL_PRESETS: { id: string; label: string; patch: Partial<FacialState> }[] = [
  { id: 'neutral', label: 'Neutral', patch: { smile: 0, frown: 0, surprise: 0, anger: 0, sadness: 0, fear: 0, blink: 0, mouthOpen: 0, browRaise: 0 } },
  { id: 'happy', label: 'Happy Smile', patch: { smile: 0.9, frown: 0, browRaise: 0.35, mouthOpen: 0.25, anger: 0, sadness: 0 } },
  { id: 'surprised', label: 'Surprised', patch: { surprise: 0.95, browRaise: 0.85, mouthOpen: 0.65, smile: 0 } },
  { id: 'angry', label: 'Angry', patch: { anger: 0.9, browRaise: -0.7, frown: 0.65, smile: 0 } },
  { id: 'sad', label: 'Sad', patch: { sadness: 0.9, frown: 0.75, browRaise: -0.25, smile: 0 } },
  { id: 'blink', label: 'Blink', patch: { blink: 1 } },
];

export interface RigTabProps {
  char: CharacterInstanceData;
  currentTime: number;
  rigNodes: RigNodeInfo[];
  rigReport: RigCompatibilityReport | null;
  evaluatedNodeRotations: Record<string, Vec3>;
  onSelectNode: (nodeId: string, nodeName: string) => void;
  onUpdateCharacterMeta: (instanceId: string, patch: Partial<CharacterInstanceData>) => void;
  onKeyNodeRotation: (instanceId: string, nodeId: string, nodeName: string, rot: Vec3, easing: EasingType) => void;
  onApplyPresetToTimeline: (instanceId: string, presetId: string) => void;
  onExecuteSuggestion: (sug: AnimationSuggestion) => void;
  scene: SceneData;
}

export function RigAndIkSection({
  char,
  currentTime,
  rigNodes,
  rigReport,
  evaluatedNodeRotations,
  onSelectNode,
  onUpdateCharacterMeta,
  onKeyNodeRotation,
}: RigTabProps) {
  const [poseName, setPoseName] = useState('Pose A');
  const [blendAlpha, setBlendAlpha] = useState(0.5);
  const [slotNodeId, setSlotNodeId] = useState<string>(rigNodes[0]?.nodeId ?? '');
  const [slotTarget, setSlotTarget] = useState<HumanoidSlot | ''>('');

  const boneMap = char.boneMap ?? {};
  const ikTargets = char.ikTargets ?? [];
  const savedPoses = char.savedPoses ?? [];

  const toggleIkChain = (chain: IkChainType, defaultTarget: Vec3) => {
    const existing = ikTargets.find((i) => i.chain === chain);
    const next: IkTargetData[] = existing
      ? ikTargets.map((i) => (i.chain === chain ? { ...i, enabled: !i.enabled } : i))
      : [...ikTargets, { id: createId('ik'), chain, enabled: true, target: { ...defaultTarget }, weight: 1 }];
    onUpdateCharacterMeta(char.id, { ikTargets: next });
  };

  const updateIkTarget = (chain: IkChainType, patch: Partial<IkTargetData>) => {
    const next = ikTargets.map((i) => (i.chain === chain ? { ...i, ...patch } : i));
    onUpdateCharacterMeta(char.id, { ikTargets: next });
  };

  const handleSaveCurrentPose = () => {
    const rotations: Record<string, Vec3> = {};
    for (const [nodeId, rot] of Object.entries(evaluatedNodeRotations)) {
      rotations[nodeId] = { ...rot };
    }
    const pose: SavedPoseData = {
      id: createId('pose'),
      name: poseName.trim() || `Pose ${savedPoses.length + 1}`,
      nodeRotations: rotations,
    };
    onUpdateCharacterMeta(char.id, { savedPoses: [...savedPoses, pose] });
  };

  const applyPoseRotations = (rotations: Record<string, Vec3>) => {
    for (const [nodeId, rot] of Object.entries(rotations)) {
      const node = rigNodes.find((n) => n.nodeId === nodeId);
      onKeyNodeRotation(char.id, nodeId, node?.name ?? nodeId, rot, 'smooth');
    }
  };

  return (
    <div className="space-y-4">
      {/* Rig Compatibility Summary */}
      {rigReport && (
        <div className="space-y-1.5 rounded border border-[#2a2e36] bg-[#14161a] p-2.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
              <Bone className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
              <span>Rig: {rigReport.rigKind.toUpperCase()}</span>
            </span>
            <span className="font-mono-code text-[10px] text-[#98a0ad]">
              {rigReport.mappedCount} mapped / {rigReport.totalNodes} nodes
            </span>
          </div>
          {rigReport.notes.map((n, i) => (
            <p key={i} className="text-[11px] leading-snug text-[#98a0ad]">
              {n}
            </p>
          ))}
        </div>
      )}

      {/* Body Parts Quick Picker */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-[#98a0ad]">
          <span>Selectable Rig Parts</span>
          <span>Click to pose in 3D</span>
        </div>
        <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-[#2a2e36] bg-[#14161a] p-1.5">
          {rigNodes.length === 0 ? (
            <div className="p-2 text-center text-[11px] text-[#6b7280]">No rig nodes exposed.</div>
          ) : (
            rigNodes.map((n) => (
              <button
                key={n.nodeId}
                type="button"
                onClick={() => onSelectNode(n.nodeId, n.name)}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] text-[#e6e8ec] hover:bg-[#252932]"
              >
                <span className="truncate">{n.name}</span>
                <span className="ml-2 shrink-0 rounded bg-[#22262e] px-1.5 py-0.5 font-mono-code text-[9px] text-[#98a0ad]">
                  {n.slot ?? n.type}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* IK Chains */}
      <div className="space-y-2 border-t border-[#2a2e36] pt-3">
        <div className="font-semibold text-[#e6e8ec]">Inverse Kinematics (IK)</div>
        <div className="space-y-1.5">
          {IK_CHAINS.map((spec) => {
            const existing = ikTargets.find((i) => i.chain === spec.chain);
            const enabled = Boolean(existing?.enabled);
            return (
              <div key={spec.chain} className="rounded border border-[#2a2e36] bg-[#14161a] p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-[11px] font-medium text-[#e6e8ec]">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => toggleIkChain(spec.chain, spec.defaultTarget)}
                      className="accent-[#e8702a]"
                    />
                    <span>{spec.label}</span>
                  </label>
                  {enabled && <span className="text-[10px] text-[#4ade80]">Drag green handle</span>}
                </div>
                {enabled && existing && (
                  <>
                    <div className="grid grid-cols-3 gap-1">
                      <NumericInput
                        label="X"
                        value={existing.target.x}
                        onChange={(x) => updateIkTarget(spec.chain, { target: { ...existing.target, x } })}
                      />
                      <NumericInput
                        label="Y"
                        value={existing.target.y}
                        onChange={(y) => updateIkTarget(spec.chain, { target: { ...existing.target, y } })}
                      />
                      <NumericInput
                        label="Z"
                        value={existing.target.z}
                        onChange={(z) => updateIkTarget(spec.chain, { target: { ...existing.target, z } })}
                      />
                    </div>
                    <StudioSlider
                      label="IK / FK Blend"
                      min={0}
                      max={1}
                      step={0.05}
                      value={existing.weight}
                      displayValue={`${Math.round(existing.weight * 100)}%`}
                      onChange={(weight) => updateIkTarget(spec.chain, { weight })}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Pose Library, Mirroring & Blending */}
      <div className="space-y-2 border-t border-[#2a2e36] pt-3">
        <div className="font-semibold text-[#e6e8ec]">Pose Library &amp; Mirroring</div>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={poseName}
            onChange={(e) => setPoseName(e.target.value)}
            placeholder="Pose name..."
            className="h-7 flex-1 rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
          />
          <StudioButton size="sm" variant="primary" onClick={handleSaveCurrentPose}>
            <Plus className="h-3 w-3" aria-hidden="true" />
            <span>Save Pose</span>
          </StudioButton>
        </div>

        <StudioButton
          className="w-full"
          size="xs"
          onClick={() => {
            const mirrored = mirrorPoseRotations(evaluatedNodeRotations, boneMap);
            applyPoseRotations(mirrored);
          }}
        >
          <FlipHorizontal2 className="h-3 w-3" aria-hidden="true" />
          <span>Mirror Current Pose L ↔ R @ {currentTime.toFixed(1)}s</span>
        </StudioButton>

        {savedPoses.length > 0 && (
          <div className="space-y-1.5">
            {savedPoses.map((pose) => (
              <div
                key={pose.id}
                className="flex items-center justify-between gap-1.5 rounded border border-[#2a2e36] bg-[#14161a] px-2 py-1.5"
              >
                <span className="truncate font-medium text-[#e6e8ec]">{pose.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <StudioButton size="xs" onClick={() => applyPoseRotations(pose.nodeRotations)}>
                    Apply
                  </StudioButton>
                  <StudioButton
                    size="xs"
                    title="Blend 50% into current pose"
                    onClick={() => {
                      const blended = blendPoses(evaluatedNodeRotations, pose.nodeRotations, blendAlpha);
                      applyPoseRotations(blended);
                    }}
                  >
                    <Layers className="h-3 w-3" aria-hidden="true" />
                  </StudioButton>
                  <IconButton
                    label={`Delete pose ${pose.name}`}
                    onClick={() =>
                      onUpdateCharacterMeta(char.id, {
                        savedPoses: savedPoses.filter((p) => p.id !== pose.id),
                      })
                    }
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            ))}
            <StudioSlider
              label="Pose Blend Factor"
              min={0.1}
              max={1}
              step={0.05}
              value={blendAlpha}
              displayValue={`${Math.round(blendAlpha * 100)}%`}
              onChange={setBlendAlpha}
            />
          </div>
        )}
      </div>

      {/* Manual Bone Slot Remapping */}
      {rigNodes.length > 0 && (
        <div className="space-y-2 border-t border-[#2a2e36] pt-3">
          <div className="font-semibold text-[#e6e8ec]">Manual Joint Mapping</div>
          <div className="grid grid-cols-2 gap-1.5">
            <CustomSelect
              ariaLabel="Rig node to map"
              value={slotNodeId || rigNodes[0].nodeId}
              options={rigNodes.map((n) => ({ value: n.nodeId, label: n.name }))}
              onChange={setSlotNodeId}
            />
            <CustomSelect
              ariaLabel="Humanoid slot"
              value={slotTarget}
              options={HUMANOID_SLOT_OPTIONS}
              onChange={(s) => setSlotTarget(s as HumanoidSlot | '')}
            />
          </div>
          <StudioButton
            size="xs"
            className="w-full"
            disabled={!slotNodeId || !slotTarget}
            onClick={() => {
              if (!slotTarget || !slotNodeId) return;
              onUpdateCharacterMeta(char.id, {
                boneMap: { ...boneMap, [slotTarget]: slotNodeId },
              });
            }}
          >
            Assign Humanoid Slot
          </StudioButton>
        </div>
      )}
    </div>
  );
}

export function FacialAndVoiceSection({
  char,
  currentTime,
  evaluatedFacial,
  onUpdateCharacterMeta,
  onKeyFacialState,
  onOpenDialogueDialog,
}: {
  char: CharacterInstanceData;
  currentTime: number;
  evaluatedFacial: FacialState;
  onUpdateCharacterMeta: (instanceId: string, patch: Partial<CharacterInstanceData>) => void;
  onKeyFacialState: (instanceId: string, state: FacialState) => void;
  onOpenDialogueDialog: (instanceId: string) => void;
}) {
  const f = evaluatedFacial ?? char.facialState ?? createDefaultFacialState();

  const updateField = (patch: Partial<FacialState>) => {
    onUpdateCharacterMeta(char.id, { facialState: { ...f, ...patch } });
  };

  const SLIDERS: { key: keyof FacialState; label: string; min: number; max: number }[] = [
    { key: 'smile', label: 'Smile', min: 0, max: 1 },
    { key: 'frown', label: 'Frown', min: 0, max: 1 },
    { key: 'mouthOpen', label: 'Mouth Open (Lip Sync)', min: 0, max: 1 },
    { key: 'jawOpen', label: 'Jaw Open', min: 0, max: 1 },
    { key: 'blink', label: 'Blink', min: 0, max: 1 },
    { key: 'browRaise', label: 'Brow Raise / Furrow', min: -1, max: 1 },
    { key: 'eyeLookX', label: 'Eye Look Horizontal', min: -1, max: 1 },
    { key: 'eyeLookY', label: 'Eye Look Vertical', min: -1, max: 1 },
    { key: 'surprise', label: 'Surprise', min: 0, max: 1 },
    { key: 'anger', label: 'Anger', min: 0, max: 1 },
    { key: 'sadness', label: 'Sadness', min: 0, max: 1 },
    { key: 'fear', label: 'Fear', min: 0, max: 1 },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-2 border-b border-[#2a2e36] pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
            <Smile className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
            <span>Facial Expressions</span>
          </span>
          <span className="text-[10px] text-[#98a0ad]">
            {char.facialKeyframes?.length ?? 0} keys
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          {FACIAL_PRESETS.map((p) => (
            <StudioButton
              key={p.id}
              size="xs"
              onClick={() => updateField({ ...createDefaultFacialState(), ...p.patch })}
            >
              {p.label}
            </StudioButton>
          ))}
        </div>

        <div className="space-y-1.5 pt-1">
          {SLIDERS.map((s) => (
            <StudioSlider
              key={s.key}
              label={s.label}
              min={s.min}
              max={s.max}
              step={0.05}
              value={Number(f[s.key] ?? 0)}
              onChange={(val) => updateField({ [s.key]: val } as Partial<FacialState>)}
            />
          ))}
        </div>

        <StudioButton
          variant="primary"
          className="w-full"
          onClick={() => onKeyFacialState(char.id, f)}
        >
          <Key className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Key Expression @ {currentTime.toFixed(1)}s</span>
        </StudioButton>
      </div>

      {/* Character Voice Profile & Pitch/Speed */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-[#e6e8ec]">Voice Profile &amp; Lip Sync</span>
          <IconButton
            label={char.audioProfile.muted ? 'Unmute character' : 'Mute character'}
            active={char.audioProfile.muted}
            onClick={() =>
              onUpdateCharacterMeta(char.id, {
                audioProfile: { ...char.audioProfile, muted: !char.audioProfile.muted },
              })
            }
          >
            {char.audioProfile.muted ? (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </IconButton>
        </div>

        <label className="block">
          <span className="text-[11px] text-[#98a0ad]">Voice Profile Name</span>
          <input
            type="text"
            value={char.audioProfile.voiceLabel}
            onChange={(e) =>
              onUpdateCharacterMeta(char.id, {
                audioProfile: { ...char.audioProfile, voiceLabel: e.target.value },
              })
            }
            className="mt-1 h-7 w-full rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
          />
        </label>

        <StudioSlider
          label="Voice Pitch"
          min={0.5}
          max={2}
          step={0.05}
          value={char.audioProfile.pitch ?? 1}
          displayValue={`${(char.audioProfile.pitch ?? 1).toFixed(2)}x`}
          onChange={(pitch) =>
            onUpdateCharacterMeta(char.id, {
              audioProfile: { ...char.audioProfile, pitch },
            })
          }
        />

        <StudioSlider
          label="Voice Speed"
          min={0.5}
          max={2}
          step={0.05}
          value={char.audioProfile.speed ?? 1}
          displayValue={`${(char.audioProfile.speed ?? 1).toFixed(2)}x`}
          onChange={(speed) =>
            onUpdateCharacterMeta(char.id, {
              audioProfile: { ...char.audioProfile, speed },
            })
          }
        />

        <StudioSlider
          label="Default Volume"
          min={0}
          max={1.5}
          step={0.05}
          value={char.audioProfile.defaultVolume}
          displayValue={`${Math.round(char.audioProfile.defaultVolume * 100)}%`}
          onChange={(defaultVolume) =>
            onUpdateCharacterMeta(char.id, {
              audioProfile: { ...char.audioProfile, defaultVolume },
            })
          }
        />

        <StudioButton
          variant="primary"
          className="w-full"
          onClick={() => onOpenDialogueDialog(char.id)}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Add Dialogue / Record Mic</span>
        </StudioButton>
      </div>
    </div>
  );
}

export function SmartPresetsAndAssistantSection({
  char,
  scene,
  currentTime,
  rigReport,
  onAddPresetClip,
  onExecuteSuggestion,
}: {
  char: CharacterInstanceData;
  scene: SceneData;
  currentTime: number;
  rigReport: RigCompatibilityReport | null;
  onAddPresetClip: (
    instanceId: string,
    presetId: string,
    opts: { startTime: number; duration: number; speed: number; blendIn: number },
  ) => void;
  onExecuteSuggestion: (sug: AnimationSuggestion) => void;
}) {
  const [presetId, setPresetId] = useState(MOTION_PRESETS[0].id);
  const [duration, setDuration] = useState(MOTION_PRESETS[0].defaultDuration);
  const [speed, setSpeed] = useState(1);
  const [blendIn, setBlendIn] = useState(0.25);

  const [seqSteps, setSeqSteps] = useState<string[]>(['wave', 'walk', 'turn']);

  const localAi = new LocalSmartAnimationAssistant();
  const externalAi = new UnconfiguredExternalAiProvider();
  const suggestions = localAi.suggestSceneImprovements(scene, char, rigReport);
  const selectedPreset = MOTION_PRESETS.find((p) => p.id === presetId) ?? MOTION_PRESETS[0];

  const handleApplySequence = () => {
    let cursor = currentTime;
    for (const pid of seqSteps) {
      const p = MOTION_PRESETS.find((m) => m.id === pid);
      const dur = p?.defaultDuration ?? 1.8;
      onAddPresetClip(char.id, pid, { startTime: cursor, duration: dur, speed: 1, blendIn: 0.25 });
      cursor += Math.max(0.4, dur - 0.2);
    }
  };

  return (
    <div className="space-y-4">
      {/* 18 Procedural Motion Presets */}
      <div className="space-y-2 border-b border-[#2a2e36] pb-3">
        <div className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
          <Wand2 className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
          <span>Motion Presets Library ({MOTION_PRESETS.length})</span>
        </div>

        <CustomSelect
          label="Preset Motion"
          value={presetId}
          options={MOTION_PRESETS.map((p) => ({
            value: p.id,
            label: `${p.label} · ${p.category}`,
          }))}
          onChange={(id) => {
            setPresetId(id);
            const found = MOTION_PRESETS.find((m) => m.id === id);
            if (found) setDuration(found.defaultDuration);
          }}
        />
        <p className="text-[11px] text-[#98a0ad]">{selectedPreset.description}</p>

        <div className="grid grid-cols-3 gap-1.5">
          <NumericInput label="Dur" min={0.3} step={0.2} value={duration} onChange={setDuration} />
          <NumericInput label="Spd" min={0.25} max={3} step={0.1} value={speed} onChange={setSpeed} />
          <NumericInput label="Fade" min={0.05} max={1.5} step={0.05} value={blendIn} onChange={setBlendIn} />
        </div>

        <StudioButton
          variant="primary"
          className="w-full"
          onClick={() =>
            onAddPresetClip(char.id, presetId, {
              startTime: Number(currentTime.toFixed(2)),
              duration,
              speed,
              blendIn,
            })
          }
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Apply Preset @ {currentTime.toFixed(1)}s</span>
        </StudioButton>
      </div>

      {/* Action Sequence Builder (1..7 actions) */}
      <div className="space-y-2 border-b border-[#2a2e36] pb-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-[#e6e8ec]">Action Sequence Builder</span>
          <span className="text-[10px] text-[#98a0ad]">{seqSteps.length}/7 steps</span>
        </div>
        <div className="space-y-1">
          {seqSteps.map((stepId, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <span className="w-4 text-[10px] text-[#6b7280]">{idx + 1}.</span>
              <select
                aria-label={`Sequence step ${idx + 1}`}
                value={stepId}
                onChange={(e) =>
                  setSeqSteps((prev) => prev.map((v, i) => (i === idx ? e.target.value : v)))
                }
                className="h-6 flex-1 rounded border border-[#2e333d] bg-[#14161a] px-1.5 text-[11px] text-[#e6e8ec]"
              >
                {MOTION_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <IconButton
                label="Remove step"
                disabled={seqSteps.length <= 1}
                onClick={() => setSeqSteps((prev) => prev.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          <StudioButton
            size="xs"
            disabled={seqSteps.length >= 7}
            onClick={() => setSeqSteps((prev) => [...prev, 'clap'])}
          >
            + Add Step
          </StudioButton>
          <StudioButton size="xs" variant="primary" className="flex-1" onClick={handleApplySequence}>
            <Play className="h-3 w-3" aria-hidden="true" />
            <span>Build Sequence</span>
          </StudioButton>
        </div>
      </div>

      {/* Smart Assistant Suggestions */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 font-semibold text-[#e6e8ec]">
          <Sparkles className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
          <span>Smart Animation Assistant</span>
        </div>
        <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2 text-[10px] text-[#98a0ad]">
          <div>{localAi.getStatusMessage()}</div>
          <div className="mt-1 text-[#6b7280]">External AI: {externalAi.getStatusMessage()}</div>
        </div>
        {suggestions.length === 0 ? (
          <p className="text-[11px] text-[#6b7280]">No scene issues or suggestions right now.</p>
        ) : (
          <div className="space-y-1.5">
            {suggestions.map((sug) => (
              <div
                key={sug.id}
                className={`space-y-1 rounded border p-2 ${
                  sug.severity === 'warning'
                    ? 'border-[#7f4d2d] bg-[#2a1f17]'
                    : 'border-[#2a2e36] bg-[#14161a]'
                }`}
              >
                <div className="font-semibold text-[#e6e8ec]">{sug.title}</div>
                <p className="text-[11px] text-[#98a0ad]">{sug.detail}</p>
                {sug.actionLabel && sug.actionKind && (
                  <StudioButton size="xs" variant="primary" onClick={() => onExecuteSuggestion(sug)}>
                    {sug.actionLabel}
                  </StudioButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BodyPartInspector({
  char,
  nodeId,
  nodeName,
  nodeInfo,
  currentTime,
  rotation,
  onUpdateNodeRotation,
  onKeyNodeRotation,
  onResetNode,
  onToggleNodeLock,
  onToggleNodeVisibility,
  onBackToCharacter,
}: {
  char: CharacterInstanceData;
  nodeId: string;
  nodeName: string;
  nodeInfo?: RigNodeInfo;
  currentTime: number;
  rotation: Vec3;
  onUpdateNodeRotation: (instanceId: string, nodeId: string, nodeName: string, rot: Vec3) => void;
  onKeyNodeRotation: (instanceId: string, nodeId: string, nodeName: string, rot: Vec3, easing: EasingType) => void;
  onResetNode: (instanceId: string, nodeId: string) => void;
  onToggleNodeLock: (instanceId: string, nodeId: string) => void;
  onToggleNodeVisibility: (instanceId: string, nodeId: string) => void;
  onBackToCharacter: () => void;
}) {
  const [easing, setEasing] = useState<EasingType>('smooth');
  const track = char.nodeTracks?.find((t) => t.nodeId === nodeId);
  const isLocked = Boolean(char.lockedNodes?.includes(nodeId));
  const isHidden = Boolean(char.hiddenNodes?.includes(nodeId));

  const degX = rotation.x * RAD_TO_DEG;
  const degY = rotation.y * RAD_TO_DEG;
  const degZ = rotation.z * RAD_TO_DEG;

  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between border-b border-[#2a2e36] pb-2">
        <div className="min-w-0">
          <div className="truncate text-[10px] text-[#98a0ad]">
            {char.name} · {nodeInfo?.slot ?? 'Joint'}
          </div>
          <div className="truncate font-semibold text-[#e6e8ec]">{nodeName}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <StudioButton
            size="xs"
            variant={isLocked ? 'selected' : 'default'}
            note={isLocked ? 'Unlock joint rotation' : 'Lock joint rotation'}
            onClick={() => onToggleNodeLock(char.id, nodeId)}
          >
            {isLocked ? 'Locked' : 'Lock'}
          </StudioButton>
          <StudioButton
            size="xs"
            variant={isHidden ? 'selected' : 'default'}
            note={isHidden ? 'Show part mesh' : 'Hide part mesh'}
            onClick={() => onToggleNodeVisibility(char.id, nodeId)}
          >
            {isHidden ? 'Hidden' : 'Hide'}
          </StudioButton>
          <StudioButton size="xs" onClick={onBackToCharacter}>
            Root
          </StudioButton>
        </div>
      </div>

      {/* Parent Joint Lock Indicator */}
      <div className="rounded border border-[#2a2e36] bg-[#14161a] px-2.5 py-1.5 text-[10px] text-[#98a0ad]">
        {nodeInfo?.parentId
          ? 'Socket locked to parent bone — rotation pivots cleanly without detaching.'
          : 'Root joint — drag directly in viewport or adjust rotation below.'}
      </div>

      {/* Smooth Drag Sliders + Precise Degree Inputs */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] text-[#98a0ad]">
          <span>Joint Rotation (deg)</span>
          <span className="font-mono-code text-[10px] text-[#e8702a]">
            {track?.rotationKeyframes.length ?? 0} keys
          </span>
        </div>

        <StudioSlider
          label="Pitch (X)"
          min={-180}
          max={180}
          step={1}
          value={Math.max(-180, Math.min(180, degX))}
          displayValue={`${degX.toFixed(1)}°`}
          onChange={(x) =>
            !isLocked && onUpdateNodeRotation(char.id, nodeId, nodeName, { ...rotation, x: x * DEG_TO_RAD })
          }
        />
        <StudioSlider
          label="Yaw (Y)"
          min={-180}
          max={180}
          step={1}
          value={Math.max(-180, Math.min(180, degY))}
          displayValue={`${degY.toFixed(1)}°`}
          onChange={(y) =>
            !isLocked && onUpdateNodeRotation(char.id, nodeId, nodeName, { ...rotation, y: y * DEG_TO_RAD })
          }
        />
        <StudioSlider
          label="Roll (Z)"
          min={-180}
          max={180}
          step={1}
          value={Math.max(-180, Math.min(180, degZ))}
          displayValue={`${degZ.toFixed(1)}°`}
          onChange={(z) =>
            !isLocked && onUpdateNodeRotation(char.id, nodeId, nodeName, { ...rotation, z: z * DEG_TO_RAD })
          }
        />

        <div className="grid grid-cols-3 gap-1.5 pt-1">
          <NumericInput
            label="X"
            step={5}
            decimals={1}
            disabled={isLocked}
            value={degX}
            onChange={(x) => onUpdateNodeRotation(char.id, nodeId, nodeName, { ...rotation, x: x * DEG_TO_RAD })}
          />
          <NumericInput
            label="Y"
            step={5}
            decimals={1}
            disabled={isLocked}
            value={degY}
            onChange={(y) => onUpdateNodeRotation(char.id, nodeId, nodeName, { ...rotation, y: y * DEG_TO_RAD })}
          />
          <NumericInput
            label="Z"
            step={5}
            decimals={1}
            disabled={isLocked}
            value={degZ}
            onChange={(z) => onUpdateNodeRotation(char.id, nodeId, nodeName, { ...rotation, z: z * DEG_TO_RAD })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <CustomSelect
          ariaLabel="Node keyframe easing"
          value={easing}
          options={[
            { value: 'smooth', label: 'Smooth' },
            { value: 'linear', label: 'Linear' },
            { value: 'step', label: 'Step' },
            { value: 'easeInOut', label: 'Ease In & Out' },
          ]}
          onChange={(v) => setEasing(v as EasingType)}
        />
        <StudioButton
          variant="primary"
          onClick={() => onKeyNodeRotation(char.id, nodeId, nodeName, rotation, easing)}
        >
          <Key className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Key @ {currentTime.toFixed(1)}s</span>
        </StudioButton>
      </div>

      <StudioButton className="w-full" onClick={() => onResetNode(char.id, nodeId)}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Reset Joint Pose</span>
      </StudioButton>

      {/* Structure & Materials */}
      {nodeInfo && (
        <div className="space-y-1.5 border-t border-[#2a2e36] pt-2.5 text-[11px]">
          <div className="font-semibold text-[#e6e8ec]">Part Structure</div>
          {nodeInfo.description && <p className="text-[#98a0ad]">{nodeInfo.description}</p>}
          {nodeInfo.materials && nodeInfo.materials.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {nodeInfo.materials.map((m, idx) => (
                <span
                  key={idx}
                  className="rounded border border-[#2a2e36] bg-[#14161a] px-1.5 py-0.5 font-mono-code text-[10px] text-[#cbd5e1]"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
