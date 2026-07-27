# Preset app scaffold contract

This is a starting scaffold, not a finished demo. Adapt the existing preset
layout into the user's product and finish the real flow end to end. A page that
only renders, uses shipped media, or simulates generation is incomplete.

## Read before editing

1. Read `src/layouts/AGENTS.md` before changing the screen.
2. Read `src/components/AGENTS.md` before composing UI or wiring media.
3. For generation, uploads, profile data, or history, read
   `packages/fnf/ai/AGENTS.md` and `packages/fnf-react/ai/AGENTS.md`.
4. For Quanta APIs, read `packages/quanta/ai/AGENTS.md`. Do not modify vendored
   packages to work around an app-level issue.

## Definition of done

The adapted app must satisfy all of these:

- It uses the shipped `PresetTemplate` structure, adapted in place.
- Product copy, fields, presets, costs, states, and metadata describe the
  user's app rather than this scaffold.
- Every product-representing image or video is user-provided, generated for
  this app, or produced by the live app. No shipped `/presets/*` media, repeated
  stand-in image, stock hotlink, CSS mock artwork, emoji artwork, or fabricated
  generation/history item remains.
- Upload, selection, Generate, loading, success, error, retry, History, and
  download/use-result behavior are real. No timeout-based fake generation.
- `bun run check:adapted`, `bun run typecheck`, `bun run lint`, and
  `bun run build` all pass. Do not weaken checks, add `any`, or add
  `@ts-ignore`/`@ts-expect-error` to force a pass.

## Asset policy — mandatory

Use this order:

1. Use assets supplied by the user when they fit the requested role.
2. Otherwise use the available image-generation tool to create bespoke,
   on-brand media at the aspect ratio used by the component.
3. Save build-time assets under a meaningful path such as
   `public/assets/presets/<name>.webp`; use stable names and useful alt text.
4. Runtime generations may use the durable URLs returned by the generation
   backend.

Do not substitute placeholder services, random web images, gradients, blank
boxes, or reused scaffold art when image generation is unavailable. Explain
the missing tool/asset to the user instead. Icons are the exception: use
Lucide through Quanta's `Icon`, as required by the component contract.

Before finishing, remove `public/presets/` and run:

```bash
bun run check:adapted
```

That check intentionally fails in the untouched scaffold. It catches explicit
demo mode, shipped preset references, common placeholder hosts, simulated
product behavior, and leftover demo files.

## Real data and generation wiring

- Preserve the prewired browser/server boundary: `src/lib/fnf.browser.ts`
  exposes the browser-safe adapter, `src/lib/fnf.functions.ts` validates RPC
  inputs, and `src/lib/fnf.server.ts` is the only place that constructs the
  Workflow Platform adapter.
- Keep generation approval in `src/lib/generation-approval.ts`: pass the exact
  `jobSetType` and `params` to the host-injected
  `window.hf.requestGeneration(...)`, then return its token to the fnf submit.
  Never use `window.confirm` or add a second security modal. An `AbortError` is
  user cancellation; a missing host API or any other failure must stay visible.
- Keep the app publicly viewable under the `guest` scope. Do not gate the root
  on authentication. A guest Generate click navigates through
  `/__auth/login?return=<current path>`; authenticated Generate reaches
  `requestGeneration(...)` for approval before the backend submit.
- The root route already mounts `FnfProvider` with a stable adapter, model
  registry, and user/workspace scope. Every FNF query key, run controller, and
  cache write must preserve that scope. Adapt the registry when the product
  changes models; do not create SDK clients inline in components.
- `AssetLibraryModal` live mode requires `items`, `onUpload`, `onSelect`, and
  tab-specific `pagination`. It virtualizes loaded cards and auto-pages only
  the unfiltered All scope; filtered views keep an explicit Load/Search more
  control. Upload through multipart `FormData` to a same-origin server route
  that calls `media.upload`. Submit `item.ref`, never `item.src`.
- `UserGenerations` live mode requires `items`. Map actual fnf generations with
  `src/lib/higgsfield-generation-results.ts`; never render seeded gallery data.
- The Generate CTA must submit the selected preset, prompt, settings, and
  durable media refs through the fnf client. Drive its disabled/loading state
  and credits from the real request/cost state.
- Generated apps keep `createWorkflowPlatformAdapter` server-side against
  `https://fnf.internal`. Browser code calls app-local server functions or API
  routes; never expose tokens, user ids, workspace headers, or internal URLs.
- Persist data only when the product needs it. If D1/R2/KV is required, update
  `app.manifest.json`, bindings, and migrations together.

## Adaptation map

| Concern                               | Starting point                                    |
| ------------------------------------- | ------------------------------------------------- |
| Home route                            | `src/routes/index.tsx`                            |
| Preset rail, cards, tabs, and CTA     | `src/layouts/preset.tsx`                          |
| User uploads and generation picker    | `src/components/asset-library.tsx`                |
| Personal generation history           | `src/components/user-generations/`                |
| Generation result mapping             | `src/lib/higgsfield-generation-results.ts`        |
| Browser-safe fnf adapter              | `src/lib/fnf.browser.ts`                          |
| Validated fnf server functions        | `src/lib/fnf.functions.ts`                        |
| Server-only Workflow Platform adapter | `src/lib/fnf.server.ts`                           |
| Multipart media upload                | `src/routes/api/media/upload.ts`                  |
| Page/marketplace metadata             | `src/app-meta.json`                               |
| Resource bindings                     | `app.manifest.json`, `src/lib/bindings.server.ts` |

## TypeScript and route safety

- Keep strict TypeScript. Prefer inferred types and exported SDK/component
  types; use `import type` for type-only imports.
- Preserve server/client boundaries. Server-only code belongs in
  `*.server.ts` or a TanStack server handler. Do not access `window`,
  `document`, or browser storage during SSR render or at module scope.
- TanStack Start routes live in `src/routes`. Never edit
  `src/routeTree.gen.ts`; `bun run typecheck` regenerates it.
- Reuse existing components and SDK helpers before adding abstractions or
  dependencies. Do not add another UI library.
- Comments should explain a non-obvious constraint or boundary. Delete demo
  commentary once the corresponding demo implementation is gone.

## Required behavior checks

Exercise these cases, not only the happy path:

- Generate with valid inputs and with required input missing.
- Upload success, upload failure, generation failure, retry, and user cancel.
- Empty History and populated History using only the current user's data.
- Direct page load under SSR with no browser-global crash.
- Keyboard access, visible focus, useful alt text, and reduced-motion behavior.
- Narrow viewport/overflow behavior without adding host-owned app chrome.
