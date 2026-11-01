// 적용(백업 -> 반영)과 되돌리기. 해시로 "그사이 바뀌었는지"를 본다.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Overlay } from "../scan/fsutil";
import type { FileChange } from "../shared/types";
import { absOf, backupsDir, offDir, relOf } from "./paths";

export interface Planned {
  overlay: Overlay;
  changes: FileChange[];
  writes: { abs: string; content: string | null }[];
  moves: { from: string; to: string }[];
  pluginKeys: string[];
  hashes: Record<string, string>; // 미리 보기 시점 원본 해시 (키 = 절대경로)
}

export interface Manifest {
  id: string;
  at: string;
  findingId: string;
  files: { rel: string; existed: boolean; appliedHash: string | null }[];
  moves: { fromRel: string; toRel: string }[]; // toRel 은 HOME/.claude-checkup/off 기준
  pluginKeys: string[];
  cliKeys?: string[]; // claude plugin disable 로 끈 키
}

export class ChangedSinceError extends Error {
  constructor() {
    super("파일이 그사이 바뀌었어요, 미리 보기를 다시 만들어 주세요");
    this.name = "ChangedSinceError";
  }
}

type Run = (args: string[]) => Promise<number>;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// 파일은 내용 해시, 폴더는 안의 파일 이름과 내용 해시, 없으면 "missing"
export function hashPath(abs: string): string {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return "missing";
  }
  if (st.isFile()) return sha(readFileSync(abs));
  const h = createHash("sha256");
  const walk = (d: string, pre: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.isDirectory()) {
        h.update("d:" + pre + e.name + "\n");
        walk(join(d, e.name), pre + e.name + "/");
      } else h.update("f:" + pre + e.name + ":" + sha(readFileSync(join(d, e.name))) + "\n");
    }
  };
  walk(abs, "");
  return h.digest("hex");
}

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "") + "-" + String(d.getMilliseconds()).padStart(3, "0");

function newId(home: string): string {
  const base = stamp(new Date());
  let id = base;
  for (let i = 2; existsSync(join(backupsDir(home), id)); i++) id = base + "-" + i;
  return id;
}

function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function writeAtomic(abs: string, content: string) {
  mkdirSync(dirname(abs), { recursive: true });
  const t = abs + ".checkup-tmp";
  writeFileSync(t, content);
  renameSync(t, abs);
}

const backupFile = (home: string, id: string, rel: string) => join(backupsDir(home), id, "files", ...rel.split("/"));
const offAbs = (home: string, toRel: string) => join(offDir(home), ...toRel.split("/"));
const hashOrNull = (abs: string): string | null => {
  const h = hashPath(abs);
  return h === "missing" ? null : h;
};

