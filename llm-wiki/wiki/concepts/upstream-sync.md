# Upstream Sync

This page tracks selective synchronization from `friuns2/codexui` into this fork. Future agents should read this page before comparing upstream history so already-imported feature groups are not reprocessed.

Source snapshots:

- [2026-05-10 friuns2/codexui a26c4cc](../../raw/upstream-sync/2026-05-10-friuns2-a26c4cc.md)

## Current Sync Cursor

- Last synced upstream commit: `a26c4ccbef4212d0d816f391c075a253ac0ccfdc`
- Local result commit: `ef5af1945a81cd30abf9882edddc9235f593daaa`
- Local sync branch: `codex/upstream-sync-20260510-164819`
- Analysis merge-base: `3e1fa11286751e825bf87ea22cda636b3a7e4ac8`

For the next sync, fetch upstream and inspect only commits after the cursor:

```bash
git fetch upstream --prune
git log --reverse --no-merges a26c4ccbef4212d0d816f391c075a253ac0ccfdc..upstream/main
git diff --stat a26c4ccbef4212d0d816f391c075a253ac0ccfdc..upstream/main
```

## 2026-05-10 Sync Summary

Imported upstream feature groups:

- Selected skill chips: render on user messages, recover from session JSONL, and open local `SKILL.md`.
- Sidebar/thread list: lazy project Git status, projectless chat show-more compatibility, pinned thread pagination hydration.
- Thread automation: multiple automations per thread, schedule presets, `Run now`, immediate queue drain, readable automation prompt cards.
- Backend recovery: archive/delete recovery and loaded-sidebar pruning.
- Worktrees: persisted workspace roots for created worktrees with failure cleanup.
- Free/Zen proxy: unauthenticated OpenRouter/OpenCode Zen defaults and reasoning-content preservation for thinking/tool-call flows.
- Workflow/documentation: debug launcher hardening, performance audit notes, PR review-bot guidance, and wiki pages for imported features.

Preserved fork-specific behavior:

- Windows tray launcher and related files.
- FRP/public proxy support.
- Tunnel-safe local image URLs.
- Fork-local dev wrapper and Vite allowlist behavior.
- Existing paged historical thread hydration.
- Fork-specific test documentation history.

Skipped upstream history:

- Reverted project recency/mobile move-mode path.
- Reverted configurable Vite allowed-hosts path.
- File deletions that would remove this fork's Windows/FRP/public-proxy route.

Verification:

- `pnpm exec vue-tsc --noEmit`: passed.
- `pnpm run test:unit`: passed, 12 files and 63 tests.

## Operational Notes

- Prefer selective cherry-pick or file-level import by feature group.
- Do not use a direct upstream merge as the default.
- Treat `.agents/upstream-sync-state.json` as the machine-readable cursor for automation or future agent bootstrapping.
- If upstream deletes a file that only exists in this fork, verify whether the deletion is an upstream absence rather than an intended removal.
