import type {
  CharacterNodeGroup,
  FacialState,
  NodeMaterialOverride,
  RigNodeInfo,
  Transform3D,
  Vec3,
} from '../core/types';

export type CharacterImportMode = 'native-three-extraction' | 'isolated-iframe' | 'gltf-native';

export interface CharacterActionDescriptor {
  id: string;
  label: string;
  kind: 'gesture' | 'loop' | 'mood' | 'speech' | 'clip';
  supportsSpeed?: boolean;
  defaultDurationSec?: number;
}

export interface CharacterCapabilities {
  importMode: CharacterImportMode;
  supportsTransform: boolean;
  supportsScale: boolean;
  supportsMotionPath: boolean;
  supportsAudioLipSync: boolean;
  supportsSpeedControl: boolean;
  supportsNodeRigging?: boolean;
  supportsFacialMorphs?: boolean;
  rigNodes?: RigNodeInfo[];
  morphTargetNames?: string[];
  actions: CharacterActionDescriptor[];
  moods: string[];
  limitations: string[];
}

export interface ICharacterAdapter {
  readonly instanceId: string;
  readonly assetId: string;
  readonly capabilities: CharacterCapabilities;

  load(): Promise<void>;
  dispose(): void;

  setTransform(transform: Transform3D): void;
  setVisible(visible: boolean): void;

  playAction(actionId: string, options?: { speed?: number; loop?: boolean }): void;
  setMood(mood: string): void;
  setTalking(active: boolean, level?: number): void;
  pause(): void;
  resume(): void;
  reset(): void;
  update(deltaSeconds: number, timelineSeconds: number): void;

  getRigNodes?(): RigNodeInfo[];
  applyNodeOverrides?(
    rotations: Record<string, Vec3>,
    positions?: Record<string, Vec3>,
    scales?: Record<string, Vec3>,
  ): void;
  applyFacialState?(facial: FacialState): void;
  getNodeDeltaRotation?(nodeId: string, currentEuler: { x: number; y: number; z: number }): Vec3;
  getNodeDeltaPosition?(nodeId: string, currentPos: { x: number; y: number; z: number }): Vec3;
  getNodeDeltaScale?(nodeId: string, currentScale: { x: number; y: number; z: number }): Vec3;
  setNodeVisibilityOverrides?(hiddenNodeIds: string[], detachedNodeIds?: string[]): void;
  syncNodeGroups?(groups: CharacterNodeGroup[]): void;
  applyNodeMaterialOverrides?(overrides: Record<string, NodeMaterialOverride>): void;
  getNodeMaterialInfo?(nodeId: string): NodeMaterialOverride | null;
  setIncludeStageProps?(include: boolean): void;
  setPlayNativeLoop?(play: boolean): void;
  sampleTimelineSequence?(
    durationSec: number,
    sampleFps?: number,
  ): {
    times: number[];
    nodeDeltas: Record<string, { pos: Vec3; rot: Vec3; scale: Vec3 }[]>;
  };
}
