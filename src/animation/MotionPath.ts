import type { MotionPathCurveType, MotionPathData, MotionPathPoint, Vec3 } from '../core/types';
import { clamp, lerp } from '../utils/math';

export interface MotionPathSample {
  position: Vec3;
  tangent: Vec3;
  headingYaw: number;
  pitch: number;
  bankRoll: number;
}

function evalCubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function evalCubicBezierDerivative(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

function evalQuadraticBezier(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

function evalQuadraticBezierDerivative(p0: number, p1: number, p2: number, t: number): number {
  return 2 * (1 - t) * (p1 - p0) + 2 * t * (p2 - p1);
}

function evalCatmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function evalCatmullRomDerivative(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  return (
    0.5 *
    ((-p0 + p2) +
      2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t +
      3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2)
  );
}

function evaluateSegment(
  points: readonly MotionPathPoint[],
  segIndex: number,
  localT: number,
  curveType: MotionPathCurveType,
  closed: boolean,
): { position: Vec3; derivative: Vec3 } {
  const n = points.length;
  const a = points[segIndex];
  const b = points[(segIndex + 1) % n];

  if (curveType === 'catmullrom') {
    const prevIdx = closed ? (segIndex - 1 + n) % n : Math.max(0, segIndex - 1);
    const nextIdx = closed ? (segIndex + 2) % n : Math.min(n - 1, segIndex + 2);
    const pPrev = points[prevIdx].position;
    const p0 = a.position;
    const p1 = b.position;
    const pNext = points[nextIdx].position;

    return {
      position: {
        x: evalCatmullRom(pPrev.x, p0.x, p1.x, pNext.x, localT),
        y: evalCatmullRom(pPrev.y, p0.y, p1.y, pNext.y, localT),
        z: evalCatmullRom(pPrev.z, p0.z, p1.z, pNext.z, localT),
      },
      derivative: {
        x: evalCatmullRomDerivative(pPrev.x, p0.x, p1.x, pNext.x, localT),
        y: evalCatmullRomDerivative(pPrev.y, p0.y, p1.y, pNext.y, localT),
        z: evalCatmullRomDerivative(pPrev.z, p0.z, p1.z, pNext.z, localT),
      },
    };
  }

  if (curveType === 'quadratic') {
    // Use midpoint of handleOut & handleIn control points if sharp/edited, else a.handleOut
    const c1: Vec3 = {
      x: lerp(a.position.x + a.handleOut.x, b.position.x + b.handleIn.x, 0.5),
      y: lerp(a.position.y + a.handleOut.y, b.position.y + b.handleIn.y, 0.5),
      z: lerp(a.position.z + a.handleOut.z, b.position.z + b.handleIn.z, 0.5),
    };
    return {
      position: {
        x: evalQuadraticBezier(a.position.x, c1.x, b.position.x, localT),
        y: evalQuadraticBezier(a.position.y, c1.y, b.position.y, localT),
        z: evalQuadraticBezier(a.position.z, c1.z, b.position.z, localT),
      },
      derivative: {
        x: evalQuadraticBezierDerivative(a.position.x, c1.x, b.position.x, localT),
        y: evalQuadraticBezierDerivative(a.position.y, c1.y, b.position.y, localT),
        z: evalQuadraticBezierDerivative(a.position.z, c1.z, b.position.z, localT),
      },
    };
  }

  // Default: Cubic Bezier
  const p0 = a.position;
  const p1: Vec3 = {
    x: a.position.x + a.handleOut.x,
    y: a.position.y + a.handleOut.y,
    z: a.position.z + a.handleOut.z,
  };
  const p2: Vec3 = {
    x: b.position.x + b.handleIn.x,
    y: b.position.y + b.handleIn.y,
    z: b.position.z + b.handleIn.z,
  };
  const p3 = b.position;

  return {
    position: {
      x: evalCubicBezier(p0.x, p1.x, p2.x, p3.x, localT),
      y: evalCubicBezier(p0.y, p1.y, p2.y, p3.y, localT),
      z: evalCubicBezier(p0.z, p1.z, p2.z, p3.z, localT),
    },
    derivative: {
      x: evalCubicBezierDerivative(p0.x, p1.x, p2.x, p3.x, localT),
      y: evalCubicBezierDerivative(p0.y, p1.y, p2.y, p3.y, localT),
      z: evalCubicBezierDerivative(p0.z, p1.z, p2.z, p3.z, localT),
    },
  };
}

/**
 * Evaluates Cubic Bezier, Quadratic Bezier, or Catmull-Rom spline motion path (open or closed)
 * at a given timeline timestamp, supporting speed multiplier, scrub override, and banking.
 */
export function evaluateMotionPathAtTime(path: MotionPathData, time: number): MotionPathSample | null {
  if (!path.enabled || path.points.length < 2) return null;
  const duration = Math.max(0.01, path.duration);
  const speed = Math.max(0.1, path.speedMultiplier ?? 1);
  const rawProgress =
    typeof path.scrubProgress === 'number'
      ? clamp(path.scrubProgress, 0, 1)
      : clamp(((time - path.startTime) * speed) / duration, 0, 1);

  return evaluateMotionPathAtProgress(
    path.points,
    rawProgress,
    path.curveType ?? 'cubic',
    Boolean(path.closed),
    path.banking ?? 0,
  );
}

export function evaluateMotionPathAtProgress(
  points: readonly MotionPathPoint[],
  progress: number,
  curveType: MotionPathCurveType = 'cubic',
  closed = false,
  banking = 0,
): MotionPathSample {
  if (points.length === 0) {
    return { position: { x: 0, y: 0, z: 0 }, tangent: { x: 0, y: 0, z: 1 }, headingYaw: 0, pitch: 0, bankRoll: 0 };
  }
  if (points.length === 1) {
    return {
      position: { ...points[0].position },
      tangent: { x: 0, y: 0, z: 1 },
      headingYaw: 0,
      pitch: 0,
      bankRoll: 0,
    };
  }

  const segCount = closed ? points.length : points.length - 1;
  const p = clamp(progress, 0, 1);
  const scaled = p * segCount;
  const segIndex = Math.min(segCount - 1, Math.floor(scaled));
  const localT = scaled - segIndex;

  const { position, derivative } = evaluateSegment(points, segIndex, localT, curveType, closed);
  const len = Math.hypot(derivative.x, derivative.y, derivative.z) || 1;
  const tangent: Vec3 = {
    x: derivative.x / len,
    y: derivative.y / len,
    z: derivative.z / len,
  };
  const headingYaw = Math.atan2(derivative.x, derivative.z);
  const horiz = Math.hypot(derivative.x, derivative.z) || 1e-5;
  const pitch = Math.atan2(-derivative.y, horiz);

  let bankRoll = 0;
  if (Math.abs(banking) > 1e-4) {
    const eps = 0.025;
    const pBefore = clamp(p - eps, 0, 1) * segCount;
    const pAfter = clamp(p + eps, 0, 1) * segCount;
    const idxA = Math.min(segCount - 1, Math.floor(pBefore));
    const idxB = Math.min(segCount - 1, Math.floor(pAfter));
    const dA = evaluateSegment(points, idxA, pBefore - idxA, curveType, closed).derivative;
    const dB = evaluateSegment(points, idxB, pAfter - idxB, curveType, closed).derivative;
    let dYaw = Math.atan2(dB.x, dB.z) - Math.atan2(dA.x, dA.z);
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    bankRoll = clamp(-dYaw * 2.2 * banking, -0.65, 0.65);
  }

  return { position, tangent, headingYaw, pitch, bankRoll };
}

/**
 * Generates polyline sample points along the spline for 3D viewport rendering.
 */
export function sampleMotionPathCurve(
  points: readonly MotionPathPoint[],
  samplesPerSegment = 20,
  curveType: MotionPathCurveType = 'cubic',
  closed = false,
): Vec3[] {
  if (points.length < 2) return points.map((p) => ({ ...p.position }));
  const segCount = closed ? points.length : points.length - 1;
  const result: Vec3[] = [];
  const totalSteps = segCount * samplesPerSegment;
  for (let i = 0; i <= totalSteps; i++) {
    const sample = evaluateMotionPathAtProgress(points, i / totalSteps, curveType, closed, 0);
    result.push(sample.position);
  }
  return result;
}

/**
 * Mirrors opposite handle when point is marked smooth, or preserves broken corner when sharp.
 */
export function updatePointWithHandleSymmetry(
  point: MotionPathPoint,
  changedHandle: 'in' | 'out',
  newOffset: Vec3,
): MotionPathPoint {
  if (!point.smooth) {
    return changedHandle === 'in'
      ? { ...point, handleIn: { ...newOffset } }
      : { ...point, handleOut: { ...newOffset } };
  }
  if (changedHandle === 'in') {
    return {
      ...point,
      handleIn: { ...newOffset },
      handleOut: { x: -newOffset.x, y: -newOffset.y, z: -newOffset.z },
    };
  }
  return {
    ...point,
    handleOut: { ...newOffset },
    handleIn: { x: -newOffset.x, y: -newOffset.y, z: -newOffset.z },
  };
}

/**
 * Reverses a motion path's waypoint order and swaps handles cleanly.
 */
export function reverseMotionPath(path: MotionPathData): MotionPathData {
  const reversed = [...path.points].reverse().map((pt) => ({
    ...pt,
    handleIn: { ...pt.handleOut },
    handleOut: { ...pt.handleIn },
  }));
  return {
    ...path,
    points: reversed,
  };
}
