import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, lerp, inverseLerp, lerpAngleRadians, roundTo } from './math';
import { formatTimecode, clampTime } from './timeUtils';
import { createId } from './ids';

test('math helpers clamp, lerp, and interpolate angles along shortest path', () => {
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.equal(inverseLerp(10, 20, 15), 0.5);
  assert.equal(roundTo(3.141592, 2), 3.14);

  // Shortest path across PI/-PI wrap: 170 deg -> -170 deg should move +20 deg, not -340 deg
  const start = (170 * Math.PI) / 180;
  const end = (-170 * Math.PI) / 180;
  const mid = lerpAngleRadians(start, end, 0.5);
  assert.ok(Math.abs(mid - Math.PI) < 1e-6);
});

test('timeUtils formats MM:SS.CC timecodes accurately', () => {
  assert.equal(formatTimecode(0), '00:00.00');
  assert.equal(formatTimecode(65.5), '01:05.50');
  assert.equal(formatTimecode(-4), '00:00.00');
  assert.equal(clampTime(12, 10), 10);
});

test('createId generates unique prefixed identifiers', () => {
  const a = createId('char');
  const b = createId('char');
  assert.ok(a.startsWith('char_'));
  assert.notEqual(a, b);
});
