import type { AudioClipData, CharacterAudioProfile } from '../core/types';
import { clamp } from '../utils/math';

export function computeWaveformPeaks(buffer: AudioBuffer, binCount = 120): number[] {
  const channels = buffer.numberOfChannels;
  if (channels === 0 || buffer.length === 0 || binCount <= 0) {
    return [];
  }
  const data = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(data.length / binCount));
  const peaks: number[] = [];
  for (let i = 0; i < binCount; i++) {
    const start = i * blockSize;
    const end = Math.min(data.length, start + blockSize);
    let maxAbs = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > maxAbs) maxAbs = v;
    }
    peaks.push(clamp(maxAbs, 0, 1));
  }
  return peaks;
}

export interface VoiceSynthProvider {
  readonly id: string;
  readonly label: string;
  readonly isConfigured: boolean;
  getStatusText(): string;
  speakPreview(text: string, opts?: { pitch?: number; rate?: number }): void;
}

export class WebSpeechFallbackProvider implements VoiceSynthProvider {
  readonly id = 'webspeech';
  readonly label = 'Browser Speech Synthesis (Fallback)';
  get isConfigured() {
    return typeof speechSynthesis !== 'undefined';
  }
  getStatusText(): string {
    return this.isConfigured
      ? 'Browser SpeechSynthesis fallback ready for live dialogue preview.'
      : 'SpeechSynthesis API is not available in this browser.';
  }
  speakPreview(text: string, opts?: { pitch?: number; rate?: number }): void {
    if (!this.isConfigured || !text.trim()) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = clamp(opts?.pitch ?? 1, 0.5, 2);
    u.rate = clamp(opts?.rate ?? 1, 0.5, 2);
    speechSynthesis.speak(u);
  }
}

export class ExternalVoiceProviderHook implements VoiceSynthProvider {
  readonly id = 'custom-hook';
  readonly label = 'External Neural Voice API (Unconfigured)';
  readonly isConfigured = false;
  getStatusText(): string {
    return 'Not configured: Connect an external TTS API endpoint to synthesize downloadable studio voice tracks. Use Microphone Recording or Audio File Import for recorded voices.';
  }
  speakPreview(): void {}
}

interface ActiveSourceNode {
  clipId: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface MicRecordingSession {
  stop: () => Promise<{ buffer: ArrayBuffer; blob: Blob; mimeType: string }>;
  cancel: () => void;
}

/**
 * Web Audio API mixing, microphone capture, amplitude lip-sync extraction,
 * and deterministic timeline synchronization engine.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private exportDest: MediaStreamAudioDestinationNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private activeNodes = new Map<string, ActiveSourceNode>();
  private lastSyncTime = 0;
  private playing = false;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);
      this.exportDest = this.ctx.createMediaStreamDestination();
      this.masterGain.connect(this.exportDest);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  getExportAudioStream(): MediaStream | null {
    this.ensureContext();
    return this.exportDest?.stream ?? null;
  }

  async startMicrophoneRecording(): Promise<MicRecordingSession> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture (getUserMedia) is unavailable in this browser context.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(100);

    return {
      stop: () =>
        new Promise((resolve, reject) => {
          recorder.onerror = () => {
            stream.getTracks().forEach((t) => t.stop());
            reject(new Error('Microphone recording error.'));
          };
          recorder.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: mimeType });
            const buffer = await blob.arrayBuffer();
            resolve({ buffer, blob, mimeType });
          };
          if (recorder.state !== 'inactive') recorder.stop();
        }),
      cancel: () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recorder.state !== 'inactive') recorder.stop();
      },
    };
  }

  async decodeAudioAsset(
    assetId: string,
    arrayBuffer: ArrayBuffer,
  ): Promise<{ buffer: AudioBuffer; duration: number; peaks: number[] }> {
    const ctx = this.ensureContext();
    const copy = arrayBuffer.slice(0);
    const buffer = await ctx.decodeAudioData(copy);
    this.buffers.set(assetId, buffer);
    const peaks = computeWaveformPeaks(buffer, 120);
    return { buffer, duration: buffer.duration, peaks };
  }

  hasBuffer(assetId: string): boolean {
    return this.buffers.has(assetId);
  }

  getBuffer(assetId: string): AudioBuffer | undefined {
    return this.buffers.get(assetId);
  }

  removeBuffer(assetId: string): void {
    this.buffers.delete(assetId);
  }

  /**
   * Samples normalized audio amplitude (0..1) for real audio-driven lip sync.
   */
  sampleClipAmplitudeAtTime(clip: AudioClipData, timelineTime: number): number {
    const buffer = this.buffers.get(clip.assetId);
    if (!buffer) {
      // Fallback syllabic envelope when text-only clip has no waveform
      const local = timelineTime - clip.startTime;
      return clamp(0.35 + 0.45 * Math.sin(local * 14) * Math.cos(local * 5.2), 0, 1);
    }
    const rate = clamp(clip.playbackRate ?? 1, 0.5, 2);
    const audioSec = clip.trimStart + Math.max(0, timelineTime - clip.startTime) * rate;
    if (audioSec < 0 || audioSec >= buffer.duration) return 0;
    const ch = buffer.getChannelData(0);
    const center = Math.floor(audioSec * buffer.sampleRate);
    const win = Math.min(512, ch.length - center);
    if (win <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < win; i++) {
      sum += Math.abs(ch[center + i]);
    }
    return clamp((sum / win) * 4.5, 0, 1);
  }

