import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

describe("existing product UI regression boundary", () => {
  test("keeps the preset layout, copy, controls, tabs, and prompts byte-identical", async () => {
    const source = normalizeLineEndings(
      await readFile(new URL("../src/layouts/preset.tsx", import.meta.url), "utf8"),
    );
    const withoutAllowedConnectionHooks = source
      .replace('import { HorizonWorkspace } from "./horizon-workspace";\n', "")
      .replace("  removeGenerationQueries,\n", "")
      .replace("  disconnectHiggsfieldOAuth,\n", "")
      .replace(
        /import \{\n {2}GUEST_SCOPE_KEY,[\s\S]*? {2}uploadAsset,\n\} from "@\/lib\/fnf\.browser";/,
        'import { GUEST_SCOPE_KEY, getSignInUrl, PRESET_JOBS, uploadAsset } from "@/lib/fnf.browser";',
      )
      .replace(/\n {2}useEffect\([\s\S]*?\n\n {2}const history/, "\n  const history")
      .replace(
        /\n {2}const selectPose = useCallback[\s\S]*?\n\n {2}const handleUpload/,
        "\n  const handleUpload",
      )
      .replaceAll("selectPose(selected)", "setPose(selected)")
      .replace("}, [selectPose]);", "}, []);")
      .replace("onSelect={selectPose}", "onSelect={setPose}")
      .replace(/\n {18}if \(pose\.ref\?\.id\) \{[\s\S]*?\n {18}\}/, "")
      .replace("@/lib/profile.browser", "@/lib/profile.functions")
      .replace('poseMediaId: pose.ref?.id ?? ""', "poseImageUrl: pose.src")
      .replace(
        "  const resolvedScopeKey = useFnfScopeKey();\n  const scopeKey = resolvedScopeKey ?? GUEST_SCOPE_KEY;",
        "  const scopeKey = useFnfScopeKey() ?? GUEST_SCOPE_KEY;",
      )
      .replace(
        /\n {2}const clearInfluencerWorkspace = \(\) => \{[\s\S]*?\n {2}\};\n\n {2}const makeProfile/,
        "\n  const makeProfile",
      )
      .replace(
        /\n {12}if \(value === "horizon" && \(run\.isRunning \|\| profileBusy\)\) \{[\s\S]*?\n {12}\}/,
        "",
      )
      .replace(
        /\n {12}<div className="flex min-h-6 items-center justify-center gap-1">[\s\S]*?\n {12}<\/div>/,
        "",
      )
      .replace(/\n {2}if \(mode === "horizon"\) \{\n {4}return <HorizonWorkspace[\s\S]*?\n {2}\}\n\n/, "\n");
    expect(sha256(withoutAllowedConnectionHooks)).toBe(
      "fc1b405dc6d1a9edb0dbb9bb0963af619a06a0fd718a3045a9751d6c696ea1e8",
    );
  });

  test("adds only the scoped Influencer Higgsfield account controls", async () => {
    const component = normalizeLineEndings(
      await readFile(new URL("../src/layouts/preset.tsx", import.meta.url), "utf8"),
    );
    for (const copy of ["Higgsfield 연결 확인 중", "Higgsfield 계정 연결", "계정 변경", "연결 해제"]) {
      expect(component).toContain(copy);
    }
    expect(component).toContain("resolvedScopeKey === undefined");
    expect(component).toContain('scopeKey === GUEST_SCOPE_KEY');
    expect(component).toContain('disabled={run.isRunning || profileBusy}');
    expect(component).toContain("if (run.isRunning || profileBusy)");

    const cleanup = component.indexOf("const clearInfluencerWorkspace = () => {");
    const release = component.indexOf("releaseAllLocalUploads();", cleanup);
    const clearPose = component.indexOf("setPose(null);", cleanup);
    const clearQueries = component.indexOf("removeGenerationQueries(queryClient, { scopeKey });", cleanup);
    const disconnect = component.indexOf("await disconnectHiggsfieldOAuth();");
    const clearCall = component.indexOf("clearInfluencerWorkspace();", disconnect);
    const failureBoundary = component.indexOf("} catch {", disconnect);
    const handlerEnd = component.indexOf("\n  };", failureBoundary);
    expect(disconnect).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(cleanup);
    expect(clearPose).toBeGreaterThan(release);
    expect(clearQueries).toBeGreaterThan(clearPose);
    expect(clearCall).toBeGreaterThan(disconnect);
    expect(clearCall).toBeLessThan(failureBoundary);
    expect(component.slice(failureBoundary, handlerEnd)).not.toContain("releaseAllLocalUploads");
    expect(component.slice(failureBoundary, handlerEnd)).not.toContain("setPose(null)");
    expect(component.slice(failureBoundary, handlerEnd)).not.toContain("removeGenerationQueries");
    expect(component).toContain("setUploads([]);");
    expect(component).toContain("setProfile(null);");
    expect(component).toContain("현재 작업은 그대로 유지됩니다.");
    expect(component).not.toContain("disconnectHorizonOAuth");
  });

  test("contains the restored Horizon workspace sections without changing influencer copy", async () => {
    const component = normalizeLineEndings(
      await readFile(new URL("../src/layouts/horizon-workspace.tsx", import.meta.url), "utf8"),
    );
    const contract = normalizeLineEndings(
      await readFile(new URL("../src/lib/horizon.ts", import.meta.url), "utf8"),
    );
    const styles = normalizeLineEndings(
      await readFile(new URL("../src/layouts/horizon-workspace.css", import.meta.url), "utf8"),
    );
    const source = `${component}\n${contract}`;
    for (const copy of [
      "패션 이미지 생성", "모델 참조", "모델 정면", "모델 측면/45도", "모델 후면",
      "의상 참조", "전신 착장", "상의 디테일", "하의 디테일", "액세서리 참조",
      "액세서리/착용법", "신발", "양말", "선택 옵션 · 비워도 됨",
      "이미지로 자동 JSON 명령어 작성", "최종 생성 명령어", "폴더 일괄 자동 생성",
      "GPT Image 2.0 · 2K", "Nano Banana Pro · 2K", "Nano Banana Pro · 4K",
      "생성 결과 및 다운로드", "최근 생성 결과", "결과 불러오기", "전체 저장",
      "자동 판별", "정면 · 모델 정면 사용", "측면/45도 · 모델 측면 사용",
      "후면 · 모델 후면 사용", "생성 모델 · 해상도", "생성 수량 (최대 4장)",
      "여러 장 선택", "한 번에 여러 장 또는 반복해서 계속 추가",
      "폴더에서 이 카드로 드래그앤드롭 가능",
      "대량 생성 폴더 선택", "다시 스캔", "다른 폴더 선택", "폴더 권한 다시 승인",
      "선택한 원본 경로", "전체 작업 폴더", "전체 결과 파일 완성본에 다시 저장",
      "상품별 폴더에 1.jpg부터 번호를 붙여 넣으세요. 같은 역할의 참고 이미지가 여러 장이면 3-1.jpg, 3-2.jpg 또는 4-1.jpg, 4-2.jpg처럼 정리한 뒤 상위 폴더를 선택하세요.",
      "같은 기본 번호의 하위 번호 이미지는 하나의 제품 역할로 함께 참고합니다.",
      "생성할 상품 폴더가 없습니다. 각 상품 폴더에 1.jpg가 필요합니다.",
      "Higgsfield 크레딧이 최대 ${expectedCount}회 사용될 수 있습니다. 일괄 생성을 시작할까요?",
      "촬영 방향을 선택하면 해당 방향의 모델 이미지만 기준으로 전송됩니다.",
      "AUTO JSON →", "아직 생성된 이미지가 없습니다.",
      "직원 공용",
    ]) expect(source).toContain(copy);
    expect(component).not.toContain("브라우저 방식으로 폴더 선택");
    expect(component).not.toContain("PNG와 PSD를 브라우저 다운로드로 함께 저장합니다.");
    expect(component).toContain('batchDirectoryPermission!=="granted"');
    expect(component).toContain("결과 파일이 저장되지 않으면 해당 결과를 완료로 처리하지 않습니다.");
    expect(component).toContain("saveHorizonBatchNative");
    expect(component).not.toContain("saveHorizonBatchPng(");
    expect(component).not.toContain("saveHorizonBatchPngPsd");
    expect(component).not.toContain("PNG+PSD");
    expect(component).not.toContain("2레이어 PSD");
    expect(component).toContain("await ensureHorizonCompletedDirectory(handle);");
    expect(source).not.toContain("OPENAI_API_KEY 입력");
    expect(source).not.toContain("계정 드롭다운");
    expect(component).toContain("await disconnectHiggsfieldOAuth();");
    expect(component.indexOf("await disconnectHiggsfieldOAuth();")).toBeLessThan(
      component.indexOf("clearCurrentBrowserWorkspace();", component.indexOf("await disconnectHiggsfieldOAuth();")),
    );
    expect(component).toContain("parentBusy || run.isRunning || batchRunning || batchScanning || batchActive.current");
    expect(component).toContain("promptBusy || promptFlight.current");
    expect(component).toContain("claimHorizonImageReservation(imagesRef.current.length, uploadReservations.current, files.length)");
    expect(component).toContain("uploadReservations.current = Math.max(0, uploadReservations.current - files.length)");
    expect(component).toContain("slotUploadLocks.current.has(slotId)");
    expect(component).toContain("dragDepths.current.set(slotId, (dragDepths.current.get(slotId) ?? 0) + 1)");
    expect(component).toContain('slotDragging?"여기에 놓아 업로드":"여러 장 선택"');
    expect(component).toContain('slotUploading?"업로드 중…"');
    expect(component).toContain("aria-busy={slotUploading}");
    expect(component).toContain("accountActionFlight.current");
    expect(component).toContain('window.confirm("현재 브라우저의 선택 이미지와 작업 상태가 초기화됩니다. 계속할까요?")');
    expect(component).toContain('title="현재 연결을 끊고 다른 Higgsfield 계정으로 로그인"');
    expect(component).toContain('title="이 브라우저의 Higgsfield 연결만 해제"');
    expect(component).toContain('accountAction==="reconnect"?"계정 변경 중…":"계정 변경"');
    expect(component).toContain('accountAction==="disconnect"?"연결 해제 중…":"연결 해제"');
    expect(styles).toContain(".hz-auth-button:hover:not(:disabled)");
    expect(styles).toContain(".hz-auth-button:focus-visible");
    expect(styles).toContain(".hz-auth-button:active:not(:disabled)");
    expect(styles).toContain(".hz-auth-disconnect:hover:not(:disabled)");
    expect(styles).toContain(".hz-account-state {");
    expect(styles).toContain("cursor: default;");
    expect(styles).toContain(".hz-upload.drag-active {");
    expect(styles).toContain(".hz-upload.uploading {");
    expect(component).toContain("onParentWorkspaceReset();");
    expect(component).toContain('<button type="button" className="hz-ref-toggle"');
    expect(component).toContain('aria-pressed={image.selected}');
    expect(component).not.toContain('role="button"');
    expect(component).toContain("finally {");
    expect(component).toContain("setPromptBusy(false);");
    expect(component).toContain("const batchSettings = { engine, ratio, quantity };");
    expect(component).toContain("horizonGenerationMatchesEngine(generation, engine)");
    expect(component).toContain("const downloadable = filteredRecentItems.filter");
    expect(component).toContain('label: "다운로드", icon: IconDownload');
    expect(component).toContain('openLabel={`원본 결과 보기: ${item.prompt}`}');
    expect(component).not.toContain("chooseFallbackFolder");
    expect(component).not.toContain("fallbackFolderInput");
    expect(component).toContain('setBatchDirectory(null); setBatchDirectoryPermission("unsupported");');
    expect(component).toContain('savedFiles: saved.savedFiles');
    expect(component).toContain('saveFailureCount: saved.failureCount');
    expect(component).toContain("const status = settleHorizonBatchStatus(item.status, item.ready);");
    expect(component).toContain("일괄 작업이 중단되어 완료하지 못했습니다.");
    const chooseBatchDirectory = component.slice(
      component.indexOf("const chooseBatchDirectory"),
      component.indexOf("const rescanBatchDirectory"),
    );
    expect(chooseBatchDirectory).toContain("if (!supportsHorizonDirectoryPicker()) {");
    expect(chooseBatchDirectory).toContain("Chrome 또는 Edge에서 다시 열어 주세요.");
    const pickerFailure = chooseBatchDirectory.slice(chooseBatchDirectory.indexOf("} catch (error) {"));
    expect(pickerFailure).not.toContain("브라우저 방식");
    const approveBatchDirectory = component.slice(
      component.indexOf("const approveBatchDirectory"),
      component.indexOf("const startBatch"),
    );
    expect(approveBatchDirectory).toContain("작업을 시작할 수 없습니다");
    expect(approveBatchDirectory).not.toContain("브라우저 다운로드 방식");
    expect(component).toContain("syncHorizonHistory(queryClient, done, scopeKey);");
    expect(component).not.toContain("const created = useRef(new Set<string>());");
    expect(component).not.toContain("void navigator.clipboard.writeText(command)");
    expect(component).not.toContain("No generations yet");
    expect(component).not.toContain("Higgsfield 크레딧 사용 가능 횟수");
  });

  test("keeps the existing SignInModal DOM, copy, and styling unchanged", async () => {
    const source = normalizeLineEndings(
      await readFile(
        new URL("../src/components/sign-in-modal/sign-in-modal.tsx", import.meta.url),
        "utf8",
      ),
    );
    expect(sha256(source)).toBe("57af5005afaae0f46b9793034f7d7263c2a14b3ec882df8464eb5217ced2fd3a");
  });
});
