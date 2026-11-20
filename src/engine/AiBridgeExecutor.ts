import type {
  AiBridgeCommand,
  AiBridgeStateSnapshot,
  CharacterInstanceData,
  EasingType,
  ProjectData,
  PropGeometryKind,
  RigNodeInfo,
  SceneData,
  ScenePropData,
  SelectionTarget,
  StageEnvironmentConfig,
  StageWallSide,
  Transform3D,
  Vec3,
  Vec3Keyframe,
} from '../core/types';
import { createDefaultStageConfig } from '../core/types';
import { evaluateSceneAtTime } from '../animation/SceneEvaluator';
import { createId } from '../utils/ids';
import { createPropData, ENVIRONMENT_PRESETS } from './PropsFactory';

const DEG_TO_RAD = Math.PI / 180;

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
): AiBridgeStateSnapshot {
  const evalSnap = evaluateSceneAtTime(scene, currentTime);
  const envSpec = ENVIRONMENT_PRESETS.find((e) => e.id === scene.environmentPreset);
  const stageConfig = scene.stageConfig ?? createDefaultStageConfig(envSpec?.floorColor);

  return {
    projectName: project.name,
    sceneId: scene.id,
    sceneName: scene.name,
    duration: scene.duration,
    currentTime: Number(currentTime.toFixed(3)),
    isPlaying,
    backgroundColor: scene.backgroundColor,
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
    })),
    lights: (scene.lights ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      color: l.color,
      intensity: l.intensity,
      position: l.position,
    })),
  };
}

export function buildUniversalAiPrompt(
  originUrl: string,
  token: string,
  snapshot: AiBridgeStateSnapshot,
): string {
  return [
    `You are connected to Stagecraft 3D in Live Watch Mode. Every command you output is executed step-by-step on the user's 3D stage while they watch.`,
    ``,
    `LIVE HTTP API (if you can make HTTP requests):`,
    `- GET ${originUrl}/api/ai/state (Header: Authorization: Bearer ${token})`,
    `- POST ${originUrl}/api/ai/commands (Header: Authorization: Bearer ${token}, JSON body: { "source": "AI Assistant", "commands": [...] })`,
    ``,
    `OR if you are replying in chat, output ONLY a JSON object with a "commands" array:`,
    `{`,
    `  "commands": [`,
    `    { "op": "move", "targetId": "<id>", "position": { "x": 1.5, "y": 0, "z": 0 } },`,
    `    { "op": "rotate", "targetId": "<id>", "rotationDeg": { "y": 45 } },`,
    `    { "op": "set_color", "targetId": "<id>", "nodeId": "<optional nodeId>", "color": "#f97316" },`,
    `    { "op": "add_keyframe", "targetId": "<id>", "time": 2.0, "easing": "smooth" }`,
    `  ]`,
    `}`,
    ``,
    `SUPPORTED OPS:`,
    `select, clear_selection, move, rotate, scale, set_color, pose_part, reset_part, detach_part, ungroup_all, add_keyframe, add_prop, delete_target, add_wall, remove_wall, update_stage, update_light, set_camera_pose, set_time, play, pause, bake_html_motion, rename_scene`,
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

    case 'move':
    case 'rotate':
    case 'scale': {
      const prop = resolveProp(scene, cmd);
      const { char, node } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      const rel = Boolean(cmd.relative);
      const evalSnap = evaluateSceneAtTime(scene, currentTime);

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
                  op === 'move' ? upsertVec3Key(baseTrack.positionKeyframes, currentTime, nextPos, ease) : baseTrack.positionKeyframes,
                rotationKeyframes:
                  op === 'rotate' ? upsertVec3Key(baseTrack.rotationKeyframes, currentTime, nextRot, ease) : baseTrack.rotationKeyframes,
                scaleKeyframes:
                  op === 'scale' ? upsertVec3Key(baseTrack.scaleKeyframes ?? [], currentTime, nextScale, ease) : baseTrack.scaleKeyframes,
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
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) => (c.id === char.id ? { ...c, transform: nextT } : c)),
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
        ctx.updateScene(
          (s) => ({
            ...s,
            props: (s.props ?? []).map((p) => (p.id === prop.id ? { ...p, transform: nextT } : p)),
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
      const evalSnap = evaluateSceneAtTime(scene, currentTime);
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
              rotationKeyframes: upsertVec3Key(baseTrack.rotationKeyframes, currentTime, nextRot, ease),
              positionKeyframes: nextPos
                ? upsertVec3Key(baseTrack.positionKeyframes, currentTime, nextPos, ease)
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
      const evalSnap = evaluateSceneAtTime(scene, currentTime);
      const prop = resolveProp(scene, cmd);
      const { char } = resolveCharacterAndNode(scene, rigNodesByInstance, cmd);
      if (char) {
        const curT = evalSnap.characters.get(char.id)?.transform ?? char.transform;
        if (autoHighlight) ctx.setSelection({ kind: 'character', instanceId: char.id });
        ctx.updateScene(
          (s) => ({
            ...s,
            characters: s.characters.map((c) =>
              c.id === char.id
                ? {
                    ...c,
                    positionKeyframes: upsertVec3Key(c.positionKeyframes, t, curT.position, ease),
                    rotationKeyframes: upsertVec3Key(c.rotationKeyframes, t, curT.rotation, ease),
                    scaleKeyframes: upsertVec3Key(c.scaleKeyframes, t, curT.scale, ease),
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
        if (autoHighlight) ctx.setSelection({ kind: 'prop', propId: prop.id });
        ctx.updateScene(
          (s) => ({
            ...s,
            props: (s.props ?? []).map((p) =>
              p.id === prop.id
                ? {
                    ...p,
                    positionKeyframes: upsertVec3Key(p.positionKeyframes, t, curT.position, ease),
                    rotationKeyframes: upsertVec3Key(p.rotationKeyframes, t, curT.rotation, ease),
                    scaleKeyframes: upsertVec3Key(p.scaleKeyframes, t, curT.scale, ease),
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

    case 'add_prop': {
      const kind: PropGeometryKind = cmd.kind ?? 'box';
      const label = cmd.name ?? `AI ${kind.charAt(0).toUpperCase() + kind.slice(1)}`;
      const color = cmd.color ?? '#e8702a';
      const prop = createPropData(kind, label, color, cmd.position?.x ?? 0, cmd.position?.z ?? 0);
      if (typeof cmd.position?.y === 'number') {
        prop.transform.position.y = cmd.position.y;
      }
      ctx.updateScene(
        (s) => ({ ...s, props: [...(s.props ?? []), prop] }),
        `AI Add Prop ${label}`,
      );
      if (autoHighlight) ctx.setSelection({ kind: 'prop', propId: prop.id });
      return { ok: true, summary: `Added ${kind} "${label}"` };
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
                  ...(cmd.color ? { color: cmd.color } : {}),
                  ...(typeof cmd.intensity === 'number' ? { intensity: cmd.intensity } : {}),
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

    case 'set_time': {
      const t = typeof cmd.time === 'number' ? Math.max(0, Math.min(scene.duration, cmd.time)) : 0;
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
