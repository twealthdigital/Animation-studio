export type EventHandler<Payload = unknown> = (payload: Payload) => void;

/**
 * Typed publish/subscribe event bus decoupling engine, timeline, storage, and UI.
 */
export class EventBus<EventMap extends { [K in keyof EventMap]: unknown }> {
  private listeners = new Map<keyof EventMap, Set<EventHandler<never>>>();

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(handler as EventHandler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    bucket.delete(handler as EventHandler<never>);
    if (bucket.size === 0) {
      this.listeners.delete(event);
    }
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    // Snapshot so handlers unsubscribing during emit do not skip siblings.
    for (const handler of [...bucket]) {
      (handler as EventHandler<EventMap[K]>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount<K extends keyof EventMap>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
