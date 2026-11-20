import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Camera,
  ChevronDown,
  Command,
  Download,
  Eye,
  Film,
  FolderKanban,
  LayoutGrid,
  Redo2,
  Save,
  Sparkles,
  Sliders,
  Undo2,
  Upload,
} from 'lucide-react';
import type { SaveStatus, StudioMode, WorkspaceLayoutId } from '../../core/types';
import type { CameraViewMode } from '../../engine/StudioEngine';
import { IconButton, StudioButton } from '../components/Primitives';

interface TopToolbarProps {
  projectName: string;
  onRenameProject: (name: string) => void;
  saveStatus: SaveStatus;
  studioMode: StudioMode;
  onChangeStudioMode: (mode: StudioMode) => void;
  workspaceLayout: WorkspaceLayoutId;
  onChangeWorkspaceLayout: (layout: WorkspaceLayoutId) => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onSaveNow: () => void;
  onOpenProjects: () => void;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenGuide: () => void;
  onOpenCommandPalette: () => void;
  viewMode: CameraViewMode;
  onToggleViewMode: (mode: CameraViewMode) => void;
}

const SAVE_STATUS_LABELS: Record<SaveStatus, string> = {
  idle: 'Ready',
  unsaved: 'Unsaved',
  saving: 'Saving...',
  saved: 'Saved',
  error: 'Save failed',
};

const WORKSPACE_LAYOUTS: { id: WorkspaceLayoutId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'animation', label: 'Animation' },
  { id: 'rigging', label: 'Rigging' },
  { id: 'scene', label: 'Scene Build' },
  { id: 'audio', label: 'Audio / Mic' },
  { id: 'camera', label: 'Camera' },
];

