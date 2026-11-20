import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSceneAtTime } from './SceneEvaluator';
import { createDefaultCameraPose, createDefaultMotionPath, createDefaultTransform, type SceneData } from '../core/types';

test('evaluateSceneAtTime evaluates two independent characters, camera, and dialogue lip-sync', () => {
  const scene: SceneData = {
    id: 'sc_1',
    name: 'Scene 01',
    duration: 10,
    backgroundColor: '#16181c',
    showGrid: true,
    transition: 'cut',
    camera: {
      pose: createDefaultCameraPose(),
      keyframes: [
        { id: 'ck1', time: 0, pose: { position: { x: 0, y: 2, z: 10 }, target: { x: 0, y: 1, z: 0 }, fov: 40 }, easing: 'linear' },
        { id: 'ck2', time: 4, pose: { position: { x: 4, y: 2, z: 10 }, target: { x: 0, y: 1, z: 0 }, fov: 40 }, easing: 'linear' },
      ],
    },
    characters: [
      {
        id: 'char_a',
        assetId: 'asset_a',
        name: 'Globe',
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(-2, 0, 0),
        positionKeyframes: [
          { id: 'pk1', time: 0, value: { x: -2, y: 0, z: 0 }, easing: 'linear' },
          { id: 'pk2', time: 4, value: { x: 2, y: 0, z: 0 }, easing: 'linear' },
        ],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: createDefaultMotionPath(),
        actionClips: [
          { id: 'act1', actionId: 'hop', label: 'Hop', kind: 'gesture', startTime: 1, duration: 1.5, speed: 1 },
        ],
        currentMood: 'neutral',
        audioProfile: { voiceLabel: 'Robot Voice', defaultVolume: 1, muted: false, pan: -0.3 },
      },
      {
        id: 'char_b',
        assetId: 'asset_b',
        name: 'Host',
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(2, 0, 0),
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: createDefaultMotionPath(),
        actionClips: [
          { id: 'act2', actionId: 'wave', label: 'Wave', kind: 'gesture', startTime: 2, duration: 2, speed: 1 },
        ],
        currentMood: 'happy',
        audioProfile: { voiceLabel: 'Host Voice', defaultVolume: 1, muted: false, pan: 0.3 },
      },
    ],
    audioClips: [
      {
        id: 'aud1',
        assetId: 'a1',
        name: 'Globe Line 1',
        role: 'dialogue',
        characterInstanceId: 'char_a',
        startTime: 1,
        duration: 2,
        trimStart: 0,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: false,
      },
    ],
  };

  const stateAt2 = evaluateSceneAtTime(scene, 2);
  assert.equal(stateAt2.camera.position.x, 2);
  assert.equal(stateAt2.characters.get('char_a')?.transform.position.x, 0);
  assert.equal(stateAt2.characters.get('char_a')?.isTalking, true);
  assert.equal(stateAt2.characters.get('char_a')?.activeActions.length, 1);

  assert.equal(stateAt2.characters.get('char_b')?.transform.position.x, 2);
  assert.equal(stateAt2.characters.get('char_b')?.isTalking, false);
  assert.equal(stateAt2.characters.get('char_b')?.activeMood, 'happy');
});

