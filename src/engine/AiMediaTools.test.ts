import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_SYNTH_PRESETS,
  buildSynthAssetId,
  buildSynthPcmSamples,
  parseSynthAssetId,
} from '../audio/AudioEngine.ts';
import {
  buildAiSceneSnapshot,
  executeSingleAiCommand,
  type AiCommandExecutionContext,
} from './AiBridgeExecutor.ts';
import { getActiveCaptionsAtTime } from './ExportManager.ts';
import { buildSceneFromTemplate } from './PropsFactory.ts';
import type { ProjectData, SceneData } from '../core/types.ts';

function makeHarness(sceneName = 'Media Test Scene') {
  let scene: SceneData = buildSceneFromTemplate('blank-stage', sceneName);
  scene = {
    ...scene,
    characters: [
      {
        id: 'char_hero',
        assetId: 'asset_hero',
        name: 'Hero',
        visible: true,
        includeStageProps: false,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        positionKeyframes: [],
        rotationKeyframes: [],
        scaleKeyframes: [],
        motionPath: {
          enabled: false,
          startTime: 0,
          duration: 4,
          orientAlongPath: false,
          curveType: 'cubic',
          closed: false,
          banking: 0,
          lookAtTargetId: null,
          speedMultiplier: 1,
          scrubProgress: null,
          points: [],
        },
        actionClips: [],
        currentMood: 'neutral',
        audioProfile: {
          voiceLabel: 'Hero Voice',
          providerId: 'webspeech',
          pitch: 1,
          speed: 1,
          defaultVolume: 1,
          muted: false,
          pan: 0,
        },
      },
    ],
  };

  const synthCalls: string[] = [];
  const exportCalls: string[] = [];

  const ctx = (): AiCommandExecutionContext => ({
    scene,
    currentTime: 0,
    rigNodesByInstance: {},
    updateScene: (updater) => {
      scene = updater(scene);
    },
    setSelection: () => {},
    setTime: () => {},
    startPlayback: () => {},
    stopPlayback: () => {},
    setCameraPose: () => {},
    detachNode: () => {},
    ungroupCharacter: () => {},
    bakeHtmlMotion: () => {},
    addStageWall: () => {},
    registerSynthAudio: (assetId) => {
      synthCalls.push(assetId);
    },
    startVideoExport: (cmd) => {
      exportCalls.push(cmd.exportId ?? 'exp');
    },
  });

  return {
    getScene: () => scene,
    synthCalls,
    exportCalls,
    run: (cmd: Parameters<typeof executeSingleAiCommand>[1]) => executeSingleAiCommand(ctx(), cmd, false),
  };
}

describe('Procedural Audio Synth & AI Media Commands', () => {
  test('all audio synth presets produce valid bounded non-silent PCM audio and round-trip IDs', () => {
    for (const preset of AUDIO_SYNTH_PRESETS) {
      const samples = buildSynthPcmSamples(preset, 0.6, 8000);
      assert.ok(samples.length >= 4000);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        assert.ok(Number.isFinite(samples[i]));
        assert.ok(Math.abs(samples[i]) <= 1);
        peak = Math.max(peak, Math.abs(samples[i]));
      }
      assert.ok(peak > 0.02, `Preset ${preset} produced silent output`);

      const id = buildSynthAssetId(preset, 0.6);
      const parsed = parseSynthAssetId(id);
      assert.deepEqual(parsed, { preset, durationSec: 0.6 });
    }
  });

  test('add_dialogue splits "|" lines, creates synced captions, and updates/deletes cleanly', () => {
    const h = makeHarness();
    const res = h.run({
      op: 'add_dialogue',
      characterId: 'Hero',
      text: 'Hello everyone! | Welcome to the stage.',
      startTime: 1.0,
      pauseAfterSec: 0.5,
      cuePreset: 'chime',
    });
    assert.equal(res.ok, true);
    const sc = h.getScene();
    assert.equal(sc.audioClips.length, 2);
    assert.equal((sc.captions ?? []).length, 2);
    assert.equal(sc.audioClips[0].role, 'dialogue');
    assert.equal(sc.audioClips[0].characterInstanceId, 'char_hero');
    assert.equal(sc.captions?.[0].linkedAudioClipId, sc.audioClips[0].id);
    assert.equal(sc.captions?.[1].text, 'Welcome to the stage.');
    assert.ok(h.synthCalls.length >= 1);

    // Active captions lookup at time 1.2s matches first caption
    const activeAt12 = getActiveCaptionsAtTime(sc.captions, 1.2);
    assert.equal(activeAt12.length, 1);
    assert.equal(activeAt12[0].text, 'Hello everyone!');

    // Updating audio clip updates its linked caption too
    const upd = h.run({
      op: 'update_audio_clip',
      clipId: sc.audioClips[0].id,
      dialogueText: 'Hi everyone!',
      duration: 2.0,
    });
    assert.equal(upd.ok, true);
    assert.equal(h.getScene().captions?.[0].text, 'Hi everyone!');
    assert.equal(h.getScene().captions?.[0].duration, 2.0);

    // Deleting audio clip deletes its linked caption by default
    const del = h.run({
      op: 'delete_audio_clip',
      clipId: sc.audioClips[0].id,
    });
    assert.equal(del.ok, true);
    assert.equal(h.getScene().audioClips.length, 1);
    assert.equal(h.getScene().captions?.length, 1);
  });

  test('add_caption, update_caption, delete_caption, clear_captions, add_audio_clip, set_character_voice, and export_video', () => {
    const h = makeHarness();
    assert.equal(
      h.run({ op: 'add_caption', captionId: 'cap_intro', text: 'Opening Scene', speaker: 'Narrator', startTime: 0, duration: 3, captionPosition: 'top' }).ok,
      true,
    );
    assert.equal(h.getScene().captions?.[0].style?.position, 'top');

    assert.equal(
      h.run({ op: 'update_caption', captionId: 'cap_intro', text: 'Act I', duration: 4 }).ok,
      true,
    );
    assert.equal(h.getScene().captions?.[0].text, 'Act I');

    assert.equal(
      h.run({ op: 'add_audio_clip', preset: 'music-pulse', startTime: 0, duration: 12, volume: 0.4 }).ok,
      true,
    );
    assert.equal(h.getScene().audioClips[0].role, 'music');
    assert.ok(h.getScene().duration >= 12);

    assert.equal(
      h.run({ op: 'set_character_voice', characterId: 'char_hero', pitch: 1.25, speed: 1.1, voiceLabel: 'Hero Alto' }).ok,
      true,
    );
    assert.equal(h.getScene().characters[0].audioProfile.pitch, 1.25);

    assert.equal(h.run({ op: 'export_video', exportId: 'exp_test_1', aspectRatio: '16:9', quality: '720p', fps: 30 }).ok, true);
    assert.deepEqual(h.exportCalls, ['exp_test_1']);

    const project: ProjectData = {
      id: 'proj_1',
      name: 'Test Project',
      createdAt: 0,
      updatedAt: 0,
      fps: 30,
      activeSceneId: h.getScene().id,
      scenes: [h.getScene()],
      assetIds: [],
    };
    const snap = buildAiSceneSnapshot(project, h.getScene(), 0, false, { kind: 'none' }, {});
    assert.equal(snap.captions?.length, 1);
    assert.equal(snap.audioClips?.length, 1);

    assert.equal(h.run({ op: 'delete_caption', captionId: 'cap_intro' }).ok, true);
    assert.equal(h.getScene().captions?.length, 0);
  });
});
