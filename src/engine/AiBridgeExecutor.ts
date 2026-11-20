import type {
  ActionClip,
  AiBridgeCommand,
  AiBridgeStateSnapshot,
  CharacterInstanceData,
  EasingType,
  EnvironmentPresetId,
  FacialKeyframe,
  ProjectData,
  PropGeometryKind,
  RigNodeInfo,
  SceneData,
  SceneGroupData,
  SceneLightData,
  SceneLightKind,
  ScenePropData,
  SelectionTarget,
  StageEnvironmentConfig,
  StageWallSide,
  Transform3D,
  Vec3,
  Vec3Keyframe,
} from '../core/types';
import {
  createDefaultFacialState,
  createDefaultStageConfig,
  createDefaultTransform,
} from '../core/types';
import { evaluateSceneAtTime } from '../animation/SceneEvaluator';
import { createId } from '../utils/ids';
import { createPropData, ENVIRONMENT_PRESETS } from './PropsFactory';

const DEG_TO_RAD = Math.PI / 180;
export const MAX_TIMELINE_DURATION = 3600;

function clampDuration(sec: number): number {
  if (!Number.isFinite(sec)) return 10;
  return Math.max(1, Math.min(MAX_TIMELINE_DURATION, Number(sec.toFixed(2))));
}

function autoExpandedDuration(currentDuration: number, targetTime: number): number {
  if (!Number.isFinite(targetTime) || targetTime <= currentDuration) return currentDuration;
  return clampDuration(Math.max(currentDuration, Math.ceil(targetTime)));
}

function mergeVec3(base: Vec3, patch?: Partial<Vec3>, relative = false): Vec3 {
  if (!patch) return { ...base };
  return {
    x:
      typeof patch.x === 'number' && Number.isFinite(patch.x)
        ? relative
          ? base.x + patch.x
          : patch.x
        : base.x,
    y:
      typeof patch.y === 'number' && Number.isFinite(patch.y)
        ? relative
          ? base.y + patch.y
          : patch.y
        : base.y,
    z:
      typeof patch.z === 'number' && Number.isFinite(patch.z)
        ? relative
          ? base.z + patch.z
          : patch.z
        : base.z,
  };
}

function upsertVec3Key(list: Vec3Keyframe[], time: number, value: Vec3, easing: EasingType): Vec3Keyframe[] {
  const existing = list.find((k) => Math.abs(k.time - time) < 0.04);
  if (existing) {
    return list.map((k) => (k.id === existing.id ? { ...k, value, easing } : k));
  }
  return [...list, { id: createId('kf'), time, value, easing }].sort((a, b) => a.time - b.time);
}

export function buildAiSceneSnapshot(
  project: ProjectData,
  scene: SceneData,
  currentTime: number,
  isPlaying: boolean,
  selection: SelectionTarget,
  rigNodesByInstance: Record<string, RigNodeInfo[]>,
  sessionId?: string,
): AiBridgeStateSnapshot {
  const evalSnap = evaluateSceneAtTime(scene, currentTime);
  const envSpec = ENVIRONMENT_PRESETS.find((e) => e.id === scene.environmentPreset);
  const stageConfig = scene.stageConfig ?? createDefaultStageConfig(envSpec?.floorColor);

  return {
    ...(sessionId ? { sessionId } : {}),
    projectName: project.name,
    sceneId: scene.id,
    sceneName: scene.name,
    duration: scene.duration,
    maxDuration: MAX_TIMELINE_DURATION,
    currentTime: Number(currentTime.toFixed(3)),
    isPlaying,
    backgroundColor: scene.backgroundColor,
    showGrid: scene.showGrid,
    environmentPreset: scene.environmentPreset,
    workArea: scene.workArea,
    stageConfig,
    camera: evalSnap.camera,
    selection,
    characters: scene.characters.map((c) => {
      const ce = evalSnap.characters.get(c.id);
      const nodes = (rigNodesByInstance[c.id] ?? []).slice(0, 120).map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        type: n.type,
        slot: n.slot,
      }));
      return {
        id: c.id,
        name: c.name,
        visible: c.visible,
        includeStageProps: c.includeStageProps,
        playNativeLoop: c.playNativeLoop !== false,
        transform: ce?.transform ?? c.transform,
        keyframeCount:
          c.positionKeyframes.length +
          c.rotationKeyframes.length +
          c.scaleKeyframes.length +
          (c.nodeTracks?.length ?? 0),
        actionClipsCount: c.actionClips.length,
        nodes,
      };
    }),
    props: (scene.props ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      color: p.color,
      visible: p.visible,
      transform: evalSnap.props.get(p.id)?.transform ?? p.transform,
      keyframeCount:
        p.positionKeyframes.length + p.rotationKeyframes.length + p.scaleKeyframes.length,
    })),
    lights: (scene.lights ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      color: l.color,
      intensity: l.intensity,
      position: l.position,
    })),
    groups: (scene.groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: g.memberIds,
      visible: g.visible,
    })),
  };
}

export function buildUniversalAiPrompt(
  originUrl: string,
  token: string,
  snapshot: AiBridgeStateSnapshot,
): string {
  return [
    `You are connected to Stagecraft 3D in Live Watch Mode. Every command you output executes step-by-step on the user's 3D stage while they watch.`,
    `Timeline duration is adjustable up to ${MAX_TIMELINE_DURATION}s (via "set_duration" / "update_scene") and auto-extends if you keyframe past the current end.`,
    ``,
    `LIVE HTTP API (if you can make HTTP requests):`,
    `- GET ${originUrl}/api/ai/state?sceneId=${encodeURIComponent(snapshot.sceneId)} (Header: Authorization: Bearer ${token})`,
    `- POST ${originUrl}/api/ai/commands (Header: Authorization: Bearer ${token}, JSON body: { "sceneId": "${snapshot.sceneId}", "source": "AI Assistant", "commands": [...] })`,
    ``,
    `OR output ONLY a JSON object with a "commands" array:`,
    `{`,
    `  "commands": [`,
    `    { "op": "set_duration", "duration": 60 },`,
    `    { "op": "move", "targetId": "<id>", "position": { "x": 1.5, "y": 0, "z": 0 } },`,
    `    { "op": "rotate", "targetId": "<id>", "rotationDeg": { "y": 45 } },`,
    `    { "op": "set_color", "targetId": "<id>", "nodeId": "<optional nodeId>", "color": "#f97316" },`,
    `    { "op": "add_keyframe", "targetId": "<id>", "time": 30.0, "easing": "smooth" }`,
    `  ]`,
    `}`,
    ``,
    `SUPPORTED OPS:`,
    `set_duration, update_scene, select, clear_selection, move, rotate, scale, set_color, set_visibility, duplicate_target, pose_part, reset_part, detach_part, ungroup_all, add_keyframe, delete_keyframe, add_prop, delete_target, add_wall, remove_wall, update_stage, add_light, update_light, delete_light, set_camera_pose, add_camera_keyframe, add_action_clip, set_facial_expression, update_motion_path, create_group, ungroup_scene_group, set_time, play, pause, bake_html_motion, rename_scene`,
    ``,
    `CURRENT LIVE 3D SCENE SNAPSHOT:`,
    JSON.stringify(snapshot, null, 2),
  ].join('\n');
}

