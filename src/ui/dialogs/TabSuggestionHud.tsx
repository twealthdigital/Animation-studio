import React from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Eye, Sparkles, X } from 'lucide-react';
import type { TabPrediction } from '../../core/types';
import { StudioButton } from '../components/Primitives';

interface TabSuggestionHudProps {
  open: boolean;
  predictions: TabPrediction[];
  activeIndex: number;
  previewActive: boolean;
  onSelectIndex: (idx: number) => void;
  onTogglePreview: (pred: TabPrediction) => void;
  onApply: (pred: TabPrediction) => void;
  onDismiss: () => void;
}

const CATEGORY_LABELS: Record<TabPrediction['category'], string> = {
  pose: 'Joint Pose',
  motion: 'Motion Clip',
  keyframe: 'Keyframe',
  camera: 'Camera',
  'rig-fallback': 'Rig-Safe',
};

export function TabSuggestionHud({
  open,
  predictions,
  activeIndex,
  previewActive,
  onSelectIndex,
  onTogglePreview,
  onApply,
  onDismiss,
}: TabSuggestionHudProps) {
  if (!open || predictions.length === 0) return null;

  const safeIdx = Math.max(0, Math.min(predictions.length - 1, activeIndex));
  const active = predictions[safeIdx];

  return (
    <div
      role="dialog"
      aria-label="Animation Prediction Suggestions"
      data-testid="tab-suggestion-hud"
      className="pointer-events-auto absolute bottom-3 left-1/2 z-30 w-[440px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-md border border-[#3a404c] bg-[#181a1f] shadow-2xl"
    >
      {/* Compact Header */}
      <div className="flex items-center justify-between border-b border-[#2a2e36] bg-[#14161a] px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-[#e6e8ec]">
          <Sparkles className="h-3.5 w-3.5 text-[#e8702a]" aria-hidden="true" />
          <span>Animation Prediction</span>
          <span className="rounded bg-[#252932] px-1.5 py-0.5 font-mono-code text-[10px] text-[#98a0ad]">
            {safeIdx + 1}/{predictions.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous prediction"
            onClick={() => onSelectIndex((safeIdx - 1 + predictions.length) % predictions.length)}
            className="rounded p-1 text-[#98a0ad] hover:bg-[#252932] hover:text-[#e6e8ec]"
          >
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next prediction"
            onClick={() => onSelectIndex((safeIdx + 1) % predictions.length)}
            className="rounded p-1 text-[#98a0ad] hover:bg-[#252932] hover:text-[#e6e8ec]"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Dismiss suggestions"
            onClick={onDismiss}
            className="rounded p-1 text-[#98a0ad] hover:bg-[#252932] hover:text-[#e6e8ec]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Candidate List (compact clickable rows) */}
      <div className="max-h-40 divide-y divide-[#22262e] overflow-y-auto">
        {predictions.map((pred, idx) => {
          const selected = idx === safeIdx;
          return (
            <button
              key={pred.id}
              type="button"
              onClick={() => onSelectIndex(idx)}
              className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left transition-colors ${
                selected ? 'bg-[#2a211c]' : 'hover:bg-[#1e2127]'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-[#e6e8ec]">{pred.title}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                      pred.compatible
                        ? 'bg-[#1a2c27] text-[#4ade80]'
                        : 'bg-[#3a221d] text-[#fca5a5]'
                    }`}
                  >
                    {CATEGORY_LABELS[pred.category]}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-[#98a0ad]">{pred.reason}</p>
                {!pred.compatible && pred.incompatibilityReason && (
                  <p className="mt-1 flex items-start gap-1 text-[10px] text-[#fca5a5]">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    <span>{pred.incompatibilityReason}</span>
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Action Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-[#2a2e36] bg-[#14161a] px-3 py-2">
        <div className="text-[10px] text-[#98a0ad]">
          <span className="font-mono-code text-[#e6e8ec]">↑↓</span> Cycle ·{' '}
          <span className="font-mono-code text-[#e6e8ec]">Enter</span> Apply ·{' '}
          <span className="font-mono-code text-[#e6e8ec]">Esc</span> Dismiss
        </div>
        <div className="flex items-center gap-1.5">
          <StudioButton
            size="xs"
            variant={previewActive ? 'primary' : 'default'}
            disabled={!active.compatible}
            title="Temporarily preview this suggestion in viewport without committing"
            onClick={() => onTogglePreview(active)}
          >
            <Eye className="h-3 w-3" aria-hidden="true" />
            <span>{previewActive ? 'Previewing' : 'Preview'}</span>
          </StudioButton>
          <StudioButton
            size="xs"
            variant="primary"
            disabled={!active.compatible}
            title="Apply prediction cleanly (Undoable with Ctrl+Z)"
            onClick={() => onApply(active)}
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            <span>Apply</span>
          </StudioButton>
        </div>
      </div>
    </div>
  );
}
