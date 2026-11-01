import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "manual";

/** 클립보드 API 가 막히면 숨은 textarea 를 선택해 복사 명령을 쓴다 */
function copyBySelection(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.className = "copy-hidden";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

interface CopyButtonProps {
  text: string;
  label: string;
  /** 버튼 모양. 기본은 보조 작은 버튼 */
  variant?: "secondary" | "ghost";
}

/** 복사 버튼. 어떤 방법으로도 복사하지 못하면 글을 선택해 둔 상자를 보여 줘서 직접 복사하게 한다 */
export function CopyButton({ text, label, variant = "secondary" }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (state === "manual") area.current?.select();
  }, [state]);

  const copy = async () => {
    clearTimeout(timer.current);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyBySelection(text);
    }
    setState(ok ? "copied" : "manual");
    if (ok) timer.current = setTimeout(() => setState("idle"), 2200);
  };

  return (
    <>
      <button className={`btn btn-${variant} btn-sm`} type="button" onClick={copy}>
        {state === "copied" ? "복사했어요" : label}
      </button>
      <span className="sr-only" role="status">
        {state === "copied" ? "복사했어요" : ""}
      </span>
      {state === "manual" && (
        <div className="copy-manual">
          <p className="help">자동으로 복사하지 못했어요. 아래 글을 선택해 둘 테니 직접 복사해 주세요.</p>
          <textarea ref={area} className="copy-box" readOnly value={text} rows={4} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </>
  );
}
