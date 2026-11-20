import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bone,
  Box,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileAudio,
  FileCode2,
  Film,
  Focus,
  FolderOpen,
  Group,
  Layers,
  Lightbulb,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Shapes,
  Sparkles,
  Trash2,
  Ungroup,
  Unlock,
  Upload,
} from 'lucide-react';
import type {
  AssetRecord,
  MultiSelectedNodeRef,
  PanelCollapseState,
  PropGeometryKind,
  RigNodeInfo,
  SceneData,
  SceneLightKind,
  SelectionTarget,
} from '../../core/types';
import { PROP_LIBRARY_ITEMS, type SceneTemplateId } from '../../engine/PropsFactory';
import { ContextMenu, type ContextMenuItem, IconButton, StudioButton } from '../components/Primitives';

export type LeftPanelTab = 'assets' | 'hierarchy' | 'scenes';

interface LeftAssetPanelProps {
  width: number;
  collapseState: PanelCollapseState;
  onChangeCollapseState: (state: PanelCollapseState) => void;
  activeTab: LeftPanelTab;
  onChangeTab: (tab: LeftPanelTab) => void;
  assets: AssetRecord[];
  activeScene: SceneData;
  scenes: SceneData[];
  selection: SelectionTarget;
  multiSelectedIds: string[];
  multiSelectedNodes?: MultiSelectedNodeRef[];
  isolatedIds: string[];
  rigNodesByInstance: Record<string, RigNodeInfo[]>;
  onSelectTarget: (target: SelectionTarget, additive?: boolean) => void;
  onOpenImport: () => void;
  onLoadWorkspaceSample: (sampleUrl: string, label: string) => void;
  onAddCharacterToScene: (asset: AssetRecord) => void;
  onAddPropToScene: (kind: PropGeometryKind, label: string, color: string) => void;
  onAddGlbPropToScene: (asset: AssetRecord) => void;
  onAddLightToScene: (kind: SceneLightKind) => void;
  onAddCameraToScene: (projection: 'perspective' | 'orthographic') => void;
  onSelectCameraItem: (cameraId: string) => void;
  onAddAudioToScene: (asset: AssetRecord, role: 'music' | 'sfx') => void;
  onRenameAsset: (assetId: string, name: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onToggleCharacterVisibility: (instanceId: string) => void;
  onToggleCharacterLock: (instanceId: string) => void;
  onToggleNodeLock: (instanceId: string, nodeId: string) => void;
  onToggleNodeVisibility: (instanceId: string, nodeId: string) => void;
  onDuplicateCharacter: (instanceId: string) => void;
  onRemoveCharacterFromScene: (instanceId: string) => void;
  onTogglePropVisibility: (propId: string) => void;
  onRemovePropFromScene: (propId: string) => void;
  onRemoveLightFromScene: (lightId: string) => void;
  onGroupSelection: () => void;
  onUngroupGroup: (groupId: string) => void;
  onUngroupNodeGroup?: (instanceId: string, groupId: string) => void;
  onDuplicateGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onSelectGroupMembers: (groupId: string) => void;
  onEnterPoseMode: (instanceId: string) => void;
  onToggleGroupVisibility: (groupId: string) => void;
  onToggleGroupLock: (groupId: string) => void;
  onToggleIsolate: (id: string) => void;
  onSwitchScene: (sceneId: string) => void;
  onCreateScene: (templateId?: SceneTemplateId) => void;
  onDuplicateScene: (sceneId: string) => void;
  onDeleteScene: (sceneId: string) => void;
  onReorderScene: (sceneId: string, dir: -1 | 1) => void;
}

export function LeftAssetPanel({
  width,
  collapseState,
  onChangeCollapseState,
  activeTab,
  onChangeTab,
  assets,
  activeScene,
  scenes,
  selection,
  multiSelectedIds,
  multiSelectedNodes = [],
  isolatedIds,
  rigNodesByInstance,
  onSelectTarget,
  onOpenImport,
  onLoadWorkspaceSample,
  onAddCharacterToScene,
  onAddPropToScene,
  onAddGlbPropToScene,
  onAddLightToScene,
  onAddCameraToScene,
  onSelectCameraItem,
  onAddAudioToScene,
  onRenameAsset,
  onDeleteAsset,
  onToggleCharacterVisibility,
  onToggleCharacterLock,
  onToggleNodeLock,
  onToggleNodeVisibility,
  onDuplicateCharacter,
  onRemoveCharacterFromScene,
  onTogglePropVisibility,
  onRemovePropFromScene,
  onRemoveLightFromScene,
  onGroupSelection,
  onUngroupGroup,
  onUngroupNodeGroup,
  onDuplicateGroup,
  onRenameGroup,
  onSelectGroupMembers,
  onEnterPoseMode,
  onToggleGroupVisibility,
  onToggleGroupLock,
  onToggleIsolate,
  onSwitchScene,
  onCreateScene,
  onDuplicateScene,
  onDeleteScene,
  onReorderScene,
}: LeftAssetPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCharRigs, setExpandedCharRigs] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [showAuxNodes, setShowAuxNodes] = useState(true);
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  if (collapseState === 'collapsed') {
    return (
      <aside
        className="flex w-6 shrink-0 flex-col items-center border-r border-[#2a2e36] bg-[#191b1f] py-2"
        aria-label="Collapsed Assets & Hierarchy Panel"
      >
        <IconButton
          label="Expand Left Panel"
          note="Restore Assets, Hierarchy & Scenes panel"
          onClick={() => onChangeCollapseState('expanded')}
        >
          <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </aside>
    );
  }

