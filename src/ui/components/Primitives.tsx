import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

interface TooltipState {
  note: string;
  shortcut?: string;
  x: number;
  y: number;
}

export function StudioTooltipHost() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const showForEl = (el: HTMLElement, delayMs: number) => {
      const note = el.getAttribute('data-studio-note');
      if (!note) return;
      const shortcut = el.getAttribute('data-studio-shortcut') ?? undefined;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * 0.5;
      const y = rect.bottom + 8;

      clearTimer();
      activeElRef.current = el;
      if (delayMs <= 0) {
        setTip({ note, shortcut, x, y });
      } else {
        timerRef.current = window.setTimeout(() => {
          if (activeElRef.current === el) {
            const r = el.getBoundingClientRect();
            setTip({
              note,
              shortcut,
              x: r.left + r.width * 0.5,
              y: r.bottom + 8,
            });
          }
        }, delayMs);
      }
    };

    const hideAll = () => {
      clearTimer();
      activeElRef.current = null;
      setTip(null);
    };

    const onPointerOver = (e: PointerEvent) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-studio-note]');
      if (!target) {
        if (activeElRef.current) hideAll();
        return;
      }
      if (target === activeElRef.current) return;
      showForEl(target, 260);
    };

    const onPointerOut = (e: PointerEvent) => {
      if (!activeElRef.current) return;
      const related = (e.relatedTarget as HTMLElement | null)?.closest<HTMLElement>('[data-studio-note]');
      if (related !== activeElRef.current) {
        hideAll();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-studio-note]');
      if (target && target.matches(':focus-visible')) {
        showForEl(target, 120);
      }
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', hideAll, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', hideAll, true);
    window.addEventListener('scroll', hideAll, true);
    window.addEventListener('keydown', hideAll, true);

    return () => {
      clearTimer();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointerdown', hideAll, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', hideAll, true);
      window.removeEventListener('scroll', hideAll, true);
      window.removeEventListener('keydown', hideAll, true);
    };
  }, []);

  if (!tip) return null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  const clampedX = Math.max(120, Math.min(vw - 120, tip.x));
  const showAbove = tip.y + 44 > vh;
  const clampedY = showAbove ? Math.max(12, tip.y - 44) : tip.y;

  return (
    <div
      role="tooltip"
      data-testid="studio-hover-note"
      style={{ left: clampedX, top: clampedY, transform: 'translateX(-50%)' }}
      className="pointer-events-none fixed z-[90] flex max-w-[260px] items-center gap-2 rounded border border-[#3e4554] bg-[#14161a] px-2.5 py-1.5 text-[11px] leading-snug text-[#e6e8ec] shadow-2xl"
    >
      <span>{tip.note}</span>
      {tip.shortcut && (
        <kbd className="shrink-0 rounded border border-[#383e49] bg-[#22262f] px-1 py-0.5 font-mono-code text-[9px] text-[#f5b489]">
          {tip.shortcut}
        </kbd>
      )}
    </div>
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'selected';
  size?: 'xs' | 'sm';
  note?: string;
  shortcut?: string;
}

