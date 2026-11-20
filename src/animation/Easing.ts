import type { BezierHandle2D, EasingType } from '../core/types';
import { clamp } from '../utils/math';

function sampleCubicBezier1D(u: number, p1: number, p2: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * u * p1 + 3 * inv * u * u * p2 + u * u * u;
}

function sampleCubicBezierDerivative1D(u: number, p1: number, p2: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * p1 + 6 * inv * u * (p2 - p1) + 3 * u * u * (1 - p2);
}

/**
 * Evaluates a 2D cubic Bezier timing curve y(x) for normalized x in [0, 1]
 * with control points (x1, y1) and (x2, y2).
 */
export function evaluateCubicBezierCurve(
  x: number,
  x1 = 0.25,
  y1 = 0.1,
  x2 = 0.25,
  y2 = 1.0,
): number {
  const targetX = clamp(x, 0, 1);
  if (targetX <= 0) return 0;
  if (targetX >= 1) return 1;

  const cx1 = clamp(x1, 0, 1);
  const cx2 = clamp(x2, 0, 1);

  // Newton-Raphson + binary bracket fallback
  let u = targetX;
  for (let i = 0; i < 6; i++) {
    const err = sampleCubicBezier1D(u, cx1, cx2) - targetX;
    if (Math.abs(err) < 1e-5) break;
    const deriv = sampleCubicBezierDerivative1D(u, cx1, cx2);
    if (Math.abs(deriv) < 1e-5) break;
    u = clamp(u - err / deriv, 0, 1);
  }

  let lo = 0;
  let hi = 1;
  if (Math.abs(sampleCubicBezier1D(u, cx1, cx2) - targetX) > 1e-4) {
    u = targetX;
    for (let i = 0; i < 14; i++) {
      const val = sampleCubicBezier1D(u, cx1, cx2);
      if (Math.abs(val - targetX) < 1e-5) break;
      if (targetX > val) lo = u;
      else hi = u;
      u = 0.5 * (lo + hi);
    }
  }

  return sampleCubicBezier1D(u, y1, y2);
}

export function applyEasing(
  t: number,
  easing: EasingType,
  outHandle?: BezierHandle2D,
  inHandle?: BezierHandle2D,
): number {
  const x = clamp(t, 0, 1);
  switch (easing) {
    case 'linear':
      return x;
    case 'step':
      return x >= 1 ? 1 : 0;
    case 'smooth':
      return x * x * (3 - 2 * x);
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - Math.pow(1 - x, 3);
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'bezier': {
      const x1 = outHandle ? clamp(outHandle.x, 0.01, 0.99) : 0.35;
      const y1 = outHandle ? outHandle.y : 0.0;
      const x2 = inHandle ? clamp(1 - inHandle.x, 0.01, 0.99) : 0.65;
      const y2 = inHandle ? 1 - inHandle.y : 1.0;
      return evaluateCubicBezierCurve(x, x1, y1, x2, y2);
    }
    default:
      return x;
  }
}
