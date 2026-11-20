import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './EventBus';

interface TestEvents {
  ping: number;
  message: string;
}

test('EventBus subscribes, emits, unsubscribes, and handles once', () => {
  const bus = new EventBus<TestEvents>();
  const received: number[] = [];

  const off = bus.on('ping', (n) => received.push(n));
  bus.emit('ping', 1);
  bus.emit('ping', 2);
  off();
  bus.emit('ping', 3);

  assert.deepEqual(received, [1, 2]);
  assert.equal(bus.listenerCount('ping'), 0);

  let onceCount = 0;
  bus.once('message', () => {
    onceCount += 1;
  });
  bus.emit('message', 'first');
  bus.emit('message', 'second');
  assert.equal(onceCount, 1);
});
