import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type {
  AxisConstraint,
  CameraOrientationState,
  CameraPose,
  DetachedPartSource,
  EditorCameraPreset,
  GizmoMode,
  GizmoSpace,
  HoverTargetInfo,
  IkChainType,
  IkTargetData,
  LiveSizeInfo,
  MotionPathData,
  NodeMaterialOverride,
  SceneGroupData,
  SceneLightData,
  ScenePropData,
  SelectionFilter,
  SelectionTarget,
  SizeUnit,
  SnapSettings,
  StageEnvironmentConfig,
  StageWallConfig,
  Transform3D,
  Vec3,
} from '../core/types';
import { createDefaultStageConfig } from '../core/types';
import { sampleMotionPathCurve } from '../animation/MotionPath';
import type { EvaluatedGroupState, EvaluatedLightState, EvaluatedPropState } from '../animation/SceneEvaluator';
import type { AnyCharacterAdapter } from '../characters/CharacterRegistry';
import { HtmlThreeAdapter } from '../characters/HtmlThreeAdapter';
import { GltfCharacterAdapter } from '../characters/GltfCharacterAdapter';
import { buildPropObject3D, tagPropSubtree } from './PropsFactory';
import { RigVisualizer } from './RigVisualizer';

export interface DetachedPartExtraction {
  name: string;
  transform: Transform3D;
  color: string;
  detachedSource: DetachedPartSource;
  sourceNodeId?: string;
  sourceChildPath?: string;
  templateGroup: THREE.Group;
}

export type CameraViewMode = 'editor' | 'scene';

export interface StudioEngineCallbacks {
  onSelectTarget: (target: SelectionTarget, additive?: boolean) => void;
  onMarqueeSelect?: (targets: SelectionTarget[], additive?: boolean) => void;
  onPoseModeChange?: (instanceId: string | null, preferredNodeId?: string) => void;
  onHoverChanged?: (hover: HoverTargetInfo | null) => void;
  onLiveSizeChange?: (info: LiveSizeInfo | null) => void;
  onCameraOrientationChange?: (state: CameraOrientationState) => void;
  onContextMenuRequest?: (clientX: number, clientY: number, target: SelectionTarget) => void;
  onCharacterTransformCommit: (instanceId: string, transform: Transform3D) => void;
  onNodeTransformCommit: (
    instanceId: string,
    nodeId: string,
    nodeName: string,
    rotation: Vec3,
    position: Vec3,
    scale?: Vec3,
  ) => void;
  onIkTargetCommit: (instanceId: string, chain: IkChainType, targetPos: Vec3) => void;
  onPropTransformCommit: (propId: string, transform: Transform3D) => void;
  onGroupTransformCommit?: (groupId: string, transform: Transform3D) => void;
  onLightPositionCommit: (lightId: string, position: Vec3) => void;
  onCameraTransformCommit: (pose: CameraPose) => void;
  onSceneCameraZoom?: (factor: number) => void;
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

  private gridHelper: THREE.GridHelper;
  private floorMesh: THREE.Mesh;
  private readonly wallsGroup = new THREE.Group();
  private readonly cloudsGroup = new THREE.Group();
  private readonly scaleHandleGroup = new THREE.Group();
  private scaleHandleMesh: THREE.Mesh;
  private scaleHandleLine: THREE.Line;
  private stageConfig: StageEnvironmentConfig = createDefaultStageConfig();
  private stageFloorSig = '';
  private stageGridSig = '';
  private stageWallsSig = '';
  private stageCloudsSig = '';
  private floorLockEnabled = true;
  private showGridFlag = true;
  private lastOrientationSig = '';
  private lastLiveSizeSig = '';
  private readonly sceneCameraMarker: THREE.Group;
  private readonly selectionBoxHelper: THREE.BoxHelper;
  private readonly selectionBoxesGroup = new THREE.Group();
  private readonly hoverBoxHelper: THREE.BoxHelper;
  private readonly marqueeOverlay: HTMLDivElement;
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
  private readonly propMaterialSigs = new Map<string, string>();
  private readonly detachedTemplates = new Map<string, THREE.Group>();
  private readonly propBaseMaterials = new WeakMap<
    THREE.Mesh,
    Array<{
      colorHex?: number;
      emissiveHex?: number;
      emissiveIntensity?: number;
      roughness?: number;
      metalness?: number;
      opacity?: number;
      transparent?: boolean;
    }>
  >();
  private readonly groupProxies = new Map<string, THREE.Group>();
  private readonly groupMeta = new Map<string, { name: string; locked: boolean; memberIds: string[] }>();
  private readonly memberToGroup = new Map<string, string>();
  private readonly dynamicLights = new Map<string, THREE.Light>();
  private readonly lightMarkers = new Map<string, THREE.Mesh>();
  private readonly lockedObjects = new Set<string>();
  private readonly lockedCharacterNodes = new Map<string, Set<string>>();
  private readonly multiSelectedIds = new Set<string>();
  private readonly multiSelectedNodeKeys = new Set<string>();
  private readonly waypointNodes = new Map<
    string,
    { ownerId: string; ownerKind: 'character' | 'prop' | 'camera'; pointId: string; kind: 'point' | 'in' | 'out'; mesh: THREE.Mesh }
  >();

  // Selection highlight state (restored cleanly before material reads/writes/exports)
  private readonly restoredSelectionHighlights = new Map<
    THREE.Material,
    { emissiveHex?: number; emissiveIntensity?: number; colorHex?: number }
  >();

  // Hover highlight state (zero material cloning / allocation)
  private readonly restoredHoverEmissives = new Map<
    THREE.Material,
    { emissiveHex?: number; emissiveIntensity?: number; colorHex?: number }
  >();
  private lastHoverRayMs = 0;
  private lastHover: HoverTargetInfo | null = null;
  private hoveredInstanceId: string | null = null;
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
  private marqueeDrag: {
    startClientX: number;
    startClientY: number;
    currentClientX: number;
    currentClientY: number;
    additive: boolean;
    active: boolean;
  } | null = null;
  private snapRotateRad: number | null = null;
  private snapTranslateStep: number | null = null;
  private suppressNextDblClickUntilMs = 0;
  private directObjectDrag: {
    target: SelectionTarget;
    obj: THREE.Object3D;
    startClientX: number;
    startClientY: number;
    startObjPos: THREE.Vector3;
    startHitPoint: THREE.Vector3;
    dragPlane: THREE.Plane;
    isHorizontalPlane: boolean;
    groupMemberStarts?: { obj: THREE.Object3D; startPos: THREE.Vector3 }[];
    active: boolean;
  } | null = null;
  private directScaleNodeDrag: {
    target: SelectionTarget;
    obj: THREE.Object3D;
    startClientX: number;
    startClientY: number;
    startScale: THREE.Vector3;
    startObjPos: THREE.Vector3;
    groupMemberStarts?: { obj: THREE.Object3D; startScale: THREE.Vector3; startPos: THREE.Vector3 }[];
    active: boolean;
  } | null = null;

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
  private gizmoPointerDown = false;

