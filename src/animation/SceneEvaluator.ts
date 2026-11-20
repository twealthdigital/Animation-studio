import type {
  ActionClip,
  CameraPose,
  FacialState,
  HumanoidSlot,
  SceneCameraItem,
  SceneData,
  SceneLightData,
  ScenePropData,
  Transform3D,
  Vec3,
} from '../core/types';
import { createDefaultFacialState } from '../core/types';
import {
  evaluateCameraTrack,
  evaluateFacialTrack,
  evaluateNumberTrack,
  evaluateVec3Track,
} from './Interpolation';
import { evaluateMotionPathAtTime } from './MotionPath';
import { blendPresetDeltas } from './MotionPresets';
import { solveHeadLookAtRotation, solveTwoBoneLimbIk } from './IkSolver';
import { composeTransforms } from '../core/GroupUtils';

export interface EvaluatedGroupState {
  groupId: string;
  transform: Transform3D;
  visible: boolean;
  memberIds: string[];
}

export interface EvaluatedCharacterState {
  instanceId: string;
  transform: Transform3D;
  nodeRotations: Record<string, Vec3>;
  nodePositions: Record<string, Vec3>;
  nodeScales: Record<string, Vec3>;
  slotDeltaRotations: Partial<Record<HumanoidSlot, Vec3>>;
  activeActions: ActionClip[];
  activeMood: string;
  facial: FacialState;
  isTalking: boolean;
}

export interface EvaluatedPropState {
  propId: string;
  transform: Transform3D;
  visible: boolean;
  parentAttachment?: ScenePropData['parentAttachment'];
}

export interface EvaluatedLightState {
  light: SceneLightData;
  intensity: number;
}

