// 줄 단위 diff (LCS). 바뀐 줄과 그 주변 context 줄만 돌려준다.
import type { DiffLine } from "../shared/types";

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // 앞뒤 같은 줄은 걷어 내고 가운데만 LCS 를 푼다
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const same = (xs: string[]): DiffLine[] => xs.map((text) => ({ op: " ", text }));
  const all: DiffLine[] = [...same(a.slice(0, s)), ...middle(a.slice(s, a.length - e), b.slice(s, b.length - e)), ...same(a.slice(a.length - e))];
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, i) => {
    if (l.op === " ") return;
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true;
  });
  return all.filter((_, i) => keep[i]);
}

function middle(a: string[], b: string[]): DiffLine[] {
  const del = (xs: string[]): DiffLine[] => xs.map((text) => ({ op: "-", text }));
  const add = (xs: string[]): DiffLine[] => xs.map((text) => ({ op: "+", text }));
  if (!a.length) return add(b);
  if (!b.length) return del(a);
  if (a.length * b.length > MAX_CELLS) return [...del(a), ...add(b)];
  const n = a.length;
  const m = b.length;
  const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  return [...out, ...del(a.slice(i)), ...add(b.slice(j))];
}
