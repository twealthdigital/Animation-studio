import * as THREE from 'three';
import type {
  CharacterNodeGroup,
  FacialState,
  HumanoidSlot,
  NodeMaterialOverride,
  RigNodeInfo,
  Transform3D,
  Vec3,
} from '../core/types';
import type { CharacterCapabilities, ICharacterAdapter } from './CharacterAdapter';
import { analyzeHtmlCharacter } from './HtmlCharacterAnalyzer';
import {
  applyCharacterNodeMaterialOverrides,
  type BaseNodeSnapshot,
  type MaterialBaseSnapshot,
  readNodeMaterialSnapshot,
  reconcileCharacterNodeGroups,
} from './RigNodeOperations';

interface VirtualDomElement {
  id: string;
  tagName: string;
  value: string;
  textContent: string;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: VirtualDomElement[];
  classList: {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    toggle: (c: string, force?: boolean) => boolean;
    contains: (c: string) => boolean;
  };
  appendChild: (child: unknown) => unknown;
  addEventListener: (type: string, fn: unknown, opts?: unknown) => void;
  removeEventListener: (type: string, fn: unknown) => void;
  setPointerCapture: (id: number) => void;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
}

function createVirtualElement(id: string, tagName = 'div'): VirtualDomElement {
  const classes = new Set<string>();
  const el: VirtualDomElement = {
    id,
    tagName,
    value: '',
    textContent: '',
    clientWidth: 640,
    clientHeight: 480,
    style: {},
    dataset: {},
    children: [],
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) {
            classes.delete(c);
            return false;
          }
          classes.add(c);
          return true;
        }
        if (force) classes.add(c);
        else classes.delete(c);
        return force;
      },
      contains: (c) => classes.has(c),
    },
    appendChild(child) {
      if (child && typeof child === 'object') {
        el.children.push(child as VirtualDomElement);
      }
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    },
  };
  return el;
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const body = match[2]?.trim();
    if (body) scripts.push(body);
  }
  return scripts;
}

function countDescendantMeshes(obj: THREE.Object3D): number {
  let count = 0;
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) count += 1;
  });
  return count;
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const record = mat as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          const val = record[key];
          if (val && typeof val === 'object' && (val as THREE.Texture).isTexture) {
            (val as THREE.Texture).dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}

type CharacterExposedApi = Record<string, ((...args: unknown[]) => unknown) | unknown>;

interface SdkDescriptor {
  name?: string;
  rootGroup?: THREE.Object3D;
  stageProps?: THREE.Object3D[];
  nodes?: Partial<Record<HumanoidSlot, THREE.Object3D>>;
  moods?: string[];
  actions?: string[];
  setMood?: (mood: string) => void;
  talk?: (active: boolean, level?: number) => void;
  setExpression?: (facial: FacialState) => void;
  playAction?: (id: string, opts?: unknown) => void;
}

/**
 * Mode A Adapter: Extracts a Three.js HTML character's 3D Object3D hierarchy,
 * dynamic CanvasTextures, procedural animations, named & unnamed procedural limb nodes,
 * and public/SDK APIs directly into the Studio's master Three.js scene.
 */
export class HtmlThreeAdapter implements ICharacterAdapter {
  readonly instanceId: string;
  readonly assetId: string;
  capabilities: CharacterCapabilities;
  readonly rootGroup = new THREE.Group();

  private readonly htmlSource: string;
  private readonly groundWrapper = new THREE.Group();
  private readonly stagePropsGroup = new THREE.Group();
  private characterGroup: THREE.Object3D | null = null;
  private api: CharacterExposedApi | null = null;
  private sdk: SdkDescriptor | null = null;
  private frameCallback: ((nowMs: number) => void) | null = null;
  private virtualTimeMs = 0;
  private paused = false;
  private currentMood = 'neutral';
  private moodNeedsSettle = false;
  private currentTalking = false;
  private activeLoops = new Set<string>();
  private lastActiveClipIds = new Set<string>();
  private includeStageProps = false;
  private loaded = false;

  private baseRigNodes: RigNodeInfo[] = [];
  private rigNodes: RigNodeInfo[] = [];
  private nodeObjectMap = new Map<string, THREE.Object3D>();
  private nodeBaseTransform = new Map<string, { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }>();
  private originalNodeSnapshots = new Map<string, BaseNodeSnapshot>();
  private activeGroupPivots = new Map<string, THREE.Group>();
  private hiddenGroupIds = new Set<string>();
  private baseMaterialSnapshots = new WeakMap<THREE.Mesh, MaterialBaseSnapshot[]>();
  private pendingNodeRotOverrides: Record<string, Vec3> = {};
  private pendingNodePosOverrides: Record<string, Vec3> = {};
  private pendingNodeScaleOverrides: Record<string, Vec3> = {};
  private previouslyOverriddenNodes = new Set<string>();
  private lastGroupsSig = '';
  private lastMaterialSig = '';
  private pendingFacial: FacialState | null = null;
  private morphMeshes: THREE.Mesh[] = [];

