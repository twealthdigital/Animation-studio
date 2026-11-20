import * as THREE from 'three';
import type {
  CharacterInstanceData,
  SceneData,
  SceneGroupData,
  ScenePropData,
  Transform3D,
} from './types';

function transformToMatrix(t: Transform3D): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(t.rotation.x, t.rotation.y, t.rotation.z, 'XYZ'),
  );
  m.compose(
    new THREE.Vector3(t.position.x, t.position.y, t.position.z),
    q,
    new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z),
  );
  return m;
}

function matrixToTransform(m: THREE.Matrix4): Transform3D {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: euler.x, y: euler.y, z: euler.z },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
}

export function composeTransforms(parent: Transform3D, child: Transform3D): Transform3D {
  const mp = transformToMatrix(parent);
  const mc = transformToMatrix(child);
  return matrixToTransform(mp.multiply(mc));
}

export function computeLocalTransformInParent(parent: Transform3D, world: Transform3D): Transform3D {
  const mpInv = transformToMatrix(parent).invert();
  const mw = transformToMatrix(world);
  return matrixToTransform(mpInv.multiply(mw));
}

export function findMemberGroup(scene: SceneData, memberId: string): SceneGroupData | null {
  return (scene.groups ?? []).find((g) => g.memberIds.includes(memberId)) ?? null;
}

export function getMemberWorldTransform(scene: SceneData, memberId: string): Transform3D | null {
  const ch = scene.characters.find((c) => c.id === memberId);
  const pr = (scene.props ?? []).find((p) => p.id === memberId);
  const member = ch ?? pr;
  if (!member) return null;
  const grp = findMemberGroup(scene, memberId);
  if (!grp) return member.transform;
  return composeTransforms(grp.transform, member.transform);
}

/**
 * Creates a logical SceneGroupData from character and/or prop IDs without breaking
 * their current world positions, rotations, or scales.
 */
