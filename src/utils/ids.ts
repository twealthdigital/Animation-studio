let sequenceCounter = 0;

/**
 * Generates a unique identifier with a readable domain prefix.
 */
export function createId(prefix: string): string {
  sequenceCounter = (sequenceCounter + 1) % 100000;
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${sequenceCounter.toString(36)}_${randomPart}`;
}