export async function applyPlanned(home: string, p: Planned, findingId: string, runClaude?: Run): Promise<Manifest> {
  // 쓸 수 있는 곳인지, 미리 보기 뒤 바뀌지 않았는지 먼저 본다
  for (const w of p.writes) if (relOf(home, w.abs) === null) throw new Error("고칠 수 없는 곳이에요: " + w.abs);
  for (const mv of p.moves) if (relOf(home, mv.from) === null) throw new Error("옮길 수 없는 곳이에요: " + mv.from);
  for (const [abs, h] of Object.entries(p.hashes)) if (hashPath(abs) !== h) throw new ChangedSinceError();
  for (const mv of p.moves) if (existsSync(mv.to)) throw new Error("보관 폴더에 같은 이름이 이미 있어요: " + mv.to);

  const id = newId(home);
  const dir = join(backupsDir(home), id);
  mkdirSync(dir, { recursive: true });
  const files: Manifest["files"] = [];
  const m: Manifest = { id, at: new Date().toISOString(), findingId, files, moves: [], pluginKeys: [...p.pluginKeys] };
  for (const w of p.writes) {
    const rel = relOf(home, w.abs)!;
    const existed = existsSync(w.abs);
    if (existed) {
      mkdirSync(dirname(backupFile(home, id, rel)), { recursive: true });
      cpSync(w.abs, backupFile(home, id, rel));
    }
    files.push({ rel, existed, appliedHash: null });
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2)); // 반영 도중 멈춰도 백업은 남는다

  try {
    // 플러그인은 claude CLI 우선, 못 끈 것이 있으면 설정 파일 쓰기로 대신한다
    let allByCli = p.pluginKeys.length > 0;
    const cliKeys: string[] = [];
    for (const k of p.pluginKeys) {
      let code = 1;
      if (runClaude) {
        try {
          code = await runClaude(["plugin", "disable", k]);
        } catch {
          code = 1;
        }
      }
      if (code === 0) cliKeys.push(k);
      else allByCli = false;
    }
    if (cliKeys.length) m.cliKeys = cliKeys;
    if (!allByCli) {
      for (const w of p.writes) {
        if (w.content === null) rmSync(w.abs, { force: true });
        else writeAtomic(w.abs, w.content);
      }
    }
    for (const mv of p.moves) {
      move(mv.from, mv.to);
      m.moves.push({ fromRel: relOf(home, mv.from)!, toRel: mv.to.slice(offDir(home).length + 1).split("\\").join("/") });
    }
  } catch (e) {
    restore(home, m); // 반영 도중 실패하면 원래대로 돌리고 알린다
    throw e;
  }
  for (const f of files) f.appliedHash = hashOrNull(absOf(home, f.rel));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  return m;
}

// 백업과 보관 이동을 되돌린다 (검사 없이)
function restore(home: string, m: Manifest) {
  for (const mv of m.moves) {
    const from = absOf(home, mv.fromRel);
    const to = offAbs(home, mv.toRel);
    if (existsSync(to) && !existsSync(from)) move(to, from);
  }
  for (const f of m.files) {
    const abs = absOf(home, f.rel);
    if (f.existed) {
      mkdirSync(dirname(abs), { recursive: true });
      cpSync(backupFile(home, m.id, f.rel), abs);
    } else rmSync(abs, { force: true });
  }
}

export function listBackups(home: string): Manifest[] {
  let names: string[] = [];
  try {
    names = readdirSync(backupsDir(home));
  } catch {
    return [];
  }
  const out: Manifest[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(backupsDir(home), n, "manifest.json"), "utf8")));
    } catch {}
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function undo(home: string, id: string, runClaude?: Run): Promise<{ ok: boolean; message: string }> {
  if (!/^[\w.-]+$/.test(id)) return { ok: false, message: "그 백업을 찾을 수 없어요" };
  const dir = join(backupsDir(home), id);
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, message: "그 백업을 찾을 수 없어요: " + id };
  }
  const changed = m.files.filter((f) => hashOrNull(absOf(home, f.rel)) !== f.appliedHash);
  if (changed.length) {
    return {
      ok: false,
      message: `적용한 뒤에 파일이 다시 바뀌어서 되돌리지 않았어요 (${changed.map((f) => f.rel).join(", ")}). 원본은 백업 폴더에 있어요: ${dir}`,
    };
  }
  for (const mv of m.moves) {
    const to = offAbs(home, mv.toRel);
    if (existsSync(absOf(home, mv.fromRel))) return { ok: false, message: `제자리에 같은 이름이 이미 있어서 되돌리지 않았어요 (${mv.fromRel}). 보관한 파일은 ${to} 에 있어요` };
    if (!existsSync(to)) return { ok: false, message: `보관한 파일이 없어서 되돌릴 수 없어요 (${mv.toRel}). 보관 폴더: ${offDir(home)}` };
  }
  restore(home, m);
  for (const k of m.cliKeys ?? []) {
    if (!runClaude) continue;
    try {
      await runClaude(["plugin", "enable", k]);
    } catch {}
  }
  const note = m.cliKeys?.length && !runClaude ? " 플러그인은 claude plugin enable 로 다시 켜 주세요." : "";
  return { ok: true, message: "되돌렸어요. Claude Code 를 다시 시작하면 반영돼요." + note };
}
