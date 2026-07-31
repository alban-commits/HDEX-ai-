import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitInputFor } from "@higgsfield/fnf/client";
import { flattenFeedPages, jobsFeedQueryOptions, removeGenerationQueries, useFnfJobClient, useFnfScopeKey, useGenerationRun, useLiveFeedGenerations } from "@higgsfield/fnf-react";
import { Download as IconDownload } from "lucide-react";
import { SignInModal } from "@/components/sign-in-modal";
import type { AssetSelection } from "@/components/asset-library";
import { GenerationTile } from "@/components/generation-card";
import { HorizonRestoreDialog } from "@/components/horizon-restore-dialog";
import { generationToGalleryItem } from "@/lib/higgsfield-generation-results";
import { getNextCursor } from "@/lib/cursor-pages";
import { downloadMedia } from "@/lib/download-media";
import { HorizonDirectoryScanError, pickHorizonBatchDirectory, requestHorizonBatchDirectoryPermission, restoreHorizonBatchDirectory, saveHorizonBatchResults, scanHorizonDirectory, supportsHorizonDirectoryPicker, type HorizonDirectoryHandle, type HorizonDirectoryPermission } from "@/lib/horizon-filesystem.browser";
import { HORIZON_HISTORY_QUERY as HISTORY_QUERY, syncHorizonHistory } from "@/lib/horizon-history";
import { composeHorizonPrompt, runHorizonGenerationFlow, uploadHorizonAssets, withHorizonUploadedAssets } from "@/lib/horizon.browser";
import { HORIZON_MAX_FOLDER_FILES, HORIZON_MAX_IMAGES, HORIZON_RATIOS, HORIZON_SLOTS, HORIZON_VIEWS, HorizonBatchStepError, boundedHorizonFolderFiles, claimHorizonImageReservation, horizonBatchFailureMessage, horizonBatchProgress, horizonBatchStageFailureMessage, horizonConnectionState, horizonGenerationMatchesEngine, renumberHorizonImages, resolveHorizonBatchOutcome, runHorizonBatchSequence, scanHorizonFolder, selectHorizonImages, settleHorizonBatchStatus, type HorizonBatchDownload, type HorizonBatchFailureStage, type HorizonBatchJob, type HorizonBatchStatus, type HorizonEngine, type HorizonImage, type HorizonView } from "@/lib/horizon";
import { disconnectHiggsfieldOAuth, GUEST_SCOPE_KEY, getReconnectSignInUrl, getSignInUrl, PRESET_JOBS, releaseLocalUpload, subscribeHiggsfieldReconnect } from "@/lib/fnf.browser";
import "./horizon-workspace.css";

type GenerationInput = SubmitInputFor<typeof PRESET_JOBS>;
type StoredImage = HorizonImage & { asset: AssetSelection };
type BatchState = HorizonBatchJob & { status: HorizonBatchStatus; message?: string; results?: HorizonBatchDownload[]; savedFiles?: string[]; saveFailureCount?: number; successCount?: number; failureCount?: number };
type HorizonGalleryItem = NonNullable<ReturnType<typeof generationToGalleryItem>>;
type AccountMutation = "reconnect" | "disconnect";
type RestoreTarget = {
  id: string;
  name: string;
};
const LazyUserGenerations = lazy(async () => ({ default: (await import("@/components/user-generations")).UserGenerations }));

function slotCategory(slotId: string, code: string): string {
  const slot = HORIZON_SLOTS.find((item) => item.id === slotId);
  return `${code} · ${slot?.label ?? "참조"}`;
}

function batchErrorLabel(error: HorizonBatchJob["error"]): string {
  if (error === "too_many_images") return "이미지 14장 초과";
  if (error === "no_recognized_images") return "인식 가능한 번호 이미지 없음";
  if (error === "unsupported_format") return "지원하지 않는 형식";
  return "1번 기준 모델 없음";
}

function buildGenerationInput(engine: HorizonEngine, prompt: string, ratio: string, quantity: number, assets: StoredImage[]): GenerationInput {
  const refs = assets.flatMap((image) => image.asset.ref ? [image.asset.ref] : []);
  if (engine === "gpt-2k") return { model: "gpt_image_2", prompt: { instruction: prompt }, media: { image: refs }, settings: { aspectRatio: ratio, quality: "high", resolution: "2k", batchSize: quantity } } as GenerationInput;
  return { model: "nano_banana_2", prompt: { instruction: prompt }, media: { image: refs }, settings: { aspectRatio: ratio, resolution: engine === "nano-4k" ? "4k" : "2k", batchSize: quantity } } as GenerationInput;
}

function HorizonRecentGeneration({ item, onRestore }: { item: HorizonGalleryItem; onRestore: (item: HorizonGalleryItem) => void }) {
  if (item.status !== "ready") {
    return <GenerationTile state={item.status} ratio="square" generatingLabel="생성 중" failureLabel={item.failureLabel} className="hz-recent-tile" />;
  }
  const source = item.kind === "video" ? (item.videoSrc ?? item.src) : item.src;
  const downloadAction = { id: "download", label: "다운로드", icon: IconDownload };
  return <div className="hz-recent-result"><GenerationTile ratio="square" src={item.src} alt={item.alt} className="hz-recent-tile" generation={{ src: source, ...(item.kind === "video" ? { mediaType: "video" as const, poster: item.src } : { mediaType: "image" as const }), aspectRatio: item.width / item.height, prompt: item.prompt }} actions={[downloadAction]} detail={{ actions: [downloadAction] }} openLabel={`원본 결과 보기: ${item.prompt}`} />{item.kind === "image" ? <button type="button" className="hz-restore-open" onClick={() => onRestore(item)}>원본 복원 · PSD</button> : null}</div>;
}

