import type { Vec3 } from '../core/types';
import { clamp } from '../utils/math';

export interface JointLimit {
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  minZ?: number;
  maxZ?: number;
}

export function clampEulerLimits(rot: Vec3, limit?: JointLimit): Vec3 {
  if (!limit) return { ...rot };
  return {
    x: clamp(rot.x, limit.minX ?? -Math.PI, limit.maxX ?? Math.PI),
    y: clamp(rot.y, limit.minY ?? -Math.PI, limit.maxY ?? Math.PI),
    z: clamp(rot.z, limit.minZ ?? -Math.PI, limit.maxZ ?? Math.PI),
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function len(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function norm(v: Vec3): Vec3 {
  const l = len(v);
  if (l < 1e-6) return { x: 0, y: -1, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export interface TwoBoneIkSolution {
  upperRotation: Vec3;
  lowerRotation: Vec3;
  endWorldPosition: Vec3;
  reachable: boolean;
}

/**
 * Analytic 2-bone Inverse Kinematics solver for limbs hanging along local -Y axis
 * (upper arm -> elbow -> hand, or thigh -> knee -> foot).
 * Computes parent shoulder/hip Euler angles and child elbow/knee bend angle.
 */
export function solveTwoBoneLimbIk(params: {
  rootPos: Vec3;
  upperLength: number;
  lowerLength: number;
  targetPos: Vec3;
  poleDir?: Vec3; // e.g., backward elbow (-Z) or forward knee (+Z)
  bendSign?: 1 | -1; // -1 for arm elbow flex forward, +1 for leg knee flex backward
}): TwoBoneIkSolution {
  const { rootPos, upperLength, lowerLength, targetPos, bendSign = -1 } = params;
  const l1 = Math.max(0.05, upperLength);
  const l2 = Math.max(0.05, lowerLength);

  const toTarget = sub(targetPos, rootPos);
  const rawDist = len(toTarget);
  const maxReach = (l1 + l2) * 0.995;
  const minReach = Math.abs(l1 - l2) + 0.05;
  const reachable = rawDist <= maxReach && rawDist >= minReach;
  const clampedDist = clamp(rawDist, minReach, maxReach);

  const dir = norm(toTarget);

  // Law of cosines for interior angles
  const cosShoulderOffset = clamp(
    (l1 * l1 + clampedDist * clampedDist - l2 * l2) / (2 * l1 * clampedDist),
    -1,
    1,
  );
  const shoulderOffsetAngle = Math.acos(cosShoulderOffset);

  const cosElbowInterior = clamp(
    (l1 * l1 + l2 * l2 - clampedDist * clampedDist) / (2 * l1 * l2),
    -1,
    1,
  );
  const elbowBendAngle = Math.PI - Math.acos(cosElbowInterior);

  // Decompose target direction relative to default -Y hanging limb axis
  // rotX pitches limb forward (+Z when negative X rot) / backward
  // rotZ abducts limb laterally (+X/-X)
  const down = -dir.y;
  const basePitchX = Math.atan2(dir.z, Math.max(1e-4, Math.hypot(dir.x, down))) * -1;
  // Wait: in Three.js right-handed space, rotating -Y by +rx brings tip toward +Z!
  // Check: y' = -cos(rx), z' = -sin(rx)? No: rotating (0,-1,0) by +rx around X gives (0, -cos(rx), -sin(rx))
  // Actually rotation around +X: y' = y*cos - z*sin = -cos(rx), z' = y*sin + z*cos = -sin(rx).
  // So tip z' = -sin(rx) => to reach +Z (forward), rx must be NEGATIVE!
  const aimPitchX = -Math.atan2(dir.z, down >= 0 ? Math.max(1e-4, down) : down);
  // Around +Z: x' = x*cos - y*sin = +sin(rz), y' = -cos(rz).
  // So to reach +X, rz must be POSITIVE!
  const aimRollZ = Math.atan2(dir.x, Math.hypot(dir.z, Math.abs(down)));

  const upperRotX = aimPitchX + bendSign * shoulderOffsetAngle * 0.5;
  const lowerRotX = bendSign * elbowBendAngle;

  const endWorldPosition = add(rootPos, scale(dir, clampedDist));
  void basePitchX;

  return {
    upperRotation: clampEulerLimits({ x: upperRotX, y: 0, z: aimRollZ }, {
      minX: -Math.PI * 0.9,
      maxX: Math.PI * 0.9,
      minZ: -Math.PI * 0.85,
      maxZ: Math.PI * 0.85,
    }),
    lowerRotation: clampEulerLimits({ x: lowerRotX, y: 0, z: 0 }, {
      minX: -Math.PI * 0.85,
      maxX: Math.PI * 0.85,
    }),
    endWorldPosition,
    reachable,
  };
}

/**
 * FABRIK (Forward And Backward Reaching Inverse Kinematics) iterative solver
 * for arbitrary multi-joint chains (3+ positions).
 */
export function solveFabrikChain(
  joints: readonly Vec3[],
  target: Vec3,
  iterations = 10,
  tolerance = 0.005,
): Vec3[] {
  if (joints.length < 2) return joints.map((j) => ({ ...j }));
  const pts = joints.map((j) => ({ ...j }));
  const lengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.max(1e-4, dist(pts[i], pts[i + 1]));
    lengths.push(d);
    totalLength += d;
  }

  const origin = { ...pts[0] };
  const rootToTarget = dist(origin, target);

  // Unreachable -> fully extend toward target
  if (rootToTarget >= totalLength) {
    const dir = norm(sub(target, origin));
    for (let i = 0; i < lengths.length; i++) {
      pts[i + 1] = add(pts[i], scale(dir, lengths[i]));
    }
    return pts;
  }

  for (let iter = 0; iter < iterations; iter++) {
    if (dist(pts[pts.length - 1], target) <= tolerance) break;

    // Backward pass (end effector -> root)
    pts[pts.length - 1] = { ...target };
    for (let i = pts.length - 2; i >= 0; i--) {
      const dir = norm(sub(pts[i], pts[i + 1]));
      pts[i] = add(pts[i + 1], scale(dir, lengths[i]));
    }

    // Forward pass (root -> end effector)
    pts[0] = { ...origin };
    for (let i = 0; i < pts.length - 1; i++) {
      const dir = norm(sub(pts[i + 1], pts[i]));
      pts[i + 1] = add(pts[i], scale(dir, lengths[i]));
    }
  }

  return pts;
}

/**
 * Computes clamped head Look-At Euler rotation (yaw Y, pitch X) toward target point.
 */
export function solveHeadLookAtRotation(headPos: Vec3, targetPos: Vec3): Vec3 {
  const d = sub(targetPos, headPos);
  const horiz = Math.hypot(d.x, d.z) || 1e-4;
  const yaw = clamp(Math.atan2(d.x, d.z), -1.15, 1.15);
  const pitch = clamp(-Math.atan2(d.y, horiz), -0.65, 0.65);
  return { x: pitch, y: yaw, z: 0 };
}
