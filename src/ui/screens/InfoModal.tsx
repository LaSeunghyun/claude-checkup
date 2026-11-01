import { useId } from "react";
import { CloseButton, Modal } from "../components/Modal";
import { useUi } from "../context";
import { num } from "../format";

/** 지도의 "도구" 상자: 항목 목록이 없어서 숫자만 풀어서 보여 준다 */
export function ToolsModal({ onClose }: { onClose: () => void }) {
  const { model } = useUi();
  const tc = model.snap.stats.toolCalls30;
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <div className="dlg-head">
        <div className="dlg-head-text">
          <span className="badge badge-brand">도구</span>
          <h2 id={titleId}>파일 읽기·명령 실행</h2>
          <div className="term">원래 이름: 도구(Tool)</div>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <p className="dlg-sum">AI가 대화 중에 파일을 읽거나, 명령을 실행하거나, 연결된 서비스를 부른 횟수예요. 최근 30일 기준이에요.</p>
      <div className="stats">
        <div className="stat">
          <b>{num(tc.read)}번</b>
          <span>파일 읽기</span>
        </div>
        <div className="stat">
          <b>{num(tc.bash)}번</b>
          <span>명령 실행</span>
        </div>
        <div className="stat">
          <b>{num(tc.mcp)}번</b>
          <span>연결된 서비스 호출</span>
        </div>
        <div className="stat">
          <b>{num(tc.other)}번</b>
          <span>그 밖의 도구</span>
        </div>
      </div>
      <p className="help">이 숫자는 이 PC에 있는 대화 기록에서 센 값이에요.</p>
    </Modal>
  );
}
