import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Copy, FolderOpen, Mic, Plus, Square, Trash2, Upload } from 'lucide-react';
import type { AssetRecord, CharacterInstanceData, ProjectData, SceneData } from '../../core/types';
import { analyzeHtmlCharacter } from '../../characters/HtmlCharacterAnalyzer';
import { HtmlThreeAdapter } from '../../characters/HtmlThreeAdapter';
import {
  type AudioEngine,
  ExternalVoiceProviderHook,
  type MicRecordingSession,
  WebSpeechFallbackProvider,
} from '../../audio/AudioEngine';
import {
  type AspectRatioPreset,
  computeExportDimensions,
  detectVideoExportCapabilities,
} from '../../engine/ExportManager';
import { CustomSelect, Dialog, NumericInput, StudioButton, StudioSlider } from '../components/Primitives';

/* ---------- Live 3D Import Preview Snapshot Helper ---------- */

async function renderCharacterPreviewThumbnail(
  file: File,
  htmlSource?: string,
  glbBuffer?: ArrayBuffer,
): Promise<string | null> {
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(320, 180, false);
    const sc = new THREE.Scene();
    sc.background = new THREE.Color('#14161a');
    sc.add(new THREE.HemisphereLight('#cbe2ff', '#1c1816', 1.1));
    const dir = new THREE.DirectionalLight('#fff2df', 1.4);
    dir.position.set(4, 7, 6);
    sc.add(dir);

    let obj: THREE.Object3D | null = null;
    let adapter: HtmlThreeAdapter | null = null;

    if (htmlSource) {
      adapter = new HtmlThreeAdapter('preview_temp', 'preview_asset', htmlSource, false);
      await adapter.load();
      obj = adapter.rootGroup;
    } else if (glbBuffer) {
      const loader = new GLTFLoader();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.parse(glbBuffer.slice(0), '', resolve, reject);
      });
      obj = gltf.scene;
    }

    if (!obj) return null;
    sc.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(0.5, size.x, size.y, size.z);
    const cam = new THREE.PerspectiveCamera(38, 320 / 180, 0.05, 100);
    cam.position.set(center.x + maxDim * 0.4, center.y + maxDim * 0.25, center.z + maxDim * 2.1);
    cam.lookAt(center);
    renderer.render(sc, cam);
    const dataUrl = canvas.toDataURL('image/png');
    if (adapter) adapter.dispose();
    return dataUrl;
  } catch {
    return null;
  } finally {
    renderer?.dispose();
    void file;
  }
}

/* ---------- Import Asset Dialog ---------- */

interface ImportAssetDialogProps {
  open: boolean;
  onClose: () => void;
  onImportFile: (file: File) => Promise<void>;
}

