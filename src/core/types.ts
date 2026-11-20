export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BezierHandle2D {
  x: number; // 0..1 normalized segment time offset
  y: number; // normalized value offset
}

export interface Transform3D {
  position: Vec3;
  rotation: Vec3; // Euler radians
  scale: Vec3;
}

export type EasingType =
  | 'linear'
  | 'smooth'
  | 'step'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'bezier';

export interface NumberKeyframe {
  id: string;
  time: number;
  value: number;
  easing: EasingType;
  handleIn?: BezierHandle2D;
  handleOut?: BezierHandle2D;
}

export interface Vec3Keyframe {
  id: string;
  time: number;
  value: Vec3;
  easing: EasingType;
  handleIn?: BezierHandle2D;
  handleOut?: BezierHandle2D;
}

export type MotionPathCurveType = 'cubic' | 'quadratic' | 'catmullrom';

export interface MotionPathPoint {
  id: string;
  position: Vec3;
  handleIn: Vec3; // Relative offset from position
  handleOut: Vec3; // Relative offset from position
  smooth: boolean; // smooth mirrored tangent vs sharp corner
}

export interface MotionPathData {
  enabled: boolean;
  startTime: number;
  duration: number;
  orientAlongPath: boolean;
  curveType?: MotionPathCurveType;
  closed?: boolean;
  banking?: number; // 0..2 lean on turns
  lookAtTargetId?: string | null; // Optional character/prop ID to face while moving
  speedMultiplier?: number;
  scrubProgress?: number | null; // Manual 0..1 scrub override when testing
  points: MotionPathPoint[];
}

export type HumanoidSlot =
  | 'root'
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'jaw'
  | 'leftEye'
  | 'rightEye'
  | 'leftUpperArm'
  | 'leftForearm'
  | 'leftHand'
  | 'rightUpperArm'
  | 'rightForearm'
  | 'rightHand'
  | 'leftThigh'
  | 'leftShin'
  | 'leftFoot'
  | 'rightThigh'
  | 'rightShin'
  | 'rightFoot';

export interface RigNodeInfo {
  nodeId: string;
  name: string;
  parentId: string | null;
  type: 'group' | 'bone' | 'mesh' | 'skinned-mesh';
  slot?: HumanoidSlot;
  isAuxiliary?: boolean;
  description?: string;
  materials?: string[];
  childIds: string[];
  hasMorphTargets?: boolean;
  morphTargetNames?: string[];
  restPosition: Vec3;
  restRotation: Vec3;
}

export interface RigCompatibilityReport {
  rigKind: 'humanoid' | 'partial-humanoid' | 'generic' | 'rigid';
  mappedCount: number;
  totalNodes: number;
  mappedSlots: Partial<Record<HumanoidSlot, string>>;
  missingSlots: HumanoidSlot[];
  supportsArmIk: boolean;
  supportsLegIk: boolean;
  supportsHeadLookAt: boolean;
  notes: string[];
}

export interface NodeKeyframeTrack {
  nodeId: string;
  nodeName: string;
  rotationKeyframes: Vec3Keyframe[];
  positionKeyframes: Vec3Keyframe[];
  scaleKeyframes?: Vec3Keyframe[];
}

export interface NodeMaterialOverride {
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  opacity?: number;
}

export interface CharacterNodeGroup {
  id: string;
  name: string;
  memberNodeIds: string[];
  locked?: boolean;
  visible?: boolean;
}

export interface MultiSelectedNodeRef {
  instanceId: string;
  nodeId: string;
  nodeName: string;
}

export type IkChainType = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'lookAt';

export interface IkTargetData {
  id: string;
  chain: IkChainType;
  enabled: boolean;
  target: Vec3; // World/character-local offset target
  pole?: Vec3;
  weight: number; // 0 = full FK, 1 = full IK
}

export interface SavedPoseData {
  id: string;
  name: string;
  nodeRotations: Record<string, Vec3>;
}

export interface FacialState {
  blink: number; // 0..1
  eyeLookX: number; // -1..1
  eyeLookY: number; // -1..1
  browRaise: number; // -1..1
  mouthOpen: number; // 0..1
  jawOpen: number; // 0..1
  smile: number; // 0..1
  frown: number; // 0..1
  surprise: number; // 0..1
  anger: number; // 0..1
  sadness: number; // 0..1
  fear: number; // 0..1
  customMorphs: Record<string, number>;
}

export interface FacialKeyframe {
  id: string;
  time: number;
  state: FacialState;
  easing: EasingType;
}

