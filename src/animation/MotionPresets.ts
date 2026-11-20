import type {
  CharacterInstanceData,
  HumanoidSlot,
  RigCompatibilityReport,
  RigNodeInfo,
  SceneData,
  TabPrediction,
  Vec3,
} from '../core/types';
import { clamp } from '../utils/math';

export interface MotionPresetDescriptor {
  id: string;
  label: string;
  category: 'locomotion' | 'gesture' | 'reaction' | 'idle';
  defaultDuration: number;
  requiresHumanoidLimbs: boolean;
  description: string;
}

export const MOTION_PRESETS: MotionPresetDescriptor[] = [
  { id: 'walk', label: 'Walk Cycle', category: 'locomotion', defaultDuration: 2.4, requiresHumanoidLimbs: true, description: 'Alternating leg & arm stride with natural bounce.' },
  { id: 'run', label: 'Run Cycle', category: 'locomotion', defaultDuration: 1.8, requiresHumanoidLimbs: true, description: 'Faster forward lean, high knees, and pumping elbows.' },
  { id: 'jump', label: 'Jump', category: 'locomotion', defaultDuration: 1.2, requiresHumanoidLimbs: false, description: 'Crouch anticipation, upward arc, and soft landing.' },
  { id: 'sit', label: 'Sit Pose', category: 'idle', defaultDuration: 2.0, requiresHumanoidLimbs: true, description: 'Bends hips forward and knees downward into seated posture.' },
  { id: 'stand', label: 'Stand Neutral', category: 'idle', defaultDuration: 1.0, requiresHumanoidLimbs: true, description: 'Returns arms and legs to upright neutral stance.' },
  { id: 'wave', label: 'Wave Hello', category: 'gesture', defaultDuration: 1.6, requiresHumanoidLimbs: true, description: 'Raises right arm and waves forearm side to side.' },
  { id: 'dance', label: 'Dance Groove', category: 'reaction', defaultDuration: 3.0, requiresHumanoidLimbs: false, description: 'Rhythmic bounce, shoulder sway, and head groove.' },
  { id: 'talk', label: 'Talk Gestures', category: 'gesture', defaultDuration: 2.0, requiresHumanoidLimbs: true, description: 'Conversational hand emphasis and subtle head nods.' },
  { id: 'laugh', label: 'Laugh', category: 'reaction', defaultDuration: 1.6, requiresHumanoidLimbs: false, description: 'Upbeat torso chuckle and head tilt back.' },
  { id: 'cry', label: 'Cry / Sob', category: 'reaction', defaultDuration: 2.0, requiresHumanoidLimbs: true, description: 'Dropped head and hands raised near face.' },
  { id: 'lookAround', label: 'Look Around', category: 'gesture', defaultDuration: 2.2, requiresHumanoidLimbs: false, description: 'Scans left and right curiously with head and torso.' },
  { id: 'turn', label: 'Turn Around', category: 'locomotion', defaultDuration: 1.2, requiresHumanoidLimbs: false, description: 'Smooth 180-degree pivot turn.' },
  { id: 'fall', label: 'Slip & Fall', category: 'reaction', defaultDuration: 1.4, requiresHumanoidLimbs: false, description: 'Dramatic backward tilt onto the floor.' },
  { id: 'pickUp', label: 'Pick Up Object', category: 'gesture', defaultDuration: 1.8, requiresHumanoidLimbs: true, description: 'Leans forward and reaches right arm downward.' },
  { id: 'throw', label: 'Throw Object', category: 'gesture', defaultDuration: 1.3, requiresHumanoidLimbs: true, description: 'Winds up right arm and whips forward cleanly.' },
  { id: 'point', label: 'Point Forward', category: 'gesture', defaultDuration: 1.5, requiresHumanoidLimbs: true, description: 'Extends arm forward to direct attention.' },
  { id: 'clap', label: 'Clap Hands', category: 'reaction', defaultDuration: 1.6, requiresHumanoidLimbs: true, description: 'Brings both forearms together in rhythmic applause.' },
  { id: 'surprised', label: 'Surprised Startle', category: 'reaction', defaultDuration: 1.2, requiresHumanoidLimbs: false, description: 'Quick recoil hop with raised arms and widened gaze.' },
];

