# Improvements

Planned improvements for `claude-code-session-summarizer`, ranked by value-for-effort.
Based on the current code: a global Claude Code hook (`tools/feature-logger/`)
that writes per-session JSON, and a Next.js dashboard (`src/`) that reads it.

## High value, low effort

### 1. Add tests for the pure functions
There are zero tests. The riskiest logic is pure and trivially testable:
- `parseTranscript` / `classify` / `isRealPrompt` / `slugForCwd` in `tools/feature-logger/feature-logger.mjs`
- `estimateCostUsd` in `src/lib/pricing.ts`
- record validation + cost rollup in `src/lib/featureLog.ts`

A handful of fixture transcripts (`.jsonl`) plus `node --test` would lock in
behavior before any refactor. Highest priority — everything below is safer with
this in place.

### 2. Fix model-name matching in pricing
`PRICING` (`src/lib/pricing.ts:13`) is keyed on bare names (`claude-opus-4-8`),
but transcripts emit dated IDs like `claude-sonnet-4-6-20260...`. Those miss the
table and silently fall back to **Opus-tier** pricing (`FALLBACK` at line 21),
so Sonnet/Haiku sessions are over-billed in the estimate.
Fix: normalize the model string (strip date suffix / `[1m]` / `us.anthropic.`
prefix) before lookup, or match by prefix.

### 3. Fix the stale "kept in sync" comment
The comment at `feature-logger.mjs:18` references `src/lib/claudeCode.ts`, which
no longer exists — there's no second copy to drift from. No extraction needed
(YAGNI); just correct the comment so it stops implying a phantom duplicate.

## Medium value

### 4. Cache / incrementalize the dashboard read
`readFeatureRecords` (`src/lib/featureLog.ts:48`) re-reads and re-parses **every**
JSON file in the tree on every request (`page.tsx` is `force-dynamic`). Fine for
a few sessions, O(n) disk + Zod parse per page load otherwise. Options:
- cache by file `mtime`, only re-parse changed files, or
- read concurrently (`Promise.all`) instead of the sequential `await` loop.

### 5. Live refresh
Dashboard is SSR-only — a finished session doesn't appear until manual reload.
Add a small client poll (or a `revalidate` + refresh button). Native platform
feature: a `<meta http-equiv="refresh">` or `router.refresh()` on an interval
beats pulling in a websocket lib.

### 6. Filter / group by project — ✅ already done
`FeatureDashboard.tsx` already renders a project `<select>` and filters. No work.

### 7. Handle `schemaVersion` on read — deferred (YAGNI)
`recordSchema` uses `z.number()`, so it already accepts any `schemaVersion`.
The only real risk (a future v2 adding required fields and dropping v1 records)
doesn't exist until there's a v2. Revisit when the schema actually bumps.

## Lower priority / nice-to-have

### 8. Uninstall script
`install.mjs` merges into global `~/.claude/settings.json`. Ship the matching
uninstall (it already backs up — reuse that) so users can cleanly remove the hook.

### 9. Secrets in stored prompts
`userPrompts` are stored raw (capped at 300 chars) and shown in the dashboard.
A pasted token/key would be persisted to disk and displayed. Consider a basic
redaction pass (`sk-...`, `ghp_...`, `AKIA...`) before write.

### 10. Surface real `claude -p` cost
The SessionEnd summary records its own `summaryCostUsd` separately from the
token-based estimate. Show both (or a combined total) so the dashboard reflects
the one real LLM call the tool makes.

### 11. Empty / error states — ✅ already done
`FeatureDashboard.tsx` already renders an empty state with the install hint.

## Suggested order
1 (tests) → 2, 3 (correctness) → 4, 5 (UX/perf) → the rest as needed.

Start with #1 — without it every refactor below is a guess.

---

## What was done (2026-06-25)

All 11 items addressed in one pass. Test-driven where there was real logic
(failing test first, then implementation).

**Implemented:**

| # | Change | Files |
|---|--------|-------|
| 1 | 20 unit tests via `node --test` (zero deps); `npm test` script | `src/lib/pricing.test.ts`, `src/lib/featureTypes.test.ts`, `tools/feature-logger/feature-logger.test.mjs`, `tools/feature-logger/uninstall.test.mjs` |
| 2 | `normalizeModel` — strips date suffix / `us.anthropic.` prefix / `[1m]` tag, then prefix-matches; dated Sonnet/Haiku ids now price correctly instead of falling back to Opus | `src/lib/pricing.ts` |
| 3 | Fixed stale comment referencing the deleted `claudeCode.ts` | `tools/feature-logger/feature-logger.mjs` |
| 4 | Read record files concurrently (`Promise.all`); extracted pure `recordFromJson` | `src/lib/featureLog.ts` |
| 5 | `AutoRefresh` — client poll (`router.refresh()` every 30s) so finished sessions appear without manual reload | `src/components/AutoRefresh.tsx`, `src/app/page.tsx` |
| 8 | `uninstall.mjs` — strips our hooks from `settings.json` (backs up first), removes the script dir, leaves captured records | `tools/feature-logger/uninstall.mjs` |
| 9 | `redactSecrets` — masks sk-/ghp_/AKIA/JWT shapes in stored prompts before they hit disk/UI | `tools/feature-logger/feature-logger.mjs` |
| 10 | Surface the actual `claude -p` summary cost (`summaryCostUsd`) alongside the token estimate | `src/components/FeatureItem.tsx` |
| — | Show the model name per session (`shortModel`) in the meta line | `src/lib/format.ts`, `src/components/FeatureItem.tsx` |

Hook pure functions (`classify`, `isRealPrompt`, `slugForCwd`, `redactSecrets`)
and `uninstall`'s `stripOurHooks` were exported, with an entry guard so the
files only run their `main()` when invoked directly — not when imported by tests.

**Not implemented (deliberate):**
- **#6, #11** — already present in `FeatureDashboard.tsx` (project filter, empty state).
- **#7** — deferred (YAGNI): schema is `z.number()`, already version-tolerant; migration code waits for a real v2.
- No dedicated `featureLog` unit test — its extensionless imports don't resolve under bare `node --test`; covered by the Next build + the pricing/featureTypes tests.

**Verification:** `npm test` 20/20 pass · `npm run lint` clean · `npm run build` ✓ (types pass).

Working tree only — not committed.
