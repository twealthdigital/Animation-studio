import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blendPresetDeltas,
  evaluateMotionPresetAtTime,
  generateTabPredictions,
  LocalSmartAnimationAssistant,
  MOTION_PRESETS,
  UnconfiguredExternalAiProvider,
} from './MotionPresets';
import {
  createDefaultCameraPose,
  createDefaultMotionPath,
  createDefaultTransform,
  type RigCompatibilityReport,
  type RigNodeInfo,
  type SceneData,
} from '../core/types';

test('MOTION_PRESETS evaluates rig-mapped and root motion deltas with crossfade blending', () => {
  assert.ok(MOTION_PRESETS.length >= 16);
  const wave = evaluateMotionPresetAtTime('wave', 0.8, 1.6, 1);
  assert.ok(wave.slotRotations.rightUpperArm);
  assert.ok(Math.abs(wave.slotRotations.rightUpperArm.z) > 1.0);

  const jump = evaluateMotionPresetAtTime('jump', 0.6, 1.2, 1);
  assert.ok(jump.rootPosOffset.y > 0.5);

  const blended = blendPresetDeltas([
    { presetId: 'walk', localTime: 0.5, duration: 2, speed: 1, blendIn: 0.2, blendOut: 0.2, weight: 1 },
    { presetId: 'wave', localTime: 0.5, duration: 2, speed: 1, blendIn: 0.2, blendOut: 0.2, weight: 0.5 },
  ]);
  assert.ok(blended.slotRotations.leftThigh);
  assert.ok(blended.slotRotations.rightUpperArm);
});

test('LocalSmartAnimationAssistant provides contextual tips and external AI provider stays honest', () => {
  const path = createDefaultMotionPath();
  path.enabled = true;
  path.orientAlongPath = false;

  const scene: SceneData = {
    id: 'sc',
    name: 'Test',
    duration: 8,
    backgroundColor: '#16181c',
    showGrid: true,
    transition: 'cut',
    camera: { pose: createDefaultCameraPose(), keyframes: [] },
    characters: [
      {
        id: 'c1',
        assetId: 'a1',
        name: 'Host',
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(),
        positionKeyframes: [{ id: 'k1', time: 0, value: { x: 0, y: 0, z: 0 }, easing: 'linear' }],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: path,
        actionClips: [],
        currentMood: 'neutral',
        audioProfile: { voiceLabel: 'V', defaultVolume: 1, muted: false, pan: 0 },
      },
    ],
    audioClips: [],
  };

  const assistant = new LocalSmartAnimationAssistant();
  const tips = assistant.suggestSceneImprovements(scene, scene.characters[0]);
  assert.ok(tips.some((t) => t.actionKind === 'add-walk'));
  assert.ok(tips.some((t) => t.actionKind === 'enable-orient'));
  assert.ok(tips.some((t) => t.actionKind === 'add-camera-key'));

  const ext = new UnconfiguredExternalAiProvider();
  assert.equal(ext.isConfigured, false);
  assert.match(ext.getStatusMessage(), /Not connected/i);
});

test('generateTabPredictions generates bone pose suggestions and honest rigid-rig incompatibility notes', () => {
  const path = createDefaultMotionPath();
  path.enabled = true;

  const scene: SceneData = {
    id: 'sc_tab',
    name: 'Tab Scene',
    duration: 10,
    backgroundColor: '#16181c',
    showGrid: true,
    transition: 'cut',
    camera: { pose: createDefaultCameraPose(), keyframes: [] },
    characters: [
      {
        id: 'c_host',
        assetId: 'a_host',
        name: 'Host',
        visible: true,
        includeStageProps: false,
        transform: createDefaultTransform(),
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: path,
        actionClips: [],
        currentMood: 'neutral',
        audioProfile: { voiceLabel: 'Host', defaultVolume: 1, muted: false, pan: 0 },
      },
    ],
    audioClips: [],
  };

  const armNode: RigNodeInfo = {
    nodeId: 'node_arm_l',
    name: 'Left Upper Arm',
    parentId: 'node_0',
    type: 'group',
    slot: 'leftUpperArm',
    childIds: [],
    restPosition: { x: 0.8, y: 0.8, z: 0 },
    restRotation: { x: 0, y: 0, z: 0 },
  };

  const humanoidReport: RigCompatibilityReport = {
    rigKind: 'humanoid',
    mappedCount: 9,
    totalNodes: 15,
    mappedSlots: { leftUpperArm: 'node_arm_l', head: 'node_head' },
    missingSlots: [],
    supportsArmIk: true,
    supportsLegIk: true,
    supportsHeadLookAt: true,
    notes: [],
  };

  const humanoidPreds = generateTabPredictions({
    scene,
    selectedChar: scene.characters[0],
    selectedNode: armNode,
    rigReport: humanoidReport,
    currentTime: 1.5,
  });
  assert.ok(humanoidPreds.some((p) => p.compatible && p.applyKind === 'bone-pose'));
  assert.ok(humanoidPreds.some((p) => p.compatible && p.payload?.presetId === 'walk'));

  const rigidReport: RigCompatibilityReport = {
    rigKind: 'rigid',
    mappedCount: 0,
    totalNodes: 1,
    mappedSlots: {},
    missingSlots: ['head', 'leftUpperArm', 'leftForearm', 'rightUpperArm', 'rightForearm', 'leftThigh', 'leftShin', 'rightThigh', 'rightShin'],
    supportsArmIk: false,
    supportsLegIk: false,
    supportsHeadLookAt: false,
    notes: [],
  };

  const rigidPreds = generateTabPredictions({
    scene,
    selectedChar: scene.characters[0],
    selectedNode: null,
    rigReport: rigidReport,
    currentTime: 2.0,
  });
  const incompatWalk = rigidPreds.find((p) => !p.compatible);
  assert.ok(incompatWalk);
  assert.match(incompatWalk.incompatibilityReason ?? '', /rigid|no mapped/i);
  assert.ok(rigidPreds.some((p) => p.compatible && p.payload?.presetId === 'jump'));
});