export interface MotionPresetPoseDelta {
  rootPosOffset: Vec3;
  rootRotOffset: Vec3;
  slotRotations: Partial<Record<HumanoidSlot, Vec3>>;
}

function addVec(target: Vec3, src: Vec3, w: number) {
  target.x += src.x * w;
  target.y += src.y * w;
  target.z += src.z * w;
}

/**
 * Evaluates a procedural motion preset at local time & cycle speed.
 * Outputs both humanoid slot rotations and root transform deltas (safe fallback for rigid/globe rigs).
 */
export function evaluateMotionPresetAtTime(
  presetId: string,
  localTime: number,
  duration: number,
  speed = 1,
): MotionPresetPoseDelta {
  const t = Math.max(0, localTime) * Math.max(0.1, speed);
  const dur = Math.max(0.2, duration);
  const norm = clamp(localTime / dur, 0, 1);
  const cyc = t * Math.PI * 2;

  const rootPosOffset: Vec3 = { x: 0, y: 0, z: 0 };
  const rootRotOffset: Vec3 = { x: 0, y: 0, z: 0 };
  const slots: Partial<Record<HumanoidSlot, Vec3>> = {};

  switch (presetId) {
    case 'walk': {
      const s = Math.sin(cyc * 1.4);
      const c = Math.cos(cyc * 1.4);
      rootPosOffset.y = Math.abs(c) * 0.09;
      rootRotOffset.z = s * 0.04;
      slots.leftThigh = { x: s * 0.55, y: 0, z: 0 };
      slots.rightThigh = { x: -s * 0.55, y: 0, z: 0 };
      slots.leftShin = { x: Math.max(0, -c) * 0.55, y: 0, z: 0 };
      slots.rightShin = { x: Math.max(0, c) * 0.55, y: 0, z: 0 };
      slots.leftUpperArm = { x: -s * 0.45, y: 0, z: 0.06 };
      slots.rightUpperArm = { x: s * 0.45, y: 0, z: -0.06 };
      slots.leftForearm = { x: -0.25, y: 0, z: 0 };
      slots.rightForearm = { x: -0.25, y: 0, z: 0 };
      break;
    }
    case 'run': {
      const s = Math.sin(cyc * 2.4);
      const c = Math.cos(cyc * 2.4);
      rootPosOffset.y = Math.abs(c) * 0.18;
      rootRotOffset.x = 0.16;
      slots.leftThigh = { x: s * 0.85, y: 0, z: 0 };
      slots.rightThigh = { x: -s * 0.85, y: 0, z: 0 };
      slots.leftShin = { x: Math.max(0, -c) * 0.95 + 0.15, y: 0, z: 0 };
      slots.rightShin = { x: Math.max(0, c) * 0.95 + 0.15, y: 0, z: 0 };
      slots.leftUpperArm = { x: -s * 0.8, y: 0, z: 0.1 };
      slots.rightUpperArm = { x: s * 0.8, y: 0, z: -0.1 };
      slots.leftForearm = { x: -0.95, y: 0, z: 0 };
      slots.rightForearm = { x: -0.95, y: 0, z: 0 };
      break;
    }
    case 'jump': {
      const arc = Math.sin(norm * Math.PI);
      const crouch = norm < 0.18 ? -Math.sin((norm / 0.18) * Math.PI) * 0.18 : 0;
      rootPosOffset.y = Math.max(0, arc * 1.15) + crouch;
      rootRotOffset.x = (0.5 - norm) * 0.14;
      slots.leftUpperArm = { x: -arc * 1.2, y: 0, z: arc * 0.45 };
      slots.rightUpperArm = { x: -arc * 1.2, y: 0, z: -arc * 0.45 };
      slots.leftThigh = { x: -arc * 0.45, y: 0, z: 0 };
      slots.rightThigh = { x: -arc * 0.45, y: 0, z: 0 };
      slots.leftShin = { x: arc * 0.65, y: 0, z: 0 };
      slots.rightShin = { x: arc * 0.65, y: 0, z: 0 };
      break;
    }
    case 'sit': {
      const ease = clamp(norm * 3, 0, 1);
      rootPosOffset.y = -0.55 * ease;
      slots.leftThigh = { x: -1.35 * ease, y: 0, z: 0.08 };
      slots.rightThigh = { x: -1.35 * ease, y: 0, z: -0.08 };
      slots.leftShin = { x: 1.3 * ease, y: 0, z: 0 };
      slots.rightShin = { x: 1.3 * ease, y: 0, z: 0 };
      slots.leftUpperArm = { x: -0.25 * ease, y: 0, z: 0.1 };
      slots.rightUpperArm = { x: -0.25 * ease, y: 0, z: -0.1 };
      break;
    }
    case 'stand':
      break;
    case 'wave': {
      const env = Math.sin(norm * Math.PI);
      const wag = Math.sin(cyc * 2.2) * 0.45 * env;
      slots.rightUpperArm = { x: -0.35 * env, y: 0, z: -2.25 * env };
      slots.rightForearm = { x: -0.2 * env, y: 0, z: wag };
      slots.head = { x: -0.05 * env, y: 0.1 * env, z: 0.08 * env };
      break;
    }
    case 'dance': {
      const beat = Math.sin(cyc * 1.8);
      const bounce = Math.abs(Math.cos(cyc * 1.8));
      rootPosOffset.y = bounce * 0.16;
      rootRotOffset.y = beat * 0.28;
      rootRotOffset.z = beat * 0.08;
      slots.head = { x: bounce * 0.12, y: -beat * 0.15, z: beat * 0.12 };
      slots.leftUpperArm = { x: -0.6 + beat * 0.4, y: 0, z: 0.55 };
      slots.rightUpperArm = { x: -0.6 - beat * 0.4, y: 0, z: -0.55 };
      slots.leftForearm = { x: -0.8, y: 0, z: 0 };
      slots.rightForearm = { x: -0.8, y: 0, z: 0 };
      break;
    }
    case 'talk': {
      const g1 = Math.sin(cyc * 1.5);
      const g2 = Math.cos(cyc * 1.1);
      slots.head = { x: Math.sin(cyc * 1.7) * 0.08, y: g2 * 0.12, z: g1 * 0.06 };
      slots.leftUpperArm = { x: -0.35 + g1 * 0.25, y: 0, z: 0.18 };
      slots.rightUpperArm = { x: -0.45 + g2 * 0.3, y: 0, z: -0.2 };
      slots.leftForearm = { x: -0.75 + g2 * 0.2, y: 0, z: 0 };
      slots.rightForearm = { x: -0.85 - g1 * 0.25, y: 0, z: 0 };
      break;
    }
    case 'laugh': {
      const bob = Math.sin(cyc * 3.5) * 0.06;
      rootPosOffset.y = Math.abs(bob);
      rootRotOffset.x = -0.12 + bob;
      slots.head = { x: -0.22 + bob * 1.5, y: 0, z: 0 };
      slots.leftUpperArm = { x: -0.4, y: 0, z: 0.2 };
      slots.rightUpperArm = { x: -0.4, y: 0, z: -0.2 };
      break;
    }
    case 'cry': {
      const sob = Math.sin(cyc * 2.2) * 0.06;
      rootRotOffset.x = 0.12;
      slots.head = { x: 0.28 + sob, y: Math.sin(cyc * 0.9) * 0.08, z: 0 };
      slots.leftUpperArm = { x: -1.1, y: 0.25, z: -0.2 };
      slots.rightUpperArm = { x: -1.1, y: -0.25, z: 0.2 };
      slots.leftForearm = { x: -1.2, y: 0, z: 0 };
      slots.rightForearm = { x: -1.2, y: 0, z: 0 };
      break;
    }
    case 'lookAround': {
      const scan = Math.sin(norm * Math.PI * 2);
      rootRotOffset.y = scan * 0.35;
      slots.head = { x: Math.sin(norm * Math.PI) * -0.1, y: scan * 0.65, z: scan * 0.06 };
      break;
    }
    case 'turn': {
      const smooth = norm * norm * (3 - 2 * norm);
      rootRotOffset.y = smooth * Math.PI;
      break;
    }
    case 'fall': {
      const drop = clamp(norm * 1.4, 0, 1);
      const ease = drop * drop;
      rootPosOffset.y = -0.95 * ease;
      rootRotOffset.x = -1.35 * ease;
      slots.leftUpperArm = { x: -0.8 * ease, y: 0, z: 0.7 * ease };
      slots.rightUpperArm = { x: -0.8 * ease, y: 0, z: -0.7 * ease };
      break;
    }
    case 'pickUp': {
      const reach = Math.sin(norm * Math.PI);
      rootRotOffset.x = 0.55 * reach;
      rootPosOffset.y = -0.25 * reach;
      slots.rightUpperArm = { x: -1.35 * reach, y: 0, z: 0 };
      slots.head = { x: 0.3 * reach, y: 0, z: 0 };
      break;
    }
    case 'throw': {
      const windUp = norm < 0.45 ? -(norm / 0.45) : -1 + ((norm - 0.45) / 0.55) * 2.2;
      slots.rightUpperArm = { x: windUp * 1.4, y: 0, z: -0.4 };
      slots.rightForearm = { x: -0.5, y: 0, z: 0 };
      rootRotOffset.y = windUp * 0.25;
      break;
    }
    case 'point': {
      const env = Math.sin(norm * Math.PI);
      slots.rightUpperArm = { x: -1.45 * env, y: 0, z: -0.15 * env };
      slots.rightForearm = { x: 0, y: 0, z: 0 };
      slots.head = { x: 0, y: -0.15 * env, z: 0 };
      break;
    }
    case 'clap': {
      const clapBeat = Math.abs(Math.sin(cyc * 2.2));
      slots.leftUpperArm = { x: -0.65, y: 0.45 - clapBeat * 0.25, z: 0.1 };
      slots.rightUpperArm = { x: -0.65, y: -0.45 + clapBeat * 0.25, z: -0.1 };
      slots.leftForearm = { x: -0.95, y: 0, z: -0.3 + clapBeat * 0.3 };
      slots.rightForearm = { x: -0.95, y: 0, z: 0.3 - clapBeat * 0.3 };
      break;
    }
    case 'surprised': {
      const pop = Math.sin(norm * Math.PI);
      rootPosOffset.y = pop * 0.22;
      rootPosOffset.z = -pop * 0.18;
      rootRotOffset.x = -0.12 * pop;
      slots.leftUpperArm = { x: -0.9 * pop, y: 0, z: 0.7 * pop };
      slots.rightUpperArm = { x: -0.9 * pop, y: 0, z: -0.7 * pop };
      break;
    }
    default:
      break;
  }

  return { rootPosOffset, rootRotOffset, slotRotations: slots };
}