  previewClip(clip: AudioClipData, profile?: CharacterAudioProfile): void {
    const buffer = this.buffers.get(clip.assetId);
    if (!buffer) return;
    const ctx = this.ensureContext();
    this.stopClip(clip.id);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(clip.playbackRate ?? profile?.speed ?? 1, 0.5, 2);
    const gain = ctx.createGain();
    gain.gain.value = clip.muted ? 0 : clamp(clip.volume * (profile?.defaultVolume ?? 1), 0, 2);
    source.connect(gain);
    gain.connect(this.masterGain!);

    const offset = clamp(clip.trimStart, 0, Math.max(0, buffer.duration - 0.05));
    const duration = Math.min(clip.duration, buffer.duration - offset);
    source.onended = () => {
      if (this.activeNodes.get(clip.id)?.source === source) {
        this.activeNodes.delete(clip.id);
      }
    };
    source.start(0, offset, Math.max(0.05, duration));
    this.activeNodes.set(clip.id, { clipId: clip.id, source, gain });
  }

  startPlayback(
    timelineTime: number,
    clips: readonly AudioClipData[],
    characterProfiles: Map<string, CharacterAudioProfile>,
  ): void {
    this.stopAll();
    this.playing = true;
    this.lastSyncTime = timelineTime;
    this.ensureContext();
    this.scheduleActiveClips(timelineTime, clips, characterProfiles);
  }

  syncPlayback(
    timelineTime: number,
    clips: readonly AudioClipData[],
    characterProfiles: Map<string, CharacterAudioProfile>,
  ): void {
    if (!this.playing || !this.ctx) return;
    for (const clip of clips) {
      const inRange = timelineTime >= clip.startTime && timelineTime < clip.startTime + clip.duration;
      const isActive = this.activeNodes.has(clip.id);

      if (inRange && !isActive) {
        this.startClipAtTimelineTime(clip, timelineTime, characterProfiles);
      } else if (!inRange && isActive) {
        this.stopClip(clip.id);
      } else if (inRange && isActive) {
        const node = this.activeNodes.get(clip.id);
        if (node) {
          const targetGain = this.computeClipGainAtTime(clip, timelineTime, characterProfiles);
          node.gain.gain.setValueAtTime(targetGain, this.ctx.currentTime);
        }
      }
    }
    this.lastSyncTime = timelineTime;
  }