export function StudioButton({
  variant = 'default',
  size = 'sm',
  note,
  shortcut,
  title,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#e8702a] focus-visible:outline-offset-1 disabled:opacity-35 disabled:cursor-not-allowed';
  const sizeCls = size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs';
  const varCls =
    variant === 'primary'
      ? 'bg-[#e8702a] text-[#121316] hover:bg-[#f07f3c] font-semibold shadow-sm'
      : variant === 'selected'
        ? 'border border-[#e8702a] bg-[#2e221b] text-[#f7be97] font-semibold'
        : variant === 'danger'
          ? 'border border-[#7f2d2d] bg-[#2a1717] text-[#f3b3b3] hover:bg-[#3a1d1d]'
          : variant === 'ghost'
            ? 'text-[#a3abb8] hover:bg-[#252932] hover:text-[#e6e8ec]'
            : 'border border-[#353b47] bg-[#202329] text-[#e6e8ec] hover:border-[#4c5464] hover:bg-[#272b34]';

  const resolvedNote = note ?? title;

  return (
    <button
      type="button"
      data-studio-note={resolvedNote || undefined}
      data-studio-shortcut={shortcut || undefined}
      className={`${base} ${sizeCls} ${varCls} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  note?: string;
  shortcut?: string;
  active?: boolean;
}

export function IconButton({
  label,
  note,
  shortcut,
  active = false,
  className = '',
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      data-studio-note={note ?? label}
      data-studio-shortcut={shortcut || undefined}
      className={`inline-flex h-7 w-7 items-center justify-center rounded border transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-[#e8702a] disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? 'border-[#e8702a] bg-[#2e221b] text-[#f5a16a]'
          : 'border-transparent text-[#98a0ad] hover:border-[#383e49] hover:bg-[#252932] hover:text-[#e6e8ec]'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface CustomSelectProps<T extends string> {
  label?: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  note?: string;
}

export function CustomSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  note,
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className="relative">
      {label && <div className="mb-1 text-[11px] text-[#98a0ad]">{label}</div>}
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label ?? 'Select option'}
        data-studio-note={note || undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center justify-between gap-2 rounded border border-[#2e333d] bg-[#14161a] px-2 text-xs text-[#e6e8ec] hover:border-[#464d5b] disabled:opacity-45"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#6b7280]" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-50 mt-1 max-h-52 overflow-y-auto rounded border border-[#383e49] bg-[#1e2127] py-1 shadow-xl"
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              disabled={opt.disabled}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                opt.value === value
                  ? 'bg-[#2e221b] text-[#f5a16a] font-medium'
                  : 'text-[#e6e8ec] hover:bg-[#262a33]'
              }`}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface NumericInputProps {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  onChange: (val: number) => void;
  disabled?: boolean;
}

export function NumericInput({
  label,
  value,
  step = 0.1,
  min,
  max,
  decimals = 2,
  onChange,
  disabled = false,
}: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft !== null ? draft : Number.isFinite(value) ? value.toFixed(decimals) : '0';

  const commit = (raw: string) => {
    setDraft(null);
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    let clamped = parsed;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    onChange(clamped);
  };

  return (
    <label className="flex min-w-0 items-center gap-1 text-xs">
      <span className="shrink-0 text-[10px] font-medium text-[#98a0ad]">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={display}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
          }
        }}
        className="h-7 w-full min-w-0 rounded border border-[#2e333d] bg-[#14161a] px-1.5 font-mono-code text-[11px] text-[#e6e8ec] focus:border-[#e8702a] focus:outline-none disabled:opacity-45"
      />
    </label>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  displayValue?: string;
  onChange: (val: number) => void;
}

export function StudioSlider({
  label,
  value,
  min,
  max,
  step = 0.01,
  displayValue,
  onChange,
}: SliderProps) {
  return (
    <label className="block space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#98a0ad]">{label}</span>
        <span className="font-mono-code text-[#e6e8ec]">{displayValue ?? value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="studio-slider w-full"
      />
    </label>
  );
}

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  widthClass?: string;
  children: React.ReactNode;
}

export function Dialog({
  open,
  title,
  onClose,
  widthClass = 'max-w-lg',
  children,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`w-full ${widthClass} rounded border border-[#323741] bg-[#191b1f] shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-[#2a2e36] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#e6e8ec]">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
        <div className="max-h-[78vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} title={title} onClose={onCancel} widthClass="max-w-sm">
      <p className="text-xs leading-relaxed text-[#98a0ad]">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <StudioButton onClick={onCancel}>Cancel</StudioButton>
        <StudioButton variant="danger" onClick={onConfirm}>
          {confirmLabel}
        </StudioButton>
      </div>
    </Dialog>
  );
}

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  dividerAbove?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOnDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const closeOnKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDownWrap(closeOnDown));
    window.addEventListener('keydown', closeOnKey);
    return () => {
      window.removeEventListener('pointerdown', closeOnDown);
      window.removeEventListener('keydown', closeOnKey);
    };
  }, [onClose]);

  function onDownWrap(fn: (e: PointerEvent) => void) {
    return fn;
  }

  const clampedLeft = typeof window !== 'undefined' ? Math.min(x, Math.max(8, window.innerWidth - 220)) : x;
  const clampedTop = typeof window !== 'undefined' ? Math.min(y, Math.max(8, window.innerHeight - items.length * 32 - 16)) : y;

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="studio-context-menu"
      style={{ top: clampedTop, left: clampedLeft }}
      className="fixed z-50 min-w-[196px] rounded border border-[#3a404c] bg-[#1c1f26] py-1 shadow-2xl"
    >
      {items.map((item, idx) => (
        <React.Fragment key={idx}>
          {item.dividerAbove && <div className="my-1 border-t border-[#2c313b]" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
              item.danger
                ? 'text-[#f3b3b3] hover:bg-[#3a1d1d]'
                : 'text-[#e6e8ec] hover:bg-[#262a33]'
            }`}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="font-mono-code text-[10px] text-[#7b8394]">{item.shortcut}</span>
            )}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

interface WaveformCanvasProps {
  peaks?: number[];
  color?: string;
  height?: number;
}

export function WaveformCanvas({
  peaks,
  color = '#e8702a',
  height = 28,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.length === 0) return;

    ctx.fillStyle = color;
    const barW = Math.max(1, w / peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(0.06, peaks[i]);
      const barH = amp * (h - 4);
      const x = i * barW;
      const y = (h - barH) / 2;
      ctx.fillRect(x, y, Math.max(1, barW - 1), barH);
    }
  }, [peaks, color]);

  if (!peaks || peaks.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-[#2a2e36] bg-[#14161a] text-[10px] text-[#6b7280]"
        style={{ height }}
      >
        No audio waveform attached
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={240}
      height={height}
      className="w-full rounded bg-[#14161a]"
      style={{ height }}
    />
  );
}
