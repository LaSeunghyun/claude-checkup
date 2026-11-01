// 화면들이 같이 쓰는 값: 점검 모델, 항목 모달 열기, 화면 이동
import { createContext, useContext } from "react";
import type { Route } from "./hooks";
import type { Model } from "./model";

export interface Ui {
  model: Model;
  openItem: (id: string) => void;
  go: (r: Route, replace?: boolean) => void;
  openTools: () => void;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const v = useContext(UiContext);
  if (!v) throw new Error("UiContext 밖에서 쓸 수 없어요");
  return v;
}