export function extractAiCommandsFromText(rawText: string): { commands: AiBridgeCommand[]; source?: string } {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Paste JSON commands first.');
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const parsed = JSON.parse(candidate) as unknown;

  if (Array.isArray(parsed)) {
    return { commands: parsed as AiBridgeCommand[] };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { commands?: unknown; op?: string; source?: string };
    if (Array.isArray(obj.commands)) {
      return {
        commands: obj.commands as AiBridgeCommand[],
        source: typeof obj.source === 'string' ? obj.source : undefined,
      };
    }
    if (typeof obj.op === 'string') {
      return { commands: [parsed as AiBridgeCommand] };
    }
  }
  throw new Error('JSON must be an object with { "commands": [...] } or an array of command objects.');
}

export interface AiCommandExecutionContext {
  scene: SceneData;
  currentTime: number;
  rigNodesByInstance: Record<string, RigNodeInfo[]>;
  updateScene: (updater: (s: SceneData) => SceneData, description: string) => void;
  setSelection: (target: SelectionTarget) => void;
  setTime: (time: number) => void;
  startPlayback: () => void;
  stopPlayback: () => void;
  setCameraPose: (pose: { position: Vec3; target: Vec3; fov: number }) => void;
  detachNode: (instanceId: string, nodeId: string, nodeName: string) => void;
  ungroupCharacter: (instanceId: string) => void;
  bakeHtmlMotion: (instanceId: string) => void;
  addStageWall: (side: StageWallSide, opts?: { color?: string; height?: number }) => void;
  ensureSessionScene?: (sessionId: string, sceneId: string, sceneName: string) => void;
}

function resolveCharacterAndNode(
  scene: SceneData,
  rigNodesByInstance: Record<string, RigNodeInfo[]>,
  cmd: AiBridgeCommand,
): { char: CharacterInstanceData | undefined; node: RigNodeInfo | undefined } {
  const idOrName = cmd.characterId ?? cmd.targetId ?? cmd.id;
  const char =
    scene.characters.find(
      (c) => c.id === idOrName || c.name.toLowerCase() === String(idOrName ?? '').toLowerCase(),
    ) ?? (cmd.nodeId && scene.characters.length === 1 ? scene.characters[0] : undefined);
  if (!char) return { char: undefined, node: undefined };
  const nodes = rigNodesByInstance[char.id] ?? [];
  const nodeLookup = cmd.nodeId ?? cmd.nodeName;
  const node = nodeLookup
    ? nodes.find(
        (n) =>
          n.nodeId === nodeLookup ||
          n.slot?.toLowerCase() === nodeLookup.toLowerCase() ||
          n.name.toLowerCase() === nodeLookup.toLowerCase(),
      )
    : undefined;
  return { char, node };
}

function resolveProp(scene: SceneData, cmd: AiBridgeCommand): ScenePropData | undefined {
  const idOrName = cmd.targetId ?? cmd.id;
  if (!idOrName) return undefined;
  return (scene.props ?? []).find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase(),
  );
}

