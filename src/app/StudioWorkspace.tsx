import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActionClip,
  AssetRecord,
  AudioClipData,
  AxisConstraint,
  CameraPose,
  CharacterInstanceData,
  EasingType,
  EditorCameraPreset,
  EnvironmentPresetId,
  FacialState,
  GizmoMode,
  GizmoSpace,
  HoverTargetInfo,
  MotionPathData,
  MotionPathPoint,
  PanelCollapseState,
  ProjectData,
  PropGeometryKind,
  RigNodeInfo,
  SaveStatus,
  SceneCameraItem,
  SceneData,
  SceneLightData,
  SceneLightKind,
  ScenePropData,
  SelectionFilter,
  SelectionTarget,
  SnapSettings,
  StudioMode,
  TabPrediction,
  Transform3D,
  Vec3,
  Vec3Keyframe,
  WorkspaceLayoutId,
} from '../core/types';
import {
  createDefaultMotionPath,
  createDefaultTransform,
} from '../core/types';
import { migrateProjectData } from '../core/migrations';
import { CommandManager } from '../core/CommandManager';
import {
  createLogicalGroup,
  findMemberGroup,
  isEffectiveVisible,
  ungroupLogicalGroup,
} from '../core/GroupUtils';
import { createId } from '../utils/ids';
import { evaluateSceneAtTime } from '../animation/SceneEvaluator';
import {
  findAdjacentKeyframeTime,
  reverseKeyframes,
  shiftKeyframes,
  stretchKeyframes,
} from '../animation/Interpolation';
import { updatePointWithHandleSymmetry } from '../animation/MotionPath';
import {
  type AnimationSuggestion,
  generateTabPredictions,
  MOTION_PRESETS,
} from '../animation/MotionPresets';
import { autoMapHumanoidSlots, buildRigCompatibilityReport } from '../animation/RigMapper';
import { analyzeHtmlCharacter } from '../characters/HtmlCharacterAnalyzer';
import type { CharacterCapabilities } from '../characters/CharacterAdapter';
import { createCharacterAdapter, type AnyCharacterAdapter } from '../characters/CharacterRegistry';
import { HtmlThreeAdapter } from '../characters/HtmlThreeAdapter';
import { GltfCharacterAdapter } from '../characters/GltfCharacterAdapter';
import { HtmlIframeAdapter } from '../characters/HtmlIframeAdapter';
import { AudioEngine } from '../audio/AudioEngine';
import { type CameraViewMode, StudioEngine } from '../engine/StudioEngine';
import {
  buildSceneFromTemplate,
  createPropData,
  ENVIRONMENT_PRESETS,
  type SceneTemplateId,
} from '../engine/PropsFactory';
import { exportScenesToVideo } from '../engine/ExportManager';
import {
  deleteAsset as dbDeleteAsset,
  deleteProject as dbDeleteProject,
  listAssets as dbListAssets,
  listProjects as dbListProjects,
  loadAssetBinary as dbLoadAssetBinary,
  saveAsset as dbSaveAsset,
  saveProject as dbSaveProject,
} from '../storage/StudioRepository';
import { TopToolbar } from '../ui/panels/TopToolbar';
import { LeftAssetPanel, type LeftPanelTab } from '../ui/panels/LeftAssetPanel';
import { CenterViewport } from '../ui/panels/CenterViewport';
import { type CharInspectorTab, RightInspector } from '../ui/panels/RightInspector';
import { BottomTimeline, type KeyframeRef } from '../ui/panels/BottomTimeline';
import {
  DialogueDialog,
  ExportVideoDialog,
  ImportAssetDialog,
  ProjectManagerDialog,
  UserGuideDialog,
} from '../ui/dialogs/StudioDialogs';
import { CommandPalette, type PaletteAction } from '../ui/dialogs/CommandPalette';
import { ConfirmDialog, type ContextMenuItem } from '../ui/components/Primitives';

const UI_PREFS_KEY = 'stagecraft_ui_prefs_v1';

interface UiPrefs {
  workspaceLayout: WorkspaceLayoutId;
  leftCollapse: PanelCollapseState;
  rightCollapse: PanelCollapseState;
  timelineCollapse: PanelCollapseState;
}

function loadUiPrefs(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiPrefs>;
      return {
        workspaceLayout: parsed.workspaceLayout ?? 'general',
        leftCollapse: parsed.leftCollapse ?? 'expanded',
        rightCollapse: parsed.rightCollapse ?? 'expanded',
        timelineCollapse: parsed.timelineCollapse ?? 'expanded',
      };
    }
  } catch {
    // Ignore storage access failure
  }
  return {
    workspaceLayout: 'general',
    leftCollapse: 'expanded',
    rightCollapse: 'expanded',
    timelineCollapse: 'expanded',
  };
}

function createBlankProject(name = 'My Cartoon'): ProjectData {
  const firstScene = buildSceneFromTemplate('blank-stage', 'Scene 01');
  return {
    id: createId('proj'),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fps: 30,
    activeSceneId: firstScene.id,
    scenes: [firstScene],
    assetIds: [],
  };
}

function cloneScene(s: SceneData): SceneData {
  return JSON.parse(JSON.stringify(s)) as SceneData;
}

function cloneTransform(t: Transform3D): Transform3D {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
    scale: { ...t.scale },
  };
}

function upsertVec3Key(
  list: Vec3Keyframe[],
  time: number,
  value: Vec3,
  easing: EasingType = 'smooth',
): Vec3Keyframe[] {
  const snapT = Number(time.toFixed(2));
  const filtered = list.filter((k) => Math.abs(k.time - snapT) > 0.04);
  return [...filtered, { id: createId('kf'), time: snapT, value: { ...value }, easing }].sort(
    (a, b) => a.time - b.time,
  );
}

function applyTabPredictionToScene(
  scene: SceneData,
  pred: TabPrediction,
  time: number,
  rigNodesByInstance: Record<string, RigNodeInfo[]>,
): SceneData {
  if (!pred.compatible || pred.applyKind === 'none' || !pred.payload) return scene;
  const charId = pred.payload.targetCharacterId;
  if (!charId) return scene;
  const char = scene.characters.find((c) => c.id === charId);
  if (!char) return scene;

  if (pred.applyKind === 'bone-pose' && pred.payload.nodeRotations) {
    const entries = Object.entries(pred.payload.nodeRotations);
    const nodes = rigNodesByInstance[charId] ?? [];
    const tracks = [...(char.nodeTracks ?? [])];
    for (const [nodeId, rot] of entries) {
      const nodeName = nodes.find((n) => n.nodeId === nodeId)?.name ?? nodeId;
      const idx = tracks.findIndex((nt) => nt.nodeId === nodeId);
      const existing =
        idx >= 0 ? tracks[idx] : { nodeId, nodeName, rotationKeyframes: [], positionKeyframes: [] };
      const updated = {
        ...existing,
        rotationKeyframes: upsertVec3Key(
          existing.rotationKeyframes,
          time,
          rot,
          pred.payload.easing ?? 'smooth',
        ),
      };
      if (idx >= 0) tracks[idx] = updated;
      else tracks.push(updated);
    }
    return {
      ...scene,
      characters: scene.characters.map((c) => (c.id === charId ? { ...c, nodeTracks: tracks } : c)),
    };
  }

  if (pred.applyKind === 'motion-preset' && pred.payload.presetId) {
    const preset = MOTION_PRESETS.find((m) => m.id === pred.payload?.presetId);
    const clip: ActionClip = {
      id: createId('act'),
      actionId: pred.payload.presetId,
      label: preset?.label ?? pred.payload.presetId,
      kind: 'preset',
      startTime: Number(time.toFixed(2)),
      duration: pred.payload.duration ?? 1.6,
      speed: 1,
      blendIn: 0.2,
      blendOut: 0.2,
      weight: 1,
    };
    return {
      ...scene,
      characters: scene.characters.map((c) =>
        c.id === charId ? { ...c, actionClips: [...c.actionClips, clip] } : c,
      ),
    };
  }

  if (pred.applyKind === 'add-keyframe' || pred.applyKind === 'follow-through') {
    const evalT = evaluateSceneAtTime(scene, time).characters.get(charId)?.transform ?? char.transform;
    const offset = pred.payload.rootOffset ?? { x: 0, y: 0, z: 0 };
    const targetTime =
      pred.applyKind === 'follow-through'
        ? Math.min(scene.duration, Number((time + (pred.payload.duration ?? 0.5)).toFixed(2)))
        : time;
    const nextPos = {
      x: evalT.position.x + offset.x,
      y: evalT.position.y + offset.y,
      z: evalT.position.z + offset.z,
    };
    const easing = pred.payload.easing ?? 'smooth';
    return {
      ...scene,
      characters: scene.characters.map((c) =>
        c.id === charId
          ? {
              ...c,
              positionKeyframes: upsertVec3Key(c.positionKeyframes, targetTime, nextPos, easing),
              rotationKeyframes: upsertVec3Key(c.rotationKeyframes, targetTime, evalT.rotation, easing),
            }
          : c,
      ),
    };
  }

  return scene;
}

