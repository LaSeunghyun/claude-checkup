// 첫 화면 할 일 순서 (design.md 9절 1). 스캐너 테스트와 화면이 함께 쓰므로 src/scan 을 가져오지 않는다.
import type { Category, Finding, Gain } from "./types";

export const A4_TOKENS = 1500; // 토큰 1,500개 = A4 1쪽 (추정)

// 고장 → 연결 누수 → 낭비 → 헷갈림. 위험은 순위에 넣지 않고 화면 위에 따로 둔다
const ORDER: Category[] = ["broken", "leak", "waste", "confusion"];

// 같은 분류 안에서만 비교하는 효과 크기. 토큰은 A4 쪽수로, 개수는 그대로, 모르면 0
export function gainValue(g?: Gain): number {
  if (!g) return 0;
  if (g.tokens != null) return g.tokens / A4_TOKENS;
  return g.count ?? 0;
}

// 후보는 고치기가 되는 진단(mechanical, claude)만. 같은 분류·같은 효과면 진단 순서(심각도 순) 그대로.
// 실패가 1~2번뿐인 훅(심각도 high 아님)은 일시적일 수 있어 할 일에서 뺀다. 전체 진단에는 남는다
export function topTodos(findings: Finding[], n = 3): Finding[] {
  return findings
    .filter((f) => ORDER.includes(f.category) && f.fixKind !== "manual" && !(f.rule === "failing-hook" && f.severity !== "high"))
    .sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || gainValue(b.gain) - gainValue(a.gain))
    .slice(0, n);
}
