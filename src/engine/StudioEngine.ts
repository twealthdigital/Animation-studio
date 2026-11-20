import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type {
  AxisConstraint,
  CameraPose,
  EditorCameraPreset,
  GizmoMode,
  GizmoSpace,
  HoverTargetInfo,
  IkChainType,
  IkTargetData,
  MotionPathData,
  SceneGroupData,
  SceneLightData,
  ScenePropData,
  SelectionFilter,
  SelectionTarget,
  SnapSettings,
  Transform3D,
  Vec3,
} from '../core/types';
import { sampleMotionPathCurve } from '../animation/MotionPath';
import type { EvaluatedGroupState, EvaluatedLightState, EvaluatedPropState } from '../animation/SceneEvaluator';
import type { AnyCharacterAdapter } from '../characters/CharacterRegistry';
import { buildPropObject3D } from './PropsFactory';
import { RigVisualizer } from './RigVisualizer';

export type CameraViewMode = 'editor' | 'scene';

export interface StudioEngineCallbacks {
  onSelectTarget: (target: SelectionTarget, shiftKey?: boolean) => void;
  onPoseModeChange?: (instanceId: string | null, preferredNodeId?: string) => void;
  onHoverChanged?: (hover: HoverTargetInfo | null) => void;
  onContextMenuRequest?: (clientX: number, clientY: number, target: SelectionTarget) => void;
  onCharacterTransformCommit: (instanceId: string, transform: Transform3D) => void;
  onNodeTransformCommit: (instanceId: string, nodeId: string, nodeName: string, rotation: Vec3, position: Vec3) => void;
  onIkTargetCommit: (instanceId: string, chain: IkChainType, targetPos: Vec3) => void;
  onPropTransformCommit: (propId: string, transform: Transform3D) => void;
  onGroupTransformCommit?: (groupId: string, transform: Transform3D) => void;
  onLightPositionCommit: (lightId: string, position: Vec3) => void;
  onCameraTransformCommit: (pose: CameraPose) => void;
  onWaypointTransformCommit: (
    ownerId: string,
    ownerKind: 'character' | 'prop' | 'camera',
    pointId: string,
    handleKind: 'point' | 'in' | 'out',
    pos: Vec3,
  ) => void;
  onAnimationTick: (deltaSeconds: number) => void;
}

function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

/**
 * Master Three.js 3D viewport engine.
 * Supports:
 * - Throttled hover raycasting & non-destructive part highlight + control note tooltips
 * - Single-click object selection vs Double-click Articulated Pose Mode with parent-locked rotation
 * - Direct drag-to-rotate on body parts in Pose Mode
 * - RigVisualizer skeleton links, sockets, local X/Y/Z axis rings & IK diamond handles
 * - Logical SceneGroupData unified gizmo manipulation
 * - Independent editor camera presets, Persp/Ortho toggle, cursor zoom, and damped Focus (F)
 */
export class StudioEngine {
  readonly isSoftwareGl: boolean;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly editorCamera: THREE.PerspectiveCamera;
  readonly editorOrthoCamera: THREE.OrthographicCamera;
  readonly sceneCamera: THREE.PerspectiveCamera;
  readonly orthoSceneCamera: THREE.OrthographicCamera;
  readonly orbitControls: OrbitControls;
  readonly transformControls: TransformControls;

  private readonly container: HTMLElement;
  private readonly callbacks: StudioEngineCallbacks;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();

  private readonly gridHelper: THREE.GridHelper;
  private readonly floorMesh: THREE.Mesh;
  private readonly sceneCameraMarker: THREE.Group;
  private readonly selectionBoxHelper: THREE.BoxHelper;
  private readonly hoverBoxHelper: THREE.BoxHelper;
  private readonly motionPathGroup = new THREE.Group();
  private readonly rigOverlayGroup = new THREE.Group();
  private readonly rigVisualizer: RigVisualizer;
  private readonly lightsGroup = new THREE.Group();
  private readonly lightMarkersGroup = new THREE.Group();
  private readonly propsGroup = new THREE.Group();
  private readonly groupProxiesGroup = new THREE.Group();

  private readonly adapters = new Map<string, AnyCharacterAdapter>();
  private readonly propObjects = new Map<string, THREE.Group>();
  private readonly propHashes = new Map<string, string>();
  private readonly groupProxies = new Map<string, THREE.Group>();
  private readonly groupMeta = new Map<string, { name: string; locked: boolean; memberIds: string[] }>();
  private readonly memberToGroup = new Map<string, string>();
  private readonly dynamicLights = new Map<string, THREE.Light>();
  private readonly lightMarkers = new Map<string, THREE.Mesh>();
  private readonly lockedObjects = new Set<string>();
  private readonly lockedCharacterNodes = new Map<string, Set<string>>();
  private readonly waypointNodes = new Map<
    string,
    { ownerId: string; ownerKind: 'character' | 'prop' | 'camera'; pointId: string; kind: 'point' | 'in' | 'out'; mesh: THREE.Mesh }
  >();

  // Hover highlight state (zero material cloning / allocation)
  private readonly restoredHoverEmissives = new Map<
    THREE.MeshStandardMaterial,
    { hex: number; intensity: number }
  >();
  private lastHoverRayMs = 0;
  private lastHover: HoverTargetInfo | null = null;
  private hoveredNodeKey: string | null = null;
  private hoveredRingAxis: 'x' | 'y' | 'z' | null = null;
  private activeRingAxis: 'x' | 'y' | 'z' | null = null;
  private lastRigInstanceId: string | null = null;
  private lastIkTargets: readonly IkTargetData[] = [];

  // Pose mode & direct limb / ring drag-to-rotate state
  private poseModeInstanceId: string | null = null;
  private directLimbDrag: {
    instanceId: string;
    nodeId: string;
    nodeName: string;
    nodeObj: THREE.Object3D;
    startClientX: number;
    startClientY: number;
    startQuat: THREE.Quaternion;
    parentInvWorldQuat: THREE.Quaternion;
    camRight: THREE.Vector3;
    camUp: THREE.Vector3;
    camForward: THREE.Vector3;
    axis?: 'x' | 'y' | 'z' | null;
    jointScreenCenter?: { x: number; y: number };
    tangent2D?: THREE.Vector2;
    useCircular?: boolean;
    circularSign?: number;
    active: boolean;
  } | null = null;
  private snapRotateRad: number | null = null;

  // Damped camera focus transition state (cancelled immediately on manual Orbit/Gizmo input)
  private focusAnim: {
    targetPos: THREE.Vector3;
    targetLook: THREE.Vector3;
    remainingFrames: number;
  } | null = null;

  private viewMode: CameraViewMode = 'editor';
  private editorProjection: 'perspective' | 'orthographic' = 'perspective';
  private editorOrthoSize = 6.5;
  private activeCameraProjection: 'perspective' | 'orthographic' = 'perspective';
  private activeCameraOrthoSize = 6;
  private gizmoMode: GizmoMode = 'translate';
  private gizmoSpace: GizmoSpace = 'world';
  private axisConstraint: AxisConstraint = 'all';
  private selectionFilter: SelectionFilter = 'all';
  private currentSelection: SelectionTarget = { kind: 'none' };
  private showRigOverlay = true;
  private isPlaying = false;

  private frameId = 0;
  private lastTickMs = 0;
  private renderBusy = false;
  private renderDirty = false;
  private disposed = false;
  private pointerDownPos = { x: 0, y: 0 };

