import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FacialState, RigNodeInfo, Transform3D, Vec3 } from '../core/types';
import type { CharacterActionDescriptor, CharacterCapabilities, ICharacterAdapter } from './CharacterAdapter';
import { autoMapHumanoidSlots } from '../animation/RigMapper';

/**
 * Native GLB/GLTF Character Adapter with skeletal AnimationMixer playback,
 * real bone/node hierarchy extraction, per-node transform overrides, and morph targets.
 */
export class GltfCharacterAdapter implements ICharacterAdapter {
  readonly instanceId: string;
  readonly assetId: string;
  readonly rootGroup = new THREE.Group();
  capabilities: CharacterCapabilities;

  private readonly binaryData: ArrayBuffer;
  private mixer: THREE.AnimationMixer | null = null;
  private clipActions = new Map<string, THREE.AnimationAction>();
  private clips: THREE.AnimationClip[] = [];
  private activeClipId: string | null = null;
  private speed = 1;
  private clipLocalTime = 0;

  private rigNodes: RigNodeInfo[] = [];
  private nodeObjectMap = new Map<string, THREE.Object3D>();
  private nodeBaseTransform = new Map<string, { pos: THREE.Vector3; rot: THREE.Euler }>();
  private morphMeshes: THREE.Mesh[] = [];

