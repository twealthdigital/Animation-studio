import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type {
  CameraPose,
  EnvironmentPresetId,
  PropGeometryKind,
  SceneData,
  SceneLightData,
  ScenePropData,
  Vec3,
} from '../core/types';
import { createDefaultCameraPose, createDefaultMotionPath, createDefaultStageConfig, createDefaultTransform } from '../core/types';
import { createId } from '../utils/ids';

export interface EnvironmentPresetSpec {
  id: EnvironmentPresetId;
  label: string;
  backgroundColor: string;
  floorColor: string;
  lights: SceneLightData[];
}

export const ENVIRONMENT_PRESETS: EnvironmentPresetSpec[] = [
  {
    id: 'studio-dark',
    label: 'Studio Dark',
    backgroundColor: '#16181c',
    floorColor: '#1b1e24',
    lights: [
      { id: 'env_amb', name: 'Ambient Fill', kind: 'ambient', color: '#cbe2ff', intensity: 0.75, position: { x: 0, y: 8, z: 0 }, castShadow: false, visible: true },
      { id: 'env_key', name: 'Warm Key', kind: 'directional', color: '#ffe6cc', intensity: 1.45, position: { x: 5, y: 9, z: 7 }, target: { x: 0, y: 1, z: 0 }, castShadow: true, visible: true },
      { id: 'env_rim', name: 'Cool Rim', kind: 'directional', color: '#8bb8ff', intensity: 0.65, position: { x: -6, y: 4, z: -6 }, target: { x: 0, y: 1, z: 0 }, castShadow: false, visible: true },
    ],
  },
  {
    id: 'sunset-stage',
    label: 'Sunset Stage',
    backgroundColor: '#231618',
    floorColor: '#291c1e',
    lights: [
      { id: 'env_amb', name: 'Dusk Ambient', kind: 'ambient', color: '#ffbfa3', intensity: 0.65, position: { x: 0, y: 8, z: 0 }, castShadow: false, visible: true },
      { id: 'env_key', name: 'Golden Sun', kind: 'directional', color: '#ff9b54', intensity: 1.85, position: { x: 8, y: 6, z: 5 }, target: { x: 0, y: 1, z: 0 }, castShadow: true, visible: true },
      { id: 'env_rim', name: 'Violet Rim', kind: 'point', color: '#a855f7', intensity: 2.2, position: { x: -5, y: 4, z: -4 }, castShadow: false, distance: 20, visible: true },
    ],
  },
  {
    id: 'daylight-cyclorama',
    label: 'Daylight Cyclorama',
    backgroundColor: '#364454',
    floorColor: '#2d3743',
    lights: [
      { id: 'env_amb', name: 'Sky Ambient', kind: 'ambient', color: '#e6f2ff', intensity: 1.0, position: { x: 0, y: 10, z: 0 }, castShadow: false, visible: true },
      { id: 'env_key', name: 'Sun Key', kind: 'directional', color: '#fff9e8', intensity: 1.65, position: { x: 6, y: 12, z: 6 }, target: { x: 0, y: 1, z: 0 }, castShadow: true, visible: true },
    ],
  },
  {
    id: 'neon-night',
    label: 'Neon Night',
    backgroundColor: '#0e1018',
    floorColor: '#131622',
    lights: [
      { id: 'env_amb', name: 'Night Fill', kind: 'ambient', color: '#4f6d9a', intensity: 0.45, position: { x: 0, y: 8, z: 0 }, castShadow: false, visible: true },
      { id: 'env_spot', name: 'Stage Spot', kind: 'spot', color: '#ffffff', intensity: 2.6, position: { x: 0, y: 8, z: 4 }, target: { x: 0, y: 1.5, z: 0 }, castShadow: true, angle: 0.55, distance: 25, visible: true },
      { id: 'env_pt1', name: 'Cyan Accent', kind: 'point', color: '#22d3ee', intensity: 1.8, position: { x: -4, y: 3, z: 2 }, castShadow: false, distance: 15, visible: true },
      { id: 'env_pt2', name: 'Amber Accent', kind: 'point', color: '#f97316', intensity: 1.8, position: { x: 4, y: 3, z: 2 }, castShadow: false, distance: 15, visible: true },
    ],
  },
  {
    id: 'minimal-white',
    label: 'Bright Studio',
    backgroundColor: '#2c313a',
    floorColor: '#353b46',
    lights: [
      { id: 'env_amb', name: 'Softbox Ambient', kind: 'ambient', color: '#ffffff', intensity: 1.15, position: { x: 0, y: 8, z: 0 }, castShadow: false, visible: true },
      { id: 'env_key', name: 'Studio Key', kind: 'directional', color: '#ffffff', intensity: 1.25, position: { x: 4, y: 9, z: 6 }, target: { x: 0, y: 1, z: 0 }, castShadow: true, visible: true },
    ],
  },
];

