import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyCharacterNodeMaterialOverrides,
  type BaseNodeSnapshot,
  type MaterialBaseSnapshot,
  readNodeMaterialSnapshot,
  reconcileCharacterNodeGroups,
} from './RigNodeOperations';
import type { RigNodeInfo } from '../core/types';

function makeTestRig() {
  const root = new THREE.Group();
  root.userData.rigNodeId = 'node_0';

  const sharedMat = new THREE.MeshStandardMaterial({ color: '#3366ff', roughness: 0.5, metalness: 0.2 });

  const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sharedMat);
  meshA.position.set(-2, 1, 0);
  meshA.userData.rigNodeId = 'node_1';

  const meshB = new THREE.Mesh(new THREE.SphereGeometry(0.5), sharedMat);
  meshB.position.set(2, 1, 0);
  meshB.userData.rigNodeId = 'node_2';

  const meshC = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), sharedMat);
  meshC.position.set(0, 3, 0);
  meshC.userData.rigNodeId = 'node_3';

  root.add(meshA, meshB, meshC);
  root.updateMatrixWorld(true);

  const nodeObjectMap = new Map<string, THREE.Object3D>([
    ['node_0', root],
    ['node_1', meshA],
    ['node_2', meshB],
    ['node_3', meshC],
  ]);

  const nodeBaseTransform = new Map<string, { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }>();
  const originalSnapshots = new Map<string, BaseNodeSnapshot>();
  for (const [id, obj] of nodeObjectMap.entries()) {
    nodeBaseTransform.set(id, {
      pos: obj.position.clone(),
      rot: obj.rotation.clone(),
      scale: obj.scale.clone(),
    });
    if (id !== 'node_0') {
      originalSnapshots.set(id, {
        parent: obj.parent,
        pos: obj.position.clone(),
        rot: obj.rotation.clone(),
        scale: obj.scale.clone(),
      });
    }
  }

  const baseRigNodes: RigNodeInfo[] = [
    {
      nodeId: 'node_0',
      name: 'Root',
      parentId: null,
      type: 'group',
      childIds: ['node_1', 'node_2', 'node_3'],
      restPosition: { x: 0, y: 0, z: 0 },
      restRotation: { x: 0, y: 0, z: 0 },
    },
    {
      nodeId: 'node_1',
      name: 'Left Pod',
      parentId: 'node_0',
      type: 'mesh',
      childIds: [],
      restPosition: { x: -2, y: 1, z: 0 },
      restRotation: { x: 0, y: 0, z: 0 },
    },
    {
      nodeId: 'node_2',
      name: 'Right Pod',
      parentId: 'node_0',
      type: 'mesh',
      childIds: [],
      restPosition: { x: 2, y: 1, z: 0 },
      restRotation: { x: 0, y: 0, z: 0 },
    },
    {
      nodeId: 'node_3',
      name: 'Antenna',
      parentId: 'node_0',
      type: 'mesh',
      childIds: [],
      restPosition: { x: 0, y: 3, z: 0 },
      restRotation: { x: 0, y: 0, z: 0 },
    },
  ];

  return { root, meshA, meshB, meshC, sharedMat, nodeObjectMap, nodeBaseTransform, originalSnapshots, baseRigNodes };
}

test('applyCharacterNodeMaterialOverrides edits ONLY the selected mesh even when material is shared', () => {
  const { root, meshA, meshB, nodeObjectMap } = makeTestRig();
  const baseMaterials = new WeakMap<THREE.Mesh, MaterialBaseSnapshot[]>();

  applyCharacterNodeMaterialOverrides(
    root,
    nodeObjectMap,
    {
      node_1: { color: '#ff2200', roughness: 0.15, opacity: 0.8 },
    },
    baseMaterials,
  );

  const snapA = readNodeMaterialSnapshot(meshA);
  const snapB = readNodeMaterialSnapshot(meshB);
  assert.equal(snapA?.color, '#ff2200');
  assert.ok(Math.abs((snapA?.roughness ?? 0) - 0.15) < 1e-4);
  assert.equal(snapB?.color, '#3366ff', 'Sibling mesh sharing original material must stay unchanged');

  // Resetting removes override cleanly
  applyCharacterNodeMaterialOverrides(root, nodeObjectMap, {}, baseMaterials);
  assert.equal(readNodeMaterialSnapshot(meshA)?.color, '#3366ff');
});

test('reconcileCharacterNodeGroups creates locked centroid pivot and restores parents cleanly on ungroup', () => {
  const { root, meshA, meshB, meshC, nodeObjectMap, nodeBaseTransform, originalSnapshots, baseRigNodes } =
    makeTestRig();
  const activeGroupPivots = new Map<string, THREE.Group>();

  const groupedNodes = reconcileCharacterNodeGroups({
    instanceId: 'inst_1',
    rootContainer: root,
    baseRigNodes,
    nodeObjectMap,
    nodeBaseTransform,
    originalSnapshots,
    activeGroupPivots,
    groups: [
      {
        id: 'cgrp_1',
        name: 'Pod Pair',
        memberNodeIds: ['node_1', 'node_2'],
        visible: true,
        locked: false,
      },
    ],
  });

  const grpPivot = nodeObjectMap.get('cgrp_1');
  assert.ok(grpPivot, 'Group pivot must be registered');
  assert.equal(meshA.parent, grpPivot);
  assert.equal(meshB.parent, grpPivot);
  assert.equal(meshC.parent, root, 'Unselected mesh remains on root');

  // Centroid of (-2,1,0) and (2,1,0) should be (0,1,0)
  assert.ok(Math.abs(grpPivot.position.x) < 1e-4);
  assert.ok(Math.abs(grpPivot.position.y - 1) < 1e-4);

  // World positions of meshA & meshB are preserved without detaching or jumping
  grpPivot.updateMatrixWorld(true);
  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();
  meshA.getWorldPosition(worldA);
  meshB.getWorldPosition(worldB);
  assert.ok(Math.abs(worldA.x - -2) < 1e-4);
  assert.ok(Math.abs(worldB.x - 2) < 1e-4);

  // Rotating group moves both pods rigidly together
  grpPivot.rotation.z = Math.PI / 2;
  grpPivot.updateMatrixWorld(true);
  meshA.getWorldPosition(worldA);
  meshB.getWorldPosition(worldB);
  assert.ok(Math.abs(worldA.y - -1) < 1e-4);
  assert.ok(Math.abs(worldB.y - 3) < 1e-4);

  assert.ok(groupedNodes.some((n) => n.nodeId === 'cgrp_1'));

  // Ungrouping restores original parent and rest coordinates cleanly
  const ungroupedNodes = reconcileCharacterNodeGroups({
    instanceId: 'inst_1',
    rootContainer: root,
    baseRigNodes,
    nodeObjectMap,
    nodeBaseTransform,
    originalSnapshots,
    activeGroupPivots,
    groups: [],
  });

  assert.equal(meshA.parent, root);
  assert.equal(meshB.parent, root);
  assert.equal(meshA.position.x, -2);
  assert.equal(meshB.position.x, 2);
  assert.equal(nodeObjectMap.has('cgrp_1'), false);
  assert.equal(ungroupedNodes.some((n) => n.nodeId === 'cgrp_1'), false);
});