export function blendPresetDeltas(
  clips: {
    presetId: string;
    localTime: number;
    duration: number;
    speed: number;
    blendIn?: number;
    blendOut?: number;
    weight?: number;
  }[],
): MotionPresetPoseDelta {
  const rootPosOffset: Vec3 = { x: 0, y: 0, z: 0 };
  const rootRotOffset: Vec3 = { x: 0, y: 0, z: 0 };
  const slotRotations: Partial<Record<HumanoidSlot, Vec3>> = {};

  for (const clip of clips) {
    const blendIn = Math.max(0.05, clip.blendIn ?? 0.2);
    const blendOut = Math.max(0.05, clip.blendOut ?? 0.2);
    const inW = clamp(clip.localTime / blendIn, 0, 1);
    const outW = clamp((clip.duration - clip.localTime) / blendOut, 0, 1);
    const w = Math.min(inW, outW) * clamp(clip.weight ?? 1, 0, 1);
    if (w <= 1e-4) continue;

    const delta = evaluateMotionPresetAtTime(clip.presetId, clip.localTime, clip.duration, clip.speed);
    addVec(rootPosOffset, delta.rootPosOffset, w);
    addVec(rootRotOffset, delta.rootRotOffset, w);
    for (const [slot, rot] of Object.entries(delta.slotRotations) as [HumanoidSlot, Vec3][]) {
      if (!slotRotations[slot]) slotRotations[slot] = { x: 0, y: 0, z: 0 };
      addVec(slotRotations[slot]!, rot, w);
    }
  }

  return { rootPosOffset, rootRotOffset, slotRotations };
}

