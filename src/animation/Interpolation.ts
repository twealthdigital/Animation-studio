import type {
  CameraKeyframe,
  CameraPose,
  FacialKeyframe,
  FacialState,
  NumberKeyframe,
  Vec3,
  Vec3Keyframe,
} from '../core/types';
import { createDefaultFacialState } from '../core/types';
import { lerp, lerpAngleRadians } from '../utils/math';
import { applyEasing } from './Easing';

export function sortByTime<T extends { time: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.time - b.time);
}

export function evaluateNumberTrack(
  keyframes: readonly NumberKeyframe[],
  time: number,
  fallback: number,
): number {
  if (keyframes.length === 0) return fallback;
  const sorted = sortByTime(keyframes);
  if (time <= sorted[0].time) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return last.value;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= 1e-6) return b.value;
      const rawT = (time - a.time) / span;
      if (b.easing === 'step') return a.value;
      const t = applyEasing(rawT, b.easing, a.handleOut, b.handleIn);
      return lerp(a.value, b.value, t);
    }
  }
  return last.value;
}

export function evaluateVec3Track(
  keyframes: readonly Vec3Keyframe[],
  time: number,
  fallback: Vec3,
  isRotation = false,
): Vec3 {
  if (keyframes.length === 0) return { ...fallback };
  const sorted = sortByTime(keyframes);
  if (time <= sorted[0].time) return { ...sorted[0].value };
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return { ...last.value };

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= 1e-6) return { ...b.value };
      const rawT = (time - a.time) / span;
      if (b.easing === 'step') return { ...a.value };
      const t = applyEasing(rawT, b.easing, a.handleOut, b.handleIn);
      if (isRotation) {
        return {
          x: lerpAngleRadians(a.value.x, b.value.x, t),
          y: lerpAngleRadians(a.value.y, b.value.y, t),
          z: lerpAngleRadians(a.value.z, b.value.z, t),
        };
      }
      return {
        x: lerp(a.value.x, b.value.x, t),
        y: lerp(a.value.y, b.value.y, t),
        z: lerp(a.value.z, b.value.z, t),
      };
    }
  }
  return { ...last.value };
}

export function evaluateCameraTrack(
  keyframes: readonly CameraKeyframe[],
  time: number,
  fallback: CameraPose,
): CameraPose {
  if (keyframes.length === 0) {
    return {
      position: { ...fallback.position },
      target: { ...fallback.target },
      fov: fallback.fov,
    };
  }
  const sorted = sortByTime(keyframes);
  if (time <= sorted[0].time) {
    return {
      position: { ...sorted[0].pose.position },
      target: { ...sorted[0].pose.target },
      fov: sorted[0].pose.fov,
    };
  }
  const last = sorted[sorted.length - 1];
  if (time >= last.time) {
    return {
      position: { ...last.pose.position },
      target: { ...last.pose.target },
      fov: last.pose.fov,
    };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= 1e-6) {
        return {
          ...b.pose,
          position: { ...b.pose.position },
          target: { ...b.pose.target },
        };
      }
      const rawT = (time - a.time) / span;
      if (b.easing === 'step') {
        return {
          position: { ...a.pose.position },
          target: { ...a.pose.target },
          fov: a.pose.fov,
        };
      }
      const t = applyEasing(rawT, b.easing);
      return {
        position: {
          x: lerp(a.pose.position.x, b.pose.position.x, t),
          y: lerp(a.pose.position.y, b.pose.position.y, t),
          z: lerp(a.pose.position.z, b.pose.position.z, t),
        },
        target: {
          x: lerp(a.pose.target.x, b.pose.target.x, t),
          y: lerp(a.pose.target.y, b.pose.target.y, t),
          z: lerp(a.pose.target.z, b.pose.target.z, t),
        },
        fov: lerp(a.pose.fov, b.pose.fov, t),
      };
    }
  }
  return {
    position: { ...last.pose.position },
    target: { ...last.pose.target },
    fov: last.pose.fov,
  };
}