export type CameraFramingPresetId =
  | 'wide'
  | 'medium'
  | 'closeup'
  | 'extreme-closeup'
  | 'ots'
  | 'establishing'
  | 'tracking';

export function computeCameraFramingPreset(
  preset: CameraFramingPresetId,
  subjectPos: Vec3 = { x: 0, y: 0, z: 0 },
): CameraPose {
  const sx = subjectPos.x;
  const sy = subjectPos.y;
  const sz = subjectPos.z;
  switch (preset) {
    case 'wide':
      return { position: { x: sx, y: sy + 3.0, z: sz + 13.5 }, target: { x: sx, y: sy + 1.8, z: sz }, fov: 44 };
    case 'medium':
      return { position: { x: sx + 0.5, y: sy + 2.4, z: sz + 7.2 }, target: { x: sx, y: sy + 2.0, z: sz }, fov: 38 };
    case 'closeup':
      return { position: { x: sx + 0.2, y: sy + 2.8, z: sz + 3.8 }, target: { x: sx, y: sy + 2.7, z: sz }, fov: 32 };
    case 'extreme-closeup':
      return { position: { x: sx, y: sy + 2.85, z: sz + 2.1 }, target: { x: sx, y: sy + 2.8, z: sz }, fov: 26 };
    case 'ots':
      return { position: { x: sx - 2.4, y: sy + 2.7, z: sz + 4.4 }, target: { x: sx + 1.4, y: sy + 2.1, z: sz - 0.5 }, fov: 36 };
    case 'establishing':
      return { position: { x: sx + 9.5, y: sy + 6.5, z: sz + 15.0 }, target: { x: sx, y: sy + 1.5, z: sz }, fov: 48 };
    case 'tracking':
      return { position: { x: sx + 4.5, y: sy + 2.3, z: sz + 6.0 }, target: { x: sx, y: sy + 1.8, z: sz }, fov: 40 };
    default:
      return createDefaultCameraPose();
  }
}

export const PROP_LIBRARY_ITEMS: { kind: PropGeometryKind; label: string; defaultColor: string }[] = [
  { kind: 'box', label: 'Crate / Block', defaultColor: '#d97706' },
  { kind: 'sphere', label: 'Ball / Sphere', defaultColor: '#e8702a' },
  { kind: 'cylinder', label: 'Pillar / Drum', defaultColor: '#64748b' },
  { kind: 'cone', label: 'Traffic Cone', defaultColor: '#f97316' },
  { kind: 'podium', label: 'Stage Podium', defaultColor: '#334155' },
  { kind: 'desk', label: 'Host Desk', defaultColor: '#475569' },
  { kind: 'chair', label: 'Studio Chair', defaultColor: '#1e293b' },
  { kind: 'lamp', label: 'Floor Lamp', defaultColor: '#facc15' },
  { kind: 'tree', label: 'Stylized Tree', defaultColor: '#22c55e' },
];

export function createPropData(kind: PropGeometryKind, label: string, color: string, x = 0, z = 0): ScenePropData {
  return {
    id: createId('prop'),
    name: label,
    kind,
    color,
    visible: true,
    transform: createDefaultTransform(x, 0, z),
    pivot: { x: 0, y: 0, z: 0 },
    positionKeyframes: [],
    rotationKeyframes: [],
    scaleKeyframes: [],
    motionPath: createDefaultMotionPath(),
    parentAttachment: null,
  };
}

