# PHASE_NOTES — dashboard & register redesign

Running log for the 12-phase redesign in `design_handoff_redesign_12_phases/`
(`README.md` there is the spec, `CLAUDE_CODE_PROMPT.md` the phase plan). One entry per
phase: what changed, what was assumed, and a **Later** list for ideas that lost to a
locked decision. The consolidated Later list and the answers to README §5 land in the
Phase 12 entry.

---

## Phase 1 — Tokens and fonts (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `apps/web` only, no schema, no API.

### What changed

- **Fonts.** Public Sans (400–600), Archivo (500–700) and JetBrains Mono (400–500) are
  self-hosted variable woff2 files under `apps/web/public/fonts/` (latin + latin-ext,
  Google Fonts v21 / v25 / v24 slices), declared with `@font-face` in `globals.css`. Geist
  and Geist Mono are removed. Self-hosting rather than `next/font` keeps the existing
  pattern (no third-party stylesheet, register still has its type when the store is
  offline). Body is Public Sans 13px / 1.5; `h1`–`h4` are Archivo with tabular figures;
  `--font-mono` is JetBrains Mono. Type-scale classes `t-display-xl`, `t-display-l`,
  `t-heading`, `t-title`, `t-body`, `t-body-register`, `t-label`, `t-mono`, `t-mono-sm`
  mirror canvas 2d.
- **Colour.** `:root` now carries the README §1 ramp verbatim (`--bg #f6f5f2`,
  `--surface`, `--surface-2`, `--border`, `--border-strong`, `--text`, `--text-2`,
  `--muted`, `--faint`, `--accent #1e3a5f`, `--accent-soft`, `--accent-ink`) and the six
  status triplets as `--status-{draft|waiting|scheduled|fulfilled|cancelled|risk}-{fg|bg|border}`.
  `--destructive` aliases the risk red for the outlined destructive tier. Every legacy name
  (`--brand`, `--danger`, `--warn`, `--info`, `--success`, `--surface2`, `--text2`,
  `--border2`, `--neutral-soft`, …) is an alias onto the new ramp so the ~1,000 existing
  call sites pick it up unchanged. The Tailwind `@theme` block maps both the new names
  (`bg-surface-2`, `text-text-2`, `text-muted`, `border-border-strong`, `bg-accent-soft`,
  `text-status-risk`, `font-display`) and the legacy utilities still in the tree.
  The green oklch accent, the dark theme block and every hard-coded Tailwind hex in
  `globals.css` (alerts, password-strength bar, sonner override, auth radial gradients)
  are gone; those now read status tokens.
- **Radius.** `--radius-chip 3`, `--radius-input 3`, `--radius-control 3`,
  `--radius-button 5`, `--radius-card 5`, `--radius-sheet 0`; legacy `--radius` → 5 and
  `--radius-sm` → 3. Every `border-radius` in `globals.css` reads one of these (tables,
  table wraps and header corners are now square; pills/badges/kbd/count chips are 3;
  buttons, menus, dialogs, panels, KPI strips and the auth card are 5). Only bars (2px
  meters) and true circles (dots, avatars) keep literal values. No 9px remains.
- **Density.** Two presets as data attributes: `:root` / `[data-density="management"]`
  (row 36 · text 13 · control 30) and `[data-density="register"]` (row 44 · text 14 ·
  control 38 · hit target 44), exposed as `--row-h`, `--text-size`, `--control-h`,
  `--hit-target`; the legacy `--rowy` / `--pad` / `--kpi` derive from the preset. The
  register opts in on its root in Phase 4.