test('evaluateSceneAtTime evaluates node tracks, facial keys, props with attachment, lights, and camera switches', () => {
  const scene: SceneData = {
    id: 'sc_2',
    name: 'Scene 02',
    duration: 10,
    backgroundColor: '#16181c',
    showGrid: true,
    transition: 'cut',
    camera: { pose: createDefaultCameraPose(), keyframes: [] },
    cameras: [
      { id: 'cam_1', name: 'Wide', projection: 'perspective', pose: createDefaultCameraPose(), keyframes: [] },
      { id: 'cam_2', name: 'Close', projection: 'orthographic', orthoSize: 4, pose: { position: { x: 0, y: 2, z: 4 }, target: { x: 0, y: 2, z: 0 }, fov: 28 }, keyframes: [] },
    ],
    activeCameraId: 'cam_1',
    cameraSwitches: [{ id: 'sw1', time: 2, cameraId: 'cam_2' }],
    lights: [{ id: 'l1', name: 'Spot', kind: 'spot', color: '#ffffff', intensity: 1, position: { x: 0, y: 5, z: 2 }, castShadow: true, visible: true, intensityKeyframes: [{ id: 'lk1', time: 0, value: 0, easing: 'linear' }, { id: 'lk2', time: 4, value: 2, easing: 'linear' }] }],
    props: [{ id: 'prop1', name: 'Ball', kind: 'sphere', color: '#e8702a', visible: true, transform: createDefaultTransform(1, 0, 0), positionKeyframes: [], rotationKeyframes: [], scaleKeyframes: [], motionPath: createDefaultMotionPath(), parentAttachment: { targetId: 'c1', nodeId: 'handR', offset: { x: 0, y: 0.2, z: 0 }, rotationOffset: { x: 0, y: 0, z: 0 } } }],
    characters: [
      {
        id: 'c1',
        assetId: 'a1',
        name: 'Host',
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(0, 0, 0),
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        nodeTracks: [
          {
            nodeId: 'head',
            nodeName: 'Head',
            positionKeyframes: [],
            rotationKeyframes: [
              { id: 'nk1', time: 0, value: { x: 0, y: 0, z: 0 }, easing: 'linear' },
              { id: 'nk2', time: 4, value: { x: 0, y: 1.0, z: 0 }, easing: 'linear' },
            ],
          },
        ],
        motionPath: createDefaultMotionPath(),
        actionClips: [],
        currentMood: 'neutral',
        audioProfile: { voiceLabel: 'Host', defaultVolume: 1, muted: false, pan: 0 },
      },
    ],
    audioClips: [],
  };

  const at3 = evaluateSceneAtTime(scene, 3);
  assert.equal(at3.activeCameraId, 'cam_2');
  assert.equal(at3.activeCameraProjection, 'orthographic');
  assert.equal(at3.lights.get('l1')?.intensity, 1.5);
  assert.ok(Math.abs((at3.characters.get('c1')?.nodeRotations.head?.y ?? 0) - 0.75) < 1e-5);
  assert.equal(at3.props.get('prop1')?.parentAttachment?.nodeId, 'handR');
});

test('evaluateSceneAtTime composes animated SceneGroupData transforms onto member characters and props', () => {
  const scene: SceneData = {
    id: 'sc_grp',
    name: 'Group Eval',
    duration: 10,
    backgroundColor: '#16181c',
    showGrid: true,
    transition: 'cut',
    camera: { pose: createDefaultCameraPose(), keyframes: [] },
    groups: [
      {
        id: 'grp_1',
        name: 'Stage Cluster',
        visible: false,
        locked: false,
        memberIds: ['c1', 'p1'],
        transform: createDefaultTransform(0, 0, 0),
        positionKeyframes: [
          { id: 'gk1', time: 0, value: { x: 0, y: 0, z: 0 }, easing: 'linear' },
          { id: 'gk2', time: 4, value: { x: 4, y: 0, z: 0 }, easing: 'linear' },
        ],
        rotationKeyframes: [],
        scaleKeyframes: [],
      },
    ],
    props: [
      {
        id: 'p1',
        name: 'Mic',
        kind: 'cylinder',
        color: '#ffffff',
        visible: true,
        transform: createDefaultTransform(1, 0, 0),
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: createDefaultMotionPath(),
      },
    ],
    characters: [
      {
        id: 'c1',
        assetId: 'a1',
        name: 'Host',
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(-1, 0, 0),
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

  const at2 = evaluateSceneAtTime(scene, 2);
  assert.ok(Math.abs((at2.characters.get('c1')?.transform.position.x ?? 0) - 1) < 1e-5);
  assert.ok(Math.abs((at2.props.get('p1')?.transform.position.x ?? 0) - 3) < 1e-5);
  assert.equal(at2.props.get('p1')?.visible, false);
});