export async function buildPropObject3D(
  prop: ScenePropData,
  glbBinary?: ArrayBuffer,
): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = prop.name;
  root.userData.propId = prop.id;

  const content = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(prop.color || '#e8702a'),
    roughness: 0.55,
    metalness: 0.15,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1f242d, roughness: 0.65, metalness: 0.25 });

  if (prop.kind === 'detached-part') {
    content.userData.isDetachedPartContainer = true;
  } else if (prop.kind === 'glb' && glbBinary) {
    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(glbBinary.slice(0), '', resolve, reject);
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    if (Number.isFinite(box.min.y)) gltf.scene.position.y -= box.min.y;
    content.add(gltf.scene);
  } else if (prop.kind === 'sphere') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 18), mat.clone());
    m.name = 'Sphere';
    m.position.y = 0.42;
    content.add(m);
  } else if (prop.kind === 'cylinder') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 20), mat.clone());
    m.name = 'Cylinder';
    m.position.y = 0.6;
    content.add(m);
  } else if (prop.kind === 'cone') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.7), darkMat.clone());
    base.name = 'Cone Base';
    base.position.y = 0.04;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.85, 18), mat.clone());
    cone.name = 'Cone Body';
    cone.position.y = 0.46;
    content.add(base, cone);
  } else if (prop.kind === 'podium') {
    const step1 = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.55, 0.28, 32), darkMat.clone());
    step1.name = 'Podium Platform';
    step1.position.y = 0.14;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.42, 2.42, 0.05, 32), mat.clone());
    rim.name = 'Podium Rim';
    rim.position.y = 0.27;
    content.add(step1, rim);
  } else if (prop.kind === 'desk') {
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.95), mat.clone());
    top.name = 'Desk Top';
    top.position.y = 1.05;
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.95, 0.78), darkMat.clone());
    body.name = 'Desk Base';
    body.position.y = 0.48;
    content.add(top, body);
  } else if (prop.kind === 'chair') {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.1, 0.75), mat.clone());
    seat.name = 'Chair Seat';
    seat.position.y = 0.65;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.8, 0.1), mat.clone());
    back.name = 'Chair Backrest';
    back.position.set(0, 1.05, -0.32);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 12), darkMat.clone());
    stem.name = 'Chair Stem';
    stem.position.y = 0.32;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 0.07, 16), darkMat.clone());
    base.name = 'Chair Base';
    base.position.y = 0.035;
    content.add(seat, back, stem, base);
  } else if (prop.kind === 'lamp') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.08, 16), darkMat.clone());
    base.name = 'Lamp Base';
    base.position.y = 0.04;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.3, 10), darkMat.clone());
    pole.name = 'Lamp Pole';
    pole.position.y = 1.18;
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.42, 0.45, 16),
      new THREE.MeshStandardMaterial({
        color: prop.color || '#facc15',
        emissive: new THREE.Color(prop.color || '#facc15'),
        emissiveIntensity: 0.35,
      }),
    );
    shade.name = 'Lamp Shade';
    shade.position.y = 2.35;
    content.add(base, pole, shade);
  } else if (prop.kind === 'tree') {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.26, 1.4, 10),
      new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 }),
    );
    trunk.name = 'Tree Trunk';
    trunk.position.y = 0.7;
    const crown1 = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.4, 10), mat.clone());
    crown1.name = 'Lower Foliage';
    crown1.position.y = 1.8;
    const crown2 = new THREE.Mesh(new THREE.ConeGeometry(0.72, 1.1, 10), mat.clone());
    crown2.name = 'Upper Foliage';
    crown2.position.y = 2.55;
    content.add(trunk, crown1, crown2);
  } else {
    // default box
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.85), mat.clone());
    m.name = 'Box';
    m.position.y = 0.425;
    content.add(m);
  }

  mat.dispose();
  darkMat.dispose();

  tagPropSubtree(content, prop.id, prop.name);

  if (prop.pivot) {
    content.position.set(-prop.pivot.x, -prop.pivot.y, -prop.pivot.z);
  }
  root.add(content);
  return root;
}

export function tagPropSubtree(root: THREE.Object3D, propId: string, propName: string): void {
  const visit = (obj: THREE.Object3D, path: string) => {
    obj.userData.propId = propId;
    obj.userData.propName = propName;
    obj.userData.propChildPath = path;
    delete obj.userData.characterInstanceId;
    delete obj.userData.rigNodeId;
    delete obj.userData.rigNodeName;
    delete obj.userData.componentGroupId;
    delete obj.userData.componentGroupName;
    delete obj.userData.__detachedHidden;
    if ((obj as THREE.Mesh).isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.frustumCulled = false;
    }
    obj.children.forEach((child, idx) => {
      visit(child, path ? `${path}/${idx}` : `${idx}`);
    });
  };
  visit(root, '');
}

export type SceneTemplateId = 'blank-stage' | 'talk-show' | 'outdoor-park' | 'spotlight-monologue';