export function TopToolbar({
  projectName,
  onRenameProject,
  saveStatus,
  studioMode,
  onChangeStudioMode,
  workspaceLayout,
  onChangeWorkspaceLayout,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  onSaveNow,
  onOpenProjects,
  onOpenImport,
  onOpenExport,
  onOpenGuide,
  onOpenCommandPalette,
  viewMode,
  onToggleViewMode,
}: TopToolbarProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNameDraft(projectName);
  }, [projectName]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  const commitName = () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== projectName) {
      onRenameProject(trimmed);
    } else {
      setNameDraft(projectName);
    }
  };

  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[#2a2e36] bg-[#191b1f] px-3 overflow-x-auto">
      {/* Zone 1: Brand & Active Project */}
      <div className="flex min-w-0 items-center gap-2 shrink-0">
        <div className="flex items-center gap-2 whitespace-nowrap shrink-0">
          <Film className="h-4 w-4 text-[#e8702a]" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-tight text-[#e6e8ec]">
            Stagecraft 3D
          </span>
        </div>

        <span className="text-[#4b5260]" aria-hidden="true">/</span>

        {editingName ? (
          <input
            type="text"
            aria-label="Project name"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') {
                setNameDraft(projectName);
                setEditingName(false);
              }
            }}
            className="h-7 w-36 rounded border border-[#e8702a] bg-[#121316] px-2 text-xs font-medium text-[#e6e8ec] focus:outline-none"
          />
        ) : (
          <button
            type="button"
            data-studio-note="Click to rename project"
            onClick={() => setEditingName(true)}
            className="truncate max-w-[140px] rounded px-1.5 py-1 text-xs font-medium text-[#e6e8ec] hover:bg-[#252932]"
          >
            {projectName}
          </button>
        )}

        <span
          className={`text-[11px] whitespace-nowrap shrink-0 ${
            saveStatus === 'error'
              ? 'text-[#f3b3b3]'
              : saveStatus === 'unsaved'
                ? 'text-[#e8702a]'
                : 'text-[#6b7280]'
          }`}
        >
          {SAVE_STATUS_LABELS[saveStatus]}
        </span>
      </div>

      {/* Zone 2: Studio Mode, Layout, Camera View Mode & History */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Beginner vs Advanced Mode Switcher */}
        <div
          role="group"
          aria-label="Workspace mode"
          className="flex items-center rounded border border-[#2a2e36] bg-[#14161a] p-0.5"
        >
          <button
            type="button"
            data-studio-note="Guided Beginner workspace with simplified controls"
            onClick={() => onChangeStudioMode('beginner')}
            className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              studioMode === 'beginner'
                ? 'bg-[#e8702a] text-[#121316] font-semibold'
                : 'text-[#98a0ad] hover:text-[#e6e8ec]'
            }`}
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            <span>Beginner</span>
          </button>
          <button
            type="button"
            data-studio-note="Full Rigging, IK, Keyframe & Curve Editor workspace"
            onClick={() => onChangeStudioMode('advanced')}
            className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              studioMode === 'advanced'
                ? 'bg-[#2e221b] border border-[#e8702a]/70 text-[#f7be97] font-semibold'
                : 'text-[#98a0ad] hover:text-[#e6e8ec]'
            }`}
          >
            <Sliders className="h-3 w-3" aria-hidden="true" />
            <span>Advanced</span>
          </button>
        </div>

        {/* Workspace Layout Preset */}
        <div
          data-studio-note="Switch studio panel & tab layout preset"
          className="flex items-center gap-1 rounded border border-[#2a2e36] bg-[#14161a] px-1.5 h-7"
        >
          <LayoutGrid className="h-3 w-3 text-[#98a0ad]" aria-hidden="true" />
          <select
            aria-label="Workspace layout preset"
            value={workspaceLayout}
            onChange={(e) => onChangeWorkspaceLayout(e.target.value as WorkspaceLayoutId)}
            className="bg-transparent text-[11px] text-[#e6e8ec] focus:outline-none"
          >
            {WORKSPACE_LAYOUTS.map((l) => (
              <option key={l.id} value={l.id} className="bg-[#191b1f] text-[#e6e8ec]">
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

        <div className="flex items-center rounded border border-[#2a2e36] bg-[#14161a] p-0.5">
          <button
            type="button"
            data-studio-note="Free Orbit & Rigging Camera (separate from render camera)"
            onClick={() => onToggleViewMode('editor')}
            className={`flex h-6 items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'editor'
                ? 'bg-[#2a2f3a] text-[#ffffff] font-semibold'
                : 'text-[#98a0ad] hover:text-[#e6e8ec]'
            }`}
          >
            <Eye className="h-3 w-3" aria-hidden="true" />
            <span>Editor</span>
          </button>
          <button
            type="button"
            data-studio-note="Preview final exported Scene Camera framing"
            onClick={() => onToggleViewMode('scene')}
            className={`flex h-6 items-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'scene'
                ? 'bg-[#e8702a] text-[#121316] font-semibold'
                : 'text-[#98a0ad] hover:text-[#e6e8ec]'
            }`}
          >
            <Camera className="h-3 w-3" aria-hidden="true" />
            <span>Final Cam</span>
          </button>
        </div>

        <div className="h-4 w-px bg-[#2a2e36]" aria-hidden="true" />

        <IconButton
          label={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
          note={undoLabel ? `Undo: ${undoLabel}` : 'Nothing to undo'}
          shortcut="Ctrl+Z"
          disabled={!canUndo}
          active={canUndo}
          onClick={onUndo}
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={redoLabel ? `Redo: ${redoLabel}` : 'Redo'}
          note={redoLabel ? `Redo: ${redoLabel}` : 'Nothing to redo'}
          shortcut="Ctrl+Shift+Z"
          disabled={!canRedo}
          active={canRedo}
          onClick={onRedo}
        >
          <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton label="Save Project Now" note="Save project locally" shortcut="Ctrl+S" onClick={onSaveNow}>
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton label="Command Palette" note="Search all studio actions & tools" shortcut="Ctrl+K" onClick={onOpenCommandPalette}>
          <Command className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>

      {/* Zone 3: Projects, Import, Export & Options */}
      <div className="flex items-center gap-1.5 shrink-0">
        <StudioButton note="Manage or create projects" onClick={onOpenProjects}>
          <FolderKanban className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Projects</span>
        </StudioButton>

        <StudioButton note="Import .html, .glb, .gltf, or audio" onClick={onOpenImport}>
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Import</span>
        </StudioButton>

        <StudioButton variant="primary" note="Render & download cartoon video" onClick={onOpenExport}>
          <span>Export</span>
        </StudioButton>

        <div ref={menuRef} className="relative">
          <StudioButton
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span>More</span>
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </StudioButton>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-50 mt-1 w-52 rounded border border-[#383e49] bg-[#1e2127] py-1 shadow-xl"
            >
              <a
                href="/downloads/stagecraft-3d-studio.zip"
                download="stagecraft-3d-studio.zip"
                onClick={() => setMenuOpen(false)}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[#e6e8ec] hover:bg-[#262a33]"
              >
                <Download className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
                <span>Download Studio (.zip)</span>
              </a>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenGuide();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#e6e8ec] hover:bg-[#262a33]"
              >
                <BookOpen className="h-3.5 w-3.5 text-[#98a0ad]" aria-hidden="true" />
                <span>Shortcuts &amp; Studio Guide</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
