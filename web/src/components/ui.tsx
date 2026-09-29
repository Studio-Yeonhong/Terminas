import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightToLine, Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useStore } from '../store';
import { locale, t } from '../i18n';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'soft'; size?: 'sm' | 'md'; loading?: boolean };

export function Button({ variant = 'soft', size = 'md', loading, className = '', children, disabled, ...rest }: BtnProps) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || loading} {...rest}>
      {loading && <Loader2 size={14} className="spin" />}
      {children}
    </button>
  );
}

export function IconButton({ label, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input({ icon, className = '', ...rest }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  return (
    <div className={`input ${icon ? 'has-icon' : ''} ${className}`}>
      {icon && <span className="input-icon">{icon}</span>}
      <input {...rest} />
    </div>
  );
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

// 브라우저 기본 <select> 목록은 OS 모양(흰 바탕·파란 강조)이라 앱과 안 어울린다 → 직접 그린 드롭다운.
// 쓰는 쪽은 그대로 <option value>이름</option> 자식과 onChange(e => e.target.value) 를 쓴다.
type SelectOption = { value: string; label: string; disabled: boolean };
type SelectProps = {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
};

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : isValidElement<{ children?: ReactNode }>(n) ? textOf(n.props.children) : ''))
    .join('');

function optionsOf(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  const walk = (nodes: ReactNode) =>
    Children.forEach(nodes, (child) => {
      if (!isValidElement<{ children?: ReactNode; value?: unknown; disabled?: boolean }>(child)) return;
      if (child.type === Fragment) return walk(child.props.children);
      if (child.type === 'option') out.push({ value: String(child.props.value ?? ''), label: textOf(child.props.children), disabled: Boolean(child.props.disabled) });
    });
  walk(children);
  return out;
}

export function Select({ value, onChange, children, disabled, className = '', placeholder, ...rest }: SelectProps) {
  const options = optionsOf(children);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const place = () => {
    const r = btn.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(320, options.length * 34 + 12);
    const up = below < want && above > below;
    const maxHeight = Math.max(120, Math.min(want, up ? above : below));
    setPos({ left: r.left, width: Math.max(r.width, 180), maxHeight, top: up ? r.top - 6 - maxHeight : r.bottom + 6 });
  };
  const show = () => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, selectedIndex));
    place();
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const pick = (o: SelectOption) => {
    if (o.disabled) return;
    if (o.value !== value) onChange({ target: { value: o.value } });
    close();
  };
  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < options.length; i += step) if (!options[i].disabled) return i;
    return from;
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    // 목록이 열려 있을 때의 키는 여기서 끝낸다 (Esc 가 옆 패널까지 닫지 않게)
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Tab') return close(e.key === 'Escape');
    e.preventDefault();
    if (e.key === 'ArrowDown') setActive((a) => move(a, 1));
    else if (e.key === 'ArrowUp') setActive((a) => move(a, -1));
    else if (e.key === 'Home') setActive(move(-1, 1));
    else if (e.key === 'End') setActive(move(options.length, -1));
    else if (e.key === 'Enter' || e.key === ' ') options[active] && pick(options[active]);
    else if (e.key.length === 1) {
      // 첫 글자로 찾아가기
      const k = e.key.toLowerCase();
      const next = options.findIndex((o, i) => i > active && !o.disabled && o.label.toLowerCase().startsWith(k));
      const wrap = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(k));
      if (next >= 0 || wrap >= 0) setActive(next >= 0 ? next : wrap);
    }
  };

  const selected = options[selectedIndex];
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select select-btn ${open ? 'open' : ''} ${className}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest['aria-label']}
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          if (open) close();
          else show();
        }}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value ${selected ? '' : 'placeholder'}`}>{selected?.label ?? placeholder ?? ''}</span>
        <ChevronDown size={14} className="select-caret" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="menu select-list" role="listbox" ref={list} style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}>
            {options.map((o, i) => (
              <div
                key={`${o.value}-${i}`}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled}
                className={`menu-item select-option ${i === active ? 'active' : ''} ${o.value === value ? 'selected' : ''} ${o.disabled ? 'disabled' : ''}`}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                <span className="menu-label">{o.label || ' '}</span>
                {o.value === value && <Check size={14} className="select-check" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card-block">
      {(title || actions) && (
        <div className="card-block-head">
          {title && <h3>{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function SidePanel({ title, onClose, actions, footer, children }: { title: string; onClose: () => void; actions?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="side-panel">
      <header className="side-panel-head">
        <h2>{title}</h2>
        <div className="side-panel-actions">
          {actions}
          <IconButton label={t('패널 닫기')} onClick={onClose}>
            <ArrowRightToLine size={16} />
          </IconButton>
        </div>
      </header>
      <div className="side-panel-body">{children}</div>
      {footer && <footer className="side-panel-foot">{footer}</footer>}
    </aside>
  );
}

export function Modal({ title, onClose, children, width = 520, footer }: { title?: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        {title && (
          <header className="modal-head">
            <h2>{title}</h2>
            <IconButton label={t('닫기')} onClick={onClose}>
              <X size={16} />
            </IconButton>
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// checked: 체크 표시(고르는 항목) · keepOpen: 눌러도 메뉴를 닫지 않는다(여러 개 고르기)
export type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; hint?: string; disabled?: boolean; checked?: boolean; keepOpen?: boolean } | { divider: true } | { header: string };

// 버튼 아래(또는 마우스 위치)에 뜨는 드롭다운 메뉴
export function Menu({ anchor, items, onClose, align = 'left' }: { anchor: DOMRect | { x: number; y: number }; items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = 'x' in anchor && !('width' in anchor) ? anchor.x : align === 'right' ? (anchor as DOMRect).right - w : (anchor as DOMRect).left;
    let top = 'width' in anchor ? (anchor as DOMRect).bottom + 6 : (anchor as { y: number }).y;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [anchor, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return createPortal(
    <div className="menu" ref={ref} style={pos} role="menu">
      {items.map((item, i) =>
        'divider' in item ? (
          <div key={i} className="menu-divider" />
        ) : 'header' in item ? (
          <div key={i} className="menu-header">
            {item.header}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            aria-checked={item.checked}
            onClick={() => {
              if (!item.keepOpen) onClose();
              item.onClick();
            }}
          >
            {item.checked !== undefined ? <span className="menu-icon">{item.checked ? <Check size={14} /> : null}</span> : item.icon && <span className="menu-icon">{item.icon}</span>}
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ anchor: DOMRect | { x: number; y: number }; items: MenuItem[]; align?: 'left' | 'right' } | null>(null);
  const node = menu ? <Menu anchor={menu.anchor} items={menu.items} align={menu.align} onClose={() => setMenu(null)} /> : null;
  return { node, open: setMenu };
}

export function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}

export function Avatar({ name, url, size = 28 }: { name: string; url?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return <img className="avatar" src={url} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.42, background: colorFor(name) }}>
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'accent' | 'warn' | 'danger' | 'ok' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export const PALETTE = ['#4c8dff', '#20b486', '#e0883a', '#b36ee8', '#e25c77', '#1fa9c4', '#8a9a2c', '#d45fb0', '#5f7fe0', '#cc7a2e'];

export function colorFor(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Toasts() {
  const { toasts } = useStore();
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function ConfirmDialog() {
  const { confirmRequest: req } = useStore();
  if (!req) return null;
  return (
    <Modal
      title={req.title}
      onClose={() => req.resolve(false)}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => req.resolve(false)}>
            {req.cancelLabel ?? t('취소')}
          </Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => req.resolve(true)} autoFocus>
            {req.confirmLabel ?? t('확인')}
          </Button>
        </>
      }
    >
      <p className="confirm-text">{req.message}</p>
    </Modal>
  );
}

export function TextDialog() {
  const { textRequest: req } = useStore();
  if (!req) return null;
  return <TextDialogBody key={`${req.title}:${req.value}`} req={req} />;
}

function TextDialogBody({ req }: { req: NonNullable<ReturnType<typeof useStore>['textRequest']> }) {
  const [value, setValue] = useState(req.value);
  const box = useRef<HTMLFormElement>(null);
  // 파일 이름이면 확장자 앞까지만 골라 둔다
  useLayoutEffect(() => {
    const input = box.current?.querySelector('input');
    if (!input) return;
    input.focus();
    const dot = req.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : req.value.length);
  }, [req.value]);
  return (
    <Modal
      title={req.title}
      onClose={() => req.resolve(null)}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => req.resolve(null)}>
            {t('취소')}
          </Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => req.resolve(value.trim())}>
            {req.confirmLabel ?? t('확인')}
          </Button>
        </>
      }
    >
      <form
        ref={box}
        className="text-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) req.resolve(value.trim());
        }}
      >
        {req.label && <span className="field-label">{req.label}</span>}
        <Input value={value} onChange={(e) => setValue(e.target.value)} />
        {req.hint && <p className="muted small">{req.hint}</p>}
      </form>
    </Modal>
  );
}

export function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return t('방금');
  if (m < 60) return t('{count}분 전', { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('{count}시간 전', { count: h });
  const d = Math.round(h / 24);
  if (d < 30) return t('{count}일 전', { count: d });
  return new Date(ts).toLocaleDateString(locale());
}

export function formatTime(ts: number) {
  return new Date(ts).toLocaleString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