export interface EvaluatedSceneState {
  time: number;
  activeCameraId: string;
  activeCameraProjection: 'perspective' | 'orthographic';
  activeCameraOrthoSize: number;
  camera: CameraPose;
  cameras: Map<string, CameraPose>;
  groups: Map<string, EvaluatedGroupState>;
  characters: Map<string, EvaluatedCharacterState>;
  props: Map<string, EvaluatedPropState>;
  lights: Map<string, EvaluatedLightState>;
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function evaluateSingleCamera(cam: SceneCameraItem, time: number): CameraPose {
  const pose = evaluateCameraTrack(cam.keyframes, time, cam.pose);
  if (cam.motionPath?.enabled && cam.motionPath.points.length >= 2) {
    const sample = evaluateMotionPathAtTime(cam.motionPath, time);
    if (sample) {
      pose.position = { ...sample.position };
    }
  }
  return pose;
}

/**
 * Pure deterministic evaluation of the unified scene model at any timeline timestamp:
 * - Multi-camera & camera switches & camera motion paths
 * - Characters (root transform, motion paths w/ banking & look-at, node/bone keyframes,
 *   blended motion presets, 2-bone IK & head look-at IK, facial track + lip sync)
 * - Props (keyframes, motion paths, parent-child attachment metadata)
 * - Scene Lights (editable + animated intensity)
 */
export function evaluateSceneAtTime(scene: SceneData, time: number): EvaluatedSceneState {
  // 1. Evaluate all cameras + camera switch timeline
  const camerasMap = new Map<string, CameraPose>();
  const sceneCameras: SceneCameraItem[] =
    scene.cameras && scene.cameras.length > 0
      ? scene.cameras
      : [
          {
            id: 'cam_main',
            name: 'Main Camera',
            projection: 'perspective',
            orthoSize: 6,
            pose: scene.camera.pose,
            keyframes: scene.camera.keyframes,
          },
        ];

  for (const cam of sceneCameras) {
    // Sync main camera fallback keyframes if scene.camera was edited directly
    const camItem: SceneCameraItem =
      cam.id === sceneCameras[0].id && scene.camera
        ? {
            ...cam,
            pose: scene.camera.pose,
            keyframes: scene.camera.keyframes.length > 0 ? scene.camera.keyframes : cam.keyframes,
          }
        : cam;
    camerasMap.set(cam.id, evaluateSingleCamera(camItem, time));
  }

  let activeCameraId = scene.activeCameraId && camerasMap.has(scene.activeCameraId)
    ? scene.activeCameraId
    : sceneCameras[0].id;

  if (scene.cameraSwitches && scene.cameraSwitches.length > 0) {
    const triggered = [...scene.cameraSwitches]
      .filter((sw) => time >= sw.time && camerasMap.has(sw.cameraId))
      .sort((a, b) => a.time - b.time);
    if (triggered.length > 0) {
      activeCameraId = triggered[triggered.length - 1].cameraId;
    }
  }

  const activeCameraObj = sceneCameras.find((c) => c.id === activeCameraId) ?? sceneCameras[0];
  const camera = camerasMap.get(activeCameraId) ?? evaluateCameraTrack(scene.camera.keyframes, time, scene.camera.pose);

  // Evaluate logical scene groups
  const groups = new Map<string, EvaluatedGroupState>();
  const memberToGroup = new Map<string, EvaluatedGroupState>();
  for (const grp of scene.groups ?? []) {
    const grpState: EvaluatedGroupState = {
      groupId: grp.id,
      transform: {
        position: evaluateVec3Track(grp.positionKeyframes, time, grp.transform.position, false),
        rotation: evaluateVec3Track(grp.rotationKeyframes, time, grp.transform.rotation, true),
        scale: evaluateVec3Track(grp.scaleKeyframes, time, grp.transform.scale, false),
      },
      visible: grp.visible,
      memberIds: grp.memberIds,
    };
    groups.set(grp.id, grpState);
    for (const mId of grp.memberIds) {
      memberToGroup.set(mId, grpState);
    }
  }

  // Build world-position lookup table for Look-At constraints (pre-pass on base transforms + groups)
  const worldLookup = new Map<string, Vec3>();
  for (const ch of scene.characters) {
    const localT: Transform3D = {
      position: evaluateVec3Track(ch.positionKeyframes, time, ch.transform.position, false),
      rotation: evaluateVec3Track(ch.rotationKeyframes, time, ch.transform.rotation, true),
      scale: evaluateVec3Track(ch.scaleKeyframes, time, ch.transform.scale, false),
    };
    const grp = memberToGroup.get(ch.id);
    worldLookup.set(ch.id, (grp ? composeTransforms(grp.transform, localT) : localT).position);
  }
  for (const pr of scene.props ?? []) {
    const localT: Transform3D = {
      position: evaluateVec3Track(pr.positionKeyframes, time, pr.transform.position, false),
      rotation: evaluateVec3Track(pr.rotationKeyframes, time, pr.transform.rotation, true),
      scale: evaluateVec3Track(pr.scaleKeyframes, time, pr.transform.scale, false),
    };
    const grp = memberToGroup.get(pr.id);
    worldLookup.set(pr.id, (grp ? composeTransforms(grp.transform, localT) : localT).position);
  }

  // 2. Evaluate characters
  const characters = new Map<string, EvaluatedCharacterState>();
  for (const char of scene.characters) {
    const position = evaluateVec3Track(char.positionKeyframes, time, char.transform.position, false);
    const rotation = evaluateVec3Track(char.rotationKeyframes, time, char.transform.rotation, true);
    const scale = evaluateVec3Track(char.scaleKeyframes, time, char.transform.scale, false);

    // Motion path overrides position (and optionally Y rotation + banking + lookAt)
    if (char.motionPath.enabled && char.motionPath.points.length >= 2) {
      const sample = evaluateMotionPathAtTime(char.motionPath, time);
      if (sample) {
        position.x = sample.position.x;
        position.y = sample.position.y;
        position.z = sample.position.z;
        if (char.motionPath.lookAtTargetId && worldLookup.has(char.motionPath.lookAtTargetId)) {
          const targetPos = worldLookup.get(char.motionPath.lookAtTargetId)!;
          rotation.y = Math.atan2(targetPos.x - position.x, targetPos.z - position.z);
        } else if (char.motionPath.orientAlongPath) {
          rotation.y = sample.headingYaw;
          rotation.z += sample.bankRoll;
        }
      }
    }

    const activeActions = char.actionClips.filter(
      (clip) => time >= clip.startTime && time <= clip.startTime + clip.duration,
    );

    // Evaluate blended motion presets (any clip with kind === 'preset' OR procedural loop actions)
    const presetClips = activeActions
      .filter((clip) => clip.kind === 'preset')
      .map((clip) => ({
        presetId: clip.actionId,
        localTime: Math.max(0, time - clip.startTime),
        duration: clip.duration,
        speed: clip.speed,
        blendIn: clip.blendIn,
        blendOut: clip.blendOut,
        weight: clip.weight,
      }));
    const presetDelta = blendPresetDeltas(presetClips);
    position.x += presetDelta.rootPosOffset.x;
    position.y += presetDelta.rootPosOffset.y;
    position.z += presetDelta.rootPosOffset.z;
    rotation.x += presetDelta.rootRotOffset.x;
    rotation.y += presetDelta.rootRotOffset.y;
    rotation.z += presetDelta.rootRotOffset.z;

    // Evaluate per-node / bone keyframe tracks
    const nodeRotations: Record<string, Vec3> = {};
    const nodePositions: Record<string, Vec3> = {};
    const nodeScales: Record<string, Vec3> = {};
    for (const track of char.nodeTracks ?? []) {
      if (track.rotationKeyframes.length > 0) {
        nodeRotations[track.nodeId] = evaluateVec3Track(
          track.rotationKeyframes,
          time,
          { x: 0, y: 0, z: 0 },
          true,
        );
      }
      if (track.positionKeyframes.length > 0) {
        nodePositions[track.nodeId] = evaluateVec3Track(
          track.positionKeyframes,
          time,
          { x: 0, y: 0, z: 0 },
          false,
        );
      }
      if (track.scaleKeyframes && track.scaleKeyframes.length > 0) {
        nodeScales[track.nodeId] = evaluateVec3Track(
          track.scaleKeyframes,
          time,
          { x: 1, y: 1, z: 1 },
          false,
        );
      }
    }

    // Apply mapped slot deltas from motion presets onto mapped nodes
    const boneMap = char.boneMap ?? {};
    for (const [slot, delta] of Object.entries(presetDelta.slotRotations) as [HumanoidSlot, Vec3][]) {
      const mappedNodeId = boneMap[slot];
      if (mappedNodeId) {
        const cur = nodeRotations[mappedNodeId] ?? { x: 0, y: 0, z: 0 };
        nodeRotations[mappedNodeId] = addVec3(cur, delta);
      }
    }

    // Apply enabled IK targets (2-bone arms/legs & look-at head)
    for (const ik of char.ikTargets ?? []) {
      if (!ik.enabled || ik.weight <= 0.01) continue;
      if (ik.chain === 'lookAt') {
        const headId = boneMap.head;
        if (headId) {
          const solved = solveHeadLookAtRotation({ x: 0, y: 2.2, z: 0 }, ik.target);
          const cur = nodeRotations[headId] ?? { x: 0, y: 0, z: 0 };
          nodeRotations[headId] = {
            x: cur.x + (solved.x - cur.x) * ik.weight,
            y: cur.y + (solved.y - cur.y) * ik.weight,
            z: cur.z + (solved.z - cur.z) * ik.weight,
          };
        }
      } else {
        const isLeft = ik.chain === 'leftArm' || ik.chain === 'leftLeg';
        const isArm = ik.chain === 'leftArm' || ik.chain === 'rightArm';
        const upperSlot: HumanoidSlot = isArm
          ? isLeft
            ? 'leftUpperArm'
            : 'rightUpperArm'
          : isLeft
            ? 'leftThigh'
            : 'rightThigh';
        const lowerSlot: HumanoidSlot = isArm
          ? isLeft
            ? 'leftForearm'
            : 'rightForearm'
          : isLeft
            ? 'leftShin'
            : 'rightShin';
        const upperId = boneMap[upperSlot];
        const lowerId = boneMap[lowerSlot];
        if (upperId && lowerId) {
          const rootPos: Vec3 = isArm
            ? { x: isLeft ? 0.8 : -0.8, y: 2.8, z: 0 }
            : { x: isLeft ? 0.4 : -0.4, y: 1.4, z: 0 };
          const solved = solveTwoBoneLimbIk({
            rootPos,
            upperLength: isArm ? 0.8 : 1.0,
            lowerLength: isArm ? 0.85 : 0.95,
            targetPos: ik.target,
            bendSign: isArm ? -1 : 1,
          });
          const curUp = nodeRotations[upperId] ?? { x: 0, y: 0, z: 0 };
          const curLo = nodeRotations[lowerId] ?? { x: 0, y: 0, z: 0 };
          nodeRotations[upperId] = {
            x: curUp.x + (solved.upperRotation.x - curUp.x) * ik.weight,
            y: curUp.y + (solved.upperRotation.y - curUp.y) * ik.weight,
            z: curUp.z + (solved.upperRotation.z - curUp.z) * ik.weight,
          };
          nodeRotations[lowerId] = {
            x: curLo.x + (solved.lowerRotation.x - curLo.x) * ik.weight,
            y: curLo.y + (solved.lowerRotation.y - curLo.y) * ik.weight,
            z: curLo.z + (solved.lowerRotation.z - curLo.z) * ik.weight,
          };
        }
      }
    }

    // Most recent mood clip up to current time, or character base mood
    let activeMood = char.currentMood;
    const moodClips = char.actionClips
      .filter((c) => c.kind === 'mood' && c.mood && time >= c.startTime)
      .sort((a, b) => a.startTime - b.startTime);
    if (moodClips.length > 0) {
      activeMood = moodClips[moodClips.length - 1].mood ?? activeMood;
    }

    const isTalking =
      !char.audioProfile.muted &&
      scene.audioClips.some(
        (clip) =>
          !clip.muted &&
          clip.role === 'dialogue' &&
          clip.characterInstanceId === char.id &&
          time >= clip.startTime &&
          time <= clip.startTime + clip.duration,
      );

    // Facial animation track + fallback procedural lip-sync mouth movement when talking
    const facial = evaluateFacialTrack(
      char.facialKeyframes ?? [],
      time,
      char.facialState ?? createDefaultFacialState(),
    );
    if (isTalking && facial.mouthOpen < 0.05) {
      facial.mouthOpen = 0.25 + 0.45 * Math.abs(Math.sin(time * 14));
      facial.jawOpen = facial.mouthOpen * 0.65;
    }

    const parentGrp = memberToGroup.get(char.id);
    const finalTransform = parentGrp
      ? composeTransforms(parentGrp.transform, { position, rotation, scale })
      : { position, rotation, scale };

    characters.set(char.id, {
      instanceId: char.id,
      transform: finalTransform,
      nodeRotations,
      nodePositions,
      nodeScales,
      slotDeltaRotations: presetDelta.slotRotations,
      activeActions,
      activeMood,
      facial,
      isTalking,
    });
  }

  // 3. Evaluate props
  const props = new Map<string, EvaluatedPropState>();
  for (const prop of scene.props ?? []) {
    const position = evaluateVec3Track(prop.positionKeyframes, time, prop.transform.position, false);
    const rotation = evaluateVec3Track(prop.rotationKeyframes, time, prop.transform.rotation, true);
    const scale = evaluateVec3Track(prop.scaleKeyframes, time, prop.transform.scale, false);

    if (prop.motionPath.enabled && prop.motionPath.points.length >= 2) {
      const sample = evaluateMotionPathAtTime(prop.motionPath, time);
      if (sample) {
        position.x = sample.position.x;
        position.y = sample.position.y;
        position.z = sample.position.z;
        if (prop.motionPath.orientAlongPath) {
          rotation.y = sample.headingYaw;
          rotation.z += sample.bankRoll;
        }
      }
    }

    const parentGrp = memberToGroup.get(prop.id);
    const finalTransform = parentGrp
      ? composeTransforms(parentGrp.transform, { position, rotation, scale })
      : { position, rotation, scale };

    props.set(prop.id, {
      propId: prop.id,
      transform: finalTransform,
      visible: prop.visible && (parentGrp ? parentGrp.visible : true),
      parentAttachment: prop.parentAttachment,
    });
  }

  // 4. Evaluate lights
  const lights = new Map<string, EvaluatedLightState>();
  for (const light of scene.lights ?? []) {
    const intensity = evaluateNumberTrack(light.intensityKeyframes ?? [], time, light.intensity);
    lights.set(light.id, { light, intensity });
  }

  return {
    time,
    activeCameraId,
    activeCameraProjection: activeCameraObj.projection,
    activeCameraOrthoSize: activeCameraObj.orthoSize ?? 6,
    camera,
    cameras: camerasMap,
    groups,
    characters,
    props,
    lights,
  };
}
