import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, historyFile, previousOf } from "../src/scan/history";
import type { HistorySummary } from "../src/shared/types";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-hist-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const sum = (n: number): HistorySummary => ({
  at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  totalTokens: n,
  unusedTokens: 0,
  leaks: { unreachable: 0, brokenLinks: 0, unread: 0, unusedTokens: 0 } as HistorySummary["leaks"],
  byCategory: {} as HistorySummary["byCategory"],
});

test("기록 파일은 HOME/.claude-checkup/history.json", () => {
  expect(historyFile(home)).toBe(join(home, ".claude-checkup", "history.json"));
});

test("기록은 50개까지", () => {
  for (let i = 0; i < 60; i++) appendHistory(home, sum(i));
  const list = JSON.parse(readFileSync(historyFile(home), "utf8")) as HistorySummary[];
  expect(list.length).toBe(50);
  expect(list[0].totalTokens).toBe(10);
  expect(list[49].totalTokens).toBe(59);
});

test("첫 점검은 previous 없음", () => {
  expect(existsSync(historyFile(home))).toBe(false);
  expect(previousOf(home, sum(1))).toBeUndefined();
});

test("두 번째 점검은 직전 요약을 previous 로", () => {
  appendHistory(home, sum(1));
  appendHistory(home, sum(2));
  expect(previousOf(home, sum(3))?.totalTokens).toBe(2);
  // 같은 시각은 건너뛴다
  expect(previousOf(home, sum(2))?.totalTokens).toBe(1);
});

test("망가진 기록 파일은 없는 것으로 본다", () => {
  appendHistory(home, sum(1));
  writeFileSync(historyFile(home), "{broken");
  expect(previousOf(home, sum(2))).toBeUndefined();
  appendHistory(home, sum(2));
  expect(previousOf(home, sum(3))?.totalTokens).toBe(2);
});
