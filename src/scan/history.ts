// 점검 요약 기록: HOME/.claude-checkup/history.json 에 최근 50개만 둔다
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HistorySummary } from "../shared/types";

const MAX = 50;

export const historyFile = (home: string): string => join(home, ".claude-checkup", "history.json");

function load(home: string): HistorySummary[] {
  try {
    const j = JSON.parse(readFileSync(historyFile(home), "utf8"));
    return Array.isArray(j) ? j.filter((x) => x && typeof x.at === "string") : [];
  } catch {
    return [];
  }
}

export function appendHistory(home: string, s: HistorySummary): void {
  const list = [...load(home), s].slice(-MAX);
  const f = historyFile(home);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(list, null, 2));
}

// 가장 최근 기록 중 now 와 시각이 다른 것
export function previousOf(home: string, now: HistorySummary): HistorySummary | undefined {
  const list = load(home);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].at !== now.at) return list[i];
  return undefined;
}
