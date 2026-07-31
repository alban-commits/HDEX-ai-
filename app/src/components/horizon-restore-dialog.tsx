import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Download, X } from "lucide-react";
import {
  applyHorizonRestoreFacePreset,
  clearHorizonRestoreMask,
  createHorizonRestoreWorkspace,
  downloadHorizonRestorePng,
  downloadHorizonRestorePsd,
  drawHorizonRestorePreview,
  horizonRestoreCanvasPoint,
  paintHorizonRestoreMask,
  type HorizonRestoreBrushMode,
  type HorizonRestorePoint,
  type HorizonRestoreView,
  type HorizonRestoreWorkspace,
} from "@/lib/horizon-restore.browser";

type OriginalSource = {
  name: string;
  src: string;
};

export function HorizonRestoreDialog({
  generatedUrl,
  generatedName,
  defaultOriginal,
  onClose,
}: {
  generatedUrl: string;
  generatedName: string;
  defaultOriginal?: OriginalSource;
  onClose: () => void;
}) {
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const workspaceRef = useRef<HorizonRestoreWorkspace | null>(null);
  const ownedOriginalUrl = useRef<string | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<HorizonRestorePoint | undefined>(undefined);
  const [original, setOriginal] = useState<OriginalSource | undefined>(defaultOriginal);
  const [view, setView] = useState<HorizonRestoreView>("composite");
  const [brushMode, setBrushMode] = useState<HorizonRestoreBrushMode>("restore");
  const [brushSize, setBrushSize] = useState(64);
  const [busy, setBusy] = useState(Boolean(defaultOriginal));
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState(
    defaultOriginal ? "원본과 생성 결과를 불러오는 중입니다." : "복원할 1번 원본 모델 이미지를 선택해 주세요.",
  );

  const refresh = (nextView = view) => {
    const workspace = workspaceRef.current;
    const preview = previewRef.current;
    if (workspace && preview) drawHorizonRestorePreview(workspace, preview, nextView);
  };

  useEffect(() => {
    if (!original) return;
    let active = true;
    void createHorizonRestoreWorkspace(original.src, generatedUrl)
      .then((workspace) => {
        if (!active) return;
        workspaceRef.current = workspace;
        setReady(true);
        setMessage("얼굴·머리 기본 영역이 복원됐습니다. 브러시로 몸과 피부 영역을 추가해 주세요.");
        window.requestAnimationFrame(() => {
          const preview = previewRef.current;
          if (active && preview) drawHorizonRestorePreview(workspace, preview, "composite");
        });
      })
      .catch(() => {
        if (!active) return;
        setMessage("이미지를 불러오지 못했습니다. 원본을 다시 선택하거나 결과를 다시 불러와 주세요.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [generatedUrl, original]);

  useEffect(
    () => () => {
      if (ownedOriginalUrl.current) URL.revokeObjectURL(ownedOriginalUrl.current);
    },
    [],
  );

  const selectOriginal = (file?: File) => {
    if (!file) return;
    if (ownedOriginalUrl.current) URL.revokeObjectURL(ownedOriginalUrl.current);
    const src = URL.createObjectURL(file);
    ownedOriginalUrl.current = src;
    workspaceRef.current = null;
    setBusy(true);
    setReady(false);
    setMessage("원본과 생성 결과를 정렬하고 있습니다.");
    setOriginal({ name: file.name, src });
  };

  const setPreviewView = (next: HorizonRestoreView) => {
    setView(next);
    refresh(next);
  };

  const paint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const workspace = workspaceRef.current;
    const canvas = previewRef.current;
    if (!workspace || !canvas || view !== "composite") return;
    const bounds = canvas.getBoundingClientRect();
    const point = horizonRestoreCanvasPoint(
      event.clientX,
      event.clientY,
      bounds,
      workspace.width,
      workspace.height,
    );
    const radius = (brushSize / Math.max(1, bounds.width)) * workspace.width * 0.5;
    paintHorizonRestoreMask(workspace, point, radius, brushMode, lastPoint.current);
    lastPoint.current = point;
    refresh();
  };

  const beginPaint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || view !== "composite") return;
    drawing.current = true;
    lastPoint.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    paint(event);
  };

  const continuePaint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawing.current) paint(event);
  };

  const stopPaint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drawing.current = false;
    lastPoint.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const runExport = async (kind: "png" | "psd") => {
    const workspace = workspaceRef.current;
    if (!workspace || busy) return;
    setBusy(true);
    setMessage(kind === "psd" ? "레이어 PSD를 만들고 있습니다." : "복원 PNG를 만들고 있습니다.");
    try {
      if (kind === "psd") await downloadHorizonRestorePsd(workspace, generatedName);
      else await downloadHorizonRestorePng(workspace, generatedName);
      setMessage(kind === "psd" ? "수정 가능한 레이어 PSD를 저장했습니다." : "복원된 PNG를 저장했습니다.");
    } catch {
      setMessage("파일을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hz-restore-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) onClose();
    }}>
      <section className="hz-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="hz-restore-title">
        <header className="hz-restore-header">
          <div>
            <span>ORIGINAL RESTORE PSD</span>
            <h2 id="hz-restore-title">원본 얼굴·몸 복원</h2>
            <p>AI 의상 결과 위에 1번 원본의 얼굴·머리·노출 피부를 마스크로 복원합니다.</p>
          </div>
          <button type="button" aria-label="원본 복원 창 닫기" disabled={busy} onClick={onClose}><X /></button>
        </header>

        <div className="hz-restore-body">
          <div className="hz-restore-stage">
            {original ? (
              <canvas
                ref={previewRef}
                className={`hz-restore-canvas ${ready && view === "composite" ? "editable" : ""}`}
                onPointerDown={beginPaint}
                onPointerMove={continuePaint}
                onPointerUp={stopPaint}
                onPointerCancel={stopPaint}
              />
            ) : (
              <label className="hz-restore-empty">
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectOriginal(event.currentTarget.files?.[0])} />
                <b>1번 원본 모델 이미지 선택</b>
                <span>생성에 사용한 원본과 동일한 파일을 선택해 주세요.</span>
              </label>
            )}
            {busy && original ? <div className="hz-restore-loading">처리 중…</div> : null}
          </div>

          <aside className="hz-restore-controls">
            <div className="hz-restore-source">
              <span>원본 모델</span>
              <b>{original?.name ?? "선택되지 않음"}</b>
              <label>
                <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => selectOriginal(event.currentTarget.files?.[0])} />
                다른 원본 선택
              </label>
            </div>

            <fieldset disabled={!ready || busy}>
              <legend>비교 보기</legend>
              <div className="hz-restore-segmented">
                <button type="button" className={view === "composite" ? "active" : ""} onClick={() => setPreviewView("composite")}>복원 결과</button>
                <button type="button" className={view === "generated" ? "active" : ""} onClick={() => setPreviewView("generated")}>AI 결과</button>
                <button type="button" className={view === "original" ? "active" : ""} onClick={() => setPreviewView("original")}>원본</button>
              </div>
            </fieldset>

            <fieldset disabled={!ready || busy}>
              <legend>복원 마스크</legend>
              <div className="hz-restore-segmented">
                <button type="button" className={brushMode === "restore" ? "active" : ""} onClick={() => setBrushMode("restore")}>원본 복원</button>
                <button type="button" className={brushMode === "erase" ? "active" : ""} onClick={() => setBrushMode("erase")}>AI 결과 되살리기</button>
              </div>
              <label className="hz-restore-range">
                <span>브러시 크기 <b>{brushSize}px</b></span>
                <input type="range" min={16} max={180} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
              </label>
              <div className="hz-restore-preset-actions">
                <button type="button" onClick={() => {
                  const workspace = workspaceRef.current;
                  if (!workspace) return;
                  applyHorizonRestoreFacePreset(workspace);
                  setPreviewView("composite");
                }}>얼굴·머리 기본 복원</button>
                <button type="button" onClick={() => {
                  const workspace = workspaceRef.current;
                  if (!workspace) return;
                  clearHorizonRestoreMask(workspace);
                  setPreviewView("composite");
                }}>마스크 비우기</button>
              </div>
            </fieldset>

            <p className="hz-restore-message">{message}</p>
            <div className="hz-restore-downloads">
              <button type="button" disabled={!ready || busy} onClick={() => void runExport("png")}><Download /> 복원 PNG</button>
              <button type="button" className="primary" disabled={!ready || busy} onClick={() => void runExport("psd")}><Download /> 레이어 PSD</button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
