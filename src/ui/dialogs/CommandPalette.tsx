import { useEffect, useState } from 'react';
import { Command, Search } from 'lucide-react';

export interface PaletteAction {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

export function CommandPalette({ open, onClose, actions }: CommandPaletteProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  if (!open) return null;

  const filtered = actions.filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return a.label.toLowerCase().includes(q) || a.category.toLowerCase().includes(q);
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-20 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-md border border-[#383e49] bg-[#191b1f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[#2a2e36] px-3 py-2.5">
          <Search className="h-4 w-4 text-[#e8702a]" aria-hidden="true" />
          <input
            type="text"
            autoFocus
            placeholder="Search tools, actions, cameras, modes, or shortcuts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && filtered[0]) {
                filtered[0].run();
                onClose();
              }
            }}
            className="flex-1 bg-transparent text-xs text-[#e6e8ec] placeholder-[#6b7280] focus:outline-none"
          />
          <span className="rounded bg-[#262a33] px-1.5 py-0.5 font-mono-code text-[10px] text-[#98a0ad]">
            ESC
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[#6b7280]">
              No matching studio commands.
            </div>
          ) : (
            filtered.map((act) => (
              <button
                key={act.id}
                type="button"
                onClick={() => {
                  act.run();
                  onClose();
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-[#e6e8ec] hover:bg-[#262a33]"
              >
                <div className="flex items-center gap-2">
                  <Command className="h-3 w-3 text-[#98a0ad]" aria-hidden="true" />
                  <span className="rounded bg-[#22262e] px-1.5 py-0.5 text-[10px] text-[#98a0ad]">
                    {act.category}
                  </span>
                  <span>{act.label}</span>
                </div>
                {act.shortcut && (
                  <span className="font-mono-code text-[10px] text-[#6b7280]">
                    {act.shortcut}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