- **Focus.** Global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`
  with no radius; the four `outline: none` rules in `globals.css` and the two inline ones
  (command palette input, global search input) are removed. Inputs show the accent border
  on focus and `--border-strong` on hover instead of a box-shadow halo.
- **Motion.** `--motion 120ms ease-out`, `--motion-slide 160ms`. Under
  `prefers-reduced-motion: reduce` every animation and transition is 0 and the skeleton
  shimmer becomes a static two-tone bar.
- **Light mode only.** The per-user theme (light/dark) and density (cozy/compact)
  preferences are removed: `lib/ui-prefs.ts`, the root-layout bootstrap script, the
  Theme / Density segment in the account menu, and the `T` shortcut (and its row in the
  shortcuts dialog). Stored `jetnine.theme` / `jetnine.density` localStorage keys are
  simply ignored.
- **Primary and destructive buttons** now match the tier rule: primary is accent-filled
  (was ink-on-paper), destructive is outlined risk red on white (was grey-bordered).
  Active filter pills are accent-filled.
- **`/dev/tokens`** renders artboard 2d from the live CSS variables: type scale, neutral
  ramp, accent, destructive tier, six status chips with contrast ratios, spacing / radius /
  density / focus / motion, both density presets on a real row + control, and the skeleton.
  `apps/web/src/lib/design-tokens.ts` holds the same literals for code that has to name a
  token (Phase 2 StatusChip, print documents).
- The hand-off folder is checked in at `design_handoff_redesign_12_phases/` (excluded from
  prettier). The `.dc.html` files are references, not shipped routes.

### Assumptions

- "Self-host or next/font": self-hosted, for the offline register.
- Public Sans latin + latin-ext only (as Geist was); Vietnamese / Cyrillic / Greek slices
  are not bundled.
- The user-level density preference is retired in favour of the two surface presets;
  nothing in the spec keeps a per-user compact mode.
- `/dev/tokens` is a plain public route with `robots: noindex` — it has no data and no
  shell. Gate it behind an env flag if the owner prefers.

### Later

- Licensed grotesk (Söhne or similar) replacing Public Sans if the owner buys one (canvas
  2a note); the scale would not change.
- Once Phase 12 deletes the legacy aliases, the `@theme` block shrinks to the new names.
- Tailwind `rounded-*` utilities with off-scale radii still exist in ~13 TSX files (dashboard
  cards, team tasks, agency page); they are restyled with their screens in Phases 3–10.

---

## Phase 2 — Component kit (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` (restarted from `main` after the Phase 1 squash) ·
**Scope:** `apps/web` only. Every existing import of `@/components/ui` keeps working; the
single `ui.tsx` is now a `components/ui/` directory.

### What changed

- **Button** — four tiers to canvas 2e: primary (accent fill, 600), secondary (hairline),
  ghost (accent text), destructive (outlined risk red, 600, never filled). Height follows
  the density preset (`--control-h`), radius 5. `kbd="F8"` / `kbd="mod+k"` appends a
  shortcut chip. `variant="danger"` still works as the old name for destructive. `Button`,
  `Input` and `Select` forward refs so dialogs can name their initial focus.
- **Kbd** — platform-aware shortcut chip: `mod` renders ⌘ on a Mac and `Ctrl` on the
  Windows registers (`usePlatform`, `formatKeys`; server renders the Windows form and the
  client corrects after hydration). Chords (`g o`) keep their space; ⌘K does not.
- **Field** — label always visible, 12px / 500 / text-2; an error turns the label red and
  shows the message; hint is muted. `.input-mono` and `.input-num` for phone numbers, SKUs
  and money (mono, tabular, right-aligned).
- **Table** — `RowLink` (anchor in the first cell with an `::after` overlay so the whole
  row is clickable while the anchor takes focus; other controls in the row sit above it
  via `.row-action`) and `SortHeader` (`<th aria-sort>` around a button that inherits the
  header type; the indicator is drawn from `aria-sort`). Rows are `--row-h` tall with a
  `surface-2` hairline, hover `bg`, selected `accent-soft`; headers are 11px / 600 /
  uppercase / .05em.
- **StatusChip** — the six statuses from `design-tokens.ts`, glyph + word + colour with a
  1px border of the tint; Cancelled is struck. `StatusBadge` / `DisplayStatusBadge` keep
  their APIs and vocabularies but render the same anatomy: `.badge` now carries a glyph
  from its tone class (○ neutral · ◔ warning · ◷ info · ✓ success · ▲ danger · ◑ brand)
  and cancelled / refunded strings are struck on the neutral tint. The word is still the
  only text, so existing e2e text matchers hold.
