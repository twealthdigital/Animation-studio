import type {
  FacialState,
  HumanoidSlot,
  MotionPathData,
  ProjectData,
  SceneCameraItem,
  SceneData,
  SceneLightData,
  Transform3D,
  Vec3,
} from './types';
import { createDefaultCameraPose, createDefaultFacialState, createDefaultMotionPath } from './types';

function ensureVec3(v: Partial<Vec3> | undefined, fallback: Vec3): Vec3 {
  return {
    x: typeof v?.x === 'number' && Number.isFinite(v.x) ? v.x : fallback.x,
    y: typeof v?.y === 'number' && Number.isFinite(v.y) ? v.y : fallback.y,
    z: typeof v?.z === 'number' && Number.isFinite(v.z) ? v.z : fallback.z,
  };
}

export function ensureTransform(t: Partial<Transform3D> | undefined): Transform3D {
  return {
    position: ensureVec3(t?.position, { x: 0, y: 0, z: 0 }),
    rotation: ensureVec3(t?.rotation, { x: 0, y: 0, z: 0 }),
    scale: ensureVec3(t?.scale, { x: 1, y: 1, z: 1 }),
  };
}

export function ensureMotionPath(mp: Partial<MotionPathData> | undefined): MotionPathData {
  const def = createDefaultMotionPath();
  return {
    enabled: Boolean(mp?.enabled),
    startTime: typeof mp?.startTime === 'number' ? mp.startTime : def.startTime,
    duration: typeof mp?.duration === 'number' ? Math.max(0.1, mp.duration) : def.duration,
    orientAlongPath: Boolean(mp?.orientAlongPath),
    curveType: mp?.curveType ?? 'cubic',
    closed: Boolean(mp?.closed),
    banking: typeof mp?.banking === 'number' ? mp.banking : 0,
    lookAtTargetId: mp?.lookAtTargetId ?? null,
    speedMultiplier: typeof mp?.speedMultiplier === 'number' ? mp.speedMultiplier : 1,
    scrubProgress: typeof mp?.scrubProgress === 'number' ? mp.scrubProgress : null,
    points:
      Array.isArray(mp?.points) && mp.points.length >= 2
        ? mp.points.map((pt, idx) => ({
            id: pt.id || `pt_${idx}`,
            position: ensureVec3(pt.position, { x: 0, y: 0, z: 0 }),
            handleIn: ensureVec3(pt.handleIn, { x: -0.5, y: 0, z: 0 }),
            handleOut: ensureVec3(pt.handleOut, { x: 0.5, y: 0, z: 0 }),
            smooth: pt.smooth !== false,
          }))
        : def.points,
  };
}

export function createDefaultSceneLights(): SceneLightData[] {
  return [
    {
      id: 'light_hemi_default',
      name: 'Ambient Hemisphere',
      kind: 'ambient',
      color: '#cbe2ff',
      intensity: 0.75,
      position: { x: 0, y: 8, z: 0 },
      castShadow: false,
      visible: true,
    },
    {
      id: 'light_key_default',
      name: 'Key Directional',
      kind: 'directional',
      color: '#ffe6cc',
      intensity: 1.45,
      position: { x: 5, y: 9, z: 7 },
      target: { x: 0, y: 1, z: 0 },
      castShadow: true,
      visible: true,
    },
    {
      id: 'light_rim_default',
      name: 'Rim Directional',
      kind: 'directional',
      color: '#8bb8ff',
      intensity: 0.65,
      position: { x: -6, y: 4, z: -6 },
      target: { x: 0, y: 1, z: 0 },
      castShadow: false,
      visible: true,
    },
  ];
}

