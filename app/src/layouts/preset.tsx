import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitInputFor } from "@higgsfield/fnf/client";
import {
  costQueryOptions,
  flattenFeedPages,
  jobsFeedQueryOptions,
  prependGenerations,
  removeGenerationQueries,
  useFnfJobClient,
  useFnfScopeKey,
  useGenerationRun,
  useLiveFeedGenerations,
} from "@higgsfield/fnf-react";
import { Download, Image, Plus, WandSparkles } from "lucide-react";
import Sparkles from "@/assets/icon-sparkles-soft.svg?react";
import { Button } from "@higgsfield/quanta/button";
import { Card, card } from "@higgsfield/quanta/card";
import { Icon } from "@higgsfield/quanta/icon";
import { Loader } from "@higgsfield/quanta/loader";
import { Tabs } from "@higgsfield/quanta/tabs";
import { Typography } from "@higgsfield/quanta/typography";
import { Composer } from "@/components/composer";
import { RailFooter } from "@/components/rail-footer";
import { SignInModal } from "@/components/sign-in-modal";
import { UploadField } from "@/components/upload-field";
import { AssetLibraryModal } from "@/components/asset-library";
import type {
  AssetLibraryItem,
  AssetLibraryPagination,
  AssetSelection,
} from "@/components/asset-library";
import type { GalleryItem } from "@/components/gallery";
import { generationToGalleryItem } from "@/lib/higgsfield-generation-results";
import { getNextCursor } from "@/lib/cursor-pages";
import {
  disconnectHiggsfieldOAuth,
  GUEST_SCOPE_KEY,
  getReconnectSignInUrl,
  getSignInUrl,
  PRESET_JOBS,
  releaseAllLocalUploads,
  releaseLocalUpload,
  subscribeHiggsfieldReconnect,
  uploadAsset,
} from "@/lib/fnf.browser";
import { composeInfluencerProfile } from "@/lib/profile.browser";
import { savePreferences } from "@/lib/preferences.functions";
import catalogJson from "@/data/reference-catalog.json";
import { HorizonWorkspace } from "./horizon-workspace";

type GenerationInput = SubmitInputFor<typeof PRESET_JOBS>;
type Mode = "influencer" | "horizon";
type Gender = "male" | "female";

const HISTORY_QUERY = { type: "image" as const, size: 40 };
const LazyUserGenerations = lazy(async () => {
  const module = await import("@/components/user-generations");
  return { default: module.UserGenerations };
});

type CatalogScene = { id: string; label: string; images: string[] };
type CatalogEnvironment = { id: string; label: string; scenes: CatalogScene[] };
type CatalogGender = { id: Gender; label: string; environments: CatalogEnvironment[] };
const CATALOG = catalogJson as { genders: CatalogGender[] };
const INITIAL_GENDER = CATALOG.genders.find((item) => item.id === "female") ?? CATALOG.genders[0]!;
const INITIAL_ENVIRONMENT = INITIAL_GENDER.environments[0]!;
const INITIAL_SCENE = INITIAL_ENVIRONMENT.scenes[0]!;

const IMAGE_TYPES = [
  ["auto", "자동 · 자연스러운 SNS"],
  ["street photography", "Street Photography"],
  ["digital camera", "Digital Camera"],
  ["old smartphone", "Old Smartphone"],
  ["subtle flash", "Subtle Flash"],
  ["editorial street style", "Editorial Street Style"],
  ["warm ambient", "Warm Ambient"],
] as const;

const RATIOS = ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"] as const;

function FieldSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string] | string)[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="px-1 text-q-caption-sm-medium text-q-text-secondary">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-q-300 border border-q-border-subtle bg-q-background-secondary px-3 text-q-body-sm-regular text-q-text-primary outline-none focus:border-q-border-focus"
      >
        {options.map((option) => {
          const item = Array.isArray(option) ? option : [option, option];
          return (
            <option key={item[0]} value={item[0]}>
              {item[1]}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function ProfilePreview({
  profile,
  onDownload,
}: {
  profile: Record<string, unknown> | null;
  onDownload: () => void;
}) {
  return (
    <Card surface="solid" className="min-h-0 flex-1 overflow-hidden p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <Typography as="h2" variant="accent-md-bold" color="primary" className="uppercase">
            GPT JSON
          </Typography>
          <Typography as="p" variant="caption-sm-regular" color="secondary">
            GPT-5.6 Terra가 포즈와 선택값을 결합한 결과입니다.
          </Typography>
        </div>
        {profile ? (
          <Button variant="tertiary" size="sm" onClick={onDownload} start={<Icon as={Download} />}>
            JSON 저장
          </Button>
        ) : null}
      </div>
      {profile ? (
        <pre className="h-full overflow-auto whitespace-pre-wrap rounded-q-300 bg-q-background-primary p-4 text-q-caption-xs-regular text-q-text-secondary">
          {JSON.stringify(profile, null, 2)}
        </pre>
      ) : (
        <div className="grid h-full min-h-80 place-items-center rounded-q-300 border border-dashed border-q-border-subtle text-center">
          <div className="max-w-sm">
            <Icon as={WandSparkles} size="lg" color="secondary" />
            <Typography as="h3" variant="body-md-semi-bold" color="primary" className="mt-3">
              포즈 이미지를 넣고 JSON을 만드세요
            </Typography>
            <Typography as="p" variant="body-sm-regular" color="secondary" className="mt-1">
              성별·장소·연출은 고정하고 포즈만 분석해 Soul 2용 영문 프롬프트를 만듭니다.
            </Typography>
          </div>
        </div>
      )}
    </Card>
  );
}

export function PresetTemplate() {
  const jobClient = useFnfJobClient<typeof PRESET_JOBS>();
  const resolvedScopeKey = useFnfScopeKey();
  const scopeKey = resolvedScopeKey ?? GUEST_SCOPE_KEY;
  const queryClient = useQueryClient();
  const run = useGenerationRun(jobClient, { scopeKey });
  const prepended = useRef(new Set<string>());
  const [mode, setMode] = useState<Mode>("influencer");
  const [gender, setGender] = useState<Gender>("female");
  const [environment, setEnvironment] = useState(INITIAL_ENVIRONMENT.id);
  const [scene, setScene] = useState(INITIAL_SCENE.id);
  const [imageType, setImageType] = useState("auto");
  const [aspectRatio, setAspectRatio] = useState<(typeof RATIOS)[number]>("2:3");
  const [count, setCount] = useState("1");
  const [pose, setPose] = useState<AssetSelection | null>(null);
  const [uploads, setUploads] = useState<AssetLibraryItem[]>([]);
  const [brief, setBrief] = useState("");
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState("json");
  const [pendingSignInUrl, setPendingSignInUrl] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeHiggsfieldReconnect(() => {
        setPendingSignInUrl(
          getReconnectSignInUrl(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
          ),
        );
      }),
    [],
  );
  useEffect(() => releaseAllLocalUploads, []);

  const history = useInfiniteQuery({
    ...jobsFeedQueryOptions(jobClient, HISTORY_QUERY, { scopeKey }),
    getNextPageParam: getNextCursor,
    select: flattenFeedPages,
  });
  const generations = useMemo(() => history.data ?? [], [history.data]);
  useLiveFeedGenerations(jobClient, generations, { scopeKey });
  const historyItems = useMemo(
    () =>
      generations
        .map(generationToGalleryItem)
        .filter((item): item is GalleryItem => item != null),
    [generations],
  );

  const pagination = useMemo<AssetLibraryPagination>(
    () => ({
      uploads: { hasMore: false, loading: false, onLoadMore: async () => undefined },
      image: { hasMore: false, loading: false, onLoadMore: async () => undefined },
      video: { hasMore: false, loading: false, onLoadMore: async () => undefined },
    }),
    [],
  );

  const masterPrompt =
    profile && typeof profile.master_prompt === "string" ? profile.master_prompt : "";
  const horizonPrompt = brief.trim();
  const canGenerate =
    mode === "influencer" ? masterPrompt.length > 0 : horizonPrompt.length > 0 && pose?.ref != null;

  const input = useMemo<GenerationInput>(() => {
    if (mode === "influencer") {
      return {
        model: "text2image_soul_v2",
        prompt: { instruction: masterPrompt },
        settings: {
          aspectRatio,
          quality: "1080p",
          batchSize: Number(count),
        },
      };
    }
    return {
      model: "gpt_image_2",
      prompt: {
        instruction:
          `${horizonPrompt}\n\nCreate one continuous product photograph. Preserve the uploaded product faithfully. No text, logo invention, collage, split screen, duplicate object, poster, UI or watermark.`,
      },
      ...(pose?.ref ? { media: { image: pose.ref } } : {}),
      settings: {
        aspectRatio,
        quality: "high",
        resolution: "2k",
        batchSize: Number(count),
      },
    };
  }, [aspectRatio, count, horizonPrompt, masterPrompt, mode, pose]);

  const cost = useQuery({
    ...costQueryOptions(jobClient, input, { enabled: canGenerate, scopeKey }),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const fresh = run.generations.filter((generation) => !prepended.current.has(generation.id));
    if (!fresh.length) return;
    for (const generation of fresh) prepended.current.add(generation.id);
    prependGenerations(queryClient, HISTORY_QUERY, fresh, { scopeKey });
    setActiveTab("history");
    run.reset();
  }, [queryClient, run, run.generations, scopeKey]);

  const selectPose = useCallback((selected: AssetSelection) => {
    const previousId = pose?.ref?.id;
    if (previousId && previousId !== selected.ref?.id) {
      releaseLocalUpload(previousId);
      setUploads((current) => current.filter((entry) => entry.ref?.id !== previousId));
    }
    setPose(selected);
  }, [pose]);

  const handleUpload = useCallback(async (file: File) => {
    const selected = await uploadAsset(file);
    const item = { ...selected, kind: "upload" as const, personal: true };
    setUploads((current) => [item, ...current.filter((entry) => entry.ref?.id !== item.ref?.id)]);
    selectPose(selected);
    return selected;
  }, [selectPose]);

  const requireSignIn = () => {
    const signInUrl = getSignInUrl(
      scopeKey,
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
    if (signInUrl) {
      setPendingSignInUrl(signInUrl);
      return false;
    }
    return true;
  };

  const clearInfluencerWorkspace = () => {
    releaseAllLocalUploads();
    setPose(null);
    setUploads([]);
    setProfile(null);
    prepended.current.clear();
    removeGenerationQueries(queryClient, { scopeKey });
    run.reset();
    setActiveTab("json");
  };

  const disconnectInfluencerAccount = async (reconnect: boolean) => {
    if (run.isRunning || profileBusy) {
      setMessage("처리 중에는 계정을 변경하거나 연결 해제할 수 없습니다.");
      return;
    }
    try {
      await disconnectHiggsfieldOAuth();
      clearInfluencerWorkspace();
      if (reconnect) {
        setPendingSignInUrl(
          getReconnectSignInUrl(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
          ),
        );
      } else {
        window.location.reload();
      }
    } catch {
      setMessage("Higgsfield 연결을 해제하지 못했습니다. 현재 작업은 그대로 유지됩니다.");
    }
  };

  const makeProfile = async () => {
    if (!pose || !requireSignIn()) return;
    setProfileBusy(true);
    setMessage("");
    const result = await composeInfluencerProfile({
      data: {
        gender,
        environment: selectedEnvironment?.label ?? environment,
        scene: selectedScene?.label ?? scene,
        imageType,
        poseMediaId: pose.ref?.id ?? "",
        referenceImageUrls: (selectedScene?.images ?? []).map(
          (path) => `${window.location.origin}${path}`,
        ),
      },
    });
    if (result.ok) {
      setProfile(result.profile as Record<string, unknown>);
      setMessage("JSON이 완성됐습니다. 검토 후 이미지를 생성하세요.");
    } else {
      setMessage(result.message);
    }
    setProfileBusy(false);
  };

  const handleGenerate = () => {
    if (!canGenerate || run.isRunning || !requireSignIn()) return;
    setMessage("");
    void savePreferences({
      data: { mode, gender, environment, scene, aspectRatio, imageType },
    });
    void run.start(input);
  };

  const downloadProfile = () => {
    if (!profile) return;
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `influencer-${gender}-${selectedEnvironment?.label ?? environment}-${selectedScene?.label ?? scene}.json`;
    anchor.click();
    window.requestAnimationFrame(() => URL.revokeObjectURL(url));
  };

  const selectedGender = CATALOG.genders.find((item) => item.id === gender) ?? CATALOG.genders[0]!;
  const selectedEnvironment =
    selectedGender.environments.find((item) => item.id === environment) ??
    selectedGender.environments[0];
  const selectedScene =
    selectedEnvironment?.scenes.find((item) => item.id === scene) ??
    selectedEnvironment?.scenes[0];

  if (mode === "horizon") {
    return <HorizonWorkspace parentBusy={run.isRunning || profileBusy} onParentWorkspaceReset={clearInfluencerWorkspace} onBack={() => setMode("influencer")} />;
  }

  return (
    <div className="flex h-dvh gap-5 overflow-hidden bg-q-background-primary px-4 py-3">
      <SignInModal
        open={pendingSignInUrl != null}
        signInUrl={pendingSignInUrl}
        onOpenChange={(open) => {
          if (!open) setPendingSignInUrl(null);
        }}
      />

      <aside
        className={card(
          { surface: "solid", elevation: "raised" },
          "w-85.5 shrink-0 gap-3 overflow-y-auto border-q-thin border-q-border-subtle p-3 [&>*]:shrink-0",
        )}
      >
        <div className="px-2 py-1">
          <Typography as="h1" variant="accent-sm-bold" color="brand" className="uppercase">
            Influencer Frame
          </Typography>
          <Typography as="p" variant="caption-xs-regular" color="secondary">
            GPT-5.6 Terra + Higgsfield
          </Typography>
        </div>

        <FieldSelect
          label="작업 모드"
          value={mode}
          options={[
            ["influencer", "인플루언서 콘텐츠"],
            ["horizon", "호리존 제품 이미지"],
          ]}
          onChange={(value) => {
            if (value === "horizon" && (run.isRunning || profileBusy)) {
              setMessage("생성 또는 JSON 작성 중에는 호리존 화면으로 이동할 수 없습니다.");
              return;
            }
            setMode(value as Mode);
            setMessage("");
          }}
        />

        {mode === "influencer" ? (
          <>
            <FieldSelect
              label="성별"
              value={gender}
              options={[
                ["male", "남자"],
                ["female", "여자"],
              ]}
              onChange={(value) => {
                const next = value as Gender;
                setGender(next);
                const nextGender =
                  CATALOG.genders.find((item) => item.id === next) ?? CATALOG.genders[0]!;
                const firstEnvironment = nextGender.environments[0]!;
                setEnvironment(firstEnvironment.id);
                setScene(firstEnvironment.scenes[0]!.id);
                setProfile(null);
              }}
            />
            <FieldSelect
              label="장소"
              value={environment}
              options={selectedGender.environments.map((item) => [item.id, item.label] as const)}
              onChange={(value) => {
                setEnvironment(value);
                const nextEnvironment = selectedGender.environments.find((item) => item.id === value);
                setScene(nextEnvironment?.scenes[0]?.id ?? "");
                setProfile(null);
              }}
            />
            <FieldSelect
              label="연출"
              value={scene}
              options={(selectedEnvironment?.scenes ?? []).map(
                (item) => [item.id, item.label] as const,
              )}
              onChange={(value) => {
                setScene(value);
                setProfile(null);
              }}
            />
          </>
        ) : (
          <Composer
            label="제품 연출 설명"
            placeholder="예: 모델 이미지는 유지하고 업로드한 의상만 자연스럽게 교체"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            required
          />
        )}

        <AssetLibraryModal
          items={uploads}
          pagination={pagination}
          onUpload={handleUpload}
          onSelect={selectPose}
          trigger={
            pose ? (
              <UploadField
                preview={pose.src}
                previewAlt={pose.name}
                previewType="image"
                onRemove={() => {
                  if (pose.ref?.id) {
                    releaseLocalUpload(pose.ref.id);
                    setUploads((current) => current.filter((entry) => entry.ref?.id !== pose.ref?.id));
                  }
                  setPose(null);
                  setProfile(null);
                }}
                className="grow-0"
              />
            ) : (
              <UploadField
                render={<button type="button" />}
                icon={Image}
                title={mode === "influencer" ? "포즈 이미지 추가" : "제품 또는 기준 이미지 추가"}
                subtitle="JPG, PNG · 20MB 이하"
                className="grow-0"
              />
            )
          }
        />

        {mode === "influencer" ? (
          <FieldSelect
            label="이미지 유형"
            value={imageType}
            options={IMAGE_TYPES}
            onChange={(value) => {
              setImageType(value);
              setProfile(null);
            }}
          />
        ) : null}
        <FieldSelect
          label="이미지 비율"
          value={aspectRatio}
          options={RATIOS}
          onChange={(value) => setAspectRatio(value as (typeof RATIOS)[number])}
        />
        <FieldSelect
          label="생성 장수"
          value={count}
          options={["1", "2", "3", "4"]}
          onChange={setCount}
        />

        {message ? (
          <Typography
            as="p"
            variant="caption-sm-regular"
            color={message.includes("완성") ? "success" : "danger"}
            className="px-1"
          >
            {message}
          </Typography>
        ) : null}
        {run.error ? (
          <Typography as="p" variant="caption-sm-regular" color="danger" className="px-1">
            {run.error.message}
          </Typography>
        ) : null}

        <RailFooter>
          <div className="grid gap-2">
            {mode === "influencer" ? (
              <Button
                variant="tertiary"
                size="md"
                className="w-full"
                disabled={!pose || profileBusy}
                onClick={() => void makeProfile()}
                start={profileBusy ? <Loader size="xs" color="neutral" /> : <Icon as={WandSparkles} />}
              >
                {profileBusy ? "JSON 만드는 중" : "GPT JSON 만들기"}
              </Button>
            ) : null}
            <Button
              variant="marketingPrimary"
              size="md"
              className="w-full"
              disabled={!canGenerate || run.isRunning}
              onClick={handleGenerate}
              end={
                run.isRunning ? (
                  <Loader size="xs" color="neutral" />
                ) : (
                  <span className="flex items-center gap-2">
                    <Sparkles width={14} height={14} />
                    <span>{cost.data?.credits ?? "—"}</span>
                  </span>
                )
              }
            >
              {run.isRunning ? "생성 요청 중" : "Higgsfield로 생성"}
            </Button>
            <div className="flex min-h-6 items-center justify-center gap-1">
              {resolvedScopeKey === undefined ? (
                <Typography as="span" variant="caption-xs-regular" color="secondary">
                  Higgsfield 연결 확인 중
                </Typography>
              ) : scopeKey === GUEST_SCOPE_KEY ? (
                <Button variant="ghost" size="xs" onClick={() => requireSignIn()}>
                  Higgsfield 계정 연결
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="xs" disabled={run.isRunning || profileBusy} onClick={() => void disconnectInfluencerAccount(true)}>
                    계정 변경
                  </Button>
                  <Button variant="ghost" size="xs" disabled={run.isRunning || profileBusy} onClick={() => void disconnectInfluencerAccount(false)}>
                    연결 해제
                  </Button>
                </>
              )}
            </div>
          </div>
        </RailFooter>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Tabs.Root
          variant="segmented"
          value={activeTab}
          onValueChange={(value) => setActiveTab(String(value))}
          className="flex! min-h-0 flex-1 flex-col gap-3"
        >
          <Tabs.List
            items={[
              { value: "json", label: "기획 JSON", start: <Icon as={WandSparkles} /> },
              { value: "history", label: "생성 결과", start: <Icon as={Plus} /> },
            ]}
          />
          <Tabs.Panel value="json" className="flex min-h-0 flex-1 flex-col pt-0">
            <ProfilePreview profile={profile} onDownload={downloadProfile} />
          </Tabs.Panel>
          <Tabs.Panel value="history" className="flex min-h-0 flex-1 flex-col pt-0">
            <Card surface="solid" className="min-h-0 flex-1 overflow-hidden p-4">
              {history.isPending ? (
                <div className="grid h-full place-items-center">
                  <Loader size="md" color="neutral" />
                </div>
              ) : (
                <Suspense fallback={<Loader size="md" color="neutral" />}>
                  <LazyUserGenerations
                    items={historyItems}
                    hasMore={history.hasNextPage === true}
                    loadingMore={history.isFetchingNextPage}
                    onLoadMore={history.fetchNextPage}
                  />
                </Suspense>
              )}
            </Card>
          </Tabs.Panel>
        </Tabs.Root>
      </section>
    </div>
  );
}
