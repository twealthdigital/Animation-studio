import type { AudioClipData, AudioSynthPreset, CharacterAudioProfile } from '../core/types';
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
  speakPreview(text: string, opts?: { pitch?: number; rate?: number; cancelExisting?: boolean }): void {
    if (!this.isConfigured || !text.trim()) return;
    if (opts?.cancelExisting !== false) {
      speechSynthesis.cancel();
    }
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = clamp(opts?.pitch ?? 1, 0.5, 2);
    u.rate = clamp(opts?.rate ?? 1, 0.5, 2);
    speechSynthesis.speak(u);
  }

  cancel(): void {
    if (!this.isConfigured) return;
    speechSynthesis.cancel();
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


export const AUDIO_SYNTH_PRESETS: AudioSynthPreset[] = [
  'chime',
  'bell',
  'pop',
  'whoosh',
  'thud',
  'footstep',
  'boom',
  'laser',
  'click',
  'success',
  'alert',
  'riser',
  'ambient-pad',
  'music-pulse',
];

export function buildSynthAssetId(preset: AudioSynthPreset, durationSec: number): string {
  const dur = clamp(Number.isFinite(durationSec) ? durationSec : 1.5, 0.15, 120);
  return `synth:${preset}:${dur.toFixed(2)}`;
}

export function parseSynthAssetId(assetId: string): { preset: AudioSynthPreset; durationSec: number } | null {
  if (!assetId || !assetId.startsWith('synth:')) return null;
  const parts = assetId.split(':');
  const preset = parts[1] as AudioSynthPreset;
  if (!AUDIO_SYNTH_PRESETS.includes(preset)) return null;
  const dur = Number(parts[2]);
  return {
    preset,
    durationSec: clamp(Number.isFinite(dur) ? dur : 1.5, 0.15, 120),
  };
}

/**
 * Pure deterministic procedural audio sample synthesis for built-in SFX, foley,
 * ambient beds, and musical cues so AI agents can generate real audible tracks
 * without external files.
 */
export function buildSynthPcmSamples(
  preset: AudioSynthPreset,
  durationSec: number,
  sampleRate = 44100,
): Float32Array {
  const dur = clamp(durationSec, 0.15, 120);
  const len = Math.max(1, Math.floor(dur * sampleRate));
  const out = new Float32Array(len);
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  let lp = 0;

  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const p = t / dur;
    const envFade = Math.min(1, t / 0.012) * Math.min(1, (dur - t) / 0.025);
    let s = 0;

    switch (preset) {
      case 'chime':
      case 'bell': {
        const base = preset === 'bell' ? 660 : 880;
        const decay = Math.exp(-t * (preset === 'bell' ? 2.6 : 4.2));
        s =
          (Math.sin(2 * Math.PI * base * t) * 0.55 +
            Math.sin(2 * Math.PI * base * 1.5 * t) * 0.25 +
            Math.sin(2 * Math.PI * base * 2.02 * t) * 0.18) *
          decay;
        break;
      }
      case 'pop': {
        const freq = 220 + 580 * Math.exp(-t * 36);
        s = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 28) * 0.75;
        break;
      }
      case 'click': {
        s = (nextRand() * 0.5 + Math.sin(2 * Math.PI * 1600 * t) * 0.5) * Math.exp(-t * 80) * 0.8;
        break;
      }
      case 'whoosh': {
        const noise = nextRand();
        lp = lp * 0.88 + noise * 0.12;
        const swell = Math.sin(Math.PI * p);
        s = lp * swell * 0.85;
        break;
      }
      case 'thud':
      case 'boom': {
        const f0 = preset === 'boom' ? 110 : 140;
        const f1 = preset === 'boom' ? 32 : 45;
        const freq = f1 + (f0 - f1) * Math.exp(-t * 14);
        const decay = Math.exp(-t * (preset === 'boom' ? 2.2 : 9));
        s = (Math.sin(2 * Math.PI * freq * t) * 0.85 + nextRand() * 0.15 * Math.exp(-t * 20)) * decay;
        break;
      }
      case 'footstep': {
        const noise = nextRand();
        lp = lp * 0.72 + noise * 0.28;
        s = (lp * 0.7 + Math.sin(2 * Math.PI * 95 * t) * 0.5) * Math.exp(-t * 22);
        break;
      }
      case 'laser': {
        const freq = 1400 * Math.exp(-t * 6.5) + 120;
        s = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 4.5) * 0.65;
        break;
      }
      case 'success': {
        const step = Math.min(2, Math.floor(p * 3));
        const notes = [523.25, 659.25, 783.99];
        const freq = notes[step];
        const localT = t - (step * dur) / 3;
        s =
          (Math.sin(2 * Math.PI * freq * t) * 0.6 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.2) *
          Math.exp(-Math.max(0, localT) * 5.5);
        break;
      }
      case 'alert': {
        const freq = p < 0.5 ? 740 : 988;
        const localT = p < 0.5 ? t : t - dur * 0.5;
        s = Math.sin(2 * Math.PI * freq * t) * Math.exp(-localT * 6) * 0.55;
        break;
      }
      case 'riser': {
        const freq = 140 + 820 * p * p;
        const noise = nextRand();
        lp = lp * 0.92 + noise * 0.08;
        s = (Math.sin(2 * Math.PI * freq * t) * 0.45 + lp * 0.35) * p;
        break;
      }
      case 'ambient-pad': {
        const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.25 * t);
        const freqs = [220, 277.18, 329.63, 440];
        let chord = 0;
        for (const f of freqs) {
          chord += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * (f * 1.003) * t);
        }
        s = (chord / (freqs.length * 1.3)) * lfo * 0.45;
        break;
      }
      case 'music-pulse': {
        const beatPos = (t * 2) % 1; // 120 BPM
        const bassEnv = Math.exp(-beatPos * 6.5);
        const barIdx = Math.floor((t * 2) / 4) % 4;
        const roots = [110, 146.83, 130.81, 98];
        const root = roots[barIdx];
        const pad =
          Math.sin(2 * Math.PI * root * 2 * t) * 0.25 +
          Math.sin(2 * Math.PI * root * 3 * t) * 0.15;
        const bass = Math.sin(2 * Math.PI * root * t) * bassEnv * 0.45;
        s = bass + pad;
        break;
      }
    }
    out[i] = clamp(s * envFade, -0.95, 0.95);
  }
  return out;
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

  synthesizePresetAsset(
    assetId: string,
    preset: AudioSynthPreset,
    durationSec = 1.5,
  ): { buffer: AudioBuffer; duration: number; peaks: number[] } {
    const ctx = this.ensureContext();
    const sampleRate = ctx.sampleRate || 44100;
    const samples = buildSynthPcmSamples(preset, durationSec, sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    this.buffers.set(assetId, buffer);
    const peaks = computeWaveformPeaks(buffer, 120);
    return { buffer, duration: buffer.duration, peaks };
  }

  ensureSynthAssetLoaded(assetId: string): AudioBuffer | undefined {
    const existing = this.buffers.get(assetId);
    if (existing) return existing;
    const parsed = parseSynthAssetId(assetId);
    if (!parsed) return undefined;
    return this.synthesizePresetAsset(assetId, parsed.preset, parsed.durationSec).buffer;
  }

  async decodeAudioFromBase64(
    assetId: string,
    base64OrDataUrl: string,
  ): Promise<{ buffer: AudioBuffer; duration: number; peaks: number[]; byteLength: number; mimeType: string }> {
    let raw = base64OrDataUrl.trim();
    let mimeType = 'audio/mpeg';
    const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.*)$/s);
    if (dataUrlMatch) {
      mimeType = dataUrlMatch[1] || mimeType;
      raw = dataUrlMatch[2];
    }
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const decoded = await this.decodeAudioAsset(assetId, bytes.buffer);
    return { ...decoded, byteLength: bytes.byteLength, mimeType };
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
    const buffer = this.buffers.get(clip.assetId) ?? this.ensureSynthAssetLoaded(clip.assetId);
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
    const buffer = this.buffers.get(clip.assetId) ?? this.ensureSynthAssetLoaded(clip.assetId);
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
    const buffer = this.buffers.get(clip.assetId) ?? this.ensureSynthAssetLoaded(clip.assetId);
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