export function createDefaultCameraItem(scene: Partial<SceneData>): SceneCameraItem {
  const pose = scene.camera?.pose ?? createDefaultCameraPose();
  return {
    id: 'cam_main',
    name: 'Main Camera',
    projection: 'perspective',
    orthoSize: 6,
    pose: {
      position: ensureVec3(pose.position, createDefaultCameraPose().position),
      target: ensureVec3(pose.target, createDefaultCameraPose().target),
      fov: typeof pose.fov === 'number' ? pose.fov : 40,
    },
    keyframes: Array.isArray(scene.camera?.keyframes) ? scene.camera.keyframes : [],
  };
}

export function ensureFacialState(f: Partial<FacialState> | undefined): FacialState {
  const def = createDefaultFacialState();
  return {
    ...def,
    ...(f ?? {}),
    customMorphs: f?.customMorphs ? { ...f.customMorphs } : {},
  };
}

/**
 * Safely migrates legacy Stage 0-15 projects so all new Studio features (cameras, lights,
 * props, node/bone tracks, IK targets, facial tracks, work area, audio pitch/speed) work
 * seamlessly without losing existing scenes or keyframes.
 */
export function migrateProjectData(raw: ProjectData): ProjectData {
  const scenes: SceneData[] = (raw.scenes ?? []).map((sc) => {
    const primaryCamera = createDefaultCameraItem(sc);
    const cameras: SceneCameraItem[] =
      Array.isArray(sc.cameras) && sc.cameras.length > 0
        ? sc.cameras.map((cam, idx) => ({
            ...cam,
            id: cam.id || `cam_${idx}`,
            name: cam.name || `Camera ${idx + 1}`,
            projection: cam.projection ?? 'perspective',
            orthoSize: typeof cam.orthoSize === 'number' ? cam.orthoSize : 6,
            pose: {
              position: ensureVec3(cam.pose?.position, createDefaultCameraPose().position),
              target: ensureVec3(cam.pose?.target, createDefaultCameraPose().target),
              fov: typeof cam.pose?.fov === 'number' ? cam.pose.fov : 40,
            },
            keyframes: Array.isArray(cam.keyframes) ? cam.keyframes : [],
            motionPath: cam.motionPath ? ensureMotionPath(cam.motionPath) : undefined,
          }))
        : [primaryCamera];

    const activeCameraId =
      sc.activeCameraId && cameras.some((c) => c.id === sc.activeCameraId)
        ? sc.activeCameraId
        : cameras[0].id;

    return {
      ...sc,
      duration: typeof sc.duration === 'number' && sc.duration > 0 ? sc.duration : 10,
      backgroundColor: sc.backgroundColor || '#16181c',
      showGrid: sc.showGrid !== false,
      transition: sc.transition ?? 'cut',
      environmentPreset: sc.environmentPreset ?? 'studio-dark',
      workArea: sc.workArea ?? { enabled: false, start: 0, end: sc.duration || 10 },
      camera: sc.camera ?? {
        pose: cameras[0].pose,
        keyframes: cameras[0].keyframes,
      },
      cameras,
      activeCameraId,
      cameraSwitches: Array.isArray(sc.cameraSwitches) ? sc.cameraSwitches : [],
      lights:
        Array.isArray(sc.lights) && sc.lights.length > 0
          ? sc.lights
          : createDefaultSceneLights(),
      props: Array.isArray(sc.props)
        ? sc.props.map((pr) => ({
            ...pr,
            transform: ensureTransform(pr.transform),
            positionKeyframes: Array.isArray(pr.positionKeyframes) ? pr.positionKeyframes : [],
            rotationKeyframes: Array.isArray(pr.rotationKeyframes) ? pr.rotationKeyframes : [],
            scaleKeyframes: Array.isArray(pr.scaleKeyframes) ? pr.scaleKeyframes : [],
            motionPath: ensureMotionPath(pr.motionPath),
          }))
        : [],
      groups: Array.isArray(sc.groups)
        ? sc.groups.map((gr, idx) => ({
            ...gr,
            id: gr.id || `grp_${idx}`,
            name: gr.name || `Group ${idx + 1}`,
            visible: gr.visible !== false,
            locked: Boolean(gr.locked),
            memberIds: Array.isArray(gr.memberIds) ? gr.memberIds : [],
            transform: ensureTransform(gr.transform),
            pivot: ensureVec3(gr.pivot, { x: 0, y: 0, z: 0 }),
            positionKeyframes: Array.isArray(gr.positionKeyframes) ? gr.positionKeyframes : [],
            rotationKeyframes: Array.isArray(gr.rotationKeyframes) ? gr.rotationKeyframes : [],
            scaleKeyframes: Array.isArray(gr.scaleKeyframes) ? gr.scaleKeyframes : [],
          }))
        : [],
      characters: (sc.characters ?? []).map((ch) => ({
        ...ch,
        transform: ensureTransform(ch.transform),
        pivot: ensureVec3(ch.pivot, { x: 0, y: 0, z: 0 }),
        lockedProperties: ch.lockedProperties ?? { transform: false, keys: false },
        lockedNodes: Array.isArray(ch.lockedNodes) ? ch.lockedNodes : [],
        hiddenNodes: Array.isArray(ch.hiddenNodes) ? ch.hiddenNodes : [],
        nodeGroups: Array.isArray(ch.nodeGroups) ? ch.nodeGroups : [],
        nodeMaterialOverrides:
          ch.nodeMaterialOverrides && typeof ch.nodeMaterialOverrides === 'object'
            ? ch.nodeMaterialOverrides
            : {},
        positionKeyframes: Array.isArray(ch.positionKeyframes) ? ch.positionKeyframes : [],
        rotationKeyframes: Array.isArray(ch.rotationKeyframes) ? ch.rotationKeyframes : [],
        scaleKeyframes: Array.isArray(ch.scaleKeyframes) ? ch.scaleKeyframes : [],
        nodeTracks: Array.isArray(ch.nodeTracks)
          ? ch.nodeTracks.map((nt) => ({
              ...nt,
              positionKeyframes: Array.isArray(nt.positionKeyframes) ? nt.positionKeyframes : [],
              rotationKeyframes: Array.isArray(nt.rotationKeyframes) ? nt.rotationKeyframes : [],
              scaleKeyframes: Array.isArray(nt.scaleKeyframes) ? nt.scaleKeyframes : [],
            }))
          : [],
        boneMap: (ch.boneMap ?? {}) as Partial<Record<HumanoidSlot, string>>,
        ikTargets: Array.isArray(ch.ikTargets) ? ch.ikTargets : [],
        savedPoses: Array.isArray(ch.savedPoses) ? ch.savedPoses : [],
        facialState: ensureFacialState(ch.facialState),
        facialKeyframes: Array.isArray(ch.facialKeyframes) ? ch.facialKeyframes : [],
        motionPath: ensureMotionPath(ch.motionPath),
        actionClips: Array.isArray(ch.actionClips) ? ch.actionClips : [],
        audioProfile: {
          voiceLabel: ch.audioProfile?.voiceLabel || `${ch.name} Voice`,
          providerId: ch.audioProfile?.providerId ?? 'webspeech',
          pitch: typeof ch.audioProfile?.pitch === 'number' ? ch.audioProfile.pitch : 1,
          speed: typeof ch.audioProfile?.speed === 'number' ? ch.audioProfile.speed : 1,
          defaultVolume:
            typeof ch.audioProfile?.defaultVolume === 'number'
              ? ch.audioProfile.defaultVolume
              : 1,
          muted: Boolean(ch.audioProfile?.muted),
          pan: typeof ch.audioProfile?.pan === 'number' ? ch.audioProfile.pan : 0,
        },
      })),
      audioClips: Array.isArray(sc.audioClips) ? sc.audioClips : [],
    };
  });

  return {
    ...raw,
    fps: typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : 30,
    scenes,
    activeSceneId:
      raw.activeSceneId && scenes.some((s) => s.id === raw.activeSceneId)
        ? raw.activeSceneId
        : (scenes[0]?.id ?? ''),
  };
}
