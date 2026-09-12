# CLAUDE.md — Jetnine ERP

Multi-tenant browser-based POS / retail-operations SaaS (STORIS replacement,
GHL-style platform layer). Turborepo + pnpm monorepo, Node 22.

## Read order (do this before writing code)

0. **`HANDOFF.md`** — takeover brief: what is built, what is deployed, the two live
   threads, and the traps. Start here if you are new to this work.
1. **`SPRINT-STATUS.md`** — where the active sprint stands and what to do next. Keep it updated.
2. **`PLAN-POS-OPERATIONS.md`** — the active build spec: STORIS-modeled POS/operations
   modules (owner-confirmed decisions + amendments §0, 9-phase build order).
3. **`PLAN-STORIS-CUTOVER.md`** — the prior sprint spec: gap analysis, locked
   decisions D1–D10, data model, module/endpoint/UI surfaces, migration pipeline, schedule.
4. **`PLAN.md`** — the original locked architecture (tenancy, stack, conventions §10,
   permission model). Decisions in these docs are **locked**: change the doc first, then the code.
5. **`design_handoff_redesign_12_phases/README.md`** + **`PHASE_NOTES.md`** — the
   dashboard & register redesign (12 phases, `CLAUDE_CODE_PROMPT.md` in the same folder
   is the phase plan). Tokens, type, densities and copy there are final; `PHASE_NOTES.md`
   logs what each phase shipped and assumed.

`README.md` is a per-epic status log of Phases 0–2. Note its "Deployment (Phase 2.21 —
Vercel-only)" section is outdated: the API now deploys as a Docker service on Render
(`render.yaml`, `apps/api/Dockerfile`); the web app stays on Vercel.

## Layout

```
apps/api        NestJS backend — one module per domain (sales, catalog, inventory, …)
apps/web        Next.js 15 App Router — route groups: (auth) (business) (pos) (super-admin)
packages/db     Drizzle schema (src/schema/*.ts), migrations, seed, RLS helpers (with-context.ts)
packages/shared zod schemas, money helpers, permission catalog (src/permissions.ts), roles
packages/ui     shared React components;  packages/config  shared tsconfig/eslint
```

## Commands

`pnpm dev` · `pnpm build` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (Vitest) ·
`pnpm format` · `pnpm db:generate` (Drizzle migration from schema diff) · `pnpm db:migrate` ·
`pnpm db:seed` · `pnpm db:reset` (destructive). Local Postgres 16 + Redis 7 via
`docker compose up -d`. CI runs lint, typecheck, test, build, format-check, and a
**migration drift check** — always commit generated migrations with schema changes.

## Non-negotiable conventions

- **Money is integer cents** (`*_cents`), helpers in `packages/shared/src/money.ts`.
- **Every tenant table**: `business_id` FK + RLS policy + indexes, matching the style in
  `packages/db/src/schema/*.ts`. Platform-level tables (no `business_id`) are the exception.
- New endpoints: NestJS module pattern as in existing modules — zod DTOs from
  `packages/shared`, tenancy context, permission guards, audit-log writes, outbound
  webhook events on significant mutations.
- New permissions go in `packages/shared/src/permissions.ts` and get seeded into system roles.
- Derived money (e.g. order balance due) is computed, never stored.
- Legacy-imported records carry `imported_at` and are excluded from cash-drawer,
  commission accrual, and webhook emission (sprint decision D8).
- Git: feature branch per epic, squash-merge, CI green before merge. Conventional-ish
  messages (`feat(orders): …`). Never commit secrets; `.env.example` only.

## Sprint execution protocol

Each work session: read `SPRINT-STATUS.md`, take the first unchecked build item, build it as a
**vertical slice** (schema → migration → API + tests → UI → e2e where listed), then check the
box, add a dated note, and commit the tracker update with the work. If a decision must change,
edit `PLAN-STORIS-CUTOVER.md` in the same PR. Items marked **Ops** belong to the human — never
block on them silently; flag them in your summary.
