import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composeTransforms,
  createLogicalGroup,
  duplicateLogicalGroup,
  getMemberWorldTransform,
  ungroupLogicalGroup,
} from './GroupUtils';
import { createDefaultCameraPose, createDefaultMotionPath, type SceneData } from './types';

function makeBaseScene(): SceneData {
  return {
    id: 'scene_1',
    name: 'Test Scene',
    duration: 10,
    backgroundColor: '#16181c',
    showGrid: true,
    transition: 'cut',
    camera: { pose: createDefaultCameraPose(), keyframes: [] },
    groups: [],
    props: [
      {
        id: 'prop_desk',
        name: 'Desk',
        kind: 'desk',
        color: '#8a5a36',
        visible: true,
        transform: {
          position: { x: 2, y: 0, z: 1 },
          rotation: { x: 0, y: 0.5, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: createDefaultMotionPath(),
      },
    ],
    characters: [
      {
        id: 'char_host',
        assetId: 'asset_1',
        name: 'Host',
        visible: true,
        includeStageProps: false,
        transform: {
          position: { x: -2, y: 0, z: -1 },
          rotation: { x: 0, y: -0.25, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: createDefaultMotionPath(),
        actionClips: [],
        currentMood: 'neutral',
        audioProfile: { voiceLabel: 'Host', defaultVolume: 1, muted: false, pan: 0 },
      },
    ],
    audioClips: [],
  };
}

test('createLogicalGroup preserves member world transforms and ungroup restores them after group move/rotate', () => {
  const base = makeBaseScene();
  const { scene: grouped, group } = createLogicalGroup(
    base,
    ['char_host', 'prop_desk'],
    'Broadcast Desk Pair',
    'grp_test',
  );
  assert.ok(group);
  assert.equal(group.id, 'grp_test');
  assert.deepEqual(group.memberIds, ['char_host', 'prop_desk']);
  assert.ok(Math.abs(group.transform.position.x - 0) < 1e-6);
  assert.ok(Math.abs(group.transform.position.z - 0) < 1e-6);

  // Member world transform remains identical immediately after grouping
  const hostWorld = getMemberWorldTransform(grouped, 'char_host')!;
  assert.ok(Math.abs(hostWorld.position.x - -2) < 1e-5);
  assert.ok(Math.abs(hostWorld.position.z - -1) < 1e-5);
  assert.ok(Math.abs(hostWorld.rotation.y - -0.25) < 1e-5);

  // Move & rotate the group by 90 deg around Y and +3 X
  const movedGroupScene: SceneData = {
    ...grouped,
    groups: grouped.groups!.map((g) => ({
      ...g,
      transform: {
        position: { x: 3, y: 1, z: 0 },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    })),
  };

  const movedWorld = getMemberWorldTransform(movedGroupScene, 'char_host')!;
  // (-2, 0, -1) rotated +90 deg Y -> (-1, 0, 2) + (3, 1, 0) = (2, 1, 2)
  assert.ok(Math.abs(movedWorld.position.x - 2) < 1e-4);
  assert.ok(Math.abs(movedWorld.position.y - 1) < 1e-4);
  assert.ok(Math.abs(movedWorld.position.z - 2) < 1e-4);

  const { scene: ungrouped, releasedIds } = ungroupLogicalGroup(movedGroupScene, 'grp_test');
  assert.deepEqual(releasedIds, ['char_host', 'prop_desk']);
  assert.equal(ungrouped.groups?.length, 0);
  const ungroupedHost = ungrouped.characters[0].transform;
  assert.ok(Math.abs(ungroupedHost.position.x - movedWorld.position.x) < 1e-5);
  assert.ok(Math.abs(ungroupedHost.position.y - movedWorld.position.y) < 1e-5);
  assert.ok(Math.abs(ungroupedHost.position.z - movedWorld.position.z) < 1e-5);

  const composedCheck = composeTransforms(
    movedGroupScene.groups![0].transform,
    movedGroupScene.props![0].transform,
  );
  assert.ok(Math.abs(ungrouped.props![0].transform.position.x - composedCheck.position.x) < 1e-5);
});

test('duplicateLogicalGroup clones group and members with distinct IDs and spatial offset', () => {
  const base = makeBaseScene();
  const { scene: grouped } = createLogicalGroup(
    base,
    ['char_host', 'prop_desk'],
    'Broadcast Pair',
    'grp_src',
  );

  let seq = 0;
  const { scene: duplicated, group: newGroup } = duplicateLogicalGroup(
    grouped,
    'grp_src',
    (prefix) => `${prefix}_clone_${++seq}`,
    2.25,
  );

  assert.ok(newGroup);
  assert.notEqual(newGroup.id, 'grp_src');
  assert.equal(newGroup.name, 'Broadcast Pair Copy');
  assert.equal(newGroup.memberIds.length, 2);
  assert.ok(!newGroup.memberIds.includes('char_host'));
  assert.ok(!newGroup.memberIds.includes('prop_desk'));
  assert.equal(duplicated.groups?.length, 2);
  assert.equal(duplicated.characters.length, 2);
  assert.equal(duplicated.props?.length, 2);
  assert.ok(Math.abs(newGroup.transform.position.x - (grouped.groups![0].transform.position.x + 2.25)) < 1e-6);

  // Source group remains untouched
  const srcAfter = duplicated.groups!.find((g) => g.id === 'grp_src')!;
  assert.deepEqual(srcAfter.memberIds, ['char_host', 'prop_desk']);

  // Missing group returns null safely
  const missing = duplicateLogicalGroup(grouped, 'grp_nonexistent', (p) => `${p}_x`);
  assert.equal(missing.group, null);
  assert.equal(missing.scene.groups?.length, 1);
});

