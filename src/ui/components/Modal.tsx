import { useEffect, useRef, type ReactNode } from "react";
import { Close } from "../icons";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  /** 제목 요소의 id (aria-labelledby) */
  labelledBy: string;
  onClose: () => void;
  /** 이 값이 바뀌면(다른 항목으로 이동) 포커스를 다시 다이얼로그로 옮긴다 */
  focusKey?: string;
  children: ReactNode;
}

/** 다이얼로그: Esc 로 닫기, 안쪽으로 포커스 이동, 닫으면 연 버튼으로 복귀, Tab 은 안에서만 돈다 */
export function Modal({ labelledBy, onClose, focusKey, children }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, []);

  useEffect(() => {
    dialog.current?.focus();
    dialog.current?.scrollTo({ top: 0 });
  }, [focusKey]);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialog.current) return;
    const list = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (list.length === 0) return e.preventDefault();
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="overlay overlay--center"
      role="presentation"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="dialog big"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn btn-secondary icon-btn" type="button" aria-label="닫기" onClick={onClick}>
      <Close size={20} />
    </button>
  );
}