/* ---------- Smart Animation Assistant & External AI Provider Interface ---------- */

export interface AnimationSuggestion {
  id: string;
  severity: 'tip' | 'warning';
  title: string;
  detail: string;
  actionLabel?: string;
  actionKind?: 'add-walk' | 'enable-orient' | 'add-camera-key' | 'smooth-keys';
  targetCharacterId?: string;
}

export interface AiAssistantProvider {
  readonly id: string;
  readonly label: string;
  readonly isConfigured: boolean;
  getStatusMessage(): string;
  suggestSceneImprovements(scene: SceneData, selectedChar?: CharacterInstanceData | null): AnimationSuggestion[];
}

/**
 * Deterministic local Smart Animation Assistant that analyzes scene keyframes,
 * motion paths, overlapping action clips, rig compatibility, and camera framing.
 */
export class LocalSmartAnimationAssistant implements AiAssistantProvider {
  readonly id = 'local-rules';
  readonly label = 'Built-in Smart Assistant (Local)';
  readonly isConfigured = true;

  getStatusMessage(): string {
    return 'Local rule-based animation assistant active (works offline).';
  }

  suggestSceneImprovements(
    scene: SceneData,
    selectedChar?: CharacterInstanceData | null,
    rigReport?: RigCompatibilityReport | null,
  ): AnimationSuggestion[] {
    const out: AnimationSuggestion[] = [];
    const target = selectedChar ?? scene.characters[0] ?? null;

    if (target) {
      // 1. Long motion path without walk cycle
      if (target.motionPath.enabled && target.motionPath.points.length >= 2) {
        let totalLen = 0;
        for (let i = 0; i < target.motionPath.points.length - 1; i++) {
          const a = target.motionPath.points[i].position;
          const b = target.motionPath.points[i + 1].position;
          totalLen += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        }
        const hasWalk = target.actionClips.some((c) => c.actionId === 'walk' || c.actionId === 'run');
        if (totalLen > 1.8 && !hasWalk) {
          out.push({
            id: `sug_walk_${target.id}`,
            severity: 'tip',
            title: `Add Walk animation along ${target.name}'s path`,
            detail: `${target.name} travels ${totalLen.toFixed(1)}m along a curve without a Walk/Run clip.`,
            actionLabel: 'Apply Walk Clip',
            actionKind: 'add-walk',
            targetCharacterId: target.id,
          });
        }
        if (!target.motionPath.orientAlongPath && totalLen > 1.2) {
          out.push({
            id: `sug_orient_${target.id}`,
            severity: 'tip',
            title: `Face forward along curve`,
            detail: `Enable "Face direction along path" so ${target.name} turns naturally on bends.`,
            actionLabel: 'Enable Path Orientation',
            actionKind: 'enable-orient',
            targetCharacterId: target.id,
          });
        }
      }

      // 2. Overlapping gesture clips warning
      const sortedActs = [...target.actionClips].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < sortedActs.length - 1; i++) {
        const a = sortedActs[i];
        const b = sortedActs[i + 1];
        if (a.kind !== 'mood' && b.kind !== 'mood' && a.startTime + a.duration > b.startTime + 0.05) {
          out.push({
            id: `sug_overlap_${a.id}_${b.id}`,
            severity: 'warning',
            title: `Overlapping action clips on ${target.name}`,
            detail: `"${a.label}" overlaps "${b.label}" at ${b.startTime.toFixed(1)}s. Consider crossfading or spacing them.`,
          });
          break;
        }
      }

      // 3. Single keyframe reminder
      if (target.positionKeyframes.length === 1) {
        out.push({
          id: `sug_single_kf_${target.id}`,
          severity: 'tip',
          title: `Single position keyframe on ${target.name}`,
          detail: `Scrub to another timestamp, move ${target.name}, and add a second keyframe to animate.`,
        });
      }

      // 4. Linear / abrupt transition hint
      if (target.positionKeyframes.some((k) => k.easing === 'linear' || k.easing === 'step')) {
        out.push({
          id: `sug_smooth_${target.id}`,
          severity: 'tip',
          title: `Abrupt keyframe easing detected`,
          detail: `Some keyframes on ${target.name} use Linear/Step curves. Switch to Smooth or Ease In & Out for organic motion.`,
          actionLabel: 'Smooth Keyframes',
          actionKind: 'smooth-keys',
          targetCharacterId: target.id,
        });
      }

      // 5. Rig compatibility advice
      if (rigReport && rigReport.rigKind === 'rigid') {
        out.push({
          id: `sug_rig_${target.id}`,
          severity: 'tip',
          title: `Rigid rig detected on ${target.name}`,
          detail: `Limb IK is unavailable on single-body rigs; use Jump, Look Around, Turn, Motion Paths, and Expressions instead.`,
        });
      }
    }