  if (collapseState === 'compact') {
    return (
      <aside
        className="flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-[#2a2e36] bg-[#191b1f] py-2"
        aria-label="Compact Assets & Hierarchy Rail"
      >
        <IconButton
          label="Expand Left Panel"
          note="Expand full panel"
          onClick={() => onChangeCollapseState('expanded')}
        >
          <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <div className="h-px w-6 bg-[#2a2e36]" />
        <IconButton
          label="Assets"
          note="Open Assets & Props Library"
          active={activeTab === 'assets'}
          onClick={() => {
            onChangeTab('assets');
            onChangeCollapseState('expanded');
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Hierarchy"
          note="Open Scene Hierarchy & Groups"
          active={activeTab === 'hierarchy'}
          onClick={() => {
            onChangeTab('hierarchy');
            onChangeCollapseState('expanded');
          }}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Scenes"
          note="Open Story Scenes"
          active={activeTab === 'scenes'}
          onClick={() => {
            onChangeTab('scenes');
            onChangeCollapseState('expanded');
          }}
        >
          <Film className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton label="Import File" note="Import .html, .glb, or audio" onClick={onOpenImport}>
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
        <div className="mt-auto">
          <IconButton
            label="Collapse Left Panel"
            note="Minimize panel completely"
            onClick={() => onChangeCollapseState('collapsed')}
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </div>
      </aside>
    );
  }

  const q = searchQuery.trim().toLowerCase();
  const characterAssets = assets.filter(
    (a) =>
      (a.kind === 'character-html' || a.kind === 'character-glb' || a.kind === 'prop-glb') &&
      (!q || a.name.toLowerCase().includes(q)),
  );
  const audioAssets = assets.filter(
    (a) => a.kind === 'audio' && (!q || a.name.toLowerCase().includes(q)),
  );
  const filteredPropsLibrary = PROP_LIBRARY_ITEMS.filter(
    (p) => !q || p.label.toLowerCase().includes(q),
  );

  const openCtxMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleRowShiftF10 = (e: React.KeyboardEvent, items: ContextMenuItem[]) => {
    if (e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setCtxMenu({ x: rect.left + 28, y: rect.bottom + 2, items });
    }
  };

  const sceneCameras = activeScene.cameras ?? [];
  const sceneLights = activeScene.lights ?? [];
  const sceneProps = activeScene.props ?? [];
  const sceneGroups = activeScene.groups ?? [];
  const canGroupNow =
    multiSelectedIds.length >= 1 ||
    multiSelectedNodes.length >= 2 ||
    selection.kind === 'character' ||
    selection.kind === 'prop';

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-[#2a2e36] bg-[#191b1f]"
      aria-label="Assets, Hierarchy, and Scenes"
    >
      {/* Tabs + Collapse Controls */}
      <div className="flex items-center gap-1 border-b border-[#2a2e36] p-1.5" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'assets'}
          title="Characters, Props, and Audio Assets"
          onClick={() => onChangeTab('assets')}
          className={`flex flex-1 items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'assets'
              ? 'bg-[#2a2f3a] text-[#ffffff]'
              : 'text-[#98a0ad] hover:text-[#e6e8ec]'
          }`}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Assets</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'hierarchy'}
          title="Scene Hierarchy, Groups & Rig Bones"
          onClick={() => onChangeTab('hierarchy')}
          className={`flex flex-1 items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'hierarchy'
              ? 'bg-[#2a2f3a] text-[#ffffff]'
              : 'text-[#98a0ad] hover:text-[#e6e8ec]'
          }`}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Hierarchy</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'scenes'}
          title="Story Scenes & Templates"
          onClick={() => onChangeTab('scenes')}
          className={`flex flex-1 items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'scenes'
              ? 'bg-[#2a2f3a] text-[#ffffff]'
              : 'text-[#98a0ad] hover:text-[#e6e8ec]'
          }`}
        >
          <Film className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Scenes</span>
        </button>
        <IconButton
          label="Compact Left Panel"
          note="Collapse to icon rail"
          onClick={() => onChangeCollapseState('compact')}
        >
          <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
      </div>

      {/* Search Bar */}
      <div className="border-b border-[#2a2e36] px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 rounded border border-[#2a2e36] bg-[#14161a] px-2 py-1">
          <Search className="h-3 w-3 text-[#6b7280]" aria-hidden="true" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter assets, bones, props..."
            aria-label="Filter assets and hierarchy"
            className="w-full bg-transparent text-[11px] text-[#e6e8ec] placeholder-[#6b7280] focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {activeTab === 'assets' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-[#e6e8ec]">Asset Library</h2>
              <StudioButton size="xs" variant="primary" onClick={onOpenImport}>
                <Upload className="h-3 w-3" aria-hidden="true" />
                <span>Import File</span>
              </StudioButton>
            </div>