export function StudioWorkspace() {
  const initialPrefs = useMemo(() => loadUiPrefs(), []);

  const [projects, setProjects] = useState<ProjectData[]>(() => [createBlankProject()]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [capabilitiesMap, setCapabilitiesMap] = useState<Record<string, CharacterCapabilities>>({});
  const [rigNodesByInstance, setRigNodesByInstance] = useState<Record<string, RigNodeInfo[]>>({});

  const [studioMode, setStudioMode] = useState<StudioMode>('advanced');
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayoutId>(initialPrefs.workspaceLayout);
  const [leftCollapse, setLeftCollapse] = useState<PanelCollapseState>(initialPrefs.leftCollapse);
  const [rightCollapse, setRightCollapse] = useState<PanelCollapseState>(initialPrefs.rightCollapse);
  const [timelineCollapse, setTimelineCollapse] = useState<PanelCollapseState>(initialPrefs.timelineCollapse);
  const [leftTab, setLeftTab] = useState<LeftPanelTab>('assets');
  const [inspectorCharTab, setInspectorCharTab] = useState<CharInspectorTab>('transform');

  const [selection, setSelection] = useState<SelectionTarget>({ kind: 'none' });
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  const [isolatedIds, setIsolatedIds] = useState<string[]>([]);
  const [poseModeInstanceId, setPoseModeInstanceId] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverTargetInfo | null>(null);

  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [loopPlayback, setLoopPlayback] = useState<boolean>(false);
  const [autoKey, setAutoKey] = useState<boolean>(false);
  const [previewFullStory, setPreviewFullStory] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<CameraViewMode>('editor');
  const [editorProjection, setEditorProjection] = useState<'perspective' | 'orthographic'>('perspective');
  const [editorCameraPreset, setEditorCameraPreset] = useState<EditorCameraPreset>('free');

  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [gizmoSpace, setGizmoSpace] = useState<GizmoSpace>('world');
  const [axisConstraint, setAxisConstraint] = useState<AxisConstraint>('all');
  const [snapSettings, setSnapSettings] = useState<SnapSettings>({
    enabled: false,
    translateStep: 0.5,
    rotateDegStep: 15,
    scaleStep: 0.1,
  });
  const [selectionFilter, setSelectionFilter] = useState<SelectionFilter>('all');
  const [showRigOverlay, setShowRigOverlay] = useState<boolean>(true);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [storageReady, setStorageReady] = useState<boolean>(false);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  // Tab prediction HUD state
  const [tabHudOpen, setTabHudOpen] = useState<boolean>(false);
  const [tabHudIndex, setTabHudIndex] = useState<number>(0);
  const [tabPreviewActive, setTabPreviewActive] = useState<boolean>(false);

  // Context menu state (right-click OR Shift+F10)
  const [viewportContextMenu, setViewportContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // Panel dimensions
  const [leftWidth, setLeftWidth] = useState(276);
  const [rightWidth, setRightWidth] = useState(324);
  const [timelineHeight, setTimelineHeight] = useState(264);

  // Dialogs
  const [importOpen, setImportOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [dialogueTargetCharId, setDialogueTargetCharId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatusText, setExportStatusText] = useState('');
  const exportAbortRef = useRef<AbortController | null>(null);

  // History revision ticker + coalescing ref
  const [, setHistoryVersion] = useState(0);
  const lastCoalesceRef = useRef<{
    key: string;
    atMs: number;
    afterBox: { scene: SceneData };
  } | null>(null);

  // Core imperative instances
  const viewportMountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<StudioEngine | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const commandManagerRef = useRef(new CommandManager(120));
  const glbBinaryCacheRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const loadingAdaptersRef = useRef<Set<string>>(new Set());

  if (!audioEngineRef.current) {
    audioEngineRef.current = new AudioEngine();
  }

  // Persist workspace layout & panel collapses
  useEffect(() => {
    try {
      window.localStorage.setItem(
        UI_PREFS_KEY,
        JSON.stringify({ workspaceLayout, leftCollapse, rightCollapse, timelineCollapse }),
      );
    } catch {
      // Ignore storage failures
    }
  }, [workspaceLayout, leftCollapse, rightCollapse, timelineCollapse]);

  // Derive active project & scene
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0],
    [projects, activeProjectId],
  );
  const activeScene = useMemo(
    () =>
      activeProject.scenes.find((s) => s.id === activeProject.activeSceneId) ??
      activeProject.scenes[0],
    [activeProject],
  );

  // Refs for fresh access inside Three.js callbacks & key handlers
  const projectRef = useRef(activeProject);
  const sceneRef = useRef(activeScene);
  const timeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  const loopPlaybackRef = useRef(loopPlayback);
  const autoKeyRef = useRef(autoKey);
  const fullStoryRef = useRef(previewFullStory);
  const selectionRef = useRef(selection);
  const showRigOverlayRef = useRef(showRigOverlay);
  const isolatedIdsRef = useRef(isolatedIds);
  const rigNodesRef = useRef(rigNodesByInstance);
  const lastUiTimeSyncRef = useRef(0);

  projectRef.current = activeProject;
  sceneRef.current = activeScene;
  timeRef.current = currentTime;
  isPlayingRef.current = isPlaying;
  playbackSpeedRef.current = playbackSpeed;
  loopPlaybackRef.current = loopPlayback;
  autoKeyRef.current = autoKey;
  fullStoryRef.current = previewFullStory;
  selectionRef.current = selection;
  showRigOverlayRef.current = showRigOverlay;
  isolatedIdsRef.current = isolatedIds;
  rigNodesRef.current = rigNodesByInstance;

  const updateActiveProject = useCallback(
    (updater: (proj: ProjectData) => ProjectData, markUnsaved = true) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectRef.current.id ? updater(p) : p)),
      );
      if (markUnsaved) setSaveStatus('unsaved');
    },
    [],
  );

  const replaceActiveScene = useCallback(
    (nextScene: SceneData, markUnsaved = true) => {
      sceneRef.current = nextScene;
      updateActiveProject(
        (proj) => ({
          ...proj,
          scenes: proj.scenes.map((s) => (s.id === proj.activeSceneId ? nextScene : s)),
        }),
        markUnsaved,
      );
    },
    [updateActiveProject],
  );

  const updateActiveScene = useCallback(
    (updater: (scene: SceneData) => SceneData, markUnsaved = true) => {
      const next = updater(sceneRef.current);
      replaceActiveScene(next, markUnsaved);
    },
    [replaceActiveScene],
  );

  /**
   * Universal Undo/Redo mutation helper with optional time-window coalescing for sliders & drags.
   */
  const commitSceneMutation = useCallback(
    (label: string, mutator: (scene: SceneData) => SceneData, coalesceKey?: string) => {
      const beforeSnap = cloneScene(sceneRef.current);
      const nextScene = mutator(cloneScene(beforeSnap));
      replaceActiveScene(nextScene, true);

      const nowMs = Date.now();
      const prevCoalesce = lastCoalesceRef.current;
      const canCoalesce =
        Boolean(coalesceKey) &&
        prevCoalesce !== null &&
        prevCoalesce.key === coalesceKey &&
        nowMs - prevCoalesce.atMs < 480 &&
        commandManagerRef.current.canUndo();

      if (canCoalesce && prevCoalesce) {
        prevCoalesce.afterBox.scene = cloneScene(nextScene);
        prevCoalesce.atMs = nowMs;
      } else {
        const afterBox = { scene: cloneScene(nextScene) };
        lastCoalesceRef.current = coalesceKey ? { key: coalesceKey, atMs: nowMs, afterBox } : null;
        commandManagerRef.current.pushExecuted({
          label,
          execute: () => replaceActiveScene(cloneScene(afterBox.scene), true),
          undo: () => replaceActiveScene(cloneScene(beforeSnap), true),
        });
      }
      setHistoryVersion((v) => v + 1);
    },
    [replaceActiveScene],
  );

  const handleUndo = useCallback(() => {
    lastCoalesceRef.current = null;
    const lbl = commandManagerRef.current.undo();
    if (lbl) {
      setHistoryVersion((v) => v + 1);
      setSaveStatus('unsaved');
    }
  }, []);

  const handleRedo = useCallback(() => {
    lastCoalesceRef.current = null;
    const lbl = commandManagerRef.current.redo();
    if (lbl) {
      setHistoryVersion((v) => v + 1);
      setSaveStatus('unsaved');
    }
  }, []);

  const refreshRigVisuals = useCallback((scene: SceneData, sel: SelectionTarget, showOverlay: boolean) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!showOverlay) {
      engine.updateRigAndIkVisuals(null, []);
      return;
    }
    const charId =
      sel.kind === 'character' || sel.kind === 'body-part' || sel.kind === 'ik-handle'
        ? sel.instanceId
        : null;
    const char = charId ? scene.characters.find((c) => c.id === charId) ?? null : null;
    engine.updateRigAndIkVisuals(char?.id ?? null, char?.ikTargets ?? []);
  }, []);

  // Deterministic evaluation applied to Three.js engine
  const applySceneEvaluation = useCallback(
    (scene: SceneData, time: number, dt = 0) => {
      const engine = engineRef.current;
      if (!engine) return;
      const evalState = evaluateSceneAtTime(scene, time);

      const isoList = isolatedIdsRef.current;
      const hasIso = isoList.length > 0;
      const isObjVisible = (id: string, ownVisible: boolean) => {
        if (!isEffectiveVisible(scene, id, ownVisible)) return false;
        if (!hasIso) return true;
        if (isoList.includes(id)) return true;
        const grp = findMemberGroup(scene, id);
        return Boolean(grp && isoList.includes(grp.id));
      };

      engine.syncSceneCamera(
        evalState.camera,
        evalState.activeCameraProjection,
        evalState.activeCameraOrthoSize,
      );
      engine.syncSceneLights(evalState.lights);
      engine.syncSceneGroups(scene.groups ?? [], evalState.groups);

      // Apply effective visibility onto evaluated prop states
      for (const prop of scene.props ?? []) {
        const ps = evalState.props.get(prop.id);
        if (ps) {
          ps.visible = isObjVisible(prop.id, ps.visible);
        }
      }
      void engine.syncSceneProps(scene.props ?? [], evalState.props, glbBinaryCacheRef.current);

      for (const char of scene.characters) {
        const adapter = engine.getAdapter(char.id);
        const charEval = evalState.characters.get(char.id);
        if (!adapter || !charEval) continue;

        adapter.setVisible(isObjVisible(char.id, char.visible));
        adapter.setTransform(charEval.transform);

        if ('setNodeVisibilityOverrides' in adapter && typeof adapter.setNodeVisibilityOverrides === 'function') {
          adapter.setNodeVisibilityOverrides(char.hiddenNodes ?? []);
        }

        // Compute audio-driven lip sync amplitude if talking
        let lipAmplitude = charEval.facial.mouthOpen;
        if (charEval.isTalking) {
          const activeDialogue = scene.audioClips.find(
            (c) =>
              !c.muted &&
              c.role === 'dialogue' &&
              c.characterInstanceId === char.id &&
              time >= c.startTime &&
              time <= c.startTime + c.duration,
          );
          if (activeDialogue && audioEngineRef.current) {
            lipAmplitude = Math.max(
              lipAmplitude,
              audioEngineRef.current.sampleClipAmplitudeAtTime(activeDialogue, time),
            );
          }
        }
        const facialWithAudio: FacialState = {
          ...charEval.facial,
          mouthOpen: lipAmplitude,
          jawOpen: Math.max(charEval.facial.jawOpen, lipAmplitude * 0.65),
        };

        if (adapter instanceof HtmlThreeAdapter) {
          adapter.setIncludeStageProps(char.includeStageProps);
          adapter.applyTimelineState(
            new Set(charEval.activeActions.map((a) => a.id)),
            charEval.activeActions,
            charEval.activeMood,
            charEval.isTalking,
          );
          adapter.applyNodeOverrides(charEval.nodeRotations, charEval.nodePositions);
          adapter.applyFacialState(facialWithAudio);
          adapter.update(dt);
        } else if (adapter instanceof GltfCharacterAdapter) {
          const firstClip = charEval.activeActions[0];
          adapter.evaluateClipAt(
            firstClip?.actionId ?? null,
            firstClip ? Math.max(0, time - firstClip.startTime) : 0,
            firstClip?.speed ?? 1,
          );
          adapter.applyNodeOverrides(charEval.nodeRotations, charEval.nodePositions);
          adapter.applyFacialState(facialWithAudio);
        } else if (adapter instanceof HtmlIframeAdapter) {
          adapter.setMood(charEval.activeMood);
          adapter.setTalking(charEval.isTalking);
        }
      }

      refreshRigVisuals(scene, selectionRef.current, showRigOverlayRef.current);
      engine.requestRender();
    },
    [refreshRigVisuals],
  );

  // Sync lock states into StudioEngine whenever scene lock lists or groups change
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const lockedObjIds = new Set<string>();
    const lockedNodes = new Map<string, ReadonlySet<string>>();

    for (const c of activeScene.characters) {
      if (c.lockedProperties?.transform) lockedObjIds.add(c.id);
      if ((c.lockedNodes ?? []).length > 0) lockedNodes.set(c.id, new Set(c.lockedNodes));
    }
    for (const p of activeScene.props ?? []) {
      if (p.locked) lockedObjIds.add(p.id);
    }
    for (const g of activeScene.groups ?? []) {
      if (g.locked) {
        lockedObjIds.add(g.id);
        for (const mId of g.memberIds) lockedObjIds.add(mId);
      }
    }
    engine.setLockStates(lockedObjIds, lockedNodes);
  }, [activeScene]);

  // Selection derived entities
  const selectedCharacter = useMemo(() => {
    const id =
      selection.kind === 'character' ||
      selection.kind === 'waypoint' ||
      selection.kind === 'body-part' ||
      selection.kind === 'ik-handle' ||
      selection.kind === 'action-clip'
        ? selection.instanceId
        : null;
    return id ? activeScene.characters.find((c) => c.id === id) ?? null : null;
  }, [activeScene.characters, selection]);

  const selectedCharacterAsset = useMemo(
    () => (selectedCharacter ? assets.find((a) => a.id === selectedCharacter.assetId) ?? null : null),
    [assets, selectedCharacter],
  );

  const selectedCharacterCaps = selectedCharacter
    ? capabilitiesMap[selectedCharacter.id] ?? null
    : null;

  const selectedRigNode = useMemo(() => {
    if (selection.kind !== 'body-part') return null;
    return (
      (rigNodesByInstance[selection.instanceId] ?? []).find(
        (n) => n.nodeId === selection.nodeId,
      ) ?? null
    );
  }, [rigNodesByInstance, selection]);

  const selectedCharRigReport = useMemo(() => {
    if (!selectedCharacter) return null;
    const nodes = rigNodesByInstance[selectedCharacter.id] ?? [];
    return buildRigCompatibilityReport(nodes, selectedCharacter.boneMap);
  }, [rigNodesByInstance, selectedCharacter]);

  // Tab Prediction candidates
  const tabPredictions = useMemo<TabPrediction[]>(() => {
    return generateTabPredictions({
      scene: activeScene,
      selectedChar: selectedCharacter,
      selectedNode: selectedRigNode,
      rigReport: selectedCharRigReport,
      currentTime,
    });
  }, [activeScene, selectedCharacter, selectedRigNode, selectedCharRigReport, currentTime]);

  const activeTabPrediction = tabPredictions[tabHudIndex] ?? tabPredictions[0] ?? null;

  // Compute scene to render (either real activeScene OR non-destructive Tab preview overlay)
  const displayedScene = useMemo(() => {
    if (tabHudOpen && tabPreviewActive && activeTabPrediction) {
      return applyTabPredictionToScene(activeScene, activeTabPrediction, currentTime, rigNodesByInstance);
    }
    return activeScene;
  }, [activeScene, tabHudOpen, tabPreviewActive, activeTabPrediction, currentTime, rigNodesByInstance]);

  // Load persisted projects & assets from IndexedDB on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rawProjects, savedAssets] = await Promise.all([
          dbListProjects(),
          dbListAssets(),
        ]);
        if (cancelled) return;

        for (const asset of savedAssets) {
          if (asset.kind === 'audio' || asset.kind === 'character-glb' || asset.kind === 'prop-glb') {
            const bin = await dbLoadAssetBinary(asset.id);
            if (bin) {
              if (asset.kind === 'character-glb' || asset.kind === 'prop-glb') {
                glbBinaryCacheRef.current.set(asset.id, bin);
              } else if (asset.kind === 'audio') {
                try {
                  await audioEngineRef.current?.decodeAudioAsset(asset.id, bin);
                } catch {
                  // Ignore decode failure
                }
              }
            }
          }
        }

        if (savedAssets.length > 0) {
          setAssets(savedAssets);
        }
        if (rawProjects.length > 0) {
          const migrated = rawProjects.map(migrateProjectData);
          setProjects(migrated);
          setActiveProjectId(migrated[0].id);
          setSaveStatus('saved');
        } else {
          const initial = createBlankProject('My Cartoon');
          setProjects([initial]);
          setActiveProjectId(initial.id);
          await dbSaveProject(initial);
          setSaveStatus('saved');
        }
      } catch {
        setSaveStatus('error');
        setNoticeMessage('Local storage could not be opened; changes stay in memory for this session.');
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced autosave
  useEffect(() => {
    if (!storageReady || saveStatus !== 'unsaved') return;
    const timer = window.setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await dbSaveProject(projectRef.current);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [projects, saveStatus, storageReady]);

  // Keyframe helpers
  const handleKeyCharacterTransform = useCallback(
    (instanceId: string, easing: EasingType) => {
      const sc = sceneRef.current;
      const char = sc.characters.find((c) => c.id === instanceId);
      if (!char) return;
      const evalState = evaluateSceneAtTime(sc, timeRef.current);
      const t = evalState.characters.get(instanceId)?.transform ?? char.transform;

      commitSceneMutation(`Key ${char.name} @ ${timeRef.current.toFixed(1)}s`, (s) => ({
        ...s,
        characters: s.characters.map((c) =>
          c.id === instanceId
            ? {
                ...c,
                positionKeyframes: upsertVec3Key(c.positionKeyframes, timeRef.current, t.position, easing),
                rotationKeyframes: upsertVec3Key(c.rotationKeyframes, timeRef.current, t.rotation, easing),
                scaleKeyframes: upsertVec3Key(c.scaleKeyframes, timeRef.current, t.scale, easing),
              }
            : c,
        ),
      }));
    },
    [commitSceneMutation],
  );

  const handleDuplicateCharacter = useCallback(
    (instanceId: string) => {
      const src = sceneRef.current.characters.find((c) => c.id === instanceId);
      if (!src) return;
      const copy: CharacterInstanceData = {
        ...JSON.parse(JSON.stringify(src)),
        id: createId('inst'),
        name: `${src.name} Copy`,
        transform: {
          ...cloneTransform(src.transform),
          position: {
            x: src.transform.position.x + 1.5,
            y: src.transform.position.y,
            z: src.transform.position.z,
          },
        },
      };
      commitSceneMutation(`Duplicate ${src.name}`, (s) => ({
        ...s,
        characters: [...s.characters, copy],
      }));
      setSelection({ kind: 'character', instanceId: copy.id });
    },
    [commitSceneMutation],
  );

  const handleRemoveCharacter = useCallback(
    (instanceId: string) => {
      const removed = sceneRef.current.characters.find((c) => c.id === instanceId);
      if (!removed) return;
      engineRef.current?.unregisterCharacterAdapter(instanceId);
      commitSceneMutation(`Remove ${removed.name}`, (s) => ({
        ...s,
        characters: s.characters.filter((c) => c.id !== instanceId),
        audioClips: s.audioClips.filter((a) => a.characterInstanceId !== instanceId),
        groups: (s.groups ?? [])
          .map((g) => ({ ...g, memberIds: g.memberIds.filter((id) => id !== instanceId) }))
          .filter((g) => g.memberIds.length > 0),
      }));
      if (poseModeInstanceId === instanceId) {
        setPoseModeInstanceId(null);
        engineRef.current?.setPoseMode(null);
      }
      setSelection({ kind: 'none' });
    },
    [commitSceneMutation, poseModeInstanceId],
  );

  const handleGroupSelection = useCallback(() => {
    const sc = sceneRef.current;
    let candidateIds = [...multiSelectedIds];
    if (candidateIds.length === 0) {
      if (selectionRef.current.kind === 'character') candidateIds = [selectionRef.current.instanceId];
      else if (selectionRef.current.kind === 'prop') candidateIds = [selectionRef.current.propId];
    }
    if (candidateIds.length === 0) {
      setNoticeMessage('Select one or more characters/props (Shift+Click) to create a logical group.');
      return;
    }

    let createdGroupId: string | null = null;
    commitSceneMutation('Group Selection', (s) => {
      const res = createLogicalGroup(s, candidateIds);
      createdGroupId = res.group?.id ?? null;
      return res.scene;
    });

    if (createdGroupId) {
      setSelection({ kind: 'group', groupId: createdGroupId });
      setMultiSelectedIds([]);
      setLeftTab('hierarchy');
    }
  }, [commitSceneMutation, multiSelectedIds]);

  const handleUngroupGroup = useCallback(
    (groupId: string) => {
      let released: string[] = [];
      commitSceneMutation('Ungroup', (s) => {
        const res = ungroupLogicalGroup(s, groupId);
        released = res.releasedIds;
        return res.scene;
      });
      if (released.length > 0) {
        const firstChar = sceneRef.current.characters.find((c) => c.id === released[0]);
        if (firstChar) setSelection({ kind: 'character', instanceId: firstChar.id });
        else setSelection({ kind: 'prop', propId: released[0] });
      } else {
        setSelection({ kind: 'none' });
      }
    },
    [commitSceneMutation],
  );

  const handleEnterPoseMode = useCallback((instanceId: string) => {
    const nodes = rigNodesRef.current[instanceId] ?? [];
    const preferred =
      nodes.find((n) => n.slot === 'head') ??
      nodes.find((n) => n.slot === 'leftUpperArm') ??
      nodes.find((n) => n.nodeId !== 'node_0') ??
      nodes[0];
    setPoseModeInstanceId(instanceId);
    engineRef.current?.setPoseMode(instanceId);
    setGizmoMode('rotate');
    setGizmoSpace('local');
    engineRef.current?.setGizmoMode('rotate');
    engineRef.current?.setGizmoSpace('local');
    setInspectorCharTab('rig');
    if (preferred) {
      setSelection({
        kind: 'body-part',
        instanceId,
        nodeId: preferred.nodeId,
        nodeName: preferred.name,
      });
    } else {
      setSelection({ kind: 'character', instanceId });
    }
  }, []);

  const handleExitPoseMode = useCallback(() => {
    const instId = poseModeInstanceId;
    setPoseModeInstanceId(null);
    engineRef.current?.setPoseMode(null);
    if (instId) {
      setSelection({ kind: 'character', instanceId: instId });
    }
  }, [poseModeInstanceId]);

  const handleToggleIsolate = useCallback((id: string) => {
    setIsolatedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  // Unified Context Menu builder (used by both right-click AND Shift+F10)
  const buildContextMenuItems = useCallback(
    (target: SelectionTarget): ContextMenuItem[] => {
      const sc = sceneRef.current;
      const items: ContextMenuItem[] = [];

      if (target.kind === 'character' || target.kind === 'body-part') {
        const ch = sc.characters.find((c) => c.id === target.instanceId);
        if (ch) {
          items.push({
            label: poseModeInstanceId === ch.id ? 'Exit Pose Mode' : `Pose Joints (${ch.name})`,
            shortcut: 'Dbl-Click',
            onClick: () =>
              poseModeInstanceId === ch.id
                ? handleExitPoseMode()
                : handleEnterPoseMode(ch.id),
          });
          items.push({
            label: 'Key Transform @ Playhead',
            shortcut: 'I',
            onClick: () => handleKeyCharacterTransform(ch.id, 'smooth'),
          });
          items.push({
            label: 'Suggest Next Motion (Tab HUD)',
            shortcut: 'Tab',
            onClick: () => {
              setTabHudIndex(0);
              setTabHudOpen(true);
            },
          });
          items.push({
            label: ch.lockedProperties?.transform ? 'Unlock Character' : 'Lock Character',
            dividerAbove: true,
            onClick: () =>
              commitSceneMutation(`Toggle Lock ${ch.name}`, (s) => ({
                ...s,
                characters: s.characters.map((c) =>
                  c.id === ch.id
                    ? {
                        ...c,
                        lockedProperties: {
                          ...c.lockedProperties,
                          transform: !c.lockedProperties?.transform,
                        },
                      }
                    : c,
                ),
              })),
          });
          items.push({
            label: isolatedIds.includes(ch.id) ? 'Clear Isolation' : `Isolate ${ch.name}`,
            onClick: () => handleToggleIsolate(ch.id),
          });
          items.push({
            label: 'Duplicate Character',
            shortcut: 'Ctrl+D',
            onClick: () => handleDuplicateCharacter(ch.id),
          });
          items.push({
            label: 'Group Selection',
            shortcut: 'Ctrl+G',
            onClick: handleGroupSelection,
          });
          if (target.kind === 'body-part') {
            const nodeId = target.nodeId;
            items.push({
              label: `Reset ${target.nodeName} Pose`,
              dividerAbove: true,
              onClick: () =>
                commitSceneMutation(`Reset ${target.nodeName}`, (s) => ({
                  ...s,
                  characters: s.characters.map((c) =>
                    c.id === ch.id
                      ? { ...c, nodeTracks: (c.nodeTracks ?? []).filter((nt) => nt.nodeId !== nodeId) }
                      : c,
                  ),
                })),
            });
          }
          items.push({
            label: `Remove ${ch.name}`,
            danger: true,
            dividerAbove: true,
            onClick: () => handleRemoveCharacter(ch.id),
          });
        }
      } else if (target.kind === 'prop') {
        const pr = (sc.props ?? []).find((p) => p.id === target.propId);
        if (pr) {
          items.push({
            label: `Key ${pr.name} @ Playhead`,
            onClick: () => {
              const t = evaluateSceneAtTime(sc, timeRef.current).props.get(pr.id)?.transform ?? pr.transform;
              commitSceneMutation(`Key ${pr.name}`, (s) => ({
                ...s,
                props: (s.props ?? []).map((p) =>
                  p.id === pr.id
                    ? {
                        ...p,
                        positionKeyframes: upsertVec3Key(p.positionKeyframes, timeRef.current, t.position),
                        rotationKeyframes: upsertVec3Key(p.rotationKeyframes, timeRef.current, t.rotation),
                      }
                    : p,
                ),
              }));
            },
          });
          items.push({
            label: pr.locked ? 'Unlock Prop' : 'Lock Prop',
            onClick: () =>
              commitSceneMutation(`Toggle Lock ${pr.name}`, (s) => ({
                ...s,
                props: (s.props ?? []).map((p) => (p.id === pr.id ? { ...p, locked: !p.locked } : p)),
              })),
          });
          items.push({
            label: 'Group Selection',
            shortcut: 'Ctrl+G',
            onClick: handleGroupSelection,
          });
          items.push({
            label: `Remove ${pr.name}`,
            danger: true,
            dividerAbove: true,
            onClick: () => {
              commitSceneMutation(`Remove ${pr.name}`, (s) => ({
                ...s,
                props: (s.props ?? []).filter((p) => p.id !== pr.id),
              }));
              setSelection({ kind: 'none' });
            },
          });
        }
      } else if (target.kind === 'group') {
        const grp = (sc.groups ?? []).find((g) => g.id === target.groupId);
        if (grp) {
          items.push({
            label: `Key Group "${grp.name}"`,
            onClick: () =>
              commitSceneMutation(`Key Group ${grp.name}`, (s) => ({
                ...s,
                groups: (s.groups ?? []).map((g) =>
                  g.id === grp.id
                    ? {
                        ...g,
                        positionKeyframes: upsertVec3Key(g.positionKeyframes, timeRef.current, g.transform.position),
                        rotationKeyframes: upsertVec3Key(g.rotationKeyframes, timeRef.current, g.transform.rotation),
                      }
                    : g,
                ),
              })),
          });
          items.push({
            label: grp.locked ? 'Unlock Group' : 'Lock Group',
            onClick: () =>
              commitSceneMutation(`Toggle Lock ${grp.name}`, (s) => ({
                ...s,
                groups: (s.groups ?? []).map((g) => (g.id === grp.id ? { ...g, locked: !g.locked } : g)),
              })),
          });
          items.push({
            label: 'Ungroup',
            shortcut: 'Ctrl+Shift+G',
            danger: true,
            dividerAbove: true,
            onClick: () => handleUngroupGroup(grp.id),
          });
        }
      }

      // General Viewport actions always available
      items.push({
        label: 'Focus Target',
        shortcut: 'F',
        dividerAbove: items.length > 0,
        onClick: () => engineRef.current?.focusOnTarget(),
      });
      items.push({
        label: 'Frame All Stage Objects',
        shortcut: 'Shift+F',
        onClick: () => engineRef.current?.frameAll(),
      });
      if (isolatedIds.length > 0) {
        items.push({
          label: 'Show All Isolated Objects',
          onClick: () => setIsolatedIds([]),
        });
      }

      return items;
    },
    [
      commitSceneMutation,
      handleDuplicateCharacter,
      handleEnterPoseMode,
      handleExitPoseMode,
      handleGroupSelection,
      handleKeyCharacterTransform,
      handleRemoveCharacter,
      handleToggleIsolate,
      handleUngroupGroup,
      isolatedIds,
      poseModeInstanceId,
    ],
  );

  // Mount Three.js StudioEngine once
  useEffect(() => {
    const mount = viewportMountRef.current;
    if (!mount) return;

    const engine = new StudioEngine(mount, {
      onSelectTarget: (target, shiftKey) => {
        if (shiftKey && (target.kind === 'character' || target.kind === 'prop')) {
          const id = target.kind === 'character' ? target.instanceId : target.propId;
          setMultiSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
          );
        } else {
          if (target.kind === 'character') setMultiSelectedIds([target.instanceId]);
          else if (target.kind === 'prop') setMultiSelectedIds([target.propId]);
          else setMultiSelectedIds([]);
        }
        setSelection(target);
        if (target.kind === 'body-part') {
          setInspectorCharTab('rig');
        }
      },
      onPoseModeChange: (instId, preferredNodeId) => {
        setPoseModeInstanceId(instId);
        if (instId) {
          setGizmoMode('rotate');
          setGizmoSpace('local');
          engineRef.current?.setGizmoMode('rotate');
          engineRef.current?.setGizmoSpace('local');
          setInspectorCharTab('rig');
          if (preferredNodeId) {
            const nodeName =
              rigNodesRef.current[instId]?.find((n) => n.nodeId === preferredNodeId)?.name ??
              preferredNodeId;
            setSelection({
              kind: 'body-part',
              instanceId: instId,
              nodeId: preferredNodeId,
              nodeName,
            });
          }
        }
      },
      onHoverChanged: (hover) => {
        setHoverInfo(hover);
      },
      onContextMenuRequest: (clientX, clientY, target) => {
        setViewportContextMenu({
          x: clientX,
          y: clientY,
          items: buildContextMenuItems(target),
        });
      },
      onCharacterTransformCommit: (instanceId, nextTransform) => {
        const sc = sceneRef.current;
        const char = sc.characters.find((c) => c.id === instanceId);
        if (!char || char.lockedProperties?.transform) return;
        const committed = cloneTransform(nextTransform);
        const shouldAutoKey = autoKeyRef.current;
        const tNow = timeRef.current;

        commitSceneMutation(`Transform ${char.name}`, (s) => ({
          ...s,
          characters: s.characters.map((c) => {
            if (c.id !== instanceId) return c;
            if (!shouldAutoKey) return { ...c, transform: committed };
            return {
              ...c,
              transform: committed,
              positionKeyframes: upsertVec3Key(c.positionKeyframes, tNow, committed.position),
              rotationKeyframes: upsertVec3Key(c.rotationKeyframes, tNow, committed.rotation),
              scaleKeyframes: upsertVec3Key(c.scaleKeyframes, tNow, committed.scale),
            };
          }),
        }));
      },
      onNodeTransformCommit: (instanceId, nodeId, nodeName, rotation, _pos) => {
        const tNow = timeRef.current;
        commitSceneMutation(
          `Rotate ${nodeName}`,
          (s) => ({
            ...s,
            characters: s.characters.map((c) => {
              if (c.id !== instanceId) return c;
              const tracks = [...(c.nodeTracks ?? [])];
              const idx = tracks.findIndex((nt) => nt.nodeId === nodeId);
              const existing =
                idx >= 0 ? tracks[idx] : { nodeId, nodeName, rotationKeyframes: [], positionKeyframes: [] };
              const updatedTrack = {
                ...existing,
                rotationKeyframes: upsertVec3Key(existing.rotationKeyframes, tNow, rotation, 'smooth'),
              };
              if (idx >= 0) tracks[idx] = updatedTrack;
              else tracks.push(updatedTrack);
              return { ...c, nodeTracks: tracks };
            }),
          }),
          `node:${instanceId}:${nodeId}`,
        );
      },
      onIkTargetCommit: (instanceId, chain, targetPos) => {
        commitSceneMutation(
          `Move ${chain} IK Target`,
          (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === instanceId
                ? {
                    ...c,
                    ikTargets: (c.ikTargets ?? []).map((ik) =>
                      ik.chain === chain ? { ...ik, target: { ...targetPos } } : ik,
                    ),
                  }
                : c,
            ),
          }),
          `ik:${instanceId}:${chain}`,
        );
      },
      onPropTransformCommit: (propId, nextTransform) => {
        const tNow = timeRef.current;
        const shouldAutoKey = autoKeyRef.current;
        commitSceneMutation(`Transform Prop`, (s) => ({
          ...s,
          props: (s.props ?? []).map((p) => {
            if (p.id !== propId || p.locked) return p;
            const committed = cloneTransform(nextTransform);
            if (!shouldAutoKey) return { ...p, transform: committed };
            return {
              ...p,
              transform: committed,
              positionKeyframes: upsertVec3Key(p.positionKeyframes, tNow, committed.position),
              rotationKeyframes: upsertVec3Key(p.rotationKeyframes, tNow, committed.rotation),
              scaleKeyframes: upsertVec3Key(p.scaleKeyframes, tNow, committed.scale),
            };
          }),
        }));
      },
      onGroupTransformCommit: (groupId, nextTransform) => {
        const tNow = timeRef.current;
        const shouldAutoKey = autoKeyRef.current;
        commitSceneMutation(`Transform Group`, (s) => ({
          ...s,
          groups: (s.groups ?? []).map((g) => {
            if (g.id !== groupId || g.locked) return g;
            const committed = cloneTransform(nextTransform);
            if (!shouldAutoKey) return { ...g, transform: committed };
            return {
              ...g,
              transform: committed,
              positionKeyframes: upsertVec3Key(g.positionKeyframes, tNow, committed.position),
              rotationKeyframes: upsertVec3Key(g.rotationKeyframes, tNow, committed.rotation),
              scaleKeyframes: upsertVec3Key(g.scaleKeyframes, tNow, committed.scale),
            };
          }),
        }));
      },
      onLightPositionCommit: (lightId, position) => {
        commitSceneMutation(`Move Light`, (s) => ({
          ...s,
          lights: (s.lights ?? []).map((l) => (l.id === lightId ? { ...l, position } : l)),
        }));
      },
      onCameraTransformCommit: (nextPose) => {
        const curTarget = sceneRef.current.camera.pose.target;
        const mergedPose: CameraPose = {
          position: nextPose.position,
          target: { ...curTarget },
          fov: nextPose.fov,
        };
        commitSceneMutation('Move Scene Camera', (s) => ({
          ...s,
          camera: { ...s.camera, pose: mergedPose },
          cameras: (s.cameras ?? []).map((cam, idx) =>
            cam.id === s.activeCameraId || (!s.activeCameraId && idx === 0)
              ? { ...cam, pose: mergedPose }
              : cam,
          ),
        }));
      },
      onWaypointTransformCommit: (ownerId, ownerKind, pointId, handleKind, worldPos) => {
        const updatePoints = (points: MotionPathPoint[]) =>
          points.map((pt) => {
            if (pt.id !== pointId) return pt;
            if (handleKind === 'point') return { ...pt, position: { ...worldPos } };
            const rel: Vec3 = {
              x: worldPos.x - pt.position.x,
              y: worldPos.y - pt.position.y,
              z: worldPos.z - pt.position.z,
            };
            return updatePointWithHandleSymmetry(pt, handleKind, rel);
          });

        commitSceneMutation('Edit Path Waypoint', (s) => {
          if (ownerKind === 'prop') {
            return {
              ...s,
              props: (s.props ?? []).map((p) =>
                p.id === ownerId
                  ? { ...p, motionPath: { ...p.motionPath, points: updatePoints(p.motionPath.points) } }
                  : p,
              ),
            };
          }
          return {
            ...s,
            characters: s.characters.map((c) =>
              c.id === ownerId
                ? { ...c, motionPath: { ...c.motionPath, points: updatePoints(c.motionPath.points) } }
                : c,
            ),
          };
        });
      },
      onAnimationTick: (rawDt) => {
        const dt = rawDt * playbackSpeedRef.current;
        const sc = sceneRef.current;
        const workStart = sc.workArea?.enabled ? sc.workArea.start : 0;
        const workEnd = sc.workArea?.enabled ? Math.min(sc.duration, sc.workArea.end) : sc.duration;
        const nextTime = timeRef.current + dt;

        if (nextTime >= workEnd) {
          if (loopPlaybackRef.current) {
            timeRef.current = workStart;
            setCurrentTime(workStart);
            const profiles = new Map(sc.characters.map((c) => [c.id, c.audioProfile]));
            audioEngineRef.current?.startPlayback(workStart, sc.audioClips, profiles);
            applySceneEvaluation(sc, workStart, 0);
            return;
          }
          if (fullStoryRef.current) {
            const proj = projectRef.current;
            const curIdx = proj.scenes.findIndex((s) => s.id === sc.id);
            if (curIdx >= 0 && curIdx < proj.scenes.length - 1) {
              const nextScene = proj.scenes[curIdx + 1];
              timeRef.current = 0;
              setCurrentTime(0);
              updateActiveProject((p) => ({ ...p, activeSceneId: nextScene.id }), false);
              const profiles = new Map(nextScene.characters.map((c) => [c.id, c.audioProfile]));
              audioEngineRef.current?.startPlayback(0, nextScene.audioClips, profiles);
              return;
            }
          }
          timeRef.current = workEnd;
          setCurrentTime(workEnd);
          setIsPlaying(false);
          engineRef.current?.setPlaying(false);
          audioEngineRef.current?.stopAll();
          applySceneEvaluation(sc, workEnd, 0);
          return;
        }

        timeRef.current = nextTime;
        const profiles = new Map(sc.characters.map((c) => [c.id, c.audioProfile]));
        audioEngineRef.current?.syncPlayback(nextTime, sc.audioClips, profiles);
        applySceneEvaluation(sc, nextTime, dt);

        const nowMs = performance.now();
        if (nowMs - lastUiTimeSyncRef.current > 65) {
          lastUiTimeSyncRef.current = nowMs;
          setCurrentTime(nextTime);
        }
      },
    });

    engineRef.current = engine;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        engine.resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    ro.observe(mount);

    return () => {
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
      audioEngineRef.current?.dispose();
    };
  }, [applySceneEvaluation, buildContextMenuItems, commitSceneMutation, updateActiveProject]);

  // Keep engine synced with displayedScene (handles Tab preview + Undo/Redo + character instances)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const envSpec = ENVIRONMENT_PRESETS.find((e) => e.id === displayedScene.environmentPreset);
    engine.setSceneAppearance(
      displayedScene.backgroundColor,
      displayedScene.showGrid,
      envSpec?.floorColor,
    );

    const activeIds = new Set(displayedScene.characters.map((c) => c.id));
    for (const cId of engine.getRegisteredIds()) {
      if (!activeIds.has(cId)) {
        engine.unregisterCharacterAdapter(cId);
      }
    }

    for (const char of displayedScene.characters) {
      if (engine.getAdapter(char.id) || loadingAdaptersRef.current.has(char.id)) continue;
      const asset = assets.find((a) => a.id === char.assetId);
      if (!asset) continue;

      loadingAdaptersRef.current.add(char.id);
      const glbBinary = glbBinaryCacheRef.current.get(asset.id);
      let adapter: AnyCharacterAdapter;
      try {
        adapter = createCharacterAdapter(char.id, asset, {
          includeStageProps: char.includeStageProps,
          glbBinary,
        });
      } catch (err) {
        loadingAdaptersRef.current.delete(char.id);
        setNoticeMessage(err instanceof Error ? err.message : 'Failed to initialize character.');
        continue;
      }

      adapter
        .load()
        .then(() => {
          loadingAdaptersRef.current.delete(char.id);
          if (!sceneRef.current.characters.some((c) => c.id === char.id)) {
            adapter.dispose();
            return;
          }
          engine.registerCharacterAdapter(adapter);
          setCapabilitiesMap((prev) => ({ ...prev, [char.id]: adapter.capabilities }));

          const nodes =
            'getRigNodes' in adapter && typeof adapter.getRigNodes === 'function'
              ? adapter.getRigNodes()
              : [];
          setRigNodesByInstance((prev) => ({ ...prev, [char.id]: nodes }));

          if (nodes.length > 0 && (!char.boneMap || Object.keys(char.boneMap).length === 0)) {
            const autoMap = autoMapHumanoidSlots(nodes);
            if (Object.keys(autoMap).length > 0) {
              updateActiveScene(
                (s) => ({
                  ...s,
                  characters: s.characters.map((c) =>
                    c.id === char.id ? { ...c, boneMap: autoMap } : c,
                  ),
                }),
                false,
              );
            }
          }

          applySceneEvaluation(sceneRef.current, timeRef.current, 0);
          engine.setSelection(selectionRef.current);
        })
        .catch((err) => {
          loadingAdaptersRef.current.delete(char.id);
          setNoticeMessage(
            err instanceof Error
              ? `Failed to render "${char.name}": ${err.message}`
              : `Failed to render "${char.name}".`,
          );
        });
    }

    applySceneEvaluation(displayedScene, timeRef.current, 0);
  }, [displayedScene, assets, isolatedIds, applySceneEvaluation, updateActiveScene]);

  // Keep engine selection, motion path visual & rig overlay synced
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setSelection(selection);
    const charId =
      selection.kind === 'character' ||
      selection.kind === 'waypoint' ||
      selection.kind === 'body-part' ||
      selection.kind === 'ik-handle'
        ? selection.instanceId
        : null;
    const char = charId ? activeScene.characters.find((c) => c.id === charId) ?? null : null;
    engine.updateMotionPathVisual(char?.id ?? null, char?.motionPath ?? null);
    refreshRigVisuals(activeScene, selection, showRigOverlay);
  }, [selection, activeScene, showRigOverlay, refreshRigVisuals]);

  // Workspace Layout preset switcher
  const handleChangeWorkspaceLayout = useCallback(
    (layout: WorkspaceLayoutId) => {
      setWorkspaceLayout(layout);
      switch (layout) {
        case 'general':
          setLeftCollapse('expanded');
          setRightCollapse('expanded');
          setTimelineCollapse('expanded');
          setLeftTab('assets');
          setInspectorCharTab('transform');
          break;
        case 'animation':
          setLeftCollapse('compact');
          setRightCollapse('expanded');
          setTimelineCollapse('expanded');
          setInspectorCharTab('presets');
          break;
        case 'rigging':
          setLeftCollapse('expanded');
          setRightCollapse('expanded');
          setTimelineCollapse('compact');
          setLeftTab('hierarchy');
          setInspectorCharTab('rig');
          break;
        case 'scene':
          setLeftCollapse('expanded');
          setRightCollapse('expanded');
          setTimelineCollapse('compact');
          setLeftTab('assets');
          setInspectorCharTab('transform');
          break;
        case 'audio':
          setLeftCollapse('compact');
          setRightCollapse('expanded');
          setTimelineCollapse('expanded');
          setInspectorCharTab('face');
          break;
        case 'camera':
          setLeftCollapse('compact');
          setRightCollapse('expanded');
          setTimelineCollapse('expanded');
          setSelection({ kind: 'camera', cameraId: activeScene.activeCameraId });
          break;
      }
    },
    [activeScene.activeCameraId],
  );

  // Transport controls
  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(activeScene.duration, time));
      timeRef.current = clamped;
      setCurrentTime(clamped);
      const profiles = new Map(activeScene.characters.map((c) => [c.id, c.audioProfile]));
      audioEngineRef.current?.seek(clamped, activeScene.audioClips, profiles);
      applySceneEvaluation(displayedScene, clamped, 0);
    },
    [activeScene, displayedScene, applySceneEvaluation],
  );

  const handleTogglePlay = useCallback(() => {
    const next = !isPlayingRef.current;
    const workStart = activeScene.workArea?.enabled ? activeScene.workArea.start : 0;
    const workEnd = activeScene.workArea?.enabled
      ? Math.min(activeScene.duration, activeScene.workArea.end)
      : activeScene.duration;

    if (next && (timeRef.current >= workEnd || timeRef.current < workStart)) {
      timeRef.current = workStart;
      setCurrentTime(workStart);
    }
    setIsPlaying(next);
    engineRef.current?.setPlaying(next);
    if (next) {
      const profiles = new Map(activeScene.characters.map((c) => [c.id, c.audioProfile]));
      audioEngineRef.current?.startPlayback(timeRef.current, activeScene.audioClips, profiles);
    } else {
      audioEngineRef.current?.pause();
    }
  }, [activeScene]);

  const handleStop = useCallback(() => {
    setIsPlaying(false);
    engineRef.current?.setPlaying(false);
    audioEngineRef.current?.stopAll();
    handleSeek(0);
  }, [handleSeek]);

  const handleSaveNow = useCallback(async () => {
    setSaveStatus('saving');
    try {
      const thumb = engineRef.current?.captureThumbnailDataUrl();
      if (thumb) {
        updateActiveScene((s) => ({ ...s, thumbnailDataUrl: thumb }), false);
      }
      await dbSaveProject(projectRef.current);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  }, [updateActiveScene]);

  const handleKeyCamera = useCallback(
    (easing: EasingType) => {
      const evalPose = evaluateSceneAtTime(sceneRef.current, timeRef.current).camera;
      const snapTime = Number(timeRef.current.toFixed(2));
      commitSceneMutation(`Key Camera @ ${snapTime}s`, (s) => {
        const filtered = s.camera.keyframes.filter((k) => Math.abs(k.time - snapTime) > 0.04);
        const nextKeys = [
          ...filtered,
          {
            id: createId('camkf'),
            time: snapTime,
            pose: {
              position: { ...evalPose.position },
              target: { ...evalPose.target },
              fov: evalPose.fov,
            },
            easing,
          },
        ].sort((a, b) => a.time - b.time);
        return {
          ...s,
          camera: { ...s.camera, keyframes: nextKeys },
          cameras: (s.cameras ?? []).map((cam, idx) =>
            cam.id === s.activeCameraId || (!s.activeCameraId && idx === 0)
              ? { ...cam, keyframes: nextKeys }
              : cam,
          ),
        };
      });
    },
    [commitSceneMutation],
  );

  // Tab Prediction Apply
  const handleApplyTabPrediction = useCallback(
    (pred: TabPrediction) => {
      if (!pred.compatible) {
        setNoticeMessage(pred.incompatibilityReason ?? pred.reason);
        return;
      }
      if (pred.applyKind === 'camera-frame') {
        engineRef.current?.frameAll();
        setTabPreviewActive(false);
        setTabHudOpen(false);
        return;
      }
      setTabPreviewActive(false);
      setTabHudOpen(false);
      commitSceneMutation(`Tab Predict: ${pred.title}`, (s) =>
        applyTabPredictionToScene(s, pred, timeRef.current, rigNodesRef.current),
      );
    },
    [commitSceneMutation],
  );

  // Full Global Keyboard Shortcuts (including Shift+F10, Tab HUD, F Focus, Shift+F Frame All, Ctrl+G/Shift+G, Ctrl+D, Ctrl+Z/Shift+Z)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const lower = e.key.toLowerCase();

      if (mod && lower === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
        return;
      }
      if (mod && lower === 's') {
        e.preventDefault();
        void handleSaveNow();
        return;
      }
      if (mod && lower === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (mod && lower === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (e.key === 'Escape') {
        if (viewportContextMenu) {
          setViewportContextMenu(null);
          return;
        }
        if (tabHudOpen) {
          setTabPreviewActive(false);
          setTabHudOpen(false);
          return;
        }
        if (poseModeInstanceId) {
          handleExitPoseMode();
          return;
        }
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Shift+F10 Context Menu fallback
      if (e.shiftKey && e.key === 'F10') {
        e.preventDefault();
        const rect = viewportMountRef.current?.getBoundingClientRect();
        const cx = rect ? rect.left + rect.width * 0.5 : window.innerWidth * 0.5;
        const cy = rect ? rect.top + rect.height * 0.45 : window.innerHeight * 0.45;
        setViewportContextMenu({
          x: cx,
          y: cy,
          items: buildContextMenuItems(selectionRef.current),
        });
        return;
      }

      // Tab Prediction HUD
      if (e.key === 'Tab') {
        e.preventDefault();
        if (!tabHudOpen) {
          setTabHudIndex(0);
          setTabHudOpen(true);
        } else {
          setTabHudIndex((idx) => (tabPredictions.length > 0 ? (idx + 1) % tabPredictions.length : 0));
        }
        return;
      }

      if (tabHudOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        if (tabPredictions.length > 0) {
          setTabHudIndex((idx) =>
            e.key === 'ArrowDown'
              ? (idx + 1) % tabPredictions.length
              : (idx - 1 + tabPredictions.length) % tabPredictions.length,
          );
        }
        return;
      }

      if (tabHudOpen && e.key === 'Enter' && activeTabPrediction) {
        e.preventDefault();
        handleApplyTabPrediction(activeTabPrediction);
        return;
      }

      // Grouping & Duplication
      if (mod && lower === 'g') {
        e.preventDefault();
        if (e.shiftKey) {
          if (selectionRef.current.kind === 'group') {
            handleUngroupGroup(selectionRef.current.groupId);
          } else if (selectionRef.current.kind === 'character') {
            const grp = findMemberGroup(sceneRef.current, selectionRef.current.instanceId);
            if (grp) handleUngroupGroup(grp.id);
          } else if (selectionRef.current.kind === 'prop') {
            const grp = findMemberGroup(sceneRef.current, selectionRef.current.propId);
            if (grp) handleUngroupGroup(grp.id);
          }
        } else {
          handleGroupSelection();
        }
        return;
      }

      if (mod && lower === 'd') {
        e.preventDefault();
        if (selectionRef.current.kind === 'character') {
          handleDuplicateCharacter(selectionRef.current.instanceId);
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (lower === 'q') {
        setGizmoMode('select');
        engineRef.current?.setGizmoMode('select');
      } else if (lower === 'g' && !mod) {
        setGizmoMode('translate');
        engineRef.current?.setGizmoMode('translate');
      } else if (lower === 'r' && !mod) {
        setGizmoMode('rotate');
        engineRef.current?.setGizmoMode('rotate');
      } else if (lower === 's' && !mod) {
        setGizmoMode('scale');
        engineRef.current?.setGizmoMode('scale');
      } else if (lower === 'l') {
        const nextSpace: GizmoSpace = gizmoSpace === 'world' ? 'local' : 'world';
        setGizmoSpace(nextSpace);
        engineRef.current?.setGizmoSpace(nextSpace);
      } else if (lower === 'f') {
        e.preventDefault();
        if (e.shiftKey) engineRef.current?.frameAll();
        else engineRef.current?.focusOnTarget();
      } else if (lower === 'i' && !mod) {
        if (selectionRef.current.kind === 'character') {
          handleKeyCharacterTransform(selectionRef.current.instanceId, 'smooth');
        } else if (selectionRef.current.kind === 'camera') {
          handleKeyCamera('smooth');
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectionRef.current.kind === 'character') {
          handleRemoveCharacter(selectionRef.current.instanceId);
        } else if (selectionRef.current.kind === 'prop') {
          const propId = selectionRef.current.propId;
          commitSceneMutation('Remove Prop', (s) => ({
            ...s,
            props: (s.props ?? []).filter((p) => p.id !== propId),
          }));
          setSelection({ kind: 'none' });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeTabPrediction,
    buildContextMenuItems,
    commitSceneMutation,
    gizmoSpace,
    handleApplyTabPrediction,
    handleDuplicateCharacter,
    handleExitPoseMode,
    handleGroupSelection,
    handleKeyCamera,
    handleKeyCharacterTransform,
    handleRedo,
    handleRemoveCharacter,
    handleSaveNow,
    handleTogglePlay,
    handleUndo,
    handleUngroupGroup,
    poseModeInstanceId,
    tabHudOpen,
    tabPredictions.length,
    viewportContextMenu,
  ]);

  // Importing Files (.html, .glb/.gltf, audio)
  const importAssetFile = useCallback(
    async (file: File): Promise<AssetRecord> => {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'html' || ext === 'htm') {
        const html = await file.text();
        const analysis = analyzeHtmlCharacter(html, file.name);
        const record: AssetRecord = {
          id: createId('asset'),
          name: analysis.suggestedName,
          kind: 'character-html',
          fileName: file.name,
          mimeType: file.type || 'text/html',
          sizeBytes: file.size,
          createdAt: Date.now(),
          htmlSource: html,
          htmlAnalysis: {
            usesThreeJs: analysis.usesThreeJs,
            threeVersion: analysis.threeVersion,
            recommendedMode:
              analysis.recommendedMode === 'isolated-iframe'
                ? 'isolated-iframe'
                : 'native-three-extraction',
            globalApiHandle: analysis.globalApiHandle,
            sdkDetected: analysis.sdkDetected,
            externalDependencies: analysis.externalDependencies,
            rigHints: analysis.rigHints,
            facialHints: analysis.facialHints,
            moods: analysis.moods,
            actions: analysis.actions.map((a) => ({
              id: a.id,
              label: a.label,
              kind: a.kind === 'loop' ? 'loop' : 'gesture',
              supportsSpeed: a.supportsSpeed,
              defaultDurationSec: a.defaultDurationSec,
            })),
            supportsTalk: analysis.supportsTalk,
            supportsSpeak: analysis.supportsSpeak,
            supportsLookAt: analysis.supportsLookAt,
            warnings: analysis.warnings,
          },
        };
        await dbSaveAsset(record);
        setAssets((prev) => [record, ...prev]);
        updateActiveProject((p) => ({ ...p, assetIds: [...p.assetIds, record.id] }));
        return record;
      }

      if (ext === 'glb' || ext === 'gltf') {
        const buffer = await file.arrayBuffer();
        const record: AssetRecord = {
          id: createId('asset'),
          name: file.name.replace(/\.(glb|gltf)$/i, ''),
          kind: 'character-glb',
          fileName: file.name,
          mimeType: file.type || 'model/gltf-binary',
          sizeBytes: file.size,
          createdAt: Date.now(),
        };
        glbBinaryCacheRef.current.set(record.id, buffer);
        await dbSaveAsset(record, buffer);
        setAssets((prev) => [record, ...prev]);
        updateActiveProject((p) => ({ ...p, assetIds: [...p.assetIds, record.id] }));
        return record;
      }

      if (['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) {
        const buffer = await file.arrayBuffer();
        const recordId = createId('audio');
        const decoded = await audioEngineRef.current!.decodeAudioAsset(recordId, buffer);
        const record: AssetRecord = {
          id: recordId,
          name: file.name.replace(/\.[^.]+$/, ''),
          kind: 'audio',
          fileName: file.name,
          mimeType: file.type || 'audio/mpeg',
          sizeBytes: file.size,
          createdAt: Date.now(),
          audioDuration: decoded.duration,
          waveformPeaks: decoded.peaks,
        };
        await dbSaveAsset(record, buffer);
        setAssets((prev) => [record, ...prev]);
        updateActiveProject((p) => ({ ...p, assetIds: [...p.assetIds, record.id] }));
        return record;
      }

      throw new Error(
        `Unsupported file format ".${ext}". Please choose .html, .glb, .gltf, .mp3, .wav, or .ogg.`,
      );
    },
    [updateActiveProject],
  );

  const handleLoadWorkspaceSample = useCallback(
    async (sampleUrl: string, label: string) => {
      try {
        const res = await fetch(sampleUrl);
        if (!res.ok) throw new Error(`Could not load ${label} (${res.status})`);
        const blob = await res.blob();
        const fileName = sampleUrl.split('/').pop() || `${label}.html`;
        const file = new File([blob], fileName, { type: 'text/html' });
        await importAssetFile(file);
      } catch (err) {
        setNoticeMessage(err instanceof Error ? err.message : 'Failed to load workspace sample.');
      }
    },
    [importAssetFile],
  );

  // Add Character Instance to Scene
  const handleAddCharacterToScene = useCallback(
    (asset: AssetRecord) => {
      const count = activeScene.characters.length;
      const offsetX =
        count === 0
          ? 0
          : count === 1
            ? -2.8
            : count === 2
              ? 2.8
              : (count % 2 === 1 ? -1 : 1) * (2.8 + Math.floor(count / 2) * 2.2);
      const instance: CharacterInstanceData = {
        id: createId('inst'),
        assetId: asset.id,
        name: `${asset.name}${count > 0 ? ` ${count + 1}` : ''}`,
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(offsetX, 0, 0),
        pivot: { x: 0, y: 0, z: 0 },
        lockedProperties: { transform: false, keys: false },
        lockedNodes: [],
        hiddenNodes: [],
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        nodeTracks: [],
        boneMap: {},
        ikTargets: [],
        savedPoses: [],
        facialKeyframes: [],
        motionPath: createDefaultMotionPath(),
        actionClips: [],
        currentMood: 'neutral',
        audioProfile: {
          voiceLabel: `${asset.name} Voice`,
          providerId: 'webspeech',
          pitch: 1,
          speed: 1,
          defaultVolume: 1,
          muted: false,
          pan: Math.max(-0.5, Math.min(0.5, offsetX * 0.2)),
        },
      };

      commitSceneMutation(`Add ${instance.name}`, (s) => ({
        ...s,
        characters: [...s.characters, instance],
      }));
      setSelection({ kind: 'character', instanceId: instance.id });
    },
    [activeScene.characters.length, commitSceneMutation],
  );

  // Preview action briefly even when paused
  const handlePreviewCharacterAction = useCallback(
    (instanceId: string, actionId: string, speed: number) => {
      const adapter = engineRef.current?.getAdapter(instanceId);
      if (!adapter || !actionId) return;
      adapter.resume();
      adapter.playAction(actionId, { speed, loop: true });
      if (!isPlayingRef.current) {
        let elapsed = 0;
        const step = () => {
          if (elapsed >= 1.5 || isPlayingRef.current) return;
          elapsed += 0.033;
          adapter.update(0.033, timeRef.current);
          engineRef.current?.requestRender();
          window.setTimeout(step, 33);
        };
        step();
      }
    },
    [],
  );

  const handleAlignMultiSelection = useCallback(
    (mode: 'align-x' | 'align-z' | 'distribute-x' | 'ground-y') => {
      const ids = new Set(multiSelectedIds);
      if (ids.size < 2) return;
      const chars = activeScene.characters.filter((c) => ids.has(c.id));
      const props = (activeScene.props ?? []).filter((p) => ids.has(p.id));
      const allPos = [...chars.map((c) => c.transform.position), ...props.map((p) => p.transform.position)];
      if (allPos.length < 2) return;

      const avgX = allPos.reduce((a, p) => a + p.x, 0) / allPos.length;
      const avgZ = allPos.reduce((a, p) => a + p.z, 0) / allPos.length;

      commitSceneMutation(`Align (${mode})`, (s) => {
        if (mode === 'distribute-x') {
          const ordered = [...s.characters]
            .filter((c) => ids.has(c.id))
            .sort((a, b) => a.transform.position.x - b.transform.position.x);
          const minX = ordered[0]?.transform.position.x ?? -3;
          const maxX = ordered[ordered.length - 1]?.transform.position.x ?? 3;
          const span = Math.max(2, maxX - minX);
          const mapX = new Map<string, number>();
          ordered.forEach((c, idx) => {
            mapX.set(c.id, ordered.length > 1 ? minX + (idx / (ordered.length - 1)) * span : c.transform.position.x);
          });
          return {
            ...s,
            characters: s.characters.map((c) =>
              mapX.has(c.id)
                ? { ...c, transform: { ...c.transform, position: { ...c.transform.position, x: mapX.get(c.id)! } } }
                : c,
            ),
          };
        }

        const applyPos = (p: Vec3): Vec3 => {
          if (mode === 'align-x') return { ...p, x: avgX };
          if (mode === 'align-z') return { ...p, z: avgZ };
          return { ...p, y: 0 };
        };

        return {
          ...s,
          characters: s.characters.map((c) =>
            ids.has(c.id) ? { ...c, transform: { ...c.transform, position: applyPos(c.transform.position) } } : c,
          ),
          props: (s.props ?? []).map((pr) =>
            ids.has(pr.id) ? { ...pr, transform: { ...pr.transform, position: applyPos(pr.transform.position) } } : pr,
          ),
        };
      });
    },
    [activeScene.characters, activeScene.props, commitSceneMutation, multiSelectedIds],
  );

  const handleExecuteSuggestion = useCallback(
    (sug: AnimationSuggestion) => {
      if (sug.actionKind === 'add-camera-key') {
        handleKeyCamera('smooth');
        return;
      }
      if (!sug.targetCharacterId) return;
      const cid = sug.targetCharacterId;
      if (sug.actionKind === 'add-walk') {
        const preset = MOTION_PRESETS.find((m) => m.id === 'walk')!;
        const clip: ActionClip = {
          id: createId('act'),
          actionId: 'walk',
          label: preset.label,
          kind: 'preset',
          startTime: 0,
          duration: activeScene.characters.find((c) => c.id === cid)?.motionPath.duration ?? 3,
          speed: 1,
          blendIn: 0.25,
          blendOut: 0.25,
          weight: 1,
        };
        commitSceneMutation('Apply Walk Suggestion', (s) => ({
          ...s,
          characters: s.characters.map((c) =>
            c.id === cid ? { ...c, actionClips: [...c.actionClips, clip] } : c,
          ),
        }));
      } else if (sug.actionKind === 'enable-orient') {
        commitSceneMutation('Enable Orient Along Path', (s) => ({
          ...s,
          characters: s.characters.map((c) =>
            c.id === cid ? { ...c, motionPath: { ...c.motionPath, orientAlongPath: true } } : c,
          ),
        }));
      } else if (sug.actionKind === 'smooth-keys') {
        commitSceneMutation('Smooth Character Keys', (s) => ({
          ...s,
          characters: s.characters.map((c) =>
            c.id === cid
              ? {
                  ...c,
                  positionKeyframes: c.positionKeyframes.map((k) => ({ ...k, easing: 'smooth' })),
                  rotationKeyframes: c.rotationKeyframes.map((k) => ({ ...k, easing: 'smooth' })),
                }
              : c,
          ),
        }));
      }
    },
    [activeScene.characters, commitSceneMutation, handleKeyCamera],
  );

  const evalSnapshot = useMemo(
    () => evaluateSceneAtTime(displayedScene, currentTime),
    [displayedScene, currentTime],
  );

  const selectedProp = useMemo(() => {
    if (selection.kind !== 'prop') return null;
    return (activeScene.props ?? []).find((p) => p.id === selection.propId) ?? null;
  }, [activeScene.props, selection]);

  const selectedGroup = useMemo(() => {
    if (selection.kind !== 'group') return null;
    return (activeScene.groups ?? []).find((g) => g.id === selection.groupId) ?? null;
  }, [activeScene.groups, selection]);

  const selectedLight = useMemo(() => {
    if (selection.kind !== 'light') return null;
    return (activeScene.lights ?? []).find((l) => l.id === selection.lightId) ?? null;
  }, [activeScene.lights, selection]);

  const selectedAudioClip = useMemo(() => {
    if (selection.kind !== 'audio-clip') return null;
    return activeScene.audioClips.find((c) => c.id === selection.clipId) ?? null;
  }, [activeScene.audioClips, selection]);

  const selectedAudioAsset = useMemo(
    () =>
      selectedAudioClip ? assets.find((a) => a.id === selectedAudioClip.assetId) ?? null : null,
    [assets, selectedAudioClip],
  );

  const selectedActionClip = useMemo(() => {
    if (selection.kind !== 'action-clip') return null;
    const ch = activeScene.characters.find((c) => c.id === selection.instanceId);
    return ch?.actionClips.find((a) => a.id === selection.clipId) ?? null;
  }, [activeScene.characters, selection]);

  const isolatedIframeData = useMemo(() => {
    const target = selectedCharacter ?? activeScene.characters[0];
    if (!target) return null;
    const caps = capabilitiesMap[target.id];
    if (caps?.importMode !== 'isolated-iframe') return null;
    const asset = assets.find((a) => a.id === target.assetId);
    if (!asset?.htmlSource) return null;
    return { instanceId: target.id, name: target.name, html: asset.htmlSource };
  }, [activeScene.characters, assets, capabilitiesMap, selectedCharacter]);

  const beginnerTip = useMemo(() => {
    if (poseModeInstanceId) {
      return 'Pose Mode: Click any joint sphere and drag to rotate smoothly while bones stay locked together. Press Esc to exit.';
    }
    if (activeScene.characters.length === 0) {
      return 'Step 1: Load Host or Globe from the left Assets panel and click Add to Stage.';
    }
    if (selection.kind === 'none') {
      return 'Hover to inspect parts. Click to select object, or Double-Click a character to Pose Joints.';
    }
    if (selection.kind === 'character') {
      return 'Press Tab for smart motion predictions, F to focus zoom, or Double-Click to pose body joints.';
    }
    return 'Press Space to play or Tab for next-pose suggestions.';
  }, [activeScene.characters.length, poseModeInstanceId, selection.kind]);

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: 'mode-toggle',
        label: `Switch to ${studioMode === 'beginner' ? 'Advanced' : 'Beginner'} Mode`,
        category: 'Workspace',
        run: () => setStudioMode((m) => (m === 'beginner' ? 'advanced' : 'beginner')),
      },
      {
        id: 'tab-hud',
        label: 'Open Tab Animation Prediction HUD',
        category: 'Animation',
        shortcut: 'Tab',
        run: () => {
          setTabHudIndex(0);
          setTabHudOpen(true);
        },
      },
      {
        id: 'group-sel',
        label: 'Group Selected Objects',
        category: 'Hierarchy',
        shortcut: 'Ctrl+G',
        run: handleGroupSelection,
      },
      {
        id: 'focus-target',
        label: 'Focus Camera on Selection',
        category: 'Camera',
        shortcut: 'F',
        run: () => engineRef.current?.focusOnTarget(),
      },
      {
        id: 'frame-all',
        label: 'Frame All Stage Objects',
        category: 'Camera',
        shortcut: 'Shift+F',
        run: () => engineRef.current?.frameAll(),
      },
      {
        id: 'space-toggle',
        label: `Switch Transform Space to ${gizmoSpace === 'world' ? 'Local' : 'World'}`,
        category: 'Transform',
        shortcut: 'L',
        run: () => {
          const next = gizmoSpace === 'world' ? 'local' : 'world';
          setGizmoSpace(next);
          engineRef.current?.setGizmoSpace(next);
        },
      },
      {
        id: 'snap-toggle',
        label: `${snapSettings.enabled ? 'Disable' : 'Enable'} Precision Snapping`,
        category: 'Transform',
        run: () => {
          const next = { ...snapSettings, enabled: !snapSettings.enabled };
          setSnapSettings(next);
          engineRef.current?.setSnapSettings(next);
        },
      },
      {
        id: 'add-podium',
        label: 'Add Stage Podium Prop',
        category: 'Props',
        run: () => {
          const prop = createPropData('podium', 'Stage Podium', '#334155', 0, 0);
          commitSceneMutation('Add Stage Podium', (s) => ({ ...s, props: [...(s.props ?? []), prop] }));
          setSelection({ kind: 'prop', propId: prop.id });
        },
      },
      {
        id: 'import-file',
        label: 'Import Character / GLB / Audio File',
        category: 'Assets',
        run: () => setImportOpen(true),
      },
      {
        id: 'export-video',
        label: 'Export Cartoon Video',
        category: 'Render',
        run: () => setExportOpen(true),
      },
      {
        id: 'save-now',
        label: 'Save Project Now',
        category: 'File',
        shortcut: 'Ctrl+S',
        run: () => void handleSaveNow(),
      },
    ],
    [commitSceneMutation, gizmoSpace, handleGroupSelection, handleSaveNow, snapSettings, studioMode],
  );

  // Keyframe batch helpers for Timeline
  const mutateSingleKeyframe = (
    s: SceneData,
    target: KeyframeRef,
    fn: (kf: Vec3Keyframe) => Vec3Keyframe | null,
  ): SceneData => {
    if (target.kind === 'cam') {
      const next = s.camera.keyframes
        .map((k) => {
          if (k.id !== target.keyframeId) return k;
          const res = fn({
            id: k.id,
            time: k.time,
            value: k.pose.position,
            easing: k.easing,
          });
          return res ? { ...k, time: res.time, easing: res.easing } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => a.time - b.time);
      return { ...s, camera: { ...s.camera, keyframes: next } };
    }
    if (target.kind === 'group-pos' && target.groupId) {
      return {
        ...s,
        groups: (s.groups ?? []).map((g) =>
          g.id === target.groupId
            ? {
                ...g,
                positionKeyframes: g.positionKeyframes
                  .map((k) => (k.id === target.keyframeId ? fn(k) : k))
                  .filter((x): x is Vec3Keyframe => x !== null)
                  .sort((a, b) => a.time - b.time),
              }
            : g,
        ),
      };
    }
    return {
      ...s,
      characters: s.characters.map((c) => {
        if (c.id !== target.instanceId) return c;
        if (target.kind === 'pos') {
          return {
            ...c,
            positionKeyframes: c.positionKeyframes
              .map((k) => (k.id === target.keyframeId ? fn(k) : k))
              .filter((x): x is Vec3Keyframe => x !== null)
              .sort((a, b) => a.time - b.time),
          };
        }
        if (target.kind === 'rot') {
          return {
            ...c,
            rotationKeyframes: c.rotationKeyframes
              .map((k) => (k.id === target.keyframeId ? fn(k) : k))
              .filter((x): x is Vec3Keyframe => x !== null)
              .sort((a, b) => a.time - b.time),
          };
        }
        if (target.kind === 'scale') {
          return {
            ...c,
            scaleKeyframes: c.scaleKeyframes
              .map((k) => (k.id === target.keyframeId ? fn(k) : k))
              .filter((x): x is Vec3Keyframe => x !== null)
              .sort((a, b) => a.time - b.time),
          };
        }
        if (target.kind === 'facial') {
          return {
            ...c,
            facialKeyframes: (c.facialKeyframes ?? [])
              .map((k) => {
                if (k.id !== target.keyframeId) return k;
                const res = fn({
                  id: k.id,
                  time: k.time,
                  value: { x: 0, y: 0, z: 0 },
                  easing: k.easing,
                });
                return res ? { ...k, time: res.time, easing: res.easing } : null;
              })
              .filter((x): x is NonNullable<typeof x> => x !== null)
              .sort((a, b) => a.time - b.time),
          };
        }
        if (target.kind === 'node' && target.nodeId) {
          return {
            ...c,
            nodeTracks: (c.nodeTracks ?? []).map((nt) =>
              nt.nodeId === target.nodeId
                ? {
                    ...nt,
                    rotationKeyframes: nt.rotationKeyframes
                      .map((k) => (k.id === target.keyframeId ? fn(k) : k))
                      .filter((x): x is Vec3Keyframe => x !== null)
                      .sort((a, b) => a.time - b.time),
                  }
                : nt,
            ),
          };
        }
        return c;
      }),
    };
  };

  // Panel splitters
  const startHorizontalResize = (
    e: React.PointerEvent,
    startVal: number,
    min: number,
    max: number,
    invert: boolean,
    setter: (v: number) => void,
  ) => {
    e.preventDefault();
    const originX = e.clientX;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      setter(Math.max(min, Math.min(max, startVal + (invert ? -dx : dx))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startVerticalResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const originY = e.clientY;
    const startH = timelineHeight;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - originY;
      setTimelineHeight(Math.max(150, Math.min(440, startH - dy)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const poseModeCharName = poseModeInstanceId
    ? activeScene.characters.find((c) => c.id === poseModeInstanceId)?.name ?? null
    : null;

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-[#121316] text-[#e6e8ec] select-none"
      data-testid="studio-workspace"
      data-playing={isPlaying ? 'true' : 'false'}
      data-mode={studioMode}
    >
      <TopToolbar
        projectName={activeProject.name}
        onRenameProject={(name) => updateActiveProject((p) => ({ ...p, name }))}
        saveStatus={saveStatus}
        studioMode={studioMode}
        onChangeStudioMode={setStudioMode}
        workspaceLayout={workspaceLayout}
        onChangeWorkspaceLayout={handleChangeWorkspaceLayout}
        canUndo={commandManagerRef.current.canUndo()}
        canRedo={commandManagerRef.current.canRedo()}
        undoLabel={commandManagerRef.current.getUndoLabel()}
        redoLabel={commandManagerRef.current.getRedoLabel()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSaveNow={() => void handleSaveNow()}
        onOpenProjects={() => setProjectsOpen(true)}
        onOpenImport={() => setImportOpen(true)}
        onOpenExport={() => setExportOpen(true)}
        onOpenGuide={() => setGuideOpen(true)}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        viewMode={viewMode}
        onToggleViewMode={(mode) => {
          setViewMode(mode);
          engineRef.current?.setViewMode(mode);
        }}
      />

      {noticeMessage && (
        <div
          role="status"
          className="flex items-center justify-between border-b border-[#4a3222] bg-[#241b16] px-4 py-1.5 text-xs text-[#f2c4a2]"
        >
          <span>{noticeMessage}</span>
          <button
            type="button"
            onClick={() => setNoticeMessage(null)}
            className="underline hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Middle Workspace Row */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LeftAssetPanel
          width={leftWidth}
          collapseState={leftCollapse}
          onChangeCollapseState={setLeftCollapse}
          activeTab={leftTab}
          onChangeTab={setLeftTab}
          assets={assets}
          activeScene={activeScene}
          scenes={activeProject.scenes}
          selection={selection}
          multiSelectedIds={multiSelectedIds}
          isolatedIds={isolatedIds}
          rigNodesByInstance={rigNodesByInstance}
          onSelectTarget={(t, shift) => {
            if (shift && (t.kind === 'character' || t.kind === 'prop')) {
              const id = t.kind === 'character' ? t.instanceId : t.propId;
              setMultiSelectedIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              );
            } else {
              if (t.kind === 'character') setMultiSelectedIds([t.instanceId]);
              else if (t.kind === 'prop') setMultiSelectedIds([t.propId]);
              else setMultiSelectedIds([]);
            }
            setSelection(t);
            if (t.kind === 'body-part') setInspectorCharTab('rig');
          }}
          onOpenImport={() => setImportOpen(true)}
          onLoadWorkspaceSample={(url, label) => void handleLoadWorkspaceSample(url, label)}
          onAddCharacterToScene={handleAddCharacterToScene}
          onAddPropToScene={(kind: PropGeometryKind, label: string, color: string) => {
            const prop = createPropData(kind, label, color, 0, 0);
            commitSceneMutation(`Add Prop ${label}`, (s) => ({
              ...s,
              props: [...(s.props ?? []), prop],
            }));
            setSelection({ kind: 'prop', propId: prop.id });
          }}
          onAddGlbPropToScene={(asset) => {
            const prop: ScenePropData = {
              ...createPropData('glb', asset.name, '#ffffff', 0, 0),
              assetId: asset.id,
            };
            commitSceneMutation(`Add Prop ${asset.name}`, (s) => ({
              ...s,
              props: [...(s.props ?? []), prop],
            }));
            setSelection({ kind: 'prop', propId: prop.id });
          }}
          onAddLightToScene={(kind: SceneLightKind) => {
            const lt: SceneLightData = {
              id: createId('light'),
              name: `${kind.charAt(0).toUpperCase() + kind.slice(1)} Light`,
              kind,
              color: '#ffffff',
              intensity: 1.5,
              position: { x: 0, y: 5, z: 3 },
              target: { x: 0, y: 1, z: 0 },
              castShadow: false,
              distance: 20,
              angle: 0.55,
              visible: true,
            };
            commitSceneMutation(`Add ${lt.name}`, (s) => ({
              ...s,
              lights: [...(s.lights ?? []), lt],
            }));
            setSelection({ kind: 'light', lightId: lt.id });
          }}
          onAddCameraToScene={(projection) => {
            const cam: SceneCameraItem = {
              id: createId('cam'),
              name: `${projection === 'orthographic' ? 'Ortho' : 'Camera'} ${(activeScene.cameras?.length ?? 1) + 1}`,
              projection,
              orthoSize: 6,
              pose: { ...activeScene.camera.pose },
              keyframes: [],
            };
            commitSceneMutation(`Add ${cam.name}`, (s) => ({
              ...s,
              cameras: [...(s.cameras ?? []), cam],
              activeCameraId: cam.id,
              camera: { pose: cam.pose, keyframes: cam.keyframes },
            }));
            setSelection({ kind: 'camera', cameraId: cam.id });
          }}
          onSelectCameraItem={(cameraId) => {
            const cam = (activeScene.cameras ?? []).find((c) => c.id === cameraId);
            if (!cam) return;
            commitSceneMutation(`Select ${cam.name}`, (s) => ({
              ...s,
              activeCameraId: cam.id,
              camera: { pose: cam.pose, keyframes: cam.keyframes },
            }));
          }}
          onAddAudioToScene={(asset, role) => {
            const clip: AudioClipData = {
              id: createId('clip'),
              assetId: asset.id,
              name: asset.name,
              role,
              startTime: Number(currentTime.toFixed(2)),
              duration: asset.audioDuration ?? 4,
              trimStart: 0,
              volume: role === 'music' ? 0.45 : 0.9,
              fadeIn: 0.2,
              fadeOut: 0.3,
              muted: false,
            };
            commitSceneMutation(`Add ${asset.name} Audio`, (s) => ({
              ...s,
              audioClips: [...s.audioClips, clip],
            }));
            setSelection({ kind: 'audio-clip', clipId: clip.id });
          }}
          onRenameAsset={(assetId, name) => {
            setAssets((prev) =>
              prev.map((a) => {
                if (a.id !== assetId) return a;
                const updated = { ...a, name };
                void dbSaveAsset(updated);
                return updated;
              }),
            );
          }}
          onDeleteAsset={(assetId) => {
            const target = assets.find((a) => a.id === assetId);
            setConfirmState({
              title: 'Delete Asset',
              message: `Delete "${target?.name ?? 'this asset'}" from your library?`,
              onConfirm: () => {
                void dbDeleteAsset(assetId);
                audioEngineRef.current?.removeBuffer(assetId);
                glbBinaryCacheRef.current.delete(assetId);
                setAssets((prev) => prev.filter((a) => a.id !== assetId));
                setConfirmState(null);
              },
            });
          }}
          onToggleCharacterVisibility={(instanceId) =>
            commitSceneMutation('Toggle Character Visibility', (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId ? { ...c, visible: !c.visible } : c,
              ),
            }))
          }
          onToggleCharacterLock={(instanceId) =>
            commitSceneMutation('Toggle Character Lock', (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId
                  ? {
                      ...c,
                      lockedProperties: {
                        ...c.lockedProperties,
                        transform: !c.lockedProperties?.transform,
                      },
                    }
                  : c,
              ),
            }))
          }
          onToggleNodeLock={(instanceId, nodeId) =>
            commitSceneMutation('Toggle Node Lock', (s) => ({
              ...s,
              characters: s.characters.map((c) => {
                if (c.id !== instanceId) return c;
                const cur = c.lockedNodes ?? [];
                return {
                  ...c,
                  lockedNodes: cur.includes(nodeId)
                    ? cur.filter((x) => x !== nodeId)
                    : [...cur, nodeId],
                };
              }),
            }))
          }
          onToggleNodeVisibility={(instanceId, nodeId) =>
            commitSceneMutation('Toggle Node Visibility', (s) => ({
              ...s,
              characters: s.characters.map((c) => {
                if (c.id !== instanceId) return c;
                const cur = c.hiddenNodes ?? [];
                return {
                  ...c,
                  hiddenNodes: cur.includes(nodeId)
                    ? cur.filter((x) => x !== nodeId)
                    : [...cur, nodeId],
                };
              }),
            }))
          }
          onDuplicateCharacter={handleDuplicateCharacter}
          onRemoveCharacterFromScene={handleRemoveCharacter}
          onTogglePropVisibility={(propId) =>
            commitSceneMutation('Toggle Prop Visibility', (s) => ({
              ...s,
              props: (s.props ?? []).map((p) => (p.id === propId ? { ...p, visible: !p.visible } : p)),
            }))
          }
          onRemovePropFromScene={(propId) => {
            commitSceneMutation('Remove Prop', (s) => ({
              ...s,
              props: (s.props ?? []).filter((p) => p.id !== propId),
            }));
            setSelection({ kind: 'none' });
          }}
          onRemoveLightFromScene={(lightId) => {
            commitSceneMutation('Remove Light', (s) => ({
              ...s,
              lights: (s.lights ?? []).filter((l) => l.id !== lightId),
            }));
            setSelection({ kind: 'none' });
          }}
          onGroupSelection={handleGroupSelection}
          onUngroupGroup={handleUngroupGroup}
          onToggleGroupVisibility={(groupId) =>
            commitSceneMutation('Toggle Group Visibility', (s) => ({
              ...s,
              groups: (s.groups ?? []).map((g) =>
                g.id === groupId ? { ...g, visible: !g.visible } : g,
              ),
            }))
          }
          onToggleGroupLock={(groupId) =>
            commitSceneMutation('Toggle Group Lock', (s) => ({
              ...s,
              groups: (s.groups ?? []).map((g) =>
                g.id === groupId ? { ...g, locked: !g.locked } : g,
              ),
            }))
          }
          onToggleIsolate={handleToggleIsolate}
          onSwitchScene={(sceneId) => {
            const thumb = engineRef.current?.captureThumbnailDataUrl();
            if (thumb) {
              updateActiveScene((s) => ({ ...s, thumbnailDataUrl: thumb }), false);
            }
            handleStop();
            setPoseModeInstanceId(null);
            engineRef.current?.setPoseMode(null);
            setSelection({ kind: 'none' });
            updateActiveProject((p) => ({ ...p, activeSceneId: sceneId }), false);
          }}
          onCreateScene={(templateId: SceneTemplateId = 'blank-stage') => {
            const newSc = buildSceneFromTemplate(
              templateId,
              `Scene ${String(activeProject.scenes.length + 1).padStart(2, '0')}`,
            );
            updateActiveProject((p) => ({
              ...p,
              scenes: [...p.scenes, newSc],
              activeSceneId: newSc.id,
            }));
            setSelection({ kind: 'none' });
            handleSeek(0);
          }}
          onDuplicateScene={(sceneId) => {
            const src = activeProject.scenes.find((s) => s.id === sceneId);
            if (!src) return;
            const copy: SceneData = {
              ...cloneScene(src),
              id: createId('scene'),
              name: `${src.name} Copy`,
            };
            updateActiveProject((p) => ({
              ...p,
              scenes: [...p.scenes, copy],
              activeSceneId: copy.id,
            }));
          }}
          onDeleteScene={(sceneId) => {
            if (activeProject.scenes.length <= 1) return;
            const sc = activeProject.scenes.find((s) => s.id === sceneId);
            setConfirmState({
              title: 'Delete Scene',
              message: `Delete "${sc?.name ?? 'this scene'}" and its keyframes?`,
              onConfirm: () => {
                updateActiveProject((p) => {
                  const remaining = p.scenes.filter((s) => s.id !== sceneId);
                  return {
                    ...p,
                    scenes: remaining,
                    activeSceneId:
                      p.activeSceneId === sceneId ? remaining[0].id : p.activeSceneId,
                  };
                });
                setConfirmState(null);
              },
            });
          }}
          onReorderScene={(sceneId, dir) => {
            updateActiveProject((p) => {
              const idx = p.scenes.findIndex((s) => s.id === sceneId);
              const nextIdx = idx + dir;
              if (idx < 0 || nextIdx < 0 || nextIdx >= p.scenes.length) return p;
              const copy = [...p.scenes];
              const [moved] = copy.splice(idx, 1);
              copy.splice(nextIdx, 0, moved);
              return { ...p, scenes: copy };
            });
          }}
        />

        {/* Left Splitter (only when expanded) */}
        {leftCollapse === 'expanded' && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => startHorizontalResize(e, leftWidth, 210, 420, false, setLeftWidth)}
            className="w-1 shrink-0 cursor-col-resize bg-[#22252c] hover:bg-[#e8702a]"
          />
        )}

        <CenterViewport
          mountRef={viewportMountRef}
          studioMode={studioMode}
          viewMode={viewMode}
          gizmoMode={gizmoMode}
          gizmoSpace={gizmoSpace}
          axisConstraint={axisConstraint}
          snapSettings={snapSettings}
          selectionFilter={selectionFilter}
          showRigOverlay={showRigOverlay}
          multiSelectedCount={multiSelectedIds.length}
          hoverInfo={hoverInfo}
          poseModeInstanceId={poseModeInstanceId}
          poseModeCharName={poseModeCharName}
          editorProjection={editorProjection}
          editorCameraPreset={editorCameraPreset}
          onChangeGizmoMode={(m) => {
            setGizmoMode(m);
            engineRef.current?.setGizmoMode(m);
          }}
          onChangeGizmoSpace={(sp) => {
            setGizmoSpace(sp);
            engineRef.current?.setGizmoSpace(sp);
          }}
          onChangeAxisConstraint={(ax) => {
            setAxisConstraint(ax);
            engineRef.current?.setAxisConstraint(ax);
          }}
          onToggleSnap={() => {
            const next = { ...snapSettings, enabled: !snapSettings.enabled };
            setSnapSettings(next);
            engineRef.current?.setSnapSettings(next);
          }}
          onChangeSelectionFilter={(f) => {
            setSelectionFilter(f);
            engineRef.current?.setSelectionFilter(f);
          }}
          onToggleRigOverlay={() => {
            const next = !showRigOverlay;
            setShowRigOverlay(next);
            engineRef.current?.setShowRigOverlay(next);
          }}
          onAlignMultiSelection={handleAlignMultiSelection}
          onGroupSelection={handleGroupSelection}
          onResetEditorCamera={() => {
            setEditorCameraPreset('free');
            engineRef.current?.resetEditorCamera();
          }}
          onToggleEditorProjection={() => {
            const next = editorProjection === 'perspective' ? 'orthographic' : 'perspective';
            setEditorProjection(next);
            engineRef.current?.setEditorProjection(next);
          }}
          onChangeEditorCameraPreset={(preset) => {
            setEditorCameraPreset(preset);
            engineRef.current?.setEditorCameraPreset(preset);
          }}
          onFocusTarget={() => engineRef.current?.focusOnTarget()}
          onFrameAll={() => engineRef.current?.frameAll()}
          onExitPoseMode={handleExitPoseMode}
          onToggleTabHud={() => {
            setTabHudIndex(0);
            setTabPreviewActive(false);
            setTabHudOpen((v) => !v);
          }}
          tabHud={{
            open: tabHudOpen,
            predictions: tabPredictions,
            activeIndex: tabHudIndex,
            previewActive: tabPreviewActive,
            onSelectIndex: (idx) => {
              setTabHudIndex(idx);
            },
            onTogglePreview: () => setTabPreviewActive((v) => !v),
            onApply: handleApplyTabPrediction,
            onDismiss: () => {
              setTabPreviewActive(false);
              setTabHudOpen(false);
            },
          }}
          viewportContextMenu={viewportContextMenu}
          onCloseContextMenu={() => setViewportContextMenu(null)}
          sceneName={activeScene.name}
          characterCount={activeScene.characters.length}
          propCount={activeScene.props?.length ?? 0}
          beginnerTip={beginnerTip}
          isolatedIframeHtml={isolatedIframeData}
          onRegisterIframe={(instId, el) => {
            const adp = engineRef.current?.getAdapter(instId);
            if (adp instanceof HtmlIframeAdapter) {
              adp.attachIframe(el);
            }
          }}
        />

        {/* Right Splitter (only when expanded) */}
        {rightCollapse === 'expanded' && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => startHorizontalResize(e, rightWidth, 250, 460, true, setRightWidth)}
            className="w-1 shrink-0 cursor-col-resize bg-[#22252c] hover:bg-[#e8702a]"
          />
        )}

        <RightInspector
          width={rightWidth}
          collapseState={rightCollapse}
          onChangeCollapseState={setRightCollapse}
          activeCharTab={inspectorCharTab}
          onChangeCharTab={setInspectorCharTab}
          studioMode={studioMode}
          activeScene={activeScene}
          currentTime={currentTime}
          selection={selection}
          selectedCharacter={selectedCharacter}
          selectedCharacterAsset={selectedCharacterAsset}
          selectedCharacterCaps={selectedCharacterCaps}
          evaluatedTransform={
            selectedCharacter
              ? evalSnapshot.characters.get(selectedCharacter.id)?.transform ?? selectedCharacter.transform
              : null
          }
          evaluatedNodeRotations={
            selectedCharacter ? evalSnapshot.characters.get(selectedCharacter.id)?.nodeRotations ?? {} : {}
          }
          evaluatedFacial={
            selectedCharacter ? evalSnapshot.characters.get(selectedCharacter.id)?.facial ?? null : null
          }
          evaluatedCameraPose={evalSnapshot.camera}
          selectedProp={selectedProp}
          evaluatedPropTransform={
            selectedProp ? evalSnapshot.props.get(selectedProp.id)?.transform ?? selectedProp.transform : null
          }
          selectedGroup={selectedGroup}
          evaluatedGroupTransform={
            selectedGroup
              ? evalSnapshot.groups.get(selectedGroup.id)?.transform ?? selectedGroup.transform
              : null
          }
          selectedLight={selectedLight}
          evaluatedLightIntensity={
            selectedLight ? evalSnapshot.lights.get(selectedLight.id)?.intensity ?? selectedLight.intensity : null
          }
          selectedAudioClip={selectedAudioClip}
          selectedAudioAsset={selectedAudioAsset}
          selectedActionClip={selectedActionClip}
          rigNodesByInstance={rigNodesByInstance}
          onSelectTarget={(t) => {
            setSelection(t);
            if (t.kind === 'body-part') setInspectorCharTab('rig');
          }}
          onEnterPoseMode={handleEnterPoseMode}
          onUpdateCharacterMeta={(instanceId, patch) =>
            commitSceneMutation(
              'Update Character Property',
              (s) => ({
                ...s,
                characters: s.characters.map((c) => (c.id === instanceId ? { ...c, ...patch } : c)),
              }),
              `meta:${instanceId}`,
            )
          }
          onUpdateCharacterTransform={(instanceId, transform) =>
            commitSceneMutation(
              'Update Character Transform',
              (s) => ({
                ...s,
                characters: s.characters.map((c) =>
                  c.id === instanceId ? { ...c, transform: cloneTransform(transform) } : c,
                ),
              }),
              `xform:${instanceId}`,
            )
          }
          onKeyCharacterTransform={handleKeyCharacterTransform}
          onUpdateNodeRotation={(instanceId, nodeId, nodeName, rot) => {
            commitSceneMutation(
              `Pose ${nodeName}`,
              (s) => ({
                ...s,
                characters: s.characters.map((c) => {
                  if (c.id !== instanceId) return c;
                  const tracks = [...(c.nodeTracks ?? [])];
                  const idx = tracks.findIndex((nt) => nt.nodeId === nodeId);
                  const existing =
                    idx >= 0 ? tracks[idx] : { nodeId, nodeName, rotationKeyframes: [], positionKeyframes: [] };
                  const updated = {
                    ...existing,
                    rotationKeyframes: upsertVec3Key(existing.rotationKeyframes, currentTime, rot, 'smooth'),
                  };
                  if (idx >= 0) tracks[idx] = updated;
                  else tracks.push(updated);
                  return { ...c, nodeTracks: tracks };
                }),
              }),
              `node:${instanceId}:${nodeId}`,
            );
          }}
          onKeyNodeRotation={(instanceId, nodeId, nodeName, rot, easing) => {
            commitSceneMutation(`Key ${nodeName}`, (s) => ({
              ...s,
              characters: s.characters.map((c) => {
                if (c.id !== instanceId) return c;
                const tracks = [...(c.nodeTracks ?? [])];
                const idx = tracks.findIndex((nt) => nt.nodeId === nodeId);
                const existing =
                  idx >= 0 ? tracks[idx] : { nodeId, nodeName, rotationKeyframes: [], positionKeyframes: [] };
                const updated = {
                  ...existing,
                  rotationKeyframes: upsertVec3Key(existing.rotationKeyframes, currentTime, rot, easing),
                };
                if (idx >= 0) tracks[idx] = updated;
                else tracks.push(updated);
                return { ...c, nodeTracks: tracks };
              }),
            }));
          }}
          onResetNodeRotation={(instanceId, nodeId) => {
            commitSceneMutation('Reset Joint Pose', (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId
                  ? { ...c, nodeTracks: (c.nodeTracks ?? []).filter((nt) => nt.nodeId !== nodeId) }
                  : c,
              ),
            }));
          }}
          onToggleNodeLock={(instanceId, nodeId) =>
            commitSceneMutation('Toggle Node Lock', (s) => ({
              ...s,
              characters: s.characters.map((c) => {
                if (c.id !== instanceId) return c;
                const cur = c.lockedNodes ?? [];
                return {
                  ...c,
                  lockedNodes: cur.includes(nodeId)
                    ? cur.filter((x) => x !== nodeId)
                    : [...cur, nodeId],
                };
              }),
            }))
          }
          onToggleNodeVisibility={(instanceId, nodeId) =>
            commitSceneMutation('Toggle Node Visibility', (s) => ({
              ...s,
              characters: s.characters.map((c) => {
                if (c.id !== instanceId) return c;
                const cur = c.hiddenNodes ?? [];
                return {
                  ...c,
                  hiddenNodes: cur.includes(nodeId)
                    ? cur.filter((x) => x !== nodeId)
                    : [...cur, nodeId],
                };
              }),
            }))
          }
          onKeyFacialState={(instanceId, state) => {
            const snapT = Number(currentTime.toFixed(2));
            commitSceneMutation(
              'Key Facial Expression',
              (s) => ({
                ...s,
                characters: s.characters.map((c) => {
                  if (c.id !== instanceId) return c;
                  const filtered = (c.facialKeyframes ?? []).filter((k) => Math.abs(k.time - snapT) > 0.04);
                  return {
                    ...c,
                    facialState: state,
                    facialKeyframes: [
                      ...filtered,
                      {
                        id: createId('fkf'),
                        time: snapT,
                        state: { ...state, customMorphs: { ...state.customMorphs } },
                        easing: 'smooth' as const,
                      },
                    ].sort((a, b) => a.time - b.time),
                  };
                }),
              }),
              `facial:${instanceId}`,
            );
          }}
          onPreviewCharacterAction={handlePreviewCharacterAction}
          onSetCharacterMood={(instanceId, mood) =>
            commitSceneMutation(`Set Mood: ${mood}`, (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId ? { ...c, currentMood: mood } : c,
              ),
            }))
          }
          onAddActionClip={(instanceId, actionId, speed) => {
            const caps = capabilitiesMap[instanceId];
            const desc = caps?.actions.find((a) => a.id === actionId);
            const clip: ActionClip = {
              id: createId('act'),
              actionId,
              label: desc?.label ?? actionId,
              kind: desc?.kind === 'loop' ? 'loop' : 'gesture',
              startTime: Number(currentTime.toFixed(2)),
              duration: desc?.defaultDurationSec ?? 1.5,
              speed,
              blendIn: 0.2,
              blendOut: 0.2,
              weight: 1,
            };
            commitSceneMutation(`Add Action ${clip.label}`, (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId ? { ...c, actionClips: [...c.actionClips, clip] } : c,
              ),
            }));
            setSelection({ kind: 'action-clip', instanceId, clipId: clip.id });
          }}
          onAddPresetClip={(instanceId, presetId, opts) => {
            const preset = MOTION_PRESETS.find((m) => m.id === presetId);
            const clip: ActionClip = {
              id: createId('act'),
              actionId: presetId,
              label: preset?.label ?? presetId,
              kind: 'preset',
              startTime: opts.startTime,
              duration: opts.duration,
              speed: opts.speed,
              blendIn: opts.blendIn,
              blendOut: opts.blendIn,
              weight: 1,
            };
            commitSceneMutation(`Add Preset ${clip.label}`, (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId ? { ...c, actionClips: [...c.actionClips, clip] } : c,
              ),
            }));
            setSelection({ kind: 'action-clip', instanceId, clipId: clip.id });
          }}
          onExecuteSuggestion={handleExecuteSuggestion}
          onToggleMotionPath={(instanceId, enabled) =>
            commitSceneMutation(`${enabled ? 'Enable' : 'Disable'} Motion Path`, (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId ? { ...c, motionPath: { ...c.motionPath, enabled } } : c,
              ),
            }))
          }
          onUpdateMotionPathProps={(instanceId, patch: Partial<MotionPathData>) =>
            commitSceneMutation(
              'Update Motion Path',
              (s) => ({
                ...s,
                characters: s.characters.map((c) =>
                  c.id === instanceId ? { ...c, motionPath: { ...c.motionPath, ...patch } } : c,
                ),
              }),
              `mp:${instanceId}`,
            )
          }
          onAddWaypoint={(instanceId) => {
            const ch = activeScene.characters.find((c) => c.id === instanceId);
            if (!ch) return;
            const last = ch.motionPath.points[ch.motionPath.points.length - 1];
            const nextPt: MotionPathPoint = {
              id: createId('pt'),
              position: {
                x: (last?.position.x ?? 0) + 1.8,
                y: last?.position.y ?? 0,
                z: (last?.position.z ?? 0) + 1.2,
              },
              handleIn: { x: -0.6, y: 0, z: -0.4 },
              handleOut: { x: 0.6, y: 0, z: 0.4 },
              smooth: true,
            };
            commitSceneMutation('Add Path Waypoint', (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId
                  ? { ...c, motionPath: { ...c.motionPath, points: [...c.motionPath.points, nextPt] } }
                  : c,
              ),
            }));
            setSelection({ kind: 'waypoint', instanceId, pointId: nextPt.id });
          }}
          onUpdateWaypoint={(instanceId, pointId, patch) =>
            commitSceneMutation(
              'Edit Waypoint',
              (s) => ({
                ...s,
                characters: s.characters.map((c) =>
                  c.id === instanceId
                    ? {
                        ...c,
                        motionPath: {
                          ...c.motionPath,
                          points: c.motionPath.points.map((p) => (p.id === pointId ? { ...p, ...patch } : p)),
                        },
                      }
                    : c,
                ),
              }),
              `wp:${instanceId}:${pointId}`,
            )
          }
          onDeleteWaypoint={(instanceId, pointId) =>
            commitSceneMutation('Delete Waypoint', (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId
                  ? {
                      ...c,
                      motionPath: {
                        ...c.motionPath,
                        points: c.motionPath.points.filter((p) => p.id !== pointId),
                      },
                    }
                  : c,
              ),
            }))
          }
          onOpenDialogueDialog={(instanceId) => setDialogueTargetCharId(instanceId)}
          onUpdateProp={(propId, patch) =>
            commitSceneMutation(
              'Update Prop',
              (s) => ({
                ...s,
                props: (s.props ?? []).map((p) => (p.id === propId ? { ...p, ...patch } : p)),
              }),
              `prop:${propId}`,
            )
          }
          onKeyPropTransform={(propId, easing) => {
            const prop = (activeScene.props ?? []).find((p) => p.id === propId);
            if (!prop) return;
            const t = evalSnapshot.props.get(propId)?.transform ?? prop.transform;
            commitSceneMutation(`Key Prop ${prop.name}`, (s) => ({
              ...s,
              props: (s.props ?? []).map((p) =>
                p.id === propId
                  ? {
                      ...p,
                      positionKeyframes: upsertVec3Key(p.positionKeyframes, currentTime, t.position, easing),
                      rotationKeyframes: upsertVec3Key(p.rotationKeyframes, currentTime, t.rotation, easing),
                      scaleKeyframes: upsertVec3Key(p.scaleKeyframes, currentTime, t.scale, easing),
                    }
                  : p,
              ),
            }));
          }}
          onUpdateGroup={(groupId, patch) =>
            commitSceneMutation(
              'Update Group',
              (s) => ({
                ...s,
                groups: (s.groups ?? []).map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
              }),
              `grp:${groupId}`,
            )
          }
          onKeyGroupTransform={(groupId, easing) => {
            const grp = (activeScene.groups ?? []).find((g) => g.id === groupId);
            if (!grp) return;
            const t = evalSnapshot.groups.get(groupId)?.transform ?? grp.transform;
            commitSceneMutation(`Key Group ${grp.name}`, (s) => ({
              ...s,
              groups: (s.groups ?? []).map((g) =>
                g.id === groupId
                  ? {
                      ...g,
                      positionKeyframes: upsertVec3Key(g.positionKeyframes, currentTime, t.position, easing),
                      rotationKeyframes: upsertVec3Key(g.rotationKeyframes, currentTime, t.rotation, easing),
                      scaleKeyframes: upsertVec3Key(g.scaleKeyframes, currentTime, t.scale, easing),
                    }
                  : g,
              ),
            }));
          }}
          onUngroupGroup={handleUngroupGroup}
          onUpdateLight={(lightId, patch) =>
            commitSceneMutation(
              'Update Light',
              (s) => ({
                ...s,
                lights: (s.lights ?? []).map((l) => (l.id === lightId ? { ...l, ...patch } : l)),
              }),
              `lt:${lightId}`,
            )
          }
          onKeyLightIntensity={(lightId) => {
            const lt = (activeScene.lights ?? []).find((l) => l.id === lightId);
            if (!lt) return;
            const snapT = Number(currentTime.toFixed(2));
            const curVal = evalSnapshot.lights.get(lightId)?.intensity ?? lt.intensity;
            commitSceneMutation(`Key ${lt.name} Intensity`, (s) => ({
              ...s,
              lights: (s.lights ?? []).map((l) =>
                l.id === lightId
                  ? {
                      ...l,
                      intensityKeyframes: [
                        ...(l.intensityKeyframes ?? []).filter((k) => Math.abs(k.time - snapT) > 0.04),
                        { id: createId('lkf'), time: snapT, value: curVal, easing: 'smooth' as const },
                      ].sort((a, b) => a.time - b.time),
                    }
                  : l,
              ),
            }));
          }}
          onSelectCameraItem={(cameraId) => {
            const cam = (activeScene.cameras ?? []).find((c) => c.id === cameraId);
            if (!cam) return;
            commitSceneMutation(`Select ${cam.name}`, (s) => ({
              ...s,
              activeCameraId: cam.id,
              camera: { pose: cam.pose, keyframes: cam.keyframes },
            }));
          }}
          onAddCameraToScene={(projection) => {
            const cam: SceneCameraItem = {
              id: createId('cam'),
              name: `${projection === 'orthographic' ? 'Ortho' : 'Camera'} ${(activeScene.cameras?.length ?? 1) + 1}`,
              projection,
              orthoSize: 6,
              pose: { ...activeScene.camera.pose },
              keyframes: [],
            };
            commitSceneMutation(`Add ${cam.name}`, (s) => ({
              ...s,
              cameras: [...(s.cameras ?? []), cam],
              activeCameraId: cam.id,
              camera: { pose: cam.pose, keyframes: cam.keyframes },
            }));
          }}
          onUpdateCameraItem={(cameraId, patch) =>
            commitSceneMutation(
              'Update Camera Settings',
              (s) => ({
                ...s,
                cameras: (s.cameras ?? []).map((c) => (c.id === cameraId ? { ...c, ...patch } : c)),
              }),
              `cam:${cameraId}`,
            )
          }
          onAddCameraSwitch={(cameraId) => {
            const snapT = Number(currentTime.toFixed(2));
            commitSceneMutation(`Add Camera Cut @ ${snapT}s`, (s) => ({
              ...s,
              cameraSwitches: [
                ...(s.cameraSwitches ?? []).filter((sw) => Math.abs(sw.time - snapT) > 0.04),
                { id: createId('csw'), time: snapT, cameraId },
              ].sort((a, b) => a.time - b.time),
            }));
          }}
          onUpdateCameraPose={(pose) =>
            commitSceneMutation(
              'Update Scene Camera Pose',
              (s) => ({
                ...s,
                camera: { ...s.camera, pose },
                cameras: (s.cameras ?? []).map((cam, idx) =>
                  cam.id === s.activeCameraId || (!s.activeCameraId && idx === 0) ? { ...cam, pose } : cam,
                ),
              }),
              'campose',
            )
          }
          onKeyCamera={handleKeyCamera}
          onCaptureEditorCamera={() => {
            const engine = engineRef.current;
            if (!engine) return;
            const pose: CameraPose = {
              position: {
                x: Number(engine.editorCamera.position.x.toFixed(2)),
                y: Number(engine.editorCamera.position.y.toFixed(2)),
                z: Number(engine.editorCamera.position.z.toFixed(2)),
              },
              target: {
                x: Number(engine.orbitControls.target.x.toFixed(2)),
                y: Number(engine.orbitControls.target.y.toFixed(2)),
                z: Number(engine.orbitControls.target.z.toFixed(2)),
              },
              fov: Math.round(engine.editorCamera.fov),
            };
            commitSceneMutation('Match Camera to Editor View', (s) => ({
              ...s,
              camera: { ...s.camera, pose },
              cameras: (s.cameras ?? []).map((cam, idx) =>
                cam.id === s.activeCameraId || (!s.activeCameraId && idx === 0) ? { ...cam, pose } : cam,
              ),
            }));
          }}
          onApplyEnvironmentPreset={(presetId: EnvironmentPresetId) => {
            const env = ENVIRONMENT_PRESETS.find((e) => e.id === presetId);
            if (!env) return;
            commitSceneMutation(`Apply Environment: ${env.label}`, (s) => ({
              ...s,
              environmentPreset: presetId,
              backgroundColor: env.backgroundColor,
              lights: JSON.parse(JSON.stringify(env.lights)),
            }));
          }}
          onUpdateAudioClip={(clipId, patch) =>
            commitSceneMutation(
              'Update Audio Clip',
              (s) => ({
                ...s,
                audioClips: s.audioClips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
              }),
              `aud:${clipId}`,
            )
          }
          onPreviewAudioClip={(clip) => {
            const char = activeScene.characters.find((c) => c.id === clip.characterInstanceId);
            audioEngineRef.current?.previewClip(clip, char?.audioProfile);
          }}
          onDeleteAudioClip={(clipId) => {
            commitSceneMutation('Delete Audio Clip', (s) => ({
              ...s,
              audioClips: s.audioClips.filter((c) => c.id !== clipId),
            }));
            setSelection({ kind: 'none' });
          }}
          onUpdateActionClip={(instanceId, clipId, patch) =>
            commitSceneMutation(
              'Update Action Clip',
              (s) => ({
                ...s,
                characters: s.characters.map((c) =>
                  c.id === instanceId
                    ? { ...c, actionClips: c.actionClips.map((a) => (a.id === clipId ? { ...a, ...patch } : a)) }
                    : c,
                ),
              }),
              `act:${clipId}`,
            )
          }
          onDeleteActionClip={(instanceId, clipId) => {
            commitSceneMutation('Delete Action Clip', (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId ? { ...c, actionClips: c.actionClips.filter((a) => a.id !== clipId) } : c,
              ),
            }));
            setSelection({ kind: 'none' });
          }}
          onUpdateSceneProps={(patch) =>
            commitSceneMutation(
              'Update Scene Settings',
              (s) => ({ ...s, ...patch }),
              'sceneprops',
            )
          }
        />
      </div>

      {/* Bottom Timeline Splitter */}
      {timelineCollapse === 'expanded' && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={startVerticalResize}
          className="h-1 shrink-0 cursor-row-resize bg-[#22252c] hover:bg-[#e8702a]"
        />
      )}

      <BottomTimeline
        height={timelineHeight}
        collapseState={timelineCollapse}
        onChangeCollapseState={setTimelineCollapse}
        studioMode={studioMode}
        scene={activeScene}
        assets={assets}
        currentTime={currentTime}
        fps={activeProject.fps}
        playbackSpeed={playbackSpeed}
        loopPlayback={loopPlayback}
        autoKey={autoKey}
        isPlaying={isPlaying}
        previewFullStory={previewFullStory}
        selection={selection}
        onSeek={handleSeek}
        onTogglePlay={handleTogglePlay}
        onStop={handleStop}
        onRestart={() => handleSeek(0)}
        onStepFrame={(dir) => handleSeek(currentTime + dir / Math.max(1, activeProject.fps))}
        onJumpKeyframe={(dir) => {
          const allTimes: number[] = activeScene.camera.keyframes.map((k) => k.time);
          for (const ch of activeScene.characters) {
            ch.positionKeyframes.forEach((k) => allTimes.push(k.time));
            ch.rotationKeyframes.forEach((k) => allTimes.push(k.time));
            (ch.nodeTracks ?? []).forEach((nt) => nt.rotationKeyframes.forEach((nk) => allTimes.push(nk.time)));
          }
          for (const grp of activeScene.groups ?? []) {
            grp.positionKeyframes.forEach((k) => allTimes.push(k.time));
          }
          const hit = findAdjacentKeyframeTime(allTimes, currentTime, dir);
          if (hit !== null) handleSeek(hit);
        }}
        onChangeFps={(fps) => updateActiveProject((p) => ({ ...p, fps }))}
        onChangePlaybackSpeed={setPlaybackSpeed}
        onToggleLoop={() => setLoopPlayback((v) => !v)}
        onToggleAutoKey={() => setAutoKey((v) => !v)}
        onToggleWorkArea={() =>
          commitSceneMutation('Toggle Work Area', (s) => ({
            ...s,
            workArea: {
              enabled: !(s.workArea?.enabled ?? false),
              start: s.workArea?.start ?? 0,
              end: s.workArea?.end ?? s.duration,
            },
          }))
        }
        onTogglePreviewScope={setPreviewFullStory}
        onSelectTarget={setSelection}
        onMoveAudioClip={(clipId, startTime, duration) =>
          commitSceneMutation(
            'Move Audio Clip',
            (s) => ({
              ...s,
              audioClips: s.audioClips.map((c) =>
                c.id === clipId ? { ...c, startTime, duration: duration ?? c.duration } : c,
              ),
            }),
            `moveaud:${clipId}`,
          )
        }
        onDeleteAudioClip={(clipId) =>
          commitSceneMutation('Delete Audio Clip', (s) => ({
            ...s,
            audioClips: s.audioClips.filter((c) => c.id !== clipId),
          }))
        }
        onMoveActionClip={(instanceId, clipId, startTime, duration) =>
          commitSceneMutation(
            'Move Action Clip',
            (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId
                  ? {
                      ...c,
                      actionClips: c.actionClips.map((a) =>
                        a.id === clipId ? { ...a, startTime, duration: duration ?? a.duration } : a,
                      ),
                    }
                  : c,
              ),
            }),
            `moveact:${clipId}`,
          )
        }
        onDeleteActionClip={(instanceId, clipId) =>
          commitSceneMutation('Delete Action Clip', (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === instanceId ? { ...c, actionClips: c.actionClips.filter((a) => a.id !== clipId) } : c,
            ),
          }))
        }
        onDeleteKeyframe={(target) =>
          commitSceneMutation('Delete Keyframe', (s) => mutateSingleKeyframe(s, target, () => null))
        }
        onMoveKeyframe={(target, nextTime) =>
          commitSceneMutation(
            'Move Keyframe',
            (s) => mutateSingleKeyframe(s, target, (k) => ({ ...k, time: nextTime })),
            `movekf:${target.keyframeId}`,
          )
        }
        onSetKeyframeEasing={(targets, easing) =>
          commitSceneMutation(`Set Easing (${easing})`, (s) => {
            let next = s;
            for (const t of targets) {
              next = mutateSingleKeyframe(next, t, (k) => ({ ...k, easing }));
            }
            return next;
          })
        }
        onDuplicateOrPasteKeys={(targets, targetTime) =>
          commitSceneMutation('Duplicate/Paste Keys', (s) => {
            let next = s;
            const snapT = Number(targetTime.toFixed(2));
            for (const target of targets) {
              if (target.kind === 'pos' || target.kind === 'rot' || target.kind === 'scale') {
                next = {
                  ...next,
                  characters: next.characters.map((c) => {
                    if (c.id !== target.instanceId) return c;
                    const arr =
                      target.kind === 'pos'
                        ? c.positionKeyframes
                        : target.kind === 'rot'
                          ? c.rotationKeyframes
                          : c.scaleKeyframes;
                    const src = arr.find((k) => k.id === target.keyframeId);
                    if (!src) return c;
                    const updated = upsertVec3Key(arr, snapT, src.value, src.easing);
                    if (target.kind === 'pos') return { ...c, positionKeyframes: updated };
                    if (target.kind === 'rot') return { ...c, rotationKeyframes: updated };
                    return { ...c, scaleKeyframes: updated };
                  }),
                };
              } else if (target.kind === 'node' && target.nodeId) {
                next = {
                  ...next,
                  characters: next.characters.map((c) => {
                    if (c.id !== target.instanceId) return c;
                    return {
                      ...c,
                      nodeTracks: (c.nodeTracks ?? []).map((nt) => {
                        if (nt.nodeId !== target.nodeId) return nt;
                        const src = nt.rotationKeyframes.find((k) => k.id === target.keyframeId);
                        if (!src) return nt;
                        return {
                          ...nt,
                          rotationKeyframes: upsertVec3Key(nt.rotationKeyframes, snapT, src.value, src.easing),
                        };
                      }),
                    };
                  }),
                };
              }
            }
            return next;
          })
        }
        onBatchKeyframes={(op) => {
          const targetId = selectedCharacter?.id ?? activeScene.characters[0]?.id;
          if (!targetId) return;
          const emptySet = new Set<string>();
          commitSceneMutation(`Batch Keys (${op})`, (s) => ({
            ...s,
            characters: s.characters.map((c) => {
              if (c.id !== targetId) return c;
              if (op === 'shift-left' || op === 'shift-right') {
                const d = op === 'shift-left' ? -0.5 : 0.5;
                return {
                  ...c,
                  positionKeyframes: shiftKeyframes(c.positionKeyframes, emptySet, d, s.duration),
                  rotationKeyframes: shiftKeyframes(c.rotationKeyframes, emptySet, d, s.duration),
                };
              }
              if (op === 'stretch-double' || op === 'stretch-half') {
                const f = op === 'stretch-double' ? 1.5 : 0.75;
                return {
                  ...c,
                  positionKeyframes: stretchKeyframes(c.positionKeyframes, emptySet, f),
                  rotationKeyframes: stretchKeyframes(c.rotationKeyframes, emptySet, f),
                };
              }
              if (op === 'reverse') {
                return {
                  ...c,
                  positionKeyframes: reverseKeyframes(c.positionKeyframes, emptySet),
                  rotationKeyframes: reverseKeyframes(c.rotationKeyframes, emptySet),
                };
              }
              return {
                ...c,
                positionKeyframes: c.positionKeyframes.map((k) => ({ ...k, easing: 'smooth' as const })),
                rotationKeyframes: c.rotationKeyframes.map((k) => ({ ...k, easing: 'smooth' as const })),
              };
            }),
          }));
        }}
        onUpdateCharacterVec3Keys={(instanceId, channel, nextKeys) =>
          commitSceneMutation(
            'Edit Curve Keys',
            (s) => ({
              ...s,
              characters: s.characters.map((c) => {
                if (c.id !== instanceId) return c;
                if (channel === 'pos') return { ...c, positionKeyframes: nextKeys };
                if (channel === 'rot') return { ...c, rotationKeyframes: nextKeys };
                return { ...c, scaleKeyframes: nextKeys };
              }),
            }),
            `curve:${instanceId}:${channel}`,
          )
        }
        onUpdateNodeRotKeys={(instanceId, nodeId, nextKeys) =>
          commitSceneMutation(
            'Edit Joint Curve Keys',
            (s) => ({
              ...s,
              characters: s.characters.map((c) =>
                c.id === instanceId
                  ? {
                      ...c,
                      nodeTracks: (c.nodeTracks ?? []).map((nt) =>
                        nt.nodeId === nodeId ? { ...nt, rotationKeyframes: nextKeys } : nt,
                      ),
                    }
                  : c,
              ),
            }),
            `curve:${instanceId}:node:${nodeId}`,
          )
        }
        onUpdateGroupVec3Keys={(groupId, channel, nextKeys) =>
          commitSceneMutation(
            'Edit Group Curve Keys',
            (s) => ({
              ...s,
              groups: (s.groups ?? []).map((g) => {
                if (g.id !== groupId) return g;
                if (channel === 'pos') return { ...g, positionKeyframes: nextKeys };
                if (channel === 'rot') return { ...g, rotationKeyframes: nextKeys };
                return { ...g, scaleKeyframes: nextKeys };
              }),
            }),
            `curve:grp:${groupId}:${channel}`,
          )
        }
        onToggleCharacterMute={(instanceId) =>
          commitSceneMutation('Toggle Character Audio Mute', (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === instanceId
                ? { ...c, audioProfile: { ...c.audioProfile, muted: !c.audioProfile.muted } }
                : c,
            ),
          }))
        }
      />

      {/* Dialogs */}
      <ImportAssetDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImportFile={async (f) => {
          await importAssetFile(f);
        }}
      />

      <ProjectManagerDialog
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        projects={projects}
        activeProjectId={activeProject.id}
        onCreateProject={(name) => {
          handleStop();
          const proj = createBlankProject(name);
          setProjects((prev) => [proj, ...prev]);
          setActiveProjectId(proj.id);
          setSelection({ kind: 'none' });
          commandManagerRef.current.clear();
          void dbSaveProject(proj);
          setSaveStatus('saved');
        }}
        onOpenProject={(projectId) => {
          handleStop();
          setActiveProjectId(projectId);
          setSelection({ kind: 'none' });
          commandManagerRef.current.clear();
        }}
        onDuplicateProject={(projectId) => {
          const src = projects.find((p) => p.id === projectId);
          if (!src) return;
          const dup: ProjectData = {
            ...JSON.parse(JSON.stringify(src)),
            id: createId('proj'),
            name: `${src.name} Copy`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          setProjects((prev) => [dup, ...prev]);
          void dbSaveProject(dup);
        }}
        onDeleteProject={(projectId) => {
          if (projects.length <= 1) return;
          const target = projects.find((p) => p.id === projectId);
          setConfirmState({
            title: 'Delete Project',
            message: `Permanently delete project "${target?.name ?? ''}"?`,
            onConfirm: () => {
              void dbDeleteProject(projectId);
              setProjects((prev) => {
                const next = prev.filter((p) => p.id !== projectId);
                if (activeProjectId === projectId && next.length > 0) {
                  setActiveProjectId(next[0].id);
                }
                return next;
              });
              setConfirmState(null);
            },
          });
        }}
      />

      <DialogueDialog
        open={dialogueTargetCharId !== null}
        onClose={() => setDialogueTargetCharId(null)}
        audioEngine={audioEngineRef.current!}
        characters={activeScene.characters}
        initialCharacterId={dialogueTargetCharId ?? ''}
        audioAssets={assets.filter((a) => a.kind === 'audio')}
        currentTime={currentTime}
        onImportAudioFile={importAssetFile}
        onCreateDialogueClip={({
          characterInstanceId,
          dialogueText,
          audioAssetId,
          startTime,
          duration,
          volume,
          playbackRate,
          pauseAfterSec,
        }) => {
          const char = activeScene.characters.find((c) => c.id === characterInstanceId);
          const clip: AudioClipData = {
            id: createId('dlg'),
            assetId: audioAssetId,
            name: dialogueText ? dialogueText.slice(0, 26) : `${char?.name ?? 'Character'} Dialogue`,
            role: 'dialogue',
            characterInstanceId,
            dialogueText,
            startTime,
            duration,
            trimStart: 0,
            volume,
            fadeIn: 0.05,
            fadeOut: 0.05,
            muted: false,
            playbackRate,
            pauseAfterSec,
          };
          commitSceneMutation(`Add Dialogue Clip`, (s) => ({
            ...s,
            audioClips: [...s.audioClips, clip],
          }));
          setSelection({ kind: 'audio-clip', clipId: clip.id });
        }}
      />

      <ExportVideoDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        activeScene={activeScene}
        allScenes={activeProject.scenes}
        exporting={exporting}
        progress={exportProgress}
        statusText={exportStatusText}
        onCancelExport={() => exportAbortRef.current?.abort()}
        onStartExport={async ({ scope, width, height, fps, mimeType, ext, includeAudio, steppedFrames }) => {
          if (!engineRef.current || !audioEngineRef.current) return;
          handleStop();
          const scenesToExport = scope === 'project' ? activeProject.scenes : [activeScene];
          const abort = new AbortController();
          exportAbortRef.current = abort;
          setExporting(true);
          setExportProgress(0);
          setExportStatusText('Initializing video encoder...');

          try {
            const blob = await exportScenesToVideo(engineRef.current, audioEngineRef.current, {
              scenes: scenesToExport,
              fps,
              width,
              height,
              mimeType,
              includeAudio,
              steppedFrames,
              signal: abort.signal,
              onSceneSwitch: (sceneIdx, localTime) => {
                const sc = scenesToExport[sceneIdx];
                if (sc) {
                  if (sceneRef.current.id !== sc.id) {
                    updateActiveProject((p) => ({ ...p, activeSceneId: sc.id }), false);
                  }
                  applySceneEvaluation(sc, localTime, 1 / fps);
                }
              },
              onProgress: (frac, txt) => {
                setExportProgress(frac);
                setExportStatusText(txt);
              },
            });

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${activeProject.name.replace(/[^a-z0-9_-]+/gi, '_')}.${ext}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setExportOpen(false);
          } finally {
            setExporting(false);
            exportAbortRef.current = null;
          }
        }}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        actions={paletteActions}
      />

      <UserGuideDialog open={guideOpen} onClose={() => setGuideOpen(false)} />

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
