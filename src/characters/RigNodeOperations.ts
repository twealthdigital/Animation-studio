import * as THREE from 'three';
import type { CharacterNodeGroup, NodeMaterialOverride, RigNodeInfo } from '../core/types';

export interface BaseNodeSnapshot {
  parent: THREE.Object3D | null;
  pos: THREE.Vector3;
  rot: THREE.Euler;
  scale: THREE.Vector3;
}

export interface MaterialBaseSnapshot {
  colorHex: number | null;
  emissiveHex: number | null;
  emissiveIntensity: number;
  roughness: number | null;
  metalness: number | null;
  opacity: number;
  transparent: boolean;
}

function getMeshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  if (!mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function captureMaterialSnapshots(mesh: THREE.Mesh): MaterialBaseSnapshot[] {
  return getMeshMaterials(mesh).map((mat) => {
    const std = mat as THREE.MeshStandardMaterial & {
      color?: THREE.Color;
      emissive?: THREE.Color;
      emissiveIntensity?: number;
      roughness?: number;
      metalness?: number;
    };
    return {
      colorHex: std.color ? std.color.getHex() : null,
      emissiveHex: std.emissive ? std.emissive.getHex() : null,
      emissiveIntensity: typeof std.emissiveIntensity === 'number' ? std.emissiveIntensity : 0,
      roughness: typeof std.roughness === 'number' ? std.roughness : null,
      metalness: typeof std.metalness === 'number' ? std.metalness : null,
      opacity: typeof mat.opacity === 'number' ? mat.opacity : 1,
      transparent: Boolean(mat.transparent),
    };
  });
}

function ensureUniqueMeshMaterials(
  mesh: THREE.Mesh,
  baseMaterials: WeakMap<THREE.Mesh, MaterialBaseSnapshot[]>,
): MaterialBaseSnapshot[] {
  let snaps = baseMaterials.get(mesh);
  if (!snaps) {
    snaps = captureMaterialSnapshots(mesh);
    baseMaterials.set(mesh, snaps);
  }
  if (!mesh.userData.__stagecraftUniqueMat && mesh.material) {
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => m.clone())
      : mesh.material.clone();
    mesh.userData.__stagecraftUniqueMat = true;
  }
  return snaps;
}

function applyOverrideToMesh(
  mesh: THREE.Mesh,
  override: NodeMaterialOverride | undefined,
  baseMaterials: WeakMap<THREE.Mesh, MaterialBaseSnapshot[]>,
): void {
  if (!override) {
    const snaps = baseMaterials.get(mesh);
    if (!snaps) return;
    const mats = getMeshMaterials(mesh);
    mats.forEach((mat, idx) => {
      const snap = snaps[idx];
      if (!snap) return;
      const std = mat as THREE.MeshStandardMaterial & {
        color?: THREE.Color;
        emissive?: THREE.Color;
        emissiveIntensity?: number;
        roughness?: number;
        metalness?: number;
      };
      if (std.color && snap.colorHex !== null) std.color.setHex(snap.colorHex);
      if (std.emissive && snap.emissiveHex !== null) std.emissive.setHex(snap.emissiveHex);
      if (typeof std.emissiveIntensity === 'number') std.emissiveIntensity = snap.emissiveIntensity;
      if (typeof std.roughness === 'number' && snap.roughness !== null) std.roughness = snap.roughness;
      if (typeof std.metalness === 'number' && snap.metalness !== null) std.metalness = snap.metalness;
      mat.opacity = snap.opacity;
      mat.transparent = snap.transparent;
      mat.needsUpdate = true;
    });
    return;
  }

  const snaps = ensureUniqueMeshMaterials(mesh, baseMaterials);
  const mats = getMeshMaterials(mesh);
  mats.forEach((mat, idx) => {
    const snap = snaps[idx];
    const std = mat as THREE.MeshStandardMaterial & {
      color?: THREE.Color;
      emissive?: THREE.Color;
      emissiveIntensity?: number;
      roughness?: number;
      metalness?: number;
    };
    if (std.color) {
      if (override.color) std.color.set(override.color);
      else if (snap && snap.colorHex !== null) std.color.setHex(snap.colorHex);
    }
    if (std.emissive) {
      if (override.emissive) std.emissive.set(override.emissive);
      else if (snap && snap.emissiveHex !== null) std.emissive.setHex(snap.emissiveHex);
    }
    if (typeof std.emissiveIntensity === 'number') {
      if (typeof override.emissiveIntensity === 'number') std.emissiveIntensity = override.emissiveIntensity;
      else if (snap) std.emissiveIntensity = snap.emissiveIntensity;
    }
    if (typeof std.roughness === 'number') {
      if (typeof override.roughness === 'number') std.roughness = override.roughness;
      else if (snap && snap.roughness !== null) std.roughness = snap.roughness;
    }
    if (typeof std.metalness === 'number') {
      if (typeof override.metalness === 'number') std.metalness = override.metalness;
      else if (snap && snap.metalness !== null) std.metalness = snap.metalness;
    }
    if (typeof override.opacity === 'number') {
      mat.opacity = override.opacity;
      mat.transparent = override.opacity < 0.99 || Boolean(snap?.transparent);
    } else if (snap) {
      mat.opacity = snap.opacity;
      mat.transparent = snap.transparent;
    }
    mat.needsUpdate = true;
  });
}