export function executeSingleAiCommand(
  ctx: AiCommandExecutionContext,
  cmd: AiBridgeCommand,
  autoHighlight = true,
): { ok: boolean; summary: string } {
  const { scene, currentTime, rigNodesByInstance } = ctx;
  const op = cmd.op;

  switch (op) {
    case 'create_session': {
      if (cmd.sessionId && cmd.sceneId) {
        ctx.ensureSessionScene?.(cmd.sessionId, cmd.sceneId, cmd.sceneName ?? 'Claude Session');
      }
      return {
        ok: true,
        summary: `Started isolated session "${cmd.sceneName ?? cmd.sceneId ?? 'New Session'}"`,
      };
    }

    case 'set_duration': {
      const nextDur = clampDuration(typeof cmd.duration === 'number' ? cmd.duration : 60);
      ctx.updateScene(
        (s) => ({
          ...s,
          duration: nextDur,
          workArea: s.workArea ? { ...s.workArea, end: Math.max(s.workArea.start + 0.5, nextDur) } : s.workArea,
        }),
        `AI Set Duration ${nextDur}s`,
      );
      return { ok: true, summary: `Set timeline duration to ${nextDur}s` };
    }

    case 'update_scene': {
      const nextDur = typeof cmd.duration === 'number' ? clampDuration(cmd.duration) : scene.duration;
      const presetSpec = cmd.environmentPreset
        ? ENVIRONMENT_PRESETS.find((p) => p.id === cmd.environmentPreset)
        : undefined;
      ctx.updateScene(
        (s) => {
          const curStage = s.stageConfig ?? createDefaultStageConfig();
          return {
            ...s,
            name: cmd.name?.trim() ? cmd.name.trim() : s.name,
            duration: nextDur,
            backgroundColor: cmd.backgroundColor ?? presetSpec?.backgroundColor ?? s.backgroundColor,
            showGrid: typeof cmd.showGrid === 'boolean' ? cmd.showGrid : s.showGrid,
            environmentPreset: (cmd.environmentPreset as EnvironmentPresetId | undefined) ?? s.environmentPreset,
            workArea: cmd.workArea
              ? {
                  enabled: cmd.workArea.enabled ?? s.workArea?.enabled ?? false,
                  start: Math.max(0, cmd.workArea.start ?? s.workArea?.start ?? 0),
                  end: Math.min(nextDur, cmd.workArea.end ?? s.workArea?.end ?? nextDur),
                }
              : s.workArea,
            stageConfig: presetSpec || cmd.floorColor || cmd.gridColor || cmd.cloudColor
              ? {
                  ...curStage,
                  floorColor: cmd.floorColor ?? presetSpec?.floorColor ?? curStage.floorColor,
                  gridColor: cmd.gridColor ?? curStage.gridColor,
                  cloudColor: cmd.cloudColor ?? curStage.cloudColor,
                }
              : curStage,
          };
        },
        'AI Update Scene Settings',
      );
      return { ok: true, summary: `Updated scene settings (duration: ${nextDur}s)` };
    }

    case 'clear_selection': {
      ctx.setSelection({ kind: 'none' });
      return { ok: true, summary: 'Cleared viewport selection' };
    }

    case 'select': {
      if (cmd.targetKind === 'none') {
        ctx.setSelection({ kind: 'none' });
        return { ok: true, summary: 'Cleared selection' };
      }
      if (cmd.targetKind === 'camera') {
        ctx.setSelection({ kind: 'camera', cameraId: cmd.id ?? scene.activeCameraId });
        return { ok: true, summary: 'Selected scene camera' };
      }
      if (cmd.targetKind === 'light') {
        const lid = cmd.id ?? cmd.lightId ?? scene.lights?.[0]?.id;
        if (!lid) return { ok: false, summary: 'Light not found' };
        ctx.setSelection({ kind: 'light', lightId: lid });
        return { ok: true, summary: `Selected light ${lid}` };
      }
      const prop = resolveProp(scene, cmd);
      if (prop && cmd.targetKind !== 'character' && cmd.targetKind !== 'body-part') {
        ctx.setSelection({ kind: 'prop', propId: prop.id });
        return { ok: true, summary: `Selected prop "${prop.name}"` };
      }
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char && node) {
        ctx.setSelection({ kind: 'body-part', instanceId: char.id, nodeId: node.nodeId, nodeName: node.name });
        return { ok: true, summary: `Selected "${node.name}" on ${char.name}` };
      }
      if (char) {
        ctx.setSelection({ kind: 'character', instanceId: char.id });
        return { ok: true, summary: `Selected character "${char.name}"` };
      }
      return { ok: false, summary: 'Target not found for select' };
    }

    case 'set_visibility': {
      const nextVis = cmd.visible !== false;
      const prop = resolveProp(scene, cmd);
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char && node) {
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) => {
              if (c.id !== char.id) return c;
              const hidden = new Set(c.hiddenNodes ?? []);
              if (nextVis) hidden.delete(node.nodeId);
              else hidden.add(node.nodeId);
              return { ...c, hiddenNodes: Array.from(hidden) };
            }),
          }),
          `AI ${nextVis ? 'Show' : 'Hide'} ${node.name}`,
        );
        return { ok: true, summary: `${nextVis ? 'Showed' : 'Hid'} part "${node.name}"` };
      }
      if (char) {
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) => (c.id === char.id ? { ...c, visible: nextVis } : c)),
          }),
          `AI ${nextVis ? 'Show' : 'Hide'} ${char.name}`,
        );
        return { ok: true, summary: `${nextVis ? 'Showed' : 'Hid'} "${char.name}"` };
      }
      if (prop) {
        ctx.updateScene(
          (s) => ({
            ...s,
            props: (s.props ?? []).map((p) => (p.id === prop.id ? { ...p, visible: nextVis } : p)),
          }),
          `AI ${nextVis ? 'Show' : 'Hide'} ${prop.name}`,
        );
        return { ok: true, summary: `${nextVis ? 'Showed' : 'Hid'} prop "${prop.name}"` };
      }
      return { ok: false, summary: 'Target not found for set_visibility' };
    }

    case 'duplicate_target': {
      const prop = resolveProp(scene, cmd);
      if (prop) {
        const clone: ScenePropData = {
          ...(JSON.parse(JSON.stringify(prop)) as ScenePropData),
          id: createId('prop'),
          name: cmd.name?.trim() || `${prop.name} Copy`,
          transform: {
            ...prop.transform,
            position: cmd.position
              ? mergeVec3(prop.transform.position, cmd.position, Boolean(cmd.relative))
              : {
                  x: prop.transform.position.x + 1.5,
                  y: prop.transform.position.y,
                  z: prop.transform.position.z,
                },
          },
        };
        ctx.updateScene((s) => ({ ...s, props: [...(s.props ?? []), clone] }), `AI Duplicate ${prop.name}`);
        if (autoHighlight) ctx.setSelection({ kind: 'prop', propId: clone.id });
        return { ok: true, summary: `Duplicated prop "${prop.name}" as "${clone.name}"` };
      }
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char) {
        const clone: CharacterInstanceData = {
          ...(JSON.parse(JSON.stringify(char)) as CharacterInstanceData),
          id: createId('char'),
          name: cmd.name?.trim() || `${char.name} Copy`,
          transform: {
            ...char.transform,
            position: cmd.position
              ? mergeVec3(char.transform.position, cmd.position, Boolean(cmd.relative))
              : {
                  x: char.transform.position.x + 1.8,
                  y: char.transform.position.y,
                  z: char.transform.position.z,
                },
          },
        };
        ctx.updateScene((s) => ({ ...s, characters: [...s.characters, clone] }), `AI Duplicate ${char.name}`);
        if (autoHighlight) ctx.setSelection({ kind: 'character', instanceId: clone.id });
        return { ok: true, summary: `Duplicated character "${char.name}" as "${clone.name}"` };
      }
      return { ok: false, summary: 'Target not found for duplicate_target' };
    }

    case 'move':
    case 'rotate':
    case 'scale': {
      const prop = resolveProp(scene, cmd);
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      const rel = Boolean(cmd.relative);
      const targetTime = typeof cmd.time === 'number' ? Math.max(0, cmd.time) : currentTime;
      const evalSnap = evaluateSceneAtTime(scene, targetTime);

      const scalePatch: Partial<Vec3> | undefined =
        typeof cmd.scale === 'number'
          ? { x: cmd.scale, y: cmd.scale, z: cmd.scale }
          : cmd.scale;
      const rotPatch: Partial<Vec3> | undefined = cmd.rotationDeg
        ? {
            x: typeof cmd.rotationDeg.x === 'number' ? cmd.rotationDeg.x * DEG_TO_RAD : undefined,
            y: typeof cmd.rotationDeg.y === 'number' ? cmd.rotationDeg.y * DEG_TO_RAD : undefined,
            z: typeof cmd.rotationDeg.z === 'number' ? cmd.rotationDeg.z * DEG_TO_RAD : undefined,
          }
        : cmd.rotationRad;

      if (char && node) {
        if (autoHighlight) {
          ctx.setSelection({ kind: 'body-part', instanceId: char.id, nodeId: node.nodeId, nodeName: node.name });
        }
        const charEval = evalSnap.characters.get(char.id);
        const curPos = charEval?.nodePositions[node.nodeId] ?? { x: 0, y: 0, z: 0 };
        const curRot = charEval?.nodeRotations[node.nodeId] ?? { x: 0, y: 0, z: 0 };
        const curScale = charEval?.nodeScales[node.nodeId] ?? { x: 1, y: 1, z: 1 };
        const nextPos = op === 'move' ? mergeVec3(curPos, cmd.position, rel) : curPos;
        const nextRot = op === 'rotate' ? mergeVec3(curRot, rotPatch, rel) : curRot;
        const nextScale = op === 'scale' ? mergeVec3(curScale, scalePatch, rel) : curScale;
        const ease = cmd.easing ?? 'smooth';

        ctx.updateScene(
          (s) => ({
            ...s,
            duration: autoExpandedDuration(s.duration, targetTime),
            characters: s.characters.map((c) => {
              if (c.id !== char.id) return c;
              const tracks = c.nodeTracks ?? [];
              const idx = tracks.findIndex((nt) => nt.nodeId === node.nodeId);
              const baseTrack =
                idx >= 0
                  ? tracks[idx]
                  : {
                      nodeId: node.nodeId,
                      nodeName: node.name,
                      rotationKeyframes: [],
                      positionKeyframes: [],
                      scaleKeyframes: [],
                    };
              const updatedTrack = {
                ...baseTrack,
                positionKeyframes:
                  op === 'move' ? upsertVec3Key(baseTrack.positionKeyframes, targetTime, nextPos, ease) : baseTrack.positionKeyframes,
                rotationKeyframes:
                  op === 'rotate' ? upsertVec3Key(baseTrack.rotationKeyframes, targetTime, nextRot, ease) : baseTrack.rotationKeyframes,
                scaleKeyframes:
                  op === 'scale' ? upsertVec3Key(baseTrack.scaleKeyframes ?? [], targetTime, nextScale, ease) : baseTrack.scaleKeyframes,
              };
              const nextTracks =
                idx >= 0 ? tracks.map((t, i) => (i === idx ? updatedTrack : t)) : [...tracks, updatedTrack];
              return { ...c, nodeTracks: nextTracks };
            }),
          }),
          `AI ${op} ${node.name}`,
        );
        return { ok: true, summary: `${op} part "${node.name}" on ${char.name}` };
      }

      if (char) {
        if (autoHighlight) {
          ctx.setSelection({ kind: 'character', instanceId: char.id });
        }
        const baseT = evalSnap.characters.get(char.id)?.transform ?? char.transform;
        const nextT: Transform3D = {
          position: op === 'move' ? mergeVec3(baseT.position, cmd.position, rel) : baseT.position,
          rotation: op === 'rotate' ? mergeVec3(baseT.rotation, rotPatch, rel) : baseT.rotation,
          scale: op === 'scale' ? mergeVec3(baseT.scale, scalePatch, rel) : baseT.scale,
        };
        const ease = cmd.easing ?? 'smooth';
        ctx.updateScene(
          (s) => ({
            ...s,
            duration: autoExpandedDuration(s.duration, targetTime),
            characters: s.characters.map((c) => {
              if (c.id !== char.id) return c;
              if (typeof cmd.time === 'number' || c.positionKeyframes.length > 0 || c.rotationKeyframes.length > 0) {
                return {
                  ...c,
                  transform: nextT,
                  positionKeyframes: op === 'move' ? upsertVec3Key(c.positionKeyframes, targetTime, nextT.position, ease) : c.positionKeyframes,
                  rotationKeyframes: op === 'rotate' ? upsertVec3Key(c.rotationKeyframes, targetTime, nextT.rotation, ease) : c.rotationKeyframes,
                  scaleKeyframes: op === 'scale' ? upsertVec3Key(c.scaleKeyframes, targetTime, nextT.scale, ease) : c.scaleKeyframes,
                };
              }
              return { ...c, transform: nextT };
            }),
          }),
          `AI ${op} ${char.name}`,
        );
        return { ok: true, summary: `${op} "${char.name}"` };
      }

      if (prop) {
        if (autoHighlight) {
          ctx.setSelection({ kind: 'prop', propId: prop.id });
        }
        const baseT = evalSnap.props.get(prop.id)?.transform ?? prop.transform;
        const nextT: Transform3D = {
          position: op === 'move' ? mergeVec3(baseT.position, cmd.position, rel) : baseT.position,
          rotation: op === 'rotate' ? mergeVec3(baseT.rotation, rotPatch, rel) : baseT.rotation,
          scale: op === 'scale' ? mergeVec3(baseT.scale, scalePatch, rel) : baseT.scale,
        };
        const ease = cmd.easing ?? 'smooth';
        ctx.updateScene(
          (s) => ({
            ...s,
            duration: autoExpandedDuration(s.duration, targetTime),
            props: (s.props ?? []).map((p) => {
              if (p.id !== prop.id) return p;
              if (typeof cmd.time === 'number' || p.positionKeyframes.length > 0 || p.rotationKeyframes.length > 0) {
                return {
                  ...p,
                  transform: nextT,
                  positionKeyframes: op === 'move' ? upsertVec3Key(p.positionKeyframes, targetTime, nextT.position, ease) : p.positionKeyframes,
                  rotationKeyframes: op === 'rotate' ? upsertVec3Key(p.rotationKeyframes, targetTime, nextT.rotation, ease) : p.rotationKeyframes,
                  scaleKeyframes: op === 'scale' ? upsertVec3Key(p.scaleKeyframes, targetTime, nextT.scale, ease) : p.scaleKeyframes,
                };
              }
              return { ...p, transform: nextT };
            }),
          }),
          `AI ${op} ${prop.name}`,
        );
        return { ok: true, summary: `${op} prop "${prop.name}"` };
      }

      return { ok: false, summary: `Target not found for ${op}` };
    }

    case 'pose_part': {
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char || !node) return { ok: false, summary: 'Character or node not found for pose_part' };
      if (autoHighlight) {
        ctx.setSelection({ kind: 'body-part', instanceId: char.id, nodeId: node.nodeId, nodeName: node.name });
      }
      const ease = cmd.easing ?? 'smooth';
      const targetTime = typeof cmd.time === 'number' ? Math.max(0, cmd.time) : currentTime;
      const evalSnap = evaluateSceneAtTime(scene, targetTime);
      const charEval = evalSnap.characters.get(char.id);
      const curRot = charEval?.nodeRotations[node.nodeId] ?? { x: 0, y: 0, z: 0 };
      const curPos = charEval?.nodePositions[node.nodeId] ?? { x: 0, y: 0, z: 0 };
      const rotPatch = cmd.rotationDeg
        ? {
            x: typeof cmd.rotationDeg.x === 'number' ? cmd.rotationDeg.x * DEG_TO_RAD : undefined,
            y: typeof cmd.rotationDeg.y === 'number' ? cmd.rotationDeg.y * DEG_TO_RAD : undefined,
            z: typeof cmd.rotationDeg.z === 'number' ? cmd.rotationDeg.z * DEG_TO_RAD : undefined,
          }
        : cmd.rotationRad;
      const nextRot = mergeVec3(curRot, rotPatch, Boolean(cmd.relative));
      const nextPos = cmd.position ? mergeVec3(curPos, cmd.position, Boolean(cmd.relative)) : null;

      ctx.updateScene(
        (s) => ({
          ...s,
          duration: autoExpandedDuration(s.duration, targetTime),
          characters: s.characters.map((c) => {
            if (c.id !== char.id) return c;
            const tracks = c.nodeTracks ?? [];
            const idx = tracks.findIndex((nt) => nt.nodeId === node.nodeId);
            const baseTrack =
              idx >= 0
                ? tracks[idx]
                : { nodeId: node.nodeId, nodeName: node.name, rotationKeyframes: [], positionKeyframes: [], scaleKeyframes: [] };
            const updatedTrack = {
              ...baseTrack,
              rotationKeyframes: upsertVec3Key(baseTrack.rotationKeyframes, targetTime, nextRot, ease),
              positionKeyframes: nextPos
                ? upsertVec3Key(baseTrack.positionKeyframes, targetTime, nextPos, ease)
                : baseTrack.positionKeyframes,
            };
            return {
              ...c,
              nodeTracks: idx >= 0 ? tracks.map((t, i) => (i === idx ? updatedTrack : t)) : [...tracks, updatedTrack],
            };
          }),
        }),
        `AI Pose ${node.name}`,
      );
      return { ok: true, summary: `Posed "${node.name}" on ${char.name}` };
    }

    case 'reset_part': {
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char || !node) return { ok: false, summary: 'Part not found for reset_part' };
      ctx.updateScene(
        (s) => ({
          ...s,
          characters: s.characters.map((c) =>
            c.id === char.id
              ? { ...c, nodeTracks: (c.nodeTracks ?? []).filter((nt) => nt.nodeId !== node.nodeId) }
              : c,
          ),
        }),
        `AI Reset ${node.name}`,
      );
      return { ok: true, summary: `Reset "${node.name}"` };
    }

    case 'detach_part': {
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char || !node) return { ok: false, summary: 'Part not found for detach_part' };
      ctx.detachNode(char.id, node.nodeId, node.name);
      return { ok: true, summary: `Detached "${node.name}" into standalone object` };
    }

    case 'ungroup_all': {
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char) return { ok: false, summary: 'Character not found for ungroup_all' };
      ctx.ungroupCharacter(char.id);
      return { ok: true, summary: `Ungrouped "${char.name}" into independent parts` };
    }

    case 'set_color': {
      const prop = resolveProp(scene, cmd);
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char) {
        const nid = node?.nodeId ?? 'node_0';
        if (autoHighlight) {
          ctx.setSelection(
            node
              ? { kind: 'body-part', instanceId: char.id, nodeId: node.nodeId, nodeName: node.name }
              : { kind: 'character', instanceId: char.id },
          );
        }
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === char.id
                ? {
                    ...c,
                    nodeMaterialOverrides: {
                      ...(c.nodeMaterialOverrides ?? {}),
                      [nid]: {
                        ...(c.nodeMaterialOverrides?.[nid] ?? {}),
                        ...(cmd.color ? { color: cmd.color } : {}),
                        ...(cmd.emissive ? { emissive: cmd.emissive } : {}),
                        ...(typeof cmd.roughness === 'number' ? { roughness: cmd.roughness } : {}),
                        ...(typeof cmd.metalness === 'number' ? { metalness: cmd.metalness } : {}),
                        ...(typeof cmd.opacity === 'number' ? { opacity: cmd.opacity } : {}),
                      },
                    },
                  }
                : c,
            ),
          }),
          `AI Recolor ${node?.name ?? char.name}`,
        );
        return { ok: true, summary: `Recolored "${node?.name ?? char.name}" to ${cmd.color ?? 'updated material'}` };
      }
      if (prop) {
        if (autoHighlight) {
          ctx.setSelection({ kind: 'prop', propId: prop.id });
        }
        ctx.updateScene(
          (s) => ({
            ...s,
            props: (s.props ?? []).map((p) =>
              p.id === prop.id
                ? {
                    ...p,
                    color: cmd.color ?? p.color,
                    materialOverride: {
                      ...(p.materialOverride ?? {}),
                      ...(cmd.color ? { color: cmd.color } : {}),
                      ...(cmd.emissive ? { emissive: cmd.emissive } : {}),
                      ...(typeof cmd.roughness === 'number' ? { roughness: cmd.roughness } : {}),
                      ...(typeof cmd.metalness === 'number' ? { metalness: cmd.metalness } : {}),
                      ...(typeof cmd.opacity === 'number' ? { opacity: cmd.opacity } : {}),
                    },
                  }
                : p,
            ),
          }),
          `AI Recolor ${prop.name}`,
        );
        return { ok: true, summary: `Recolored prop "${prop.name}" to ${cmd.color ?? 'updated material'}` };
      }
      return { ok: false, summary: 'Target not found for set_color' };
    }

    case 'add_keyframe': {
      const t = typeof cmd.time === 'number' ? Math.max(0, cmd.time) : currentTime;
      const ease = cmd.easing ?? 'smooth';
      const evalSnap = evaluateSceneAtTime(scene, t);
      const prop = resolveProp(scene, cmd);
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);

      const scalePatch: Partial<Vec3> | undefined =
        typeof cmd.scale === 'number'
          ? { x: cmd.scale, y: cmd.scale, z: cmd.scale }
          : cmd.scale;
      const rotPatch: Partial<Vec3> | undefined = cmd.rotationDeg
        ? {
            x: typeof cmd.rotationDeg.x === 'number' ? cmd.rotationDeg.x * DEG_TO_RAD : undefined,
            y: typeof cmd.rotationDeg.y === 'number' ? cmd.rotationDeg.y * DEG_TO_RAD : undefined,
            z: typeof cmd.rotationDeg.z === 'number' ? cmd.rotationDeg.z * DEG_TO_RAD : undefined,
          }
        : cmd.rotationRad;

      if (char) {
        const curT = evalSnap.characters.get(char.id)?.transform ?? char.transform;
        const nextPos = cmd.position ? mergeVec3(curT.position, cmd.position, Boolean(cmd.relative)) : curT.position;
        const nextRot = rotPatch ? mergeVec3(curT.rotation, rotPatch, Boolean(cmd.relative)) : curT.rotation;
        const nextScale = scalePatch ? mergeVec3(curT.scale, scalePatch, Boolean(cmd.relative)) : curT.scale;
        if (autoHighlight) ctx.setSelection({ kind: 'character', instanceId: char.id });
        ctx.updateScene(
          (s) => ({
            ...s,
            duration: autoExpandedDuration(s.duration, t),
            characters: s.characters.map((c) =>
              c.id === char.id
                ? {
                    ...c,
                    positionKeyframes: upsertVec3Key(c.positionKeyframes, t, nextPos, ease),
                    rotationKeyframes: upsertVec3Key(c.rotationKeyframes, t, nextRot, ease),
                    scaleKeyframes: upsertVec3Key(c.scaleKeyframes, t, nextScale, ease),
                  }
                : c,
            ),
          }),
          `AI Keyframe ${char.name} @ ${t.toFixed(2)}s`,
        );
        return { ok: true, summary: `Added keyframe on "${char.name}" @ ${t.toFixed(2)}s` };
      }
      if (prop) {
        const curT = evalSnap.props.get(prop.id)?.transform ?? prop.transform;
        const nextPos = cmd.position ? mergeVec3(curT.position, cmd.position, Boolean(cmd.relative)) : curT.position;
        const nextRot = rotPatch ? mergeVec3(curT.rotation, rotPatch, Boolean(cmd.relative)) : curT.rotation;
        const nextScale = scalePatch ? mergeVec3(curT.scale, scalePatch, Boolean(cmd.relative)) : curT.scale;
        if (autoHighlight) ctx.setSelection({ kind: 'prop', propId: prop.id });
        ctx.updateScene(
          (s) => ({
            ...s,
            duration: autoExpandedDuration(s.duration, t),
            props: (s.props ?? []).map((p) =>
              p.id === prop.id
                ? {
                    ...p,
                    positionKeyframes: upsertVec3Key(p.positionKeyframes, t, nextPos, ease),
                    rotationKeyframes: upsertVec3Key(p.rotationKeyframes, t, nextRot, ease),
                    scaleKeyframes: upsertVec3Key(p.scaleKeyframes, t, nextScale, ease),
                  }
                : p,
            ),
          }),
          `AI Keyframe ${prop.name} @ ${t.toFixed(2)}s`,
        );
        return { ok: true, summary: `Added keyframe on prop "${prop.name}" @ ${t.toFixed(2)}s` };
      }
      return { ok: false, summary: 'Target not found for add_keyframe' };
    }

    case 'delete_keyframe': {
      const hasTime = typeof cmd.time === 'number';
      const t = cmd.time ?? 0;
      const matchesTime = (kTime: number) => !hasTime || Math.abs(kTime - t) < 0.06;
      const prop = resolveProp(scene, cmd);
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char && node) {
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === char.id
                ? {
                    ...c,
                    nodeTracks: (c.nodeTracks ?? []).map((nt) =>
                      nt.nodeId === node.nodeId
                        ? {
                            ...nt,
                            positionKeyframes: nt.positionKeyframes.filter((k) => !matchesTime(k.time)),
                            rotationKeyframes: nt.rotationKeyframes.filter((k) => !matchesTime(k.time)),
                            scaleKeyframes: (nt.scaleKeyframes ?? []).filter((k) => !matchesTime(k.time)),
                          }
                        : nt,
                    ),
                  }
                : c,
            ),
          }),
          `AI Delete Keyframe ${node.name}`,
        );
        return { ok: true, summary: `Removed keyframe(s) on part "${node.name}"` };
      }
      if (char) {
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === char.id
                ? {
                    ...c,
                    positionKeyframes: c.positionKeyframes.filter((k) => !matchesTime(k.time)),
                    rotationKeyframes: c.rotationKeyframes.filter((k) => !matchesTime(k.time)),
                    scaleKeyframes: c.scaleKeyframes.filter((k) => !matchesTime(k.time)),
                  }
                : c,
            ),
          }),
          `AI Delete Keyframe ${char.name}`,
        );
        return { ok: true, summary: `Removed keyframe(s) on "${char.name}"` };
      }
      if (prop) {
        ctx.updateScene(
          (s) => ({
            ...s,
            props: (s.props ?? []).map((p) =>
              p.id === prop.id
                ? {
                    ...p,
                    positionKeyframes: p.positionKeyframes.filter((k) => !matchesTime(k.time)),
                    rotationKeyframes: p.rotationKeyframes.filter((k) => !matchesTime(k.time)),
                    scaleKeyframes: p.scaleKeyframes.filter((k) => !matchesTime(k.time)),
                  }
                : p,
            ),
          }),
          `AI Delete Keyframe ${prop.name}`,
        );
        return { ok: true, summary: `Removed keyframe(s) on prop "${prop.name}"` };
      }
      return { ok: false, summary: 'Target not found for delete_keyframe' };
    }

    case 'add_prop': {
      const kind: PropGeometryKind = cmd.kind ?? 'box';
      const label = cmd.name ?? `AI ${kind.charAt(0).toUpperCase() + kind.slice(1)}`;
      const color = cmd.color ?? '#e8702a';
      const prop = createPropData(kind, label, color, cmd.position?.x ?? 0, cmd.position?.z ?? 0);
      if (typeof cmd.position?.y === 'number') {
        prop.transform.position.y = cmd.position.y;
      }
      if (cmd.rotationDeg) {
        prop.transform.rotation = {
          x: (cmd.rotationDeg.x ?? 0) * DEG_TO_RAD,
          y: (cmd.rotationDeg.y ?? 0) * DEG_TO_RAD,
          z: (cmd.rotationDeg.z ?? 0) * DEG_TO_RAD,
        };
      }
      if (cmd.scale !== undefined) {
        const sVec =
          typeof cmd.scale === 'number'
            ? { x: cmd.scale, y: cmd.scale, z: cmd.scale }
            : mergeVec3({ x: 1, y: 1, z: 1 }, cmd.scale, false);
        prop.transform.scale = sVec;
      }
      ctx.updateScene(
        (s) => ({ ...s, props: [...(s.props ?? []), prop] }),
        `AI Add Prop ${label}`,
      );
      if (autoHighlight) ctx.setSelection({ kind: 'prop', propId: prop.id });
      return { ok: true, summary: `Added ${kind} "${label}" (id: ${prop.id})` };
    }

    case 'delete_target': {
      const prop = resolveProp(scene, cmd);
      if (prop) {
        ctx.updateScene(
          (s) => ({ ...s, props: (s.props ?? []).filter((p) => p.id !== prop.id) }),
          `AI Delete ${prop.name}`,
        );
        ctx.setSelection({ kind: 'none' });
        return { ok: true, summary: `Deleted prop "${prop.name}"` };
      }
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char) {
        ctx.updateScene(
          (s) => ({ ...s, characters: s.characters.filter((c) => c.id !== char.id) }),
          `AI Delete ${char.name}`,
        );
        ctx.setSelection({ kind: 'none' });
        return { ok: true, summary: `Deleted character "${char.name}"` };
      }
      return { ok: false, summary: 'Target not found for delete_target' };
    }

    case 'add_wall': {
      ctx.addStageWall(cmd.side ?? 'back', { color: cmd.color, height: cmd.height });
      return { ok: true, summary: `Added ${cmd.side ?? 'back'} stage wall` };
    }

    case 'remove_wall': {
      if (!cmd.wallId) return { ok: false, summary: 'Provide wallId for remove_wall' };
      ctx.updateScene(
        (s) => {
          const st = s.stageConfig ?? createDefaultStageConfig();
          return { ...s, stageConfig: { ...st, walls: st.walls.filter((w) => w.id !== cmd.wallId) } };
        },
        'AI Remove Wall',
      );
      return { ok: true, summary: `Removed wall ${cmd.wallId}` };
    }

    case 'update_stage': {
      ctx.updateScene((s) => {
        const cur = s.stageConfig ?? createDefaultStageConfig();
        const nextStage: StageEnvironmentConfig = {
          ...cur,
          ...(cmd.floorShape ? { floorShape: cmd.floorShape } : {}),
          ...(typeof cmd.floorSides === 'number' ? { floorSides: Math.max(3, Math.min(64, Math.round(cmd.floorSides))) } : {}),
          ...(typeof cmd.floorSize === 'number' ? { floorSize: Math.max(4, cmd.floorSize) } : {}),
          ...(cmd.floorColor ? { floorColor: cmd.floorColor } : {}),
          ...(cmd.gridColor ? { gridColor: cmd.gridColor } : {}),
          ...(typeof cmd.showClouds === 'boolean' ? { showClouds: cmd.showClouds } : {}),
          ...(cmd.cloudColor ? { cloudColor: cmd.cloudColor } : {}),
          ...(typeof cmd.cloudOpacity === 'number' ? { cloudOpacity: cmd.cloudOpacity } : {}),
          ...(typeof cmd.floorLockEnabled === 'boolean' ? { floorLockEnabled: cmd.floorLockEnabled } : {}),
        };
        return {
          ...s,
          backgroundColor: cmd.backgroundColor ?? s.backgroundColor,
          stageConfig: nextStage,
        };
      }, 'AI Update Stage');
      return { ok: true, summary: 'Updated stage environment & sky/floor colors' };
    }

    case 'add_light': {
      const kind: SceneLightKind = cmd.lightKind ?? 'point';
      const light: SceneLightData = {
        id: createId('light'),
        name: cmd.name?.trim() || `AI ${kind.charAt(0).toUpperCase() + kind.slice(1)} Light`,
        kind,
        color: cmd.color ?? '#ffffff',
        intensity: typeof cmd.intensity === 'number' ? cmd.intensity : 1.5,
        position: mergeVec3({ x: 3, y: 6, z: 4 }, cmd.position, false),
        target: cmd.target ? mergeVec3({ x: 0, y: 1, z: 0 }, cmd.target, false) : { x: 0, y: 1, z: 0 },
        castShadow: cmd.castShadow !== false,
        visible: true,
      };
      ctx.updateScene(
        (s) => ({ ...s, lights: [...(s.lights ?? []), light] }),
        `AI Add Light ${light.name}`,
      );
      if (autoHighlight) ctx.setSelection({ kind: 'light', lightId: light.id });
      return { ok: true, summary: `Added ${kind} light "${light.name}" (id: ${light.id})` };
    }

    case 'update_light': {
      const lid = cmd.lightId ?? cmd.targetId ?? scene.lights?.[0]?.id;
      if (!lid) return { ok: false, summary: 'Light not found' };
      ctx.updateScene(
        (s) => ({
          ...s,
          lights: (s.lights ?? []).map((l) =>
            l.id === lid
              ? {
                  ...l,
                  ...(cmd.name ? { name: cmd.name } : {}),
                  ...(cmd.color ? { color: cmd.color } : {}),
                  ...(typeof cmd.intensity === 'number' ? { intensity: cmd.intensity } : {}),
                  ...(typeof cmd.visible === 'boolean' ? { visible: cmd.visible } : {}),
                  ...(cmd.position ? { position: mergeVec3(l.position, cmd.position, false) } : {}),
                }
              : l,
          ),
        }),
        'AI Update Light',
      );
      if (autoHighlight) ctx.setSelection({ kind: 'light', lightId: lid });
      return { ok: true, summary: `Updated light ${lid}` };
    }

    case 'delete_light': {
      const lid = cmd.lightId ?? cmd.targetId;
      if (!lid) return { ok: false, summary: 'Provide lightId for delete_light' };
      ctx.updateScene(
        (s) => ({ ...s, lights: (s.lights ?? []).filter((l) => l.id !== lid) }),
        `AI Delete Light ${lid}`,
      );
      return { ok: true, summary: `Deleted light ${lid}` };
    }

    case 'set_camera_pose': {
      const curPose = evaluateSceneAtTime(scene, currentTime).camera;
      const nextPose = {
        position: cmd.position ? mergeVec3(curPose.position, cmd.position, false) : curPose.position,
        target: cmd.target ? mergeVec3(curPose.target, cmd.target, false) : curPose.target,
        fov: typeof cmd.fov === 'number' ? cmd.fov : curPose.fov,
      };
      ctx.setCameraPose(nextPose);
      return { ok: true, summary: 'Updated scene camera framing' };
    }

    case 'add_camera_keyframe': {
      const t = typeof cmd.time === 'number' ? Math.max(0, cmd.time) : currentTime;
      const ease = cmd.easing ?? 'smooth';
      const curPose = evaluateSceneAtTime(scene, t).camera;
      const nextPose = {
        position: cmd.position ? mergeVec3(curPose.position, cmd.position, Boolean(cmd.relative)) : curPose.position,
        target: cmd.target ? mergeVec3(curPose.target, cmd.target, Boolean(cmd.relative)) : curPose.target,
        fov: typeof cmd.fov === 'number' ? cmd.fov : curPose.fov,
      };
      ctx.updateScene(
        (s) => {
          const kfId = createId('camkf');
          const upsertCam = (list: typeof s.camera.keyframes) => {
            const existing = list.find((k) => Math.abs(k.time - t) < 0.04);
            if (existing) return list.map((k) => (k.id === existing.id ? { ...k, pose: nextPose, easing: ease } : k));
            return [...list, { id: kfId, time: t, pose: nextPose, easing: ease }].sort((a, b) => a.time - b.time);
          };
          return {
            ...s,
            duration: autoExpandedDuration(s.duration, t),
            camera: { ...s.camera, pose: nextPose, keyframes: upsertCam(s.camera.keyframes) },
            cameras: (s.cameras ?? []).map((cam, idx) =>
              cam.id === s.activeCameraId || (!s.activeCameraId && idx === 0)
                ? { ...cam, pose: nextPose, keyframes: upsertCam(cam.keyframes) }
                : cam,
            ),
          };
        },
        `AI Camera Keyframe @ ${t.toFixed(2)}s`,
      );
      return { ok: true, summary: `Added camera keyframe @ ${t.toFixed(2)}s` };
    }

    case 'add_action_clip': {
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char) return { ok: false, summary: 'Character not found for add_action_clip' };
      const startTime = typeof cmd.startTime === 'number' ? Math.max(0, cmd.startTime) : typeof cmd.time === 'number' ? Math.max(0, cmd.time) : currentTime;
      const clipDuration = typeof cmd.duration === 'number' ? Math.max(0.2, cmd.duration) : 3.0;
      const clip: ActionClip = {
        id: createId('act'),
        actionId: cmd.actionId ?? 'walk',
        label: cmd.name?.trim() || cmd.actionId || 'Walk Cycle',
        kind: 'preset',
        startTime,
        duration: clipDuration,
        speed: typeof cmd.speed === 'number' ? cmd.speed : 1,
        blendIn: 0.25,
        blendOut: 0.25,
        weight: 1,
        ...(cmd.mood ? { mood: cmd.mood } : {}),
      };
      ctx.updateScene(
        (s) => ({
          ...s,
          duration: autoExpandedDuration(s.duration, startTime + clipDuration),
          characters: s.characters.map((c) =>
            c.id === char.id ? { ...c, actionClips: [...c.actionClips, clip] } : c,
          ),
        }),
        `AI Add Action "${clip.label}"`,
      );
      return { ok: true, summary: `Added "${clip.label}" action clip (${startTime}s–${startTime + clipDuration}s)` };
    }

    case 'set_facial_expression': {
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char) return { ok: false, summary: 'Character not found for set_facial_expression' };
      const t = typeof cmd.time === 'number' ? Math.max(0, cmd.time) : currentTime;
      const ease = cmd.easing ?? 'smooth';
      const nextFacial = {
        ...(char.facialState ?? createDefaultFacialState()),
        ...(cmd.facialState ?? {}),
      };
      ctx.updateScene(
        (s) => ({
          ...s,
          duration: autoExpandedDuration(s.duration, t),
          characters: s.characters.map((c) => {
            if (c.id !== char.id) return c;
            const existingKfs = c.facialKeyframes ?? [];
            const match = existingKfs.find((k) => Math.abs(k.time - t) < 0.04);
            const nextKfs: FacialKeyframe[] = match
              ? existingKfs.map((k) => (k.id === match.id ? { ...k, state: nextFacial, easing: ease } : k))
              : [...existingKfs, { id: createId('fkf'), time: t, state: nextFacial, easing: ease }].sort((a, b) => a.time - b.time);
            return { ...c, facialState: nextFacial, facialKeyframes: nextKfs };
          }),
        }),
        `AI Facial Expression @ ${t.toFixed(2)}s`,
      );
      return { ok: true, summary: `Updated facial expression on "${char.name}" @ ${t.toFixed(2)}s` };
    }

    case 'update_motion_path': {
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      const prop = resolveProp(scene, cmd);
      if (!char && !prop) return { ok: false, summary: 'Target not found for update_motion_path' };
      const pathDuration = typeof cmd.duration === 'number' ? Math.max(0.5, cmd.duration) : undefined;
      ctx.updateScene(
        (s) => {
          const patchMp = (mp: CharacterInstanceData['motionPath']) => ({
            ...mp,
            ...(typeof cmd.enabled === 'boolean' ? { enabled: cmd.enabled } : { enabled: true }),
            ...(typeof cmd.orientAlongPath === 'boolean' ? { orientAlongPath: cmd.orientAlongPath } : {}),
            ...(pathDuration ? { duration: pathDuration } : {}),
            ...(Array.isArray(cmd.points) && cmd.points.length >= 2
              ? {
                  points: cmd.points.map((pt) => ({
                    id: createId('mp'),
                    position: { x: pt.x, y: pt.y, z: pt.z },
                    handleIn: { x: pt.x, y: pt.y, z: pt.z },
                    handleOut: { x: pt.x, y: pt.y, z: pt.z },
                    smooth: true,
                  })),
                }
              : {}),
          });
          return {
            ...s,
            duration: pathDuration ? autoExpandedDuration(s.duration, pathDuration) : s.duration,
            characters: char ? s.characters.map((c) => (c.id === char.id ? { ...c, motionPath: patchMp(c.motionPath) } : c)) : s.characters,
            props: prop ? (s.props ?? []).map((p) => (p.id === prop.id ? { ...p, motionPath: patchMp(p.motionPath) } : p)) : s.props,
          };
        },
        'AI Update Motion Path',
      );
      return { ok: true, summary: `Updated 3D motion path for "${char?.name ?? prop?.name}"` };
    }

    case 'create_group': {
      const memberIds = Array.isArray(cmd.memberIds) ? cmd.memberIds : [];
      if (memberIds.length === 0) return { ok: false, summary: 'Provide memberIds array for create_group' };
      const group: SceneGroupData = {
        id: createId('grp'),
        name: cmd.name?.trim() || 'AI Group',
        visible: true,
        locked: false,
        memberIds,
        transform: createDefaultTransform(),
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
      };
      ctx.updateScene((s) => ({ ...s, groups: [...(s.groups ?? []), group] }), `AI Group "${group.name}"`);
      return { ok: true, summary: `Created group "${group.name}" (${memberIds.length} items)` };
    }

    case 'ungroup_scene_group': {
      const gid = cmd.groupId ?? cmd.targetId;
      if (!gid) return { ok: false, summary: 'Provide groupId for ungroup_scene_group' };
      ctx.updateScene(
        (s) => ({ ...s, groups: (s.groups ?? []).filter((g) => g.id !== gid) }),
        `AI Ungroup ${gid}`,
      );
      return { ok: true, summary: `Ungrouped group ${gid}` };
    }

    case 'set_time': {
      const t = typeof cmd.time === 'number' ? Math.max(0, Math.min(MAX_TIMELINE_DURATION, cmd.time)) : 0;
      if (t > scene.duration) {
        ctx.updateScene(
          (s) => ({ ...s, duration: autoExpandedDuration(s.duration, t) }),
          `AI Extend Duration to ${Math.ceil(t)}s`,
        );
      }
      ctx.setTime(t);
      return { ok: true, summary: `Moved playhead to ${t.toFixed(2)}s` };
    }

    case 'play': {
      ctx.startPlayback();
      return { ok: true, summary: 'Started scene playback' };
    }

    case 'pause': {
      ctx.stopPlayback();
      return { ok: true, summary: 'Paused scene playback' };
    }

    case 'bake_html_motion': {
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (!char) return { ok: false, summary: 'Character/HTML scene not found for bake_html_motion' };
      ctx.bakeHtmlMotion(char.id);
      return { ok: true, summary: `Baked "${char.name}" HTML movements into editable keyframes` };
    }

    case 'rename_scene': {
      if (!cmd.name?.trim()) return { ok: false, summary: 'Provide name for rename_scene' };
      ctx.updateScene((s) => ({ ...s, name: cmd.name!.trim() }), 'AI Rename Scene');
      return { ok: true, summary: `Renamed scene to "${cmd.name.trim()}"` };
    }

    default:
      return { ok: false, summary: `Unsupported op "${String(op)}"` };
  }
}
