import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCameraTrack, evaluateVec3Track } from './Interpolation';
import type { CameraKeyframe, Vec3Keyframe } from '../core/types';

test('evaluateVec3Track interpolates deterministically across keyframes and supports scrubbing', () => {
  const keyframes: Vec3Keyframe[] = [
    { id: 'k1', time: 0, value: { x: 0, y: 0, z: 0 }, easing: 'linear' },
    { id: 'k2', time: 2, value: { x: 10, y: 4, z: -6 }, easing: 'linear' },
  ];

  const atZero = evaluateVec3Track(keyframes, 0, { x: 99, y: 99, z: 99 });
  assert.deepEqual(atZero, { x: 0, y: 0, z: 0 });

  const atMid = evaluateVec3Track(keyframes, 1, { x: 0, y: 0, z: 0 });
  assert.deepEqual(atMid, { x: 5, y: 2, z: -3 });

  const atPastEnd = evaluateVec3Track(keyframes, 5, { x: 0, y: 0, z: 0 });
  assert.deepEqual(atPastEnd, { x: 10, y: 4, z: -6 });
});

test('evaluateVec3Track uses shortest angular path for rotations', () => {
  const startRad = (170 * Math.PI) / 180;
  const endRad = (-170 * Math.PI) / 180;
  const keyframes: Vec3Keyframe[] = [
    { id: 'r1', time: 0, value: { x: 0, y: startRad, z: 0 }, easing: 'linear' },
    { id: 'r2', time: 2, value: { x: 0, y: endRad, z: 0 }, easing: 'linear' },
  ];

  const mid = evaluateVec3Track(keyframes, 1, { x: 0, y: 0, z: 0 }, true);
  assert.ok(Math.abs(mid.y - Math.PI) < 1e-6);
});

test('evaluateCameraTrack interpolates position, target, and fov independently', () => {
  const keyframes: CameraKeyframe[] = [
    {
      id: 'c1',
      time: 0,
      pose: { position: { x: 0, y: 2, z: 10 }, target: { x: 0, y: 1, z: 0 }, fov: 40 },
      easing: 'linear',
    },
    {
      id: 'c2',
      time: 4,
      pose: { position: { x: 4, y: 4, z: 6 }, target: { x: 2, y: 1, z: 0 }, fov: 30 },
      easing: 'linear',
    },
  ];

  const mid = evaluateCameraTrack(keyframes, 2, keyframes[0].pose);
  assert.deepEqual(mid, {
    position: { x: 2, y: 3, z: 8 },
    target: { x: 1, y: 1, z: 0 },
    fov: 35,
  });
});

test('Interpolation supports step, cubic bezier handles, number tracks, and shift/stretch/reverse', async () => {
  const { evaluateNumberTrack, shiftKeyframes, stretchKeyframes, reverseKeyframes } = await import('./Interpolation');
  const keys = [
    { id: 'a', time: 0, value: 0, easing: 'linear' as const, handleOut: { x: 0.2, y: 0.8 } },
    { id: 'b', time: 2, value: 10, easing: 'bezier' as const, handleIn: { x: 0.2, y: 0.2 } },
  ];
  const bezVal = evaluateNumberTrack(keys, 1, 0);
  assert.ok(bezVal > 5 && bezVal <= 10);

  const stepped = evaluateNumberTrack([{ id: 's1', time: 0, value: 3, easing: 'linear' }, { id: 's2', time: 2, value: 9, easing: 'step' }], 1.5, 0);
  assert.equal(stepped, 3);

  const shifted = shiftKeyframes(keys, new Set(['a', 'b']), 1);
  assert.equal(shifted[0].time, 1);
  assert.equal(shifted[1].time, 3);

  const stretched = stretchKeyframes(shifted, new Set(['a', 'b']), 2);
  assert.equal(stretched[0].time, 1);
  assert.equal(stretched[1].time, 5);

  const reversed = reverseKeyframes(shifted, new Set(['a', 'b']));
  assert.equal(reversed[0].id, 'b');
  assert.equal(reversed[1].id, 'a');
});