export function evaluateFacialTrack(
  keyframes: readonly FacialKeyframe[],
  time: number,
  fallback?: FacialState,
): FacialState {
  const base = fallback ? { ...fallback, customMorphs: { ...fallback.customMorphs } } : createDefaultFacialState();
  if (keyframes.length === 0) return base;
  const sorted = sortByTime(keyframes);
  if (time <= sorted[0].time) {
    return { ...sorted[0].state, customMorphs: { ...sorted[0].state.customMorphs } };
  }
  const last = sorted[sorted.length - 1];
  if (time >= last.time) {
    return { ...last.state, customMorphs: { ...last.state.customMorphs } };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= 1e-6) {
        return { ...b.state, customMorphs: { ...b.state.customMorphs } };
      }
      if (b.easing === 'step') {
        return { ...a.state, customMorphs: { ...a.state.customMorphs } };
      }
      const t = applyEasing((time - a.time) / span, b.easing);
      const customMorphs: Record<string, number> = {};
      const keys = new Set([
        ...Object.keys(a.state.customMorphs ?? {}),
        ...Object.keys(b.state.customMorphs ?? {}),
      ]);
      for (const k of keys) {
        customMorphs[k] = lerp(a.state.customMorphs?.[k] ?? 0, b.state.customMorphs?.[k] ?? 0, t);
      }
      return {
        blink: lerp(a.state.blink, b.state.blink, t),
        eyeLookX: lerp(a.state.eyeLookX, b.state.eyeLookX, t),
        eyeLookY: lerp(a.state.eyeLookY, b.state.eyeLookY, t),
        browRaise: lerp(a.state.browRaise, b.state.browRaise, t),
        mouthOpen: lerp(a.state.mouthOpen, b.state.mouthOpen, t),
        jawOpen: lerp(a.state.jawOpen, b.state.jawOpen, t),
        smile: lerp(a.state.smile, b.state.smile, t),
        frown: lerp(a.state.frown, b.state.frown, t),
        surprise: lerp(a.state.surprise, b.state.surprise, t),
        anger: lerp(a.state.anger, b.state.anger, t),
        sadness: lerp(a.state.sadness, b.state.sadness, t),
        fear: lerp(a.state.fear, b.state.fear, t),
        customMorphs,
      };
    }
  }
  return base;
}

/* ---------- Keyframe Batch Manipulation Helpers (Timeline & Graph Editor) ---------- */

export function shiftKeyframes<T extends { id: string; time: number }>(
  keyframes: readonly T[],
  selectedIds: ReadonlySet<string>,
  deltaSeconds: number,
  maxTime = 600,
): T[] {
  return keyframes
    .map((k) =>
      selectedIds.size === 0 || selectedIds.has(k.id)
        ? { ...k, time: Math.max(0, Math.min(maxTime, Number((k.time + deltaSeconds).toFixed(3)))) }
        : k,
    )
    .sort((a, b) => a.time - b.time);
}

export function stretchKeyframes<T extends { id: string; time: number }>(
  keyframes: readonly T[],
  selectedIds: ReadonlySet<string>,
  scaleFactor: number,
  anchorTime?: number,
): T[] {
  const targets = keyframes.filter((k) => selectedIds.size === 0 || selectedIds.has(k.id));
  if (targets.length === 0) return [...keyframes];
  const anchor = anchorTime ?? Math.min(...targets.map((k) => k.time));
  const factor = Math.max(0.1, scaleFactor);
  return keyframes
    .map((k) =>
      selectedIds.size === 0 || selectedIds.has(k.id)
        ? { ...k, time: Math.max(0, Number((anchor + (k.time - anchor) * factor).toFixed(3))) }
        : k,
    )
    .sort((a, b) => a.time - b.time);
}

export function reverseKeyframes<T extends { id: string; time: number }>(
  keyframes: readonly T[],
  selectedIds: ReadonlySet<string>,
): T[] {
  const targets = keyframes.filter((k) => selectedIds.size === 0 || selectedIds.has(k.id));
  if (targets.length < 2) return [...keyframes];
  const minT = Math.min(...targets.map((k) => k.time));
  const maxT = Math.max(...targets.map((k) => k.time));
  return keyframes
    .map((k) =>
      selectedIds.size === 0 || selectedIds.has(k.id)
        ? { ...k, time: Number((minT + (maxT - k.time)).toFixed(3)) }
        : k,
    )
    .sort((a, b) => a.time - b.time);
}

export function findAdjacentKeyframeTime(
  times: readonly number[],
  currentTime: number,
  direction: 'prev' | 'next',
): number | null {
  const unique = [...new Set(times)].sort((a, b) => a - b);
  if (direction === 'prev') {
    for (let i = unique.length - 1; i >= 0; i--) {
      if (unique[i] < currentTime - 0.015) return unique[i];
    }
    return null;
  }
  for (let i = 0; i < unique.length; i++) {
    if (unique[i] > currentTime + 0.015) return unique[i];
  }
  return null;
}
