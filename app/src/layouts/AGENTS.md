# App layout — adapt the shipped code in place

<!-- shared:header:begin — keep identical across all templates (scripts/check-agents-sync.sh) -->

A `type: "app"` product must look and feel like a Higgsfield product. This
template ships ONE ready-made layout screen as REAL CODE, already wired as the
home page (`src/routes/index.tsx`). **Adapt it in place** — swap its inputs,
copy, media, and wiring for the product you are building; never rebuild the
screen from scratch, fork a new top-level structure, or swap layouts. Build a
custom shell only when the user asks for something the layout cannot cover.

**Adapt in place does NOT mean ship the demo.** The layout is only the UI
shell, filled with placeholder data and stub flows. The deliverable is the
USER'S product: replace the demo data and flows with complete, working
business logic — the app's actual features, state, generation wiring, and
persistence — so it does what the user asked end-to-end and serves them as
well as you can. A template that merely renders is not done.

Everything shared lives in **`../components/AGENTS.md`** — the mandatory
component contract (asset library, generation tiles, feeds, progressive
disclosure), the design invariants (dark theme, no app header, container
width, buttons, icons), and copy-paste wiring. Read it before editing. Backend
wiring (submit, poll, uploads): `app/packages/fnf-react/ai/AGENTS.md`.
<!-- shared:header:end -->

## The layout

| Layout     | File                                        | When to use                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Preset** | `src/layouts/preset.tsx` (`PresetTemplate`) | Pick-a-style-then-generate: a persistent left creation rail (cover/source, `@/components/composer`, `@/components/setting-trigger` rows, costed Generate) beside a browsable grid of preset tiles with Presets/History/How-it-works tabs + search. Preset tiles support horizontal (default) or vertical/portrait orientation via `presetOrientation`. |

## Preset-specific notes

- The creation rail is `InputPanel` in `preset.tsx` — its fields are CHOSEN
  PER APP within the field budget (`../components/AGENTS.md` rule 1); don't
  blindly copy the demo set.
- `PresetGallery` in `preset.tsx` renders the History tab through the
  canonical `UserGenerations` (rule 5); `HistoryGrid` is its deprecated alias.
- Pick the tile orientation that matches the app's output —
  `<PresetTemplate presetOrientation="vertical" />` for 9:16 apps (see
  "Preset tiles" in `../components/AGENTS.md`).
- The layout is prewired to the real fnf provider: live cost, submit/poll,
  multipart upload, asset refs, cache updates, and History feed. Adapt its model
  registry and typed settings for the requested product; do not replace these
  flows with local timers or fabricated results. Replace every `/presets/*`
  reference with user-provided or newly generated product media, delete
  `public/presets/`, and run `bun run check:adapted` before finishing.
- For this layout, preset covers are product-representing media. Generate or
  provide meaningful final covers; repeated generic thumbnails are not an
  acceptable style-picker shortcut unless the user explicitly requests a
  text-only/no-preview picker.