export function HorizonWorkspace({ onBack, onParentWorkspaceReset, parentBusy = false }: { onBack: () => void; onParentWorkspaceReset: () => void; parentBusy?: boolean }) {
  const jobClient = useFnfJobClient<typeof PRESET_JOBS>();
  const resolvedScopeKey = useFnfScopeKey();
  const scopeKey = resolvedScopeKey ?? GUEST_SCOPE_KEY;
  const queryClient = useQueryClient();
  const run = useGenerationRun(jobClient, { scopeKey });
  const [images, setImages] = useState<StoredImage[]>([]);
  const [brief, setBrief] = useState(""); const [command, setCommand] = useState("");
  const [view, setView] = useState<HorizonView>("auto"); const [engine, setEngine] = useState<HorizonEngine>("gpt-2k");
  const [ratio, setRatio] = useState("2:3"); const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState(""); const [promptBusy, setPromptBusy] = useState(false);
  const [pendingSignInUrl, setPendingSignInUrl] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [batch, setBatch] = useState<BatchState[]>([]); const batchActive = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchDirectory, setBatchDirectory] = useState<HorizonDirectoryHandle | null>(null);
  const [batchDirectoryPermission, setBatchDirectoryPermission] = useState<HorizonDirectoryPermission | "loading" | "none" | "unsupported">("loading");
  const [batchRootName, setBatchRootName] = useState("");
  const [batchScanning, setBatchScanning] = useState(false);
  const [batchScanned, setBatchScanned] = useState(false);
  const [batchScanError, setBatchScanError] = useState("");
  const [batchFallbackRequired, setBatchFallbackRequired] = useState(false);
  const fallbackFolderInput = useRef<HTMLInputElement | null>(null);
  const imagesRef = useRef<StoredImage[]>([]);
  const uploadReservations = useRef(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const slotUploadLocks = useRef(new Set<string>());
  const [uploadingSlots, setUploadingSlots] = useState<Set<string>>(() => new Set());
  const dragDepths = useRef(new Map<string, number>());
  const [draggingSlots, setDraggingSlots] = useState<Set<string>>(() => new Set());
  const accountActionFlight = useRef(false);
  const [accountAction, setAccountAction] = useState<AccountMutation | null>(null);
  const generationActive = useRef(false);
  const promptFlight = useRef<Promise<string | null> | null>(null);

  useEffect(() => subscribeHiggsfieldReconnect(() => setPendingSignInUrl(getReconnectSignInUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`))), []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!supportsHorizonDirectoryPicker()) { if (active) setBatchDirectoryPermission("unsupported"); return; }
      try {
        const restored = await restoreHorizonBatchDirectory();
        if (!active) return;
        if (!restored) { setBatchDirectoryPermission("none"); return; }
        setBatchDirectory(restored.handle);
        setBatchRootName(restored.handle.name);
        setBatchDirectoryPermission(restored.permission);
      } catch {
        if (active) setBatchDirectoryPermission("none");
      }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => { for (const image of imagesRef.current) if (image.asset.ref?.id) releaseLocalUpload(image.asset.ref.id); }, []);
  const history = useInfiniteQuery({ ...jobsFeedQueryOptions(jobClient, HISTORY_QUERY, { scopeKey }), getNextPageParam: getNextCursor, select: flattenFeedPages });
  const generations = useMemo(() => history.data ?? [], [history.data]);
  useLiveFeedGenerations(jobClient, generations, { scopeKey });
  const historyItems = useMemo(() => generations.map(generationToGalleryItem).filter((item): item is HorizonGalleryItem => item != null), [generations]);
  const filteredRecentItems = useMemo(
    () => generations
      .filter((generation) => horizonGenerationMatchesEngine(generation, engine))
      .map(generationToGalleryItem)
      .filter((item): item is HorizonGalleryItem => item != null),
    [engine, generations],
  );
  const recentItems = filteredRecentItems.slice(0, 4);
  useEffect(() => { void syncHorizonHistory(queryClient, run.generations, scopeKey); }, [queryClient, run.generations, scopeKey]);

  const selected = useMemo(() => selectHorizonImages(images, brief, view) as StoredImage[], [brief, images, view]);
  const restoreOriginal = useMemo(() => {
    const candidates = [...selected, ...images];
    const model = candidates.find((image, index) => {
      if (candidates.findIndex((candidate) => candidate.id === image.id) !== index) return false;
      return HORIZON_SLOTS.find((slot) => slot.id === image.slotId)?.group === "model";
    });
    return model ? { name: model.name, src: model.asset.src } : undefined;
  }, [images, selected]);
  const invalidate = () => { setCommand(""); setMessage(""); };
  const requireSignIn = () => { const url = getSignInUrl(scopeKey, `${window.location.pathname}${window.location.search}${window.location.hash}`); if (!url) return true; setPendingSignInUrl(url); return false; };

  const addFiles = async (slotId: string, files: File[]) => {
    if (batchRunning || batchActive.current) { setMessage("일괄 작업 중에는 참조 이미지를 변경할 수 없습니다."); return; }
    if (!files.length || slotUploadLocks.current.has(slotId)) return;
    const reservation = claimHorizonImageReservation(imagesRef.current.length, uploadReservations.current, files.length);
    if (reservation === null) { setMessage(`참조 이미지는 최대 ${HORIZON_MAX_IMAGES}장까지 선택할 수 있습니다.`); return; }
    uploadReservations.current = reservation;
    slotUploadLocks.current.add(slotId);
    setUploadingSlots((current) => new Set(current).add(slotId));
    setUploadBusy(true);
    try {
      const assets = await uploadHorizonAssets(files);
      const added: Array<Omit<StoredImage, "code">> = assets.map((asset, index) => ({ id: asset.ref?.id ?? crypto.randomUUID(), slotId, category: "", selected: true, name: files[index]?.name ?? asset.name, asset }));
      const next = renumberHorizonImages([...imagesRef.current, ...added]).map((item) => ({ ...item, category: slotCategory(item.slotId, item.code) })) as StoredImage[];
      imagesRef.current = next;
      setImages(next);
      invalidate();
    } catch {
      setMessage("이미지 업로드를 완료하지 못해 이번 선택을 취소했습니다.");
    } finally {
      slotUploadLocks.current.delete(slotId);
      setUploadingSlots((current) => { const next = new Set(current); next.delete(slotId); return next; });
      uploadReservations.current = Math.max(0, uploadReservations.current - files.length);
      if (uploadReservations.current === 0) setUploadBusy(false);
    }
  };
  const beginSlotDrag = (slotId: string) => {
    if (batchRunning || batchActive.current || slotUploadLocks.current.has(slotId)) return;
    dragDepths.current.set(slotId, (dragDepths.current.get(slotId) ?? 0) + 1);
    setDraggingSlots((current) => new Set(current).add(slotId));
  };
  const endSlotDrag = (slotId: string) => {
    const depth = Math.max(0, (dragDepths.current.get(slotId) ?? 0) - 1);
    if (depth > 0) { dragDepths.current.set(slotId, depth); return; }
    dragDepths.current.delete(slotId);
    setDraggingSlots((current) => { const next = new Set(current); next.delete(slotId); return next; });
  };
  const clearSlotDrag = (slotId: string) => {
    dragDepths.current.delete(slotId);
    setDraggingSlots((current) => { const next = new Set(current); next.delete(slotId); return next; });
  };
  const removeImage = (id: string) => { if (batchRunning || batchActive.current) { setMessage("일괄 작업 중에는 참조 이미지를 변경할 수 없습니다."); return; } setImages((current) => { const target = current.find((item) => item.id === id); if (target?.asset.ref?.id) releaseLocalUpload(target.asset.ref.id); return renumberHorizonImages(current.filter((item) => item.id !== id)).map((item) => ({ ...item, category: slotCategory(item.slotId,item.code) })) as StoredImage[]; }); invalidate(); };
  const toggleImage = (id: string) => { if (batchRunning || batchActive.current) { setMessage("일괄 작업 중에는 참조 이미지 선택을 바꿀 수 없습니다."); return; } setImages((current) => current.map((item) => item.id === id ? { ...item, selected: !item.selected } : item)); invalidate(); };

  const writePrompt = async (): Promise<string | null> => {
    if (promptFlight.current) return promptFlight.current;
    if (!requireSignIn()) return null;
    if (!selected.length || !selected.some((image) => HORIZON_SLOTS.find((slot) => slot.id === image.slotId)?.group === "model")) { setMessage("선택한 촬영 방향에 맞는 모델 기준 이미지를 추가해 주세요."); return null; }
    const flight = (async () => {
      setPromptBusy(true); setMessage("이미지 번호와 역할을 분석하고 있습니다.");
      try {
        const result = await composeHorizonPrompt({ brief, ratio, targetView: view, images: selected.map((image) => ({ mediaId: image.asset.ref?.id ?? "", category: image.category })) });
        if (result.ok) { setCommand(result.prompt); setMessage("선택한 이미지 역할만 적용하는 명령어가 준비되었습니다."); return result.prompt; }
        setMessage(result.message); return null;
      } catch {
        setMessage("자동 JSON 명령어를 작성하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요."); return null;
      } finally {
        setPromptBusy(false);
      }
    })();
    promptFlight.current = flight;
    try { return await flight; } finally { if (promptFlight.current === flight) promptFlight.current = null; }
  };
  const generate = async () => {
    if (generationActive.current || batchActive.current || batchRunning || run.isRunning) return;
    if (!requireSignIn()) return;
    generationActive.current = true;
    try {
      const done = await runHorizonGenerationFlow({
        command,
        writePrompt,
        generate: async (resolvedCommand) => {
          setMessage(`${engine === "gpt-2k" ? "GPT Image 2.0" : "Nano Banana Pro"} 생성 요청을 전송하고 있습니다.`);
          const done = await run.start(buildGenerationInput(engine, resolvedCommand, ratio, quantity, selected));
          await syncHorizonHistory(queryClient, done, scopeKey);
          return done;
        },
      });
      if (!done) return;
      setMessage(done.length ? "생성 작업 상태를 결과 영역에서 확인하세요." : run.error?.message ?? "생성 요청을 완료하지 못했습니다.");
    } catch {
      setMessage(run.error?.message ?? "생성 요청을 완료하지 못했습니다.");
    } finally {
      generationActive.current = false;
    }
  };
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setMessage("명령어를 클립보드에 복사했습니다.");
    } catch {
      setMessage("명령어를 복사하지 못했습니다. 직접 선택해 복사해 주세요.");
    }
  };
  const refreshResults = async () => {
    try {
      const result = await history.refetch();
      if (result.isError) throw result.error;
      setMessage("현재 계정의 최근 생성 결과를 불러왔습니다.");
    } catch {
      setMessage("최근 생성 결과를 불러오지 못했습니다.");
    }
  };
  const downloadAllResults = async () => {
    const downloadable = filteredRecentItems.filter((item) => item.status === "ready" && (item.src || item.videoSrc));
    if (!downloadable.length) { setMessage("저장할 완료 이미지가 없습니다."); return; }
    try {
      for (const item of downloadable) await downloadMedia(item.kind === "video" ? (item.videoSrc ?? item.src) : item.src);
      setMessage("완료된 결과의 저장 요청을 전송했습니다.");
    } catch {
      setMessage("일부 결과를 저장하지 못했습니다. 각 결과에서 다시 시도해 주세요.");
    }
  };
  const accountMutationBlocked = parentBusy || run.isRunning || batchRunning || batchScanning || promptBusy || uploadBusy || accountAction !== null;
  const clearCurrentBrowserWorkspace = () => {
    for (const image of imagesRef.current) if (image.asset.ref?.id) releaseLocalUpload(image.asset.ref.id);
    imagesRef.current = [];
    setImages([]); setBrief(""); setCommand(""); setBatch([]);
    setBatchScanned(false); setBatchScanError(""); run.reset();
    removeGenerationQueries(queryClient, { scopeKey });
  };
  const reset = () => {
    if (parentBusy || run.isRunning || batchRunning || batchScanning || batchActive.current || generationActive.current || promptBusy || promptFlight.current || uploadReservations.current > 0) { setMessage("처리 중에는 전체 초기화를 할 수 없습니다."); return; }
    clearCurrentBrowserWorkspace(); setMessage("작업 내용을 초기화했습니다.");
  };
  const leaveHorizon = () => {
    if (parentBusy || run.isRunning || batchRunning || batchScanning || batchActive.current || generationActive.current || promptBusy || promptFlight.current || uploadReservations.current > 0) { setMessage("처리 중에는 화면을 이동할 수 없습니다."); return; }
    onBack();
  };
  const disconnect = async (reconnect: boolean) => {
    if (accountActionFlight.current) return;
    if (parentBusy || run.isRunning || batchRunning || batchScanning || batchActive.current || generationActive.current || promptBusy || promptFlight.current || uploadReservations.current > 0) { setMessage("처리 중에는 계정을 변경하거나 연결 해제할 수 없습니다."); return; }
    const hasCurrentWorkspaceState = imagesRef.current.length > 0 || brief.trim().length > 0 || command.trim().length > 0 || batch.length > 0 || run.generations.length > 0;
    if (hasCurrentWorkspaceState && !window.confirm("현재 브라우저의 선택 이미지와 작업 상태가 초기화됩니다. 계속할까요?")) return;
    const action: AccountMutation = reconnect ? "reconnect" : "disconnect";
    accountActionFlight.current = true;
    setAccountAction(action);
    try {
      await disconnectHiggsfieldOAuth();
      clearCurrentBrowserWorkspace();
      onParentWorkspaceReset();
      if (reconnect) {
        setMessage("현재 브라우저 작업을 정리했습니다. OAuth에서 사용할 회사 계정으로 로그인해 주세요.");
        setPendingSignInUrl(getReconnectSignInUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`));
      } else window.location.reload();
    } catch {
      setMessage("현재 브라우저의 Higgsfield 연결을 해제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      accountActionFlight.current = false;
      setAccountAction(null);
    }
  };

  const applyBatchScan = (jobs: HorizonBatchJob[]) => {
    setBatch(jobs.map((job) => ({ ...job, status: "queued" })));
    setBatchScanError("");
    setBatchScanned(true);
  };
  const chooseFallbackFolder = (files: ArrayLike<File>) => {
    if (files.length > HORIZON_MAX_FOLDER_FILES) {
      setBatch([]); setBatchScanned(true);
      setBatchScanError(`파일이 ${HORIZON_MAX_FOLDER_FILES.toLocaleString()}개를 초과했습니다. 작업 루트 범위를 더 작게 선택해 주세요.`);
      return;
    }
    const bounded = boundedHorizonFolderFiles(files);
    const firstPath = (bounded[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
    setBatchRootName(firstPath?.split("/").filter(Boolean)[0] ?? "선택한 폴더");
    setBatchDirectory(null);
    setBatchDirectoryPermission("unsupported"); setBatchFallbackRequired(false);
    applyBatchScan(scanHorizonFolder(bounded));
  };
  const scanSelectedDirectory = async (handle: HorizonDirectoryHandle) => {
    setBatchScanning(true);
    try {
      applyBatchScan(await scanHorizonDirectory(handle));
      setMessage("선택한 폴더의 상품 이미지를 다시 확인했습니다.");
    } catch (error) {
      setBatch([]); setBatchScanned(true);
      const safeMessage = error instanceof HorizonDirectoryScanError
        ? `파일이 ${HORIZON_MAX_FOLDER_FILES.toLocaleString()}개를 초과했습니다. 작업 루트 범위를 더 작게 선택해 주세요.`
        : "선택한 폴더를 읽지 못했습니다. 폴더 권한을 확인해 주세요.";
      setBatchScanError(safeMessage); setMessage(safeMessage);
    } finally {
      setBatchScanning(false);
    }
  };
  const chooseBatchDirectory = async () => {
    if (!supportsHorizonDirectoryPicker()) { fallbackFolderInput.current?.click(); return; }
    try {
      const picked = await pickHorizonBatchDirectory();
      const handle = picked.handle;
      const permission = await handle.queryPermission({ mode: "readwrite" });
      setBatchDirectory(handle); setBatchRootName(handle.name); setBatchDirectoryPermission(permission);
      setBatchFallbackRequired(false);
      if (permission === "granted") await scanSelectedDirectory(handle);
      else setMessage("폴더를 다시 사용하려면 읽기·쓰기 권한을 승인해 주세요.");
      if (!picked.remembered) setMessage("폴더를 선택했지만 다음 접속을 위한 저장에는 실패했습니다. 현재 작업에서는 계속 사용할 수 있습니다.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setBatchFallbackRequired(true);
      setMessage("폴더 직접 저장을 사용할 수 없습니다. ‘브라우저 방식으로 폴더 선택’을 눌러 계속해 주세요.");
    }
  };
  const rescanBatchDirectory = async () => {
    if (!batchDirectory) { fallbackFolderInput.current?.click(); return; }
    try {
      const permission = await batchDirectory.queryPermission({ mode: "readwrite" });
      setBatchDirectoryPermission(permission);
      if (permission === "granted") await scanSelectedDirectory(batchDirectory);
      else setMessage("‘폴더 권한 다시 승인’을 눌러 현재 폴더 사용을 허용해 주세요.");
    } catch {
      setMessage("저장된 폴더 권한을 확인하지 못했습니다. 다른 폴더를 선택해 주세요.");
    }
  };
  const approveBatchDirectory = async () => {
    if (!batchDirectory) return;
    try {
      const permission = await requestHorizonBatchDirectoryPermission(batchDirectory);
      setBatchDirectoryPermission(permission);
      if (permission === "granted") await scanSelectedDirectory(batchDirectory);
      else {
        setMessage("폴더 권한이 없어 브라우저 다운로드 방식으로 계속할 수 있습니다.");
        setBatchFallbackRequired(true);
      }
    } catch {
      setMessage("폴더 권한을 승인하지 못했습니다. 브라우저 다운로드 방식으로 계속할 수 있습니다.");
      setBatchFallbackRequired(true);
    }
  };
  const startBatch = async () => {
    if (parentBusy || batchActive.current || batchScanning || batchScanError || generationActive.current || run.isRunning || !requireSignIn()) return;
    const readyCount = batch.filter((job) => job.ready).length;
    const expectedCount = readyCount * quantity;
    if (!readyCount) { setMessage("생성 가능한 상품 폴더가 없습니다."); return; }
    if (!window.confirm(`생성 가능 상품 폴더 ${readyCount}개 · 폴더별 ${quantity}장 · 총 예상 ${expectedCount}장 · Higgsfield 크레딧이 최대 ${expectedCount}회 사용될 수 있습니다. 일괄 생성을 시작할까요?`)) return;
    batchActive.current = true; setBatchRunning(true);
    const batchSettings = { engine, ratio, quantity };
    try {
      await runHorizonBatchSequence(batch, async (current) => {
        setBatch((items) => items.map((item) => item.key === current.key ? { ...item, status: "prompting" } : item));
        let stage: HorizonBatchFailureStage = "uploading";
        try {
          await withHorizonUploadedAssets(current.files.map((entry) => entry.file), async (assets) => {
            const uploaded: StoredImage[] = current.files.map((entry, index) => { const asset = assets[index]!; return { id: asset.ref?.id ?? crypto.randomUUID(), slotId: entry.slotId, code: entry.category.split(" · ")[0]!, category: entry.category, selected: true, name: entry.file.name, asset }; });
            stage = "prompting";
            const promptResult = await composeHorizonPrompt({ brief: "", ratio: batchSettings.ratio, targetView: "auto", images: uploaded.map((image) => ({ mediaId: image.asset.ref?.id ?? "", category: image.category })) });
            if (!promptResult.ok) throw new HorizonBatchStepError("prompting", promptResult.message);
            stage = "generating";
            setBatch((items) => items.map((item) => item.key === current.key ? { ...item, status: "generating" } : item));
            const submitted = await jobClient.submit(buildGenerationInput(batchSettings.engine, promptResult.prompt, batchSettings.ratio, batchSettings.quantity, uploaded));
            const done = await jobClient.wait(submitted.generations);
            await syncHorizonHistory(queryClient, done, scopeKey);
            stage = "saving";
            setBatch((items) => items.map((item) => item.key === current.key ? { ...item, status: "saving" } : item));
            const outcome = resolveHorizonBatchOutcome(done, batchSettings.engine, current.name, batchSettings.quantity);
            let saved = { savedFiles: [] as string[], failureCount: 0 };
            if (batchDirectory && batchDirectoryPermission === "granted" && outcome.results.length) {
              try {
                saved = await saveHorizonBatchResults({ root: batchDirectory, results: outcome.results });
              } catch {
                saved = { savedFiles: [], failureCount: outcome.results.length };
              }
            }
            setBatch((items) => items.map((item) => item.key === current.key ? {
              ...item,
              status: outcome.successCount > 0 ? "completed" : "failed",
              ...outcome,
              savedFiles: saved.savedFiles,
              saveFailureCount: saved.failureCount,
              message: outcome.successCount > 0
                ? `${outcome.successCount}장 성공${outcome.failureCount ? ` · ${outcome.failureCount}장 생성 실패` : ""}${saved.savedFiles.length ? ` · 완성본 ${saved.savedFiles.length}장 저장` : ""}${saved.failureCount ? ` · ${saved.failureCount}장 저장 실패` : ""}`
                : "완료된 이미지 결과가 없습니다.",
            } : item));
          });
        } catch (error) {
          if (error instanceof HorizonBatchStepError) throw error;
          throw new HorizonBatchStepError(stage, horizonBatchStageFailureMessage(stage));
        }
      }, (current, error) => {
        setBatch((items) => items.map((item) => item.key === current.key ? { ...item, status: "failed", message: horizonBatchFailureMessage(error) } : item));
      });
    } finally {
      setBatch((items) => items.map((item) => {
        const status = settleHorizonBatchStatus(item.status, item.ready);
        return status === item.status ? item : { ...item, status, message: "일괄 작업이 중단되어 완료하지 못했습니다." };
      }));
      batchActive.current = false; setBatchRunning(false);
    }
  };

  const downloadBatchResults = async (results: readonly HorizonBatchDownload[]) => {
    try {
      for (const result of results) await downloadMedia(result.url, result.filename);
      setMessage(`${results.length}개 배치 결과의 저장 요청을 전송했습니다.`);
    } catch {
      setMessage("일부 배치 결과를 저장하지 못했습니다. 다시 시도해 주세요.");
    }
  };

  const engineLabel = engine === "gpt-2k" ? "GPT Image 2.0 · 2K" : `Nano Banana Pro · ${engine === "nano-4k" ? "4K" : "2K"}`;
  const batchProgress = horizonBatchProgress(batch);
  const readyBatchCount = batch.filter((job) => job.ready).length;
  const excludedBatchCount = batch.length - readyBatchCount;
  const expectedBatchResults = readyBatchCount * quantity;
  const allBatchResults = batch.flatMap((item) => item.results ?? []);
  const connection = horizonConnectionState(resolvedScopeKey, GUEST_SCOPE_KEY);
  return <div className="hz-app">
    <SignInModal open={pendingSignInUrl != null} signInUrl={pendingSignInUrl} onOpenChange={(open) => { if (!open) setPendingSignInUrl(null); }} />
    {restoreTarget ? <HorizonRestoreDialog generatedUrl={`/api/higgsfield/result/${encodeURIComponent(restoreTarget.id)}`} generatedName={restoreTarget.name} defaultOriginal={restoreOriginal} onClose={() => setRestoreTarget(null)} /> : null}
    <aside className="hz-sidebar"><div className="hz-brand"><div className="hz-logo">H</div> AI HORIZON</div><nav className="hz-nav"><button className="active">이미지 생성</button><button disabled={accountMutationBlocked} onClick={reset}>전체 초기화</button><button disabled={accountMutationBlocked} onClick={leaveHorizon}>인플루언서 콘텐츠</button></nav><div className="hz-side-note">자동화 규격 <b>AUTO FOLDER V6</b><br/>브라우저에서 선택한 폴더별 결과를 완성합니다.</div></aside>
    <main className="hz-main"><div className="hz-content">
      <header className="hz-topbar"><div><h1>패션 이미지 생성</h1><p>개별 이미지 또는 번호 폴더 전체를 각자의 계정으로 자동 생성합니다.</p></div><div className="hz-statuses"><span className="hz-status ok">PERSONAL DISTRIBUTION V17</span><span className="hz-status ok">회사 OpenAI 서버</span><span className={`hz-status ${connection.status === "connected" ? "ok" : ""}`}>{connection.label}</span></div></header>
      <section className="hz-account-panel"><div className="hz-account-card"><div><h3>회사 OpenAI 서버</h3><p>Windows NSSM의 OPENAI_API_KEY를 직원 전체가 공용 사용합니다.</p></div><span className="hz-account-state">직원 공용</span></div><div className="hz-account-card"><div><h3>내 Higgsfield 계정</h3><p>{accountMutationBlocked?"작업 진행 중에는 계정 변경과 연결 해제를 사용할 수 없습니다.":"회사 배정 계정은 OAuth 제공자 화면에서 선택합니다."}</p></div>{resolvedScopeKey===undefined?<button className="hz-auth-button" disabled>연결 확인 중</button>:scopeKey===GUEST_SCOPE_KEY?<button className="hz-auth-button" onClick={()=>requireSignIn()}>연결</button>:<div className="hz-account-actions"><button className="hz-auth-button hz-auth-switch" title="현재 연결을 끊고 다른 Higgsfield 계정으로 로그인" disabled={accountMutationBlocked} onClick={()=>void disconnect(true)}>{accountAction==="reconnect"?"계정 변경 중…":"계정 변경"}</button><button className="hz-auth-button hz-auth-disconnect" title="이 브라우저의 Higgsfield 연결만 해제" disabled={accountMutationBlocked} onClick={()=>void disconnect(false)}>{accountAction==="disconnect"?"연결 해제 중…":"연결 해제"}</button></div>}</div></section>
      <div className="hz-workspace"><div className="hz-steps">
        {(["model","wardrobe","accessory"] as const).map((group,index)=><section className="hz-step" key={group}><div className="hz-step-head"><div className="hz-num">0{index+1}</div><div><h3>{group==="model"?"모델 참조":group==="wardrobe"?"의상 참조":"액세서리 참조"}</h3><p>{group==="model"?"인물과 포즈를 유지할 기준 이미지를 올려주세요.":group==="wardrobe"?"전신 착장 또는 상의·하의 디테일 이미지를 올려주세요.":"가방, 모자, 주얼리, 신발 등 필요한 항목만 선택하세요."}</p></div></div><div className="hz-upload-grid">{HORIZON_SLOTS.filter((slot)=>slot.group===group).map((slot)=>{const items=images.filter((image)=>image.slotId===slot.id);const slotDragging=draggingSlots.has(slot.id);const slotUploading=uploadingSlots.has(slot.id);return <div className={`hz-upload ${items.length?"has-items":""} ${slotDragging?"drag-active":""} ${slotUploading?"uploading":""}`} key={slot.id} aria-disabled={batchRunning||slotUploading} aria-busy={slotUploading} onDragEnter={(event)=>{event.preventDefault();beginSlotDrag(slot.id);}} onDragLeave={(event)=>{event.preventDefault();endSlotDrag(slot.id);}} onDragOver={(event)=>{event.preventDefault();event.dataTransfer.dropEffect="copy";}} onDrop={(event)=>{event.preventDefault();clearSlotDrag(slot.id);void addFiles(slot.id,[...event.dataTransfer.files]);}}><label className="hz-upload-add"><input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={batchRunning||slotUploading} onChange={(event)=>{void addFiles(slot.id,[...(event.target.files??[])]);event.currentTarget.value="";}}/><span className="hz-upload-copy"><b>{slot.label}</b><strong>{slotUploading?"업로드 중…":slotDragging?"여기에 놓아 업로드":"여러 장 선택"}</strong><small>{slotUploading?"이미지를 안전하게 처리하고 있습니다.":"한 번에 여러 장 또는 반복해서 계속 추가"}</small><small className="hz-drop-copy">{slotDragging?"마우스를 놓으면 이 카드에 추가됩니다.":"폴더에서 이 카드로 드래그앤드롭 가능"}</small></span><em>{items.length}장</em><i>{slot.hint}</i></label><div className="hz-thumb-list">{items.map((image)=><div className={`hz-ref-thumb ${image.selected?"selected":""}`} key={image.id}><button type="button" className="hz-ref-toggle" disabled={batchRunning} aria-pressed={image.selected} aria-label={`${image.code} ${slot.label} 적용 ${image.selected?"해제":"선택"}`} onClick={()=>toggleImage(image.id)}><img src={image.asset.src} alt=""/><span className="hz-ref-code">{image.code}</span><span className="hz-ref-check">{image.selected?"✓":"–"}</span></button><button type="button" className="hz-ref-remove" disabled={batchRunning} aria-label={`${image.code} 삭제`} onClick={()=>removeImage(image.id)}>×</button></div>)}</div></div>})}</div></section>)}
        <section className="hz-step"><div className="hz-step-head"><div className="hz-num">04</div><div><h3>선택 옵션 · 비워도 됨</h3><p>이미지만으로 자동 작성하거나 M1 W2 W3 A1처럼 사용할 번호만 적으세요.</p></div></div><div className="hz-fields"><textarea maxLength={1200} disabled={batchRunning} value={brief} onChange={(event)=>{setBrief(event.target.value);invalidate();}} placeholder="아무것도 쓰지 않아도 됩니다. 번호로 고르려면 예: M1 W2 W3 A1 / 추가 요청이 있을 때만 한국어로 작성"/><div className="hz-prompt-actions"><button className="hz-primary" disabled={promptBusy||batchRunning} onClick={()=>void writePrompt()}>{promptBusy?"자동 JSON 분석 중…":"이미지로 자동 JSON 명령어 작성"}</button><span className="hz-hint">{brief.length}/1200 · 빈칸 가능 · 번호만 입력 가능</span></div></div></section>
        <section className="hz-step"><div className="hz-step-head"><div className="hz-num">05</div><div><h3>최종 생성 명령어</h3><p>확인 후 필요한 부분만 직접 수정할 수 있습니다.</p></div></div><div className="hz-fields"><textarea className="hz-command" disabled={batchRunning} value={command} onChange={(event)=>setCommand(event.target.value)} placeholder="위의 ‘이미지로 자동 JSON 명령어 작성’을 누르면 여기에 결과가 표시됩니다."/><div className="hz-prompt-actions"><button className="hz-ghost" onClick={()=>void copyCommand()} disabled={!command||batchRunning}>명령어 복사</button><span className="hz-hint">직접 수정 가능</span></div></div></section>
        <section className="hz-step"><div className="hz-step-head"><div className="hz-num">06</div><div><h3>폴더 일괄 자동 생성</h3><p>모든 단계의 하위 폴더를 끝까지 읽고, 번호 이미지가 있는 폴더마다 결과를 생성합니다.</p></div></div><div className="hz-batch-fields"><input className="hz-batch-fallback-input" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={batchRunning||run.isRunning||batchScanning} ref={(node)=>{fallbackFolderInput.current=node;node?.setAttribute("webkitdirectory","");}} onChange={(event)=>{const files=event.currentTarget.files;event.currentTarget.value="";if(files)chooseFallbackFolder(files);}}/><p className="hz-batch-instruction">상품별 폴더에 1.jpg부터 번호를 붙여 넣으세요. 같은 역할의 참고 이미지가 여러 장이면 3-1.jpg, 3-2.jpg 또는 4-1.jpg, 4-2.jpg처럼 정리한 뒤 상위 폴더를 선택하세요.</p>{batchRootName?<div className="hz-batch-root"><span>선택한 루트 폴더</span><b>{batchRootName}</b>{batchDirectoryPermission==="prompt"||batchDirectoryPermission==="denied"?<small>읽기·쓰기 권한 재승인이 필요합니다.</small>:batchDirectoryPermission==="granted"?<small>이 브라우저에 폴더 연결이 저장되어 있습니다.</small>:<small>완성 결과는 브라우저 다운로드로 저장합니다.</small>}</div>:null}<div className="hz-batch-actions"><button className="hz-primary" disabled={batchRunning||run.isRunning||batchScanning} onClick={()=>void (batchDirectoryPermission==="granted"&&batchDirectory?rescanBatchDirectory():batchDirectory&&(batchDirectoryPermission==="prompt"||batchDirectoryPermission==="denied")?approveBatchDirectory():chooseBatchDirectory())}>{batchScanning?"폴더 스캔 중…":batchDirectory&&(batchDirectoryPermission==="prompt"||batchDirectoryPermission==="denied")?"폴더 권한 다시 승인":batchDirectory&&batchDirectoryPermission==="granted"?"다시 스캔":"대량 생성 폴더 선택"}</button>{batchDirectory?<button className="hz-ghost" disabled={batchRunning||run.isRunning||batchScanning} onClick={()=>void chooseBatchDirectory()}>다른 폴더 선택</button>:null}{batchFallbackRequired?<button className="hz-ghost" disabled={batchRunning||run.isRunning||batchScanning} onClick={()=>fallbackFolderInput.current?.click()}>브라우저 방식으로 폴더 선택</button>:null}<button className="hz-primary" disabled={!readyBatchCount||batchRunning||run.isRunning||batchScanning||Boolean(batchScanError)} onClick={()=>void startBatch()}>일괄 자동 생성 시작</button>{allBatchResults.length?<button className="hz-ghost" disabled={batchRunning||run.isRunning} onClick={()=>void downloadBatchResults(allBatchResults)}>전체 배치 결과 저장</button>:null}</div>{batchScanError?<p className="hz-batch-empty">{batchScanError}</p>:batchScanned?(batch.length?<p className="hz-batch-found">상품 폴더 {batch.length}개를 찾았습니다. · 생성 가능 {readyBatchCount}개 · 제외 {excludedBatchCount}개</p>:<p className="hz-batch-empty">생성할 상품 폴더가 없습니다. 각 상품 폴더에 1.jpg가 필요합니다.</p>):null}<p className="hz-batch-note">같은 기본 번호의 하위 번호 이미지는 하나의 제품 역할로 함께 참고합니다. 중간 폴더가 여러 단계여도 자동으로 탐색하고, 숨김 폴더와 ‘완성본’은 제외하며, 오른쪽의 모델·비율·수량 설정이 전체에 적용됩니다. 폴더 선택과 스캔만으로 생성은 시작되지 않습니다.</p>{batch.length?<><div className="hz-batch-summary"><div><span>전체 작업 폴더</span><b>{batch.length}</b></div><div><span>생성 가능</span><b>{readyBatchCount}</b></div><div><span>제외 폴더</span><b>{excludedBatchCount}</b></div><div><span>예상 결과</span><b>{expectedBatchResults}장</b></div><div><span>처리 완료</span><b>{batchProgress.processed}/{batchProgress.total}</b></div></div><div className="hz-batch-progress"><div style={{width:`${batchProgress.percent}%`}}/></div><div className="hz-batch-list">{batch.map((job)=><div className="hz-batch-job" key={job.key}><span>{job.name} <small>· 입력 {job.files.length}장{job.message?` · ${job.message}`:""}{job.savedFiles?.length?` · 저장: ${job.savedFiles.join(", ")}`:""}</small></span><div className="hz-batch-job-actions"><b className={job.status==="failed"||!job.ready?"bad":"ok"}>{!job.ready?batchErrorLabel(job.error):job.status}</b>{job.results?.length?<button type="button" className="hz-ghost" onClick={()=>void downloadBatchResults(job.results??[])}>폴더 결과 저장</button>:null}</div></div>)}</div></>:null}</div></section>
        <section className="hz-results"><div className="hz-results-head"><div><h3>생성 결과 및 다운로드</h3><span className="hz-hint">완료된 이미지는 여기에서 확인하고 저장할 수 있습니다.</span></div></div>{history.isPending?<div className="hz-result-empty">최근 결과를 불러오는 중입니다.</div>:historyItems.length===0?<div className="hz-result-empty">아직 생성된 이미지가 없습니다.</div>:<Suspense fallback={<div className="hz-result-empty">결과를 불러오는 중입니다.</div>}><LazyUserGenerations items={historyItems} hasMore={history.hasNextPage===true} loadingMore={history.isFetchingNextPage} onLoadMore={history.fetchNextPage}/></Suspense>}</section>
      </div><aside className="hz-sticky"><h3>출력 설정</h3><div className="hz-summary"><div className="hz-row"><span>선택 이미지</span><span>{selected.length}/{images.length}장 적용</span></div><div className="hz-row"><span>프롬프트 엔진</span><span>GPT-5.6 Terra · V6</span></div><div className="hz-row"><span>생성 엔진</span><span>{engineLabel}</span></div><div className="hz-row"><span>출력 해상도</span><span>{engine.endsWith("4k")?"4K":"2K"}</span></div></div><label className="hz-field">촬영 방향 · 기준 모델<select disabled={batchRunning} value={view} onChange={(event)=>{setView(event.target.value as HorizonView);invalidate();}}>{HORIZON_VIEWS.map((item)=><option key={item} value={item}>{item==="auto"?"자동 판별":item==="front"?"정면 · 모델 정면 사용":item==="side"?"측면/45도 · 모델 측면 사용":"후면 · 모델 후면 사용"}</option>)}</select></label><label className="hz-field">생성 모델 · 해상도<select disabled={batchRunning} className="hz-engine-choice" value={engine} onChange={(event)=>setEngine(event.target.value as HorizonEngine)}><option value="gpt-2k">GPT Image 2.0 · 2K</option><option value="nano-2k">Nano Banana Pro · 2K</option><option value="nano-4k">Nano Banana Pro · 4K</option></select></label><label className="hz-field">이미지 비율<select disabled={batchRunning} value={ratio} onChange={(event)=>{setRatio(event.target.value);invalidate();}}>{HORIZON_RATIOS.map((item)=><option key={item}>{item}</option>)}</select></label><label className="hz-field">생성 수량 (최대 4장)<input disabled={batchRunning} type="number" min={1} max={4} value={quantity} onChange={(event)=>setQuantity(Math.max(1,Math.min(4,Number(event.target.value)||1)))}/></label><p className="hz-selection-guide">촬영 방향을 선택하면 해당 방향의 모델 이미지만 기준으로 전송됩니다. 참조 썸네일은 초록색으로 선택하고 최대 14장까지 적용할 수 있습니다.</p><button className="hz-generate" disabled={run.isRunning||batchRunning||promptBusy||!selected.length} onClick={()=>void generate()}>{run.isRunning?"생성 진행 중…":`AUTO JSON → ${engineLabel} 생성`}</button><div className="hz-progress"><div style={{width:run.isRunning?"70%":run.status==="completed"?"100%":"0%"}}/></div><div className="hz-message">{batchRunning?"일괄 작업 시작 시점의 모델·비율·수량 설정으로 실행 중입니다.":message||"이미지를 선택하고 자동 JSON 명령어를 작성해 주세요."}</div><section className="hz-recent"><div className="hz-recent-head"><div><h4>최근 생성 결과</h4><span>{engineLabel}</span></div><div className="hz-recent-actions"><button type="button" onClick={()=>void refreshResults()}>결과 불러오기</button>{filteredRecentItems.some((item)=>item.status==="ready")?<button type="button" onClick={()=>void downloadAllResults()}>전체 저장</button>:null}</div></div>{history.isPending?<div className="hz-recent-empty">최근 결과를 불러오는 중입니다.</div>:recentItems.length?<div className="hz-recent-grid">{recentItems.map((item)=><HorizonRecentGeneration key={item.id} item={item} onRestore={(target) => setRestoreTarget({ id: target.id, name: `horizon-${target.id}` })}/>)}</div>:<div className="hz-recent-empty">선택한 모델의 생성 결과가<br/>여기에 표시됩니다.</div>}</section></aside></div>
    </div></main>
  </div>;
}