export function applyCharacterNodeMaterialOverrides(
  rootObj: THREE.Object3D,
  nodeObjectMap: Map<string, THREE.Object3D>,
  overrides: Record<string, NodeMaterialOverride>,
  baseMaterials: WeakMap<THREE.Mesh, MaterialBaseSnapshot[]>,
): void {
  // Resolve effective override for every mesh by walking from the mesh upward to the nearest overridden ancestor node
  rootObj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    let effectiveOverride: NodeMaterialOverride | undefined;
    let cur: THREE.Object3D | null = mesh;
    while (cur) {
      const nid = typeof cur.userData.rigNodeId === 'string' ? cur.userData.rigNodeId : null;
      if (nid && overrides[nid]) {
        effectiveOverride = overrides[nid];
        break;
      }
      if (cur === rootObj) break;
      cur = cur.parent;
    }

    // Fallback check if override references a node directly via nodeObjectMap
    if (!effectiveOverride) {
      for (const [nid, ov] of Object.entries(overrides)) {
        const targetObj = nodeObjectMap.get(nid);
        if (targetObj === mesh) {
          effectiveOverride = ov;
          break;
        }
      }
    }

    applyOverrideToMesh(mesh, effectiveOverride, baseMaterials);
  });
}

export function readNodeMaterialSnapshot(
  nodeObj: THREE.Object3D | undefined,
): NodeMaterialOverride | null {
  if (!nodeObj) return null;
  let sampleMesh: THREE.Mesh | null = null;
  if ((nodeObj as THREE.Mesh).isMesh) {
    sampleMesh = nodeObj as THREE.Mesh;
  } else {
    nodeObj.traverse((c) => {
      if (!sampleMesh && (c as THREE.Mesh).isMesh) {
        sampleMesh = c as THREE.Mesh;
      }
    });
  }
  if (!sampleMesh) return null;
  const mats = getMeshMaterials(sampleMesh);
  const first = mats[0] as (THREE.MeshStandardMaterial & {
    color?: THREE.Color;
    emissive?: THREE.Color;
    emissiveIntensity?: number;
    roughness?: number;
    metalness?: number;
  }) | undefined;
  if (!first) return null;

  return {
    color: first.color ? `#${first.color.getHexString()}` : '#e8702a',
    emissive: first.emissive ? `#${first.emissive.getHexString()}` : '#000000',
    emissiveIntensity: typeof first.emissiveIntensity === 'number' ? first.emissiveIntensity : 0,
    roughness: typeof first.roughness === 'number' ? first.roughness : 0.7,
    metalness: typeof first.metalness === 'number' ? first.metalness : 0.1,
    opacity: typeof first.opacity === 'number' ? first.opacity : 1,
  };
}

function getAncestors(obj: THREE.Object3D, stopAt: THREE.Object3D): THREE.Object3D[] {
  const list: THREE.Object3D[] = [];
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    list.unshift(cur);
    if (cur === stopAt) break;
    cur = cur.parent;
  }
  return list;
}

function findLowestCommonAncestor(objects: THREE.Object3D[], root: THREE.Object3D): THREE.Object3D {
  if (objects.length === 0) return root;
  let common = getAncestors(objects[0], root);
  for (let i = 1; i < objects.length; i++) {
    const next = getAncestors(objects[i], root);
    let k = 0;
    while (k < common.length && k < next.length && common[k] === next[k]) {
      k += 1;
    }
    common = common.slice(0, k);
  }
  return common[common.length - 1] ?? root;
}

/**
 * Rebuilds locked Three.js pivot groups for CharacterNodeGroup entries without detaching
 * components from their hierarchy, and cleanly restores original parents on Ungroup/Undo.
 */
