import test from 'node:test';
import assert from 'node:assert/strict';
import { blendPoses, buildRigCompatibilityReport, mirrorPoseRotations } from './RigMapper';
import type { RigNodeInfo } from '../core/types';

function makeNode(nodeId: string, name: string, slot?: RigNodeInfo['slot']): RigNodeInfo {
  return {
    nodeId,
    name,
    parentId: null,
    type: 'bone',
    slot,
    childIds: [],
    restPosition: { x: 0, y: 0, z: 0 },
    restRotation: { x: 0, y: 0, z: 0 },
  };
}

test('buildRigCompatibilityReport maps humanoid rigs and detects missing slots cleanly', () => {
  const nodes: RigNodeInfo[] = [
    makeNode('n_head', 'HeadPivot'),
    makeNode('n_lua', 'LeftUpperArm'),
    makeNode('n_lfa', 'LeftForearm'),
    makeNode('n_rua', 'RightUpperArm'),
    makeNode('n_rfa', 'RightForearm'),
    makeNode('n_lt', 'LeftThigh'),
    makeNode('n_ls', 'LeftShin'),
    makeNode('n_rt', 'RightThigh'),
    makeNode('n_rs', 'RightShin'),
  ];
  const report = buildRigCompatibilityReport(nodes);
  assert.equal(report.rigKind, 'humanoid');
  assert.equal(report.supportsArmIk, true);
  assert.equal(report.supportsLegIk, true);
  assert.equal(report.supportsHeadLookAt, true);
  assert.equal(report.missingSlots.length, 0);

  const mirrored = mirrorPoseRotations(
    { n_lua: { x: -0.6, y: 0.2, z: 0.4 }, n_rua: { x: 0, y: 0, z: 0 } },
    report.mappedSlots,
  );
  assert.equal(mirrored.n_rua.x, -0.6);
  assert.equal(mirrored.n_rua.z, -0.4);

  const blended = blendPoses(
    { n_head: { x: 0, y: 0, z: 0 } },
    { n_head: { x: 1, y: 0.5, z: -0.5 } },
    0.5,
  );
  assert.deepEqual(blended.n_head, { x: 0.5, y: 0.25, z: -0.25 });
});