  constructor(instanceId: string, assetId: string, htmlSource: string, includeStageProps = false) {
    this.instanceId = instanceId;
    this.assetId = assetId;
    this.htmlSource = htmlSource;
    this.includeStageProps = includeStageProps;
    this.rootGroup.name = `character_${instanceId}`;
    this.rootGroup.userData.characterInstanceId = instanceId;

    const analysis = analyzeHtmlCharacter(htmlSource);
    this.capabilities = {
      importMode: 'native-three-extraction',
      supportsTransform: true,
      supportsScale: true,
      supportsMotionPath: true,
      supportsAudioLipSync: analysis.supportsTalk,
      supportsSpeedControl: analysis.actions.some((a) => a.supportsSpeed),
      supportsNodeRigging: true,
      supportsFacialMorphs: analysis.facialHints.length > 0 || analysis.moods.length > 0,
      rigNodes: [],
      morphTargetNames: [],
      actions: analysis.actions,
      moods: analysis.moods,
      limitations: analysis.warnings,
    };
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const scripts = extractInlineScripts(this.htmlSource);
    if (scripts.length === 0) {
      throw new Error('No inline character initialization script found in HTML file.');
    }

    const createdScenes: THREE.Scene[] = [];
    let renderedScene: THREE.Scene | null = null;
    const frameHolder: { cb: ((nowMs: number) => void) | null } = { cb: null };

    const virtualElements = new Map<string, VirtualDomElement>();
    const getOrCreateEl = (id: string) => {
      let el = virtualElements.get(id);
      if (!el) {
        el = createVirtualElement(id);
        virtualElements.set(id, el);
      }
      return el;
    };

    const virtualDocument = {
      createElement(tag: string) {
        if (tag.toLowerCase() === 'canvas') {
          return document.createElement('canvas');
        }
        return createVirtualElement('', tag);
      },
      getElementById(id: string) {
        return getOrCreateEl(id);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };

    const virtualWindow: Record<string, unknown> = {
      innerWidth: 640,
      innerHeight: 480,
      devicePixelRatio: 1,
      addEventListener() {},
      removeEventListener() {},
      speechSynthesis: typeof window !== 'undefined' ? window.speechSynthesis : undefined,
      SpeechSynthesisUtterance:
        typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined,
    };

    class ShimmedScene extends THREE.Scene {
      constructor() {
        super();
        createdScenes.push(this);
      }
    }

    class ShimmedCanvasTexture extends THREE.CanvasTexture {
      constructor(
        canvas: HTMLCanvasElement,
        mapping?: THREE.Mapping,
        wrapS?: THREE.Wrapping,
        wrapT?: THREE.Wrapping,
        magFilter?: THREE.MagnificationTextureFilter,
        minFilter?: THREE.MinificationTextureFilter,
        format?: THREE.PixelFormat,
        type?: THREE.TextureDataType,
        anisotropy?: number,
      ) {
        super(canvas, mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy);
        this.colorSpace = THREE.SRGBColorSpace;
      }
    }

    class ShimmedWebGLRenderer {
      domElement: HTMLCanvasElement;
      constructor() {
        this.domElement = document.createElement('canvas');
      }
      setPixelRatio() {}
      setSize() {}
      render(scene: THREE.Scene) {
        renderedScene = scene;
      }
      dispose() {}
    }

    const shimmedThree = {
      ...THREE,
      Scene: ShimmedScene,
      CanvasTexture: ShimmedCanvasTexture,
      WebGLRenderer: ShimmedWebGLRenderer,
    };

    const virtualPerformance = {
      now: () => this.virtualTimeMs,
    };

    const virtualRaf = (cb: (time: number) => void) => {
      frameHolder.cb = cb;
      return 1;
    };

    const combinedCode = scripts.join('\n;\n');
    const runner = new Function(
      'THREE',
      'window',
      'document',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'addEventListener',
      'removeEventListener',
      'devicePixelRatio',
      combinedCode,
    );

    runner(
      shimmedThree,
      virtualWindow,
      virtualDocument,
      virtualPerformance,
      virtualRaf,
      () => {},
      () => {},
      () => {},
      1,
    );

    this.frameCallback = frameHolder.cb;
    if (this.frameCallback) {
      this.frameCallback(0);
    }

    // Check explicit STAGECRAFT_SDK first
    if (virtualWindow.STAGECRAFT_SDK && typeof virtualWindow.STAGECRAFT_SDK === 'object') {
      this.sdk = virtualWindow.STAGECRAFT_SDK as SdkDescriptor;
    }

    const targetScene = renderedScene ?? createdScenes[createdScenes.length - 1];
    if (!targetScene) {
      throw new Error('HTML script executed without constructing a Three.js Scene.');
    }

    const groups = targetScene.children.filter((c): c is THREE.Group => (c as THREE.Group).isGroup);
    let primaryGroup: THREE.Object3D | null = this.sdk?.rootGroup ?? null;
    if (!primaryGroup) {
      let bestMeshCount = -1;
      for (const g of groups) {
        const count = countDescendantMeshes(g);
        if (count > bestMeshCount) {
          bestMeshCount = count;
          primaryGroup = g;
        }
      }
    }

    if (!primaryGroup) {
      const fallback = new THREE.Group();
      for (const child of [...targetScene.children]) {
        if (!(child as THREE.Light).isLight && !(child as THREE.Camera).isCamera) {
          fallback.add(child);
        }
      }
      primaryGroup = fallback;
    } else {
      for (const child of [...targetScene.children]) {
        if (
          child !== primaryGroup &&
          !(child as THREE.Light).isLight &&
          !(child as THREE.Camera).isCamera
        ) {
          this.stagePropsGroup.add(child);
        }
      }
    }

    this.characterGroup = primaryGroup;
    this.groundWrapper.add(primaryGroup);
    this.stagePropsGroup.visible = this.includeStageProps;
    this.groundWrapper.add(this.stagePropsGroup);
    this.rootGroup.add(this.groundWrapper);

    // Extract exposed public API from virtualWindow
    const ignoredKeys = new Set([
      'innerWidth',
      'innerHeight',
      'devicePixelRatio',
      'addEventListener',
      'removeEventListener',
      'speechSynthesis',
      'SpeechSynthesisUtterance',
      'STAGECRAFT_SDK',
    ]);
    for (const key of Object.keys(virtualWindow)) {
      if (ignoredKeys.has(key)) continue;
      const val = virtualWindow[key];
      if (val && typeof val === 'object') {
        this.api = val as CharacterExposedApi;
        break;
      }
    }

    // Run initial procedural frame once so rest transforms reflect the character's true neutral pose
    if (this.frameCallback) {
      try {
        this.frameCallback(0);
      } catch {
        // Ignore non-fatal initial frame hiccups
      }
    }

    // Build semantic RigNodeInfo hierarchy (named groups, bones, AND unnamed procedural limbs)
    this.discoverRigHierarchy(primaryGroup);

    // Ground character flush at y=0 if its rest bounds extend below zero
    this.groundWrapper.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.characterGroup);
    if (Number.isFinite(box.min.y) && box.min.y < -0.05) {
      this.groundWrapper.position.y = -box.min.y;
    }

    this.capabilities = {
      ...this.capabilities,
      rigNodes: this.rigNodes,
      morphTargetNames: this.collectMorphTargetNames(),
      actions:
        this.sdk?.actions && this.sdk.actions.length > 0
          ? this.sdk.actions.map((id) => ({
              id,
              label: id.charAt(0).toUpperCase() + id.slice(1),
              kind: ['walk', 'ring', 'dance', 'run'].includes(id) ? 'loop' : 'gesture',
              supportsSpeed: true,
              defaultDurationSec: 1.5,
            }))
          : this.capabilities.actions,
      moods:
        this.sdk?.moods && this.sdk.moods.length > 0
          ? this.sdk.moods
          : this.capabilities.moods,
    };

    this.loaded = true;
  }

