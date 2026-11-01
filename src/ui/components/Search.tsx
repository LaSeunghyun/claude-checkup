import { useId, useMemo, useState } from "react";
import type { Item } from "../../shared/types";
import { useUi } from "../context";
import { KIND_LABEL, itemSourceName } from "../format";
import { Search as SearchIcon } from "../icons";

const MAX_RESULTS = 8;

function score(item: Item, q: string): number {
  const n = item.name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if ((item.source.plugin ?? "").toLowerCase().includes(q)) return 3;
  return -1;
}

/** 이름으로 찾기. 결과를 고르면 항목 모달이 열린다 */
export function Search() {
  const { model, openItem } = useUi();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const uid = useId();
  const listId = `${uid}-list`;

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    return model.snap.items
      .map((item) => ({ item, s: score(item, query) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s || a.item.name.localeCompare(b.item.name));
  }, [model, query]);
  const shown = results.slice(0, MAX_RESULTS);

  const pick = (item: Item) => {
    setQ("");
    setOpen(false);
    openItem(item.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const it = shown[active];
      if (it) {
        e.preventDefault();
        pick(it.item);
      }
    } else if (e.key === "Escape" && (q || open)) {
      e.stopPropagation();
      setQ("");
      setOpen(false);
    }
  };

  const expanded = open && query.length > 0;

  return (
    <div className="search" role="search">
      <span className="search-icon" aria-hidden="true">
        <SearchIcon size={20} />
      </span>
      <input
        className="input"
        type="text"
        role="combobox"
        aria-label="이름으로 찾기"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && shown[active] ? `${uid}-opt-${active}` : undefined}
        placeholder="이름으로 찾기"
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <div className="search-pop" id={listId} role="listbox" aria-label="찾은 항목">
          {shown.length === 0 ? (
            <p className="search-empty" role="status">
              이름이 맞는 항목이 없어요
            </p>
          ) : (
            shown.map(({ item }, i) => (
              <div
                key={item.id}
                id={`${uid}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className="search-opt"
                // 입력창의 포커스를 유지해서, 모달을 닫으면 입력창으로 돌아오게 한다
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(item)}
              >
                <span className="search-opt-name">{item.name}</span>
                <span className="search-opt-meta">
                  {KIND_LABEL[item.kind]} · {itemSourceName(item)}
                </span>
              </div>
            ))
          )}
          {results.length > MAX_RESULTS && (
            <p className="search-more">{results.length - MAX_RESULTS}개가 더 있어요. 이름을 더 적어 보세요.</p>
          )}
        </div>
      )}
    </div>
  );
}
