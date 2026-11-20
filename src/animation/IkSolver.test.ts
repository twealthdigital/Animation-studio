import test from 'node:test';
import assert from 'node:assert/strict';
import { clampEulerLimits, solveFabrikChain, solveHeadLookAtRotation, solveTwoBoneLimbIk } from './IkSolver';

test('solveTwoBoneLimbIk computes valid bend angles for reachable and extended targets', () => {
  const sol = solveTwoBoneLimbIk({
    rootPos: { x: 0, y: 2, z: 0 },
    upperLength: 1,
    lowerLength: 1,
    targetPos: { x: 0.4, y: 1.0, z: 0.8 },
    bendSign: -1,
  });
  assert.equal(sol.reachable, true);
  assert.ok(Math.abs(sol.lowerRotation.x) > 0.1);
  assert.ok(Number.isFinite(sol.upperRotation.x));

  const far = solveTwoBoneLimbIk({
    rootPos: { x: 0, y: 2, z: 0 },
    upperLength: 1,
    lowerLength: 1,
    targetPos: { x: 0, y: -5, z: 0 },
  });
  assert.equal(far.reachable, false);
});

test('solveFabrikChain converges multi-joint chain to reachable target', () => {
  const joints = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: -2, z: 0 },
    { x: 0, y: -3, z: 0 },
  ];
  const target = { x: 1.2, y: -1.4, z: 0.6 };
  const solved = solveFabrikChain(joints, target, 16, 0.002);
  const end = solved[solved.length - 1];
  const err = Math.hypot(end.x - target.x, end.y - target.y, end.z - target.z);
  assert.ok(err < 0.02, `Expected FABRIK error < 0.02, got ${err}`);
  assert.deepEqual(solved[0], { x: 0, y: 0, z: 0 });
});

test('solveHeadLookAtRotation and clampEulerLimits clamp safely within anatomical range', () => {
  const look = solveHeadLookAtRotation({ x: 0, y: 2, z: 0 }, { x: 10, y: 3, z: 1 });
  assert.ok(look.y > 0 && look.y <= 1.15);
  assert.ok(look.x < 0 && look.x >= -0.65);

  const clamped = clampEulerLimits({ x: 4, y: -4, z: 0 }, { minX: -1, maxX: 1, minY: -0.5, maxY: 0.5 });
  assert.deepEqual(clamped, { x: 1, y: -0.5, z: 0 });
});
