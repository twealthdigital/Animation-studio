import type { AudioEngine } from '../audio/AudioEngine';
import type { SceneData } from '../core/types';
import type { StudioEngine } from './StudioEngine';

export type ExportFormat = 'video/webm' | 'video/mp4';
export type AspectRatioPreset = '16:9' | '9:16' | '1:1' | '4:3';

export interface ExportCapabilities {
  supportedMimeTypes: { mimeType: string; label: string; ext: 'mp4' | 'webm' }[];
}

export function computeExportDimensions(
  aspectRatio: AspectRatioPreset,
  quality: '540p' | '720p' | '1080p',
): { width: number; height: number } {
  const shortSide = quality === '1080p' ? 1080 : quality === '720p' ? 720 : 540;
  switch (aspectRatio) {
    case '9:16':
      return { width: shortSide, height: Math.round((shortSide * 16) / 9) };
    case '1:1':
      return { width: shortSide, height: shortSide };
    case '4:3':
      return { width: Math.round((shortSide * 4) / 3), height: shortSide };
    case '16:9':
    default:
      return { width: Math.round((shortSide * 16) / 9), height: shortSide };
  }
}

export function detectVideoExportCapabilities(): ExportCapabilities {
  if (typeof MediaRecorder === 'undefined') {
    return { supportedMimeTypes: [] };
  }
  const candidates: { mimeType: string; label: string; ext: 'mp4' | 'webm' }[] = [
    { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 (H.264 / AAC)', ext: 'mp4' },
    { mimeType: 'video/mp4', label: 'MP4 (Browser Native)', ext: 'mp4' },
    { mimeType: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9 / Opus)', ext: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8 / Opus)', ext: 'webm' },
    { mimeType: 'video/webm', label: 'WebM (Standard)', ext: 'webm' },
  ];

  const supported = candidates.filter((c) => {
    try {
      return MediaRecorder.isTypeSupported(c.mimeType);
    } catch {
      return false;
    }
  });
  return { supportedMimeTypes: supported };
}

export interface VideoExportOptions {
  scenes: SceneData[];
  fps: number;
  width: number;
  height: number;
  mimeType: string;
  includeAudio: boolean;
  steppedFrames?: boolean; // Deterministic frame-by-frame pacing vs wall-clock
  onSceneSwitch: (sceneIndex: number, timeSec: number) => void;
  onProgress: (fraction: number, statusText: string) => void;
  signal: AbortSignal;
}

/**
 * Renders Scene Camera output + mixed Web Audio stream into a downloadable video file.
 * Supports aspect ratio sizing, real-time or deterministic stepped frame rendering,
 * and reports true browser MediaRecorder codec capabilities.
 */
export async function exportScenesToVideo(
  engine: StudioEngine,
  audioEngine: AudioEngine,
  options: VideoExportOptions,
): Promise<Blob> {
  const {
    scenes,
    fps,
    width,
    height,
    mimeType,
    includeAudio,
    steppedFrames = true,
    onSceneSwitch,
    onProgress,
    signal,
  } = options;
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder API is not supported in this browser.');
  }
  if (scenes.length === 0) {
    throw new Error('No scenes available to export.');
  }

  const totalDuration = scenes.reduce((acc, s) => acc + Math.max(0.5, s.duration), 0);
  const canvas = engine.renderer.domElement;

  const prevWidth = canvas.clientWidth || 1280;
  const prevHeight = canvas.clientHeight || 720;

  engine.setViewMode('scene');
  engine.resize(width, height);

  // Use manual captureStream(0) when steppedFrames is enabled if supported, else fps
  const videoStream = canvas.captureStream(steppedFrames ? 0 : fps);
  const videoTrack = videoStream.getVideoTracks()[0] as MediaStreamTrack & {
    requestFrame?: () => void;
  };
  const combinedTracks: MediaStreamTrack[] = videoTrack ? [videoTrack] : [];

  if (includeAudio) {
    const audioStream = audioEngine.getExportAudioStream();
    if (audioStream) {
      combinedTracks.push(...audioStream.getAudioTracks());
    }
  }

  const mixedStream = new MediaStream(combinedTracks);
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(mixedStream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
  });

  const stoppedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => reject(new Error('Video encoder encountered an error during capture.'));
    recorder.onstop = () => {
      if (signal.aborted) {
        reject(new Error('Export cancelled.'));
        return;
      }
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start(250);

  let elapsedTotal = 0;
  const dt = 1 / Math.max(10, Math.min(60, fps));
  const stepMs = dt * 1000;

  try {
    for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
      const scene = scenes[sIdx];
      const sceneDuration = Math.max(0.5, scene.duration);

      if (includeAudio) {
        const profileMap = new Map(scene.characters.map((c) => [c.id, c.audioProfile]));
        audioEngine.startPlayback(0, scene.audioClips, profileMap);
      }

      if (steppedFrames) {
        const totalFrames = Math.max(1, Math.ceil(sceneDuration * fps));
        for (let f = 0; f <= totalFrames; f++) {
          if (signal.aborted) throw new Error('Export cancelled.');
          const localTime = Math.min(sceneDuration, f * dt);
          onSceneSwitch(sIdx, localTime);
          if (includeAudio) {
            const profileMap = new Map(scene.characters.map((c) => [c.id, c.audioProfile]));
            audioEngine.syncPlayback(localTime, scene.audioClips, profileMap);
          }
          engine.renderFrame();
          videoTrack?.requestFrame?.();

          const overall = Math.min(1, (elapsedTotal + localTime) / totalDuration);
          onProgress(
            overall,
            `Frame ${f}/${totalFrames} · ${scene.name} (${localTime.toFixed(2)}s)`,
          );
          await new Promise((r) => setTimeout(r, stepMs));
        }
      } else {
        const sceneStartWall = performance.now();
        while (true) {
          if (signal.aborted) throw new Error('Export cancelled.');
          const localTime = (performance.now() - sceneStartWall) / 1000;
          if (localTime >= sceneDuration) break;
          onSceneSwitch(sIdx, localTime);
          if (includeAudio) {
            const profileMap = new Map(scene.characters.map((c) => [c.id, c.audioProfile]));
            audioEngine.syncPlayback(localTime, scene.audioClips, profileMap);
          }
          engine.renderFrame();
          const overall = Math.min(1, (elapsedTotal + localTime) / totalDuration);
          onProgress(
            overall,
            `Rendering ${scene.name} (${localTime.toFixed(1)}s / ${sceneDuration.toFixed(1)}s)`,
          );
          await new Promise((r) => setTimeout(r, stepMs));
        }
      }

      audioEngine.stopAll();
      elapsedTotal += sceneDuration;
    }

    onProgress(1, 'Finalizing video container...');
  } finally {
    audioEngine.stopAll();
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    engine.setViewMode('editor');
    engine.resize(prevWidth, prevHeight);
  }

  return stoppedPromise;
}
