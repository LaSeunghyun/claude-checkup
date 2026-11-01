// 적용(백업 -> 반영)과 되돌리기. 해시로 "그사이 바뀌었는지"를 본다.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Overlay } from "../scan/fsutil";
import type { FileChange } from "../shared/types";
import { absOf, backupsDir, claudeRoot, offDir, relOf, tmpDir } from "./paths";

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
  status?: "applying" | "applied" | "failed";
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
    try {
      cpSync(from, to, { recursive: true });
    } catch (e) {
      rmSync(to, { recursive: true, force: true }); // 반쯤 복사된 것은 지운다. 원본은 그대로다
      throw e;
    }
    rmSync(from, { recursive: true, force: true });
  }
}

// 임시 파일은 HOME/.claude-checkup/tmp 에 만들고 대상 위로 옮긴다. 다른 볼륨이라 못 옮기면 바로 쓴다(백업은 이미 있다)
function writeAtomic(home: string, abs: string, content: string) {
  mkdirSync(dirname(abs), { recursive: true });
  mkdirSync(tmpDir(home), { recursive: true });
  const t = join(tmpDir(home), `w-${process.pid}-${Date.now()}`);
  writeFileSync(t, content);
  try {
    renameSync(t, abs);
  } catch (e: any) {
    rmSync(t, { force: true });
    if (e?.code !== "EXDEV") throw e;
    writeFileSync(abs, content);
  }
}

const LINK_MSG = "링크로 연결된 곳이라 고치지 않아요: ";
const under = (p: string, root: string) => {
  const n = process.platform === "win32" ? (x: string) => x.toLowerCase() : (x: string) => x;
  return n(p).startsWith(n(root) + sep);
};

// 대상이 링크이거나, 부모 폴더가 링크를 타고 .claude 밖이나 plugins 로 나가면 거부한다
function assertNotLinked(home: string, abs: string) {
  try {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(LINK_MSG + abs);
  } catch (e: any) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
  }
  let parent = dirname(resolve(abs));
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const root = realpathSync(claudeRoot(home));
  const real = realpathSync(parent);
  const ok = real === root || under(real, root);
  const plug = under(real, join(root, "plugins")) || real.toLowerCase() === join(root, "plugins").toLowerCase();
  if (!ok || plug) throw new Error(LINK_MSG + abs);
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
  for (const w of p.writes) assertNotLinked(home, w.abs);
  for (const mv of p.moves) assertNotLinked(home, mv.from);
  for (const [abs, h] of Object.entries(p.hashes)) if (hashPath(abs) !== h) throw new ChangedSinceError();
  for (const mv of p.moves) if (existsSync(mv.to)) throw new Error("보관 폴더에 같은 이름이 이미 있어요: " + mv.to);

  const id = newId(home);
  const dir = join(backupsDir(home), id);
  mkdirSync(dir, { recursive: true });
  const files: Manifest["files"] = [];
  const moves: Manifest["moves"] = p.moves.map((mv) => ({ fromRel: relOf(home, mv.from)!, toRel: mv.to.slice(offDir(home).length + 1).split("\\").join("/") }));
  const m: Manifest = { id, at: new Date().toISOString(), findingId, files, moves, pluginKeys: [...p.pluginKeys], status: "applying" };
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
      if (runClaude) code = await runClaude(["plugin", "disable", k]); // 예외는 적용 실패로 본다. 0 이 아닌 값만 설정 파일로 대신한다
      if (code === 0) {
        cliKeys.push(k);
        m.cliKeys = [...cliKeys];
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2)); // 죽어도 되돌릴 수 있게 바로 남긴다
      } else allByCli = false;
    }
    if (!allByCli) {
      for (const w of p.writes) {
        if (w.content === null) rmSync(w.abs, { force: true });
        else writeAtomic(home, w.abs, w.content);
      }
    }
    for (const mv of p.moves) {
      move(mv.from, mv.to);
    }
  } catch (e) {
    for (const k of m.cliKeys ?? []) {
      if (!runClaude) break;
      try {
        await runClaude(["plugin", "enable", k]);
      } catch {}
    }
    restore(home, m); // 반영 도중 실패하면 원래대로 돌리고 알린다
    m.status = "failed";
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
    throw e;
  }
  for (const f of files) f.appliedHash = hashOrNull(absOf(home, f.rel));
  m.status = "applied";
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
      const mf: Manifest = JSON.parse(readFileSync(join(backupsDir(home), n, "manifest.json"), "utf8"));
      if (mf.status !== "failed") out.push(mf);
    } catch {}
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function undo(home: string, id: string, runClaude?: Run): Promise<{ ok: boolean; message: string }> {
  if (!/^[\w-]+$/.test(id)) return { ok: false, message: "그 백업을 찾을 수 없어요" };
  const dir = join(backupsDir(home), id);
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, message: "그 백업을 찾을 수 없어요: " + id };
  }
  if (m.status === "failed") return { ok: false, message: "적용에 실패해서 이미 원래대로 돌려 놓았어요. 되돌릴 것이 없어요" };
  const interrupted = m.status === "applying"; // 적용 도중 멈춘 기록은 해시 없이 되돌린다
  try {
    for (const f of m.files) assertNotLinked(home, absOf(home, f.rel));
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
  const changed = interrupted ? [] : m.files.filter((f) => hashOrNull(absOf(home, f.rel)) !== f.appliedHash);
  if (changed.length) {
    return {
      ok: false,
      message: `적용한 뒤에 파일이 다시 바뀌어서 되돌리지 않았어요 (${changed.map((f) => f.rel).join(", ")}). 원본은 백업 폴더에 있어요: ${dir}`,
    };
  }
  for (const mv of m.moves) {
    const to = offAbs(home, mv.toRel);
    if (interrupted && (existsSync(to) ? false : true)) continue;
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