  private collectMorphTargetNames(): string[] {
    const names = new Set<string>();
    for (const m of this.morphMeshes) {
      if (m.morphTargetDictionary) {
        for (const k of Object.keys(m.morphTargetDictionary)) {
          names.add(k);
        }
      }
    }
    return [...names];
  }

  /**
   * Walks the extracted Three.js hierarchy to index all bones/groups/parts,
   * inferring semantic humanoid labels even when procedural HTML scripts create unnamed Groups.
   */
  private discoverRigHierarchy(root: THREE.Object3D): void {
    this.baseRigNodes = [];
    this.rigNodes = [];
    this.nodeObjectMap.clear();
    this.nodeBaseTransform.clear();
    this.originalNodeSnapshots.clear();
    this.activeGroupPivots.clear();
    this.hiddenGroupIds.clear();
    this.lastGroupsSig = '';
    this.lastMaterialSig = '';
    this.morphMeshes = [];

    // Reverse lookup for explicit SDK node bindings
    const sdkSlotByObj = new Map<THREE.Object3D, HumanoidSlot>();
    if (this.sdk?.nodes) {
      for (const [slot, obj] of Object.entries(this.sdk.nodes)) {
        if (obj) sdkSlotByObj.set(obj, slot as HumanoidSlot);
      }
    }

    const extractMaterialLabels = (obj: THREE.Object3D): string[] | undefined => {
      const mat = (obj as THREE.Mesh).material;
      if (!mat) return undefined;
      const list = Array.isArray(mat) ? mat : [mat];
      const labels = list.map((m, i) => {
        if (m.name) return m.name;
        const c = (m as THREE.MeshStandardMaterial).color;
        return c ? `Material ${i + 1} (#${c.getHexString()})` : `Material ${i + 1}`;
      });
      return labels.length > 0 ? labels : undefined;
    };

    const describeSlot = (slot?: HumanoidSlot, name?: string): string => {
      switch (slot) {
        case 'root': return 'Root character container';
        case 'hips': return 'Rotate pelvis & hip center';
        case 'chest': return 'Rotate upper torso & chest';
        case 'neck': return 'Rotate neck pivot';
        case 'head': return 'Rotate head pitch, yaw & tilt';
        case 'leftUpperArm': return 'Rotate left upper arm at shoulder socket';
        case 'leftForearm': return 'Bend & twist left forearm at elbow';
        case 'leftHand': return 'Rotate left wrist & hand';
        case 'rightUpperArm': return 'Rotate right upper arm at shoulder socket';
        case 'rightForearm': return 'Bend & twist right forearm at elbow';
        case 'rightHand': return 'Rotate right wrist & hand';
        case 'leftThigh': return 'Rotate left thigh at hip socket';
        case 'leftShin': return 'Bend left knee & lower leg';
        case 'leftFoot': return 'Rotate left ankle & foot';
        case 'rightThigh': return 'Rotate right thigh at hip socket';
        case 'rightShin': return 'Bend right knee & lower leg';
        case 'rightFoot': return 'Rotate right ankle & foot';
        default: return name ? `Adjust ${name}` : 'Adjust structural part';
      }
    };

    const inferSlotFromProceduralGroup = (
      obj: THREE.Object3D,
      parentSlot: HumanoidSlot | undefined,
      parentName: string | undefined,
    ): { name: string; slot?: HumanoidSlot; description?: string; isAuxiliary?: boolean } => {
      const explicitSdk = sdkSlotByObj.get(obj);
      if (explicitSdk) {
        const label = obj.name || explicitSdk;
        return { name: label, slot: explicitSdk, description: describeSlot(explicitSdk, label) };
      }
      if (obj.name) {
        return { name: obj.name, description: describeSlot(undefined, obj.name) };
      }

      const px = obj.position.x;
      const py = obj.position.y;
      const pz = obj.position.z;
      const hasSubGroup = obj.children.some((c) => (c as THREE.Group).isGroup);
      const isMesh = Boolean((obj as THREE.Mesh).isMesh);
      const geoType = isMesh ? ((obj as THREE.Mesh).geometry?.type ?? '') : '';

      if (parentSlot === 'leftUpperArm') return { name: 'Left Forearm', slot: 'leftForearm', description: describeSlot('leftForearm') };
      if (parentSlot === 'leftForearm') return { name: 'Left Hand', slot: 'leftHand', description: describeSlot('leftHand') };
      if (parentSlot === 'rightUpperArm') return { name: 'Right Forearm', slot: 'rightForearm', description: describeSlot('rightForearm') };
      if (parentSlot === 'rightForearm') return { name: 'Right Hand', slot: 'rightHand', description: describeSlot('rightHand') };
      if (parentSlot === 'leftThigh') return { name: 'Left Shin & Foot', slot: 'leftShin', description: describeSlot('leftShin') };
      if (parentSlot === 'rightThigh') return { name: 'Right Shin & Foot', slot: 'rightShin', description: describeSlot('rightShin') };
      if (parentSlot === 'head') {
        if (px > 0.08 && py > 0.5 && pz > 0.3) {
          return { name: 'Left Eye', slot: 'leftEye', description: 'Left eye & pupil', isAuxiliary: true };
        }
        if (px < -0.08 && py > 0.5 && pz > 0.3) {
          return { name: 'Right Eye', slot: 'rightEye', description: 'Right eye & pupil', isAuxiliary: true };
        }
        if (Math.abs(px) < 0.15 && py < 0.5 && pz > 0.4) {
          return { name: 'Mouth', description: 'Mouth, teeth & tongue assembly', isAuxiliary: true };
        }
      }
      if (parentName === 'Antenna' && isMesh) {
        if (geoType.includes('Sphere')) return { name: 'Antenna Bulb', description: 'Tip bulb of antenna', isAuxiliary: true };
        if (py < 0.08) return { name: 'Antenna Base', description: 'Antenna base mount', isAuxiliary: true };
        return { name: 'Antenna Stem', description: 'Antenna mast stem', isAuxiliary: true };
      }
      if (parentSlot === 'leftEye' || parentSlot === 'rightEye') {
        const side = parentSlot === 'leftEye' ? 'Left' : 'Right';
        if (isMesh) {
          return pz > 0.06
            ? { name: `${side} Pupil`, description: `${side.toLowerCase()} eye pupil`, isAuxiliary: true }
            : { name: `${side} Eyeball`, description: `${side.toLowerCase()} eyeball sphere`, isAuxiliary: true };
        }
      }
      if (parentName === 'Mouth' && isMesh) {
        return { name: `Mouth Part (${this.rigNodes.length})`, description: 'Mouth sub-component', isAuxiliary: true };
      }
      if (parentName === 'Orbit Ring' && (obj as THREE.Group).isGroup) {
        return { name: 'Orbit Ring Spin', description: 'Spin satellite along orbital ring', isAuxiliary: true };
      }

      if (obj === root) return { name: 'Character Root', slot: 'root', description: describeSlot('root') };

      if (obj.parent === root) {
        if ((obj as THREE.Group).isGroup) {
          if (py >= 0.9 && Math.abs(px) < 0.35 && obj.children.length >= 4) {
            return { name: 'Head', slot: 'head', description: describeSlot('head') };
          }
          if (py >= 0.3 && px > 0.45 && hasSubGroup) {
            return { name: 'Left Upper Arm', slot: 'leftUpperArm', description: describeSlot('leftUpperArm') };
          }
          if (py >= 0.3 && px < -0.45 && hasSubGroup) {
            return { name: 'Right Upper Arm', slot: 'rightUpperArm', description: describeSlot('rightUpperArm') };
          }
          if (py <= -0.2 && px > 0.15 && hasSubGroup) {
            return { name: 'Left Thigh', slot: 'leftThigh', description: describeSlot('leftThigh') };
          }
          if (py <= -0.2 && px < -0.15 && hasSubGroup) {
            return { name: 'Right Thigh', slot: 'rightThigh', description: describeSlot('rightThigh') };
          }
          if (py >= 1.1 && obj.children.length <= 4) {
            return { name: 'Antenna', description: 'Sway & tilt antenna assembly' };
          }
          if (Math.abs(obj.rotation.x) > 0.8 && obj.children.some((c) => (c as THREE.Group).isGroup)) {
            return { name: 'Orbit Ring', description: 'Tilt & rotate orbital ring' };
          }
        }

        if (isMesh) {
          // Host character torso/collar/neck/hips meshes vs Globe character shell/screen/pods
          if (Math.abs(px) < 0.15 && Math.abs(pz) < 0.15 && py >= -0.05 && py <= 0.45) {
            const isIco = geoType.includes('Icosahedron');
            return isIco
              ? { name: 'Bot Shell', description: 'Main robot sphere shell' }
              : { name: 'Torso / Chest', slot: 'chest', description: describeSlot('chest') };
          }
          if (Math.abs(px) < 0.15 && Math.abs(pz) < 0.15 && py >= 0.85 && py <= 1.03) {
            return py > 0.95
              ? { name: 'Collar', description: 'Shirt collar mesh', isAuxiliary: true }
              : { name: 'Collar Trim', description: 'Collar accent ring', isAuxiliary: true };
          }
          if (Math.abs(px) < 0.15 && Math.abs(pz) < 0.15 && py > 1.03 && py < 1.2) {
            return { name: 'Neck', slot: 'neck', description: describeSlot('neck') };
          }
          if (Math.abs(px) < 0.15 && Math.abs(pz) < 0.15 && py <= -0.45 && py >= -0.8) {
            return { name: 'Hips / Pelvis', slot: 'hips', description: describeSlot('hips') };
          }
          if (pz > 0.8 && pz < 1.25) {
            return { name: 'Face Housing', description: 'Front visor drum housing', isAuxiliary: true };
          }
          if (pz >= 1.35) {
            return geoType.includes('Torus')
              ? { name: 'Screen Bezel', description: 'Visor outer bezel ring', isAuxiliary: true }
              : { name: 'Visor Screen', description: 'Animated face display screen', isAuxiliary: true };
          }
          if (Math.abs(px) >= 1.35 && Math.abs(py) < 0.25) {
            const side = px > 0 ? 'Left' : 'Right';
            return Math.abs(px) > 1.6
              ? { name: `${side} Ear Cap`, description: `${side.toLowerCase()} ear pod cap`, isAuxiliary: true }
              : { name: `${side} Ear Pod`, description: `${side.toLowerCase()} audio pod`, isAuxiliary: true };
          }
        }
      }

      const shortGeo = geoType.replace(/Geometry$/i, '');
      const typeLabel = (obj as THREE.Bone).isBone
        ? 'Bone'
        : isMesh
          ? shortGeo || 'Mesh'
          : 'Part';
      const fallbackName = parentName && isMesh && parentName !== 'Character Root'
        ? `${parentName} ${shortGeo || 'Part'} (${this.rigNodes.length})`
        : `${typeLabel} (${this.rigNodes.length})`;
      return {
        name: fallbackName,
        description: describeSlot(undefined, fallbackName),
        isAuxiliary: isMesh && obj.children.length === 0 ? true : undefined,
      };
    };

    const visit = (
      obj: THREE.Object3D,
      path: string,
      parentId: string | null,
      parentSlot: HumanoidSlot | undefined,
      parentName: string | undefined,
      depth: number,
    ) => {
      if (depth > 16) return; // deep penetration across every sub-component
      const isMesh = Boolean((obj as THREE.Mesh).isMesh);
      const isBone = Boolean((obj as THREE.Bone).isBone);
      const isGroup = Boolean((obj as THREE.Group).isGroup) || obj.children.length > 0;

      const nodeId = path;
      const inferred = inferSlotFromProceduralGroup(obj, parentSlot, parentName);
      if (!obj.name) {
        obj.name = inferred.name;
      }

      const morphDict = (obj as THREE.Mesh).morphTargetDictionary;
      const hasMorphTargets = Boolean(morphDict && Object.keys(morphDict).length > 0);
      if (hasMorphTargets) {
        this.morphMeshes.push(obj as THREE.Mesh);
      }

      obj.userData.characterInstanceId = this.instanceId;
      obj.userData.rigNodeId = nodeId;
      obj.userData.rigNodeName = inferred.name;
      if (isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }

      const childIds: string[] = [];
      const info: RigNodeInfo = {
        nodeId,
        name: inferred.name,
        parentId,
        type: isBone ? 'bone' : isMesh ? 'mesh' : 'group',
        slot: inferred.slot,
        isAuxiliary: inferred.isAuxiliary,
        description: inferred.description,
        materials: extractMaterialLabels(obj),
        childIds,
        hasMorphTargets,
        morphTargetNames: morphDict ? Object.keys(morphDict) : undefined,
        restPosition: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        restRotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
      };

      if (isGroup || isBone || isMesh) {
        this.rigNodes.push(info);
        this.nodeObjectMap.set(nodeId, obj);
        this.nodeBaseTransform.set(nodeId, {
          pos: obj.position.clone(),
          rot: obj.rotation.clone(),
          scale: obj.scale.clone(),
        });
        this.originalNodeSnapshots.set(nodeId, {
          parent: obj.parent,
          pos: obj.position.clone(),
          rot: obj.rotation.clone(),
          scale: obj.scale.clone(),
        });
      }

      obj.children.forEach((child, idx) => {
        const childPath = `${path}.${idx}`;
        visit(child, childPath, nodeId, inferred.slot, inferred.name, depth + 1);
        if (this.nodeObjectMap.has(childPath)) {
          childIds.push(childPath);
        }
      });
    };

    visit(root, 'node_0', null, undefined, undefined, 0);
    this.baseRigNodes = this.rigNodes.map((n) => ({ ...n, childIds: [...n.childIds] }));
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

  getNodeDeltaScale(nodeId: string, currentScale: { x: number; y: number; z: number }): Vec3 {
    const base = this.nodeBaseTransform.get(nodeId);
    if (!base) return { x: currentScale.x, y: currentScale.y, z: currentScale.z };
    const sx = Math.abs(base.scale.x) > 1e-4 ? base.scale.x : 1;
    const sy = Math.abs(base.scale.y) > 1e-4 ? base.scale.y : 1;
    const sz = Math.abs(base.scale.z) > 1e-4 ? base.scale.z : 1;
    return {
      x: currentScale.x / sx,
      y: currentScale.y / sy,
      z: currentScale.z / sz,
    };
  }

  syncNodeGroups(groups: CharacterNodeGroup[]): void {
    const sig = JSON.stringify(
      groups.map((g) => ({ id: g.id, name: g.name, members: g.memberNodeIds, visible: g.visible !== false })),
    );
    this.hiddenGroupIds.clear();
    for (const g of groups) {
      if (g.visible === false) this.hiddenGroupIds.add(g.id);
    }
    if (sig === this.lastGroupsSig || !this.characterGroup) {
      for (const [gid, pivot] of this.activeGroupPivots.entries()) {
        pivot.visible = !this.hiddenGroupIds.has(gid);
      }
      return;
    }
    this.lastGroupsSig = sig;
    this.rigNodes = reconcileCharacterNodeGroups({
      instanceId: this.instanceId,
      rootContainer: this.characterGroup,
      baseRigNodes: this.baseRigNodes,
      nodeObjectMap: this.nodeObjectMap,
      nodeBaseTransform: this.nodeBaseTransform,
      originalSnapshots: this.originalNodeSnapshots,
      activeGroupPivots: this.activeGroupPivots,
      groups,
    });
    this.capabilities = {
      ...this.capabilities,
      rigNodes: this.rigNodes,
    };
    this.applyPendingNodeTransforms();
  }

  applyNodeMaterialOverrides(overrides: Record<string, NodeMaterialOverride>): void {
    const sig = JSON.stringify(overrides);
    if (sig === this.lastMaterialSig || !this.characterGroup) return;
    this.lastMaterialSig = sig;
    applyCharacterNodeMaterialOverrides(
      this.characterGroup,
      this.nodeObjectMap,
      overrides,
      this.baseMaterialSnapshots,
    );
  }

  getNodeMaterialInfo(nodeId: string): NodeMaterialOverride | null {
    return readNodeMaterialSnapshot(this.nodeObjectMap.get(nodeId));
  }

  setNodeVisibilityOverrides(hiddenNodeIds: string[]): void {
    const hiddenSet = new Set(hiddenNodeIds);
    for (const [nodeId, obj] of this.nodeObjectMap.entries()) {
      if (nodeId === 'node_0') continue;
      obj.visible = !hiddenSet.has(nodeId) && !this.hiddenGroupIds.has(nodeId);
    }
  }

  applyNodeOverrides(
    rotations: Record<string, Vec3>,
    positions?: Record<string, Vec3>,
    scales?: Record<string, Vec3>,
  ): void {
    const nextPositions = positions ?? {};
    const nextScales = scales ?? {};
    const nextActive = new Set<string>([
      ...Object.keys(rotations),
      ...Object.keys(nextPositions),
      ...Object.keys(nextScales),
    ]);

    // Snap any previously overridden nodes back to their rest transform so smoothed HTML loops don't leave ghost poses on Undo/Reset
    for (const prevId of this.previouslyOverriddenNodes) {
      if (!nextActive.has(prevId)) {
        const obj = this.nodeObjectMap.get(prevId);
        const base = this.nodeBaseTransform.get(prevId);
        if (obj && base) {
          obj.rotation.copy(base.rot);
          obj.position.copy(base.pos);
          obj.scale.copy(base.scale);
        }
      }
    }

    this.previouslyOverriddenNodes = nextActive;
    this.pendingNodeRotOverrides = rotations;
    this.pendingNodePosOverrides = nextPositions;
    this.pendingNodeScaleOverrides = nextScales;
    this.applyPendingNodeTransforms();
  }

  applyFacialState(facial: FacialState): void {
    this.pendingFacial = facial;
    if (this.sdk?.setExpression) {
      this.sdk.setExpression(facial);
      return;
    }
    // Apply to any morph target meshes if present
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      if (!dict || !infl) continue;
      for (const [key, idx] of Object.entries(dict)) {
        const lower = key.toLowerCase();
        if (lower.includes('blink')) infl[idx] = facial.blink;
        else if (lower.includes('smile') || lower.includes('happy')) infl[idx] = facial.smile;
        else if (lower.includes('mouth') || lower.includes('jaw')) infl[idx] = Math.max(facial.mouthOpen, facial.jawOpen);
        else if (lower.includes('brow')) infl[idx] = Math.max(0, facial.browRaise);
        else if (lower.includes('surprise')) infl[idx] = facial.surprise;
        else if (lower.includes('angry') || lower.includes('anger')) infl[idx] = facial.anger;
        else if (lower.includes('sad')) infl[idx] = facial.sadness;
        else if (facial.customMorphs && typeof facial.customMorphs[key] === 'number') {
          infl[idx] = facial.customMorphs[key];
        }
      }
    }

    // Procedural mood fallback if explicit facial sliders express strong emotion
    if (facial.smile > 0.65) this.setMood('happy');
    else if (facial.surprise > 0.65) this.setMood('surprised');
    else if (facial.anger > 0.65) this.setMood('angry');
    else if (facial.sadness > 0.65) this.setMood('sad');
  }