export interface ActionClip {
  id: string;
  actionId: string;
  label: string;
  kind: 'gesture' | 'loop' | 'mood' | 'preset';
  startTime: number;
  duration: number;
  speed: number;
  blendIn?: number; // crossfade seconds
  blendOut?: number;
  weight?: number;
  mood?: string;
}

export type AudioTrackRole = 'dialogue' | 'music' | 'sfx' | 'ambient';

export interface AudioClipData {
  id: string;
  assetId: string;
  name: string;
  role: AudioTrackRole;
  characterInstanceId?: string;
  dialogueText?: string;
  startTime: number;
  duration: number;
  trimStart: number;
  volume: number; // 0..2
  fadeIn: number; // seconds
  fadeOut: number; // seconds
  muted: boolean;
  pauseAfterSec?: number;
  playbackRate?: number;
}

export interface CharacterAudioProfile {
  voiceLabel: string;
  providerId?: 'webspeech' | 'custom-hook' | 'audio-file';
  pitch?: number; // 0.5..2
  speed?: number; // 0.5..2
  defaultVolume: number;
  muted: boolean;
  pan: number; // -1..1
}

export interface CharacterInstanceData {
  id: string;
  assetId: string;
  name: string;
  visible: boolean;
  includeStageProps: boolean;
  playNativeLoop?: boolean;
  transform: Transform3D;
  pivot?: Vec3;
  lockedProperties?: { transform?: boolean; keys?: boolean };
  lockedNodes?: string[];
  hiddenNodes?: string[];
  detachedNodes?: string[];
  nodeGroups?: CharacterNodeGroup[];
  nodeMaterialOverrides?: Record<string, NodeMaterialOverride>;
  positionKeyframes: Vec3Keyframe[];
  rotationKeyframes: Vec3Keyframe[];
  scaleKeyframes: Vec3Keyframe[];
  nodeTracks?: NodeKeyframeTrack[];
  boneMap?: Partial<Record<HumanoidSlot, string>>;
  ikTargets?: IkTargetData[];
  savedPoses?: SavedPoseData[];
  facialState?: FacialState;
  facialKeyframes?: FacialKeyframe[];
  motionPath: MotionPathData;
  actionClips: ActionClip[];
  currentMood: string;
  audioProfile: CharacterAudioProfile;
}

export type PropGeometryKind =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'podium'
  | 'desk'
  | 'chair'
  | 'lamp'
  | 'tree'
  | 'glb'
  | 'detached-part';

export interface DetachedPartSource {
  originKind: 'character-node' | 'prop-part';
  sourceAssetId?: string;
  sourceCharacterId?: string;
  sourceNodeId?: string;
  sourcePropKind?: PropGeometryKind;
  sourcePropAssetId?: string;
  /** Slash-separated child index path inside the source subtree (e.g. "0/2"). */
  sourceChildPath?: string;
  /** When true, reconstruct ONLY this leaf mesh's own geometry without child meshes. */
  atomicLeafOnly?: boolean;
  sourceColor?: string;
}

export interface ParentAttachment {
  targetId: string; // character or prop ID
  nodeId?: string; // optional bone/node ID (e.g., rightHand)
  offset: Vec3;
  rotationOffset: Vec3;
}

export interface ScenePropData {
  id: string;
  name: string;
  kind: PropGeometryKind;
  assetId?: string;
  color: string;
  visible: boolean;
  locked?: boolean;
  transform: Transform3D;
  pivot?: Vec3;
  positionKeyframes: Vec3Keyframe[];
  rotationKeyframes: Vec3Keyframe[];
  scaleKeyframes: Vec3Keyframe[];
  motionPath: MotionPathData;
  parentAttachment?: ParentAttachment | null;
  detachedSource?: DetachedPartSource;
  detachedChildPaths?: string[];
  materialOverride?: NodeMaterialOverride;
}

export type SceneLightKind = 'directional' | 'point' | 'spot' | 'ambient';

