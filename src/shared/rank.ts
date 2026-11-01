// 첫 화면의 "할 일 3개"를 고르는 순서. 화면과 서버가 같이 쓰므로 src/scan 을 가져오지 않는다.
import type { Category, Finding } from "./types";

const ORDER: Category[] = ["broken", "leak", "waste", "confusion"];
const TOKENS_PER_PAGE = 1500;

// 분류 안에서 비교하는 효과 크기. 토큰은 A4 쪽수로 바꿔서 개수와 같은 눈금에 둔다
function size(f: Finding): number {
  const g = f.gain;
  if (!g) return 0;
  return g.tokens != null ? g.tokens / TOKENS_PER_PAGE : (g.count ?? 0);
}

/** 위험은 따로 보여 주고, 사용자가 직접 해야 하는 진단은 뺀다. 고장, 연결 누수, 낭비, 헷갈림 순이고 같은 분류에서는 효과가 큰 것부터 */
export function topTodos(findings: Finding[], n = 3): Finding[] {
  return findings
    .filter((f) => f.category !== "risk" && f.fixKind !== "manual")
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ORDER.indexOf(a.f.category) - ORDER.indexOf(b.f.category) || size(b.f) - size(a.f) || a.i - b.i)
    .slice(0, n)
    .map((x) => x.f);
}
