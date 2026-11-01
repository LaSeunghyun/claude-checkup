// 글 처리 도구: frontmatter, 요약, 개요, 토큰 추정, 링크 추출.

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { data: {}, body: t };
  const data: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!km) continue;
    let val = km[2].trim();
    const block = /^[|>][+-]?\d*$/.test(val);
    const parts: string[] = block || val === "" ? [] : [val];
    // 들여쓴 이어지는 줄을 모은다 (블록 스칼라, 여러 줄 따옴표, 값이 다음 줄에 있는 경우)
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (block && lines[i + 1].trim() === ""))) {
      parts.push(lines[++i].trim());
    }
    val = parts.filter(Boolean).join(" ").trim();
    if (/^"[\s\S]*"$/.test(val)) val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, " ");
    else if (/^'[\s\S]*'$/.test(val)) val = val.slice(1, -1).replace(/''/g, "'");
    data[km[1]] = val;
  }
  return { data, body: t.slice(m[0].length) };
}

function clean(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, max = 300): string {
  const cp = Array.from(s);
  return cp.length <= max ? s : cp.slice(0, max - 1).join("") + "…";
}

// 첫 문단: 제목·주석·구분선·코드 블록은 건너뛴다
export function firstParagraph(body: string): string {
  const out: string[] = [];
  let fence = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const skip = /^#{1,6}\s/.test(line) || line.startsWith("<!--") || /^(-{3,}|\*{3,}|_{3,})$/.test(line);
    if (!line || skip) {
      if (out.length) break;
      continue;
    }
    out.push(line);
  }
  return clean(out.join(" "));
}

export function summarize(description: string | undefined, body: string): string {
  const d = description ? clean(description) : "";
  return truncate(d || firstParagraph(body), 300);
}

export function outlineOf(body: string, max = 40): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of body.split(/\r?\n/)) {
    if (raw.trimStart().startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(raw);
    if (m) {
      out.push(clean(m[1]));
      if (out.length >= max) break;
    }
  }
  return out;
}

// 토큰 추정 = ceil(ASCII 글자 수 / 4 + 비ASCII 글자 수 / 1.5)
export function estimateTokens(s: string): number {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (s.length - ascii) / 1.5);
}

export function countLines(s: string): number {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

export function stripCode(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

// 메모리 링크: [제목](파일.md) 와 [[이름]]. 코드 안, 외부 주소, 앵커는 제외한다
export function memoryLinks(text: string): string[] {
  const t = stripCode(text);
  const out: string[] = [];
  const re = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    let target = m[1].replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    target = decodeSafe(target.split("#")[0]);
    if (/\.md$/i.test(target)) out.push(target);
  }
  const re2 = /\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g;
  while ((m = re2.exec(t))) out.push(m[1].trim());
  return out;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 지시문의 @경로 import 후보
export function importRefs(text: string): string[] {
  const t = stripCode(text);
  const out = new Set<string>();
  const re = /(?:^|[\s(])@((?:~|\.{1,2})?[\w.\-/\\]*[\w])/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const p = m[1];
    if (/[/\\.]/.test(p)) out.add(p);
  }
  return [...out];
}

// 같은 줄 비교용 정규화
export function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[\s>*+\-#|]+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!|]+$/, "")
    .trim();
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function wordSet(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 2) out.add(w);
  return out;
}