export function createLogicalGroup(
  scene: SceneData,
  memberIds: string[],
  name?: string,
  groupId?: string,
): { scene: SceneData; group: SceneGroupData | null } {
  const validIds = Array.from(
    new Set(
      memberIds.filter(
        (id) =>
          scene.characters.some((c) => c.id === id) ||
          (scene.props ?? []).some((p) => p.id === id),
      ),
    ),
  );
  if (validIds.length === 0) {
    return { scene, group: null };
  }

  // First extract current world transforms of all valid members
  const worldById = new Map<string, Transform3D>();
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const id of validIds) {
    const wt = getMemberWorldTransform(scene, id)!;
    worldById.set(id, wt);
    cx += wt.position.x;
    cy += wt.position.y;
    cz += wt.position.z;
  }
  const n = validIds.length;
  const groupTransform: Transform3D = {
    position: { x: cx / n, y: cy / n, z: cz / n },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };

  const existingCount = (scene.groups ?? []).length;
  const group: SceneGroupData = {
    id: groupId ?? `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    name: name ?? `Group ${existingCount + 1}`,
    visible: true,
    locked: false,
    memberIds: validIds,
    transform: groupTransform,
    pivot: { x: 0, y: 0, z: 0 },
    positionKeyframes: [],
    rotationKeyframes: [],
    scaleKeyframes: [],
  };

  const validSet = new Set(validIds);
  // Remove validIds from any old groups and drop empty old groups
  const cleanedGroups = (scene.groups ?? [])
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => !validSet.has(m)) }))
    .filter((g) => g.memberIds.length > 0);

  // Rewrite member local transforms relative to the new group transform
  const characters: CharacterInstanceData[] = scene.characters.map((c) => {
    if (!validSet.has(c.id)) return c;
    return {
      ...c,
      transform: computeLocalTransformInParent(groupTransform, worldById.get(c.id)!),
    };
  });

  const props: ScenePropData[] = (scene.props ?? []).map((p) => {
    if (!validSet.has(p.id)) return p;
    return {
      ...p,
      transform: computeLocalTransformInParent(groupTransform, worldById.get(p.id)!),
    };
  });

  return {
    group,
    scene: {
      ...scene,
      characters,
      props,
      groups: [...cleanedGroups, group],
    },
  };
}

/**
 * Dissolves a logical group while baking its composed world transform cleanly back into each member.
 */
export function ungroupLogicalGroup(
  scene: SceneData,
  groupId: string,
): { scene: SceneData; releasedIds: string[] } {
  const grp = (scene.groups ?? []).find((g) => g.id === groupId);
  if (!grp) return { scene, releasedIds: [] };

  const memberSet = new Set(grp.memberIds);
  const characters: CharacterInstanceData[] = scene.characters.map((c) =>
    memberSet.has(c.id)
      ? { ...c, transform: composeTransforms(grp.transform, c.transform) }
      : c,
  );
  const props: ScenePropData[] = (scene.props ?? []).map((p) =>
    memberSet.has(p.id)
      ? { ...p, transform: composeTransforms(grp.transform, p.transform) }
      : p,
  );

  return {
    releasedIds: [...grp.memberIds],
    scene: {
      ...scene,
      characters,
      props,
      groups: (scene.groups ?? []).filter((g) => g.id !== groupId),
    },
  };
}

export function duplicateLogicalGroup(
  scene: SceneData,
  groupId: string,
  createIdFn: (prefix: string) => string,
  offsetX = 1.5,
): { scene: SceneData; group: SceneGroupData | null } {
  const srcGroup = (scene.groups ?? []).find((g) => g.id === groupId);
  if (!srcGroup) return { scene, group: null };

  const newMemberIds: string[] = [];
  const nextChars: CharacterInstanceData[] = [...scene.characters];
  const nextProps: ScenePropData[] = [...(scene.props ?? [])];

  for (const mId of srcGroup.memberIds) {
    const srcChar = scene.characters.find((c) => c.id === mId);
    if (srcChar) {
      const cloned: CharacterInstanceData = {
        ...(JSON.parse(JSON.stringify(srcChar)) as CharacterInstanceData),
        id: createIdFn('inst'),
        name: `${srcChar.name} Copy`,
      };
      nextChars.push(cloned);
      newMemberIds.push(cloned.id);
      continue;
    }
    const srcProp = (scene.props ?? []).find((p) => p.id === mId);
    if (srcProp) {
      const clonedProp: ScenePropData = {
        ...(JSON.parse(JSON.stringify(srcProp)) as ScenePropData),
        id: createIdFn('prop'),
        name: `${srcProp.name} Copy`,
      };
      nextProps.push(clonedProp);
      newMemberIds.push(clonedProp.id);
    }
  }

  if (newMemberIds.length === 0) return { scene, group: null };

  const clonedGroup: SceneGroupData = {
    ...(JSON.parse(JSON.stringify(srcGroup)) as SceneGroupData),
    id: createIdFn('grp'),
    name: `${srcGroup.name} Copy`,
    memberIds: newMemberIds,
    transform: {
      position: {
        x: srcGroup.transform.position.x + offsetX,
        y: srcGroup.transform.position.y,
        z: srcGroup.transform.position.z,
      },
      rotation: { ...srcGroup.transform.rotation },
      scale: { ...srcGroup.transform.scale },
    },
  };

  return {
    group: clonedGroup,
    scene: {
      ...scene,
      characters: nextChars,
      props: nextProps,
      groups: [...(scene.groups ?? []), clonedGroup],
    },
  };
}

export function isEffectiveVisible(scene: SceneData, memberId: string, ownVisible: boolean): boolean {
  if (!ownVisible) return false;
  const grp = findMemberGroup(scene, memberId);
  return grp ? grp.visible : true;
}

export function isEffectiveLocked(scene: SceneData, memberId: string, ownLocked: boolean): boolean {
  if (ownLocked) return true;
  const grp = findMemberGroup(scene, memberId);
  return grp ? grp.locked : false;
}