  constructor(container: HTMLElement, callbacks: StudioEngineCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.scene.background = new THREE.Color('#16181c');
    this.scene.fog = new THREE.FogExp2('#16181c', 0.014);

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const aspect = width / height;

    this.editorCamera = new THREE.PerspectiveCamera(42, aspect, 0.1, 160);
    this.editorCamera.position.set(7.5, 4.8, 12.8);

    this.editorOrthoCamera = new THREE.OrthographicCamera(
      -this.editorOrthoSize * aspect,
      this.editorOrthoSize * aspect,
      this.editorOrthoSize,
      -this.editorOrthoSize,
      0.1,
      160,
    );
    this.editorOrthoCamera.position.copy(this.editorCamera.position);

    this.sceneCamera = new THREE.PerspectiveCamera(40, aspect, 0.1, 160);
    this.sceneCamera.position.set(0, 2.9, 12.8);
    this.sceneCamera.lookAt(0, 2.0, 0);

    this.orthoSceneCamera = new THREE.OrthographicCamera(-6 * aspect, 6 * aspect, 6, -6, 0.1, 160);
    this.orthoSceneCamera.position.copy(this.sceneCamera.position);
    this.orthoSceneCamera.lookAt(0, 2.0, 0);

    this.scene.add(this.lightsGroup);
    this.scene.add(this.lightMarkersGroup);
    this.scene.add(this.propsGroup);
    this.scene.add(this.groupProxiesGroup);

    const floorGeom = new THREE.CircleGeometry(28, 64);
    floorGeom.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x1b1e24,
      roughness: 0.92,
      metalness: 0.05,
    });
    this.floorMesh = new THREE.Mesh(floorGeom, floorMat);
    this.floorMesh.position.y = -0.01;
    this.floorMesh.receiveShadow = true;
    this.scene.add(this.floorMesh);

    this.gridHelper = new THREE.GridHelper(28, 28, 0x3a404d, 0x262a33);
    this.gridHelper.position.y = 0.005;
    this.scene.add(this.gridHelper);

    this.sceneCameraMarker = this.buildSceneCameraMarker();
    this.scene.add(this.sceneCameraMarker);

    this.selectionBoxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xe8702a);
    this.selectionBoxHelper.visible = false;
    this.scene.add(this.selectionBoxHelper);

    this.hoverBoxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0x67e8f9);
    this.hoverBoxHelper.visible = false;
    this.scene.add(this.hoverBoxHelper);

    this.scene.add(this.motionPathGroup);
    this.scene.add(this.rigOverlayGroup);
    this.rigVisualizer = new RigVisualizer(this.rigOverlayGroup);

    this.orbitControls = new OrbitControls(this.editorCamera, this.renderer.domElement);
    this.orbitControls.enableDamping = !this.isSoftwareGl;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.target.set(0, 1.8, 0);
    this.orbitControls.maxPolarAngle = Math.PI * 0.495;
    this.orbitControls.minDistance = 0.7;
    this.orbitControls.maxDistance = 48;
    this.orbitControls.zoomToCursor = true;
    this.orbitControls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.orbitControls.addEventListener('start', () => {
      this.focusAnim = null;
    });
    this.orbitControls.addEventListener('change', () => {
      this.syncEditorOrthoCamera();
      this.requestRender();
    });

    this.transformControls = new TransformControls(this.editorCamera, this.renderer.domElement);
    this.transformControls.setSize(0.82);
    this.scene.add(this.transformControls.getHelper());

    this.transformControls.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean(event.value);
      if (dragging) this.focusAnim = null;
      this.orbitControls.enabled = !dragging && this.viewMode === 'editor';
      if (!dragging) {
        this.commitGizmoTransform();
      }
      this.requestRender();
    });

    this.transformControls.addEventListener('objectChange', () => {
      if (this.selectionBoxHelper.visible) {
        this.selectionBoxHelper.update();
      }
      if (this.lastRigInstanceId) {
        this.rigVisualizer.updateLivePositions(
          this.adapters.get(this.lastRigInstanceId),
          this.getActiveEditorCamera(),
        );
      }
      this.requestRender();
    });

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointermove', this.handlePointerMove);
    dom.addEventListener('pointerup', this.handlePointerUp);
    dom.addEventListener('pointercancel', this.handlePointerCancel);
    dom.addEventListener('pointerleave', this.handlePointerLeave);
    dom.addEventListener('dblclick', this.handleDoubleClick);
    dom.addEventListener('contextmenu', this.handleContextMenu);
    dom.addEventListener('webglcontextlost', this.handleContextLost);

    this.resize(width, height);
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.editorCamera);
    }
    this.requestRender();
  }

  private buildSceneCameraMarker(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'scene_camera_marker';

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.3, 0.55),
      new THREE.MeshStandardMaterial({ color: 0xe8702a, roughness: 0.45, metalness: 0.3 }),
    );
    body.userData.isSceneCamera = true;
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, 0.25, 16),
      new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.3, metalness: 0.7 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.35;
    lens.userData.isSceneCamera = true;

    group.add(body, lens);
    return group;
  }

  private getActiveEditorCamera(): THREE.Camera {
    return this.editorProjection === 'orthographic' ? this.editorOrthoCamera : this.editorCamera;
  }

  private syncEditorOrthoCamera(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    const dist = this.editorCamera.position.distanceTo(this.orbitControls.target);
    this.editorOrthoSize = Math.max(0.8, dist * 0.42);
    this.editorOrthoCamera.left = -this.editorOrthoSize * aspect;
    this.editorOrthoCamera.right = this.editorOrthoSize * aspect;
    this.editorOrthoCamera.top = this.editorOrthoSize;
    this.editorOrthoCamera.bottom = -this.editorOrthoSize;
    this.editorOrthoCamera.position.copy(this.editorCamera.position);
    this.editorOrthoCamera.quaternion.copy(this.editorCamera.quaternion);
    this.editorOrthoCamera.updateProjectionMatrix();
  }

  setEditorProjection(projection: 'perspective' | 'orthographic'): void {
    this.editorProjection = projection;
    this.syncEditorOrthoCamera();
    const cam = this.getActiveEditorCamera();
    this.orbitControls.object = cam;
    this.transformControls.camera = cam;
    this.orbitControls.update();
    this.requestRender();
  }

  setEditorCameraPreset(preset: EditorCameraPreset): void {
    this.focusAnim = null;
    const target = this.getSelectionWorldCenter() ?? new THREE.Vector3(0, 1.8, 0);
    const dist = Math.max(3.2, this.editorCamera.position.distanceTo(this.orbitControls.target));
    const offset = new THREE.Vector3(0, 0, dist);
    switch (preset) {
      case 'front':
        offset.set(0, 0.2, dist);
        break;
      case 'back':
        offset.set(0, 0.2, -dist);
        break;
      case 'left':
        offset.set(-dist, 0.2, 0);
        break;
      case 'right':
        offset.set(dist, 0.2, 0);
        break;
      case 'top':
        offset.set(0, dist, 0.01);
        break;
      case 'bottom':
        offset.set(0, -dist, 0.01);
        break;
      default:
        offset.set(dist * 0.55, dist * 0.28, dist * 0.85);
        break;
    }
    const nextPos = target.clone().add(offset);
    this.focusAnim = { targetPos: nextPos, targetLook: target, remainingFrames: 16 };
    this.requestRender();
  }

  /**
   * Smoothly focuses camera onto hovered bone/spot or active selection (`F` key).
   */
  focusOnTarget(overrideWorldPoint?: Vec3): void {
    let center: THREE.Vector3 | null = overrideWorldPoint
      ? new THREE.Vector3(overrideWorldPoint.x, overrideWorldPoint.y, overrideWorldPoint.z)
      : null;
    let radius = 1.2;

    if (!center && this.lastHover) {
      center = new THREE.Vector3(
        this.lastHover.worldPoint.x,
        this.lastHover.worldPoint.y,
        this.lastHover.worldPoint.z,
      );
      radius = this.lastHover.kind === 'body-part' ? 0.65 : 1.5;
    } else if (!center) {
      const box = this.getSelectionWorldBox();
      if (box) {
        center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        radius = Math.max(0.65, size.length() * 0.55);
      }
    }

    if (!center) {
      this.resetEditorCamera();
      return;
    }

    const dir = this.editorCamera.position.clone().sub(this.orbitControls.target);
    if (dir.lengthSq() < 1e-4) dir.set(0.4, 0.25, 1);
    dir.normalize();
    const targetDist = THREE.MathUtils.clamp(radius * 2.6, 1.4, 18);
    const nextPos = center.clone().addScaledVector(dir, targetDist);
    this.focusAnim = { targetPos: nextPos, targetLook: center, remainingFrames: 18 };
    this.requestRender();
  }

  /**
   * Frames the entire stage (`Shift+F`).
   */
  frameAll(): void {
    const box = new THREE.Box3();
    let hasObj = false;
    for (const adapter of this.adapters.values()) {
      if (adapter.rootGroup.visible) {
        box.expandByObject(adapter.rootGroup);
        hasObj = true;
      }
    }
    for (const prop of this.propObjects.values()) {
      if (prop.visible) {
        box.expandByObject(prop);
        hasObj = true;
      }
    }
    if (!hasObj || box.isEmpty()) {
      this.resetEditorCamera();
      return;
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = THREE.MathUtils.clamp(size.length() * 1.45, 5.5, 28);
    const dir = new THREE.Vector3(0.48, 0.3, 0.85).normalize();
    this.focusAnim = {
      targetPos: center.clone().addScaledVector(dir, dist),
      targetLook: center,
      remainingFrames: 18,
    };
    this.requestRender();
  }

  private getSelectionWorldCenter(): THREE.Vector3 | null {
    const box = this.getSelectionWorldBox();
    if (!box) return null;
    const c = new THREE.Vector3();
    box.getCenter(c);
    return c;
  }

  private getSelectionWorldBox(): THREE.Box3 | null {
    const box = new THREE.Box3();
    if (this.currentSelection.kind === 'character') {
      const a = this.adapters.get(this.currentSelection.instanceId);
      if (a) return box.setFromObject(a.rootGroup);
    } else if (this.currentSelection.kind === 'body-part') {
      const a = this.adapters.get(this.currentSelection.instanceId);
      const n = a && 'getNodeObject' in a && typeof a.getNodeObject === 'function' ? a.getNodeObject(this.currentSelection.nodeId) : undefined;
      if (n) return box.setFromObject(n);
    } else if (this.currentSelection.kind === 'prop') {
      const p = this.propObjects.get(this.currentSelection.propId);
      if (p) return box.setFromObject(p);
    } else if (this.currentSelection.kind === 'group') {
      const meta = this.groupMeta.get(this.currentSelection.groupId);
      if (meta) {
        for (const id of meta.memberIds) {
          const ch = this.adapters.get(id);
          if (ch) box.expandByObject(ch.rootGroup);
          const pr = this.propObjects.get(id);
          if (pr) box.expandByObject(pr);
        }
        if (!box.isEmpty()) return box;
      }
    } else if (this.currentSelection.kind === 'light') {
      const lm = this.lightMarkers.get(this.currentSelection.lightId);
      if (lm) return box.setFromObject(lm);
    } else if (this.currentSelection.kind === 'camera') {
      return box.setFromObject(this.sceneCameraMarker);
    }
    return null;
  }

  setSceneAppearance(backgroundColor: string, showGrid: boolean, floorColor?: string): void {
    const col = new THREE.Color(backgroundColor || '#16181c');
    this.scene.background = col;
    this.scene.fog = new THREE.FogExp2(col.getHex(), 0.014);
    this.gridHelper.visible = showGrid && this.viewMode === 'editor';
    if (floorColor) {
      (this.floorMesh.material as THREE.MeshStandardMaterial).color.set(floorColor);
    }
    this.requestRender();
  }

  setViewMode(mode: CameraViewMode): void {
    this.viewMode = mode;
    const isEditor = mode === 'editor';
    this.orbitControls.enabled = isEditor;
    this.sceneCameraMarker.visible = isEditor;
    this.lightMarkersGroup.visible = isEditor;
    this.rigOverlayGroup.visible = isEditor && this.showRigOverlay;
    this.transformControls.getHelper().visible = isEditor;
    this.selectionBoxHelper.visible =
      isEditor &&
      (this.currentSelection.kind === 'character' ||
        this.currentSelection.kind === 'prop' ||
        this.currentSelection.kind === 'body-part' ||
        this.currentSelection.kind === 'group');
    this.motionPathGroup.visible = isEditor;
    if (!isEditor) {
      this.clearHoverHighlight();
    }
    this.requestRender();
  }

  setPoseMode(instanceId: string | null): void {
    this.poseModeInstanceId = instanceId;
    this.attachGizmoToSelection();
    this.rebuildRigVisuals();
    this.requestRender();
  }

  getPoseModeInstanceId(): string | null {
    return this.poseModeInstanceId;
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    if (mode === 'select') {
      this.transformControls.detach();
    } else {
      this.attachGizmoToSelection();
    }
    this.requestRender();
  }

  setGizmoSpace(space: GizmoSpace): void {
    this.gizmoSpace = space;
    if (this.currentSelection.kind !== 'body-part') {
      this.transformControls.setSpace(space);
    }
    this.requestRender();
  }

  setAxisConstraint(axis: AxisConstraint): void {
    this.axisConstraint = axis;
    this.transformControls.showX = axis === 'all' || axis === 'x';
    this.transformControls.showY = axis === 'all' || axis === 'y';
    this.transformControls.showZ = axis === 'all' || axis === 'z';
    this.requestRender();
  }

  setSnapSettings(snap: SnapSettings): void {
    if (!snap.enabled) {
      this.snapRotateRad = null;
      this.transformControls.setTranslationSnap(null);
      this.transformControls.setRotationSnap(null);
      this.transformControls.setScaleSnap(null);
    } else {
      this.snapRotateRad = (snap.rotateDegStep * Math.PI) / 180;
      this.transformControls.setTranslationSnap(snap.translateStep);
      this.transformControls.setRotationSnap(this.snapRotateRad);
      this.transformControls.setScaleSnap(snap.scaleStep);
    }
    this.requestRender();
  }

  setSelectionFilter(filter: SelectionFilter): void {
    this.selectionFilter = filter;
  }

  setShowRigOverlay(show: boolean): void {
    this.showRigOverlay = show;
    this.rigOverlayGroup.visible = this.viewMode === 'editor' && show;
    this.attachGizmoToSelection();
    this.requestRender();
  }

  setLockStates(
    lockedObjectIds: ReadonlySet<string>,
    lockedNodesByChar: ReadonlyMap<string, ReadonlySet<string>>,
  ): void {
    this.lockedObjects.clear();
    for (const id of lockedObjectIds) this.lockedObjects.add(id);
    this.lockedCharacterNodes.clear();
    for (const [charId, set] of lockedNodesByChar.entries()) {
      this.lockedCharacterNodes.set(charId, new Set(set));
    }
    this.attachGizmoToSelection();
    this.rebuildRigVisuals();
  }

  resetEditorCamera(): void {
    this.focusAnim = {
      targetPos: new THREE.Vector3(7.5, 4.8, 12.8),
      targetLook: new THREE.Vector3(0, 1.8, 0),
      remainingFrames: 16,
    };
    this.requestRender();
  }

  registerCharacterAdapter(adapter: AnyCharacterAdapter): void {
    if (this.adapters.has(adapter.instanceId)) {
      this.unregisterCharacterAdapter(adapter.instanceId);
    }
    this.adapters.set(adapter.instanceId, adapter);
    this.scene.add(adapter.rootGroup);
    if (
      (this.currentSelection.kind === 'character' || this.currentSelection.kind === 'body-part') &&
      this.currentSelection.instanceId === adapter.instanceId
    ) {
      this.attachGizmoToSelection();
    }
    this.requestRender();
  }

  unregisterCharacterAdapter(instanceId: string): void {
    const existing = this.adapters.get(instanceId);
    if (!existing) return;
    if (
      (this.currentSelection.kind === 'character' ||
        this.currentSelection.kind === 'body-part' ||
        this.currentSelection.kind === 'ik-handle') &&
      this.currentSelection.instanceId === instanceId
    ) {
      this.transformControls.detach();
      this.selectionBoxHelper.visible = false;
    }
    if (this.poseModeInstanceId === instanceId) {
      this.poseModeInstanceId = null;
    }
    this.scene.remove(existing.rootGroup);
    existing.dispose();
    this.adapters.delete(instanceId);
    this.requestRender();
  }

  getAdapter(instanceId: string): AnyCharacterAdapter | undefined {
    return this.adapters.get(instanceId);
  }

  getRegisteredIds(): string[] {
    return [...this.adapters.keys()];
  }

  /* ---------- Logical Groups ---------- */

  syncSceneGroups(groups: readonly SceneGroupData[], evalGroups: Map<string, EvaluatedGroupState>): void {
    const desiredIds = new Set(groups.map((g) => g.id));
    this.memberToGroup.clear();
    this.groupMeta.clear();

    for (const [id, proxy] of this.groupProxies.entries()) {
      if (!desiredIds.has(id)) {
        if (this.currentSelection.kind === 'group' && this.currentSelection.groupId === id) {
          this.transformControls.detach();
          this.selectionBoxHelper.visible = false;
        }
        this.groupProxiesGroup.remove(proxy);
        this.groupProxies.delete(id);
      }
    }

    for (const grp of groups) {
      this.groupMeta.set(grp.id, { name: grp.name, locked: grp.locked, memberIds: grp.memberIds });
      for (const mId of grp.memberIds) {
        this.memberToGroup.set(mId, grp.id);
      }
      let proxy = this.groupProxies.get(grp.id);
      if (!proxy) {
        proxy = new THREE.Group();
        proxy.name = `group_proxy_${grp.id}`;
        proxy.userData.sceneGroupId = grp.id;
        this.groupProxiesGroup.add(proxy);
        this.groupProxies.set(grp.id, proxy);
      }
      const evalState = evalGroups.get(grp.id);
      if (
        evalState &&
        !(this.transformControls.dragging && this.currentSelection.kind === 'group' && this.currentSelection.groupId === grp.id)
      ) {
        proxy.position.set(evalState.transform.position.x, evalState.transform.position.y, evalState.transform.position.z);
        proxy.rotation.set(evalState.transform.rotation.x, evalState.transform.rotation.y, evalState.transform.rotation.z);
        proxy.scale.set(evalState.transform.scale.x, evalState.transform.scale.y, evalState.transform.scale.z);
      }
    }
  }

  /* ---------- Scene Lights Synchronization ---------- */

  syncSceneLights(lightStates: Map<string, EvaluatedLightState>): void {
    const desiredIds = new Set(lightStates.keys());

    for (const [id, light] of this.dynamicLights.entries()) {
      if (!desiredIds.has(id)) {
        this.lightsGroup.remove(light);
        light.dispose();
        this.dynamicLights.delete(id);
      }
    }
    for (const [id, marker] of this.lightMarkers.entries()) {
      if (!desiredIds.has(id)) {
        this.lightMarkersGroup.remove(marker);
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
        this.lightMarkers.delete(id);
      }
    }

    for (const [id, state] of lightStates.entries()) {
      const cfg: SceneLightData = state.light;
      let light = this.dynamicLights.get(id);
      const expectedType =
        cfg.kind === 'ambient'
          ? 'HemisphereLight'
          : cfg.kind === 'point'
            ? 'PointLight'
            : cfg.kind === 'spot'
              ? 'SpotLight'
              : 'DirectionalLight';

      if (!light || light.type !== expectedType) {
        if (light) {
          this.lightsGroup.remove(light);
          light.dispose();
        }
        if (cfg.kind === 'ambient') {
          light = new THREE.HemisphereLight(cfg.color, '#1c1816', state.intensity);
        } else if (cfg.kind === 'point') {
          light = new THREE.PointLight(cfg.color, state.intensity, cfg.distance ?? 25);
        } else if (cfg.kind === 'spot') {
          const spot = new THREE.SpotLight(cfg.color, state.intensity, cfg.distance ?? 25, cfg.angle ?? 0.55, 0.35);
          spot.target.position.set(cfg.target?.x ?? 0, cfg.target?.y ?? 1, cfg.target?.z ?? 0);
          this.lightsGroup.add(spot.target);
          light = spot;
        } else {
          const dir = new THREE.DirectionalLight(cfg.color, state.intensity);
          dir.shadow.mapSize.set(1024, 1024);
          dir.shadow.camera.near = 1;
          dir.shadow.camera.far = 35;
          dir.shadow.camera.left = -12;
          dir.shadow.camera.right = 12;
          dir.shadow.camera.top = 12;
          dir.shadow.camera.bottom = -12;
          dir.shadow.bias = -0.0005;
          dir.shadow.normalBias = 0.02;
          light = dir;
        }
        this.lightsGroup.add(light);
        this.dynamicLights.set(id, light);
      }

      light.visible = cfg.visible;
      light.intensity = state.intensity;
      light.color.set(cfg.color);
      light.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
      if ('castShadow' in light && cfg.kind !== 'ambient') {
        light.castShadow = cfg.castShadow && !this.isSoftwareGl;
      }

      if (cfg.kind !== 'ambient') {
        let marker = this.lightMarkers.get(id);
        if (!marker) {
          marker = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.22, 0),
            new THREE.MeshBasicMaterial({ color: cfg.color, wireframe: false }),
          );
          marker.userData.sceneLightId = id;
          marker.userData.sceneLightName = cfg.name;
          this.lightMarkersGroup.add(marker);
          this.lightMarkers.set(id, marker);
        }
        if (!(this.transformControls.dragging && this.currentSelection.kind === 'light' && this.currentSelection.lightId === id)) {
          marker.position.set(cfg.position.x, cfg.position.y, cfg.position.z);
        }
        (marker.material as THREE.MeshBasicMaterial).color.set(cfg.color);
        marker.visible = cfg.visible && this.viewMode === 'editor';
      }
    }
  }

  /* ---------- Props & Parent-Child Bone Attachment ---------- */

  async syncSceneProps(
    props: readonly ScenePropData[],
    evalProps: Map<string, EvaluatedPropState>,
    glbBinaries: Map<string, ArrayBuffer>,
  ): Promise<void> {
    const desiredIds = new Set(props.map((p) => p.id));
    for (const [id, group] of this.propObjects.entries()) {
      if (!desiredIds.has(id)) {
        if (this.currentSelection.kind === 'prop' && this.currentSelection.propId === id) {
          this.transformControls.detach();
          this.selectionBoxHelper.visible = false;
        }
        this.propsGroup.remove(group);
        this.propObjects.delete(id);
        this.propHashes.delete(id);
      }
    }

    for (const prop of props) {
      const sig = `${prop.kind}:${prop.color}:${prop.assetId ?? ''}:${prop.pivot?.x ?? 0},${prop.pivot?.y ?? 0},${prop.pivot?.z ?? 0}`;
      if (this.propHashes.get(prop.id) !== sig) {
        const old = this.propObjects.get(prop.id);
        if (old) this.propsGroup.remove(old);
        const built = await buildPropObject3D(prop, prop.assetId ? glbBinaries.get(prop.assetId) : undefined);
        built.userData.propName = prop.name;
        this.propsGroup.add(built);
        this.propObjects.set(prop.id, built);
        this.propHashes.set(prop.id, sig);
      }
      const obj = this.propObjects.get(prop.id);
      const evalState = evalProps.get(prop.id);
      if (!obj || !evalState) continue;

      obj.visible = evalState.visible;

      if (evalState.parentAttachment) {
        const att = evalState.parentAttachment;
        const targetAdapter = this.adapters.get(att.targetId);
        let parentObj: THREE.Object3D | undefined = targetAdapter?.rootGroup;
        if (targetAdapter && att.nodeId && 'getNodeObject' in targetAdapter && typeof targetAdapter.getNodeObject === 'function') {
          parentObj = targetAdapter.getNodeObject(att.nodeId) ?? parentObj;
        } else if (!parentObj) {
          parentObj = this.propObjects.get(att.targetId);
        }
        if (parentObj) {
          parentObj.updateMatrixWorld(true);
          const worldPos = new THREE.Vector3();
          const worldQuat = new THREE.Quaternion();
          parentObj.getWorldPosition(worldPos);
          parentObj.getWorldQuaternion(worldQuat);
          const localOffset = new THREE.Vector3(att.offset.x, att.offset.y, att.offset.z).applyQuaternion(worldQuat);
          obj.position.copy(worldPos).add(localOffset);
          obj.quaternion.copy(worldQuat);
          obj.rotateX(att.rotationOffset.x);
          obj.rotateY(att.rotationOffset.y);
          obj.rotateZ(att.rotationOffset.z);
          obj.scale.set(evalState.transform.scale.x, evalState.transform.scale.y, evalState.transform.scale.z);
          continue;
        }
      }

      if (!(this.transformControls.dragging && this.currentSelection.kind === 'prop' && this.currentSelection.propId === prop.id)) {
        obj.position.set(evalState.transform.position.x, evalState.transform.position.y, evalState.transform.position.z);
        obj.rotation.set(evalState.transform.rotation.x, evalState.transform.rotation.y, evalState.transform.rotation.z);
        obj.scale.set(evalState.transform.scale.x, evalState.transform.scale.y, evalState.transform.scale.z);
      }
    }
  }

  syncSceneCamera(pose: CameraPose, projection: 'perspective' | 'orthographic' = 'perspective', orthoSize = 6): void {
    this.activeCameraProjection = projection;
    this.activeCameraOrthoSize = orthoSize;

    this.sceneCamera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.sceneCamera.fov = pose.fov;
    this.sceneCamera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    this.sceneCamera.updateProjectionMatrix();

    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    this.orthoSceneCamera.left = -orthoSize * aspect;
    this.orthoSceneCamera.right = orthoSize * aspect;
    this.orthoSceneCamera.top = orthoSize;
    this.orthoSceneCamera.bottom = -orthoSize;
    this.orthoSceneCamera.position.copy(this.sceneCamera.position);
    this.orthoSceneCamera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    this.orthoSceneCamera.updateProjectionMatrix();

    if (!(this.transformControls.dragging && this.currentSelection.kind === 'camera')) {
      this.sceneCameraMarker.position.copy(this.sceneCamera.position);
      this.sceneCameraMarker.lookAt(pose.target.x, pose.target.y, pose.target.z);
    }
    this.requestRender();
  }

  setSelection(target: SelectionTarget): void {
    this.currentSelection = target;
    this.attachGizmoToSelection();
    this.rebuildRigVisuals();
    this.requestRender();
  }

  updateRigAndIkVisuals(instanceId: string | null, ikTargets: readonly IkTargetData[]): void {
    this.lastRigInstanceId = instanceId;
    this.lastIkTargets = ikTargets;
    this.rebuildRigVisuals();
    if (this.currentSelection.kind === 'ik-handle') {
      this.attachGizmoToSelection();
    }
    this.requestRender();
  }

  private rebuildRigVisuals(): void {
    const adapter = this.lastRigInstanceId ? this.adapters.get(this.lastRigInstanceId) : undefined;
    const lockedSet = this.lastRigInstanceId
      ? this.lockedCharacterNodes.get(this.lastRigInstanceId) ?? new Set<string>()
      : new Set<string>();
    this.rigVisualizer.rebuild(adapter, {
      instanceId: this.lastRigInstanceId,
      poseModeInstanceId: this.poseModeInstanceId,
      ikTargets: this.lastIkTargets,
      selection: this.currentSelection,
      hoveredNodeKey: this.hoveredNodeKey,
      hoveredRingAxis: this.hoveredRingAxis,
      activeRingAxis: this.activeRingAxis,
      lockedNodeIds: lockedSet,
    });
    this.rigVisualizer.updateScales(this.getActiveEditorCamera());
  }

  private attachGizmoToSelection(): void {
    this.transformControls.detach();
    this.selectionBoxHelper.visible = false;

    if (this.viewMode !== 'editor') return;

    // Allow body-part & IK interaction in Pose Mode even if toolbar gizmoMode is 'select'
    const isBodyOrIk = this.currentSelection.kind === 'body-part' || this.currentSelection.kind === 'ik-handle';
    if (this.gizmoMode === 'select' && !isBodyOrIk) return;

    this.transformControls.setSpace(this.gizmoSpace);
    const tcMode: 'translate' | 'rotate' | 'scale' =
      this.gizmoMode === 'select' ? 'rotate' : this.gizmoMode;

    if (this.currentSelection.kind === 'character') {
      if (this.lockedObjects.has(this.currentSelection.instanceId)) return;
      const adapter = this.adapters.get(this.currentSelection.instanceId);
      if (adapter) {
        this.transformControls.setMode(tcMode);
        this.transformControls.attach(adapter.rootGroup);
        this.selectionBoxHelper.setFromObject(adapter.rootGroup);
        this.selectionBoxHelper.visible = true;
      }
    } else if (this.currentSelection.kind === 'body-part') {
      const { instanceId, nodeId } = this.currentSelection;
      if (this.lockedObjects.has(instanceId)) return;
      if (this.lockedCharacterNodes.get(instanceId)?.has(nodeId)) return;
      const adapter = this.adapters.get(instanceId);
      const nodeObj =
        adapter && 'getNodeObject' in adapter && typeof adapter.getNodeObject === 'function'
          ? adapter.getNodeObject(nodeId)
          : undefined;
      if (nodeObj) {
        const isRootNode = nodeId === 'node_0';
        this.selectionBoxHelper.setFromObject(nodeObj);
        this.selectionBoxHelper.visible = true;

        // When RigVisualizer is visible for non-root joints, RigVisualizer renders clean
        // arrowhead X/Y/Z rings directly on the socket without overlapping TransformControls!
        if (!isRootNode && this.showRigOverlay) {
          return;
        }
        const effectiveMode =
          isRootNode && tcMode !== 'scale' ? tcMode : 'rotate';
        this.transformControls.setMode(effectiveMode);
        this.transformControls.setSpace('local');
        this.transformControls.attach(nodeObj);
      }
    } else if (this.currentSelection.kind === 'ik-handle') {
      if (this.lockedObjects.has(this.currentSelection.instanceId)) return;
      const mesh = this.rigVisualizer.ikHandles.get(
        `${this.currentSelection.instanceId}:${this.currentSelection.chain}`,
      );
      if (mesh) {
        this.transformControls.setMode('translate');
        this.transformControls.attach(mesh);
      }
    } else if (this.currentSelection.kind === 'prop') {
      if (this.lockedObjects.has(this.currentSelection.propId)) return;
      const propObj = this.propObjects.get(this.currentSelection.propId);
      if (propObj) {
        this.transformControls.setMode(tcMode);
        this.transformControls.attach(propObj);
        this.selectionBoxHelper.setFromObject(propObj);
        this.selectionBoxHelper.visible = true;
      }
    } else if (this.currentSelection.kind === 'group') {
      const grpMeta = this.groupMeta.get(this.currentSelection.groupId);
      if (grpMeta?.locked) return;
      const proxy = this.groupProxies.get(this.currentSelection.groupId);
      if (proxy) {
        this.transformControls.setMode(tcMode);
        this.transformControls.attach(proxy);
        this.selectionBoxHelper.visible = false;
      }
    } else if (this.currentSelection.kind === 'light') {
      const marker = this.lightMarkers.get(this.currentSelection.lightId);
      if (marker) {
        this.transformControls.setMode('translate');
        this.transformControls.attach(marker);
      }
    } else if (this.currentSelection.kind === 'camera') {
      this.transformControls.setMode('translate');
      this.transformControls.attach(this.sceneCameraMarker);
    } else if (this.currentSelection.kind === 'waypoint') {
      const key = `${this.currentSelection.instanceId}:${this.currentSelection.pointId}:point`;
      const node = this.waypointNodes.get(key);
      if (node) {
        this.transformControls.setMode('translate');
        this.transformControls.attach(node.mesh);
      }
    }
  }

  updateMotionPathVisual(
    ownerId: string | null,
    motionPath: MotionPathData | null,
    ownerKind: 'character' | 'prop' | 'camera' = 'character',
  ): void {
    this.motionPathGroup.traverse((obj) => {
      const m = obj as THREE.Mesh | THREE.Line;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((mat) => mat.dispose());
      }
    });
    this.motionPathGroup.clear();
    this.waypointNodes.clear();

    if (!ownerId || !motionPath || !motionPath.enabled || motionPath.points.length < 2) {
      this.requestRender();
      return;
    }

    const curveType = motionPath.curveType ?? 'cubic';
    const closed = Boolean(motionPath.closed);
    const sampled = sampleMotionPathCurve(motionPath.points, 28, curveType, closed);
    const curvePts = sampled.map((p) => new THREE.Vector3(p.x, p.y + 0.04, p.z));
    const lineGeom = new THREE.BufferGeometry().setFromPoints(curvePts);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xe8702a });
    this.motionPathGroup.add(new THREE.Line(lineGeom, lineMat));

    // Directional tick cones along motion path to clearly read travel direction
    const dirGeom = new THREE.ConeGeometry(0.06, 0.16, 6);
    dirGeom.rotateX(Math.PI / 2);
    const dirMat = new THREE.MeshBasicMaterial({ color: 0xfdba74 });
    for (let i = 4; i < sampled.length - 1; i += 7) {
      const p = sampled[i];
      const next = sampled[i + 1];
      const arrow = new THREE.Mesh(dirGeom.clone(), dirMat.clone());
      arrow.position.set(p.x, p.y + 0.05, p.z);
      arrow.lookAt(next.x, next.y + 0.05, next.z);
      this.motionPathGroup.add(arrow);
    }
    dirGeom.dispose();
    dirMat.dispose();

    const ptGeom = new THREE.SphereGeometry(0.14, 14, 10);
    const handleGeom = new THREE.SphereGeometry(0.09, 10, 8);

    motionPath.points.forEach((pt, idx) => {
      const ptColor = idx === 0 ? 0x4ade80 : pt.smooth ? 0xe8702a : 0xfacc15;
      const ptMat = new THREE.MeshBasicMaterial({ color: ptColor });
      const ptMesh = new THREE.Mesh(ptGeom.clone(), ptMat);
      ptMesh.position.set(pt.position.x, pt.position.y + 0.04, pt.position.z);
      ptMesh.userData.waypoint = { ownerId, ownerKind, pointId: pt.id, kind: 'point' as const };
      this.motionPathGroup.add(ptMesh);
      this.waypointNodes.set(`${ownerId}:${pt.id}:point`, {
        ownerId,
        ownerKind,
        pointId: pt.id,
        kind: 'point',
        mesh: ptMesh,
      });

      if (curveType !== 'catmullrom') {
        const handleInWorld = new THREE.Vector3(
          pt.position.x + pt.handleIn.x,
          pt.position.y + pt.handleIn.y + 0.04,
          pt.position.z + pt.handleIn.z,
        );
        const handleOutWorld = new THREE.Vector3(
          pt.position.x + pt.handleOut.x,
          pt.position.y + pt.handleOut.y + 0.04,
          pt.position.z + pt.handleOut.z,
        );

        if (idx > 0 || closed) {
          const inLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([ptMesh.position.clone(), handleInWorld]),
            new THREE.LineBasicMaterial({ color: 0x6b7280 }),
          );
          this.motionPathGroup.add(inLine);

          const inMesh = new THREE.Mesh(handleGeom.clone(), new THREE.MeshBasicMaterial({ color: 0x93c5fd }));
          inMesh.position.copy(handleInWorld);
          inMesh.userData.waypoint = { ownerId, ownerKind, pointId: pt.id, kind: 'in' as const };
          this.motionPathGroup.add(inMesh);
          this.waypointNodes.set(`${ownerId}:${pt.id}:in`, {
            ownerId,
            ownerKind,
            pointId: pt.id,
            kind: 'in',
            mesh: inMesh,
          });
        }

        if (idx < motionPath.points.length - 1 || closed) {
          const outLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([ptMesh.position.clone(), handleOutWorld]),
            new THREE.LineBasicMaterial({ color: 0x6b7280 }),
          );
          this.motionPathGroup.add(outLine);

          const outMesh = new THREE.Mesh(handleGeom.clone(), new THREE.MeshBasicMaterial({ color: 0x93c5fd }));
          outMesh.position.copy(handleOutWorld);
          outMesh.userData.waypoint = { ownerId, ownerKind, pointId: pt.id, kind: 'out' as const };
          this.motionPathGroup.add(outMesh);
          this.waypointNodes.set(`${ownerId}:${pt.id}:out`, {
            ownerId,
            ownerKind,
            pointId: pt.id,
            kind: 'out',
            mesh: outMesh,
          });
        }
      }
    });

    ptGeom.dispose();
    handleGeom.dispose();

    if (this.currentSelection.kind === 'waypoint') {
      this.attachGizmoToSelection();
    }
    this.requestRender();
  }

  private commitGizmoTransform(): void {
    const obj = this.transformControls.object;
    if (!obj) return;

    if (this.currentSelection.kind === 'character') {
      const id = this.currentSelection.instanceId;
      this.callbacks.onCharacterTransformCommit(id, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    } else if (this.currentSelection.kind === 'body-part') {
      const { instanceId, nodeId, nodeName } = this.currentSelection;
      const adapter = this.adapters.get(instanceId);
      const deltaRot =
        adapter && 'getNodeDeltaRotation' in adapter && typeof adapter.getNodeDeltaRotation === 'function'
          ? adapter.getNodeDeltaRotation(nodeId, obj.rotation)
          : { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z };
      const isRootNode = nodeId === 'node_0';
      const deltaPos =
        isRootNode && adapter && 'getNodeDeltaPosition' in adapter && typeof adapter.getNodeDeltaPosition === 'function'
          ? adapter.getNodeDeltaPosition(nodeId, obj.position)
          : { x: 0, y: 0, z: 0 };

      this.callbacks.onNodeTransformCommit(instanceId, nodeId, nodeName, deltaRot, deltaPos);
    } else if (this.currentSelection.kind === 'ik-handle') {
      const adapter = this.adapters.get(this.currentSelection.instanceId);
      if (adapter) {
        const local = obj.position.clone().applyMatrix4(adapter.rootGroup.matrixWorld.clone().invert());
        this.callbacks.onIkTargetCommit(this.currentSelection.instanceId, this.currentSelection.chain, {
          x: local.x,
          y: local.y,
          z: local.z,
        });
      }
    } else if (this.currentSelection.kind === 'prop') {
      this.callbacks.onPropTransformCommit(this.currentSelection.propId, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    } else if (this.currentSelection.kind === 'group') {
      this.callbacks.onGroupTransformCommit?.(this.currentSelection.groupId, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    } else if (this.currentSelection.kind === 'light') {
      this.callbacks.onLightPositionCommit(this.currentSelection.lightId, {
        x: obj.position.x,
        y: obj.position.y,
        z: obj.position.z,
      });
    } else if (this.currentSelection.kind === 'camera') {
      this.sceneCamera.position.copy(obj.position);
      this.callbacks.onCameraTransformCommit({
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        target: { x: 0, y: 1.5, z: 0 },
        fov: this.sceneCamera.fov,
      });
    } else if (this.currentSelection.kind === 'waypoint') {
      const wp = obj.userData.waypoint as
        | { ownerId: string; ownerKind: 'character' | 'prop' | 'camera'; pointId: string; kind: 'point' | 'in' | 'out' }
        | undefined;
      if (wp) {
        this.callbacks.onWaypointTransformCommit(wp.ownerId, wp.ownerKind, wp.pointId, wp.kind, {
          x: obj.position.x,
          y: Math.max(0, obj.position.y - 0.04),
          z: obj.position.z,
        });
      }
    }
  }

  /* ---------- Raycasting Helpers (Hover + Selection + Pose Drag) ---------- */

  private updateRayFromEvent(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.getActiveEditorCamera());
  }

  private clearHoverHighlight(): void {
    for (const [mat, prev] of this.restoredHoverEmissives.entries()) {
      mat.emissive.setHex(prev.hex);
      mat.emissiveIntensity = prev.intensity;
    }
    this.restoredHoverEmissives.clear();
    this.hoverBoxHelper.visible = false;
    if (this.hoveredNodeKey !== null || this.hoveredRingAxis !== null) {
      this.hoveredNodeKey = null;
      this.hoveredRingAxis = null;
      this.rebuildRigVisuals();
    }
    if (this.lastHover !== null) {
      this.lastHover = null;
      this.callbacks.onHoverChanged?.(null);
    }
  }

  private applyMeshHoverEmissive(rootObj: THREE.Object3D): void {
    rootObj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        if (std && 'emissive' in std && std.emissive && !this.restoredHoverEmissives.has(std)) {
          this.restoredHoverEmissives.set(std, {
            hex: std.emissive.getHex(),
            intensity: std.emissiveIntensity ?? 1,
          });
          std.emissive.setHex(0x2dd4bf);
          std.emissiveIntensity = 0.28;
        }
      }
    });
  }

  private inspectRayTarget(
    clientX: number,
    clientY: number,
    options?: { preferBodyPart?: boolean; ignoreFilter?: boolean },
  ): {
    target: SelectionTarget;
    hitMesh: THREE.Object3D | null;
    worldPoint: THREE.Vector3;
    title: string;
    description: string;
    locked: boolean;
    ringAxis?: 'x' | 'y' | 'z';
  } | null {
    this.updateRayFromEvent(clientX, clientY);
    const allow = (k: SelectionFilter) =>
      options?.ignoreFilter || this.selectionFilter === 'all' || this.selectionFilter === k;

    // 0. Interactive Rig Rotation Rings (highest priority when a joint is selected)
    if (this.showRigOverlay && this.rigVisualizer.axisRingHandles.length > 0) {
      const ringHits = this.raycaster.intersectObjects(this.rigVisualizer.axisRingHandles, false);
      if (ringHits.length > 0) {
        const ring = ringHits[0].object.userData.rigRotationRing as
          | {
              instanceId: string;
              nodeId: string;
              nodeName: string;
              axis: 'x' | 'y' | 'z';
              title: string;
              description: string;
            }
          | undefined;
        if (ring) {
          return {
            target: {
              kind: 'body-part',
              instanceId: ring.instanceId,
              nodeId: ring.nodeId,
              nodeName: ring.nodeName,
            },
            hitMesh: null,
            worldPoint: ringHits[0].point,
            title: ring.title,
            description: ring.description,
            locked:
              Boolean(this.lockedCharacterNodes.get(ring.instanceId)?.has(ring.nodeId)) ||
              this.lockedObjects.has(ring.instanceId),
            ringAxis: ring.axis,
          };
        }
      }
    }

    // 1. IK Target Handles
    if (allow('ik-handle') && this.rigVisualizer.ikHandles.size > 0) {
      const hits = this.raycaster.intersectObjects([...this.rigVisualizer.ikHandles.values()], false);
      if (hits.length > 0) {
        const ik = hits[0].object.userData.ikHandle as { instanceId: string; chain: IkChainType } | undefined;
        if (ik) {
          return {
            target: { kind: 'ik-handle', instanceId: ik.instanceId, chain: ik.chain },
            hitMesh: hits[0].object,
            worldPoint: hits[0].point,
            title: `IK Target: ${ik.chain}`,
            description: 'Drag to pull limb end-effector cleanly',
            locked: this.lockedObjects.has(ik.instanceId),
          };
        }
      }
    }

    // 2. Waypoints
    if (allow('waypoint') && this.waypointNodes.size > 0) {
      const wpMeshes = [...this.waypointNodes.values()].map((n) => n.mesh);
      const wpHits = this.raycaster.intersectObjects(wpMeshes, false);
      if (wpHits.length > 0) {
        const wp = wpHits[0].object.userData.waypoint as
          | { ownerId: string; ownerKind: 'character' | 'prop' | 'camera'; pointId: string; kind: 'point' | 'in' | 'out' }
          | undefined;
        if (wp) {
          return {
            target: { kind: 'waypoint', instanceId: wp.ownerId, pointId: wp.pointId, ownerKind: wp.ownerKind },
            hitMesh: wpHits[0].object,
            worldPoint: wpHits[0].point,
            title: wp.kind === 'point' ? 'Path Waypoint' : `Curve Tangent (${wp.kind})`,
            description: 'Drag to sculpt 3D motion trajectory',
            locked: false,
          };
        }
      }
    }

    // 3. Visible Rig Joint Sockets
    if (this.showRigOverlay && (allow('body-part') || this.poseModeInstanceId) && this.rigVisualizer.rigNodeHandles.size > 0) {
      const jointHits = this.raycaster.intersectObjects([...this.rigVisualizer.rigNodeHandles.values()], false);
      if (jointHits.length > 0) {
        const nh = jointHits[0].object.userData.rigNodeHandle as
          | { instanceId: string; nodeId: string; nodeName: string; description?: string; locked?: boolean }
          | undefined;
        if (nh) {
          return {
            target: { kind: 'body-part', instanceId: nh.instanceId, nodeId: nh.nodeId, nodeName: nh.nodeName },
            hitMesh: jointHits[0].object,
            worldPoint: jointHits[0].point,
            title: nh.nodeName,
            description: nh.description || 'Drag to rotate joint around locked socket',
            locked: Boolean(nh.locked) || this.lockedObjects.has(nh.instanceId),
          };
        }
      }
    }

    // 4. Characters, Props, Lights, Camera
    const targets: THREE.Object3D[] = [];
    if (allow('character') || allow('body-part') || allow('group')) {
      for (const a of this.adapters.values()) {
        if (a.rootGroup.visible) targets.push(a.rootGroup);
      }
    }
    if (allow('prop') || allow('group')) {
      for (const p of this.propObjects.values()) {
        if (p.visible) targets.push(p);
      }
    }
    if (allow('light')) {
      for (const lm of this.lightMarkers.values()) {
        if (lm.visible) targets.push(lm);
      }
    }
    if (allow('camera')) {
      targets.push(this.sceneCameraMarker);
    }

    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;

    const hitObj = hits[0].object;
    if (hitObj.userData.isSceneCamera) {
      return {
        target: { kind: 'camera' },
        hitMesh: this.sceneCameraMarker,
        worldPoint: hits[0].point,
        title: 'Scene Camera',
        description: 'Move & frame active stage camera',
        locked: false,
      };
    }
    if (typeof hitObj.userData.sceneLightId === 'string') {
      return {
        target: { kind: 'light', lightId: hitObj.userData.sceneLightId },
        hitMesh: hitObj,
        worldPoint: hits[0].point,
        title: String(hitObj.userData.sceneLightName || 'Scene Light'),
        description: 'Drag to reposition light source',
        locked: false,
      };
    }

    // Walk ancestors for prop / character
    let cur: THREE.Object3D | null = hitObj;
    let propId: string | null = null;
    let propName = 'Prop';
    let charId: string | null = null;
    while (cur) {
      if (!propId && typeof cur.userData.propId === 'string') {
        propId = cur.userData.propId;
        propName = String(cur.userData.propName || propId);
      }
      if (!charId && typeof cur.userData.characterInstanceId === 'string') {
        charId = cur.userData.characterInstanceId;
      }
      cur = cur.parent;
    }

    if (propId) {
      const grpId = this.memberToGroup.get(propId);
      if (grpId && !options?.preferBodyPart && this.currentSelection.kind !== 'prop') {
        const gMeta = this.groupMeta.get(grpId);
        return {
          target: { kind: 'group', groupId: grpId },
          hitMesh: this.propObjects.get(propId) ?? hitObj,
          worldPoint: hits[0].point,
          title: gMeta?.name ?? 'Group',
          description: 'Grouped object • Alt+Click to pick member',
          locked: Boolean(gMeta?.locked),
        };
      }
      return {
        target: { kind: 'prop', propId },
        hitMesh: this.propObjects.get(propId) ?? hitObj,
        worldPoint: hits[0].point,
        title: propName,
        description: 'Move, rotate or scale stage prop',
        locked: this.lockedObjects.has(propId),
      };
    }

    if (charId) {
      const rawNodeId = typeof hitObj.userData.rigNodeId === 'string' ? hitObj.userData.rigNodeId : null;
      const adapter = this.adapters.get(charId);
      const allNodes =
        adapter && 'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function'
          ? adapter.getRigNodes()
          : [];
      const rawNode = rawNodeId ? allNodes.find((n) => n.nodeId === rawNodeId) : undefined;

      // Resolve auxiliary facial/decorative sub-parts (eyes, mouth, collar) to their parent articulable joint
      let effectiveNode = rawNode;
      const isExplicitlySelectedAux =
        this.currentSelection.kind === 'body-part' &&
        this.currentSelection.instanceId === charId &&
        this.currentSelection.nodeId === rawNodeId;
      if (effectiveNode?.isAuxiliary && !isExplicitlySelectedAux) {
        while (effectiveNode?.isAuxiliary && effectiveNode.parentId) {
          const parent = allNodes.find((n) => n.nodeId === effectiveNode!.parentId);
          if (!parent) break;
          effectiveNode = parent;
        }
      }

      const rigNodeId = effectiveNode?.nodeId ?? rawNodeId;
      const rigNodeName = effectiveNode?.name ?? String(hitObj.userData.rigNodeName || rigNodeId || 'Part');
      const displayTitle =
        rawNode && effectiveNode && rawNode.nodeId !== effectiveNode.nodeId
          ? `${effectiveNode.name} • ${rawNode.name}`
          : rigNodeName;
      const nodeObj =
        rigNodeId && adapter && 'getNodeObject' in adapter && typeof adapter.getNodeObject === 'function'
          ? adapter.getNodeObject(rigNodeId)
          : undefined;

      // Return body-part info if hovering/picking in Pose Mode, body-part filter, or Alt held
      if (
        rigNodeId &&
        (options?.preferBodyPart ||
          this.selectionFilter === 'body-part' ||
          this.poseModeInstanceId === charId)
      ) {
        const lockedNode = Boolean(this.lockedCharacterNodes.get(charId)?.has(rigNodeId));
        return {
          target: { kind: 'body-part', instanceId: charId, nodeId: rigNodeId, nodeName: rigNodeName },
          hitMesh: nodeObj ?? hitObj,
          worldPoint: hits[0].point,
          title: displayTitle,
          description: effectiveNode?.description || `Rotate ${rigNodeName} around locked joint`,
          locked: lockedNode || this.lockedObjects.has(charId),
        };
      }

      const grpId = this.memberToGroup.get(charId);
      if (grpId && this.currentSelection.kind !== 'character' && this.currentSelection.kind !== 'body-part') {
        const gMeta = this.groupMeta.get(grpId);
        return {
          target: { kind: 'group', groupId: grpId },
          hitMesh: adapter?.rootGroup ?? hitObj,
          worldPoint: hits[0].point,
          title: gMeta?.name ?? 'Group',
          description: 'Grouped character • Double-click to pose',
          locked: Boolean(gMeta?.locked),
        };
      }

      return {
        target: { kind: 'character', instanceId: charId },
        hitMesh: rigNodeId && effectiveNode ? (nodeObj ?? hitObj) : (adapter?.rootGroup ?? hitObj),
        worldPoint: hits[0].point,
        title: effectiveNode ? displayTitle : 'Character',
        description: effectiveNode
          ? `${effectiveNode.description ?? 'Select part'} • Double-click to pose`
          : 'Click to transform • Double-click to pose joints',
        locked: this.lockedObjects.has(charId),
      };
    }

    return null;
  }

  private handlePointerMove = (e: PointerEvent) => {
    if (this.disposed || this.viewMode !== 'editor') return;

    // Live camera-aligned or axis-ring limb rotation drag in Articulated Pose Mode
    if (this.directLimbDrag) {
      const drag = this.directLimbDrag;
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.active && Math.hypot(dx, dy) > 3) {
        drag.active = true;
        this.orbitControls.enabled = false;
        if (drag.axis) {
          this.activeRingAxis = drag.axis;
          this.rebuildRigVisuals();
        }
      }
      if (drag.active) {
        if (drag.axis) {
          // Interactive X/Y/Z Ring drag around exact local joint axis
          let angle = 0;
          if (drag.useCircular && drag.jointScreenCenter) {
            const a0 = Math.atan2(
              drag.startClientY - drag.jointScreenCenter.y,
              drag.startClientX - drag.jointScreenCenter.x,
            );
            const a1 = Math.atan2(
              e.clientY - drag.jointScreenCenter.y,
              e.clientX - drag.jointScreenCenter.x,
            );
            let diff = a1 - a0;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            angle = diff * (drag.circularSign ?? 1);
          } else if (drag.tangent2D) {
            angle = (dx * drag.tangent2D.x + dy * drag.tangent2D.y) * 0.014;
          } else {
            angle = (dx - dy) * 0.012;
          }
          if (this.snapRotateRad && this.snapRotateRad > 0) {
            angle = Math.round(angle / this.snapRotateRad) * this.snapRotateRad;
          }
          const localAxis = new THREE.Vector3(
            drag.axis === 'x' ? 1 : 0,
            drag.axis === 'y' ? 1 : 0,
            drag.axis === 'z' ? 1 : 0,
          );
          const dq = new THREE.Quaternion().setFromAxisAngle(localAxis, angle);
          drag.nodeObj.quaternion.copy(drag.startQuat).multiply(dq);
        } else {
          // Smooth camera-aligned parent-locked free rotation on limb/socket drag
          const sensitivity = 0.011;
          if (e.altKey) {
            const localForward = drag.camForward.clone().applyQuaternion(drag.parentInvWorldQuat).normalize();
            let rollAngle = -dx * sensitivity;
            if (this.snapRotateRad && this.snapRotateRad > 0) {
              rollAngle = Math.round(rollAngle / this.snapRotateRad) * this.snapRotateRad;
            }
            const qRoll = new THREE.Quaternion().setFromAxisAngle(localForward, rollAngle);
            drag.nodeObj.quaternion.copy(qRoll).multiply(drag.startQuat);
          } else {
            const localUp = drag.camUp.clone().applyQuaternion(drag.parentInvWorldQuat).normalize();
            const localRight = drag.camRight.clone().applyQuaternion(drag.parentInvWorldQuat).normalize();
            let yawAngle = dx * sensitivity;
            let pitchAngle = dy * sensitivity;
            if (this.axisConstraint === 'x') yawAngle = 0;
            if (this.axisConstraint === 'y') pitchAngle = 0;
            if (this.snapRotateRad && this.snapRotateRad > 0) {
              yawAngle = Math.round(yawAngle / this.snapRotateRad) * this.snapRotateRad;
              pitchAngle = Math.round(pitchAngle / this.snapRotateRad) * this.snapRotateRad;
            }
            const qYaw = new THREE.Quaternion().setFromAxisAngle(localUp, yawAngle);
            const qPitch = new THREE.Quaternion().setFromAxisAngle(localRight, pitchAngle);
            drag.nodeObj.quaternion.copy(qYaw).multiply(qPitch).multiply(drag.startQuat);
          }
        }
        const adapter = this.adapters.get(drag.instanceId);
        this.rigVisualizer.updateLivePositions(adapter, this.getActiveEditorCamera());
        if (this.selectionBoxHelper.visible) {
          this.selectionBoxHelper.update();
        }
        this.requestRender();
      }
      return;
    }

    if (this.transformControls.dragging || e.buttons !== 0) {
      if (this.lastHover) this.clearHoverHighlight();
      return;
    }

    const now = performance.now();
    if (now - this.lastHoverRayMs < 32) return;
    this.lastHoverRayMs = now;

    const hit = this.inspectRayTarget(e.clientX, e.clientY, { preferBodyPart: true });
    if (!hit) {
      if (this.lastHover) {
        this.clearHoverHighlight();
        this.requestRender();
      }
      return;
    }

    // Clear previous emissive boost without resetting hover tooltip state until updated
    for (const [mat, prev] of this.restoredHoverEmissives.entries()) {
      mat.emissive.setHex(prev.hex);
      mat.emissiveIntensity = prev.intensity;
    }
    this.restoredHoverEmissives.clear();

    if (hit.hitMesh) {
      this.applyMeshHoverEmissive(hit.hitMesh);
      this.hoverBoxHelper.setFromObject(hit.hitMesh);
      this.hoverBoxHelper.visible = true;
    } else {
      this.hoverBoxHelper.visible = false;
    }

    const nextNodeKey =
      hit.target.kind === 'body-part' ? `${hit.target.instanceId}:${hit.target.nodeId}` : null;
    const nextRingAxis = hit.ringAxis ?? null;
    if (nextNodeKey !== this.hoveredNodeKey || nextRingAxis !== this.hoveredRingAxis) {
      this.hoveredNodeKey = nextNodeKey;
      this.hoveredRingAxis = nextRingAxis;
      this.rebuildRigVisuals();
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const hoverInfo: HoverTargetInfo = {
      kind: hit.target.kind === 'none' ? 'character' : (hit.target.kind as HoverTargetInfo['kind']),
      instanceId: 'instanceId' in hit.target ? hit.target.instanceId : undefined,
      nodeId: hit.target.kind === 'body-part' ? hit.target.nodeId : undefined,
      propId: hit.target.kind === 'prop' ? hit.target.propId : undefined,
      groupId: hit.target.kind === 'group' ? hit.target.groupId : undefined,
      lightId: hit.target.kind === 'light' ? hit.target.lightId : undefined,
      pointId: hit.target.kind === 'waypoint' ? hit.target.pointId : undefined,
      chain: hit.target.kind === 'ik-handle' ? hit.target.chain : undefined,
      title: hit.title,
      description: hit.description,
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
      worldPoint: { x: hit.worldPoint.x, y: hit.worldPoint.y, z: hit.worldPoint.z },
      locked: hit.locked,
    };

    this.lastHover = hoverInfo;
    this.callbacks.onHoverChanged?.(hoverInfo);
    this.requestRender();
  };

  private handlePointerLeave = () => {
    if (this.lastHover || this.hoverBoxHelper.visible) {
      this.clearHoverHighlight();
      this.requestRender();
    }
  };

  private handlePointerCancel = (e: PointerEvent) => {
    if (this.directLimbDrag) {
      this.directLimbDrag = null;
      this.activeRingAxis = null;
      this.orbitControls.enabled = this.viewMode === 'editor';
      try {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) {
          this.renderer.domElement.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      this.rebuildRigVisuals();
      this.requestRender();
    }
  };

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };

    if (
      e.button === 0 &&
      this.viewMode === 'editor' &&
      !(this.transformControls as unknown as { axis?: string | null }).axis
    ) {
      const hit = this.inspectRayTarget(e.clientX, e.clientY, { preferBodyPart: true });
      const canDragRing = Boolean(hit?.ringAxis);
      const canDragLimb =
        hit &&
        hit.target.kind === 'body-part' &&
        hit.target.instanceId === this.poseModeInstanceId &&
        hit.target.nodeId !== 'node_0';

      if (hit && hit.target.kind === 'body-part' && (canDragRing || canDragLimb) && !hit.locked) {
        const adapter = this.adapters.get(hit.target.instanceId);
        const nodeObj =
          adapter && 'getNodeObject' in adapter && typeof adapter.getNodeObject === 'function'
            ? adapter.getNodeObject(hit.target.nodeId)
            : undefined;
        if (nodeObj) {
          nodeObj.updateMatrixWorld(true);
          const cam = this.getActiveEditorCamera();
          cam.updateMatrixWorld();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
          const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();

          const parentWorldQuat = new THREE.Quaternion();
          if (nodeObj.parent) {
            nodeObj.parent.getWorldQuaternion(parentWorldQuat);
          }
          const parentInvWorldQuat = parentWorldQuat.clone().invert();

          let jointScreenCenter: { x: number; y: number } | undefined;
          let tangent2D: THREE.Vector2 | undefined;
          let useCircular = false;
          let circularSign = 1;

          if (hit.ringAxis) {
            const rect = this.renderer.domElement.getBoundingClientRect();
            const jointWorld = new THREE.Vector3();
            nodeObj.getWorldPosition(jointWorld);
            const ndcCenter = jointWorld.clone().project(cam);
            jointScreenCenter = {
              x: rect.left + (ndcCenter.x * 0.5 + 0.5) * rect.width,
              y: rect.top + (-ndcCenter.y * 0.5 + 0.5) * rect.height,
            };

            const nodeWorldQuat = new THREE.Quaternion();
            nodeObj.getWorldQuaternion(nodeWorldQuat);
            const localAxis = new THREE.Vector3(
              hit.ringAxis === 'x' ? 1 : 0,
              hit.ringAxis === 'y' ? 1 : 0,
              hit.ringAxis === 'z' ? 1 : 0,
            );
            const axisWorld = localAxis.applyQuaternion(nodeWorldQuat).normalize();
            const axisCamDot = axisWorld.dot(camForward);
            useCircular = Math.abs(axisCamDot) > 0.28;
            // Right-hand thumb rule projected onto screen (Y points down in screen coords)
            circularSign = axisCamDot < 0 ? 1 : -1;

            const radial = hit.worldPoint.clone().sub(jointWorld);
            const tangentWorld = new THREE.Vector3().crossVectors(axisWorld, radial);
            if (tangentWorld.lengthSq() > 1e-5) {
              tangentWorld.normalize();
              const p1 = hit.worldPoint.clone().addScaledVector(tangentWorld, 0.15).project(cam);
              const p0 = hit.worldPoint.clone().project(cam);
              tangent2D = new THREE.Vector2(
                ((p1.x - p0.x) * 0.5) * rect.width,
                (-(p1.y - p0.y) * 0.5) * rect.height,
              );
              if (tangent2D.lengthSq() > 1e-5) tangent2D.normalize();
            }
          }

          this.directLimbDrag = {
            instanceId: hit.target.instanceId,
            nodeId: hit.target.nodeId,
            nodeName: hit.target.nodeName,
            nodeObj,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startQuat: nodeObj.quaternion.clone(),
            parentInvWorldQuat,
            camRight,
            camUp,
            camForward,
            axis: hit.ringAxis ?? null,
            jointScreenCenter,
            tangent2D,
            useCircular,
            circularSign,
            active: false,
          };
          try {
            this.renderer.domElement.setPointerCapture(e.pointerId);
          } catch {
            // Ignore pointer capture failure in synthetic environments
          }
          if (hit.ringAxis) {
            // Prevent OrbitControls from stealing pointer when pressing directly on an X/Y/Z ring
            this.orbitControls.enabled = false;
          }
        }
      }
    }
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (this.directLimbDrag) {
      const drag = this.directLimbDrag;
      this.directLimbDrag = null;
      this.activeRingAxis = null;
      this.orbitControls.enabled = this.viewMode === 'editor';
      try {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) {
          this.renderer.domElement.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      if (drag.active) {
        const adapter = this.adapters.get(drag.instanceId);
        const deltaRot =
          adapter && 'getNodeDeltaRotation' in adapter && typeof adapter.getNodeDeltaRotation === 'function'
            ? adapter.getNodeDeltaRotation(drag.nodeId, drag.nodeObj.rotation)
            : { x: drag.nodeObj.rotation.x, y: drag.nodeObj.rotation.y, z: drag.nodeObj.rotation.z };
        this.callbacks.onSelectTarget(
          { kind: 'body-part', instanceId: drag.instanceId, nodeId: drag.nodeId, nodeName: drag.nodeName },
          e.shiftKey,
        );
        this.callbacks.onNodeTransformCommit(drag.instanceId, drag.nodeId, drag.nodeName, deltaRot, { x: 0, y: 0, z: 0 });
        this.rebuildRigVisuals();
        this.requestRender();
        return;
      }
      if (drag.axis) {
        this.rebuildRigVisuals();
      }
    }

    if (this.transformControls.dragging || this.viewMode !== 'editor' || e.button !== 0) return;
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (dist > 5) return;

    const hit = this.inspectRayTarget(e.clientX, e.clientY, {
      preferBodyPart: e.altKey || this.selectionFilter === 'body-part' || Boolean(this.poseModeInstanceId),
    });

    if (hit) {
      // If clicking outside pose character, exit Pose Mode cleanly or select new object
      if (
        this.poseModeInstanceId &&
        !(
          (hit.target.kind === 'body-part' || hit.target.kind === 'character' || hit.target.kind === 'ik-handle') &&
          hit.target.instanceId === this.poseModeInstanceId
        )
      ) {
        this.poseModeInstanceId = null;
        this.callbacks.onPoseModeChange?.(null);
      }
      this.callbacks.onSelectTarget(hit.target, e.shiftKey);
      return;
    }

    if (this.poseModeInstanceId) {
      this.poseModeInstanceId = null;
      this.callbacks.onPoseModeChange?.(null);
    }
    this.callbacks.onSelectTarget({ kind: 'none' }, false);
  };

  private handleDoubleClick = (e: MouseEvent) => {
    if (this.viewMode !== 'editor') return;
    const hit = this.inspectRayTarget(e.clientX, e.clientY, { preferBodyPart: true, ignoreFilter: true });
    if (!hit) return;

    if (hit.target.kind === 'body-part') {
      this.poseModeInstanceId = hit.target.instanceId;
      this.callbacks.onPoseModeChange?.(hit.target.instanceId, hit.target.nodeId);
      this.callbacks.onSelectTarget(hit.target, false);
      this.rebuildRigVisuals();
      return;
    }

    if (hit.target.kind === 'character' || hit.target.kind === 'group') {
      // If double-clicking character (or character inside group), enter Articulated Pose Mode!
      let charId = hit.target.kind === 'character' ? hit.target.instanceId : null;
      if (!charId && hit.target.kind === 'group') {
        const meta = this.groupMeta.get(hit.target.groupId);
        charId = meta?.memberIds.find((id) => this.adapters.has(id)) ?? null;
      }
      if (charId) {
        const adapter = this.adapters.get(charId);
        const nodes =
          adapter && 'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function'
            ? adapter.getRigNodes()
            : [];
        const preferred =
          nodes.find((n) => n.slot === 'head') ??
          nodes.find((n) => n.slot === 'leftUpperArm') ??
          nodes.find((n) => n.nodeId !== 'node_0') ??
          nodes[0];
        this.poseModeInstanceId = charId;
        this.callbacks.onPoseModeChange?.(charId, preferred?.nodeId);
        if (preferred) {
          this.callbacks.onSelectTarget(
            { kind: 'body-part', instanceId: charId, nodeId: preferred.nodeId, nodeName: preferred.name },
            false,
          );
        } else {
          this.callbacks.onSelectTarget({ kind: 'character', instanceId: charId }, false);
        }
        this.rebuildRigVisuals();
      }
    }
  };

  private handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (this.viewMode !== 'editor') return;
    const hit = this.inspectRayTarget(e.clientX, e.clientY, { preferBodyPart: Boolean(this.poseModeInstanceId) });
    if (hit) {
      this.callbacks.onSelectTarget(hit.target, false);
      this.callbacks.onContextMenuRequest?.(e.clientX, e.clientY, hit.target);
    } else {
      this.callbacks.onContextMenuRequest?.(e.clientX, e.clientY, this.currentSelection);
    }
  };

  private handleContextLost = (e: Event) => {
    e.preventDefault();
  };

  setPlaying(playing: boolean): void {
    if (this.isPlaying === playing) return;
    this.isPlaying = playing;
    if (playing) {
      this.focusAnim = null;
      this.lastTickMs = performance.now();
      this.startLoop();
    } else {
      this.stopLoop();
      this.requestRender();
    }
  }

  private startLoop(): void {
    const tick = () => {
      if (this.disposed || !this.isPlaying) return;
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - this.lastTickMs) / 1000));
      this.lastTickMs = now;

      this.callbacks.onAnimationTick(dt);
      this.renderFrame();

      if (this.isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };

    if (this.isSoftwareGl) {
      this.afterDraw(tick);
    } else {
      this.frameId = requestAnimationFrame(tick);
    }
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
  }

  private afterDraw(cb: () => void): void {
    try {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      if (gl && typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          if (this.disposed) {
            if (sync) gl.deleteSync(sync);
            return;
          }
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            this.frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            this.frameId = window.setTimeout(cb, 80);
          }
        };
        this.frameId = window.setTimeout(poll, 5);
        return;
      }
    } catch {
      // Fallback
    }
    this.frameId = window.setTimeout(cb, 80);
  }

  requestRender(): void {
    if (this.disposed || this.isPlaying) return;
    if (this.renderBusy) {
      this.renderDirty = true;
      return;
    }
    this.renderBusy = true;
    this.frameId = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.renderDirty = false;
      if (this.focusAnim) {
        this.editorCamera.position.lerp(this.focusAnim.targetPos, 0.24);
        this.orbitControls.target.lerp(this.focusAnim.targetLook, 0.24);
        this.focusAnim.remainingFrames -= 1;
        if (
          this.focusAnim.remainingFrames <= 0 ||
          this.editorCamera.position.distanceTo(this.focusAnim.targetPos) < 0.02
        ) {
          this.editorCamera.position.copy(this.focusAnim.targetPos);
          this.orbitControls.target.copy(this.focusAnim.targetLook);
          this.focusAnim = null;
        }
        this.renderDirty = Boolean(this.focusAnim);
      }
      this.orbitControls.update();
      this.syncEditorOrthoCamera();
      this.rigVisualizer.updateScales(this.getActiveEditorCamera());
      this.renderFrame();
      const done = () => {
        this.renderBusy = false;
        if (this.renderDirty) this.requestRender();
      };
      if (this.isSoftwareGl) {
        this.afterDraw(done);
      } else {
        done();
      }
    });
  }

  renderFrame(): void {
    if (this.disposed) return;
    if (this.selectionBoxHelper.visible) {
      this.selectionBoxHelper.update();
    }
    const activeSceneCam =
      this.activeCameraProjection === 'orthographic' ? this.orthoSceneCamera : this.sceneCamera;
    const cam = this.viewMode === 'scene' ? activeSceneCam : this.getActiveEditorCamera();
    this.renderer.render(this.scene, cam);
  }

  captureThumbnailDataUrl(): string | undefined {
    try {
      this.renderFrame();
      return this.renderer.domElement.toDataURL('image/jpeg', 0.65);
    } catch {
      return undefined;
    }
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const aspect = w / h;
    this.editorCamera.aspect = aspect;
    this.editorCamera.updateProjectionMatrix();
    this.syncEditorOrthoCamera();
    this.sceneCamera.aspect = aspect;
    this.sceneCamera.updateProjectionMatrix();
    const os = this.activeCameraOrthoSize;
    this.orthoSceneCamera.left = -os * aspect;
    this.orthoSceneCamera.right = os * aspect;
    this.orthoSceneCamera.top = os;
    this.orthoSceneCamera.bottom = -os;
    this.orthoSceneCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.clearHoverHighlight();
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    dom.removeEventListener('pointermove', this.handlePointerMove);
    dom.removeEventListener('pointerup', this.handlePointerUp);
    dom.removeEventListener('pointercancel', this.handlePointerCancel);
    dom.removeEventListener('pointerleave', this.handlePointerLeave);
    dom.removeEventListener('dblclick', this.handleDoubleClick);
    dom.removeEventListener('contextmenu', this.handleContextMenu);
    dom.removeEventListener('webglcontextlost', this.handleContextLost);

    for (const id of [...this.adapters.keys()]) {
      this.unregisterCharacterAdapter(id);
    }
    for (const light of this.dynamicLights.values()) light.dispose();
    this.dynamicLights.clear();

    this.rigVisualizer.dispose();
    this.orbitControls.dispose();
    this.transformControls.dispose();
    this.floorMesh.geometry.dispose();
    (this.floorMesh.material as THREE.Material).dispose();
    this.gridHelper.dispose();
    this.renderer.dispose();
    dom.remove();
  }
}