  constructor(instanceId: string, assetId: string, binaryData: ArrayBuffer) {
    this.instanceId = instanceId;
    this.assetId = assetId;
    this.binaryData = binaryData;
    this.rootGroup.name = `gltf_${instanceId}`;
    this.rootGroup.userData.characterInstanceId = instanceId;
    this.capabilities = {
      importMode: 'gltf-native',
      supportsTransform: true,
      supportsScale: true,
      supportsMotionPath: true,
      supportsAudioLipSync: false,
      supportsSpeedControl: true,
      supportsNodeRigging: true,
      supportsFacialMorphs: false,
      rigNodes: [],
      morphTargetNames: [],
      actions: [],
      moods: [],
      limitations: [],
    };
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>(
      (resolve, reject) => {
        loader.parse(this.binaryData.slice(0), '', resolve, reject);
      },
    );

    const model = gltf.scene;
    this.rigNodes = [];
    this.nodeObjectMap.clear();
    this.nodeBaseTransform.clear();
    this.morphMeshes = [];

    const pathByObj = new Map<THREE.Object3D, string>();
    let idxCounter = 0;
    model.traverse((obj) => {
      const nodeId = obj.name ? `gltf_${obj.name}_${idxCounter++}` : `gltf_node_${idxCounter++}`;
      pathByObj.set(obj, nodeId);
      const isMesh = Boolean((obj as THREE.Mesh).isMesh);
      const isSkinned = Boolean((obj as THREE.SkinnedMesh).isSkinnedMesh);
      const isBone = Boolean((obj as THREE.Bone).isBone);

      if (isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
      obj.userData.characterInstanceId = this.instanceId;
      obj.userData.rigNodeId = nodeId;
      obj.userData.rigNodeName = obj.name || nodeId;

      const morphDict = (obj as THREE.Mesh).morphTargetDictionary;
      const hasMorphTargets = Boolean(morphDict && Object.keys(morphDict).length > 0);
      if (hasMorphTargets) this.morphMeshes.push(obj as THREE.Mesh);

      const mat = (obj as THREE.Mesh).material;
      const matList = mat ? (Array.isArray(mat) ? mat : [mat]) : [];
      const materials = matList.map((m, i) => {
        if (m.name) return m.name;
        const c = (m as THREE.MeshStandardMaterial).color;
        return c ? `Material ${i + 1} (#${c.getHexString()})` : `Material ${i + 1}`;
      });

      const nodeLabel =
        obj.name || (isBone ? `Bone ${idxCounter}` : isMesh ? `Mesh ${idxCounter}` : `Group ${idxCounter}`);
      this.rigNodes.push({
        nodeId,
        name: nodeLabel,
        parentId: obj.parent ? pathByObj.get(obj.parent) ?? null : null,
        type: isBone ? 'bone' : isSkinned ? 'skinned-mesh' : isMesh ? 'mesh' : 'group',
        description: isBone ? `Rotate ${nodeLabel} joint` : `Adjust ${nodeLabel}`,
        materials: materials.length > 0 ? materials : undefined,
        childIds: [],
        hasMorphTargets,
        morphTargetNames: morphDict ? Object.keys(morphDict) : undefined,
        restPosition: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        restRotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
      });

      this.nodeObjectMap.set(nodeId, obj);
      this.nodeBaseTransform.set(nodeId, {
        pos: obj.position.clone(),
        rot: obj.rotation.clone(),
      });
    });

    // Populate childIds & auto-mapped slots
    for (const node of this.rigNodes) {
      if (node.parentId) {
        const p = this.rigNodes.find((n) => n.nodeId === node.parentId);
        if (p) p.childIds.push(node.nodeId);
      }
    }
    const mapped = autoMapHumanoidSlots(this.rigNodes);
    for (const [slot, nId] of Object.entries(mapped)) {
      const node = this.rigNodes.find((n) => n.nodeId === nId);
      if (node) node.slot = slot as RigNodeInfo['slot'];
    }

    // Ground model flush at y=0
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (Number.isFinite(box.min.y)) {
      model.position.y -= box.min.y;
    }

    this.rootGroup.add(model);
    this.clips = gltf.animations ?? [];

    const morphNames = new Set<string>();
    for (const m of this.morphMeshes) {
      if (m.morphTargetDictionary) {
        for (const k of Object.keys(m.morphTargetDictionary)) morphNames.add(k);
      }
    }

    const descriptors: CharacterActionDescriptor[] = [];
    if (this.clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(model);
      this.clips.forEach((clip, idx) => {
        const id = clip.name || `clip_${idx}`;
        const action = this.mixer!.clipAction(clip);
        this.clipActions.set(id, action);
        descriptors.push({
          id,
          label: clip.name || `Clip ${idx + 1}`,
          kind: 'clip',
          supportsSpeed: true,
          defaultDurationSec: Math.max(0.5, clip.duration),
        });
      });
    }

    this.capabilities = {
      ...this.capabilities,
      rigNodes: this.rigNodes,
      morphTargetNames: [...morphNames],
      supportsFacialMorphs: morphNames.size > 0,
      supportsAudioLipSync: morphNames.size > 0 || Boolean(mapped.jaw),
      actions: descriptors,
      limitations:
        this.clips.length === 0
          ? ['GLB/GLTF model contains no embedded animation clips; bone keyframes, motion presets, IK, and paths remain supported.']
          : [],
    };
  }

  getRigNodes(): RigNodeInfo[] {
    return this.rigNodes;
  }

  getNodeObject(nodeId: string): THREE.Object3D | undefined {
    return this.nodeObjectMap.get(nodeId);
  }

  getNodeDeltaRotation(nodeId: string, currentEuler: { x: number; y: number; z: number }): Vec3 {
    const base = this.nodeBaseTransform.get(nodeId);
    if (!base) return { x: currentEuler.x, y: currentEuler.y, z: currentEuler.z };
    return {
      x: currentEuler.x - base.rot.x,
      y: currentEuler.y - base.rot.y,
      z: currentEuler.z - base.rot.z,
    };
  }

  getNodeDeltaPosition(nodeId: string, currentPos: { x: number; y: number; z: number }): Vec3 {
    const base = this.nodeBaseTransform.get(nodeId);
    if (!base) return { x: currentPos.x, y: currentPos.y, z: currentPos.z };
    return {
      x: currentPos.x - base.pos.x,
      y: currentPos.y - base.pos.y,
      z: currentPos.z - base.pos.z,
    };
  }

  setNodeVisibilityOverrides(hiddenNodeIds: string[]): void {
    const hiddenSet = new Set(hiddenNodeIds);
    for (const [nodeId, obj] of this.nodeObjectMap.entries()) {
      if (obj === this.rootGroup) continue;
      obj.visible = !hiddenSet.has(nodeId);
    }
  }

  applyNodeOverrides(rotations: Record<string, Vec3>, positions?: Record<string, Vec3>): void {
    // Reset to base if no mixer clip active, otherwise layer cleanly
    if (!this.activeClipId) {
      for (const [nodeId, base] of this.nodeBaseTransform.entries()) {
        const obj = this.nodeObjectMap.get(nodeId);
        if (obj) {
          obj.rotation.copy(base.rot);
          obj.position.copy(base.pos);
        }
      }
    }
    for (const [nodeId, rot] of Object.entries(rotations)) {
      const obj = this.nodeObjectMap.get(nodeId);
      const base = this.nodeBaseTransform.get(nodeId);
      if (!obj || !base) continue;
      obj.rotation.set(base.rot.x + rot.x, base.rot.y + rot.y, base.rot.z + rot.z);
    }
    for (const [nodeId, pos] of Object.entries(positions ?? {})) {
      const obj = this.nodeObjectMap.get(nodeId);
      const base = this.nodeBaseTransform.get(nodeId);
      if (!obj || !base) continue;
      obj.position.set(base.pos.x + pos.x, base.pos.y + pos.y, base.pos.z + pos.z);
    }
  }

  applyFacialState(facial: FacialState): void {
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      if (!dict || !infl) continue;
      for (const [key, idx] of Object.entries(dict)) {
        const lower = key.toLowerCase();
        if (lower.includes('blink') || lower.includes('eyeclose')) infl[idx] = facial.blink;
        else if (lower.includes('smile') || lower.includes('happy')) infl[idx] = facial.smile;
        else if (lower.includes('frown')) infl[idx] = facial.frown;
        else if (lower.includes('mouthopen') || lower.includes('viseme_aa')) infl[idx] = facial.mouthOpen;
        else if (lower.includes('jawopen')) infl[idx] = facial.jawOpen;
        else if (lower.includes('brow')) infl[idx] = Math.max(0, facial.browRaise);
        else if (lower.includes('surprise')) infl[idx] = facial.surprise;
        else if (lower.includes('anger') || lower.includes('angry')) infl[idx] = facial.anger;
        else if (lower.includes('sad')) infl[idx] = facial.sadness;
        else if (lower.includes('fear')) infl[idx] = facial.fear;
        else if (facial.customMorphs && typeof facial.customMorphs[key] === 'number') {
          infl[idx] = facial.customMorphs[key];
        }
      }
    }
  }