- **Dialog** / **SlideOver** on a shared `useFocusTrap`: `role=dialog` (or `alertdialog`)
  with `aria-modal` and `aria-labelledby`, focus moves in on open (to `initialFocus`, else
  the first control), Tab and Shift+Tab cycle, Esc closes, focus returns to the opener.
  Dialog sizes 420 / 560 / 880 / 1080; title is Archivo 16px, description wired to
  `aria-describedby`. SlideOver is 640px from the right, 160ms, mono title option for
  document numbers. `ModalDialog` (3 callers) and `ConfirmDialog` (3 callers) are rebuilt on
  it — ConfirmDialog is now an `alertdialog` whose safe button has default focus and whose
  destructive action is outlined.
- **Toast** — sonner stays the API; the Toaster now runs 2.4s with hover-pause, and the
  CSS renders a white sheet with a hairline and a left rule in the status colour (no more
  `richColors`).
- **EmptyState** — dashed border, title, one action, no fill.
- **Skeleton → ErrorState** — `LoadingRows` keeps its 93 call sites unchanged and gains the
  4-second budget: past it the rows become `ErrorState` ("{what} is taking longer than it
  should", "Nothing you typed is lost…", Retry). `useLoadBudget` exposes the timer;
  `ErrorState` takes a title, a sentence, `onRetry`, and an optional `retryIn` countdown
  that auto-retries at zero.
- **Bare "Loading…" removed** where it was a state rather than a busy button label: the
  auth gate (now a shell-shaped skeleton with an `sr-only` status), the business switcher,
  four order read-dialogs, the attachments dialog, the warehouse home subtitle, and the two
  print documents.
- **`/dev/components`** shows every part in every state, including the register-density
  block, the dialog / alertdialog / slide-over, the four toast tones, and the live
  skeleton → error handoff with a Restart control.
- **Deleted legacy kit:** `.input-lg`, `.input-adorned`, `.modal-backdrop`, `.modal-panel`,
  `.modal-panel-lg`, `.subnav*` (no consumers). `vitest.config.ts` gained the `@/` alias so
  component tests resolve the kit.

### Assumptions

- Storybook is not added; `/dev/components` is the living gallery (the prompt allowed
  either).
- `LoadingRows` without `onRetry` still hands off to the error component at 4s (with the
  copy but no button) rather than shimmering forever; call sites gain a Retry as their
  screens are rebuilt in Phases 3–10.
- The legacy `.badge` tone → glyph mapping is mine (the spec defines glyphs only for the six
  order statuses); `brand` uses ◑ for "partly" states.

### Later

- The 13 remaining hand-rolled `role="dialog"` implementations (command palette, product
  search, notifications drawer, payment list, shift editor, order quick view, …) move onto
  `Dialog` / `SlideOver` with their screens (Phases 3, 5, 6, 9).
- `SortHeader` replaces the local `SortTh` in Orders and the header buttons in Products in
  Phases 6 and 7.

---

## Phase 3 — Shell, navigation, store context, palette, global states (2026-09-12)

**Branch:** `claude/new-session-q4kc7l` · **Scope:** `apps/web` shell plus one small audited
API endpoint. No schema change.

### What changed

- **Sidebar** (`components/shell/sidebar.tsx`, `nav.ts`) — brand block, Dashboard, then the
  five collapsible groups from README §2 with the exact items: Sell (New sale, Orders,
  Customers, Deliveries, At risk, My day) · After sale (Returns, Exchanges, Service, Special
  orders) · Stock (Products, Purchasing, Transfers, As-Is review, Gift cards) · Money (Sales,
  Shifts, Reports, Commissions, General ledger) · People & setup (Salespeople, Team tasks,
  Members & roles, Time clock, Settings). Only the current group is open; the group holding
  the current page opens on navigation and a manual choice is remembered per user in
  localStorage. Cashiers get the eight-link default (Sell / Stock / Money with "My drawer" /
  Me) and the owner's per-member `hiddenNav` still applies on top. Counts for Orders,
  Deliveries, At risk (nav-counts) and Team tasks (unread inbox) sit at the right in mono
  11px. 220px, 200px at ≤1280 via a media query on `--sidebar-width`. Footer: sync status
  (green "Synced · 9:41 AM", amber "Connecting…", red "Offline · retrying") and the
  shortcuts link with a `?` chip. The 15 pages that left the sidebar (Categories, Vendors,
  Roles, Locations, Audit log, …) remain in the palette's Go to list (`MORE_PAGES`).
- **Topbar** — order per README §2: **Acting for {Store}** chip (accent-soft, first control)
  → role switcher (owner only; a preview tool that lands on `/dashboard`) → search trigger
  with platform `Kbd` (⌘K / Ctrl K) → inbox with badge → New sale (primary, `N` chip) →
  account. The period picker, compare-to segment and store-scope dropdown left the shell:
  `DashboardControls` renders them at the top of every role home except My Day.
- **Store context** (`lib/acting-store.tsx`) — one provider for the store every sale, drawer
  and report belongs to. Selling-restricted members choose among their approved stores (a
  first-login picker when there is more than one, on `Dialog`); everyone else can switch
  among all locations, stores first. The choice persists under the existing
  `jetnine.sellingStore` session key so the register, the Orders list and the manager home
  follow it unchanged, and a `erp:acting-store` window event fires for screens that want to
  react live. Every switch calls `POST /v1/business/members/me/acting-store`, which validates
  the location (and the selling scope) and writes `membership.acting_store` to the audit log.
- **Command palette** — one input, groups Orders (orders + receipts) / Customers / Go to;
  first column is the mono identifier (order number, phone, chord); the search API already
  matches phone digits; footer `↑↓ ↵ esc` plus the `g o / g d / g p` chords. Built on the
  shared focus trap (`role=dialog`, Esc, focus return). `g p` now goes to Products; the older
  `g c / g r / g h / g i` chords still work and the shortcuts dialog lists them.
- **Global error** (`lib/api-status.ts`, `shell/shell-error.tsx`) — `api()` reports every
  network failure and 502/503/504; the shell then turns the sync dot red and renders the
  canvas-3d error above the page: names the draft (`setDraftSummary`, for the register in
  Phase 4) or the number of queued offline sales, says nothing is lost, auto-retries `/ready`
  with backoff (2s → 30s) and a visible "retrying in Ns · attempt N", and offers Retry now /
  Keep writing offline. Any successful call clears it.
- **Global loading** — the auth gate already renders a shell-shaped skeleton (Phase 2);
  `SyncStatus` shows "Connecting…" until the membership answers, and `/dev/shell` shows the
  canvas-3e layout (skeleton rows in final positions, elapsed seconds in the header).
- **Inbox drawers** (`personal-inbox.tsx`, `notifications-drawer.tsx`) moved onto `SlideOver`
  (focus trap, Esc, focus return) and the inbox's bare "Loading your inbox…" became skeleton
  rows with Retry. The legacy `.drawer` class is deleted.
- **`/dev/shell`** renders the frame with the real sidebar, topbar classes and error
  component on mock data, with Owner / Cashier and normal / loading / error toggles, so the
  chrome can be checked at 1440 and 1280 without a session.
- The theme-toggle shortcut row and the topbar business badge stayed where Phase 1 left them
  (the badge is the multi-business switcher; it now sits last, after the account).

### Assumptions

- "Team tasks" count = unread items in the member's inbox (tasks and notes for them); the
  nav-counts endpoint has no tasks figure and I did not widen it.
- Non-restricted members default to the first store alphabetically (warehouse last) when
  nothing is saved for the session; a manager writing for another store switches the chip.
- The dashboard keeps its own store-scope dropdown (now in the page, not the shell) until
  Phase 9 decides how the owner home relates to "Acting for". Removing it would leave the
  owner home unable to show the company.
- `/dev/shell` is a static preview; the live shell cannot render without a session in this
  environment, so 1440 / 1280 verification was done against the preview.

### Later

- Below 1280 the sidebar would collapse to icons (canvas 3b note); no register runs that
  narrow, so the existing mobile slide-over stays.
- The register publishes its draft summary to `setDraftSummary` in Phase 4 so the error
  names "SO-10441 (2 lines, $2,598.00)".
- Fold the business switcher into the account menu.
