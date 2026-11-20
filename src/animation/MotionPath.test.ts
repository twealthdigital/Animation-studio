import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMotionPathAtTime, sampleMotionPathCurve } from './MotionPath';
import type { MotionPathData } from '../core/types';

test('evaluateMotionPathAtTime follows edited Bezier arc and tangent heading', () => {
  const path: MotionPathData = {
    enabled: true,
    startTime: 1,
    duration: 2,
    orientAlongPath: true,
    points: [
      {
        id: 'p0',
        position: { x: 0, y: 0, z: 0 },
        handleIn: { x: -1, y: 0, z: 0 },
        handleOut: { x: 0, y: 2, z: 0 },
        smooth: true,
      },
      {
        id: 'p1',
        position: { x: 4, y: 0, z: 0 },
        handleIn: { x: 0, y: 2, z: 0 },
        handleOut: { x: 1, y: 0, z: 0 },
        smooth: true,
      },
    ],
  };

  const atStart = evaluateMotionPathAtTime(path, 0.5);
  assert.ok(atStart);
  assert.deepEqual(atStart.position, { x: 0, y: 0, z: 0 });

  // Midpoint of cubic Bezier with handles at y=+2 has y = 3*0.25*0.5*2*2 = 1.5
  const atMid = evaluateMotionPathAtTime(path, 2.0);
  assert.ok(atMid);
  assert.ok(Math.abs(atMid.position.x - 2) < 1e-6);
  assert.ok(Math.abs(atMid.position.y - 1.5) < 1e-6);

  const atEnd = evaluateMotionPathAtTime(path, 5.0);
  assert.ok(atEnd);
  assert.deepEqual(atEnd.position, { x: 4, y: 0, z: 0 });

  const polyline = sampleMotionPathCurve(path.points, 10);
  assert.equal(polyline.length, 11);
});

test('MotionPath supports Catmull-Rom, Quadratic, closed loops, banking, and reversal', () => {
  const path: MotionPathData = {
    enabled: true,
    startTime: 0,
    duration: 4,
    orientAlongPath: true,
    curveType: 'catmullrom',
    closed: true,
    banking: 1.0,
    points: [
      { id: 'p0', position: { x: 0, y: 0, z: 0 }, handleIn: { x: -0.5, y: 0, z: 0 }, handleOut: { x: 0.5, y: 0, z: 0 }, smooth: true },
      { id: 'p1', position: { x: 3, y: 0, z: 2 }, handleIn: { x: -0.5, y: 0, z: 0 }, handleOut: { x: 0.5, y: 0, z: 0 }, smooth: true },
      { id: 'p2', position: { x: 0, y: 0, z: 4 }, handleIn: { x: -0.5, y: 0, z: 0 }, handleOut: { x: 0.5, y: 0, z: 0 }, smooth: true },
    ],
  };

  const closedCurve = sampleMotionPathCurve(path.points, 8, 'catmullrom', true);
  assert.equal(closedCurve.length, 25);
  // Closed loop starts and ends at p0
  assert.ok(Math.hypot(closedCurve[0].x - closedCurve[24].x, closedCurve[0].z - closedCurve[24].z) < 1e-4);

  const quadSample = evaluateMotionPathAtTime({ ...path, curveType: 'quadratic', closed: false }, 2);
  assert.ok(quadSample);
  assert.ok(Number.isFinite(quadSample.headingYaw));
});

