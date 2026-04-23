# What To Test

## Codex.app-Style Integrated Terminal

### Prerequisites
- Run the dev server at `http://127.0.0.1:4173`.
- Open an existing local or worktree thread with a valid working directory.

### Core Flow
1. Click the terminal button in the top-right thread header.
2. Confirm the terminal drawer opens below the composer.
3. Press `Cmd+J` on macOS or `Ctrl+J` elsewhere.
4. Confirm the drawer toggles closed/open and the header button pressed state updates.
5. Type `pwd` and press Enter.
6. Confirm the printed path matches the thread/project working directory.
7. Type `echo terminal-ok` and press Enter.
8. Confirm `terminal-ok` appears in the terminal output.
9. Choose `npm run dev` from the `Run...` quick-command menu.
10. Confirm the command is submitted to the active terminal.
11. Choose `Add command...` from the `Run...` menu.
12. Enter a custom command in the prompt and confirm it runs immediately.

### New Chat Flow
1. Open the new-chat screen.
2. Choose or confirm a working folder.
3. Click the terminal button in the top-right header.
4. Confirm the terminal opens below the new-chat composer before a thread exists.
5. Run `pwd` and confirm it matches the selected folder.

### Snapshot API
1. With the terminal session still running, request:
   `/codex-api/thread-terminal-snapshot?threadId=<thread-id>`
2. Confirm the response includes `session.cwd`, `session.shell`, `session.buffer`, and `session.truncated`.
3. Confirm `session.buffer` contains `terminal-ok`.

### Session Behavior
1. Hide the terminal, then reopen it.
2. Confirm recent output is restored.
3. Refresh the browser and reopen the same thread.
4. Confirm the terminal can reattach and continue accepting input.
5. Use the `Run...` menu several times.
6. Confirm only the five most-used/recent commands are shown before `Add command...`.
7. Click `New`.
8. Confirm a second terminal tab appears and becomes active.
9. Click the first terminal tab.
10. Confirm its previous output is restored.
11. Click `Close`.
12. Confirm the active PTY exits and the drawer hides only when the last tab is closed.

### Layout
1. Resize the desktop browser window.
2. Confirm the prompt is not clipped and the terminal refits.
3. Repeat at `375x812` and `768x1024`.
4. Confirm there is no horizontal page overflow and the terminal remains usable.

### Expected Result
- Terminal behavior matches Codex.app-style integrated terminal basics: per-thread terminal, project-scoped cwd, header toggle, keyboard shortcut, recent output buffer, and readable snapshot endpoint.
- Quick-command menu submits common project commands to the active terminal without replacing the session.
- Custom quick commands are added via the `Run...` menu prompt and sorted by most-used/recent history.

## Realtime Chat Rendering And Sync Performance

### Prerequisites
- Run the dev server at `http://127.0.0.1:4173`.
- Ensure the TestChat project exists at `/Users/igor/temp/TestChat`.
- Install dependencies with `pnpm install`.
- Optional but useful: open browser devtools Network panel filtered to `/codex-api/rpc`.

### Realtime Profiler
1. Run `TESTCHAT_PROFILE_LABEL=manual node scripts/profile-testchat-realtime.cjs`.
2. Wait for the TestChat turn to finish creating the temporary todo app.
3. Confirm the script prints `cleanupOk: true`.
4. Confirm no `/Users/igor/temp/TestChat/todo-render-profile-*` directory remains.
5. Open the generated JSON report under `output/playwright/testchat-realtime-manual-*.json`.
6. Confirm the report includes `longTaskSummary`, `frameDeltaSummary`, `over50msFrameCount`, screenshot path, and trace path.
7. Open the generated trace with `npx playwright show-trace output/playwright/testchat-realtime-manual-*-trace.zip`.

### Rendering Behavior
1. In TestChat, send a message that produces mixed markdown while streaming.
2. Watch the active assistant row during streaming.
3. Confirm older visible messages do not visibly flicker or reflow while new text streams.
4. Confirm code blocks still render escaped/plain before highlighter load and highlighted after highlighter load.
5. Confirm markdown images still render, and failed image loads fall back to the original markdown text.

### File-Link Regression
1. Ensure `/Users/igor/temp/TestChat/qwe.txt` exists.
2. Send:
   `FILE_LINK_RENDER_CACHE_MANUAL [qwe.txt](/Users/igor/temp/TestChat/qwe.txt) with **bold** and \`code\``
3. Inspect the rendered row.
4. Confirm there is one `a.message-file-link`.
5. Confirm the link href contains `/codex-local-browse/Users/igor/temp/TestChat/qwe.txt`.
6. Confirm the link title is `/Users/igor/temp/TestChat/qwe.txt`.
7. Confirm visible link text is `qwe.txt`.
8. Confirm bold text and inline code render in the same row.

### Sync Churn
1. Start a TestChat turn that streams assistant text and performs file changes.
2. Watch `/codex-api/rpc` requests during the active turn.
3. Confirm high-frequency `item/*` streaming events do not trigger repeated `thread/list` reloads.
4. Confirm live assistant text, command output, and file-change updates still appear while the turn is running.
5. Confirm reconciliation still happens around structural events such as turn start/completion.
6. If the sidebar has more than one page of threads, confirm background pagination waits while a turn is active and resumes after all active turns complete.

### Expected Result
- Streaming remains smooth, with unchanged chat rows avoiding repeated markdown parse/highlight work.
- The profiler completes with cleanup enabled and no persistent temporary todo app directory.
- Markdown file links, bold text, inline code, code blocks, and markdown image fallback behavior still work.
- Thread list/message refreshes are bounded during streaming instead of firing for every realtime item event.
