// 가짜 claude. 진짜처럼 인자를 받고, 환경변수 CHECKUP_FAKE_PLAN 이 가리키는 JSON 대로 작업 폴더를 고친 뒤 json 을 출력한다.
// plan: { edits: [{ rel, content?, append?, delete? }], sleepMs?, argvLog?, exit?, isError?, usage?, cost? }
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("0.0.0-fake");
  process.exit(0);
}
const plan = JSON.parse(readFileSync(process.env.CHECKUP_FAKE_PLAN!, "utf8"));
if (plan.argvLog) writeFileSync(plan.argvLog, JSON.stringify({ argv, cwd: process.cwd() }));
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
console.log(
  JSON.stringify({
    type: "result",
    is_error: !!plan.isError,
    result: plan.isError ? "Not logged in" : "done",
    usage: plan.usage ?? { input_tokens: 120, output_tokens: 34 },
    total_cost_usd: plan.cost ?? 0.0123,
  }),
);
process.exit(plan.exit ?? 0);