  constructor(container: HTMLElement, callbacks: StudioEngineCallbacks) {
    this.container = container;
    if (!this.container.style.position) {
      this.container.style.position = 'relative';
    }
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

    this.marqueeOverlay = document.createElement('div');
    this.marqueeOverlay.setAttribute('data-testid', 'viewport-marquee-box');
    this.marqueeOverlay.style.position = 'absolute';
    this.marqueeOverlay.style.border = '1.5px solid #e8702a';
    this.marqueeOverlay.style.backgroundColor = 'rgba(232, 112, 42, 0.16)';
    this.marqueeOverlay.style.borderRadius = '2px';
    this.marqueeOverlay.style.pointerEvents = 'none';
    this.marqueeOverlay.style.display = 'none';
    this.marqueeOverlay.style.zIndex = '25';
    this.container.appendChild(this.marqueeOverlay);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.scene.background = new THREE.Color('#16181c');
    this.scene.fog = new THREE.FogExp2('#16181c', 0.0045);

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const aspect = width / height;

    this.editorCamera = new THREE.PerspectiveCamera(42, aspect, 0.1, 400);
    this.editorCamera.position.set(7.5, 4.8, 12.8);

    this.editorOrthoCamera = new THREE.OrthographicCamera(
      -this.editorOrthoSize * aspect,
      this.editorOrthoSize * aspect,
      this.editorOrthoSize,
      -this.editorOrthoSize,
      0.1,
      400,
    );
    this.editorOrthoCamera.position.copy(this.editorCamera.position);

    this.sceneCamera = new THREE.PerspectiveCamera(40, aspect, 0.1, 400);
    this.sceneCamera.position.set(0, 2.9, 12.8);
    this.sceneCamera.lookAt(0, 2.0, 0);

    this.orthoSceneCamera = new THREE.OrthographicCamera(-6 * aspect, 6 * aspect, 6, -6, 0.1, 400);
    this.orthoSceneCamera.position.copy(this.sceneCamera.position);
    this.orthoSceneCamera.lookAt(0, 2.0, 0);

    this.scene.add(this.lightsGroup);
    this.scene.add(this.lightMarkersGroup);
    this.scene.add(this.propsGroup);
    this.scene.add(this.groupProxiesGroup);
    this.scene.add(this.wallsGroup);
    this.scene.add(this.cloudsGroup);

    // Default floor is a crisp Square canvas stage flush at y = 0
    const floorGeom = new THREE.BoxGeometry(28, 0.08, 28);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x1b1e24,
      roughness: 0.88,
      metalness: 0.05,
      side: THREE.FrontSide,
    });
    this.floorMesh = new THREE.Mesh(floorGeom, floorMat);
    this.floorMesh.position.y = -0.04;
    this.floorMesh.receiveShadow = true;
    this.floorMesh.frustumCulled = false;
    this.scene.add(this.floorMesh);

    this.gridHelper = new THREE.GridHelper(28, 28, 0x3a404d, 0x262a33);
    this.gridHelper.position.y = 0.005;
    this.scene.add(this.gridHelper);

    // Build stylized sky clouds
    this.rebuildStageClouds(this.stageConfig);

    // Interactive 3D Scale Handle Node (floating diamond node at top-right corner of selected object)
    this.scaleHandleGroup.name = 'interactive_scale_node_group';
    this.scaleHandleGroup.visible = false;
    this.scaleHandleGroup.userData.__isSelectionHighlight = true;

    const handleGeom = new THREE.OctahedronGeometry(0.18, 0);
    const handleMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      depthTest: false,
      transparent: true,
      opacity: 0.96,
    });
    this.scaleHandleMesh = new THREE.Mesh(handleGeom, handleMat);
    this.scaleHandleMesh.renderOrder = 999;
    this.scaleHandleMesh.userData.isScaleNodeHandle = true;
    this.scaleHandleMesh.userData.__isSelectionHighlight = true;
    // Crisp cyan halo ring around the scale node so it is unmistakable
    const ringGeom = new THREE.RingGeometry(0.22, 0.27, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.92,
    });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    ringMesh.renderOrder = 998;
    ringMesh.userData.isScaleNodeHandle = true;
    ringMesh.userData.__isSelectionHighlight = true;
    this.scaleHandleMesh.add(ringMesh);
    this.scaleHandleGroup.add(this.scaleHandleMesh);

    const connGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.4, 0.4, 0.4),
    ]);
    const connMat = new THREE.LineBasicMaterial({
      color: 0xf59e0b,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    this.scaleHandleLine = new THREE.Line(connGeom, connMat);
    this.scaleHandleLine.renderOrder = 997;
    this.scaleHandleLine.userData.__isSelectionHighlight = true;
    this.scaleHandleGroup.add(this.scaleHandleLine);
    this.scene.add(this.scaleHandleGroup);

    this.sceneCameraMarker = this.buildSceneCameraMarker();
    this.scene.add(this.sceneCameraMarker);

    this.selectionBoxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xe8702a);
    this.selectionBoxHelper.visible = false;
    this.selectionBoxHelper.userData.__isSelectionHighlight = true;
    this.scene.add(this.selectionBoxHelper);

    this.selectionBoxesGroup.name = 'selection_boxes_group';
    this.selectionBoxesGroup.userData.__isSelectionHighlight = true;
    this.scene.add(this.selectionBoxesGroup);

    this.hoverBoxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0x67e8f9);
    this.hoverBoxHelper.visible = false;
    this.hoverBoxHelper.userData.__isSelectionHighlight = true;
    this.scene.add(this.hoverBoxHelper);

    this.scene.add(this.motionPathGroup);
    this.scene.add(this.rigOverlayGroup);
    this.rigVisualizer = new RigVisualizer(this.rigOverlayGroup);

    this.orbitControls = new OrbitControls(this.editorCamera, this.renderer.domElement);
    this.orbitControls.enableDamping = !this.isSoftwareGl;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.target.set(0, 1.8, 0);
    this.orbitControls.maxPolarAngle = Math.PI * 0.495;
    this.orbitControls.minDistance = 0.15;
    this.orbitControls.maxDistance = 90;
    this.orbitControls.minZoom = 0.12;
    this.orbitControls.maxZoom = 35;
    // Touch pinch uses OrbitControls; mouse wheel & trackpad pinch are intercepted in capture phase by handleWheel.
    this.orbitControls.enableZoom = true;
    this.applyMouseButtonsForGizmoMode();
    this.orbitControls.addEventListener('start', () => {
      this.focusAnim = null;
    });
    this.orbitControls.addEventListener('change', () => {
      if (this.editorProjection === 'perspective') {
        this.syncEditorOrthoCamera();
      }
      this.updateScaleHandleVisual();
      this.emitCameraOrientation();
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
        this.emitLiveSize(false);
      }
      this.requestRender();
    });

    this.transformControls.addEventListener('objectChange', () => {
      const attached = this.transformControls.object;
      if (
        attached &&
        this.floorLockEnabled &&
        this.transformControls.getMode() === 'translate' &&
        (this.currentSelection.kind === 'character' ||
          this.currentSelection.kind === 'prop' ||
          this.currentSelection.kind === 'group')
      ) {
        this.clampObjectAboveFloor(attached);
      }
      this.updateSelectionBoxesOnly();
      this.updateScaleHandleVisual();
      this.emitLiveSize(this.transformControls.getMode() === 'scale');
      if (this.lastRigInstanceId) {
        this.rigVisualizer.updateLivePositions(
          this.adapters.get(this.lastRigInstanceId),
          this.getActiveEditorCamera(),
        );
      }
      this.requestRender();
    });

    const dom = this.renderer.domElement;
    dom.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
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

  private syncEditorOrthoCamera(updatePoseFromPerspective = true): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    if (updatePoseFromPerspective) {
      const dist = this.editorCamera.position.distanceTo(this.orbitControls.target);
      this.editorOrthoSize = Math.max(0.5, dist * 0.42);
      this.editorOrthoCamera.zoom = 1;
      this.editorOrthoCamera.position.copy(this.editorCamera.position);
      this.editorOrthoCamera.quaternion.copy(this.editorCamera.quaternion);
    }
    this.editorOrthoCamera.left = -this.editorOrthoSize * aspect;
    this.editorOrthoCamera.right = this.editorOrthoSize * aspect;
    this.editorOrthoCamera.top = this.editorOrthoSize;
    this.editorOrthoCamera.bottom = -this.editorOrthoSize;
    this.editorOrthoCamera.updateProjectionMatrix();
  }

  setEditorProjection(projection: 'perspective' | 'orthographic'): void {
    if (this.editorProjection === projection) return;
    if (projection === 'orthographic') {
      this.syncEditorOrthoCamera(true);
    } else {
      // Preserve current ortho view direction & effective zoom distance when returning to perspective
      const dir = this.editorOrthoCamera.position.clone().sub(this.orbitControls.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.5, 0.3, 1);
      dir.normalize();
      const effectiveSize = this.editorOrthoSize / Math.max(0.12, this.editorOrthoCamera.zoom);
      const nextDist = THREE.MathUtils.clamp(effectiveSize / 0.42, 0.25, 85);
      this.editorCamera.position.copy(this.orbitControls.target).addScaledVector(dir, nextDist);
      this.editorCamera.lookAt(this.orbitControls.target);
    }
    this.editorProjection = projection;
    const cam = this.getActiveEditorCamera();
    this.orbitControls.object = cam;
    this.transformControls.camera = cam;
    this.orbitControls.update();
    this.requestRender();
  }

  /**
   * Smoothly zooms in (`factor < 1`) or out (`factor > 1`) across Perspective, Orthographic,
   * and Final Camera views. Optionally anchors zoom toward the cursor position on screen.
   */
  zoomBy(factor: number, cursorClient?: { x: number; y: number }): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.focusAnim = null;

    if (this.viewMode === 'scene') {
      this.callbacks.onSceneCameraZoom?.(factor);
      return;
    }

    const clampedFactor = THREE.MathUtils.clamp(factor, 0.5, 2.0);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const hasCursor = Boolean(cursorClient && rect.width > 0 && rect.height > 0);
    const ndcX = hasCursor ? ((cursorClient!.x - rect.left) / rect.width) * 2 - 1 : 0;
    const ndcY = hasCursor ? -((cursorClient!.y - rect.top) / rect.height) * 2 + 1 : 0;

    if (this.editorProjection === 'orthographic') {
      const cam = this.editorOrthoCamera;
      const mouseBefore = hasCursor ? new THREE.Vector3(ndcX, ndcY, 0).unproject(cam) : null;
      const prevZoom = cam.zoom;
      const nextZoom = THREE.MathUtils.clamp(prevZoom / clampedFactor, 0.12, 35);
      if (Math.abs(nextZoom - prevZoom) < 1e-6) return;
      cam.zoom = nextZoom;
      cam.updateProjectionMatrix();

      if (mouseBefore) {
        const mouseAfter = new THREE.Vector3(ndcX, ndcY, 0).unproject(cam);
        const shift = mouseBefore.sub(mouseAfter);
        cam.position.add(shift);
        this.orbitControls.target.add(shift);
      }
      cam.updateMatrixWorld();
      this.orbitControls.update();
      this.rigVisualizer.updateScales(cam);
      this.requestRender();
      return;
    }

    // Perspective camera zoom
    const cam = this.editorCamera;
    const target = this.orbitControls.target;
    const offset = cam.position.clone().sub(target);
    const currentDist = offset.length();
    if (currentDist < 1e-5) {
      offset.set(0, 0.5, 2);
    }
    const minDist = this.orbitControls.minDistance;
    const maxDist = this.orbitControls.maxDistance;
    const nextDist = THREE.MathUtils.clamp(currentDist * clampedFactor, minDist, maxDist);
    const distDelta = currentDist - nextDist;
    if (Math.abs(distDelta) < 1e-6) return;

    if (hasCursor && clampedFactor < 1) {
      // Gently steer toward the cursor ray while zooming in so tiny pieces stay under the pointer
      this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
      const rayDir = this.raycaster.ray.direction.clone().normalize();
      const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      const lateralShift = rayDir
        .clone()
        .sub(camForward.multiplyScalar(rayDir.dot(camForward)))
        .multiplyScalar(distDelta * 0.65);
      target.add(lateralShift);
    }

    offset.setLength(nextDist);
    cam.position.copy(target).add(offset);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    this.syncEditorOrthoCamera(true);
    this.orbitControls.update();
    this.rigVisualizer.updateScales(cam);
    this.requestRender();
  }

  zoomIn(): void {
    this.zoomBy(0.8);
  }

  zoomOut(): void {
    this.zoomBy(1.25);
  }

  setEditorCameraPreset(preset: EditorCameraPreset): void {
    this.focusAnim = null;
    const target = this.getSelectionWorldCenter() ?? new THREE.Vector3(0, 1.5, 0);
    const dist = THREE.MathUtils.clamp(
      this.editorCamera.position.distanceTo(this.orbitControls.target),
      4.5,
      26,
    );
    const offset = new THREE.Vector3(0, 0, dist);
    switch (preset) {
      case 'front':
        offset.set(0, 0, dist);
        break;
      case 'back':
        offset.set(0, 0, -dist);
        break;
      case 'left':
        offset.set(-dist, 0, 0);
        break;
      case 'right':
        offset.set(dist, 0, 0);
        break;
      case 'top':
        offset.set(0, dist, 0.02);
        break;
      case 'bottom':
        // Ensure orbit allows viewing from underneath when user explicitly picks Bottom
        if (this.orbitControls.maxPolarAngle < Math.PI * 0.96) {
          this.orbitControls.maxPolarAngle = Math.PI * 0.96;
        }
        offset.set(0, -dist, 0.02);
        break;
      default:
        offset.set(dist * 0.52, dist * 0.3, dist * 0.82);
        break;
    }
    const nextPos = target.clone().add(offset);
    this.focusAnim = { targetPos: nextPos, targetLook: target, remainingFrames: 16 };
    this.requestRender();
  }

  getCameraOrientation(): CameraOrientationState {
    const cam = this.getActiveEditorCamera();
    cam.updateMatrixWorld();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();

    let viewLabel = this.editorProjection === 'orthographic' ? '3D Ortho' : '3D View';
    if (forward.z < -0.94 && Math.abs(forward.y) < 0.25) viewLabel = 'Front';
    else if (forward.z > 0.94 && Math.abs(forward.y) < 0.25) viewLabel = 'Back';
    else if (forward.x < -0.94 && Math.abs(forward.y) < 0.25) viewLabel = 'Right';
    else if (forward.x > 0.94 && Math.abs(forward.y) < 0.25) viewLabel = 'Left';
    else if (forward.y < -0.94) viewLabel = 'Top';
    else if (forward.y > 0.94) viewLabel = 'Bottom';

    return {
      forward: { x: forward.x, y: forward.y, z: forward.z },
      right: { x: right.x, y: right.y, z: right.z },
      up: { x: up.x, y: up.y, z: up.z },
      viewLabel,
    };
  }

  private emitCameraOrientation(): void {
    if (!this.callbacks.onCameraOrientationChange) return;
    const st = this.getCameraOrientation();
    const sig = `${st.viewLabel}:${st.forward.x.toFixed(2)},${st.forward.y.toFixed(2)},${st.forward.z.toFixed(2)}:${st.up.x.toFixed(2)},${st.up.y.toFixed(2)},${st.up.z.toFixed(2)}`;
    if (sig === this.lastOrientationSig) return;
    this.lastOrientationSig = sig;
    this.callbacks.onCameraOrientationChange(st);
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

  private isObjectEffectivelyVisible(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (!cur.visible) return false;
      if (cur.userData?.__detachedHidden === true) return false;
      if (cur.userData?.__isSelectionHighlight === true) return false;
      if (cur === this.scene) return true;
      cur = cur.parent;
    }
    return false;
  }

  private computeVisibleBox3(root: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    const meshBox = new THREE.Box3();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!this.isObjectEffectivelyVisible(mesh)) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      box.union(meshBox);
    });
    return box;
  }

  private getSelectionWorldBox(): THREE.Box3 | null {
    const box = new THREE.Box3();
    if (this.currentSelection.kind === 'character') {
      const a = this.adapters.get(this.currentSelection.instanceId);
      if (a) {
        const b = this.computeVisibleBox3(a.rootGroup);
        if (!b.isEmpty()) return b;
      }
    } else if (this.currentSelection.kind === 'body-part') {
      const a = this.adapters.get(this.currentSelection.instanceId);
      const n = a && 'getNodeObject' in a && typeof a.getNodeObject === 'function' ? a.getNodeObject(this.currentSelection.nodeId) : undefined;
      if (n) {
        const b = this.computeVisibleBox3(n);
        if (!b.isEmpty()) return b;
      }
    } else if (this.currentSelection.kind === 'prop') {
      const p = this.propObjects.get(this.currentSelection.propId);
      if (p) {
        const b = this.computeVisibleBox3(p);
        if (!b.isEmpty()) return b;
      }
    } else if (this.currentSelection.kind === 'group') {
      const meta = this.groupMeta.get(this.currentSelection.groupId);
      if (meta) {
        for (const id of meta.memberIds) {
          const ch = this.adapters.get(id);
          if (ch) box.union(this.computeVisibleBox3(ch.rootGroup));
          const pr = this.propObjects.get(id);
          if (pr) box.union(this.computeVisibleBox3(pr));
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
    const nextCfg: StageEnvironmentConfig = {
      ...this.stageConfig,
      floorColor: floorColor || this.stageConfig.floorColor,
    };
    this.setStageConfig(nextCfg, backgroundColor, showGrid);
  }

  setStageConfig(config: StageEnvironmentConfig, backgroundColor: string, showGrid: boolean): void {
    this.stageConfig = config;
    this.showGridFlag = showGrid;
    this.setFloorLockEnabled(config.floorLockEnabled);

    const col = new THREE.Color(backgroundColor || '#16181c');
    this.scene.background = col;
    this.scene.fog = new THREE.FogExp2(col.getHex(), 0.0045);

    this.rebuildStageFloor(config);
    this.rebuildStageGrid(config, showGrid);
    this.rebuildStageWalls(config.walls);
    this.rebuildStageClouds(config);
    this.requestRender();
  }

  setFloorLockEnabled(enabled: boolean): void {
    this.floorLockEnabled = enabled;
    this.orbitControls.maxPolarAngle = enabled ? Math.PI * 0.495 : Math.PI * 0.96;
    const mat = this.floorMesh.material as THREE.MeshStandardMaterial;
    if (mat) {
      mat.side = enabled ? THREE.FrontSide : THREE.DoubleSide;
      mat.needsUpdate = true;
    }
    this.requestRender();
  }

  private rebuildStageFloor(config: StageEnvironmentConfig): void {
    const sides = Math.max(3, Math.min(64, Math.round(config.floorSides || 4)));
    const size = Math.max(6, Math.min(120, Number(config.floorSize) || 28));
    const sig = `${config.floorShape}:${sides}:${size}`;
    if (sig !== this.stageFloorSig) {
      this.stageFloorSig = sig;
      let geom: THREE.BufferGeometry;
      if (config.floorShape === 'circle') {
        geom = new THREE.CylinderGeometry(size * 0.5, size * 0.5, 0.08, 64);
      } else if (config.floorShape === 'rectangle') {
        geom = new THREE.BoxGeometry(size * 1.45, 0.08, size * 0.85);
      } else if (config.floorShape === 'polygon') {
        geom = new THREE.CylinderGeometry(size * 0.5, size * 0.5, 0.08, sides);
        if (sides === 4) {
          geom.rotateY(Math.PI / 4);
        }
      } else {
        // Default: crisp Square canvas stage
        geom = new THREE.BoxGeometry(size, 0.08, size);
      }
      this.floorMesh.geometry.dispose();
      this.floorMesh.geometry = geom;
      this.floorMesh.position.y = -0.04;
    }

    const mat = this.floorMesh.material as THREE.MeshStandardMaterial;
    mat.color.set(config.floorColor || '#1b1e24');
    mat.roughness = THREE.MathUtils.clamp(config.floorRoughness ?? 0.88, 0.05, 1);
    mat.side = this.floorLockEnabled ? THREE.FrontSide : THREE.DoubleSide;
    mat.needsUpdate = true;
  }

  private rebuildStageGrid(config: StageEnvironmentConfig, showGrid: boolean): void {
    const size = Math.max(6, Math.min(120, Math.round(config.floorSize || 28)));
    const divisions = Math.max(6, Math.min(80, size));
    const gridColor = config.gridColor || '#3a404d';
    const gridSec = config.gridSecondaryColor || '#262a33';
    const sig = `${size}:${divisions}:${gridColor}:${gridSec}`;
    if (sig !== this.stageGridSig) {
      this.stageGridSig = sig;
      this.scene.remove(this.gridHelper);
      this.gridHelper.dispose();
      this.gridHelper = new THREE.GridHelper(
        size,
        divisions,
        new THREE.Color(gridColor).getHex(),
        new THREE.Color(gridSec).getHex(),
      );
      this.gridHelper.position.y = 0.005;
      this.scene.add(this.gridHelper);
    }
    this.gridHelper.visible = showGrid && this.viewMode === 'editor';
  }

  private rebuildStageWalls(walls: StageWallConfig[]): void {
    const sig = JSON.stringify(walls);
    if (sig === this.stageWallsSig) return;
    this.stageWallsSig = sig;

    while (this.wallsGroup.children.length > 0) {
      const child = this.wallsGroup.children[0];
      this.wallsGroup.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m.dispose());
      }
    }

    for (const wall of walls) {
      if (!wall.visible) continue;
      const w = Math.max(0.5, wall.width || 16);
      const h = Math.max(0.5, wall.height || 8);
      const t = Math.max(0.05, wall.thickness || 0.25);
      const geom = new THREE.BoxGeometry(w, h, t);
      const opacity = THREE.MathUtils.clamp(wall.opacity ?? 1, 0.05, 1);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(wall.color || '#252a34'),
        roughness: 0.85,
        metalness: 0.04,
        transparent: opacity < 0.99,
        opacity,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(wall.position.x, wall.position.y + h * 0.5, wall.position.z);
      mesh.rotation.y = wall.rotationY || 0;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.stageWallId = wall.id;
      this.wallsGroup.add(mesh);
    }
  }

  private rebuildStageClouds(config: StageEnvironmentConfig): void {
    const show = config.showClouds !== false;
    const color = config.cloudColor || '#cbd5e1';
    const opacity = THREE.MathUtils.clamp(config.cloudOpacity ?? 0.42, 0.05, 1);
    const sig = `${show}:${color}:${opacity.toFixed(2)}`;
    if (sig === this.stageCloudsSig) return;
    this.stageCloudsSig = sig;

    while (this.cloudsGroup.children.length > 0) {
      const child = this.cloudsGroup.children[0];
      this.cloudsGroup.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mt) => mt.dispose());
        }
      });
    }

    this.cloudsGroup.visible = show;
    if (!show) return;

    const cloudDefs = [
      { x: -18, y: 15.5, z: -26, s: 2.3 },
      { x: 14, y: 17.2, z: -30, s: 2.8 },
      { x: -28, y: 14.0, z: -8, s: 2.0 },
      { x: 26, y: 15.0, z: -12, s: 2.4 },
      { x: -6, y: 19.0, z: -34, s: 3.1 },
      { x: 22, y: 16.5, z: 18, s: 2.2 },
      { x: -24, y: 16.0, z: 20, s: 2.1 },
    ];
    const puffOffsets = [
      { x: 0, y: 0, z: 0, r: 1.0 },
      { x: -0.95, y: -0.18, z: 0.12, r: 0.78 },
      { x: 0.98, y: -0.15, z: -0.1, r: 0.82 },
      { x: 0.32, y: 0.36, z: 0.2, r: 0.72 },
      { x: -0.35, y: 0.25, z: -0.25, r: 0.68 },
    ];

    const col = new THREE.Color(color);
    const baseMat = new THREE.MeshStandardMaterial({
      color: col,
      emissive: col.clone().multiplyScalar(0.22),
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity,
      depthWrite: false,
    });

    for (const def of cloudDefs) {
      const cluster = new THREE.Group();
      cluster.position.set(def.x, def.y, def.z);
      cluster.scale.set(def.s * 1.45, def.s * 0.62, def.s * 0.92);
      for (const puff of puffOffsets) {
        const geom = new THREE.SphereGeometry(puff.r, 12, 10);
        const mesh = new THREE.Mesh(geom, baseMat.clone());
        mesh.position.set(puff.x, puff.y, puff.z);
        mesh.frustumCulled = false;
        cluster.add(mesh);
      }
      this.cloudsGroup.add(cluster);
    }
    baseMat.dispose();
  }

  private clampObjectAboveFloor(obj: THREE.Object3D, extraMembers?: THREE.Object3D[]): void {
    if (!this.floorLockEnabled) return;
    obj.updateMatrixWorld(true);
    const box = this.computeVisibleBox3(obj);
    if (extraMembers) {
      for (const m of extraMembers) {
        m.updateMatrixWorld(true);
        box.union(this.computeVisibleBox3(m));
      }
    }
    if (!box.isEmpty() && Number.isFinite(box.min.y) && box.min.y < 0) {
      const lift = -box.min.y;
      obj.position.y += lift;
      if (extraMembers) {
        for (const m of extraMembers) {
          m.position.y += lift;
        }
      }
      obj.updateMatrixWorld(true);
    }
  }

  setViewMode(mode: CameraViewMode): void {
    this.viewMode = mode;
    const isEditor = mode === 'editor';
    this.orbitControls.enabled = isEditor;
    this.gridHelper.visible = this.showGridFlag && isEditor;
    this.sceneCameraMarker.visible = isEditor;
    this.lightMarkersGroup.visible = isEditor;
    this.rigOverlayGroup.visible = isEditor && this.showRigOverlay;
    this.transformControls.getHelper().visible = isEditor;
    this.selectionBoxesGroup.visible = isEditor;
    this.selectionBoxHelper.visible = false;
    this.motionPathGroup.visible = isEditor;
    if (!isEditor) {
      this.scaleHandleGroup.visible = false;
      this.clearHoverHighlight();
      this.clearSelectionHighlight();
    } else {
      this.refreshSelectionVisuals();
      this.updateScaleHandleVisual();
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

  private applyMouseButtonsForGizmoMode(): void {
    if (this.gizmoMode === 'orbit') {
      this.orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      this.renderer.domElement.style.cursor = 'grab';
    } else if (this.gizmoMode === 'box-select') {
      this.orbitControls.mouseButtons = {
        LEFT: null as unknown as THREE.MOUSE,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.PAN,
      };
      this.renderer.domElement.style.cursor = 'crosshair';
    } else {
      this.orbitControls.mouseButtons = {
        LEFT: null as unknown as THREE.MOUSE,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.PAN,
      };
      this.renderer.domElement.style.cursor = 'default';
    }
  }

  setMultiSelectedIds(ids: string[]): void {
    this.multiSelectedIds.clear();
    for (const id of ids) this.multiSelectedIds.add(id);
    this.refreshSelectionVisuals();
    this.requestRender();
  }

  setMultiSelectedNodeKeys(keys: string[]): void {
    this.multiSelectedNodeKeys.clear();
    for (const k of keys) this.multiSelectedNodeKeys.add(k);
    this.refreshSelectionVisuals();
    this.rebuildRigVisuals();
    this.requestRender();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.applyMouseButtonsForGizmoMode();
    if (mode === 'select' || mode === 'box-select' || mode === 'orbit') {
      this.transformControls.detach();
    }
    this.attachGizmoToSelection();
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
      this.snapTranslateStep = null;
      this.transformControls.setTranslationSnap(null);
      this.transformControls.setRotationSnap(null);
      this.transformControls.setScaleSnap(null);
    } else {
      this.snapRotateRad = (snap.rotateDegStep * Math.PI) / 180;
      this.snapTranslateStep = snap.translateStep;
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
    this.editorOrthoCamera.zoom = 1;
    this.editorOrthoCamera.updateProjectionMatrix();
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

  /* ---------- Detached Part Extraction, Registration & Material Editing ---------- */

  registerDetachedTemplate(propId: string, templateGroup: THREE.Group): void {
    this.detachedTemplates.set(propId, templateGroup);
  }

  private cloneWithUniqueMaterials(source: THREE.Object3D): THREE.Object3D {
    const clone = source.clone(true);
    clone.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else if (mesh.material) {
        mesh.material = mesh.material.clone();
      }
      if (mesh.geometry) {
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      }
    });
    return clone;
  }

  private readPrimaryColorHex(root: THREE.Object3D): string {
    let hex = '#e8702a';
    root.traverse((obj) => {
      if (hex !== '#e8702a') return;
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const std = mat as THREE.MeshStandardMaterial;
      if (std && 'color' in std && std.color) {
        hex = `#${std.color.getHexString()}`;
      }
    });
    return hex;
  }

  private hasVisibleMesh(root: THREE.Object3D): boolean {
    let found = false;
    root.traverse((obj) => {
      if (found) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && this.isObjectEffectivelyVisible(mesh)) {
        found = true;
      }
    });
    return found;
  }

  private cloneSubtreeCentered(sourceObj: THREE.Object3D): {
    templateGroup: THREE.Group;
    transform: Transform3D;
    color: string;
  } {
    // Strip any temporary editor highlights before cloning so base colors remain authentic
    this.clearHoverEmissivesOnly();
    this.clearSelectionHighlight();

    sourceObj.updateMatrixWorld(true);
    const worldBox = this.computeVisibleBox3(sourceObj);
    const worldCenter = new THREE.Vector3();
    if (!worldBox.isEmpty()) {
      worldBox.getCenter(worldCenter);
    } else {
      sourceObj.getWorldPosition(worldCenter);
    }

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    sourceObj.matrixWorld.decompose(worldPos, worldQuat, worldScale);

    // Ensure non-zero scale for safe matrix inversion
    const safeScale = new THREE.Vector3(
      Math.abs(worldScale.x) < 1e-4 ? 1 : worldScale.x,
      Math.abs(worldScale.y) < 1e-4 ? 1 : worldScale.y,
      Math.abs(worldScale.z) < 1e-4 ? 1 : worldScale.z,
    );

    const pivotMatrix = new THREE.Matrix4().compose(worldCenter, worldQuat, safeScale);
    const invPivotMatrix = pivotMatrix.clone().invert();
    const localMatrix = invPivotMatrix.multiply(sourceObj.matrixWorld.clone());

    const cloned = this.cloneWithUniqueMaterials(sourceObj);
    cloned.visible = true;
    cloned.traverse((o) => {
      delete o.userData.__detachedHidden;
      delete o.userData.characterInstanceId;
      delete o.userData.rigNodeId;
      delete o.userData.rigNodeName;
      delete o.userData.componentGroupId;
      delete o.userData.componentGroupName;
    });

    const locPos = new THREE.Vector3();
    const locQuat = new THREE.Quaternion();
    const locScale = new THREE.Vector3();
    localMatrix.decompose(locPos, locQuat, locScale);
    cloned.position.copy(locPos);
    cloned.quaternion.copy(locQuat);
    cloned.scale.copy(locScale);

    const templateGroup = new THREE.Group();
    templateGroup.name = sourceObj.name || 'Detached Part';
    templateGroup.add(cloned);

    const euler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');
    const color = this.readPrimaryColorHex(templateGroup);

    this.refreshSelectionVisuals();

    return {
      templateGroup,
      transform: {
        position: { x: worldCenter.x, y: worldCenter.y, z: worldCenter.z },
        rotation: { x: euler.x, y: euler.y, z: euler.z },
        scale: { x: safeScale.x, y: safeScale.y, z: safeScale.z },
      },
      color,
    };
  }

  private cloneSingleMeshCentered(mesh: THREE.Mesh): {
    templateGroup: THREE.Group;
    transform: Transform3D;
    color: string;
  } {
    this.clearHoverEmissivesOnly();
    this.clearSelectionHighlight();

    mesh.updateMatrixWorld(true);
    let worldBox = new THREE.Box3();
    if (mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        worldBox = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      }
    }

    const worldCenter = new THREE.Vector3();
    if (!worldBox.isEmpty()) {
      worldBox.getCenter(worldCenter);
    } else {
      mesh.getWorldPosition(worldCenter);
    }

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);

    const safeScale = new THREE.Vector3(
      Math.abs(worldScale.x) < 1e-4 ? 1 : worldScale.x,
      Math.abs(worldScale.y) < 1e-4 ? 1 : worldScale.y,
      Math.abs(worldScale.z) < 1e-4 ? 1 : worldScale.z,
    );

    const pivotMatrix = new THREE.Matrix4().compose(worldCenter, worldQuat, safeScale);
    const invPivotMatrix = pivotMatrix.clone().invert();
    const localMatrix = invPivotMatrix.multiply(mesh.matrixWorld.clone());

    const clonedMat = Array.isArray(mesh.material)
      ? mesh.material.map((m) => m.clone())
      : mesh.material
        ? mesh.material.clone()
        : new THREE.MeshStandardMaterial({ color: 0xe8702a, roughness: 0.6 });
    const clonedGeom = mesh.geometry ? mesh.geometry.clone() : new THREE.BoxGeometry(0.15, 0.15, 0.15);
    clonedGeom.computeBoundingBox();
    clonedGeom.computeBoundingSphere();

    const atomicMesh = new THREE.Mesh(clonedGeom, clonedMat);
    atomicMesh.name = mesh.name || 'Component';
    atomicMesh.castShadow = true;
    atomicMesh.receiveShadow = true;
    atomicMesh.frustumCulled = false;

    const locPos = new THREE.Vector3();
    const locQuat = new THREE.Quaternion();
    const locScale = new THREE.Vector3();
    localMatrix.decompose(locPos, locQuat, locScale);
    atomicMesh.position.copy(locPos);
    atomicMesh.quaternion.copy(locQuat);
    atomicMesh.scale.copy(locScale);

    const templateGroup = new THREE.Group();
    templateGroup.name = mesh.name || 'Basic Component';
    templateGroup.add(atomicMesh);

    const euler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');
    const color = this.readPrimaryColorHex(templateGroup);

    this.refreshSelectionVisuals();

    return {
      templateGroup,
      transform: {
        position: { x: worldCenter.x, y: worldCenter.y, z: worldCenter.z },
        rotation: { x: euler.x, y: euler.y, z: euler.z },
        scale: { x: safeScale.x, y: safeScale.y, z: safeScale.z },
      },
      color,
    };
  }

  private isGenericObjectName(raw: string | undefined | null): boolean {
    if (!raw) return true;
    const t = raw.trim().toLowerCase();
    return (
      !t ||
      t === 'group' ||
      t === 'object3d' ||
      t === 'scene' ||
      t === 'mesh' ||
      t === 'root' ||
      t === 'character' ||
      t === 'character root' ||
      t === 'detached part' ||
      t === 'basic component'
    );
  }

  private collectBasicLeafMeshes(
    root: THREE.Object3D,
    options?: {
      nodeMetaByObj?: Map<THREE.Object3D, { nodeId: string; name: string }>;
      fallbackPrefix?: string;
    },
  ): Array<{
    mesh: THREE.Mesh;
    childPath: string;
    label: string;
    nearestNodeId?: string;
  }> {
    const rawItems: Array<{
      mesh: THREE.Mesh;
      childPath: string;
      baseLabel: string;
      nearestNodeId?: string;
    }> = [];

    const walk = (
      obj: THREE.Object3D,
      pathSegs: number[],
      inheritedName: string,
      inheritedNodeId?: string,
    ) => {
      if (
        !obj.visible ||
        obj.userData?.__detachedHidden === true ||
        obj.userData?.__isSelectionHighlight === true
      ) {
        return;
      }

      const meta = options?.nodeMetaByObj?.get(obj);
      const userNodeName =
        typeof obj.userData?.rigNodeName === 'string' ? obj.userData.rigNodeName : undefined;
      const userNodeId =
        meta?.nodeId ??
        (typeof obj.userData?.rigNodeId === 'string' ? obj.userData.rigNodeId : undefined);
      const currentNodeId = userNodeId && userNodeId !== 'node_0' ? userNodeId : inheritedNodeId;

      let nextName = inheritedName;
      if (meta?.name && !this.isGenericObjectName(meta.name)) {
        nextName = meta.name;
      } else if (userNodeName && !this.isGenericObjectName(userNodeName)) {
        nextName = userNodeName;
      } else if (obj.name && !this.isGenericObjectName(obj.name)) {
        nextName = obj.name;
      }

      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        const posAttr = mesh.geometry.getAttribute('position');
        if (posAttr && posAttr.count > 0) {
          const ownLabel =
            (meta?.name && !this.isGenericObjectName(meta.name) ? meta.name : '') ||
            (mesh.name && !this.isGenericObjectName(mesh.name) ? mesh.name : '') ||
            (userNodeName && !this.isGenericObjectName(userNodeName) ? userNodeName : '') ||
            nextName ||
            options?.fallbackPrefix ||
            'Joint Part';
          rawItems.push({
            mesh,
            childPath: pathSegs.join('/'),
            baseLabel: ownLabel,
            nearestNodeId: currentNodeId,
          });
        }
      }

      for (let i = 0; i < obj.children.length; i++) {
        walk(obj.children[i], [...pathSegs, i], nextName, currentNodeId);
      }
    };

    walk(root, [], options?.fallbackPrefix || '');

    // Deduplicate identical labels cleanly (e.g. "Left Arm 1", "Left Arm 2")
    const totals = new Map<string, number>();
    for (const item of rawItems) {
      totals.set(item.baseLabel, (totals.get(item.baseLabel) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return rawItems.map((item) => {
      const count = totals.get(item.baseLabel) ?? 1;
      if (count <= 1) {
        return {
          mesh: item.mesh,
          childPath: item.childPath,
          label: item.baseLabel,
          nearestNodeId: item.nearestNodeId,
        };
      }
      const nextIdx = (seen.get(item.baseLabel) ?? 0) + 1;
      seen.set(item.baseLabel, nextIdx);
      return {
        mesh: item.mesh,
        childPath: item.childPath,
        label: `${item.baseLabel} ${nextIdx}`,
        nearestNodeId: item.nearestNodeId,
      };
    });
  }

  extractDetachedPartsForCharacter(
    instanceId: string,
    sourceAssetId: string,
    alreadyDetachedNodeIds: string[] = [],
  ): { parts: DetachedPartExtraction[]; detachedNodeIds: string[]; allDetached: boolean } {
    const adapter = this.adapters.get(instanceId);
    if (!adapter || !('getNodeObject' in adapter) || typeof adapter.getNodeObject !== 'function') {
      return { parts: [], detachedNodeIds: [], allDetached: false };
    }
    const rootNode = adapter.getNodeObject('node_0') ?? adapter.rootGroup;
    const rigNodes =
      'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function' ? adapter.getRigNodes() : [];
    const nodeNameByObj = new Map<THREE.Object3D, { nodeId: string; name: string }>();
    for (const rn of rigNodes) {
      const obj = adapter.getNodeObject(rn.nodeId);
      if (obj) nodeNameByObj.set(obj, { nodeId: rn.nodeId, name: rn.name });
    }

    const detachedSet = new Set(alreadyDetachedNodeIds);
    const leafMeshes = this.collectBasicLeafMeshes(rootNode, {
      nodeMetaByObj: nodeNameByObj,
      fallbackPrefix: 'Component',
    });

    const parts: DetachedPartExtraction[] = [];
    const newlyDetachedIds = new Set<string>();

    for (const item of leafMeshes) {
      if (item.nearestNodeId && detachedSet.has(item.nearestNodeId)) continue;
      const { templateGroup, transform, color } = this.cloneSingleMeshCentered(item.mesh);
      parts.push({
        name: item.label,
        transform,
        color,
        sourceNodeId: item.nearestNodeId,
        sourceChildPath: item.childPath,
        detachedSource: {
          originKind: 'character-node',
          sourceAssetId,
          sourceCharacterId: instanceId,
          sourceNodeId: 'node_0',
          sourceChildPath: item.childPath,
          atomicLeafOnly: true,
          sourceColor: color,
        },
        templateGroup,
      });
      if (item.nearestNodeId) newlyDetachedIds.add(item.nearestNodeId);
    }

    const allDetached = parts.length > 0;
    return { parts, detachedNodeIds: Array.from(newlyDetachedIds), allDetached };
  }

  extractBasicPartsForBodyPart(
    instanceId: string,
    sourceAssetId: string,
    nodeId: string,
    nodeName: string,
  ): DetachedPartExtraction[] {
    const adapter = this.adapters.get(instanceId);
    if (!adapter || !('getNodeObject' in adapter) || typeof adapter.getNodeObject !== 'function') {
      return [];
    }
    const nodeObj = adapter.getNodeObject(nodeId);
    if (!nodeObj || !this.hasVisibleMesh(nodeObj)) return [];

    const rigNodes =
      'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function' ? adapter.getRigNodes() : [];
    const nodeNameByObj = new Map<THREE.Object3D, { nodeId: string; name: string }>();
    for (const rn of rigNodes) {
      const obj = adapter.getNodeObject(rn.nodeId);
      if (obj) nodeNameByObj.set(obj, { nodeId: rn.nodeId, name: rn.name });
    }

    const leafMeshes = this.collectBasicLeafMeshes(nodeObj, {
      nodeMetaByObj: nodeNameByObj,
      fallbackPrefix: nodeName || nodeObj.name || 'Component',
    });

    return leafMeshes.map((item) => {
      const { templateGroup, transform, color } = this.cloneSingleMeshCentered(item.mesh);
      return {
        name: item.label,
        transform,
        color,
        sourceNodeId: item.nearestNodeId ?? nodeId,
        sourceChildPath: item.childPath,
        detachedSource: {
          originKind: 'character-node',
          sourceAssetId,
          sourceCharacterId: instanceId,
          sourceNodeId: nodeId,
          sourceChildPath: item.childPath,
          atomicLeafOnly: true,
          sourceColor: color,
        },
        templateGroup,
      };
    });
  }

  extractSubPartsForProp(prop: ScenePropData): DetachedPartExtraction[] {
    const propObj = this.propObjects.get(prop.id);
    if (!propObj) return [];
    const content = propObj.children[0] ?? propObj;
    const leafMeshes = this.collectBasicLeafMeshes(content, {
      fallbackPrefix: prop.name,
    });
    if (leafMeshes.length < 2) return [];

    return leafMeshes.map((item) => {
      const { templateGroup, transform, color } = this.cloneSingleMeshCentered(item.mesh);
      const childPathRel = item.childPath;
      const parentSource = prop.detachedSource;
      const combinedPath = parentSource?.sourceChildPath
        ? childPathRel
          ? `${parentSource.sourceChildPath}/${childPathRel}`
          : parentSource.sourceChildPath
        : childPathRel;

      const detachedSource: DetachedPartSource = parentSource
        ? {
            ...parentSource,
            sourceChildPath: combinedPath,
            atomicLeafOnly: true,
            sourceColor: color,
          }
        : {
            originKind: 'prop-part',
            sourcePropKind: prop.kind,
            sourcePropAssetId: prop.assetId,
            sourceChildPath: childPathRel,
            atomicLeafOnly: true,
            sourceColor: prop.color,
          };

      return {
        name: item.label,
        transform,
        color,
        sourceChildPath: childPathRel,
        detachedSource,
        templateGroup,
      };
    });
  }

  canBreakApartTarget(target: SelectionTarget): boolean {
    if (target.kind === 'group') return true;
    if (target.kind === 'body-part') return true;
    if (target.kind === 'character') {
      const adapter = this.adapters.get(target.instanceId);
      if (!adapter || !('getNodeObject' in adapter) || typeof adapter.getNodeObject !== 'function') {
        return false;
      }
      const rootNode = adapter.getNodeObject('node_0') ?? adapter.rootGroup;
      return this.collectBasicLeafMeshes(rootNode).length >= 1;
    }
    if (target.kind === 'prop') {
      const propObj = this.propObjects.get(target.propId);
      if (!propObj) return false;
      const content = propObj.children[0] ?? propObj;
      return this.collectBasicLeafMeshes(content).length >= 2;
    }
    return false;
  }

  getPropWorldTransform(propId: string): Transform3D | null {
    const obj = this.propObjects.get(propId);
    if (!obj) return null;
    obj.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    obj.matrixWorld.decompose(pos, quat, scale);
    const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { x: euler.x, y: euler.y, z: euler.z },
      scale: { x: scale.x, y: scale.y, z: scale.z },
    };
  }

  private snapshotPropBaseMaterials(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material || this.propBaseMaterials.has(mesh)) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      this.propBaseMaterials.set(
        mesh,
        mats.map((m) => {
          const std = m as THREE.MeshStandardMaterial;
          return {
            colorHex: 'color' in std && std.color ? std.color.getHex() : undefined,
            emissiveHex: 'emissive' in std && std.emissive ? std.emissive.getHex() : undefined,
            emissiveIntensity: typeof std.emissiveIntensity === 'number' ? std.emissiveIntensity : undefined,
            roughness: typeof std.roughness === 'number' ? std.roughness : undefined,
            metalness: typeof std.metalness === 'number' ? std.metalness : undefined,
            opacity: typeof m.opacity === 'number' ? m.opacity : 1,
            transparent: Boolean(m.transparent),
          };
        }),
      );
    });
  }

  private applyPropMaterialOverrideToObject(root: THREE.Object3D, override?: NodeMaterialOverride): void {
    this.clearHoverEmissivesOnly();
    this.clearSelectionHighlight();
    this.snapshotPropBaseMaterials(root);

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const baseList = this.propBaseMaterials.get(mesh);

      mats.forEach((m, idx) => {
        const std = m as THREE.MeshStandardMaterial;
        const base = baseList?.[idx];

        if (!override) {
          if (base) {
            if (base.colorHex !== undefined && 'color' in std && std.color) std.color.setHex(base.colorHex);
            if (base.emissiveHex !== undefined && 'emissive' in std && std.emissive) {
              std.emissive.setHex(base.emissiveHex);
            }
            if (base.emissiveIntensity !== undefined && 'emissiveIntensity' in std) {
              std.emissiveIntensity = base.emissiveIntensity;
            }
            if (base.roughness !== undefined && 'roughness' in std) std.roughness = base.roughness;
            if (base.metalness !== undefined && 'metalness' in std) std.metalness = base.metalness;
            if (base.opacity !== undefined) m.opacity = base.opacity;
            if (base.transparent !== undefined) m.transparent = base.transparent;
            m.needsUpdate = true;
          }
          return;
        }

        if (override.color && 'color' in std && std.color) {
          std.color.set(override.color);
        }
        if (override.emissive && 'emissive' in std && std.emissive) {
          std.emissive.set(override.emissive);
        }
        if (typeof override.emissiveIntensity === 'number' && 'emissiveIntensity' in std) {
          std.emissiveIntensity = override.emissiveIntensity;
        }
        if (typeof override.roughness === 'number' && 'roughness' in std) {
          std.roughness = override.roughness;
        }
        if (typeof override.metalness === 'number' && 'metalness' in std) {
          std.metalness = override.metalness;
        }
        if (typeof override.opacity === 'number') {
          m.opacity = override.opacity;
          m.transparent = override.opacity < 0.999 || Boolean(base?.transparent);
        }
        m.needsUpdate = true;
      });
    });

    this.refreshSelectionVisuals();
  }

  getPropMaterialInfo(propId: string): NodeMaterialOverride | null {
    const root = this.propObjects.get(propId);
    if (!root) return null;
    this.clearHoverEmissivesOnly();
    this.clearSelectionHighlight();

    let info: NodeMaterialOverride | null = null;
    root.traverse((obj) => {
      if (info) return;
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const std = m as THREE.MeshStandardMaterial;
      info = {
        color: 'color' in std && std.color ? `#${std.color.getHexString()}` : '#e8702a',
        emissive: 'emissive' in std && std.emissive ? `#${std.emissive.getHexString()}` : '#000000',
        emissiveIntensity: typeof std.emissiveIntensity === 'number' ? std.emissiveIntensity : 0,
        roughness: typeof std.roughness === 'number' ? std.roughness : 0.65,
        metalness: typeof std.metalness === 'number' ? std.metalness : 0.15,
        opacity: typeof m.opacity === 'number' ? m.opacity : 1,
      };
    });

    this.refreshSelectionVisuals();
    return info;
  }

  private resolveChildByPath(root: THREE.Object3D, path: string): THREE.Object3D | null {
    const parts = path.split('/').filter(Boolean);
    let cur: THREE.Object3D | null = root;
    for (const seg of parts) {
      const idx = Number(seg);
      if (!Number.isFinite(idx) || !cur || !cur.children[idx]) return null;
      cur = cur.children[idx];
    }
    return cur;
  }

  private async reconstructDetachedTemplate(
    prop: ScenePropData,
    glbBinaries: Map<string, ArrayBuffer>,
    htmlAssetSources?: Map<string, string>,
  ): Promise<THREE.Group | null> {
    const src = prop.detachedSource;
    if (!src) return null;

    try {
      if (src.originKind === 'character-node') {
        let sourceObj: THREE.Object3D | undefined;
        let tempAdapter: HtmlThreeAdapter | GltfCharacterAdapter | null = null;

        // First try active adapter if still loaded in scene
        if (src.sourceCharacterId) {
          const liveAdapter = this.adapters.get(src.sourceCharacterId);
          if (liveAdapter && 'getNodeObject' in liveAdapter && typeof liveAdapter.getNodeObject === 'function' && src.sourceNodeId) {
            sourceObj = liveAdapter.getNodeObject(src.sourceNodeId);
          }
        }

        // Fallback: load temporary adapter from asset source (e.g. after page reload or after full ungroup)
        if (!sourceObj && src.sourceAssetId) {
          const html = htmlAssetSources?.get(src.sourceAssetId);
          const glb = glbBinaries.get(src.sourceAssetId);
          if (html) {
            tempAdapter = new HtmlThreeAdapter(`tmp_${prop.id}`, src.sourceAssetId, html, false);
            await tempAdapter.load();
            sourceObj = src.sourceNodeId ? tempAdapter.getNodeObject(src.sourceNodeId) : tempAdapter.getNodeObject('node_0');
          } else if (glb) {
            tempAdapter = new GltfCharacterAdapter(`tmp_${prop.id}`, src.sourceAssetId, glb);
            await tempAdapter.load();
            sourceObj = src.sourceNodeId ? tempAdapter.getNodeObject(src.sourceNodeId) : tempAdapter.getNodeObject('node_0');
          }
        }

        if (sourceObj) {
          let targetObj: THREE.Object3D = sourceObj;
          if (src.sourceChildPath) {
            const sub = this.resolveChildByPath(sourceObj, src.sourceChildPath);
            if (sub) targetObj = sub;
          }
          const wasVisible = targetObj.visible;
          const wasDetached = targetObj.userData.__detachedHidden;
          targetObj.visible = true;
          delete targetObj.userData.__detachedHidden;
          const { templateGroup } =
            src.atomicLeafOnly && (targetObj as THREE.Mesh).isMesh
              ? this.cloneSingleMeshCentered(targetObj as THREE.Mesh)
              : this.cloneSubtreeCentered(targetObj);
          targetObj.visible = wasVisible;
          targetObj.userData.__detachedHidden = wasDetached;
          tempAdapter?.dispose();
          return templateGroup;
        }
        tempAdapter?.dispose();
      } else if (src.originKind === 'prop-part' && src.sourcePropKind) {
        const tempProp: ScenePropData = {
          ...prop,
          id: `tmp_${prop.id}`,
          kind: src.sourcePropKind,
          assetId: src.sourcePropAssetId,
          color: src.sourceColor ?? prop.color,
          detachedSource: undefined,
        };
        const rebuilt = await buildPropObject3D(
          tempProp,
          src.sourcePropAssetId ? glbBinaries.get(src.sourcePropAssetId) : undefined,
        );
        const content = rebuilt.children[0] ?? rebuilt;
        const targetObj = src.sourceChildPath ? this.resolveChildByPath(content, src.sourceChildPath) : content;
        if (targetObj) {
          const { templateGroup } =
            src.atomicLeafOnly && (targetObj as THREE.Mesh).isMesh
              ? this.cloneSingleMeshCentered(targetObj as THREE.Mesh)
              : this.cloneSubtreeCentered(targetObj);
          return templateGroup;
        }
      }
    } catch {
      // Fall back to small placeholder box if source asset was deleted
    }
    return null;
  }

  /* ---------- Props & Parent-Child Bone Attachment ---------- */

  private propSyncEpoch = 0;

  async syncSceneProps(
    props: readonly ScenePropData[],
    evalProps: Map<string, EvaluatedPropState>,
    glbBinaries: Map<string, ArrayBuffer>,
    htmlAssetSources?: Map<string, string>,
  ): Promise<void> {
    const epoch = ++this.propSyncEpoch;
    const desiredIds = new Set(props.map((p) => p.id));
    for (const [id, group] of this.propObjects.entries()) {
      if (!desiredIds.has(id)) {
        if (this.currentSelection.kind === 'prop' && this.currentSelection.propId === id) {
          this.transformControls.detach();
        }
        this.propsGroup.remove(group);
        this.propObjects.delete(id);
        this.propHashes.delete(id);
        this.propMaterialSigs.delete(id);
      }
    }

    let rebuiltAny = false;
    for (const prop of props) {
      const sig =
        prop.kind === 'detached-part'
          ? `detached:${prop.id}:${prop.detachedSource?.sourceNodeId ?? ''}:${prop.detachedSource?.sourceChildPath ?? ''}:${prop.pivot?.x ?? 0},${prop.pivot?.y ?? 0},${prop.pivot?.z ?? 0}`
          : `${prop.kind}:${prop.color}:${prop.assetId ?? ''}:${prop.pivot?.x ?? 0},${prop.pivot?.y ?? 0},${prop.pivot?.z ?? 0}`;

      if (this.propHashes.get(prop.id) !== sig) {
        this.propHashes.set(prop.id, sig);
        const built = await buildPropObject3D(prop, prop.assetId ? glbBinaries.get(prop.assetId) : undefined);

        if (prop.kind === 'detached-part') {
          let template = this.detachedTemplates.get(prop.id);
          if (!template) {
            const reconstructed = await this.reconstructDetachedTemplate(prop, glbBinaries, htmlAssetSources);
            if (reconstructed) {
              template = reconstructed;
              this.detachedTemplates.set(prop.id, template);
            }
          }
          const content = built.children[0] ?? built;
          if (template) {
            const clonedContent = this.cloneWithUniqueMaterials(template);
            content.add(clonedContent);
          } else {
            const fallback = new THREE.Mesh(
              new THREE.BoxGeometry(0.3, 0.3, 0.3),
              new THREE.MeshStandardMaterial({ color: prop.color || '#e8702a', roughness: 0.6 }),
            );
            content.add(fallback);
          }
          tagPropSubtree(content, prop.id, prop.name);
        }

        // If a newer sync superseded this build or the prop was removed mid-await, discard stale mesh
        if (epoch !== this.propSyncEpoch && this.propHashes.get(prop.id) !== sig) {
          continue;
        }
        const prev = this.propObjects.get(prop.id);
        if (prev) this.propsGroup.remove(prev);

        built.userData.propId = prop.id;
        built.userData.propName = prop.name;
        this.snapshotPropBaseMaterials(built);
        this.propsGroup.add(built);
        this.propObjects.set(prop.id, built);
        this.propMaterialSigs.delete(prop.id);
        rebuiltAny = true;
      }

      const obj = this.propObjects.get(prop.id);
      const evalState = evalProps.get(prop.id);
      if (!obj || !evalState) continue;

      if (obj.userData.propName !== prop.name) {
        obj.traverse((c) => {
          c.userData.propName = prop.name;
        });
      }
      obj.visible = evalState.visible;

      // Apply independent material overrides (especially for detached parts & custom props)
      const matSig = JSON.stringify(prop.materialOverride ?? null);
      if (this.propMaterialSigs.get(prop.id) !== matSig) {
        this.propMaterialSigs.set(prop.id, matSig);
        this.applyPropMaterialOverrideToObject(obj, prop.materialOverride);
      }

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

    // Re-attach gizmo & selection highlights if current prop was rebuilt
    if (this.currentSelection.kind === 'prop' && this.propObjects.has(this.currentSelection.propId)) {
      if (rebuiltAny || !this.transformControls.object) {
        this.attachGizmoToSelection();
      } else {
        this.refreshSelectionVisuals();
      }
    } else if (rebuiltAny) {
      this.refreshSelectionVisuals();
    }
    if (rebuiltAny) {
      this.requestRender();
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
    if (target.kind === 'none') {
      this.multiSelectedIds.clear();
      this.multiSelectedNodeKeys.clear();
    }
    this.attachGizmoToSelection();
    this.refreshSelectionVisuals();
    this.rebuildRigVisuals();
    this.updateScaleHandleVisual();
    this.emitLiveSize(false);
    this.requestRender();
  }

  private getScalableSelectionObject(): {
    target: SelectionTarget;
    obj: THREE.Object3D;
    label: string;
    locked: boolean;
    groupMembers?: THREE.Object3D[];
  } | null {
    const sel = this.currentSelection;
    if (sel.kind === 'character') {
      const a = this.adapters.get(sel.instanceId);
      if (!a) return null;
      return {
        target: sel,
        obj: a.rootGroup,
        label: a.rootGroup.name || 'Character',
        locked: this.lockedObjects.has(sel.instanceId),
      };
    }
    if (sel.kind === 'body-part') {
      const a = this.adapters.get(sel.instanceId);
      const nodeObj =
        a && 'getNodeObject' in a && typeof a.getNodeObject === 'function'
          ? a.getNodeObject(sel.nodeId)
          : undefined;
      if (!nodeObj || !this.isObjectEffectivelyVisible(nodeObj)) return null;
      return {
        target: sel,
        obj: nodeObj,
        label: sel.nodeName || sel.nodeId,
        locked:
          this.lockedObjects.has(sel.instanceId) ||
          Boolean(this.lockedCharacterNodes.get(sel.instanceId)?.has(sel.nodeId)),
      };
    }
    if (sel.kind === 'prop') {
      const p = this.propObjects.get(sel.propId);
      if (!p || !p.visible) return null;
      return {
        target: sel,
        obj: p,
        label: (p.userData.propName as string) || 'Prop',
        locked: this.lockedObjects.has(sel.propId),
      };
    }
    if (sel.kind === 'group') {
      const proxy = this.groupProxies.get(sel.groupId);
      const meta = this.groupMeta.get(sel.groupId);
      if (!proxy || !meta) return null;
      const groupMembers: THREE.Object3D[] = [];
      for (const mId of meta.memberIds) {
        const ch = this.adapters.get(mId);
        if (ch) groupMembers.push(ch.rootGroup);
        const pr = this.propObjects.get(mId);
        if (pr) groupMembers.push(pr);
      }
      return {
        target: sel,
        obj: proxy,
        label: meta.name || 'Group',
        locked: meta.locked,
        groupMembers,
      };
    }
    return null;
  }

  getSelectionLiveSize(activeDragging = false): LiveSizeInfo | null {
    const resolved = this.getScalableSelectionObject();
    if (!resolved) return null;
    const box = this.getSelectionWorldBox();
    const size = new THREE.Vector3(1, 1, 1);
    if (box && !box.isEmpty()) {
      box.getSize(size);
    }
    let scaleFactor = (resolved.obj.scale.x + resolved.obj.scale.y + resolved.obj.scale.z) / 3;
    if (resolved.target.kind === 'body-part') {
      const a = this.adapters.get(resolved.target.instanceId);
      if (a && 'getNodeDeltaScale' in a && typeof a.getNodeDeltaScale === 'function') {
        const ds = a.getNodeDeltaScale(resolved.target.nodeId, resolved.obj.scale);
        scaleFactor = (ds.x + ds.y + ds.z) / 3;
      }
    }
    return {
      label: resolved.label,
      scaleFactor: Math.max(0.01, scaleFactor),
      widthM: Math.max(0.001, size.x),
      heightM: Math.max(0.001, size.y),
      depthM: Math.max(0.001, size.z),
      activeDragging,
    };
  }

  private emitLiveSize(activeDragging: boolean): void {
    if (!this.callbacks.onLiveSizeChange) return;
    const info = this.getSelectionLiveSize(activeDragging);
    const sig = info
      ? `${info.label}:${info.scaleFactor.toFixed(3)}:${info.widthM.toFixed(3)}:${info.heightM.toFixed(3)}:${info.depthM.toFixed(3)}:${Boolean(info.activeDragging)}`
      : 'none';
    if (sig === this.lastLiveSizeSig) return;
    this.lastLiveSizeSig = sig;
    this.callbacks.onLiveSizeChange(info);
  }

  applyTargetSizeToSelection(targetValue: number, unit: SizeUnit): boolean {
    if (!Number.isFinite(targetValue) || targetValue <= 0) return false;
    const resolved = this.getScalableSelectionObject();
    if (!resolved || resolved.locked) return false;

    const currentInfo = this.getSelectionLiveSize(false);
    if (!currentInfo) return false;

    let multiplier = 1;
    if (unit === '%') {
      multiplier = targetValue / 100 / Math.max(0.01, currentInfo.scaleFactor);
    } else {
      // Reference dimension: height (or max dimension for flat objects) in meters
      const currentDimM = Math.max(0.01, currentInfo.heightM > 0.02 ? currentInfo.heightM : Math.max(currentInfo.widthM, currentInfo.depthM));
      let targetMeters = targetValue;
      if (unit === 'px') {
        // Stage pixel scale: 100 px = 1.00 m
        targetMeters = targetValue / 100;
      } else if (unit === 'cm') {
        targetMeters = targetValue / 100;
      } else if (unit === 'ft') {
        targetMeters = targetValue * 0.3048;
      }
      multiplier = targetMeters / currentDimM;
    }

    if (!Number.isFinite(multiplier) || multiplier <= 0) return false;

    const obj = resolved.obj;
    const nextScale = obj.scale.clone().multiplyScalar(multiplier);
    nextScale.x = THREE.MathUtils.clamp(nextScale.x, 0.02, 40);
    nextScale.y = THREE.MathUtils.clamp(nextScale.y, 0.02, 40);
    nextScale.z = THREE.MathUtils.clamp(nextScale.z, 0.02, 40);
    obj.scale.copy(nextScale);

    if (resolved.target.kind === 'group' && resolved.groupMembers) {
      for (const m of resolved.groupMembers) {
        m.scale.multiplyScalar(multiplier);
        m.scale.x = THREE.MathUtils.clamp(m.scale.x, 0.02, 40);
        m.scale.y = THREE.MathUtils.clamp(m.scale.y, 0.02, 40);
        m.scale.z = THREE.MathUtils.clamp(m.scale.z, 0.02, 40);
      }
    }

    if (this.floorLockEnabled && (resolved.target.kind === 'character' || resolved.target.kind === 'prop' || resolved.target.kind === 'group')) {
      this.clampObjectAboveFloor(obj, resolved.groupMembers);
    }

    // Commit to React state / undo history
    if (resolved.target.kind === 'body-part') {
      const { instanceId, nodeId, nodeName } = resolved.target;
      const adapter = this.adapters.get(instanceId);
      const deltaRot =
        adapter && 'getNodeDeltaRotation' in adapter && typeof adapter.getNodeDeltaRotation === 'function'
          ? adapter.getNodeDeltaRotation(nodeId, obj.rotation)
          : { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z };
      const deltaPos =
        adapter && 'getNodeDeltaPosition' in adapter && typeof adapter.getNodeDeltaPosition === 'function'
          ? adapter.getNodeDeltaPosition(nodeId, obj.position)
          : { x: 0, y: 0, z: 0 };
      const deltaScale =
        adapter && 'getNodeDeltaScale' in adapter && typeof adapter.getNodeDeltaScale === 'function'
          ? adapter.getNodeDeltaScale(nodeId, obj.scale)
          : { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z };
      this.callbacks.onNodeTransformCommit(instanceId, nodeId, nodeName, deltaRot, deltaPos, deltaScale);
    } else {
      this.commitObjectDragTransform(resolved.target, obj);
    }

    this.updateSelectionBoxesOnly();
    this.updateScaleHandleVisual();
    this.emitLiveSize(false);
    this.requestRender();
    return true;
  }

  private updateScaleHandleVisual(): void {
    if (this.viewMode !== 'editor') {
      this.scaleHandleGroup.visible = false;
      return;
    }
    const resolved = this.getScalableSelectionObject();
    if (!resolved || resolved.locked) {
      this.scaleHandleGroup.visible = false;
      return;
    }
    const box = this.getSelectionWorldBox();
    if (!box || box.isEmpty()) {
      this.scaleHandleGroup.visible = false;
      return;
    }

    const cam = this.getActiveEditorCamera();
    cam.updateMatrixWorld();
    const corner = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    const dist = Math.max(1.2, cam.position.distanceTo(corner));
    const offsetMag = THREE.MathUtils.clamp(dist * 0.045, 0.14, 0.85);
    const handlePos = corner
      .clone()
      .addScaledVector(camRight, offsetMag * 0.85)
      .addScaledVector(camUp, offsetMag * 0.85);

    this.scaleHandleMesh.position.copy(handlePos);
    const nodeScale = THREE.MathUtils.clamp(dist * 0.065, 0.35, 1.85);
    this.scaleHandleMesh.scale.setScalar(nodeScale);
    this.scaleHandleMesh.quaternion.copy(cam.quaternion);

    const posAttr = this.scaleHandleLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    posAttr.setXYZ(0, corner.x, corner.y, corner.z);
    posAttr.setXYZ(1, handlePos.x, handlePos.y, handlePos.z);
    posAttr.needsUpdate = true;

    this.scaleHandleGroup.visible = true;
  }

  private clearSelectionBoxes(): void {
    while (this.selectionBoxesGroup.children.length > 0) {
      const ch = this.selectionBoxesGroup.children[0];
      this.selectionBoxesGroup.remove(ch);
      const line = ch as THREE.LineSegments;
      if (line.geometry) line.geometry.dispose();
      if (line.material) {
        const mats = Array.isArray(line.material) ? line.material : [line.material];
        mats.forEach((m) => m.dispose());
      }
    }
    this.selectionBoxHelper.visible = false;
  }

  private clearSelectionHighlight(): void {
    for (const [mat, prev] of this.restoredSelectionHighlights.entries()) {
      const std = mat as THREE.MeshStandardMaterial;
      if (prev.emissiveHex !== undefined && 'emissive' in std && std.emissive) {
        std.emissive.setHex(prev.emissiveHex);
      }
      if (prev.emissiveIntensity !== undefined && 'emissiveIntensity' in std) {
        std.emissiveIntensity = prev.emissiveIntensity;
      }
      if (prev.colorHex !== undefined && 'color' in std && std.color) {
        std.color.setHex(prev.colorHex);
      }
    }
    this.restoredSelectionHighlights.clear();
  }

  private applyMeshSelectionHighlight(rootObj: THREE.Object3D): void {
    const tintColor = new THREE.Color(0xff9248);
    rootObj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (!this.isObjectEffectivelyVisible(mesh)) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (this.restoredSelectionHighlights.has(m)) continue;
        const std = m as THREE.MeshStandardMaterial;
        if ('emissive' in std && std.emissive) {
          this.restoredSelectionHighlights.set(m, {
            emissiveHex: std.emissive.getHex(),
            emissiveIntensity: std.emissiveIntensity ?? 1,
          });
          std.emissive.setHex(0xe8702a);
          std.emissiveIntensity = Math.max(0.36, (std.emissiveIntensity ?? 0) + 0.28);
        } else if ('color' in std && std.color) {
          this.restoredSelectionHighlights.set(m, {
            colorHex: std.color.getHex(),
          });
          std.color.lerp(tintColor, 0.35);
        }
      }
    });
  }

  private collectSelectedObjectRoots(): THREE.Object3D[] {
    const roots = new Set<THREE.Object3D>();
    const addById = (id: string) => {
      const ch = this.adapters.get(id);
      if (ch && ch.rootGroup.visible) roots.add(ch.rootGroup);
      const pr = this.propObjects.get(id);
      if (pr && pr.visible) roots.add(pr);
    };

    if (this.currentSelection.kind === 'character') {
      addById(this.currentSelection.instanceId);
    } else if (this.currentSelection.kind === 'prop') {
      addById(this.currentSelection.propId);
    } else if (this.currentSelection.kind === 'body-part') {
      const a = this.adapters.get(this.currentSelection.instanceId);
      const n =
        a && 'getNodeObject' in a && typeof a.getNodeObject === 'function'
          ? a.getNodeObject(this.currentSelection.nodeId)
          : undefined;
      if (n && this.isObjectEffectivelyVisible(n)) roots.add(n);
    } else if (this.currentSelection.kind === 'group') {
      const meta = this.groupMeta.get(this.currentSelection.groupId);
      if (meta) {
        for (const mId of meta.memberIds) addById(mId);
      }
    } else if (this.currentSelection.kind === 'light') {
      const lm = this.lightMarkers.get(this.currentSelection.lightId);
      if (lm && lm.visible) roots.add(lm);
    } else if (this.currentSelection.kind === 'camera') {
      if (this.sceneCameraMarker.visible) roots.add(this.sceneCameraMarker);
    }

    for (const id of this.multiSelectedIds) {
      addById(id);
    }
    for (const key of this.multiSelectedNodeKeys) {
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const charId = key.slice(0, sep);
      const nodeId = key.slice(sep + 1);
      const a = this.adapters.get(charId);
      const n =
        a && 'getNodeObject' in a && typeof a.getNodeObject === 'function'
          ? a.getNodeObject(nodeId)
          : undefined;
      if (n && this.isObjectEffectivelyVisible(n)) roots.add(n);
    }

    return [...roots];
  }

  private updateSelectionBoxesOnly(): void {
    this.clearSelectionBoxes();
    if (this.viewMode !== 'editor' || this.currentSelection.kind === 'none') {
      return;
    }

    const addBoxHelper = (box: THREE.Box3, color = 0xff8a3d) => {
      if (box.isEmpty()) return;
      // Ensure even super-tiny detached pieces have a clearly visible highlight box
      const size = new THREE.Vector3();
      box.getSize(size);
      const minPad = 0.02;
      if (size.x < minPad || size.y < minPad || size.z < minPad) {
        box.expandByScalar(minPad);
      }
      const helper = new THREE.Box3Helper(box.clone(), new THREE.Color(color));
      helper.userData.__isSelectionHighlight = true;
      this.selectionBoxesGroup.add(helper);
    };

    if (this.currentSelection.kind === 'group') {
      const unionBox = new THREE.Box3();
      const meta = this.groupMeta.get(this.currentSelection.groupId);
      if (meta) {
        for (const mId of meta.memberIds) {
          const ch = this.adapters.get(mId);
          if (ch && ch.rootGroup.visible) {
            const b = this.computeVisibleBox3(ch.rootGroup);
            unionBox.union(b);
          }
          const pr = this.propObjects.get(mId);
          if (pr && pr.visible) {
            const b = this.computeVisibleBox3(pr);
            unionBox.union(b);
          }
        }
      }
      addBoxHelper(unionBox, 0xff8a3d);
      return;
    }

    const roots = this.collectSelectedObjectRoots();
    for (const root of roots) {
      const box = this.computeVisibleBox3(root);
      addBoxHelper(box, 0xff8a3d);
    }
  }

  private refreshSelectionVisuals(): void {
    this.clearHoverEmissivesOnly();
    this.clearSelectionHighlight();
    this.updateSelectionBoxesOnly();

    if (this.viewMode !== 'editor' || this.currentSelection.kind === 'none') {
      return;
    }

    const roots = this.collectSelectedObjectRoots();
    for (const root of roots) {
      this.applyMeshSelectionHighlight(root);
    }
  }

  refreshSelectionHighlight(): void {
    this.refreshSelectionVisuals();
  }

  withoutEditorHighlights<T>(fn: () => T): T {
    this.clearHoverEmissivesOnly();
    this.clearSelectionHighlight();
    try {
      return fn();
    } finally {
      this.refreshSelectionVisuals();
    }
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
    const targetInstanceId = this.hoveredInstanceId ?? this.lastRigInstanceId;
    const adapter = targetInstanceId ? this.adapters.get(targetInstanceId) : undefined;
    const lockedSet = targetInstanceId
      ? this.lockedCharacterNodes.get(targetInstanceId) ?? new Set<string>()
      : new Set<string>();
    this.rigVisualizer.rebuild(adapter, {
      instanceId: targetInstanceId,
      poseModeInstanceId: this.poseModeInstanceId,
      ikTargets: targetInstanceId === this.lastRigInstanceId ? this.lastIkTargets : [],
      selection: this.currentSelection,
      hoveredNodeKey: this.hoveredNodeKey,
      multiSelectedNodeKeys: this.multiSelectedNodeKeys,
      hoveredRingAxis: this.hoveredRingAxis,
      activeRingAxis: this.activeRingAxis,
      lockedNodeIds: lockedSet,
    });
    this.rigVisualizer.updateScales(this.getActiveEditorCamera());
  }

  private attachGizmoToSelection(): void {
    this.transformControls.detach();
    this.selectionBoxHelper.visible = false;

    if (this.viewMode !== 'editor' || this.currentSelection.kind === 'none') return;
    if (this.gizmoMode === 'orbit' || this.gizmoMode === 'box-select') {
      return;
    }

    // Allow body-part & IK interaction in Pose Mode even if toolbar gizmoMode is 'select'
    const isBodyOrIk = this.currentSelection.kind === 'body-part' || this.currentSelection.kind === 'ik-handle';
    if (this.gizmoMode === 'select' && !isBodyOrIk) {
      return;
    }

    this.transformControls.setSpace(this.gizmoSpace);
    const tcMode: 'translate' | 'rotate' | 'scale' =
      this.gizmoMode === 'select' ? 'rotate' : this.gizmoMode;

    if (this.currentSelection.kind === 'character') {
      if (this.lockedObjects.has(this.currentSelection.instanceId)) return;
      const adapter = this.adapters.get(this.currentSelection.instanceId);
      if (adapter) {
        this.transformControls.setMode(tcMode);
        this.transformControls.attach(adapter.rootGroup);
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
      if (nodeObj && this.isObjectEffectivelyVisible(nodeObj)) {
        const isRootNode = nodeId === 'node_0';
        // Give every component (even tiny parts and component groups) full Move (G) & Scale (S) gizmos,
        // and clean RigVisualizer X/Y/Z arrowhead rings for Rotate (R) / Select (Q).
        if (!isRootNode && this.showRigOverlay && (this.gizmoMode === 'select' || this.gizmoMode === 'rotate')) {
          return;
        }
        const effectiveMode =
          tcMode === 'translate' || tcMode === 'scale' ? tcMode : isRootNode ? tcMode : 'rotate';
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
      if (propObj && propObj.visible) {
        this.transformControls.setMode(tcMode);
        this.transformControls.attach(propObj);
      }
    } else if (this.currentSelection.kind === 'group') {
      const grpMeta = this.groupMeta.get(this.currentSelection.groupId);
      if (grpMeta?.locked) return;
      const proxy = this.groupProxies.get(this.currentSelection.groupId);
      if (proxy) {
        this.transformControls.setMode(tcMode);
        this.transformControls.attach(proxy);
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
      const deltaPos =
        adapter && 'getNodeDeltaPosition' in adapter && typeof adapter.getNodeDeltaPosition === 'function'
          ? adapter.getNodeDeltaPosition(nodeId, obj.position)
          : { x: 0, y: 0, z: 0 };
      const deltaScale =
        this.transformControls.getMode() === 'scale'
          ? adapter && 'getNodeDeltaScale' in adapter && typeof adapter.getNodeDeltaScale === 'function'
            ? adapter.getNodeDeltaScale(nodeId, obj.scale)
            : { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
          : undefined;

      this.callbacks.onNodeTransformCommit(instanceId, nodeId, nodeName, deltaRot, deltaPos, deltaScale);
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

  private clearHoverEmissivesOnly(): void {
    for (const [mat, prev] of this.restoredHoverEmissives.entries()) {
      const std = mat as THREE.MeshStandardMaterial;
      if (prev.emissiveHex !== undefined && 'emissive' in std && std.emissive) {
        std.emissive.setHex(prev.emissiveHex);
      }
      if (prev.emissiveIntensity !== undefined && 'emissiveIntensity' in std) {
        std.emissiveIntensity = prev.emissiveIntensity;
      }
      if (prev.colorHex !== undefined && 'color' in std && std.color) {
        std.color.setHex(prev.colorHex);
      }
    }
    this.restoredHoverEmissives.clear();
  }

  private clearHoverHighlight(): void {
    this.clearHoverEmissivesOnly();
    this.hoverBoxHelper.visible = false;
    if (this.hoveredInstanceId !== null || this.hoveredNodeKey !== null || this.hoveredRingAxis !== null) {
      this.hoveredInstanceId = null;
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
    const hoverTint = new THREE.Color(0x5eead4);
    rootObj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (!this.isObjectEffectivelyVisible(mesh)) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (this.restoredHoverEmissives.has(m)) continue;
        const std = m as THREE.MeshStandardMaterial;
        if ('emissive' in std && std.emissive) {
          this.restoredHoverEmissives.set(m, {
            emissiveHex: std.emissive.getHex(),
            emissiveIntensity: std.emissiveIntensity ?? 1,
          });
          std.emissive.setHex(0x2dd4bf);
          std.emissiveIntensity = 0.28;
        } else if ('color' in std && std.color) {
          this.restoredHoverEmissives.set(m, {
            colorHex: std.color.getHex(),
          });
          std.color.lerp(hoverTint, 0.25);
        }
      }
    });
  }

  private inspectRayTarget(
    clientX: number,
    clientY: number,
    options?: { preferBodyPart?: boolean; ignoreFilter?: boolean; ignoreGroups?: boolean },
  ): {
    target: SelectionTarget;
    hitMesh: THREE.Object3D | null;
    worldPoint: THREE.Vector3;
    title: string;
    description: string;
    locked: boolean;
    ringAxis?: 'x' | 'y' | 'z';
    isScaleHandle?: boolean;
  } | null {
    this.updateRayFromEvent(clientX, clientY);
    const allow = (k: SelectionFilter) =>
      options?.ignoreFilter || this.selectionFilter === 'all' || this.selectionFilter === k;

    // -1. Interactive 3D Scale Size Node (highest priority when visible)
    if (this.scaleHandleGroup.visible) {
      const scaleHits = this.raycaster.intersectObject(this.scaleHandleMesh, true);
      if (scaleHits.length > 0) {
        return {
          target: this.currentSelection,
          hitMesh: null,
          worldPoint: scaleHits[0].point,
          title: 'Resize Size Node',
          description: 'Drag up/right to enlarge or down/left to shrink (live size readout)',
          locked: false,
          isScaleHandle: true,
        };
      }
    }

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

    // 3. Focused Rig Joint Sockets (only pick active/focused sockets or all sockets in explicit Pose Mode
    // so dimmed background sockets NEVER steal clicks from the exact 3D mesh under the cursor)
    const canPickRigSockets =
      this.selectionFilter !== 'character' &&
      (Boolean(options?.preferBodyPart) ||
        this.selectionFilter === 'body-part' ||
        Boolean(this.poseModeInstanceId));
    if (this.showRigOverlay && canPickRigSockets && this.rigVisualizer.rigNodeHandles.size > 0) {
      const candidateSockets = [...this.rigVisualizer.rigNodeHandles.values()].filter((m) => {
        if (this.poseModeInstanceId) return true;
        return Boolean(m.userData?.rigNodeHandle?.isFocused);
      });
      const jointHits =
        candidateSockets.length > 0 ? this.raycaster.intersectObjects(candidateSockets, false) : [];
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

    // 4. Characters, Props (including detached smallest pieces), Lights, Camera
    const targets: THREE.Object3D[] = [];
    if (allow('character') || allow('body-part') || allow('group')) {
      for (const a of this.adapters.values()) {
        if (a.rootGroup.visible) {
          a.rootGroup.updateMatrixWorld(true);
          targets.push(a.rootGroup);
        }
      }
    }
    if (allow('prop') || allow('group')) {
      for (const p of this.propObjects.values()) {
        if (p.visible) {
          p.updateMatrixWorld(true);
          targets.push(p);
        }
      }
    }
    if (allow('light')) {
      for (const lm of this.lightMarkers.values()) {
        if (lm.visible) targets.push(lm);
      }
    }
    if (allow('camera') && this.sceneCameraMarker.visible) {
      targets.push(this.sceneCameraMarker);
    }

    // CRITICAL: Filter out invisible meshes (such as hidden HTML stagePropsGroup floors or detached nodes!)
    const rawHits = this.raycaster.intersectObjects(targets, true);
    const hits = rawHits.filter((h) => this.isObjectEffectivelyVisible(h.object));

    if (hits.length === 0) {
      // Small-piece proximity fallback: make tiny detached pieces (pupils, cuffs, buttons) & markers effortless to click
      return this.inspectTinyPieceScreenFallback(clientX, clientY, allow, options);
    }

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

    // Walk ancestors for prop / character & component group
    let cur: THREE.Object3D | null = hitObj;
    let propId: string | null = null;
    let propName = 'Prop';
    let charId: string | null = null;
    let nearestRigNodeId: string | null = null;
    let nearestRigNodeName: string | null = null;
    let componentGroupId: string | null = null;
    let componentGroupName: string | null = null;

    while (cur) {
      if (!propId && typeof cur.userData.propId === 'string') {
        propId = cur.userData.propId;
        propName = String(cur.userData.propName || propId);
      }
      if (!componentGroupId && cur.userData.isComponentGroup === true && typeof cur.userData.rigNodeId === 'string') {
        componentGroupId = cur.userData.rigNodeId;
        componentGroupName = String(cur.userData.rigNodeName || componentGroupId);
      }
      if (!nearestRigNodeId && typeof cur.userData.rigNodeId === 'string') {
        nearestRigNodeId = cur.userData.rigNodeId;
        nearestRigNodeName = typeof cur.userData.rigNodeName === 'string' ? cur.userData.rigNodeName : null;
      }
      if (!charId && typeof cur.userData.characterInstanceId === 'string') {
        charId = cur.userData.characterInstanceId;
      }
      cur = cur.parent;
    }

    if (propId) {
      const grpId = this.memberToGroup.get(propId);
      if (grpId && !options?.preferBodyPart && !options?.ignoreGroups && this.currentSelection.kind !== 'prop') {
        const gMeta = this.groupMeta.get(grpId);
        return {
          target: { kind: 'group', groupId: grpId },
          hitMesh: this.propObjects.get(propId) ?? hitObj,
          worldPoint: hits[0].point,
          title: gMeta?.name ?? 'Group',
          description: 'Grouped object • Ctrl+Shift+G to ungroup • Alt+Click to pick member',
          locked: Boolean(gMeta?.locked),
        };
      }
      return {
        target: { kind: 'prop', propId },
        hitMesh: this.propObjects.get(propId) ?? hitObj,
        worldPoint: hits[0].point,
        title: propName,
        description: 'Independent object • Ctrl+Shift+G to break apart further',
        locked: this.lockedObjects.has(propId),
      };
    }

    if (charId) {
      const rawNodeId =
        (!options?.ignoreGroups && componentGroupId) ||
        (typeof hitObj.userData.rigNodeId === 'string' ? hitObj.userData.rigNodeId : nearestRigNodeId);
      const adapter = this.adapters.get(charId);
      const allNodes =
        adapter && 'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function'
          ? adapter.getRigNodes()
          : [];
      const effectiveNode = rawNodeId ? allNodes.find((n) => n.nodeId === rawNodeId) : undefined;

      const rigNodeId = effectiveNode?.nodeId ?? rawNodeId;
      const rigNodeName =
        effectiveNode?.name ??
        (!options?.ignoreGroups && componentGroupName ? componentGroupName : null) ??
        nearestRigNodeName ??
        String(hitObj.userData.rigNodeName || rigNodeId || 'Part');
      const nodeObj =
        rigNodeId && adapter && 'getNodeObject' in adapter && typeof adapter.getNodeObject === 'function'
          ? adapter.getNodeObject(rigNodeId)
          : undefined;

      // If this character is explicitly inside a logical SceneGroupData, keep group behavior unless drilling in
      const grpId = this.memberToGroup.get(charId);
      if (
        grpId &&
        !options?.ignoreGroups &&
        this.poseModeInstanceId !== charId &&
        this.selectionFilter !== 'body-part' &&
        this.currentSelection.kind !== 'character' &&
        this.currentSelection.kind !== 'body-part'
      ) {
        const gMeta = this.groupMeta.get(grpId);
        return {
          target: { kind: 'group', groupId: grpId },
          hitMesh: adapter?.rootGroup ?? hitObj,
          worldPoint: hits[0].point,
          title: gMeta?.name ?? 'Group',
          description: 'Grouped character • Ctrl+Shift+G to ungroup • Alt+Click to pick part',
          locked: Boolean(gMeta?.locked),
        };
      }

      // Direct part-level picking by default! Clicking a part selects ONLY that part (never the whole character)
      // unless the user explicitly filtered selection to whole 'character' mode.
      const shouldPickBodyPart =
        Boolean(rigNodeId) &&
        (options?.preferBodyPart ||
          this.selectionFilter !== 'character' ||
          this.poseModeInstanceId === charId);
      if (shouldPickBodyPart && rigNodeId) {
        const lockedNode = Boolean(this.lockedCharacterNodes.get(charId)?.has(rigNodeId));
        return {
          target: { kind: 'body-part', instanceId: charId, nodeId: rigNodeId, nodeName: rigNodeName },
          hitMesh: nodeObj ?? hitObj,
          worldPoint: hits[0].point,
          title: rigNodeName,
          description:
            effectiveNode?.description ||
            `Part: ${rigNodeName} • Drag to rotate • G/R/S + X/Y/Z • Ctrl+Shift+G to ungroup to basic parts`,
          locked: lockedNode || this.lockedObjects.has(charId),
        };
      }

      return {
        target: { kind: 'character', instanceId: charId },
        hitMesh: rigNodeId && effectiveNode ? (nodeObj ?? hitObj) : (adapter?.rootGroup ?? hitObj),
        worldPoint: hits[0].point,
        title: effectiveNode ? rigNodeName : 'Character',
        description: effectiveNode
          ? `${effectiveNode.description ?? 'Select part'} • Ctrl+Shift+G to ungroup to basic components`
          : 'Click to select • Ctrl+Shift+G to ungroup to basic components',
        locked: this.lockedObjects.has(charId),
      };
    }

    return null;
  }

  private inspectTinyPieceScreenFallback(
    clientX: number,
    clientY: number,
    allow: (k: SelectionFilter) => boolean,
    options?: { preferBodyPart?: boolean; ignoreFilter?: boolean; ignoreGroups?: boolean },
  ): {
    target: SelectionTarget;
    hitMesh: THREE.Object3D | null;
    worldPoint: THREE.Vector3;
    title: string;
    description: string;
    locked: boolean;
    ringAxis?: 'x' | 'y' | 'z';
  } | null {
    if (!allow('prop') && !allow('group')) return null;
    const domRect = this.renderer.domElement.getBoundingClientRect();
    const cam = this.getActiveEditorCamera();
    cam.updateMatrixWorld();

    let best: {
      propId: string;
      propObj: THREE.Group;
      center: THREE.Vector3;
      distPx: number;
      camDist: number;
    } | null = null;

    const proj = new THREE.Vector3();
    for (const [propId, propObj] of this.propObjects.entries()) {
      if (!propObj.visible) continue;
      const box = this.computeVisibleBox3(propObj);
      if (box.isEmpty()) continue;
      const center = new THREE.Vector3();
      box.getCenter(center);
      proj.copy(center).project(cam);
      if (proj.z < -1 || proj.z > 1) continue;
      const sx = domRect.left + (proj.x * 0.5 + 0.5) * domRect.width;
      const sy = domRect.top + (-proj.y * 0.5 + 0.5) * domRect.height;
      const distPx = Math.hypot(clientX - sx, clientY - sy);
      if (distPx > 12) continue;

      // Only apply proximity fallback to visually small pieces (< 28px bounding extent)
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0.65) continue;

      const camDist = center.distanceTo(cam.position);
      if (!best || camDist < best.camDist) {
        best = { propId, propObj, center, distPx, camDist };
      }
    }

    if (!best) return null;
    const propName = String(best.propObj.userData.propName || best.propId);
    const grpId = this.memberToGroup.get(best.propId);
    if (grpId && !options?.preferBodyPart && !options?.ignoreGroups && this.currentSelection.kind !== 'prop') {
      const gMeta = this.groupMeta.get(grpId);
      return {
        target: { kind: 'group', groupId: grpId },
        hitMesh: best.propObj,
        worldPoint: best.center,
        title: gMeta?.name ?? 'Group',
        description: 'Grouped object • Ctrl+Shift+G to ungroup',
        locked: Boolean(gMeta?.locked),
      };
    }
    return {
      target: { kind: 'prop', propId: best.propId },
      hitMesh: best.propObj,
      worldPoint: best.center,
      title: propName,
      description: 'Independent object • Ctrl+Shift+G to break apart further',
      locked: this.lockedObjects.has(best.propId),
    };
  }

  private updateMarqueeOverlay(drag: NonNullable<typeof this.marqueeDrag>): void {
    const rect = this.container.getBoundingClientRect();
    const x0 = Math.max(0, Math.min(drag.startClientX, drag.currentClientX) - rect.left);
    const y0 = Math.max(0, Math.min(drag.startClientY, drag.currentClientY) - rect.top);
    const x1 = Math.min(rect.width, Math.max(drag.startClientX, drag.currentClientX) - rect.left);
    const y1 = Math.min(rect.height, Math.max(drag.startClientY, drag.currentClientY) - rect.top);
    this.marqueeOverlay.style.left = `${x0}px`;
    this.marqueeOverlay.style.top = `${y0}px`;
    this.marqueeOverlay.style.width = `${Math.max(1, x1 - x0)}px`;
    this.marqueeOverlay.style.height = `${Math.max(1, y1 - y0)}px`;
    this.marqueeOverlay.style.display = 'block';
  }

  private hideMarqueeOverlay(): void {
    this.marqueeOverlay.style.display = 'none';
  }

  private projectBoxIntersectsScreenRect(
    box: THREE.Box3,
    cam: THREE.Camera,
    domRect: DOMRect,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): boolean {
    if (box.isEmpty()) return false;
    const { min, max } = box;
    const corners = [
      new THREE.Vector3(min.x, min.y, min.z),
      new THREE.Vector3(min.x, min.y, max.z),
      new THREE.Vector3(min.x, max.y, min.z),
      new THREE.Vector3(min.x, max.y, max.z),
      new THREE.Vector3(max.x, min.y, min.z),
      new THREE.Vector3(max.x, min.y, max.z),
      new THREE.Vector3(max.x, max.y, min.z),
      new THREE.Vector3(max.x, max.y, max.z),
    ];
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    let anyInFront = false;
    for (const c of corners) {
      c.project(cam);
      if (c.z >= -1.05 && c.z <= 1.02) anyInFront = true;
      const sx = domRect.left + (c.x * 0.5 + 0.5) * domRect.width;
      const sy = domRect.top + (-c.y * 0.5 + 0.5) * domRect.height;
      if (sx < bx0) bx0 = sx;
      if (sx > bx1) bx1 = sx;
      if (sy < by0) by0 = sy;
      if (sy > by1) by1 = sy;
    }
    if (!anyInFront) return false;
    return bx1 >= minX && bx0 <= maxX && by1 >= minY && by0 <= maxY;
  }

  private getDirectNodeBox3(nodeObj: THREE.Object3D, nodeId: string): THREE.Box3 {
    const box = new THREE.Box3();
    if (nodeObj.userData?.isComponentGroup) {
      return box.setFromObject(nodeObj);
    }
    nodeObj.updateMatrixWorld(true);
    const mesh = nodeObj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) {
        box.copy(mesh.geometry.boundingBox).applyMatrix4(nodeObj.matrixWorld);
        return box;
      }
    }
    for (const child of nodeObj.children) {
      const cMesh = child as THREE.Mesh;
      if (cMesh.isMesh && cMesh.visible && cMesh.geometry && child.userData?.rigNodeId === nodeId) {
        if (!cMesh.geometry.boundingBox) cMesh.geometry.computeBoundingBox();
        if (cMesh.geometry.boundingBox) {
          box.union(cMesh.geometry.boundingBox.clone().applyMatrix4(cMesh.matrixWorld));
        }
      }
    }
    if (box.isEmpty()) {
      const wp = new THREE.Vector3();
      nodeObj.getWorldPosition(wp);
      box.setFromCenterAndSize(wp, new THREE.Vector3(0.14, 0.14, 0.14));
    }
    return box;
  }

  private isInsideComponentGroup(obj: THREE.Object3D, rootStop: THREE.Object3D): boolean {
    let p = obj.parent;
    while (p && p !== rootStop) {
      if (p.userData?.isComponentGroup === true) return true;
      p = p.parent;
    }
    return false;
  }

  private collectMarqueeTargets(drag: NonNullable<typeof this.marqueeDrag>): SelectionTarget[] {
    const minX = Math.min(drag.startClientX, drag.currentClientX);
    const maxX = Math.max(drag.startClientX, drag.currentClientX);
    const minY = Math.min(drag.startClientY, drag.currentClientY);
    const maxY = Math.max(drag.startClientY, drag.currentClientY);
    const domRect = this.renderer.domElement.getBoundingClientRect();
    const cam = this.getActiveEditorCamera();
    cam.updateMatrixWorld();

    const results: SelectionTarget[] = [];

    if (this.poseModeInstanceId || this.selectionFilter === 'body-part') {
      const charIds = this.poseModeInstanceId ? [this.poseModeInstanceId] : [...this.adapters.keys()];
      for (const charId of charIds) {
        const adapter = this.adapters.get(charId);
        if (!adapter || !adapter.rootGroup.visible) continue;
        if (!('getRigNodes' in adapter) || typeof adapter.getRigNodes !== 'function') continue;
        if (!('getNodeObject' in adapter) || typeof adapter.getNodeObject !== 'function') continue;
        adapter.rootGroup.updateMatrixWorld(true);
        const nodes = adapter.getRigNodes();
        for (const node of nodes) {
          if (node.nodeId === 'node_0') continue;
          const nodeObj = adapter.getNodeObject(node.nodeId);
          if (!nodeObj || !nodeObj.visible) continue;
          if (!nodeObj.userData?.isComponentGroup && this.isInsideComponentGroup(nodeObj, adapter.rootGroup)) {
            continue;
          }
          const box = this.getDirectNodeBox3(nodeObj, node.nodeId);
          if (this.projectBoxIntersectsScreenRect(box, cam, domRect, minX, maxX, minY, maxY)) {
            results.push({
              kind: 'body-part',
              instanceId: charId,
              nodeId: node.nodeId,
              nodeName: node.name,
            });
          }
        }
      }
      return results;
    }

    const allowChars = this.selectionFilter === 'all' || this.selectionFilter === 'character' || this.selectionFilter === 'group';
    const allowProps = this.selectionFilter === 'all' || this.selectionFilter === 'prop' || this.selectionFilter === 'group';

    if (allowChars) {
      for (const [charId, adapter] of this.adapters.entries()) {
        if (!adapter.rootGroup.visible) continue;
        const box = this.computeVisibleBox3(adapter.rootGroup);
        if (!box.isEmpty() && this.projectBoxIntersectsScreenRect(box, cam, domRect, minX, maxX, minY, maxY)) {
          results.push({ kind: 'character', instanceId: charId });
        }
      }
    }
    if (allowProps) {
      for (const [propId, propObj] of this.propObjects.entries()) {
        if (!propObj.visible) continue;
        const box = this.computeVisibleBox3(propObj);
        if (!box.isEmpty() && this.projectBoxIntersectsScreenRect(box, cam, domRect, minX, maxX, minY, maxY)) {
          results.push({ kind: 'prop', propId });
        }
      }
    }
    return results;
  }

  private handlePointerMove = (e: PointerEvent) => {
    if (this.disposed || this.viewMode !== 'editor') return;

    if (this.marqueeDrag) {
      const drag = this.marqueeDrag;
      drag.currentClientX = e.clientX;
      drag.currentClientY = e.clientY;
      const dx = drag.currentClientX - drag.startClientX;
      const dy = drag.currentClientY - drag.startClientY;
      if (!drag.active && Math.hypot(dx, dy) > 4) {
        drag.active = true;
        this.suppressNextDblClickUntilMs = performance.now() + 350;
        this.focusAnim = null;
        this.orbitControls.enabled = false;
      }
      if (drag.active) {
        this.updateMarqueeOverlay(drag);
      }
      return;
    }

    // Live camera-aligned or axis-ring limb rotation drag in Articulated Pose Mode
    if (this.directLimbDrag) {
      const drag = this.directLimbDrag;
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.active && Math.hypot(dx, dy) > 3) {
        drag.active = true;
        this.suppressNextDblClickUntilMs = performance.now() + 350;
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

    // Live interactive 3D Scale Node drag (smooth uniform scaling with live size readout)
    if (this.directScaleNodeDrag) {
      const drag = this.directScaleNodeDrag;
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.active && Math.hypot(dx, dy) > 2) {
        drag.active = true;
        this.suppressNextDblClickUntilMs = performance.now() + 350;
        this.focusAnim = null;
        this.orbitControls.enabled = false;
        this.transformControls.enabled = false;
      }
      if (drag.active) {
        const deltaPx = dx - dy;
        const mult = THREE.MathUtils.clamp(Math.exp(deltaPx * 0.0055), 0.05, 25);
        drag.obj.scale.set(
          THREE.MathUtils.clamp(drag.startScale.x * mult, 0.02, 40),
          THREE.MathUtils.clamp(drag.startScale.y * mult, 0.02, 40),
          THREE.MathUtils.clamp(drag.startScale.z * mult, 0.02, 40),
        );
        drag.obj.position.copy(drag.startObjPos);
        if (drag.groupMemberStarts) {
          for (const m of drag.groupMemberStarts) {
            m.obj.scale.set(
              THREE.MathUtils.clamp(m.startScale.x * mult, 0.02, 40),
              THREE.MathUtils.clamp(m.startScale.y * mult, 0.02, 40),
              THREE.MathUtils.clamp(m.startScale.z * mult, 0.02, 40),
            );
            m.obj.position.copy(m.startPos);
          }
        }
        if (
          this.floorLockEnabled &&
          (drag.target.kind === 'character' || drag.target.kind === 'prop' || drag.target.kind === 'group')
        ) {
          this.clampObjectAboveFloor(
            drag.obj,
            drag.groupMemberStarts?.map((m) => m.obj),
          );
        }
        this.updateSelectionBoxesOnly();
        this.updateScaleHandleVisual();
        this.emitLiveSize(true);
        if (this.lastRigInstanceId) {
          this.rigVisualizer.updateLivePositions(
            this.adapters.get(this.lastRigInstanceId),
            this.getActiveEditorCamera(),
          );
        }
        this.requestRender();
      }
      return;
    }

    // Live click-and-drag / trackpad double-click-and-drag object translation anywhere in viewport
    if (this.directObjectDrag) {
      const drag = this.directObjectDrag;
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (!drag.active && Math.hypot(dx, dy) > 4) {
        drag.active = true;
        this.suppressNextDblClickUntilMs = performance.now() + 350;
        this.focusAnim = null;
        this.orbitControls.enabled = false;
        this.transformControls.enabled = false;
      }
      if (drag.active) {
        this.updateRayFromEvent(e.clientX, e.clientY);
        const intersectPt = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(drag.dragPlane, intersectPt)) {
          // Guard against rays intersecting behind camera or shooting to infinity at grazing horizon angles
          const alongRay = intersectPt.clone().sub(this.raycaster.ray.origin).dot(this.raycaster.ray.direction);
          if (alongRay <= 0.05) return;

          const delta = intersectPt.sub(drag.startHitPoint);
          if (delta.length() > 45) {
            delta.setLength(45);
          }

          if (this.axisConstraint === 'x') {
            delta.y = 0;
            delta.z = 0;
          } else if (this.axisConstraint === 'y' || (!drag.isHorizontalPlane && e.shiftKey)) {
            delta.x = 0;
            delta.z = 0;
          } else if (this.axisConstraint === 'z') {
            delta.x = 0;
            delta.y = 0;
          } else if (drag.isHorizontalPlane) {
            // Keep clean horizontal floor-parallel movement (no accidental camera-zoom or underground dive)
            delta.y = 0;
          }

          const nextPos = drag.startObjPos.clone().add(delta);
          if (this.snapTranslateStep && this.snapTranslateStep > 0) {
            const step = this.snapTranslateStep;
            nextPos.x = Math.round(nextPos.x / step) * step;
            nextPos.y = Math.round(nextPos.y / step) * step;
            nextPos.z = Math.round(nextPos.z / step) * step;
          }
          const appliedDelta = nextPos.clone().sub(drag.startObjPos);
          drag.obj.position.copy(nextPos);
          if (drag.groupMemberStarts) {
            for (const m of drag.groupMemberStarts) {
              m.obj.position.copy(m.startPos).add(appliedDelta);
            }
          }

          // Respect Floor Lock so objects cannot vanish beneath floor unless unlocked
          if (
            this.floorLockEnabled &&
            (drag.target.kind === 'character' || drag.target.kind === 'prop' || drag.target.kind === 'group')
          ) {
            this.clampObjectAboveFloor(
              drag.obj,
              drag.groupMemberStarts?.map((m) => m.obj),
            );
          }

          if (drag.target.kind === 'light') {
            const dynLight = this.dynamicLights.get(drag.target.lightId);
            if (dynLight) dynLight.position.copy(drag.obj.position);
          } else if (drag.target.kind === 'character') {
            this.rigVisualizer.updateLivePositions(
              this.adapters.get(drag.target.instanceId),
              this.getActiveEditorCamera(),
            );
          }
          this.updateSelectionBoxesOnly();
          this.updateScaleHandleVisual();
          this.requestRender();
        }
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

    // Clear previous hover emissive boost cleanly
    this.clearHoverEmissivesOnly();

    if (hit.hitMesh) {
      this.applyMeshHoverEmissive(hit.hitMesh);
      const hoverBox = this.computeVisibleBox3(hit.hitMesh);
      if (!hoverBox.isEmpty()) {
        this.hoverBoxHelper.setFromObject(hit.hitMesh);
        this.hoverBoxHelper.visible = true;
      } else {
        this.hoverBoxHelper.visible = false;
      }
    } else {
      this.hoverBoxHelper.visible = false;
    }

    const nextHoveredInstanceId =
      hit.target.kind === 'body-part' || hit.target.kind === 'character' || hit.target.kind === 'ik-handle'
        ? hit.target.instanceId
        : null;
    const nextNodeKey =
      hit.target.kind === 'body-part' ? `${hit.target.instanceId}:${hit.target.nodeId}` : null;
    const nextRingAxis = hit.ringAxis ?? null;
    if (
      nextHoveredInstanceId !== this.hoveredInstanceId ||
      nextNodeKey !== this.hoveredNodeKey ||
      nextRingAxis !== this.hoveredRingAxis
    ) {
      this.hoveredInstanceId = nextHoveredInstanceId;
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
    if (this.directLimbDrag || this.directObjectDrag || this.directScaleNodeDrag || this.marqueeDrag) {
      this.directLimbDrag = null;
      this.directObjectDrag = null;
      this.directScaleNodeDrag = null;
      this.marqueeDrag = null;
      this.hideMarqueeOverlay();
      this.activeRingAxis = null;
      this.orbitControls.enabled = this.viewMode === 'editor';
      this.transformControls.enabled = true;
      this.emitLiveSize(false);
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

  private resolveDraggableObject(target: SelectionTarget): {
    target: SelectionTarget;
    obj: THREE.Object3D;
    groupMemberStarts?: { obj: THREE.Object3D; startPos: THREE.Vector3 }[];
  } | null {
    if (target.kind === 'character') {
      const a = this.adapters.get(target.instanceId);
      return a ? { target, obj: a.rootGroup } : null;
    }
    if (target.kind === 'body-part' && target.nodeId === 'node_0') {
      const a = this.adapters.get(target.instanceId);
      return a ? { target: { kind: 'character', instanceId: target.instanceId }, obj: a.rootGroup } : null;
    }
    if (target.kind === 'prop') {
      const p = this.propObjects.get(target.propId);
      return p ? { target, obj: p } : null;
    }
    if (target.kind === 'group') {
      const proxy = this.groupProxies.get(target.groupId);
      if (!proxy) return null;
      const meta = this.groupMeta.get(target.groupId);
      const groupMemberStarts: { obj: THREE.Object3D; startPos: THREE.Vector3 }[] = [];
      if (meta) {
        for (const mId of meta.memberIds) {
          const ch = this.adapters.get(mId);
          if (ch) groupMemberStarts.push({ obj: ch.rootGroup, startPos: ch.rootGroup.position.clone() });
          const pr = this.propObjects.get(mId);
          if (pr) groupMemberStarts.push({ obj: pr, startPos: pr.position.clone() });
        }
      }
      return { target, obj: proxy, groupMemberStarts };
    }
    if (target.kind === 'light') {
      const m = this.lightMarkers.get(target.lightId);
      return m ? { target, obj: m } : null;
    }
    if (target.kind === 'camera') {
      return { target, obj: this.sceneCameraMarker };
    }
    if (target.kind === 'waypoint') {
      const w =
        this.waypointNodes.get(`${target.instanceId}:${target.pointId}:point`) ??
        [...this.waypointNodes.values()].find((n) => n.ownerId === target.instanceId && n.pointId === target.pointId);
      return w ? { target, obj: w.mesh } : null;
    }
    return null;
  }

  private commitObjectDragTransform(target: SelectionTarget, obj: THREE.Object3D): void {
    if (target.kind === 'character') {
      this.callbacks.onCharacterTransformCommit(target.instanceId, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    } else if (target.kind === 'prop') {
      this.callbacks.onPropTransformCommit(target.propId, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    } else if (target.kind === 'group') {
      this.callbacks.onGroupTransformCommit?.(target.groupId, {
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      });
    } else if (target.kind === 'light') {
      this.callbacks.onLightPositionCommit(target.lightId, {
        x: obj.position.x,
        y: obj.position.y,
        z: obj.position.z,
      });
    } else if (target.kind === 'camera') {
      this.sceneCamera.position.copy(obj.position);
      this.callbacks.onCameraTransformCommit({
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        target: { x: 0, y: 1.5, z: 0 },
        fov: this.sceneCamera.fov,
      });
    } else if (target.kind === 'waypoint') {
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

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let delta = e.deltaY;
    if (e.deltaMode === 1) {
      // DOM_DELTA_LINE
      delta *= 16;
    } else if (e.deltaMode === 2) {
      // DOM_DELTA_PAGE
      delta *= 100;
    }
    if (e.ctrlKey) {
      // Trackpad pinch-to-zoom dispatches wheel with ctrlKey=true and smaller deltaY
      delta *= 4.5;
    }
    if (Math.abs(delta) < 1e-4) return;

    const clampedDelta = THREE.MathUtils.clamp(delta, -320, 320);
    const factor = Math.exp(clampedDelta * 0.0018);
    this.zoomBy(factor, { x: e.clientX, y: e.clientY });
  };

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
    const activeTcAxis = (this.transformControls as unknown as { axis?: string | null }).axis;
    this.gizmoPointerDown = Boolean(activeTcAxis);

    if (this.gizmoMode === 'orbit') {
      return;
    }

    if (
      e.button === 0 &&
      this.viewMode === 'editor' &&
      !activeTcAxis
    ) {
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;

      if (this.gizmoMode === 'box-select') {
        this.marqueeDrag = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          additive,
          active: false,
        };
        this.orbitControls.enabled = false;
        try {
          this.renderer.domElement.setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture failure in synthetic environments
        }
        return;
      }

      const hit = this.inspectRayTarget(e.clientX, e.clientY, {
        preferBodyPart: e.altKey || this.selectionFilter !== 'character',
        ignoreGroups: e.altKey,
      });

      // Interactive 3D Scale Size Node grab
      if (hit?.isScaleHandle) {
        const resolved = this.getScalableSelectionObject();
        if (resolved && !resolved.locked) {
          this.directScaleNodeDrag = {
            target: resolved.target,
            obj: resolved.obj,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startScale: resolved.obj.scale.clone(),
            startObjPos: resolved.obj.position.clone(),
            groupMemberStarts: resolved.groupMembers?.map((m) => ({
              obj: m,
              startScale: m.scale.clone(),
              startPos: m.position.clone(),
            })),
            active: false,
          };
          this.orbitControls.enabled = false;
          this.transformControls.enabled = false;
          try {
            this.renderer.domElement.setPointerCapture(e.pointerId);
          } catch {
            // Ignore pointer capture failure in synthetic environments
          }
          return;
        }
      }

      const canDragRing = Boolean(hit?.ringAxis);
      const canDragLimb =
        hit &&
        hit.target.kind === 'body-part' &&
        hit.target.nodeId !== 'node_0' &&
        (this.gizmoMode === 'select' || this.gizmoMode === 'rotate');

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
          return;
        }
      }

      // Do NOT hijack body-part selection in translate/scale mode with whole-character root dragging!
      if (hit && hit.target.kind === 'body-part') {
        return;
      }

      // Direct click-and-drag on any standalone stage object (character, detached part, prop, group, light, camera)
      const objHit = this.inspectRayTarget(e.clientX, e.clientY, {
        preferBodyPart: false,
        ignoreGroups: e.altKey,
      });
      if (objHit && !objHit.locked && !objHit.isScaleHandle) {
        const resolved = this.resolveDraggableObject(objHit.target);
        if (resolved) {
          const cam = this.getActiveEditorCamera();
          cam.updateMatrixWorld();
          const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
          const wantsVertical =
            this.axisConstraint === 'y' || e.shiftKey || Math.abs(camForward.y) < 0.14;
          let dragPlane: THREE.Plane;
          let isHorizontalPlane = false;
          if (!wantsVertical) {
            // Stable horizontal plane parallel to the floor so objects glide cleanly without auto-zooming or disappearing
            dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
              new THREE.Vector3(0, 1, 0),
              objHit.worldPoint,
            );
            isHorizontalPlane = true;
          } else {
            // Vertical plane facing the camera horizontally (never tilted into the floor)
            const horizNormal = new THREE.Vector3(camForward.x, 0, camForward.z);
            if (horizNormal.lengthSq() < 1e-4) horizNormal.set(0, 0, 1);
            horizNormal.normalize();
            dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(horizNormal, objHit.worldPoint);
          }
          this.directObjectDrag = {
            target: resolved.target,
            obj: resolved.obj,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startObjPos: resolved.obj.position.clone(),
            startHitPoint: objHit.worldPoint.clone(),
            dragPlane,
            isHorizontalPlane,
            groupMemberStarts: resolved.groupMemberStarts,
            active: false,
          };
          this.orbitControls.enabled = false;
          this.transformControls.enabled = false;
          try {
            this.renderer.domElement.setPointerCapture(e.pointerId);
          } catch {
            // Ignore pointer capture failure in synthetic environments
          }
          return;
        }
      }

      // Dragging starting outside any object (empty viewport) draws the Marquee Highlight Box!
      if (!hit && !objHit) {
        this.marqueeDrag = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          currentClientX: e.clientX,
          currentClientY: e.clientY,
          additive,
          active: false,
        };
        this.orbitControls.enabled = false;
        try {
          this.renderer.domElement.setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture failure in synthetic environments
        }
      }
    }
  };

  private handlePointerUp = (e: PointerEvent) => {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;

    if (this.marqueeDrag) {
      const drag = this.marqueeDrag;
      this.marqueeDrag = null;
      this.hideMarqueeOverlay();
      this.orbitControls.enabled = this.viewMode === 'editor';
      try {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) {
          this.renderer.domElement.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      if (drag.active) {
        const targets = this.collectMarqueeTargets(drag);
        if (targets.length === 0 && !drag.additive) {
          if (this.poseModeInstanceId) {
            this.poseModeInstanceId = null;
            this.callbacks.onPoseModeChange?.(null);
          }
          this.callbacks.onSelectTarget({ kind: 'none' }, false);
        } else {
          this.callbacks.onMarqueeSelect?.(targets, drag.additive);
        }
        this.requestRender();
        return;
      }
    }

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
        const deltaPos =
          adapter && 'getNodeDeltaPosition' in adapter && typeof adapter.getNodeDeltaPosition === 'function'
            ? adapter.getNodeDeltaPosition(drag.nodeId, drag.nodeObj.position)
            : { x: 0, y: 0, z: 0 };
        const deltaScale =
          adapter && 'getNodeDeltaScale' in adapter && typeof adapter.getNodeDeltaScale === 'function'
            ? adapter.getNodeDeltaScale(drag.nodeId, drag.nodeObj.scale)
            : { x: 1, y: 1, z: 1 };
        this.callbacks.onSelectTarget(
          { kind: 'body-part', instanceId: drag.instanceId, nodeId: drag.nodeId, nodeName: drag.nodeName },
          additive,
        );
        this.callbacks.onNodeTransformCommit(drag.instanceId, drag.nodeId, drag.nodeName, deltaRot, deltaPos, deltaScale);
        this.rebuildRigVisuals();
        this.requestRender();
        return;
      }
      if (drag.axis) {
        this.rebuildRigVisuals();
      }
    }

    if (this.directScaleNodeDrag) {
      const drag = this.directScaleNodeDrag;
      this.directScaleNodeDrag = null;
      this.orbitControls.enabled = this.viewMode === 'editor';
      this.transformControls.enabled = true;
      try {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) {
          this.renderer.domElement.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      if (drag.active) {
        if (drag.target.kind === 'body-part') {
          const { instanceId, nodeId, nodeName } = drag.target;
          const adapter = this.adapters.get(instanceId);
          const deltaRot =
            adapter && 'getNodeDeltaRotation' in adapter && typeof adapter.getNodeDeltaRotation === 'function'
              ? adapter.getNodeDeltaRotation(nodeId, drag.obj.rotation)
              : { x: drag.obj.rotation.x, y: drag.obj.rotation.y, z: drag.obj.rotation.z };
          const deltaPos =
            adapter && 'getNodeDeltaPosition' in adapter && typeof adapter.getNodeDeltaPosition === 'function'
              ? adapter.getNodeDeltaPosition(nodeId, drag.obj.position)
              : { x: 0, y: 0, z: 0 };
          const deltaScale =
            adapter && 'getNodeDeltaScale' in adapter && typeof adapter.getNodeDeltaScale === 'function'
              ? adapter.getNodeDeltaScale(nodeId, drag.obj.scale)
              : { x: drag.obj.scale.x, y: drag.obj.scale.y, z: drag.obj.scale.z };
          this.callbacks.onNodeTransformCommit(instanceId, nodeId, nodeName, deltaRot, deltaPos, deltaScale);
        } else {
          this.commitObjectDragTransform(drag.target, drag.obj);
        }
        this.updateSelectionBoxesOnly();
        this.updateScaleHandleVisual();
      }
      this.emitLiveSize(false);
      this.requestRender();
      return;
    }

    if (this.directObjectDrag) {
      const drag = this.directObjectDrag;
      this.directObjectDrag = null;
      this.orbitControls.enabled = this.viewMode === 'editor';
      this.transformControls.enabled = true;
      try {
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) {
          this.renderer.domElement.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }
      if (drag.active) {
        if (
          this.poseModeInstanceId &&
          !(drag.target.kind === 'character' && drag.target.instanceId === this.poseModeInstanceId)
        ) {
          this.poseModeInstanceId = null;
          this.callbacks.onPoseModeChange?.(null);
        }
        this.callbacks.onSelectTarget(drag.target, additive);
        this.commitObjectDragTransform(drag.target, drag.obj);
        this.updateSelectionBoxesOnly();
        this.updateScaleHandleVisual();
        this.emitLiveSize(false);
        this.requestRender();
        return;
      }
    }

    if (this.gizmoPointerDown) {
      this.gizmoPointerDown = false;
      return;
    }
    if (this.transformControls.dragging || this.viewMode !== 'editor' || e.button !== 0) return;

    // Allow short clicks (<= 5px) to select or deselect in ALL modes (including orbit mode!)
    const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (dist > 5) return;

    const hit = this.inspectRayTarget(e.clientX, e.clientY, {
      preferBodyPart: e.altKey || this.selectionFilter !== 'character',
      ignoreGroups: e.altKey,
    });

    if (hit) {
      // If clicking outside pose character, exit Pose Mode cleanly and select the clicked object
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
      this.callbacks.onSelectTarget(hit.target, additive);
      return;
    }

    // Clicked outside on empty viewport space: ALWAYS clear ALL selection completely!
    if (this.poseModeInstanceId) {
      this.poseModeInstanceId = null;
      this.callbacks.onPoseModeChange?.(null);
    }
    this.clearHoverHighlight();
    this.callbacks.onSelectTarget({ kind: 'none' }, false);
  };

  private handleDoubleClick = (e: MouseEvent) => {
    if (this.viewMode !== 'editor' || this.gizmoMode === 'orbit') return;
    if (performance.now() < this.suppressNextDblClickUntilMs) return;
    const hit = this.inspectRayTarget(e.clientX, e.clientY, {
      preferBodyPart: true,
      ignoreFilter: true,
      ignoreGroups: e.altKey,
    });
    if (!hit) return;

    // Blender-style Object <-> Part toggle on double-click:
    // If a body part of this character is already selected, double-clicking toggles to the whole Character root
    // so you can move/scale the full character cleanly; double-clicking again returns to Pose/Part mode.
    if (hit.target.kind === 'body-part') {
      const charId = hit.target.instanceId;
      if (
        this.currentSelection.kind === 'body-part' &&
        this.currentSelection.instanceId === charId &&
        !this.poseModeInstanceId
      ) {
        this.callbacks.onSelectTarget({ kind: 'character', instanceId: charId }, false);
        this.rebuildRigVisuals();
        return;
      }

      let target = hit.target;
      if (target.nodeId === 'node_0') {
        const adapter = this.adapters.get(charId);
        const nodes =
          adapter && 'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function'
            ? adapter.getRigNodes()
            : [];
        const preferred =
          nodes.find((n) => n.slot === 'head') ??
          nodes.find((n) => n.slot === 'leftUpperArm') ??
          nodes.find((n) => n.nodeId !== 'node_0' && !n.isAuxiliary) ??
          nodes.find((n) => n.nodeId !== 'node_0') ??
          nodes[0];
        if (preferred) {
          target = { kind: 'body-part', instanceId: charId, nodeId: preferred.nodeId, nodeName: preferred.name };
        }
      }
      this.poseModeInstanceId = charId;
      this.callbacks.onPoseModeChange?.(charId, target.nodeId);
      this.callbacks.onSelectTarget(target, false);
      this.rebuildRigVisuals();
      return;
    }

    if (hit.target.kind === 'character' || hit.target.kind === 'group') {
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
          nodes.find((n) => n.nodeId !== 'node_0' && !n.isAuxiliary) ??
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
    if (e.ctrlKey && e.button === 0) {
      e.preventDefault();
      return;
    }
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
      this.orbitControls.update();
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
        this.syncEditorOrthoCamera(true);
        this.renderDirty = Boolean(this.focusAnim);
      }
      const controlsChanged = this.orbitControls.update();
      if (controlsChanged) {
        this.renderDirty = true;
      }
      if (this.editorProjection === 'perspective') {
        this.syncEditorOrthoCamera(true);
      }
      this.rigVisualizer.updateScales(this.getActiveEditorCamera());
      this.updateScaleHandleVisual();
      this.emitCameraOrientation();
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
    if (this.viewMode === 'editor' && this.currentSelection.kind !== 'none' && (this.isPlaying || this.transformControls.dragging)) {
      this.updateSelectionBoxesOnly();
      this.updateScaleHandleVisual();
    }
    const activeSceneCam =
      this.activeCameraProjection === 'orthographic' ? this.orthoSceneCamera : this.sceneCamera;
    const cam = this.viewMode === 'scene' ? activeSceneCam : this.getActiveEditorCamera();
    this.renderer.render(this.scene, cam);
  }

  captureThumbnailDataUrl(): string | undefined {
    try {
      const wasEditor = this.viewMode === 'editor';
      const wasScaleHandleVisible = this.scaleHandleGroup.visible;
      if (wasEditor) {
        this.clearHoverEmissivesOnly();
        this.clearSelectionHighlight();
        this.selectionBoxesGroup.visible = false;
        this.scaleHandleGroup.visible = false;
      }
      this.renderFrame();
      const url = this.renderer.domElement.toDataURL('image/jpeg', 0.65);
      if (wasEditor) {
        this.selectionBoxesGroup.visible = true;
        this.scaleHandleGroup.visible = wasScaleHandleVisible;
        this.refreshSelectionVisuals();
      }
      return url;
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
    this.syncEditorOrthoCamera(this.editorProjection === 'perspective');
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
    this.clearSelectionHighlight();
    this.clearSelectionBoxes();
    this.detachedTemplates.clear();
    const dom = this.renderer.domElement;
    dom.removeEventListener('wheel', this.handleWheel, { capture: true });
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
    for (const grp of [this.wallsGroup, this.cloudsGroup, this.scaleHandleGroup]) {
      grp.traverse((o) => {
        const m = o as THREE.Mesh | THREE.Line;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mt) => mt.dispose());
        }
      });
    }
    this.renderer.dispose();
    this.marqueeOverlay.remove();
    dom.remove();
  }
}