  private applyPendingNodeTransforms(): void {
    for (const [nodeId, rot] of Object.entries(this.pendingNodeRotOverrides)) {
      const obj = this.nodeObjectMap.get(nodeId);
      const base = this.nodeBaseTransform.get(nodeId);
      if (!obj || !base) continue;
      obj.rotation.set(base.rot.x + rot.x, base.rot.y + rot.y, base.rot.z + rot.z);
    }
    for (const [nodeId, pos] of Object.entries(this.pendingNodePosOverrides)) {
      const obj = this.nodeObjectMap.get(nodeId);
      const base = this.nodeBaseTransform.get(nodeId);
      if (!obj || !base) continue;
      obj.position.set(base.pos.x + pos.x, base.pos.y + pos.y, base.pos.z + pos.z);
    }
    for (const [nodeId, sc] of Object.entries(this.pendingNodeScaleOverrides)) {
      const obj = this.nodeObjectMap.get(nodeId);
      const base = this.nodeBaseTransform.get(nodeId);
      if (!obj || !base) continue;
      obj.scale.set(base.scale.x * sc.x, base.scale.y * sc.y, base.scale.z * sc.z);
    }
  }

  setIncludeStageProps(include: boolean): void {
    this.includeStageProps = include;
    this.stagePropsGroup.visible = include;
  }

