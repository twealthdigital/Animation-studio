import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandManager } from './CommandManager';

test('CommandManager executes, undoes, redoes, and clears redo stack on new command', () => {
  const manager = new CommandManager();
  let value = 0;

  manager.execute({
    label: 'Add 5',
    execute: () => {
      value += 5;
    },
    undo: () => {
      value -= 5;
    },
  });
  assert.equal(value, 5);
  assert.equal(manager.canUndo(), true);
  assert.equal(manager.canRedo(), false);

  manager.execute({
    label: 'Add 3',
    execute: () => {
      value += 3;
    },
    undo: () => {
      value -= 3;
    },
  });
  assert.equal(value, 8);

  assert.equal(manager.undo(), 'Add 3');
  assert.equal(value, 5);
  assert.equal(manager.canRedo(), true);

  assert.equal(manager.redo(), 'Add 3');
  assert.equal(value, 8);

  manager.undo();
  manager.execute({
    label: 'Set 10',
    execute: () => {
      value = 10;
    },
    undo: () => {
      value = 5;
    },
  });
  assert.equal(value, 10);
  assert.equal(manager.canRedo(), false);
});
