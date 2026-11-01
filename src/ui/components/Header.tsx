import type { ReactNode } from "react";
import type { Theme } from "../hooks";
import { Search } from "./Search";

interface HeaderProps {
  /** 왼쪽: 제목이나 뒤로 가기 */
  left: ReactNode;
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
  onRescan?: () => void;
  /** 점검 결과가 있을 때만 이름 찾기를 보여 준다 */
  withSearch?: boolean;
}

export function Header({ left, theme, onToggleTheme, onSettings, onRescan, withSearch }: HeaderProps) {
  return (
    <header className="top">
      <div className="top-main">{left}</div>
      <div className="top-actions">
        {withSearch && <Search />}
        <div className="top-buttons">
          {onRescan && (
            <button className="btn btn-secondary btn-sm" type="button" onClick={onRescan}>
              다시 점검
            </button>
          )}
          <button className="btn btn-secondary btn-sm" type="button" onClick={onSettings}>
            설정
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onToggleTheme}>
            {theme === "dark" ? "밝게 보기" : "어둡게 보기"}
          </button>
        </div>
      </div>
    </header>
  );
}
