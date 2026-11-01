// 기계적 고치기 계획: 플러그인 끄기, 보관 폴더로 옮기기. 미리 보기는 파일을 하나도 바꾸지 않는다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { overlayFrom, redactSecrets } from "../scan/fsutil";
import type { FileChange } from "../shared/types";
import { hashPath, type Planned } from "./backup";
import { lineDiff } from "./diff";
import { absOf, claudeRoot, offDir, relOf } from "./paths";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// settings.json 에서 키들의 enabledPlugins 값을 false 로. 모양은 되도록 그대로 둔다
function disableInText(text: string, keys: string[]): string {
  let out = text;
  const missing: string[] = [];
  for (const k of keys) {
    const q = esc(JSON.stringify(k).slice(1, -1));
    const on = new RegExp(`("${q}"\\s*:\\s*)true\\b`);
    if (on.test(out)) out = out.replace(on, "$1false");
    else if (!new RegExp(`"${q}"\\s*:\\s*false\\b`).test(out)) missing.push(k);
  }
  if (!missing.length) return out;
  // 자리가 없으면 JSON 으로 다시 쓴다
  let j: any = {};
  try {
    j = out.trim() ? JSON.parse(out) : {};
  } catch {
    throw new Error("settings.json 을 읽을 수 없어서 플러그인을 끌 수 없어요");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) j = {};
  if (!j.enabledPlugins || typeof j.enabledPlugins !== "object") j.enabledPlugins = {};
  for (const k of keys) j.enabledPlugins[k] = false;
  return JSON.stringify(j, null, 2) + "\n";
}

export function planPluginsOff(home: string, keys: string[]): Planned {
  const abs = join(claudeRoot(home), "settings.json");
  const rel = relOf(home, abs)!;
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const after = disableInText(before, keys);
  const change: FileChange = {
    rel,
    kind: "plugin-off",
    diff: lineDiff(redactSecrets(before), redactSecrets(after)),
    note: `플러그인 ${keys.length}개를 꺼요. Claude Code 를 다시 시작하면 적용돼요`,
  };
  return {
    overlay: overlayFrom([[abs, after]]),
    changes: [change],
    writes: [{ abs, content: after }],
    moves: [],
    pluginKeys: [...keys],
    hashes: { [abs]: hashPath(abs) },
  };
}

// 고른 파일·폴더를 HOME/.claude-checkup/off/<.claude 기준 상대 경로> 로 옮긴다
export function planMoveOff(home: string, abs: string[]): Planned {
  const rels = new Set<string>();
  for (const a of abs) {
    const rel = relOf(home, a);
    if (rel === null) throw new Error("옮길 수 없는 곳이에요: " + redactSecrets(a));
    rels.add(rel);
  }
  // 고른 폴더 안의 항목은 폴더와 함께 옮겨지므로 따로 두지 않는다
  const all = [...rels].sort();
  const top = all.filter((k) => !all.some((o) => o !== k && k.toLowerCase().startsWith(o.toLowerCase() + "/")));
  const moves: Planned["moves"] = [];
  const changes: FileChange[] = [];
  const hashes: Record<string, string> = {};
  for (const rel of top) {
    const from = absOf(home, rel);
    moves.push({ from, to: join(offDir(home), ...rel.split("/")) });
    hashes[from] = hashPath(from);
    changes.push({ rel, kind: "moved", diff: [], note: "보관 폴더로 옮겨요. 되돌리면 제자리로 와요" });
  }
  return { overlay: overlayFrom(moves.map((m): [string, null] => [m.from, null])), changes, writes: [], moves, pluginKeys: [], hashes };
}
