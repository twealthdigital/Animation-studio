import { clamp } from './math';

/**
 * Formats seconds as MM:SS.CC (centiseconds) with fixed width for tabular displays.
 */
export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalCentis = Math.round(safe * 100);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60);

  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

export function clampTime(seconds: number, duration: number): number {
  return clamp(Number.isFinite(seconds) ? seconds : 0, 0, Math.max(0, duration));
}
