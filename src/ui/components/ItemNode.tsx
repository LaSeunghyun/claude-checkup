import type { Item } from "../../shared/types";
import { useUi } from "../context";
import { HOOK_EVENT, KIND_LABEL, a4, clip, num, seconds } from "../format";
import { usageOf, type Model } from "../model";
import type { Tone } from "../map";

export function nodeTag(item: Item): { text: string; tone: Tone } {
  if (!item.enabled) return { text: "꺼짐", tone: "idle" };
  const n = usageOf(item);
  switch (item.kind) {
    case "instruction":
    case "memory-index":
      return { text: a4(item.alwaysLoaded?.tokens ?? item.size.tokens), tone: "idle" };
    case "hook": {
      const h = item.hook;
      if (h && h.failures30 > 0) return { text: `실패 ${num(h.failures30)}번`, tone: "bad" };
      if (h && (h.avgMs >= 3000 || h.maxMs >= 10000)) return { text: "느려요", tone: "warn" };
      return n > 0 ? { text: `${num(n)}번 실행`, tone: "ok" } : { text: "한 달 0번", tone: "idle" };
    }
    case "memory":
      return n > 0 ? { text: `${num(n)}번 읽음`, tone: "ok" } : { text: "한 달 0번", tone: "idle" };
    default:
      return n > 0 ? { text: `${num(n)}번`, tone: "ok" } : { text: "한 달 0번", tone: "idle" };
  }
}

export function nodeMeta(item: Item, model: Model): string {
  if (!item.enabled) return "꺼져 있어서 목록에 안 들어가요";
  // 플러그인 항목은 안에 든 것을 전부 가리켜서 "부르는 곳"에서 뺀다
  const callers = item.links.in
    .map((id) => model.byId.get(id))
    .filter((c) => !!c && c.kind !== "plugin")
    .map((c) => c!.name);
  const n = usageOf(item);
  switch (item.kind) {
    case "instruction":
      return clip(item.summary, 40) || "AI에게 늘 지키라고 적어 둔 규칙";
    case "memory-index":
      return `${num(item.size.lines)}줄 중 앞 200줄까지 읽혀요`;
    case "hook":
      return item.hook ? `${HOOK_EVENT[item.hook.event] ?? item.hook.event}, 평균 ${seconds(item.hook.avgMs)}` : "실행 기록이 없어요";
    case "mcp":
      return n > 0 ? "AI가 필요할 때 불러요" : "연결만 되어 있어요";
    case "memory":
      return callers.length ? `연결: ${callers[0]}` : n > 0 ? "AI가 필요할 때 읽어요" : "한 달 동안 안 읽었어요";
    default: {
      if (callers.length) return `부르는 곳: ${callers[0]}${callers.length > 1 ? ` 외 ${callers.length - 1}` : ""}`;
      const v = item.usage.via;
      if (n > 0 && v) return `직접 ${num(v.user ?? 0)}번, AI가 ${num(v.model ?? 0)}번`;
      return n > 0 ? "한 달 안에 썼어요" : "목록에만 있어요";
    }
  }
}

/** 묶음 카드 안의 항목 상자. 안 쓴 것은 점선 */
export function ItemNode({ item }: { item: Item }) {
  const { model, openItem } = useUi();
  const tag = nodeTag(item);
  const ghost = item.enabled && usageOf(item) === 0 && item.kind !== "instruction" && item.kind !== "memory-index";
  return (
    <button className={`node${ghost ? " ghost" : ""}`} type="button" onClick={() => openItem(item.id)}>
      <span className="node-kind">
        {KIND_LABEL[item.kind]}
        <span className={`tag ${tag.tone}`}>{tag.text}</span>
      </span>
      <span className="node-title">{item.name}</span>
      <span className="node-meta">{nodeMeta(item, model)}</span>
    </button>
  );
}