export function buildSceneFromTemplate(templateId: SceneTemplateId, name: string): SceneData {
  const basePose = createDefaultCameraPose();
  if (templateId === 'talk-show') {
    const env = ENVIRONMENT_PRESETS[1];
    return {
      id: createId('scene'),
      name,
      duration: 12,
      backgroundColor: env.backgroundColor,
      showGrid: true,
      transition: 'fade',
      environmentPreset: 'sunset-stage',
      stageConfig: createDefaultStageConfig(env.floorColor),
      workArea: { enabled: false, start: 0, end: 12 },
      camera: { pose: computeCameraFramingPreset('wide'), keyframes: [] },
      cameras: [
        { id: 'cam_main', name: 'Wide Stage', projection: 'perspective', pose: computeCameraFramingPreset('wide'), keyframes: [] },
        { id: 'cam_cu', name: 'Host Close-Up', projection: 'perspective', pose: computeCameraFramingPreset('closeup', { x: 1.5, y: 0, z: 0 }), keyframes: [] },
      ],
      activeCameraId: 'cam_main',
      cameraSwitches: [],
      lights: JSON.parse(JSON.stringify(env.lights)),
      props: [
        createPropData('podium', 'Stage Podium', '#334155', 0, 0),
        createPropData('desk', 'Host Desk', '#475569', 1.6, 0.6),
        createPropData('lamp', 'Stage Lamp', '#facc15', -3.6, -1.5),
      ],
      characters: [],
      audioClips: [],
    };
  }
  if (templateId === 'outdoor-park') {
    const env = ENVIRONMENT_PRESETS[2];
    return {
      id: createId('scene'),
      name,
      duration: 12,
      backgroundColor: env.backgroundColor,
      showGrid: true,
      transition: 'cut',
      environmentPreset: 'daylight-cyclorama',
      stageConfig: {
        ...createDefaultStageConfig(env.floorColor),
        showClouds: true,
        cloudColor: '#f1f5f9',
      },
      workArea: { enabled: false, start: 0, end: 12 },
      camera: { pose: computeCameraFramingPreset('establishing'), keyframes: [] },
      cameras: [{ id: 'cam_main', name: 'Establishing Cam', projection: 'perspective', pose: computeCameraFramingPreset('establishing'), keyframes: [] }],
      activeCameraId: 'cam_main',
      cameraSwitches: [],
      lights: JSON.parse(JSON.stringify(env.lights)),
      props: [
        createPropData('tree', 'Oak Tree L', '#22c55e', -4.2, -2.5),
        createPropData('tree', 'Oak Tree R', '#16a34a', 4.5, -2.8),
        createPropData('sphere', 'Soccer Ball', '#e8702a', 0, 1.4),
      ],
      characters: [],
      audioClips: [],
    };
  }
  if (templateId === 'spotlight-monologue') {
    const env = ENVIRONMENT_PRESETS[3];
    return {
      id: createId('scene'),
      name,
      duration: 10,
      backgroundColor: env.backgroundColor,
      showGrid: false,
      transition: 'fade',
      environmentPreset: 'neon-night',
      stageConfig: createDefaultStageConfig(env.floorColor),
      workArea: { enabled: false, start: 0, end: 10 },
      camera: { pose: computeCameraFramingPreset('medium'), keyframes: [] },
      cameras: [{ id: 'cam_main', name: 'Hero Cam', projection: 'perspective', pose: computeCameraFramingPreset('medium'), keyframes: [] }],
      activeCameraId: 'cam_main',
      cameraSwitches: [],
      lights: JSON.parse(JSON.stringify(env.lights)),
      props: [createPropData('podium', 'Center Spot Podium', '#e8702a', 0, 0)],
      characters: [],
      audioClips: [],
    };
  }

  const defEnv = ENVIRONMENT_PRESETS[0];
  return {
    id: createId('scene'),
    name,
    duration: 10,
    backgroundColor: defEnv.backgroundColor,
    showGrid: true,
    transition: 'cut',
    environmentPreset: 'studio-dark',
    stageConfig: createDefaultStageConfig(defEnv.floorColor),
    workArea: { enabled: false, start: 0, end: 10 },
    camera: { pose: basePose, keyframes: [] },
    cameras: [{ id: 'cam_main', name: 'Main Camera', projection: 'perspective', pose: basePose, keyframes: [] }],
    activeCameraId: 'cam_main',
    cameraSwitches: [],
    lights: JSON.parse(JSON.stringify(defEnv.lights)),
    props: [],
    characters: [],
    audioClips: [],
  };
}