            {/* Quick-import attached workspace characters */}
            <div className="rounded border border-[#2a2e36] bg-[#15171b] p-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-[#98a0ad]">
                Workspace Characters
              </div>
              <div className="flex flex-col gap-1.5">
                <StudioButton
                  size="xs"
                  note="Load Globe Bot HTML character into library"
                  onClick={() =>
                    onLoadWorkspaceSample('/assets/aistudio/Globe_character_2c73ff07.html', 'Globe Character')
                  }
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  <span>Load Globe Character HTML</span>
                </StudioButton>
                <StudioButton
                  size="xs"
                  note="Load Host articulated humanoid HTML character into library"
                  onClick={() =>
                    onLoadWorkspaceSample('/assets/aistudio/Host_character_ed9211ab.html', 'Host Character')
                  }
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  <span>Load Host Character HTML</span>
                </StudioButton>
              </div>
            </div>

            {/* Characters & Models section */}
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] text-[#98a0ad]">
                <span>Characters &amp; Models</span>
                <span className="tabular-nums">{characterAssets.length}</span>
              </div>
              {characterAssets.length === 0 ? (
                <p className="rounded border border-dashed border-[#2a2e36] p-3 text-center text-[11px] text-[#6b7280]">
                  Import HTML or GLB/GLTF models to start.
                </p>
              ) : (
                <div className="space-y-2">
                  {characterAssets.map((asset) => {
                    const assetCtxItems: ContextMenuItem[] = [
                      { label: 'Add to Active Scene', onClick: () => onAddCharacterToScene(asset) },
                      {
                        label: 'Add as Scene Prop',
                        onClick: () => onAddGlbPropToScene(asset),
                        disabled: asset.kind !== 'character-glb' && asset.kind !== 'prop-glb',
                      },
                      {
                        label: 'Rename Asset',
                        onClick: () => {
                          setRenamingAssetId(asset.id);
                          setRenameDraft(asset.name);
                        },
                      },
                      { label: 'Delete Asset', danger: true, onClick: () => onDeleteAsset(asset.id) },
                    ];
                    return (
                    <div
                      key={asset.id}
                      tabIndex={0}
                      onContextMenu={(e) => openCtxMenu(e, assetCtxItems)}
                      onKeyDown={(e) => handleRowShiftF10(e, assetCtxItems)}
                      className="rounded border border-[#2a2e36] bg-[#1e2127] p-2 focus:border-[#e8702a] focus:outline-none"
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[#262a33] text-[#e8702a]">
                          {asset.kind === 'character-html' ? (
                            <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Box className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          {renamingAssetId === asset.id ? (
                            <input
                              type="text"
                              autoFocus
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onBlur={() => {
                                if (renameDraft.trim()) onRenameAsset(asset.id, renameDraft.trim());
                                setRenamingAssetId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  if (renameDraft.trim()) onRenameAsset(asset.id, renameDraft.trim());
                                  setRenamingAssetId(null);
                                }
                                if (e.key === 'Escape') setRenamingAssetId(null);
                              }}
                              className="h-6 w-full rounded border border-[#e8702a] bg-[#14161a] px-1.5 text-xs text-[#e6e8ec] focus:outline-none"
                            />
                          ) : (
                            <div className="truncate font-semibold text-[#e6e8ec]">{asset.name}</div>
                          )}
                          <div className="truncate text-[11px] text-[#98a0ad]">
                            {asset.kind === 'character-html'
                              ? asset.htmlAnalysis?.recommendedMode === 'native-three-extraction'
                                ? 'HTML · Native 3D'
                                : 'HTML · Sandbox'
                              : 'GLB/GLTF'}
                            {asset.htmlAnalysis?.actions.length
                              ? ` · ${asset.htmlAnalysis.actions.length} actions`
                              : ''}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <StudioButton
                          size="xs"
                          className="flex-1"
                          aria-label={`Add ${asset.name} to scene`}
                          onClick={() => onAddCharacterToScene(asset)}
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" />
                          <span>Add to Scene</span>
                        </StudioButton>
                        <IconButton
                          label={`Delete ${asset.name}`}
                          onClick={() => onDeleteAsset(asset.id)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </div>
                  );
                  })}
                </div>
              )}
            </div>

            {/* Stage Props Library */}
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] text-[#98a0ad]">
                <span>Stage Props</span>
                <span className="tabular-nums">{filteredPropsLibrary.length}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {filteredPropsLibrary.map((item) => (
                  <button
                    key={item.kind}
                    type="button"
                    title={`Add ${item.label} prop to stage`}
                    onClick={() => onAddPropToScene(item.kind, item.label, item.defaultColor)}
                    className="flex items-center gap-1.5 rounded border border-[#2a2e36] bg-[#1e2127] px-2 py-1.5 text-left text-[11px] text-[#e6e8ec] hover:border-[#e8702a]"
                  >
                    <Shapes className="h-3 w-3 shrink-0 text-[#e8702a]" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Audio Assets section */}
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] text-[#98a0ad]">
                <span>Audio Clips</span>
                <span className="tabular-nums">{audioAssets.length}</span>
              </div>
              {audioAssets.length === 0 ? (
                <p className="rounded border border-dashed border-[#2a2e36] p-3 text-center text-[11px] text-[#6b7280]">
                  Import MP3, WAV, or OGG for music &amp; SFX.
                </p>
              ) : (
                <div className="space-y-2">
                  {audioAssets.map((asset) => (
                    <div key={asset.id} className="rounded border border-[#2a2e36] bg-[#1e2127] p-2">
                      <div className="flex items-center gap-2">
                        <FileAudio className="h-3.5 w-3.5 shrink-0 text-[#98a0ad]" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-[#e6e8ec]">{asset.name}</div>
                          <div className="font-mono-code text-[10px] text-[#6b7280]">
                            {asset.audioDuration ? `${asset.audioDuration.toFixed(1)}s` : 'Audio'}
                          </div>
                        </div>
                        <IconButton
                          label={`Delete ${asset.name}`}
                          onClick={() => onDeleteAsset(asset.id)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                      </div>
                      <div className="mt-2 flex gap-1.5">
                        <StudioButton
                          size="xs"
                          className="flex-1"
                          onClick={() => onAddAudioToScene(asset, 'music')}
                        >
                          + Music
                        </StudioButton>
                        <StudioButton
                          size="xs"
                          className="flex-1"
                          onClick={() => onAddAudioToScene(asset, 'sfx')}
                        >
                          + SFX
                        </StudioButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'hierarchy' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="truncate font-semibold text-[#e6e8ec]">{activeScene.name}</h2>
              <StudioButton
                size="xs"
                disabled={!canGroupNow}
                note={
                  multiSelectedNodes.length >= 2
                    ? 'Group selected body components cleanly without detaching (Ctrl+G)'
                    : 'Group selected characters/props cleanly (Ctrl+G)'
                }
                onClick={onGroupSelection}
              >
                <Group className="h-3 w-3" aria-hidden="true" />
                <span>{multiSelectedNodes.length >= 2 ? 'Group Parts' : 'Group'}</span>
              </StudioButton>
            </div>

            {/* Logical Groups */}
            {sceneGroups.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] text-[#98a0ad]">Groups</div>
                {sceneGroups.map((grp) => {
                  const sel = selection.kind === 'group' && selection.groupId === grp.id;
                  const expanded = expandedGroups[grp.id] ?? true;
                  const isolated = isolatedIds.includes(grp.id);
                  const grpCtxItems: ContextMenuItem[] = [
                    { label: 'Select All Members', onClick: () => onSelectGroupMembers(grp.id) },
                    {
                      label: 'Rename Group',
                      onClick: () => {
                        setRenamingGroupId(grp.id);
                        setRenameDraft(grp.name);
                      },
                    },
                    { label: 'Duplicate Group', shortcut: 'Ctrl+D', onClick: () => onDuplicateGroup(grp.id) },
                    {
                      label: isolated ? 'Clear Isolation' : 'Isolate Group',
                      dividerAbove: true,
                      onClick: () => onToggleIsolate(grp.id),
                    },
                    {
                      label: grp.locked ? 'Unlock Group' : 'Lock Group',
                      onClick: () => onToggleGroupLock(grp.id),
                    },
                    {
                      label: grp.visible ? 'Hide Group' : 'Show Group',
                      onClick: () => onToggleGroupVisibility(grp.id),
                    },
                    {
                      label: 'Ungroup',
                      shortcut: 'Ctrl+Shift+G',
                      danger: true,
                      dividerAbove: true,
                      onClick: () => onUngroupGroup(grp.id),
                    },
                  ];
                  return (
                    <div key={grp.id} className="space-y-1">
                      <div
                        tabIndex={0}
                        onContextMenu={(e) => openCtxMenu(e, grpCtxItems)}
                        onKeyDown={(e) => handleRowShiftF10(e, grpCtxItems)}
                        className={`flex items-center gap-1 rounded border p-1.5 focus:outline-none ${
                          sel ? 'border-[#e8702a] bg-[#2e221b]' : 'border-[#2a2e36] bg-[#1e2127] hover:border-[#383e49]'
                        }`}
                      >
                        <button
                          type="button"
                          aria-label={`Expand ${grp.name}`}
                          onClick={() => setExpandedGroups((p) => ({ ...p, [grp.id]: !expanded }))}
                          className="p-0.5 text-[#98a0ad] hover:text-[#e6e8ec]"
                        >
                          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </button>
                        {renamingGroupId === grp.id ? (
                          <input
                            type="text"
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => {
                              if (renameDraft.trim()) onRenameGroup(grp.id, renameDraft.trim());
                              setRenamingGroupId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                if (renameDraft.trim()) onRenameGroup(grp.id, renameDraft.trim());
                                setRenamingGroupId(null);
                              }
                              if (e.key === 'Escape') setRenamingGroupId(null);
                            }}
                            className="h-6 min-w-0 flex-1 rounded border border-[#e8702a] bg-[#14161a] px-1.5 text-xs text-[#e6e8ec] focus:outline-none"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => onSelectTarget({ kind: 'group', groupId: grp.id })}
                            onDoubleClick={() => {
                              setRenamingGroupId(grp.id);
                              setRenameDraft(grp.name);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            <Group className="h-3.5 w-3.5 shrink-0 text-[#e8702a]" aria-hidden="true" />
                            <span className="truncate font-medium text-[#e6e8ec]">{grp.name}</span>
                          </button>
                        )}
                        <IconButton
                          label={`Duplicate ${grp.name}`}
                          note="Duplicate group and all members"
                          onClick={() => onDuplicateGroup(grp.id)}
                        >
                          <Copy className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Isolate ${grp.name}`}
                          active={isolated}
                          onClick={() => onToggleIsolate(grp.id)}
                        >
                          <Focus className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={grp.locked ? `Unlock ${grp.name}` : `Lock ${grp.name}`}
                          active={grp.locked}
                          onClick={() => onToggleGroupLock(grp.id)}
                        >
                          {grp.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                        </IconButton>
                        <IconButton
                          label={grp.visible ? `Hide ${grp.name}` : `Show ${grp.name}`}
                          onClick={() => onToggleGroupVisibility(grp.id)}
                        >
                          {grp.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        </IconButton>
                        <IconButton
                          label={`Ungroup ${grp.name}`}
                          note="Ungroup keeping member world positions"
                          shortcut="Ctrl+Shift+G"
                          onClick={() => onUngroupGroup(grp.id)}
                        >
                          <Ungroup className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                      </div>
                      {expanded && (
                        <div className="ml-4 space-y-0.5 border-l border-[#2a2e36] pl-2 text-[11px] text-[#98a0ad]">
                          {grp.memberIds.map((mId) => {
                            const ch = activeScene.characters.find((c) => c.id === mId);
                            const pr = sceneProps.find((p) => p.id === mId);
                            if (ch) {
                              return (
                                <button
                                  key={mId}
                                  type="button"
                                  onClick={() => onSelectTarget({ kind: 'character', instanceId: ch.id })}
                                  className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left hover:bg-[#22262e] hover:text-[#e6e8ec]"
                                >
                                  <Box className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{ch.name}</span>
                                </button>
                              );
                            }
                            if (pr) {
                              return (
                                <button
                                  key={mId}
                                  type="button"
                                  onClick={() => onSelectTarget({ kind: 'prop', propId: pr.id })}
                                  className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left hover:bg-[#22262e] hover:text-[#e6e8ec]"
                                >
                                  <Shapes className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{pr.name}</span>
                                </button>
                              );
                            }
                            return null;
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Cameras */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[#98a0ad]">
                <span>Cameras</span>
                <div className="flex gap-1">
                  <StudioButton size="xs" onClick={() => onAddCameraToScene('perspective')}>
                    + Persp
                  </StudioButton>
                  <StudioButton size="xs" onClick={() => onAddCameraToScene('orthographic')}>
                    + Ortho
                  </StudioButton>
                </div>
              </div>
              {(sceneCameras.length > 0
                ? sceneCameras
                : [{ id: 'cam_main', name: 'Scene Camera', projection: 'perspective' as const }]
              ).map((cam) => {
                const isCamSel =
                  selection.kind === 'camera' &&
                  (!selection.cameraId || selection.cameraId === cam.id) &&
                  (activeScene.activeCameraId ? activeScene.activeCameraId === cam.id : true);
                return (
                  <button
                    key={cam.id}
                    type="button"
                    onClick={() => {
                      onSelectCameraItem(cam.id);
                      onSelectTarget({ kind: 'camera', cameraId: cam.id });
                    }}
                    className={`flex w-full items-center justify-between rounded border px-2.5 py-1.5 text-left transition-colors ${
                      isCamSel
                        ? 'border-[#e8702a] bg-[#2a211c] text-[#ffffff]'
                        : 'border-[#2a2e36] bg-[#1e2127] text-[#e6e8ec] hover:border-[#383e49]'
                    }`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Camera className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
                      <span className="font-medium truncate">{cam.name}</span>
                    </span>
                    <span className="text-[10px] text-[#6b7280] uppercase">{cam.projection.slice(0, 5)}</span>
                  </button>
                );
              })}
            </div>

            {/* Characters & Expandable Rig Node Trees */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[#98a0ad]">
                <span>Characters &amp; Rig</span>
                <button
                  type="button"
                  data-studio-note="Include decorative sub-parts (eyes, mouth, collars) in bone tree"
                  onClick={() => setShowAuxNodes((v) => !v)}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    showAuxNodes ? 'bg-[#2e221b] text-[#f5a16a]' : 'text-[#6b7280] hover:text-[#e6e8ec]'
                  }`}
                >
                  {showAuxNodes ? 'All Parts' : 'Joints Only'}
                </button>
              </div>
              {activeScene.characters.length === 0 ? (
                <div className="rounded border border-dashed border-[#2a2e36] p-2.5 text-center text-[11px] text-[#6b7280]">
                  No characters yet. Add from Assets.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {activeScene.characters
                    .filter((c) => !q || c.name.toLowerCase().includes(q))
                    .map((char) => {
                      const selected =
                        (selection.kind === 'character' && selection.instanceId === char.id) ||
                        multiSelectedIds.includes(char.id);
                      const allNodes = rigNodesByInstance[char.id] ?? [];
                      const nodes = showAuxNodes ? allNodes : allNodes.filter((n) => !n.isAuxiliary);
                      const expanded = Boolean(expandedCharRigs[char.id]);
                      const isLocked = Boolean(char.lockedProperties?.transform);
                      const isIsolated = isolatedIds.includes(char.id);
                      const lockedNodeSet = new Set(char.lockedNodes ?? []);
                      const hiddenNodeSet = new Set(char.hiddenNodes ?? []);

                      const charCtxItems: ContextMenuItem[] = [
                        {
                          label: `Pose Joints (${char.name})`,
                          shortcut: 'Dbl-Click',
                          onClick: () => {
                            setExpandedCharRigs((p) => ({ ...p, [char.id]: true }));
                            onEnterPoseMode(char.id);
                          },
                        },
                        {
                          label: expanded ? 'Collapse Rig Tree' : 'Expand Rig Tree',
                          onClick: () => setExpandedCharRigs((p) => ({ ...p, [char.id]: !expanded })),
                        },
                        {
                          label: 'Group Selection',
                          shortcut: 'Ctrl+G',
                          onClick: () => {
                            onSelectTarget({ kind: 'character', instanceId: char.id });
                            onGroupSelection();
                          },
                        },
                        {
                          label: char.visible ? 'Hide Character' : 'Show Character',
                          dividerAbove: true,
                          onClick: () => onToggleCharacterVisibility(char.id),
                        },
                        {
                          label: isIsolated ? 'Un-Isolate' : 'Isolate Character',
                          onClick: () => onToggleIsolate(char.id),
                        },
                        {
                          label: isLocked ? 'Unlock Transform' : 'Lock Transform',
                          onClick: () => onToggleCharacterLock(char.id),
                        },
                        { label: 'Duplicate Instance', shortcut: 'Ctrl+D', onClick: () => onDuplicateCharacter(char.id) },
                        {
                          label: 'Remove from Scene',
                          shortcut: 'Del',
                          danger: true,
                          dividerAbove: true,
                          onClick: () => onRemoveCharacterFromScene(char.id),
                        },
                      ];

                      return (
                        <div key={char.id} className="space-y-1">
                          <div
                            tabIndex={0}
                            onContextMenu={(e) => openCtxMenu(e, charCtxItems)}
                            onKeyDown={(e) => handleRowShiftF10(e, charCtxItems)}
                            className={`flex items-center gap-0.5 rounded border p-1 transition-colors focus:outline-none ${
                              selected
                                ? 'border-[#e8702a] bg-[#2e221b]'
                                : 'border-[#2a2e36] bg-[#1e2127] hover:border-[#383e49]'
                            }`}
                          >
                            {nodes.length > 0 && (
                              <button
                                type="button"
                                aria-label={`Expand ${char.name} rig`}
                                onClick={() =>
                                  setExpandedCharRigs((prev) => ({ ...prev, [char.id]: !prev[char.id] }))
                                }
                                className="p-0.5 text-[#98a0ad] hover:text-[#e6e8ec]"
                              >
                                {expanded ? (
                                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                                ) : (
                                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) =>
                                onSelectTarget(
                                  { kind: 'character', instanceId: char.id },
                                  e.shiftKey || e.ctrlKey || e.metaKey,
                                )
                              }
                              onDoubleClick={() => onEnterPoseMode(char.id)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-left"
                            >
                              <Box className="h-3.5 w-3.5 shrink-0 text-[#98a0ad]" aria-hidden="true" />
                              <span className="truncate font-medium text-[#e6e8ec]">{char.name}</span>
                            </button>
                            <IconButton
                              label={`Isolate ${char.name}`}
                              active={isIsolated}
                              onClick={() => onToggleIsolate(char.id)}
                            >
                              <Focus className="h-3 w-3" aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              label={isLocked ? `Unlock ${char.name}` : `Lock ${char.name}`}
                              active={isLocked}
                              onClick={() => onToggleCharacterLock(char.id)}
                            >
                              {isLocked ? (
                                <Lock className="h-3 w-3" aria-hidden="true" />
                              ) : (
                                <Unlock className="h-3 w-3" aria-hidden="true" />
                              )}
                            </IconButton>
                            <IconButton
                              label={char.visible ? `Hide ${char.name}` : `Show ${char.name}`}
                              onClick={() => onToggleCharacterVisibility(char.id)}
                            >
                              {char.visible ? (
                                <Eye className="h-3 w-3" aria-hidden="true" />
                              ) : (
                                <EyeOff className="h-3 w-3 text-[#6b7280]" aria-hidden="true" />
                              )}
                            </IconButton>
                            <IconButton
                              label={`Remove ${char.name}`}
                              onClick={() => onRemoveCharacterFromScene(char.id)}
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </IconButton>
                          </div>

                          {/* Expandable Body Parts / Bone Nodes */}
                          {expanded && nodes.length > 0 && (
                            <div className="ml-4 space-y-0.5 border-l border-[#2a2e36] pl-2">
                              {nodes
                                .filter((n) => !q || n.name.toLowerCase().includes(q))
                                .map((node) => {
                                  const isNodeSel =
                                    (selection.kind === 'body-part' &&
                                      selection.instanceId === char.id &&
                                      selection.nodeId === node.nodeId) ||
                                    multiSelectedNodes.some(
                                      (m) => m.instanceId === char.id && m.nodeId === node.nodeId,
                                    );
                                  const isPartGroup = node.nodeId.startsWith('cgrp_');
                                  const nLocked = lockedNodeSet.has(node.nodeId);
                                  const nHidden = hiddenNodeSet.has(node.nodeId);
                                  return (
                                    <div
                                      key={node.nodeId}
                                      className={`flex items-center justify-between gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                                        isNodeSel
                                          ? 'bg-[#2e221b] text-[#f7be97] font-medium border border-[#e8702a]/50'
                                          : 'text-[#98a0ad] hover:bg-[#22262e] hover:text-[#e6e8ec]'
                                      }`}
                                    >
                                      <button
                                        type="button"
                                        data-studio-note={
                                          node.description ??
                                          `Click to edit ${node.name} · Ctrl+Click to multi-select parts for Ctrl+G group`
                                        }
                                        onClick={(e) =>
                                          onSelectTarget(
                                            {
                                              kind: 'body-part',
                                              instanceId: char.id,
                                              nodeId: node.nodeId,
                                              nodeName: node.name,
                                            },
                                            e.shiftKey || e.ctrlKey || e.metaKey,
                                          )
                                        }
                                        className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
                                      >
                                        {isPartGroup ? (
                                          <Group className="h-3 w-3 shrink-0 text-[#e8702a]" aria-hidden="true" />
                                        ) : (
                                          <Bone className="h-3 w-3 shrink-0" aria-hidden="true" />
                                        )}
                                        <span className="truncate">{node.name}</span>
                                        {isPartGroup && (
                                          <span className="shrink-0 rounded bg-[#2e221b] px-1 text-[9px] text-[#f5a16a]">
                                            Group
                                          </span>
                                        )}
                                      </button>
                                      <div className="flex items-center gap-0.5 shrink-0">
                                        {isPartGroup && onUngroupNodeGroup && (
                                          <button
                                            type="button"
                                            aria-label={`Ungroup ${node.name}`}
                                            data-studio-note="Ungroup parts back to original joints (Ctrl+Shift+G)"
                                            onClick={() => onUngroupNodeGroup(char.id, node.nodeId)}
                                            className="rounded p-0.5 text-[#f5a16a] hover:bg-[#2a2e36]"
                                          >
                                            <Ungroup className="h-2.5 w-2.5" />
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          aria-label={nLocked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                                          data-studio-note={nLocked ? 'Unlock part transform' : 'Lock part transform'}
                                          onClick={() => onToggleNodeLock(char.id, node.nodeId)}
                                          className={`rounded p-0.5 ${nLocked ? 'text-[#e8702a]' : 'text-[#6b7280] hover:text-[#e6e8ec]'}`}
                                        >
                                          {nLocked ? <Lock className="h-2.5 w-2.5" /> : <Unlock className="h-2.5 w-2.5" />}
                                        </button>
                                        <button
                                          type="button"
                                          aria-label={nHidden ? `Show ${node.name}` : `Hide ${node.name}`}
                                          data-studio-note={nHidden ? 'Show part mesh' : 'Hide part mesh'}
                                          onClick={() => onToggleNodeVisibility(char.id, node.nodeId)}
                                          className={`rounded p-0.5 ${nHidden ? 'text-[#e8702a]' : 'text-[#6b7280] hover:text-[#e6e8ec]'}`}
                                        >
                                          {nHidden ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Scene Props */}
            {sceneProps.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] text-[#98a0ad]">Props</div>
                {sceneProps.map((prop) => {
                  const sel =
                    (selection.kind === 'prop' && selection.propId === prop.id) ||
                    multiSelectedIds.includes(prop.id);
                  const isolated = isolatedIds.includes(prop.id);
                  return (
                    <div
                      key={prop.id}
                      className={`flex items-center gap-0.5 rounded border p-1 ${
                        sel ? 'border-[#e8702a] bg-[#2a211c]' : 'border-[#2a2e36] bg-[#1e2127]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) =>
                          onSelectTarget(
                            { kind: 'prop', propId: prop.id },
                            e.shiftKey || e.ctrlKey || e.metaKey,
                          )
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left"
                      >
                        <Shapes className="h-3.5 w-3.5 shrink-0 text-[#e8702a]" aria-hidden="true" />
                        <span className="truncate font-medium text-[#e6e8ec]">{prop.name}</span>
                      </button>
                      <IconButton
                        label={`Isolate ${prop.name}`}
                        active={isolated}
                        onClick={() => onToggleIsolate(prop.id)}
                      >
                        <Focus className="h-3 w-3" />
                      </IconButton>
                      <IconButton
                        label={prop.visible ? `Hide ${prop.name}` : `Show ${prop.name}`}
                        onClick={() => onTogglePropVisibility(prop.id)}
                      >
                        {prop.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                      </IconButton>
                      <IconButton label={`Delete ${prop.name}`} onClick={() => onRemovePropFromScene(prop.id)}>
                        <Trash2 className="h-3 w-3" />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Scene Lights */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[#98a0ad]">
                <span>Lights</span>
                <div className="flex gap-1">
                  <StudioButton size="xs" onClick={() => onAddLightToScene('point')}>
                    + Pt
                  </StudioButton>
                  <StudioButton size="xs" onClick={() => onAddLightToScene('spot')}>
                    + Spot
                  </StudioButton>
                </div>
              </div>
              {sceneLights.map((lt) => {
                const sel = selection.kind === 'light' && selection.lightId === lt.id;
                return (
                  <div
                    key={lt.id}
                    className={`flex items-center gap-1 rounded border p-1.5 ${
                      sel ? 'border-[#e8702a] bg-[#2a211c]' : 'border-[#2a2e36] bg-[#1e2127]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectTarget({ kind: 'light', lightId: lt.id })}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-left"
                    >
                      <Lightbulb className="h-3.5 w-3.5 shrink-0" style={{ color: lt.color }} aria-hidden="true" />
                      <span className="truncate text-[#e6e8ec]">{lt.name}</span>
                    </button>
                    {sceneLights.length > 1 && (
                      <IconButton label={`Remove ${lt.name}`} onClick={() => onRemoveLightFromScene(lt.id)}>
                        <Trash2 className="h-3 w-3" />
                      </IconButton>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'scenes' && (
          <div className="space-y-3">
            <div className="relative flex items-center justify-between">
              <h2 className="font-semibold text-[#e6e8ec]">Story Scenes</h2>
              <div className="flex items-center gap-1">
                <StudioButton size="xs" variant="primary" onClick={() => onCreateScene('blank-stage')}>
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  <span>New</span>
                </StudioButton>
                <StudioButton size="xs" onClick={() => setTemplateMenuOpen((v) => !v)}>
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  <span>Template</span>
                </StudioButton>
              </div>

              {templateMenuOpen && (
                <div className="absolute right-0 top-7 z-40 w-44 rounded border border-[#383e49] bg-[#1e2127] py-1 shadow-xl">
                  {(
                    [
                      ['blank-stage', 'Blank Stage'],
                      ['talk-show', 'Talk Show Studio'],
                      ['outdoor-park', 'Outdoor Park'],
                      ['spotlight-monologue', 'Spotlight Monologue'],
                    ] as [SceneTemplateId, string][]
                  ).map(([tid, label]) => (
                    <button
                      key={tid}
                      type="button"
                      onClick={() => {
                        setTemplateMenuOpen(false);
                        onCreateScene(tid);
                      }}
                      className="flex w-full px-3 py-1.5 text-left text-xs text-[#e6e8ec] hover:bg-[#262a33]"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              {scenes.map((sc, idx) => {
                const isActive = sc.id === activeScene.id;
                return (
                  <div
                    key={sc.id}
                    className={`rounded border p-2 transition-colors ${
                      isActive
                        ? 'border-[#e8702a] bg-[#2a211c]'
                        : 'border-[#2a2e36] bg-[#1e2127] hover:border-[#383e49]'
                    }`}
                  >
                    {sc.thumbnailDataUrl && (
                      <button
                        type="button"
                        onClick={() => onSwitchScene(sc.id)}
                        className="mb-1.5 block w-full overflow-hidden rounded border border-[#2a2e36]"
                      >
                        <img
                          src={sc.thumbnailDataUrl}
                          alt={`${sc.name} preview`}
                          className="h-16 w-full object-cover"
                        />
                      </button>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onSwitchScene(sc.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate font-semibold text-[#e6e8ec]">
                          {idx + 1}. {sc.name}
                        </div>
                        <div className="text-[11px] text-[#98a0ad]">
                          {sc.duration.toFixed(1)}s · {sc.characters.length} chars · {sc.props?.length ?? 0} props
                        </div>
                      </button>
                      <div className="flex items-center gap-0.5">
                        <IconButton
                          label={`Move ${sc.name} up`}
                          disabled={idx === 0}
                          onClick={() => onReorderScene(sc.id, -1)}
                        >
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Move ${sc.name} down`}
                          disabled={idx === scenes.length - 1}
                          onClick={() => onReorderScene(sc.id, 1)}
                        >
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Duplicate ${sc.name}`}
                          onClick={() => onDuplicateScene(sc.id)}
                        >
                          <Copy className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Delete ${sc.name}`}
                          disabled={scenes.length <= 1}
                          onClick={() => onDeleteScene(sc.id)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  );
}
