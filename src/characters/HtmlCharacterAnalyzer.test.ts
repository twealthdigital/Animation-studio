import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtmlCharacter } from './HtmlCharacterAnalyzer';

test('HtmlCharacterAnalyzer inspects Globe_character HTML accurately', () => {
  const filePath = path.resolve(process.cwd(), 'public/assets/aistudio/Globe_character_2c73ff07.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const analysis = analyzeHtmlCharacter(html, 'Globe_character_2c73ff07.html');

  assert.equal(analysis.title, 'Globe character');
  assert.equal(analysis.usesThreeJs, true);
  assert.equal(analysis.threeVersion, 'r128');
  assert.equal(analysis.recommendedMode, 'native-three-extraction');
  assert.equal(analysis.globalApiHandle, 'globe');
  assert.deepEqual(analysis.moods, ['neutral', 'happy', 'surprised', 'angry', 'sad']);
  assert.equal(analysis.supportsTalk, true);
  assert.equal(analysis.supportsSpeak, true);
  assert.equal(analysis.supportsLookAt, true);

  const actionIds = analysis.actions.map((a) => a.id);
  for (const expected of ['nod', 'shake', 'tilt', 'hop', 'spin', 'flash', 'blink', 'ring']) {
    assert.ok(actionIds.includes(expected), `Expected action "${expected}" to be detected`);
  }
});

test('HtmlCharacterAnalyzer inspects Host_character HTML accurately', () => {
  const filePath = path.resolve(process.cwd(), 'public/assets/aistudio/Host_character_ed9211ab.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const analysis = analyzeHtmlCharacter(html, 'Host_character_ed9211ab.html');

  assert.equal(analysis.title, 'Host character');
  assert.equal(analysis.usesThreeJs, true);
  assert.equal(analysis.threeVersion, 'r128');
  assert.equal(analysis.recommendedMode, 'native-three-extraction');
  assert.equal(analysis.globalApiHandle, 'guy');
  assert.deepEqual(analysis.moods, ['neutral', 'happy', 'surprised', 'angry', 'sad']);
  assert.equal(analysis.supportsTalk, true);
  assert.equal(analysis.supportsSpeak, true);
  assert.equal(analysis.supportsLookAt, true);

  const actionIds = analysis.actions.map((a) => a.id);
  for (const expected of ['nod', 'shake', 'wave', 'shrug', 'point', 'blink', 'walk']) {
    assert.ok(actionIds.includes(expected), `Expected action "${expected}" to be detected`);
  }
});

test('HtmlCharacterAnalyzer falls back to isolated iframe mode for non-Three.js HTML', () => {
  const html = '<!doctype html><html><head><title>Custom 2D Rig</title></head><body><canvas></canvas></body></html>';
  const analysis = analyzeHtmlCharacter(html);

  assert.equal(analysis.usesThreeJs, false);
  assert.equal(analysis.recommendedMode, 'isolated-iframe');
  assert.ok(analysis.warnings.length > 0);
});
