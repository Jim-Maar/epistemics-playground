/** Shared interface pieces: popovers, menus, dialogs, toasts and small controls. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { createStore, dismissToast, toastStore, useStore } from "../stores";

const VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 6;

// ---------- Popovers ----------

type Anchor = { left: number; top: number; bottom: number; right: number };
type PopoverState = { anchor: Anchor; content: ReactNode } | null;

const popoverStore = createStore<PopoverState>(null);

export function openPopover(anchor: Element | { x: number; y: number }, content: ReactNode) {
  const rect =
    anchor instanceof Element
      ? anchor.getBoundingClientRect()
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  popoverStore.set({ anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right }, content });
}

export const closePopover = () => popoverStore.set(null);

export function PopoverHost() {
  const state = useStore(popoverStore);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!state || !ref.current) return setPosition(null);
    const { width, height } = ref.current.getBoundingClientRect();
    const fitsBelow = state.anchor.bottom + POPOVER_GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
    const top = fitsBelow ? state.anchor.bottom + POPOVER_GAP : Math.max(VIEWPORT_MARGIN, state.anchor.top - POPOVER_GAP - height);
    const left = Math.max(VIEWPORT_MARGIN, Math.min(state.anchor.left, window.innerWidth - width - VIEWPORT_MARGIN));
    setPosition({ left, top });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) closePopover();
    };
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && closePopover();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [state]);

  if (!state) return null;
  return (
    <div ref={ref} className="popover" style={{ ...(position ?? { left: 0, top: 0 }), visibility: position ? "visible" : "hidden" }}>
      {state.content}
    </div>
  );
}

// ---------- Menus ----------

export type MenuItem =
  | { label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | "separator";

function Menu({ items }: { items: MenuItem[] }) {
  return (
    <div className="menu" role="menu">
      {items.map((item, index) =>
        item === "separator" ? (
          <hr key={index} />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={item.danger ? "menu-item danger" : "menu-item"}
            disabled={item.disabled}
            onClick={() => {
              closePopover();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export function openMenu(event: MouseEvent, items: MenuItem[], atPointer = false) {
  event.preventDefault();
  event.stopPropagation();
  openPopover(atPointer ? { x: event.clientX, y: event.clientY } : event.currentTarget, <Menu items={items} />);
}

// ---------- Dialogs ----------

const dialogStore = createStore<{ title: string; content: ReactNode; wide?: boolean } | null>(null);

export function openDialog(title: string, content: ReactNode, wide = false) {
  dialogStore.set({ title, content, wide });
}

export const closeDialog = () => dialogStore.set(null);

export function DialogHost() {
  const state = useStore(dialogStore);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state && !ref.current?.open) ref.current?.showModal();
    if (!state && ref.current?.open) ref.current.close();
  }, [state]);
  return (
    <dialog
      ref={ref}
      className={state?.wide ? "dialog wide" : "dialog"}
      onClose={closeDialog}
      onClick={(event) => event.target === ref.current && closeDialog()}
    >
      {state && (
        <>
          <header className="dialog-head">
            <h2>{state.title}</h2>
            <IconButton label="Close" onClick={closeDialog}>
              <X size={16} />
            </IconButton>
          </header>
          <div className="dialog-body">{state.content}</div>
        </>
      )}
    </dialog>
  );
}

// ---------- Toasts ----------

export function ToastHost() {
  const toasts = useStore(toastStore);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- Small controls ----------

export function IconButton(props: {
  label: string; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; children: ReactNode; active?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={props.active ? "icon-btn active" : "icon-btn"}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** A text box that replaces a name in place. Enter saves, Escape cancels, leaving it saves. */
export function InlineEdit(props: { value: string; onSave: (value: string) => void; onCancel: () => void; className?: string }) {
  const [value, setValue] = useState(props.value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (save && trimmed && trimmed !== props.value) props.onSave(trimmed);
    else props.onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  };
  return (
    <input
      className={props.className ?? "inline-edit"}
      value={value}
      autoFocus
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

export function Toggle(props: { id: string; checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="toggle-row" htmlFor={props.id}>
      <input id={props.id} type="checkbox" role="switch" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="toggle" aria-hidden="true" />
      {props.label}
    </label>
  );
}

/** A textarea that grows with its text. */
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }) {
  const { maxHeight, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, maxHeight ?? Number.POSITIVE_INFINITY)}px`;
  }, [props.value, maxHeight]);
  return <textarea ref={ref} rows={1} {...rest} />;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