  setTransform(transform: Transform3D): void {
    this.rootGroup.position.set(transform.position.x, transform.position.y, transform.position.z);
    this.rootGroup.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    this.rootGroup.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  setVisible(visible: boolean): void {
    this.rootGroup.visible = visible;
  }

  playAction(actionId: string, options?: { speed?: number; loop?: boolean }): void {
    if (this.sdk?.playAction) {
      this.sdk.playAction(actionId, options);
      return;
    }
    if (!this.api) return;
    const fn = this.api[actionId];
    if (typeof fn !== 'function') return;

    if (actionId === 'walk' || actionId === 'ring') {
      const nextState = options?.loop ?? true;
      if (nextState) this.activeLoops.add(actionId);
      else this.activeLoops.delete(actionId);
      (fn as (v: boolean) => void)(nextState);
    } else {
      (fn as () => void)();
    }
  }

  stopAction(actionId: string): void {
    if (!this.api) return;
    if (actionId === 'walk' || actionId === 'ring') {
      this.activeLoops.delete(actionId);
      const fn = this.api[actionId];
      if (typeof fn === 'function') (fn as (v: boolean) => void)(false);
    }
  }

  setMood(mood: string): void {
    if (this.currentMood === mood) return;
    this.currentMood = mood;
    this.moodNeedsSettle = true;
    if (this.sdk?.setMood) {
      this.sdk.setMood(mood);
      return;
    }
    const fn = this.api?.setMood;
    if (typeof fn === 'function') (fn as (m: string) => void)(mood);
  }

  setTalking(active: boolean, level?: number): void {
    if (this.currentTalking === active && level === undefined) return;
    this.currentTalking = active;
    if (this.sdk?.talk) {
      this.sdk.talk(active, level);
      return;
    }
    const fn = this.api?.talk;
    if (typeof fn === 'function') (fn as (a: boolean, l?: number) => void)(active, level);
  }

  speakPreview(text: string): void {
    const fn = this.api?.speak;
    if (typeof fn === 'function') {
      (fn as (t: string) => void)(text);
    }
  }

  applyTimelineState(
    activeClipIds: Set<string>,
    activeActions: { id: string; actionId: string; kind: string }[],
    mood: string,
    isTalking: boolean,
  ): void {
    this.setMood(mood);
    this.setTalking(isTalking);

    for (const act of activeActions) {
      if (act.kind === 'gesture' && !this.lastActiveClipIds.has(act.id)) {
        this.playAction(act.actionId);
      }
    }

    for (const loopId of ['walk', 'ring']) {
      const shouldRun = activeActions.some((a) => a.actionId === loopId);
      const isRunning = this.activeLoops.has(loopId);
      if (shouldRun && !isRunning) {
        this.playAction(loopId, { loop: true });
      } else if (!shouldRun && isRunning) {
        this.stopAction(loopId);
      }
    }

    this.lastActiveClipIds = new Set(activeClipIds);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  reset(): void {
    this.virtualTimeMs = 0;
    this.lastActiveClipIds.clear();
    for (const loopId of [...this.activeLoops]) {
      this.stopAction(loopId);
    }
    this.setMood('neutral');
    this.setTalking(false);
    if (this.frameCallback) {
      this.frameCallback(this.virtualTimeMs);
    }
    this.applyPendingNodeTransforms();
  }

  update(deltaSeconds: number, _timelineSeconds = 0): void {
    if (!this.loaded || !this.frameCallback) return;
    if (deltaSeconds <= 0 && this.moodNeedsSettle) {
      for (let i = 0; i < 24; i++) {
        this.frameCallback(this.virtualTimeMs);
      }
      this.moodNeedsSettle = false;
      this.applyPendingNodeTransforms();
      return;
    }
    if (deltaSeconds > 0) {
      this.moodNeedsSettle = false;
    }
    if (!this.paused) {
      this.virtualTimeMs += Math.max(0, deltaSeconds) * 1000;
    }
    // 1. Run character's native procedural frame
    this.frameCallback(this.virtualTimeMs);
    // 2. Apply user body-part keyframes / IK / preset overrides AFTER native frame so they always stick!
    this.applyPendingNodeTransforms();
    if (this.pendingFacial) {
      this.applyFacialState(this.pendingFacial);
    }
  }

  dispose(): void {
    disposeObject3D(this.rootGroup);
    this.rootGroup.clear();
    this.frameCallback = null;
    this.api = null;
    this.sdk = null;
    this.characterGroup = null;
    this.nodeObjectMap.clear();
    this.nodeBaseTransform.clear();
    this.loaded = false;
  }
}
