# Tests

This file tracks manual regression and feature verification steps.

## Template

### Feature: <name>

#### Prerequisites
- <required setup>

#### Steps
1. <action>
2. <action>

#### Expected Results
- <result>

#### Rollback/Cleanup
- <cleanup action, if any>

### Feature: Telegram bot token stored in dedicated global file

#### Prerequisites
- App server is running from this repository.
- A valid Telegram bot token is available.
- Access to `~/.codex/` on the host machine.

#### Steps
1. In the app UI, open Telegram connection and submit a bot token.
2. Verify file `~/.codex/telegram-bridge.json` exists.
3. Open `~/.codex/telegram-bridge.json` and confirm it contains a `botToken` field.
4. Restart the app server and call Telegram status endpoint from UI to confirm it still reports configured.

#### Expected Results
- Telegram token is persisted in `~/.codex/telegram-bridge.json`.
- Telegram bridge remains configured after restart.

#### Rollback/Cleanup
- Remove `~/.codex/telegram-bridge.json` to clear saved Telegram token.

### Feature: Telegram chatIds persisted for bot DM sending

#### Prerequisites
- App server is running from this repository.
- Telegram bot already configured in the app.
- Access to `~/.codex/telegram-bridge.json`.

#### Steps
1. Send `/start` to the Telegram bot from your DM.
2. Wait for the app to process the update, then open `~/.codex/telegram-bridge.json`.
3. Confirm `chatIds` contains your DM chat id as the first element.
4. In the app, reconnect Telegram bot with the same token.
5. Re-open `~/.codex/telegram-bridge.json` and confirm `chatIds` remains present.

#### Expected Results
- `chatIds` is written after Telegram DM activity.
- `chatIds` persists across bot reconfiguration.
- `botToken` and `chatIds` are both present in `~/.codex/telegram-bridge.json`.

#### Rollback/Cleanup
- Remove `chatIds` or delete `~/.codex/telegram-bridge.json` to clear persisted chat targets.

### Feature: ACP Bridge with Gemini CLI

#### Prerequisites
- `gemini` CLI is installed and available in PATH (`gemini --version`).
- Valid Gemini API credentials configured (e.g. `GOOGLE_API_KEY` or logged in via `gemini auth login`).
- App built or running in dev mode.

#### Steps — Dev mode with Gemini
1. Start the dev server with Gemini agent: `CODEXUI_AGENT=gemini npm run dev`
2. Open `http://localhost:5173` in a browser.
3. Verify the app loads without errors.
4. Click "New Chat" or equivalent — a new session should be created.
5. Type a simple prompt like "What is 2+2?" and press Enter.
6. Observe:
   - A `turn/started` notification appears (thread shows as in-progress).
   - Streamed agent response chunks render in real-time.
   - When complete, a `turn/completed` notification fires and the thread shows idle.
7. Type another prompt in the same thread — verify multi-turn works.

#### Expected Results
- Session is created via ACP `session/new` with `gemini --acp` subprocess.
- Prompts are sent via ACP `session/prompt`.
- `session/update` notifications with `agent_message_chunk` are mapped to live agent messages in the UI.
- `session/update` with `tool_call` / `tool_call_update` render as command execution cards.
- `session/request_permission` requests are auto-accepted (no approval UI shown).
- Thread list populates with in-memory sessions.
- Thread title is set from first prompt text or agent-provided `session_info_update`.

#### Rollback/Cleanup
- Stop the dev server.
- No persistent state is created by the ACP bridge (sessions are in-memory only).

### Feature: ACP Bridge with --agent CLI flag

#### Prerequisites
- CLI is built (`npm run build:cli`).
- `gemini` CLI installed and configured.

#### Steps
1. Run: `node dist-cli/index.js --agent gemini --no-tunnel --no-open -p 5999`
2. Verify console output shows: `[agent] Using ACP agent: gemini (gemini --acp)`
3. Open `http://localhost:5999` in a browser.
4. Create a new chat and send a prompt — verify it works as in the dev mode test above.
5. Verify that Codex CLI install/login is skipped when `--agent gemini` is used.

#### Expected Results
- `--agent` flag correctly selects ACP bridge instead of Codex app-server bridge.
- Codex CLI setup (install, login) is skipped.
- All chat functionality works through the ACP bridge.

#### Rollback/Cleanup
- Stop the server.

### Feature: ACP Bridge with Claude agent

#### Prerequisites
- Node.js with npx available.
- Valid Anthropic API key.

#### Steps
1. Run: `CODEXUI_AGENT=claude npm run dev`
2. Verify the bridge spawns `npx -y @anthropic-ai/claude-code --acp`.
3. Create a new chat and send a prompt.
4. Verify streamed responses appear.

#### Expected Results
- Claude ACP agent is spawned and communicates via ACP protocol.
- Same UI behavior as Gemini agent.

#### Rollback/Cleanup
- Stop the dev server.

### Feature: ACP auto-accept permissions (yolo mode)

#### Prerequisites
- ACP agent (gemini or claude) running with the bridge.

#### Steps
1. Start with `CODEXUI_AGENT=gemini npm run dev`.
2. Send a prompt that triggers a tool call requiring permission (e.g. "Create a file called test.txt with hello world").
3. Observe the agent proceeds without showing a permission approval UI.
4. Check terminal/console — the bridge should log `server/request/resolved` with `mode: auto-accept`.

#### Expected Results
- `session/request_permission` requests are intercepted by the bridge.
- Bridge responds automatically with `allow_always` (or `allow_once` if not available).
- No permission approval card is shown in the UI.
- Agent proceeds with the tool call immediately.

#### Rollback/Cleanup
- Stop the dev server.
- Remove any files created by the agent during testing.

### Feature: CODEXUI_AGENT environment variable

#### Prerequisites
- `gemini` CLI installed.

#### Steps
1. Set env: `export CODEXUI_AGENT=gemini`
2. Run: `npm run dev`
3. Verify dev server uses ACP bridge (check terminal output or browser behavior).
4. Unset env: `unset CODEXUI_AGENT`
5. Run: `npm run dev`
6. Verify dev server uses Codex app-server bridge (default behavior).

#### Expected Results
- `CODEXUI_AGENT` env var selects ACP bridge when set to a non-codex value.
- When unset or set to "codex", the app uses the default Codex app-server bridge.

#### Rollback/Cleanup
- Stop dev servers. Unset `CODEXUI_AGENT` if still set.