export interface SceneLightData {
  id: string;
  name: string;
  kind: SceneLightKind;
  color: string;
  intensity: number;
  position: Vec3;
  target?: Vec3;
  castShadow: boolean;
  distance?: number;
  angle?: number;
  visible: boolean;
  intensityKeyframes?: NumberKeyframe[];
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface CameraKeyframe {
  id: string;
  time: number;
  pose: CameraPose;
  easing: EasingType;
}

export interface SceneCameraData {
  pose: CameraPose;
  keyframes: CameraKeyframe[];
}

export interface SceneCameraItem {
  id: string;
  name: string;
  projection: 'perspective' | 'orthographic';
  orthoSize?: number;
  pose: CameraPose;
  keyframes: CameraKeyframe[];
  motionPath?: MotionPathData;
}

export interface SceneCameraSwitch {
  id: string;
  time: number;
  cameraId: string;
}

export type EnvironmentPresetId =
  | 'studio-dark'
  | 'sunset-stage'
  | 'daylight-cyclorama'
  | 'neon-night'
  | 'minimal-white';

export type SceneTransitionType = 'cut' | 'fade';

export interface SceneGroupData {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  memberIds: string[];
  transform: Transform3D;
  pivot?: Vec3;
  positionKeyframes: Vec3Keyframe[];
  rotationKeyframes: Vec3Keyframe[];
  scaleKeyframes: Vec3Keyframe[];
}

export type FloorShapeKind = 'square' | 'rectangle' | 'circle' | 'polygon';

export type StageWallSide = 'back' | 'left' | 'right' | 'front' | 'custom';

export type SizeUnit = '%' | 'px' | 'm' | 'cm' | 'ft';

export interface StageWallConfig {
  id: string;
  name: string;
  side: StageWallSide;
  color: string;
  width: number;
  height: number;
  thickness: number;
  position: Vec3;
  rotationY: number;
  opacity: number;
  visible: boolean;
}

export interface StageEnvironmentConfig {
  floorShape: FloorShapeKind;
  floorSides: number; // 3..64
  floorSize: number; // stage width/diameter in world meters
  floorColor: string;
  floorRoughness: number;
  gridColor: string;
  gridSecondaryColor: string;
  showClouds: boolean;
  cloudColor: string;
  cloudOpacity: number;
  floorLockEnabled: boolean; // true = prevent objects from going below floor y=0; false = allow moving under floor
  walls: StageWallConfig[];
}

export interface LiveSizeInfo {
  label: string;
  scaleFactor: number; // uniform scale multiplier (1 = 100%)
  widthM: number;
  heightM: number;
  depthM: number;
  activeDragging?: boolean;
}

export interface CameraOrientationState {
  /** Camera forward vector in world space */
  forward: Vec3;
  /** Camera right vector in world space */
  right: Vec3;
  /** Camera up vector in world space */
  up: Vec3;
  /** Human-readable current canonical orientation (e.g. "Front", "Right", "Top", "3D View") */
  viewLabel: string;
}

export function createDefaultStageConfig(floorColor = '#1b1e24'): StageEnvironmentConfig {
  return {
    floorShape: 'square',
    floorSides: 4,
    floorSize: 28,
    floorColor,
    floorRoughness: 0.88,
    gridColor: '#3a404d',
    gridSecondaryColor: '#262a33',
    showClouds: true,
    cloudColor: '#cbd5e1',
    cloudOpacity: 0.42,
    floorLockEnabled: true,
    walls: [],
  };
}

export interface SceneData {
  id: string;
  name: string;
  duration: number;
  backgroundColor: string;
  showGrid: boolean;
  transition: SceneTransitionType;
  environmentPreset?: EnvironmentPresetId;
  stageConfig?: StageEnvironmentConfig;
  workArea?: { enabled: boolean; start: number; end: number };
  thumbnailDataUrl?: string;
  camera: SceneCameraData;
  cameras?: SceneCameraItem[];
  activeCameraId?: string;
  cameraSwitches?: SceneCameraSwitch[];
  lights?: SceneLightData[];
  props?: ScenePropData[];
  groups?: SceneGroupData[];
  characters: CharacterInstanceData[];
  audioClips: AudioClipData[];
}

export type AssetKind = 'character-html' | 'character-glb' | 'prop-glb' | 'audio';

export interface AssetRecord {
  id: string;
  name: string;
  kind: AssetKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  htmlSource?: string;
  htmlAnalysis?: {
    usesThreeJs: boolean;
    threeVersion: string | null;
    recommendedMode: 'native-three-extraction' | 'isolated-iframe';
    isFullScene?: boolean;
    globalApiHandle: string | null;
    sdkDetected?: boolean;
    externalDependencies?: string[];
    rigHints?: string[];
    facialHints?: string[];
    moods: string[];
    actions: {
      id: string;
      label: string;
      kind: 'gesture' | 'loop' | 'mood';
      supportsSpeed?: boolean;
      defaultDurationSec?: number;
    }[];
    supportsTalk: boolean;
    supportsSpeak: boolean;
    supportsLookAt: boolean;
    warnings: string[];
  };
  audioDuration?: number;
  waveformPeaks?: number[];
}

export interface ProjectData {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  fps: number;
  activeSceneId: string;
  scenes: SceneData[];
  assetIds: string[];
}

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

export type StudioMode = 'beginner' | 'advanced';

export type GizmoMode = 'select' | 'box-select' | 'translate' | 'rotate' | 'scale' | 'orbit';
export type GizmoSpace = 'world' | 'local';
export type AxisConstraint = 'all' | 'x' | 'y' | 'z';
export type SelectionFilter =
  | 'all'
  | 'character'
  | 'body-part'
  | 'prop'
  | 'group'
  | 'light'
  | 'camera'
  | 'waypoint'
  | 'ik-handle';

export interface SnapSettings {
  enabled: boolean;
  translateStep: number;
  rotateDegStep: number;
  scaleStep: number;
}

export type WorkspaceLayoutId =
  | 'general'
  | 'animation'
  | 'rigging'
  | 'scene'
  | 'audio'
  | 'camera';

export type PanelCollapseState = 'expanded' | 'compact' | 'collapsed';

export type EditorCameraPreset =
  | 'free'
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom';

export interface HoverTargetInfo {
  kind:
    | 'character'
    | 'body-part'
    | 'ik-handle'
    | 'prop'
    | 'group'
    | 'light'
    | 'camera'
    | 'waypoint';
  instanceId?: string;
  nodeId?: string;
  propId?: string;
  groupId?: string;
  lightId?: string;
  cameraId?: string;
  pointId?: string;
  chain?: IkChainType;
  title: string;
  description: string;
  screenX: number;
  screenY: number;
  worldPoint: Vec3;
  locked?: boolean;
}

export interface TabPrediction {
  id: string;
  title: string;
  reason: string;
  category: 'pose' | 'motion' | 'keyframe' | 'camera' | 'rig-fallback';
  compatible: boolean;
  incompatibilityReason?: string;
  applyKind: 'bone-pose' | 'motion-preset' | 'add-keyframe' | 'follow-through' | 'camera-frame' | 'none';
  payload?: {
    targetCharacterId?: string;
    nodeId?: string;
    nodeRotations?: Record<string, Vec3>;
    presetId?: string;
    duration?: number;
    easing?: EasingType;
    rootOffset?: Vec3;
  };
}

export type SelectionTarget =
  | { kind: 'none' }
  | { kind: 'character'; instanceId: string }
  | { kind: 'body-part'; instanceId: string; nodeId: string; nodeName: string }
  | { kind: 'ik-handle'; instanceId: string; chain: IkChainType }
  | { kind: 'prop'; propId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'light'; lightId: string }
  | { kind: 'camera'; cameraId?: string }
  | { kind: 'audio-clip'; clipId: string }
  | { kind: 'action-clip'; instanceId: string; clipId: string }
  | { kind: 'waypoint'; instanceId: string; pointId: string; ownerKind?: 'character' | 'prop' | 'camera' };

export interface StudioEvents {
  'selection:changed': SelectionTarget;
  'project:save-status': SaveStatus;
  'timeline:time-changed': number;
  'scene:changed': string;
  'playback:state-changed': boolean;
}

export function createDefaultTransform(x = 0, y = 0, z = 0): Transform3D {
  return {
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

export function createDefaultMotionPath(): MotionPathData {
  return {
    enabled: false,
    startTime: 0,
    duration: 4,
    orientAlongPath: false,
    curveType: 'cubic',
    closed: false,
    banking: 0,
    lookAtTargetId: null,
    speedMultiplier: 1,
    scrubProgress: null,
    points: [
      {
        id: 'pt_0',
        position: { x: -2.7, y: 0, z: 0 },
        handleIn: { x: -0.6, y: 0, z: 0 },
        handleOut: { x: 0.4, y: 0.8, z: 0.9 },
        smooth: true,
      },
      {
        id: 'pt_1',
        position: { x: -1.4, y: 0, z: 3.2 },
        handleIn: { x: -0.4, y: 0.8, z: -0.9 },
        handleOut: { x: 0.6, y: 0, z: 0 },
        smooth: true,
      },
    ],
  };
}

export function createDefaultCameraPose(): CameraPose {
  return {
    position: { x: 0, y: 2.9, z: 12.8 },
    target: { x: 0, y: 2.0, z: 0 },
    fov: 40,
  };
}

export function createDefaultFacialState(): FacialState {
  return {
    blink: 0,
    eyeLookX: 0,
    eyeLookY: 0,
    browRaise: 0,
    mouthOpen: 0,
    jawOpen: 0,
    smile: 0,
    frown: 0,
    surprise: 0,
    anger: 0,
    sadness: 0,
    fear: 0,
    customMorphs: {},
  };
}

export interface AiBridgeCommand {
  op:
    | 'create_session'
    | 'select'
    | 'clear_selection'
    | 'move'
    | 'rotate'
    | 'scale'
    | 'set_color'
    | 'set_visibility'
    | 'duplicate_target'
    | 'pose_part'
    | 'reset_part'
    | 'detach_part'
    | 'ungroup_all'
    | 'add_keyframe'
    | 'delete_keyframe'
    | 'add_prop'
    | 'delete_target'
    | 'add_wall'
    | 'remove_wall'
    | 'update_stage'
    | 'update_scene'
    | 'set_duration'
    | 'add_light'
    | 'update_light'
    | 'delete_light'
    | 'set_camera_pose'
    | 'add_camera_keyframe'
    | 'add_action_clip'
    | 'set_facial_expression'
    | 'update_motion_path'
    | 'create_group'
    | 'ungroup_scene_group'
    | 'set_time'
    | 'play'
    | 'pause'
    | 'bake_html_motion'
    | 'rename_scene';
  sessionId?: string;
  sceneId?: string;
  sceneName?: string;
  targetId?: string;
  targetKind?: 'character' | 'body-part' | 'prop' | 'light' | 'camera' | 'group' | 'none';
  characterId?: string;
  nodeId?: string;
  nodeName?: string;
  groupId?: string;
  memberIds?: string[];
  id?: string;
  position?: Partial<Vec3>;
  rotationDeg?: Partial<Vec3>;
  rotationRad?: Partial<Vec3>;
  scale?: Partial<Vec3> | number;
  relative?: boolean;
  visible?: boolean;
  color?: string;
  emissive?: string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  time?: number;
  duration?: number;
  startTime?: number;
  easing?: EasingType;
  kind?: PropGeometryKind;
  lightKind?: SceneLightKind;
  castShadow?: boolean;
  name?: string;
  actionId?: string;
  mood?: string;
  facialState?: Partial<FacialState>;
  points?: { x: number; y: number; z: number }[];
  enabled?: boolean;
  orientAlongPath?: boolean;
  workArea?: { enabled?: boolean; start?: number; end?: number };
  showGrid?: boolean;
  environmentPreset?: EnvironmentPresetId;
  side?: StageWallSide;
  height?: number;
  wallId?: string;
  floorShape?: FloorShapeKind;
  floorSides?: number;
  floorSize?: number;
  floorColor?: string;
  gridColor?: string;
  showClouds?: boolean;
  cloudColor?: string;
  cloudOpacity?: number;
  floorLockEnabled?: boolean;
  backgroundColor?: string;
  lightId?: string;
  intensity?: number;
  target?: Partial<Vec3>;
  fov?: number;
  speed?: number;
}

export interface AiSessionSummary {
  sessionId: string;
  label: string;
  sceneId: string;
  sceneName: string;
  createdAt: number;
  lastActivityAt: number;
  batchCount: number;
}

export interface AiBridgeLogEntry {
  id: string;
  timestamp: number;
  source: string;
  sessionId?: string;
  sceneName?: string;
  summary: string;
  status: 'pending' | 'running' | 'applied' | 'error';
  detail?: string;
}

export interface AiBridgeStateSnapshot {
  sessionId?: string;
  projectName: string;
  sceneId: string;
  sceneName: string;
  duration: number;
  maxDuration: number;
  currentTime: number;
  isPlaying: boolean;
  backgroundColor: string;
  showGrid: boolean;
  environmentPreset?: EnvironmentPresetId;
  workArea?: { enabled: boolean; start: number; end: number };
  stageConfig: StageEnvironmentConfig;
  camera: CameraPose;
  selection: SelectionTarget;
  characters: {
    id: string;
    name: string;
    visible: boolean;
    includeStageProps: boolean;
    playNativeLoop: boolean;
    transform: Transform3D;
    keyframeCount: number;
    actionClipsCount: number;
    nodes: { nodeId: string; name: string; type: string; slot?: string }[];
  }[];
  props: {
    id: string;
    name: string;
    kind: PropGeometryKind;
    color: string;
    visible: boolean;
    transform: Transform3D;
    keyframeCount: number;
  }[];
  lights: {
    id: string;
    name: string;
    kind: SceneLightKind;
    color: string;
    intensity: number;
    position: Vec3;
  }[];
  groups: {
    id: string;
    name: string;
    memberIds: string[];
    visible: boolean;
  }[];
}