    // 6. Static camera suggestion
    if (scene.characters.length > 0 && scene.camera.keyframes.length === 0) {
      out.push({
        id: 'sug_cam_move',
        severity: 'tip',
        title: 'Add a subtle camera push or pan',
        detail: 'Keyframing the Scene Camera at 0s and end of scene gives cartoons cinematic depth.',
        actionLabel: 'Key Camera @ Current Time',
        actionKind: 'add-camera-key',
      });
    }

    return out;
  }
}

export class UnconfiguredExternalAiProvider implements AiAssistantProvider {
  readonly id = 'external-ai';
  readonly label = 'External AI Choreographer (Unconfigured)';
  readonly isConfigured = false;

  getStatusMessage(): string {
    return 'Not connected: No external AI provider API key or endpoint is configured. Using local Smart Assistant instead.';
  }

  suggestSceneImprovements(): AnimationSuggestion[] {
    return [];
  }
}

/**
 * Generates compact, context-aware Tab-autocomplete predictions tailored to the currently
 * selected character, body part/bone, rig capabilities, and timeline state.
 */
export function generateTabPredictions(params: {
  scene: SceneData;
  selectedChar?: CharacterInstanceData | null;
  selectedNode?: RigNodeInfo | null;
  rigReport?: RigCompatibilityReport | null;
  currentTime: number;
}): TabPrediction[] {
  const { scene, selectedChar, selectedNode, rigReport, currentTime } = params;
  const target = selectedChar ?? scene.characters[0] ?? null;
  const predictions: TabPrediction[] = [];

  if (!target) {
    predictions.push({
      id: 'tab_no_char_frame',
      title: 'Frame Scene Overview',
      reason: 'No character selected — frame all stage objects cleanly.',
      category: 'camera',
      compatible: true,
      applyKind: 'camera-frame',
    });
    return predictions;
  }

  const isRigid = rigReport?.rigKind === 'rigid';
  const hasLimbs = Boolean(
    rigReport
      ? rigReport.supportsArmIk || rigReport.supportsLegIk
      : Object.keys(target.boneMap ?? {}).some((k) => k.includes('Arm') || k.includes('Thigh')),
  );

  // 1. Body-part specific pose continuations
  if (selectedNode) {
    const slot = selectedNode.slot;
    if (slot === 'leftUpperArm' || slot === 'rightUpperArm') {
      const sign = slot === 'leftUpperArm' ? 1 : -1;
      predictions.push({
        id: `tab_pose_raise_${selectedNode.nodeId}`,
        title: `Raise ${selectedNode.name} (Gesture Pose)`,
        reason: 'Lifts shoulder naturally forward & outward while keeping joint attached.',
        category: 'pose',
        compatible: true,
        applyKind: 'bone-pose',
        payload: {
          targetCharacterId: target.id,
          nodeId: selectedNode.nodeId,
          nodeRotations: { [selectedNode.nodeId]: { x: -0.95, y: 0.15 * sign, z: 0.42 * sign } },
        },
      });
    } else if (slot === 'leftForearm' || slot === 'rightForearm') {
      predictions.push({
        id: `tab_pose_bend_${selectedNode.nodeId}`,
        title: `Bend ${selectedNode.name} (65° Elbow)`,
        reason: 'Natural conversational elbow bend around hinge axis.',
        category: 'pose',
        compatible: true,
        applyKind: 'bone-pose',
        payload: {
          targetCharacterId: target.id,
          nodeId: selectedNode.nodeId,
          nodeRotations: { [selectedNode.nodeId]: { x: -1.12, y: 0, z: 0 } },
        },
      });
    } else if (slot === 'head') {
      predictions.push({
        id: `tab_pose_head_tilt_${selectedNode.nodeId}`,
        title: 'Friendly Head Tilt & Nod',
        reason: 'Adds expressive head tilt while keeping neck socket aligned.',
        category: 'pose',
        compatible: true,
        applyKind: 'bone-pose',
        payload: {
          targetCharacterId: target.id,
          nodeId: selectedNode.nodeId,
          nodeRotations: { [selectedNode.nodeId]: { x: -0.08, y: 0.24, z: 0.14 } },
        },
      });
    } else if (slot === 'leftThigh' || slot === 'rightThigh') {
      predictions.push({
        id: `tab_pose_stride_${selectedNode.nodeId}`,
        title: `Stride Forward (${selectedNode.name})`,
        reason: 'Swings leg forward from hip joint for walk/step blocking.',
        category: 'pose',
        compatible: true,
        applyKind: 'bone-pose',
        payload: {
          targetCharacterId: target.id,
          nodeId: selectedNode.nodeId,
          nodeRotations: { [selectedNode.nodeId]: { x: -0.55, y: 0, z: 0 } },
        },
      });
    } else {
      predictions.push({
        id: `tab_pose_accent_${selectedNode.nodeId}`,
        title: `Tilt ${selectedNode.name} (+18°)`,
        reason: 'Applies clean local rotational accent and sets a bone keyframe.',
        category: 'pose',
        compatible: true,
        applyKind: 'bone-pose',
        payload: {
          targetCharacterId: target.id,
          nodeId: selectedNode.nodeId,
          nodeRotations: { [selectedNode.nodeId]: { x: 0.12, y: 0.18, z: 0.31 } },
        },
      });
    }

    predictions.push({
      id: `tab_pose_reset_${selectedNode.nodeId}`,
      title: `Reset ${selectedNode.name} to Neutral`,
      reason: 'Keys this joint cleanly back to its rest orientation.',
      category: 'pose',
      compatible: true,
      applyKind: 'bone-pose',
      payload: {
        targetCharacterId: target.id,
        nodeId: selectedNode.nodeId,
        nodeRotations: { [selectedNode.nodeId]: { x: 0, y: 0, z: 0 } },
      },
    });
  }

  // 2. Motion-path & locomotion awareness
  if (target.motionPath.enabled && target.motionPath.points.length >= 2) {
    const hasWalk = target.actionClips.some((c) => c.actionId === 'walk' || c.actionId === 'run');
    if (!hasWalk) {
      if (hasLimbs && !isRigid) {
        predictions.push({
          id: `tab_walk_path_${target.id}`,
          title: `Add Walk Cycle Along ${target.name}'s Path`,
          reason: 'Syncs alternating arm & leg stride across the active motion path.',
          category: 'motion',
          compatible: true,
          applyKind: 'motion-preset',
          payload: {
            targetCharacterId: target.id,
            presetId: 'walk',
            duration: Math.max(1.2, target.motionPath.duration),
          },
        });
      } else {
        predictions.push({
          id: `tab_walk_incompat_${target.id}`,
          title: 'Walk Cycle (Limbs Required)',
          reason: 'Humanoid limb stride cannot drive a single-body rig.',
          category: 'rig-fallback',
          compatible: false,
          incompatibilityReason: `${target.name} uses a ${rigReport?.rigKind ?? 'rigid'} rig without mapped leg/arm bones. Use Floating Hop or Turn instead.`,
          applyKind: 'none',
        });
        predictions.push({
          id: `tab_hop_fallback_${target.id}`,
          title: `Add Floating Hop Along ${target.name}'s Path`,
          reason: 'Rig-safe vertical anticipation & arc compatible with single-body rigs.',
          category: 'rig-fallback',
          compatible: true,
          applyKind: 'motion-preset',
          payload: {
            targetCharacterId: target.id,
            presetId: 'jump',
            duration: Math.min(2.0, Math.max(0.8, target.motionPath.duration)),
          },
        });
      }
    }
  }

  // 3. Follow-through & anticipation keyframes
  if (target.positionKeyframes.length >= 1) {
    const settleTime = Math.min(scene.duration, Number((currentTime + 0.5).toFixed(2)));
    predictions.push({
      id: `tab_follow_through_${target.id}`,
      title: `Follow-Through Settle (+0.5s @ ${settleTime.toFixed(1)}s)`,
      reason: 'Adds a soft ease-out settle keyframe ahead of the playhead.',
      category: 'keyframe',
      compatible: true,
      applyKind: 'follow-through',
      payload: {
        targetCharacterId: target.id,
        duration: 0.5,
        easing: 'easeOut',
        rootOffset: { x: 0, y: 0.06, z: 0 },
      },
    });
  } else {
    predictions.push({
      id: `tab_start_key_${target.id}`,
      title: `Key ${target.name} Transform @ ${currentTime.toFixed(1)}s`,
      reason: 'Locks current position & rotation on the timeline before next pose.',
      category: 'keyframe',
      compatible: true,
      applyKind: 'add-keyframe',
      payload: {
        targetCharacterId: target.id,
        easing: 'easeInOut',
      },
    });
  }

  // 4. Expressive clip suggestion matched to rig capability
  if (hasLimbs && !isRigid) {
    predictions.push({
      id: `tab_wave_${target.id}`,
      title: 'Insert Wave Greeting Clip',
      reason: 'Raises right arm & forearm in a smooth 1.6s wave.',
      category: 'motion',
      compatible: true,
      applyKind: 'motion-preset',
      payload: {
        targetCharacterId: target.id,
        presetId: 'wave',
        duration: 1.6,
      },
    });
  } else {
    predictions.push({
      id: `tab_look_around_${target.id}`,
      title: 'Insert Look Around Expressive Clip',
      reason: 'Curiously scans left & right — works smoothly on non-humanoid rigs.',
      category: 'motion',
      compatible: true,
      applyKind: 'motion-preset',
      payload: {
        targetCharacterId: target.id,
        presetId: 'lookAround',
        duration: 2.0,
      },
    });
  }

  return predictions;
}