export function reconcileCharacterNodeGroups(params: {
  instanceId: string;
  rootContainer: THREE.Object3D;
  baseRigNodes: RigNodeInfo[];
  nodeObjectMap: Map<string, THREE.Object3D>;
  nodeBaseTransform: Map<string, { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }>;
  originalSnapshots: Map<string, BaseNodeSnapshot>;
  activeGroupPivots: Map<string, THREE.Group>;
  groups: CharacterNodeGroup[];
}): RigNodeInfo[] {
  const {
    instanceId,
    rootContainer,
    baseRigNodes,
    nodeObjectMap,
    nodeBaseTransform,
    originalSnapshots,
    activeGroupPivots,
    groups,
  } = params;

  // 1. Restore every original node back to its exact original parent and rest transform
  for (const [nodeId, snap] of originalSnapshots.entries()) {
    const obj = nodeObjectMap.get(nodeId);
    if (!obj) continue;
    if (snap.parent && obj.parent !== snap.parent) {
      snap.parent.add(obj);
    }
    obj.position.copy(snap.pos);
    obj.rotation.copy(snap.rot);
    obj.scale.copy(snap.scale);
    nodeBaseTransform.set(nodeId, {
      pos: snap.pos.clone(),
      rot: snap.rot.clone(),
      scale: snap.scale.clone(),
    });
  }

  // 2. Remove previously created group pivots
  for (const [grpId, pivot] of activeGroupPivots.entries()) {
    pivot.parent?.remove(pivot);
    nodeObjectMap.delete(grpId);
    nodeBaseTransform.delete(grpId);
  }
  activeGroupPivots.clear();

  const clonedNodes: RigNodeInfo[] = baseRigNodes.map((n) => ({
    ...n,
    childIds: [...n.childIds],
  }));

  if (groups.length === 0) {
    return clonedNodes;
  }

  rootContainer.updateMatrixWorld(true);

  for (const grp of groups) {
    const memberObjs = grp.memberNodeIds
      .map((id) => nodeObjectMap.get(id))
      .filter((o): o is THREE.Object3D => Boolean(o && o !== rootContainer));

    // Only keep non-ancestor members (if user selected both a parent and its child, parent brings child along)
    const memberSet = new Set(memberObjs);
    const topMembers = memberObjs.filter((obj) => {
      let cur = obj.parent;
      while (cur) {
        if (memberSet.has(cur)) return false;
        cur = cur.parent;
      }
      return true;
    });

    if (topMembers.length === 0) continue;

    // Pick lowest common ancestor of the members' parents
    const parentCandidates = topMembers.map((o) => o.parent ?? rootContainer);
    const commonAncestor = findLowestCommonAncestor(parentCandidates, rootContainer);
    commonAncestor.updateMatrixWorld(true);

    // Compute world centroid of members so group pivot sits squarely centered on the grouped assembly
    const centroidWorld = new THREE.Vector3();
    for (const m of topMembers) {
      const box = new THREE.Box3().setFromObject(m);
      const center = new THREE.Vector3();
      if (!box.isEmpty()) box.getCenter(center);
      else m.getWorldPosition(center);
      centroidWorld.add(center);
    }
    centroidWorld.divideScalar(topMembers.length);

    const pivotGroup = new THREE.Group();
    pivotGroup.name = grp.name;
    pivotGroup.userData.characterInstanceId = instanceId;
    pivotGroup.userData.rigNodeId = grp.id;
    pivotGroup.userData.rigNodeName = grp.name;
    pivotGroup.userData.isComponentGroup = true;
    pivotGroup.visible = grp.visible !== false;

    const localPivotPos = commonAncestor.worldToLocal(centroidWorld.clone());
    pivotGroup.position.copy(localPivotPos);
    commonAncestor.add(pivotGroup);
    pivotGroup.updateMatrixWorld(true);

    const attachedIds: string[] = [];
    for (const mObj of topMembers) {
      pivotGroup.attach(mObj);
      const mNodeId = typeof mObj.userData.rigNodeId === 'string' ? mObj.userData.rigNodeId : null;
      if (mNodeId) {
        attachedIds.push(mNodeId);
        nodeBaseTransform.set(mNodeId, {
          pos: mObj.position.clone(),
          rot: mObj.rotation.clone(),
          scale: mObj.scale.clone(),
        });
        const nodeEntry = clonedNodes.find((n) => n.nodeId === mNodeId);
        if (nodeEntry) {
          if (nodeEntry.parentId) {
            const oldP = clonedNodes.find((n) => n.nodeId === nodeEntry.parentId);
            if (oldP) oldP.childIds = oldP.childIds.filter((c) => c !== mNodeId);
          }
          nodeEntry.parentId = grp.id;
        }
      }
    }

    const ancestorNodeId =
      typeof commonAncestor.userData.rigNodeId === 'string' ? commonAncestor.userData.rigNodeId : 'node_0';
    const ancestorNode = clonedNodes.find((n) => n.nodeId === ancestorNodeId);
    if (ancestorNode && !ancestorNode.childIds.includes(grp.id)) {
      ancestorNode.childIds.push(grp.id);
    }

    clonedNodes.push({
      nodeId: grp.id,
      name: grp.name,
      parentId: ancestorNodeId,
      type: 'group',
      description: `Locked component group (${attachedIds.length} parts) • Move, rotate or recolor together`,
      childIds: attachedIds,
      restPosition: { x: pivotGroup.position.x, y: pivotGroup.position.y, z: pivotGroup.position.z },
      restRotation: { x: pivotGroup.rotation.x, y: pivotGroup.rotation.y, z: pivotGroup.rotation.z },
    });

    activeGroupPivots.set(grp.id, pivotGroup);
    nodeObjectMap.set(grp.id, pivotGroup);
    nodeBaseTransform.set(grp.id, {
      pos: pivotGroup.position.clone(),
      rot: pivotGroup.rotation.clone(),
      scale: pivotGroup.scale.clone(),
    });
  }

  return clonedNodes;
}