  setTransform(transform: Transform3D): void {
    this.rootGroup.position.set(transform.position.x, transform.position.y, transform.position.z);
    this.rootGroup.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    this.rootGroup.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  setVisible(visible: boolean): void {
    this.rootGroup.visible = visible;
  }

  playAction(actionId: string, options?: { speed?: number }): void {
    if (!this.mixer) return;
    const action = this.clipActions.get(actionId);
    if (!action) return;
    if (this.activeClipId && this.activeClipId !== actionId) {
      this.clipActions.get(this.activeClipId)?.stop();
    }
    this.speed = options?.speed ?? 1;
    this.activeClipId = actionId;
    this.clipLocalTime = 0;
    action.reset().play();
    this.mixer.setTime(0);
  }

  evaluateClipAt(actionId: string | null, localSeconds: number, speed = 1): void {
    if (!this.mixer) return;
    if (!actionId) {
      if (this.activeClipId) {
        this.clipActions.get(this.activeClipId)?.stop();
        this.activeClipId = null;
      }
      return;
    }
    const action = this.clipActions.get(actionId);
    if (!action) return;
    if (this.activeClipId !== actionId) {
      if (this.activeClipId) {
        this.clipActions.get(this.activeClipId)?.stop();
      }
      this.activeClipId = actionId;
      action.reset().play();
    }
    this.mixer.setTime(Math.max(0, localSeconds * speed));
  }

  setMood(): void {}
  setTalking(): void {}
  pause(): void {}
  resume(): void {}

  reset(): void {
    this.clipLocalTime = 0;
    if (this.mixer && this.activeClipId) {
      this.mixer.setTime(0);
    }
  }

  update(deltaSeconds: number): void {
    if (!this.mixer || !this.activeClipId) return;
    this.clipLocalTime += Math.max(0, deltaSeconds) * this.speed;
    this.mixer.setTime(this.clipLocalTime);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.rootGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.rootGroup.clear();
    this.clipActions.clear();
    this.nodeObjectMap.clear();
    this.nodeBaseTransform.clear();
  }
}