export function ImportAssetDialog({ open, onClose, onImportFile }: ImportAssetDialogProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [htmlPreview, setHtmlPreview] = useState<ReturnType<typeof analyzeHtmlCharacter> | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (file: File | undefined) => {
    setError(null);
    setHtmlPreview(null);
    setPreviewImg(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    if (/\.html?$/i.test(file.name)) {
      try {
        const text = await file.text();
        const analysis = analyzeHtmlCharacter(text, file.name);
        setHtmlPreview(analysis);
        if (analysis.recommendedMode === 'native-three-extraction') {
          const thumb = await renderCharacterPreviewThumbnail(file, text, undefined);
          setPreviewImg(thumb);
        }
      } catch {
        setError('Could not read HTML file contents.');
      }
    } else if (/\.(glb|gltf)$/i.test(file.name)) {
      try {
        const buf = await file.arrayBuffer();
        const thumb = await renderCharacterPreviewThumbnail(file, undefined, buf);
        setPreviewImg(thumb);
      } catch {
        // Non-fatal preview error
      }
    }
  };

  const handleConfirm = async () => {
    if (!selectedFile) return;
    setBusy(true);
    setError(null);
    try {
      await onImportFile(selectedFile);
      setSelectedFile(null);
      setHtmlPreview(null);
      setPreviewImg(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Import Character, Prop or Audio Asset" onClose={onClose}>
      <div className="space-y-4 text-xs">
        <p className="text-[#98a0ad]">
          Select an HTML 3D character (<code className="text-[#e6e8ec]">.html</code>), a GLB/GLTF model (<code className="text-[#e6e8ec]">.glb</code>, <code className="text-[#e6e8ec]">.gltf</code>), or an audio file (<code className="text-[#e6e8ec]">.mp3</code>, <code className="text-[#e6e8ec]">.wav</code>, <code className="text-[#e6e8ec]">.ogg</code>).
        </p>

        <label className="flex cursor-pointer flex-col items-center justify-center rounded border border-dashed border-[#383e49] bg-[#14161a] p-5 text-center hover:border-[#e8702a]">
          <Upload className="mb-2 h-5 w-5 text-[#e8702a]" aria-hidden="true" />
          <span className="font-medium text-[#e6e8ec]">
            {selectedFile ? selectedFile.name : 'Choose a file from your computer'}
          </span>
          <span className="mt-1 text-[11px] text-[#6b7280]">
            {selectedFile
              ? `${(selectedFile.size / 1024).toFixed(1)} KB`
              : 'Supports .html (STAGECRAFT_SDK or Three.js), .glb, .gltf, .mp3, .wav, .ogg'}
          </span>
          <input
            type="file"
            accept=".html,.htm,.glb,.gltf,.mp3,.wav,.ogg,.m4a,.webm"
            className="hidden"
            onChange={(e) => void handleFileChange(e.target.files?.[0])}
          />
        </label>

        {previewImg && (
          <div className="overflow-hidden rounded border border-[#2a2e36] bg-[#14161a]">
            <div className="border-b border-[#2a2e36] px-2.5 py-1 text-[10px] text-[#98a0ad]">
              Live 3D Import Preview
            </div>
            <img src={previewImg} alt="3D Import Preview" className="h-36 w-full object-contain" />
          </div>
        )}

        {htmlPreview && (
          <div className="space-y-1.5 rounded border border-[#2a2e36] bg-[#14161a] p-3">
            <div className="flex items-center justify-between font-semibold text-[#e6e8ec]">
              <span>Detected: {htmlPreview.suggestedName}</span>
              {htmlPreview.sdkDetected && (
                <span className="rounded bg-[#1a2c27] px-1.5 py-0.5 text-[10px] text-[#4ade80]">
                  STAGECRAFT_SDK
                </span>
              )}
            </div>
            <div className="text-[#98a0ad]">
              Mode:{' '}
              <span className="text-[#e8702a]">
                {htmlPreview.recommendedMode === 'native-three-extraction'
                  ? 'Mode A · Native Three.js Extraction'
                  : 'Mode B · Isolated HTML Sandbox'}
              </span>
            </div>
            <div className="text-[#98a0ad]">
              Actions: {htmlPreview.actions.length} · Moods: {htmlPreview.moods.length}
              {htmlPreview.rigHints.length > 0 && ` · Rig: ${htmlPreview.rigHints.join(', ')}`}
            </div>
            {htmlPreview.externalDependencies.length > 0 && (
              <div className="text-[10px] text-[#98a0ad]">
                External deps: {htmlPreview.externalDependencies.length} script(s)
              </div>
            )}
            {htmlPreview.warnings.map((w, i) => (
              <div key={i} className="text-[11px] text-[#e8702a]">
                {w}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded border border-[#7f2d2d] bg-[#2a1717] p-2.5 text-[#f3b3b3]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <StudioButton onClick={onClose}>Cancel</StudioButton>
          <StudioButton variant="primary" disabled={!selectedFile || busy} onClick={() => void handleConfirm()}>
            {busy ? 'Importing...' : 'Import into Project'}
          </StudioButton>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- Project Manager Dialog ---------- */

interface ProjectManagerDialogProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectData[];
  activeProjectId: string;
  onCreateProject: (name: string) => void;
  onOpenProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
}

export function ProjectManagerDialog({
  open,
  onClose,
  projects,
  activeProjectId,
  onCreateProject,
  onOpenProject,
  onDuplicateProject,
  onDeleteProject,
}: ProjectManagerDialogProps) {
  const [newName, setNewName] = useState('');

  return (
    <Dialog open={open} title="Projects" onClose={onClose}>
      <div className="space-y-4 text-xs">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="New project name (e.g. My Cartoon)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                onCreateProject(newName.trim());
                setNewName('');
                onClose();
              }
            }}
            className="h-7 flex-1 rounded border border-[#2e333d] bg-[#14161a] px-2.5 text-xs text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
          />
          <StudioButton
            variant="primary"
            disabled={!newName.trim()}
            onClick={() => {
              if (!newName.trim()) return;
              onCreateProject(newName.trim());
              setNewName('');
              onClose();
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Create</span>
          </StudioButton>
        </div>

        <div className="space-y-2">
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            return (
              <div
                key={p.id}
                className={`flex items-center justify-between gap-2 rounded border p-2.5 ${
                  isActive ? 'border-[#e8702a] bg-[#2a211c]' : 'border-[#2a2e36] bg-[#14161a]'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold text-[#e6e8ec]">{p.name}</div>
                  <div className="text-[11px] text-[#98a0ad]">
                    {p.scenes.length} scene(s) · Updated {new Date(p.updatedAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!isActive && (
                    <StudioButton
                      size="xs"
                      onClick={() => {
                        onOpenProject(p.id);
                        onClose();
                      }}
                    >
                      <FolderOpen className="h-3 w-3" aria-hidden="true" />
                      <span>Open</span>
                    </StudioButton>
                  )}
                  <StudioButton size="xs" onClick={() => onDuplicateProject(p.id)}>
                    <Copy className="h-3 w-3" aria-hidden="true" />
                  </StudioButton>
                  <StudioButton
                    size="xs"
                    variant="danger"
                    disabled={projects.length <= 1}
                    onClick={() => onDeleteProject(p.id)}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </StudioButton>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- Dialogue & Microphone Recording Dialog ---------- */

interface DialogueDialogProps {
  open: boolean;
  onClose: () => void;
  audioEngine: AudioEngine;
  characters: CharacterInstanceData[];
  initialCharacterId: string;
  audioAssets: AssetRecord[];
  currentTime: number;
  onImportAudioFile: (file: File) => Promise<AssetRecord>;
  onCreateDialogueClip: (params: {
    characterInstanceId: string;
    dialogueText: string;
    audioAssetId: string;
    startTime: number;
    duration: number;
    volume: number;
    playbackRate?: number;
    pauseAfterSec?: number;
  }) => void;
}

export function DialogueDialog({
  open,
  onClose,
  audioEngine,
  characters,
  initialCharacterId,
  audioAssets,
  currentTime,
  onImportAudioFile,
  onCreateDialogueClip,
}: DialogueDialogProps) {
  const [charId, setCharId] = useState(initialCharacterId);
  const [text, setText] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState(audioAssets[0]?.id ?? '');
  const [startTime, setStartTime] = useState(currentTime);
  const [duration, setDuration] = useState(3);
  const [volume, setVolume] = useState(1);
  const [pauseAfterSec, setPauseAfterSec] = useState(0.35);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recSessionRef = useRef<MicRecordingSession | null>(null);

  const webSpeech = useMemo(() => new WebSpeechFallbackProvider(), []);
  const externalVoice = useMemo(() => new ExternalVoiceProviderHook(), []);

  useEffect(() => {
    if (open) {
      setCharId(initialCharacterId || characters[0]?.id || '');
      setStartTime(currentTime);
      setSelectedAssetId(audioAssets[0]?.id ?? '');
      setError(null);
      setRecording(false);
    }
    return () => {
      recSessionRef.current?.cancel();
      recSessionRef.current = null;
    };
  }, [open, initialCharacterId, characters, currentTime, audioAssets]);

  const activeChar = characters.find((c) => c.id === charId);

  const handleUploadNewAudio = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const asset = await onImportAudioFile(file);
      setSelectedAssetId(asset.id);
      if (asset.audioDuration) {
        setDuration(Number(asset.audioDuration.toFixed(2)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio file.');
    }
  };

  const handleToggleMicRecord = async () => {
    setError(null);
    if (!recording) {
      try {
        recSessionRef.current = await audioEngine.startMicrophoneRecording();
        setRecording(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start microphone.');
      }
    } else {
      try {
        const res = await recSessionRef.current?.stop();
        recSessionRef.current = null;
        setRecording(false);
        if (res) {
          const recFile = new File([res.blob], `Voice_Take_${Date.now()}.webm`, { type: res.mimeType });
          const asset = await onImportAudioFile(recFile);
          setSelectedAssetId(asset.id);
          if (asset.audioDuration) setDuration(Number(asset.audioDuration.toFixed(2)));
        }
      } catch (err) {
        setRecording(false);
        setError(err instanceof Error ? err.message : 'Failed to save microphone recording.');
      }
    }
  };

  const previewSpeech = () => {
    webSpeech.speakPreview(text, {
      pitch: activeChar?.audioProfile.pitch ?? 1,
      rate: activeChar?.audioProfile.speed ?? 1,
    });
  };

  const handleSubmit = () => {
    if (!charId) {
      setError('Select a character first.');
      return;
    }
    const chosen = audioAssets.find((a) => a.id === selectedAssetId);
    // Split multi-part lines if user uses '|' separator (e.g. "Hello! | Welcome to the show.")
    const parts = text.trim().includes('|')
      ? text
          .split('|')
          .map((p) => p.trim())
          .filter(Boolean)
      : [text.trim()];

    let cursor = startTime;
    const perPartDur = Math.max(0.4, (chosen?.audioDuration ? Math.min(duration, chosen.audioDuration) : duration) / parts.length);

    parts.forEach((part, idx) => {
      onCreateDialogueClip({
        characterInstanceId: charId,
        dialogueText: part,
        audioAssetId: idx === 0 ? chosen?.id ?? '' : '',
        startTime: Number(cursor.toFixed(2)),
        duration: Number(perPartDur.toFixed(2)),
        volume,
        playbackRate: activeChar?.audioProfile.speed ?? 1,
        pauseAfterSec,
      });
      cursor += perPartDur + pauseAfterSec;
    });

    onClose();
  };

  return (
    <Dialog open={open} title="Add Character Dialogue &amp; Voice" onClose={onClose}>
      <div className="space-y-3 text-xs">
        {characters.length > 0 && (
          <CustomSelect
            label="Speaking Character"
            value={charId}
            options={characters.map((c) => ({
              value: c.id,
              label: `${c.name} (${c.audioProfile.voiceLabel})`,
            }))}
            onChange={setCharId}
          />
        )}

        <label className="block">
          <span className="text-[11px] text-[#98a0ad]">
            Dialogue Line (use <code className="text-[#e6e8ec]">|</code> to auto-split into timed beats)
          </span>
          <textarea
            rows={2}
            placeholder="Hello everyone! | Welcome to Stagecraft 3D."
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-1 w-full rounded border border-[#2e333d] bg-[#14161a] p-2 text-xs text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <StudioButton size="xs" disabled={!text.trim()} onClick={previewSpeech}>
            Preview Browser Speech
          </StudioButton>
          <StudioButton
            size="xs"
            variant={recording ? 'danger' : 'primary'}
            onClick={() => void handleToggleMicRecord()}
          >
            {recording ? <Square className="h-3 w-3" aria-hidden="true" /> : <Mic className="h-3 w-3" aria-hidden="true" />}
            <span>{recording ? 'Stop & Attach Mic' : 'Record Microphone'}</span>
          </StudioButton>
          <label className="cursor-pointer rounded border border-[#2e333d] bg-[#202329] px-2.5 py-1 text-[11px] font-medium text-[#e6e8ec] hover:border-[#e8702a]">
            Attach Audio (.mp3/.wav)
            <input
              type="file"
              accept=".mp3,.wav,.ogg,.m4a,.webm"
              className="hidden"
              onChange={(e) => void handleUploadNewAudio(e.target.files?.[0])}
            />
          </label>
        </div>

        <div className="rounded border border-[#2a2e36] bg-[#14161a] p-2 text-[10px] text-[#98a0ad]">
          <div>{webSpeech.getStatusText()}</div>
          <div className="mt-0.5 text-[#6b7280]">{externalVoice.getStatusText()}</div>
        </div>

        {audioAssets.length > 0 && (
          <CustomSelect
            label="Attached Audio Clip"
            value={selectedAssetId}
            options={[
              { value: '', label: 'Syllabic Lip-Sync Only (no audio file)' },
              ...audioAssets.map((a) => ({
                value: a.id,
                label: `${a.name} (${a.audioDuration?.toFixed(1) ?? '?'}s)`,
              })),
            ]}
            onChange={(id) => {
              setSelectedAssetId(id);
              const found = audioAssets.find((a) => a.id === id);
              if (found?.audioDuration) setDuration(Number(found.audioDuration.toFixed(2)));
            }}
          />
        )}

        <div className="grid grid-cols-3 gap-2">
          <NumericInput label="Start" min={0} value={startTime} onChange={setStartTime} />
          <NumericInput label="Dur" min={0.3} value={duration} onChange={setDuration} />
          <NumericInput label="Pause" min={0} step={0.1} value={pauseAfterSec} onChange={setPauseAfterSec} />
        </div>

        <StudioSlider
          label="Volume"
          min={0}
          max={1.5}
          step={0.05}
          value={volume}
          displayValue={`${Math.round(volume * 100)}%`}
          onChange={setVolume}
        />

        {error && (
          <div role="alert" className="rounded border border-[#7f2d2d] bg-[#2a1717] p-2 text-[#f3b3b3]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <StudioButton onClick={onClose}>Cancel</StudioButton>
          <StudioButton variant="primary" onClick={handleSubmit}>
            Add to Character Track
          </StudioButton>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- Export Video Dialog ---------- */

interface ExportVideoDialogProps {
  open: boolean;
  onClose: () => void;
  activeScene: SceneData;
  allScenes: SceneData[];
  onStartExport: (params: {
    scope: 'scene' | 'project';
    width: number;
    height: number;
    fps: number;
    mimeType: string;
    ext: 'mp4' | 'webm';
    includeAudio: boolean;
    steppedFrames: boolean;
  }) => Promise<void>;
  exporting: boolean;
  progress: number;
  statusText: string;
  onCancelExport: () => void;
}

export function ExportVideoDialog({
  open,
  onClose,
  activeScene,
  allScenes,
  onStartExport,
  exporting,
  progress,
  statusText,
  onCancelExport,
}: ExportVideoDialogProps) {
  const caps = useMemo(() => detectVideoExportCapabilities(), [open]);
  const [scope, setScope] = useState<'scene' | 'project'>('scene');
  const [aspectRatio, setAspectRatio] = useState<AspectRatioPreset>('16:9');
  const [quality, setQuality] = useState<'540p' | '720p' | '1080p'>('720p');
  const [fps, setFps] = useState<'24' | '30' | '60'>('30');
  const [mimeType, setMimeType] = useState(caps.supportedMimeTypes[0]?.mimeType ?? '');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [steppedFrames, setSteppedFrames] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const chosenFormat =
    caps.supportedMimeTypes.find((c) => c.mimeType === mimeType) ?? caps.supportedMimeTypes[0];
  const dims = computeExportDimensions(aspectRatio, quality);

  const handleExport = async () => {
    if (!chosenFormat) return;
    setError(null);
    try {
      await onStartExport({
        scope,
        width: dims.width,
        height: dims.height,
        fps: Number(fps),
        mimeType: chosenFormat.mimeType,
        ext: chosenFormat.ext,
        includeAudio,
        steppedFrames,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    }
  };

  return (
    <Dialog open={open} title="Export Cartoon Video" onClose={() => !exporting && onClose()}>
      <div className="space-y-4 text-xs">
        <CustomSelect
          label="Export Scope"
          value={scope}
          disabled={exporting}
          options={[
            { value: 'scene', label: `Current Scene (${activeScene.name} · ${activeScene.duration}s)` },
            { value: 'project', label: `Full Story (${allScenes.length} scenes)` },
          ]}
          onChange={(v) => setScope(v as 'scene' | 'project')}
        />

        <div className="grid grid-cols-3 gap-2">
          <CustomSelect
            label="Aspect Ratio"
            value={aspectRatio}
            disabled={exporting}
            options={[
              { value: '16:9', label: '16:9 Widescreen' },
              { value: '9:16', label: '9:16 Vertical' },
              { value: '1:1', label: '1:1 Square' },
              { value: '4:3', label: '4:3 Classic' },
            ]}
            onChange={(v) => setAspectRatio(v as AspectRatioPreset)}
          />
          <CustomSelect
            label="Quality"
            value={quality}
            disabled={exporting}
            options={[
              { value: '540p', label: '540p Draft' },
              { value: '720p', label: '720p HD' },
              { value: '1080p', label: '1080p Full HD' },
            ]}
            onChange={(v) => setQuality(v as '540p' | '720p' | '1080p')}
          />
          <CustomSelect
            label="Frame Rate"
            value={fps}
            disabled={exporting}
            options={[
              { value: '24', label: '24 fps' },
              { value: '30', label: '30 fps' },
              { value: '60', label: '60 fps' },
            ]}
            onChange={(v) => setFps(v as '24' | '30' | '60')}
          />
        </div>

        <div className="text-[11px] text-[#98a0ad]">
          Output resolution: <span className="font-mono-code text-[#e6e8ec]">{dims.width} × {dims.height}</span>
        </div>

        {caps.supportedMimeTypes.length > 0 ? (
          <CustomSelect
            label="Container &amp; Codec (Browser Native)"
            value={chosenFormat?.mimeType ?? ''}
            disabled={exporting}
            options={caps.supportedMimeTypes.map((c) => ({
              value: c.mimeType,
              label: c.label,
            }))}
            onChange={setMimeType}
          />
        ) : (
          <div className="rounded border border-[#7f2d2d] bg-[#2a1717] p-2.5 text-[#f3b3b3]">
            This browser does not expose MediaRecorder video encoding.
          </div>
        )}

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={includeAudio}
              disabled={exporting}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              className="accent-[#e8702a]"
            />
            <span>Include mixed dialogue, music, and sound effects</span>
          </label>
          <label className="flex items-center gap-2 text-[#e6e8ec]">
            <input
              type="checkbox"
              checked={steppedFrames}
              disabled={exporting}
              onChange={(e) => setSteppedFrames(e.target.checked)}
              className="accent-[#e8702a]"
            />
            <span>Stepped deterministic frame capture (smooth timing under heavy scenes)</span>
          </label>
        </div>

        {exporting && (
          <div className="space-y-1.5 rounded border border-[#2a2e36] bg-[#14161a] p-3">
            <div className="flex justify-between text-[11px] text-[#e6e8ec]">
              <span>{statusText}</span>
              <span className="font-mono-code">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-[#262a33]">
              <div
                style={{ width: `${Math.round(progress * 100)}%` }}
                className="h-full bg-[#e8702a] transition-all"
              />
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded border border-[#7f2d2d] bg-[#2a1717] p-2.5 text-[#f3b3b3]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {exporting ? (
            <StudioButton variant="danger" onClick={onCancelExport}>
              Cancel Export
            </StudioButton>
          ) : (
            <>
              <StudioButton onClick={onClose}>Close</StudioButton>
              <StudioButton
                variant="primary"
                disabled={caps.supportedMimeTypes.length === 0}
                onClick={() => void handleExport()}
              >
                Render &amp; Download Video
              </StudioButton>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- User Guide Dialog ---------- */

export function UserGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title="Stagecraft 3D — Production &amp; Shortcut Guide" onClose={onClose}>
      <div className="space-y-3 text-xs leading-relaxed text-[#98a0ad]">
        <div>
          <h3 className="font-semibold text-[#e6e8ec]">1. Hover Identification &amp; Double-Click Pose Mode</h3>
          <p>
            <strong>Hover</strong> any character limb, prop, or joint to highlight it and see its control description. <strong>Single-click</strong> selects the whole character/group with Move/Rotate/Scale gizmos. <strong>Double-click</strong> a character or limb to enter <strong>Articulated Pose Mode</strong>: child bones stay locked to their parent socket and rotate smoothly when you drag directly on the body part or axis rings.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-[#e6e8ec]">2. Grouping, Hierarchy &amp; Material Structure</h3>
          <p>
            Select multiple characters or props (<kbd className="rounded bg-[#262a33] px-1 text-[#e6e8ec]">Shift+Click</kbd>) and press <kbd className="rounded bg-[#262a33] px-1 text-[#e6e8ec]">Ctrl+G</kbd> to create a Logical Group (<kbd className="rounded bg-[#262a33] px-1 text-[#e6e8ec]">Ctrl+Shift+G</kbd> to ungroup). Inspect bones, slots, and materials inside the Inspector.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-[#e6e8ec]">3. Timeline, Motion Paths, Curves &amp; Tab Prediction</h3>
          <p>
            Expand characters in the Timeline to drag or key individual <strong>Pos / Rot / Bone</strong> diamonds. Switch to <strong>Curves</strong> to drag keyframes and Cubic Bezier tangent handles. Press <kbd className="rounded bg-[#262a33] px-1 text-[#e6e8ec]">Tab</kbd> anytime for context-aware animation suggestions with live Preview &amp; Apply.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-[#e6e8ec]">4. Complete Keyboard Shortcuts</h3>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-[#2a2e36] bg-[#14161a] p-2.5 text-[11px]">
            <div><strong className="text-[#e6e8ec]">Q / G / R / S</strong> — Select / Move / Rotate / Scale</div>
            <div><strong className="text-[#e6e8ec]">L</strong> — Toggle World / Local Space</div>
            <div><strong className="text-[#e6e8ec]">F / Shift+F</strong> — Focus Part / Frame All</div>
            <div><strong className="text-[#e6e8ec]">Tab</strong> — Animation Prediction HUD</div>
            <div><strong className="text-[#e6e8ec]">Space</strong> — Play / Pause Timeline</div>
            <div><strong className="text-[#e6e8ec]">I</strong> — Insert Keyframe at Playhead</div>
            <div><strong className="text-[#e6e8ec]">Ctrl+Z / Ctrl+Shift+Z</strong> — Undo / Redo</div>
            <div><strong className="text-[#e6e8ec]">Ctrl+G / Ctrl+Shift+G</strong> — Group / Ungroup</div>
            <div><strong className="text-[#e6e8ec]">Ctrl+D / Delete</strong> — Duplicate / Delete</div>
            <div><strong className="text-[#e6e8ec]">Shift+F10</strong> — Context Menu</div>
            <div><strong className="text-[#e6e8ec]">Ctrl+K / Ctrl+S</strong> — Palette / Save</div>
            <div><strong className="text-[#e6e8ec]">Esc</strong> — Exit Pose Mode / Close Menu</div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
