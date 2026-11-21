import type { AudioEngine } from '../audio/AudioEngine';
import type { CaptionItem, SceneData } from '../core/types';
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

export function detectVideoExportCapabilities(includeAudio = true): ExportCapabilities {
  if (typeof MediaRecorder === 'undefined') {
    return { supportedMimeTypes: [] };
  }
  const candidates: { mimeType: string; label: string; ext: 'mp4' | 'webm' }[] = includeAudio
    ? [
        { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 (H.264 / AAC)', ext: 'mp4' },
        { mimeType: 'video/mp4', label: 'MP4 (Browser Native)', ext: 'mp4' },
        { mimeType: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9 / Opus)', ext: 'webm' },
        { mimeType: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8 / Opus)', ext: 'webm' },
        { mimeType: 'video/webm', label: 'WebM (Standard)', ext: 'webm' },
      ]
    : [
        { mimeType: 'video/mp4;codecs=avc1.42E01E', label: 'MP4 (H.264)', ext: 'mp4' },
        { mimeType: 'video/mp4', label: 'MP4 (Browser Native)', ext: 'mp4' },
        { mimeType: 'video/webm;codecs=vp9', label: 'WebM (VP9)', ext: 'webm' },
        { mimeType: 'video/webm;codecs=vp8', label: 'WebM (VP8)', ext: 'webm' },
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

export function pickPreferredExportFormat(
  preferred: 'auto' | 'mp4' | 'webm' = 'auto',
  includeAudio = true,
): { mimeType: string; label: string; ext: 'mp4' | 'webm' } | null {
  const caps = detectVideoExportCapabilities(includeAudio);
  const all = caps.supportedMimeTypes;
  if (all.length === 0) return null;
  if (preferred === 'mp4') {
    return all.find((c) => c.ext === 'mp4') ?? all[0];
  }
  if (preferred === 'webm') {
    return all.find((c) => c.ext === 'webm') ?? all[0];
  }
  return all[0];
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const next = `${current} ${words[i]}`;
      if (ctx.measureText(next).width <= maxWidth) {
        current = next;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export function getActiveCaptionsAtTime(
  captions: readonly CaptionItem[] | undefined,
  timeSec: number,
): CaptionItem[] {
  if (!captions || captions.length === 0) return [];
  return captions.filter(
    (c) => c.text.trim() && timeSec >= c.startTime - 0.001 && timeSec < c.startTime + Math.max(0.05, c.duration),
  );
}

/**
 * Draws active captions cleanly onto a 2D export/screenshot canvas, scaled proportionally
 * to the output frame resolution.
 */
export function renderCaptionOverlay2D(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  captions: readonly CaptionItem[] | undefined,
  timeSec: number,
): void {
  const active = getActiveCaptionsAtTime(captions, timeSec);
  if (active.length === 0) return;

  const scale = Math.max(0.55, Math.min(2.2, height / 720));
  const maxBoxWidth = Math.max(200, width * 0.84);

  const byPos = {
    top: active.filter((c) => c.style?.position === 'top'),
    center: active.filter((c) => c.style?.position === 'center'),
    bottom: active.filter((c) => !c.style?.position || c.style.position === 'bottom'),
  };

  const renderStack = (items: CaptionItem[], pos: 'top' | 'center' | 'bottom') => {
    if (items.length === 0) return;

    const renderedBlocks = items.map((cap) => {
      const baseFontPx = Math.round((cap.style?.fontSize ?? 26) * scale);
      const speakerFontPx = Math.round(baseFontPx * 0.72);
      const padX = Math.round(18 * scale);
      const padY = Math.round(10 * scale);
      const lineGap = Math.round(baseFontPx * 1.28);
      const showSpeaker = cap.style?.showSpeaker !== false && Boolean(cap.speaker?.trim());

      ctx.font = `600 ${baseFontPx}px Inter, system-ui, -apple-system, sans-serif`;
      const lines = wrapTextLines(ctx, cap.text, maxBoxWidth - padX * 2);

      let textMaxW = 0;
      for (const line of lines) {
        textMaxW = Math.max(textMaxW, ctx.measureText(line).width);
      }
      if (showSpeaker && cap.speaker) {
        ctx.font = `700 ${speakerFontPx}px Inter, system-ui, -apple-system, sans-serif`;
        textMaxW = Math.max(textMaxW, ctx.measureText(cap.speaker.toUpperCase()).width);
      }

      const speakerH = showSpeaker ? Math.round(speakerFontPx * 1.35) : 0;
      const boxW = Math.min(maxBoxWidth, Math.ceil(textMaxW + padX * 2));
      const boxH = Math.ceil(padY * 2 + speakerH + lines.length * lineGap);
      return { cap, baseFontPx, speakerFontPx, padX, padY, lineGap, showSpeaker, speakerH, lines, boxW, boxH };
    });

    const gapY = Math.round(10 * scale);
    const totalH = renderedBlocks.reduce((acc, b) => acc + b.boxH, 0) + gapY * (renderedBlocks.length - 1);
    const marginY = Math.round(36 * scale);
    let cursorY =
      pos === 'top'
        ? marginY
        : pos === 'center'
          ? Math.round((height - totalH) / 2)
          : height - marginY - totalH;

    for (const blk of renderedBlocks) {
      const boxX = Math.round((width - blk.boxW) / 2);
      ctx.save();
      drawRoundedRectPath(ctx, boxX, cursorY, blk.boxW, blk.boxH, Math.round(10 * scale));
      ctx.fillStyle = blk.cap.style?.backgroundColor || 'rgba(10, 12, 16, 0.82)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, Math.round(1.2 * scale));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.stroke();

      let textY = cursorY + blk.padY;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      if (blk.showSpeaker && blk.cap.speaker) {
        ctx.font = `700 ${blk.speakerFontPx}px Inter, system-ui, -apple-system, sans-serif`;
        ctx.fillStyle = blk.cap.style?.speakerColor || '#e8702a';
        ctx.fillText(blk.cap.speaker.toUpperCase(), width / 2, textY);
        textY += blk.speakerH;
      }

      ctx.font = `600 ${blk.baseFontPx}px Inter, system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = blk.cap.style?.textColor || '#ffffff';
      for (const line of blk.lines) {
        ctx.fillText(line, width / 2, textY);
        textY += blk.lineGap;
      }
      ctx.restore();
      cursorY += blk.boxH + gapY;
    }
  };

  renderStack(byPos.top, 'top');
  renderStack(byPos.center, 'center');
  renderStack(byPos.bottom, 'bottom');
}

export interface VideoExportOptions {
  scenes: SceneData[];
  fps: number;
  width: number;
  height: number;
  mimeType: string;
  includeAudio: boolean;
  includeCaptions?: boolean;
  steppedFrames?: boolean;
  onSceneSwitch: (sceneIndex: number, timeSec: number) => void;
  onProgress: (fraction: number, statusText: string) => void;
  signal: AbortSignal;
}

/**
 * Renders Scene Camera output + burned-in captions + mixed Web Audio stream into a downloadable video file.
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
    includeCaptions = true,
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
  const webglCanvas = engine.renderer.domElement;
  const prevViewMode = engine.getViewMode();
  const prevWidth = webglCanvas.clientWidth || 1280;
  const prevHeight = webglCanvas.clientHeight || 720;

  // Create offscreen 2D compositing canvas so WebGL output + burned-in captions record cleanly
  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = width;
  compositeCanvas.height = height;
  const ctx2d = compositeCanvas.getContext('2d');

  engine.setViewMode('scene');
  engine.resize(width, height);

  const captureSource = ctx2d ? compositeCanvas : webglCanvas;
  const videoStream = captureSource.captureStream(steppedFrames ? 0 : fps);
  const videoTrack = videoStream.getVideoTracks()[0] as MediaStreamTrack & {
    requestFrame?: () => void;
  };

  const combinedTracks: MediaStreamTrack[] = videoTrack ? [videoTrack] : [];
  let hasAudioTrack = false;
  if (includeAudio) {
    for (const sc of scenes) {
      for (const clip of sc.audioClips) {
        if (clip.assetId) audioEngine.ensureSynthAssetLoaded(clip.assetId);
      }
    }
    const audioStream = audioEngine.getExportAudioStream();
    if (audioStream && audioStream.getAudioTracks().length > 0) {
      combinedTracks.push(...audioStream.getAudioTracks());
      hasAudioTrack = true;
    }
  }

  const mixedStream = new MediaStream(combinedTracks);
  const chunks: BlobPart[] = [];

  let activeMime = mimeType;
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(mixedStream, {
      mimeType: activeMime,
      videoBitsPerSecond: 6_000_000,
    });
  } catch {
    const fallback = pickPreferredExportFormat('auto', hasAudioTrack)?.mimeType ?? 'video/webm';
    activeMime = fallback;
    recorder = new MediaRecorder(mixedStream, {
      mimeType: activeMime,
      videoBitsPerSecond: 6_000_000,
    });
  }

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
      resolve(new Blob(chunks, { type: activeMime }));
    };
  });

  recorder.start(250);
  let elapsedTotal = 0;
  const dt = 1 / Math.max(10, Math.min(60, fps));
  const stepMs = dt * 1000;

  const paintCompositeFrame = (scene: SceneData, localTime: number) => {
    engine.renderFrame();
    if (ctx2d) {
      ctx2d.clearRect(0, 0, width, height);
      ctx2d.drawImage(webglCanvas, 0, 0, width, height);
      if (includeCaptions) {
        renderCaptionOverlay2D(ctx2d, width, height, scene.captions, localTime);
      }
    }
    videoTrack?.requestFrame?.();
  };

  try {
    for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
      const scene = scenes[sIdx];
      const sceneDuration = Math.max(0.5, scene.duration);
      const profileMap = new Map(scene.characters.map((c) => [c.id, c.audioProfile]));

      if (includeAudio) {
        audioEngine.startPlayback(0, scene.audioClips, profileMap);
      }

      if (steppedFrames) {
        const totalFrames = Math.max(1, Math.ceil(sceneDuration * fps));
        for (let f = 0; f <= totalFrames; f++) {
          if (signal.aborted) throw new Error('Export cancelled.');
          const localTime = Math.min(sceneDuration, f * dt);
          onSceneSwitch(sIdx, localTime);
          if (includeAudio) {
            audioEngine.syncPlayback(localTime, scene.audioClips, profileMap);
          }
          paintCompositeFrame(scene, localTime);
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
            audioEngine.syncPlayback(localTime, scene.audioClips, profileMap);
          }
          paintCompositeFrame(scene, localTime);
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
    engine.setViewMode(prevViewMode);
    engine.resize(prevWidth, prevHeight);
  }

  return stoppedPromise;
}

export async function captureSceneFrame(
  engine: StudioEngine,
  scene: SceneData,
  timeSec: number,
  options: {
    width?: number;
    height?: number;
    includeCaptions?: boolean;
    mimeType?: 'image/png' | 'image/jpeg';
    quality?: number;
    onEvaluateAtTime: (t: number) => void;
  },
): Promise<{ blob: Blob; dataUrl: string; width: number; height: number; mimeType: string }> {
  const width = Math.max(160, Math.min(1920, Math.round(options.width ?? 1280)));
  const height = Math.max(90, Math.min(1080, Math.round(options.height ?? 720)));
  const includeCaptions = options.includeCaptions !== false;
  const mimeType = options.mimeType ?? 'image/jpeg';
  const quality = options.quality ?? 0.85;

  const webglCanvas = engine.renderer.domElement;
  const prevViewMode = engine.getViewMode();
  const prevWidth = webglCanvas.clientWidth || 1280;
  const prevHeight = webglCanvas.clientHeight || 720;

  try {
    engine.setViewMode('scene');
    engine.resize(width, height);
    options.onEvaluateAtTime(timeSec);
    engine.renderFrame();

    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx2d = outCanvas.getContext('2d');
    if (ctx2d) {
      ctx2d.drawImage(webglCanvas, 0, 0, width, height);
      if (includeCaptions) {
        renderCaptionOverlay2D(ctx2d, width, height, scene.captions, timeSec);
      }
    }

    const dataUrl = outCanvas.toDataURL(mimeType, quality);
    const blob = await new Promise<Blob>((resolve, reject) => {
      outCanvas.toBlob(
        (b) => {
          if (b) resolve(b);
          else reject(new Error('Failed to encode captured frame.'));
        },
        mimeType,
        quality,
      );
    });
    return { blob, dataUrl, width, height, mimeType };
  } finally {
    engine.setViewMode(prevViewMode);
    engine.resize(prevWidth, prevHeight);
  }
}
