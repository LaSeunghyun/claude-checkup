import { useId, useRef, type ReactNode } from "react";

// 용어가 화면에 처음 나올 때 붙이는 한 줄 설명 (docs/design.md 3절)
const TERMS: Record<string, string> = {
  플러그인: "Claude Code에 설치해서 작업 설명서, 에이전트 같은 기능을 한꺼번에 더해 주는 묶음이에요.",
  "작업 설명서": "Claude가 특정 일을 할 때 꺼내 보는 설명서예요.",
  "자동 실행 규칙": "정해진 때가 되면 Claude Code가 저절로 실행하는 명령이에요.",
  "연결된 서비스": "Claude가 바깥 도구와 이어 쓰게 해 주는 연결이에요.",
  메모리: "Claude가 대화가 끝나도 잊지 않도록 적어 두는 메모 파일이에요.",
  에이전트: "Claude가 특정 역할을 맡겨 따로 일을 시키는 도우미예요.",
  컨텍스트: "Claude가 한 번에 기억하고 있는 대화와 자료의 범위예요.",
};
const RE = new RegExp(Object.keys(TERMS).sort((a, b) => b.length - a.length).join("|"));

/** 용어 하나. 누르거나 포커스하면 설명이 떠요. 화면 가장자리에서 잘리지 않게 위치를 밀어 준다 */
function Term({ word }: { word: string }) {
  const id = useId();
  const tip = useRef<HTMLSpanElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const place = () => {
    const t = tip.current;
    const h = host.current;
    if (!t || !h) return;
    t.style.transform = "";
    const box = t.getBoundingClientRect();
    const left = h.getBoundingClientRect().left;
    const gutter = 16;
    const over = left + box.width - (window.innerWidth - gutter);
    const shift = over > 0 ? -Math.min(over, left - gutter) : 0;
    if (shift) t.style.transform = `translateX(${shift}px)`;
  };
  return (
    <span className="term-tip" ref={host} tabIndex={0} aria-describedby={id} onMouseEnter={place} onFocus={place}>
      {word}
      <span className="tip" id={id} role="tooltip" ref={tip}>
        {TERMS[word]}
      </span>
    </span>
  );
}

/** 글 안에서 아직 설명하지 않은 용어의 첫 등장에만 설명을 붙인다. seen 은 화면을 만드는 쪽이 한 번 그릴 때마다 새로 만든다 */
export function withTerms(text: string, seen: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  for (;;) {
    const m = RE.exec(rest);
    if (!m) break;
    const word = m[0];
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (seen.has(word)) out.push(word);
    else {
      seen.add(word);
      out.push(<Term key={n++} word={word} />);
    }
    rest = rest.slice(m.index + word.length);
  }
  if (rest) out.push(rest);
  return out;
}
