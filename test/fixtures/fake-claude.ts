// 가짜 claude. 진짜처럼 인자를 받고, 환경변수 CHECKUP_FAKE_PLAN 이 가리키는 JSON 대로 작업 폴더를 고친 뒤 json 을 출력한다.
// plan: { edits: [{ rel, content?, append?, delete? }], sleepMs?, argvLog?, exit?, isError?, usage?, cost?,
//         grandchildPidFile?, configProjectDir?: string[] (CLAUDE_CONFIG_DIR/projects 아래에 만들 하위 경로, 마지막에 {file} 이 있으면 파일도) }
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("0.0.0-fake");
  process.exit(0);
}
const plan = JSON.parse(readFileSync(process.env.CHECKUP_FAKE_PLAN!, "utf8"));
if (plan.flood) process.stdout.write("x".repeat(plan.flood)); // 표준 입력을 읽기 전에 많이 쓰는 자식
const stdin = plan.ignoreStdin ? "" : await Bun.stdin.text();
if (plan.argvLog) writeFileSync(plan.argvLog, JSON.stringify({ argv, cwd: process.cwd(), stdin }));
if (plan.grandchildPidFile) {
  // 표준 출력을 붙든 손자 프로세스
  const gc = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{},60000)"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  writeFileSync(plan.grandchildPidFile, String(gc.pid));
}
if (plan.configProjectDir) {
  const root = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "C--enc-" + basename(process.cwd()));
  for (const sub of plan.configProjectDir) mkdirSync(join(root, sub), { recursive: true });
  if (plan.configProjectFile) writeFileSync(join(root, plan.configProjectFile), "x");
}
if (plan.sleepMs) await new Promise((r) => setTimeout(r, plan.sleepMs));
for (const e of plan.edits ?? []) {
  const abs = join(process.cwd(), e.rel);
  if (e.delete) rmSync(abs, { force: true });
  else {
    mkdirSync(dirname(abs), { recursive: true });
    if (e.append) appendFileSync(abs, e.content);
    else writeFileSync(abs, e.content);
  }
}
if (plan.touchOriginal) writeFileSync(plan.touchOriginal, "원본을 몰래 고침\n");
console.log(
  JSON.stringify({
    type: "result",
    is_error: !!plan.isError,
    result: plan.isError ? "Not logged in" : "done",
    usage: plan.usage ?? { input_tokens: 120, output_tokens: 34, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500 },
    total_cost_usd: plan.cost ?? 0.0123,
  }),
);
process.exit(plan.exit ?? 0);