  seek(
    timelineTime: number,
    clips: readonly AudioClipData[],
    characterProfiles: Map<string, CharacterAudioProfile>,
  ): void {
    if (this.playing) {
      this.startPlayback(timelineTime, clips, characterProfiles);
    } else {
      this.stopAll();
      this.lastSyncTime = timelineTime;
    }
  }

  pause(): void {
    this.playing = false;
    this.stopAll();
  }

  stopAll(): void {
    this.playing = false;
    for (const id of [...this.activeNodes.keys()]) {
      this.stopClip(id);
    }
  }

  private scheduleActiveClips(
    timelineTime: number,
    clips: readonly AudioClipData[],
    characterProfiles: Map<string, CharacterAudioProfile>,
  ): void {
    for (const clip of clips) {
      if (timelineTime >= clip.startTime && timelineTime < clip.startTime + clip.duration) {
        this.startClipAtTimelineTime(clip, timelineTime, characterProfiles);
      }
    }
  }

  private computeClipGainAtTime(
    clip: AudioClipData,
    timelineTime: number,
    characterProfiles: Map<string, CharacterAudioProfile>,
  ): number {
    if (clip.muted) return 0;
    const profile = clip.characterInstanceId ? characterProfiles.get(clip.characterInstanceId) : undefined;
    if (profile?.muted) return 0;

    const baseVol = clamp(clip.volume * (profile?.defaultVolume ?? 1), 0, 2);
    const localTime = timelineTime - clip.startTime;
    let fadeFactor = 1;
    if (clip.fadeIn > 0 && localTime < clip.fadeIn) {
      fadeFactor = Math.min(fadeFactor, clamp(localTime / clip.fadeIn, 0, 1));
    }
    const remaining = clip.duration - localTime;
    if (clip.fadeOut > 0 && remaining < clip.fadeOut) {
      fadeFactor = Math.min(fadeFactor, clamp(remaining / clip.fadeOut, 0, 1));
    }
    return baseVol * fadeFactor;
  }

  private startClipAtTimelineTime(
    clip: AudioClipData,
    timelineTime: number,
    characterProfiles: Map<string, CharacterAudioProfile>,
  ): void {
    const buffer = this.buffers.get(clip.assetId);
    if (!buffer || !this.ctx || !this.masterGain) return;

    const profile = clip.characterInstanceId ? characterProfiles.get(clip.characterInstanceId) : undefined;
    const rate = clamp(clip.playbackRate ?? profile?.speed ?? 1, 0.5, 2);
    const localOffset = Math.max(0, timelineTime - clip.startTime) * rate;
    const bufferOffset = clip.trimStart + localOffset;
    if (bufferOffset >= buffer.duration) return;

    const remainingClip = (clip.duration - Math.max(0, timelineTime - clip.startTime)) * rate;
    const remainingBuffer = buffer.duration - bufferOffset;
    const playDuration = Math.min(remainingClip, remainingBuffer);
    if (playDuration <= 0.02) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const gain = this.ctx.createGain();
    const initialGain = this.computeClipGainAtTime(clip, timelineTime, characterProfiles);
    gain.gain.setValueAtTime(initialGain, this.ctx.currentTime);

    if (profile && Math.abs(profile.pan) > 0.01 && typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = clamp(profile.pan, -1, 1);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      source.connect(gain);
      gain.connect(this.masterGain);
    }

    source.onended = () => {
      if (this.activeNodes.get(clip.id)?.source === source) {
        this.activeNodes.delete(clip.id);
      }
    };
    source.start(0, bufferOffset, playDuration);
    this.activeNodes.set(clip.id, { clipId: clip.id, source, gain });
  }

  private stopClip(clipId: string): void {
    const active = this.activeNodes.get(clipId);
    if (!active) return;
    this.activeNodes.delete(clipId);
    try {
      active.source.stop();
      active.source.disconnect();
      active.gain.disconnect();
    } catch {
      // Ignore already stopped
    }
  }

  dispose(): void {
    this.stopAll();
    this.buffers.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
