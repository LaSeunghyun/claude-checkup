// 항목 사이 연결: 플러그인 구성, 메모리 링크, 본문 속 이름 언급.
import { basename, resolve } from "node:path";
import { exists } from "./fsutil";
import type { Entry, PluginEntry } from "./inventory";
import { memoryKey, memoryLinks, stripCode } from "./text";

function link(from: Entry, to: Entry) {
  if (from === to) return;
  if (!from.item.links.out.includes(to.item.id)) from.item.links.out.push(to.item.id);
  if (!to.item.links.in.includes(from.item.id)) to.item.links.in.push(from.item.id);
}

const TEXT_KINDS = new Set(["instruction", "memory-index", "memory", "skill", "command", "agent"]);
const TARGET_KINDS = new Set(["skill", "command", "agent"]);

const rank = (e: Entry): number => {
  const s = e.item.source.type;
  return (s === "user" ? 0 : s === "project" ? 1 : s === "plugin" ? (e.item.enabled ? 2 : 3) : 4) * 2 + (e.item.kind === "skill" ? 0 : 1);
};

export interface LinkResult {
  broken: Map<string, string[]>; // 항목 id -> 대상이 없는 링크
}

export function buildLinks(entries: Entry[], plugins: PluginEntry[]): LinkResult {
  const broken = new Map<string, string[]>();

  // 플러그인 <-> 구성
  const byPlugin = new Map<string, Entry>();
  for (const p of plugins) {
    const e = entries.find((x) => x.item === p.item);
    if (e) byPlugin.set(p.key, e);
  }
  for (const e of entries) {
    if (!e.pluginKey || e.item.kind === "plugin") continue;
    const p = byPlugin.get(e.pluginKey);
    if (p) link(p, e);
  }

  // 메모리 링크
  const memByPath = new Map<string, Entry>();
  const memByKey = new Map<string, Entry>(); // `${memDir}|${memoryKey}` -> 메모리 (파일 이름과 frontmatter name 둘 다)
  for (const e of entries) {
    if ((e.item.kind === "memory" || e.item.kind === "memory-index") && e.abs) {
      memByPath.set(resolve(e.abs).toLowerCase(), e);
      if (e.memDir) {
        const dir = resolve(e.memDir).toLowerCase();
        memByKey.set(`${dir}|${memoryKey(basename(e.abs))}`, e);
        const name = e.text?.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)/m)?.[1];
        if (name) memByKey.set(`${dir}|${memoryKey(name.trim())}`, e);
      }
    }
  }
  for (const e of entries) {
    if (!e.memDir || !e.text) continue;
    const { md, wiki } = memoryLinks(e.text);
    const dir = resolve(e.memDir).toLowerCase();
    for (const w of new Set(wiki)) {
      const target = memByKey.get(`${dir}|${memoryKey(w)}`);
      if (target) link(e, target);
    }
    // MEMORY.md 가 링크 없이 파일 이름만 적어 둔 경우도 목차에 있는 것으로 본다
    if (e.item.kind === "memory-index") {
      const plain = stripCode(e.text).toLowerCase();
      for (const x of entries) {
        if (x.item.kind !== "memory" || !x.abs || !x.memDir || resolve(x.memDir).toLowerCase() !== dir) continue;
        const stem = basename(x.abs).replace(/\.md$/i, "").toLowerCase();
        if (new RegExp(`(?<![\\w-])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(plain)) link(e, x);
      }
    }
    const bad: string[] = [];
    for (const t of new Set(md)) {
      const cands = t.toLowerCase().endsWith(".md") ? [t] : [t + ".md", t];
      let ok = false;
      let target: Entry | undefined;
      for (const c of cands) {
        const abs = resolve(e.memDir, c);
        if (exists(abs)) {
          ok = true;
          target = memByPath.get(abs.toLowerCase());
          break;
        }
      }
      if (!ok) bad.push(t);
      else if (target) link(e, target);
    }
    if (bad.length) broken.set(e.item.id, bad);
  }

  // 본문 속 이름 언급 (작업 설명서·명령·에이전트)
  const qualified = new Map<string, Entry>();
  const bare = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!TARGET_KINDS.has(e.item.kind)) continue;
    for (const n of e.inv) {
      if (n.includes(":")) qualified.set(n, e);
      else (bare.get(n) ?? bare.set(n, []).get(n)!).push(e);
    }
  }
  const pick = (n: string): Entry | undefined => bare.get(n)?.slice().sort((a, b) => rank(a) - rank(b))[0];
  const reSlash = /(?<![\w/.:~-])\/([a-z][\w-]{3,})(?![\w/-]|\.\w|:\w)/gi;
  const reTick = /`([a-z][\w-]{3,})`/gi;
  const reQual = /(?<![\w-])([a-z0-9][\w-]*:[a-z0-9][\w-]*)(?![\w-])/gi;
  for (const e of entries) {
    if (!e.text || !TEXT_KINDS.has(e.item.kind)) continue;
    const t = stripCodeKeepTicks(e.body ?? e.text);
    for (const m of t.matchAll(reQual)) {
      const x = qualified.get(m[1].toLowerCase());
      if (x) link(e, x);
    }
    for (const re of [reSlash, reTick]) {
      for (const m of t.matchAll(re)) {
        const x = pick(m[1].toLowerCase());
        if (x) link(e, x);
      }
    }
  }
  return { broken };
}

// 코드 블록은 지우되, 한 줄짜리 `이름` 표기는 남긴다
function stripCodeKeepTicks(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "");
}
