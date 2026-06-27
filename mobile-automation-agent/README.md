# Mobile Automation Agent

A production-ready **TypeScript** mobile automation agent. You describe an
end-to-end flow in plain English; the agent drives a real Android/iOS device to
execute it.

```
Tap on Continue
Enter username as hello
Enter date of birth
Tap new button
Tap on close
Go back
Toggle switch of activity
```

It is inspired by [mobilerun](https://github.com/droidrun/mobilerun) (an LLM
agent that controls phones via natural language) but reimplemented in TypeScript
on top of the [**appium-mcp**](https://github.com/appium/appium-mcp) server, so
it works against the full Appium ecosystem (UiAutomator2 / XCUITest, emulators,
simulators, and real devices).

## How it works

```
            natural-language steps
                     │
                     ▼
        ┌────────────────────────┐      Claude tool-use
        │      MobileAgent        │◄────────────────────────┐
        │  OBSERVE→PLAN→ACT→VERIFY│                          │
        └────────────┬───────────┘                          │
                     │ MCP tool calls                 Anthropic API
                     ▼  (streamable HTTP)                    │
        ┌────────────────────────┐                          │
        │  appium-mcp (httpStream)│──────────────────────────┘
        └────────────┬───────────┘
                     │ WebDriver
                     ▼
              Android / iOS device
```

- **Deterministic scaffold** — session creation, capabilities and teardown are
  built in code (not left to the LLM) for repeatability.
- **LLM for the fuzzy part** — each step runs a bounded
  *observe → plan → act → verify → finish* loop. The agent calls appium-mcp
  tools (`appium_find_element`, `appium_gesture`, `appium_set_value`,
  `appium_get_page_source`, `appium_screenshot`, …) until it reports the step
  done.
- **Streamable HTTP transport** — the agent talks to appium-mcp over
  `httpStream` (FastMCP's streamable-HTTP), not stdio. The server can be
  auto-spawned locally (`appium-mcp --httpStream --port=8080`, endpoint `/sse`)
  or you can attach to a shared/remote server via `MCP_HTTP_URL`. Set
  `MCP_TRANSPORT=stdio` to fall back to stdio.
- **Maestro-style reliability layer** — high-level tools (`tap`, `input_text`,
  `assert_visible`, `scroll_until_visible`, `toggle`, `back`) wrap every
  interaction in deterministic robustness, so stability doesn't depend on the
  model: (1) **wait-for-settle** — poll the view hierarchy until it stops
  changing before observing/acting (no `sleep`s); (2) **implicit wait** — poll
  for the target element to appear before failing; (3) **tolerant matching** —
  case-insensitive exact→prefix→substring over text/accessibility/id; (4)
  **verify-and-retry** — after a tap, confirm the hierarchy actually changed and
  retry if it didn't. See [`src/agent/device.ts`](src/agent/device.ts). The raw
  `appium_*` tools stay available for the rest (date-picker wheels, swipes,
  alerts, app lifecycle).
- **Compact UI snapshot for element finding** — instead of dumping raw,
  truncated page-source XML at the model, the agent parses it once and hands the
  model a small JSON list of only the *actionable* elements, each with a
  **precomputed, prioritised locator** (`by: {strategy, selector}`), a tap-point
  (`c: [x,y]`), and compact `state` flags. This cuts tokens dramatically and
  makes locating elements deterministic — the model uses the locator we already
  derived (accessibility id > resource-id/name > text/predicate > xpath) rather
  than guessing. Exposed as the `inspect_screen` tool and auto-attached at the
  start of each step. See [`src/mcp/uiSnapshot.ts`](src/mcp/uiSnapshot.ts).
- **Tools are discovered dynamically** from appium-mcp, so new server
  capabilities are available automatically.
- **Vision** — a screenshot is attached at the start of every step; older
  screenshots are pruned from history to keep context (and cost) bounded.
- **Built-in playbooks** for the tricky cases: date pickers (Android calendar &
  spinner, iOS wheels), toggles/switches (state-aware — only taps when needed),
  back navigation, dropdowns, scrolling to off-screen elements, and system
  alerts. See [`src/agent/prompts.ts`](src/agent/prompts.ts).

## Prerequisites

- **Node.js ≥ 20** (22+ recommended)
- An **Anthropic API key**
- A working **Appium** mobile setup, as required by `appium-mcp`:
  - Android: JDK, Android SDK (`ANDROID_HOME`), an emulator or USB device
  - iOS: macOS, Xcode, simulators
- `npx` available on `PATH` (used to launch `appium-mcp@latest`)

## Install

```bash
cd mobile-automation-agent
npm install
cp .env.example .env   # then edit .env
npm run build
```

## Configure

Set values in `.env` (see [`.env.example`](.env.example) for the full list). The
essentials:

```bash
ANTHROPIC_API_KEY=sk-ant-...
PLATFORM=android
ANDROID_HOME=/path/to/android/sdk     # Android only
APP_PACKAGE=com.example.app           # optional; can live in the flow instead
APP_ACTIVITY=.MainActivity
```

CLI flags override `.env`.

## Run

```bash
# From a structured flow file
npm run dev -- run flows/example.flow.yaml

# From a plain-text flow (one step per line)
npm run dev -- run flows/quickstart.txt

# Inline steps, no file
npm run dev -- run \
  --step "Tap on Continue" \
  --step "Enter username as hello" \
  --step "Enter date of birth" \
  --step "Toggle switch of activity" \
  --step "Go back"

# Built binary
node dist/index.js run flows/example.flow.yaml --report reports/run.json
```

Useful flags: `--platform`, `--device`, `--app-package`, `--bundle-id`,
`--model`, `--max-iterations`, `--report <path>`, `--no-vision`,
`--keep-session`, `--continue-on-failure`, `--dry-run`.

Exit code is `0` when the flow passes, `1` when any required step fails, `2` on
configuration/flow errors — convenient for CI.

## Transport (httpStream)

The agent connects to appium-mcp over **streamable HTTP** by default.

- **Auto-spawn (default):** with `MCP_AUTOSTART=true` the agent launches
  `npx appium-mcp@latest --httpStream --port=<MCP_HTTP_PORT>` and connects to
  `http://<host>:<port>/sse`, retrying until the server is ready
  (`MCP_CONNECT_TIMEOUT_MS`). It also stops the server on exit.
- **Attach to a running server:** start it yourself —
  `npx appium-mcp@latest --httpStream --port=8080` — then set
  `MCP_AUTOSTART=false` and `MCP_HTTP_URL=http://127.0.0.1:8080/sse` (handy for a
  shared device host or a containerised Appium grid). Extra headers (e.g. auth)
  go in `MCP_HTTP_HEADERS` as JSON.
- **stdio fallback:** set `MCP_TRANSPORT=stdio` to spawn appium-mcp and speak
  over its stdio instead.

## Flow formats

**YAML / JSON** (structured):

```yaml
name: signup
platform: android
app:
  appPackage: com.example.app
  appActivity: .MainActivity
steps:
  - Tap on Continue                 # shorthand string step
  - text: Enter username as hello   # object step with options
    retries: 1
  - text: Tap on close
    optional: true                  # failure won't abort the flow
```

**Plain text** (`.txt`): one natural-language step per line; `#` lines and blank
lines are ignored.

## Element finding

How the agent locates things on screen, in order of preference:

1. **Compact UI snapshot** (`inspect_screen`, also auto-attached each step).
   The raw page-source XML is parsed into JSON containing only actionable
   elements. Each entry looks like:

   ```json
   {"ref":3,"role":"Button","text":"Continue","acc":"Continue",
    "state":"clickable","c":[540,650],
    "by":{"strategy":"accessibility id","selector":"Continue"}}
   ```

   The `by` locator is computed with the recommended priority
   (**accessibility id → resource-id/name → text/predicate → xpath**), so the
   model just reuses it via `appium_find_element` instead of inventing a
   selector. `state` exposes flags (e.g. `checked`) so toggles are handled by
   reading state, not guessing. `c` gives a center point for coordinate taps
   when no stable locator exists. Pure layout containers and invisible nodes are
   dropped, and the list is capped — keeping the payload small (often a fraction
   of the raw XML's tokens).

2. **Screenshot (vision)** — attached for visual grounding/disambiguation.

3. **Raw `appium_get_page_source`** — available as a fallback for the rare
   attributes the snapshot omits (e.g. inspecting picker-wheel internals).

Both Android (UiAutomator2) and iOS (XCUITest) trees are supported.

## Project layout

```
src/
  index.ts              CLI (commander)
  config.ts             env config, zod-validated
  logger.ts             dependency-free structured logger
  types.ts              shared domain types
  mcp/appiumClient.ts   appium-mcp transport client (httpStream/stdio) + results
  mcp/uiSnapshot.ts     page-source XML -> compact JSON with precomputed locators
  llm/toolAdapter.ts    MCP tools <-> Anthropic tool-use; result conversion
  agent/
    agent.ts            the observe/plan/act/verify/finish loop
    device.ts           Maestro-style reliability: settle, match, verify, retry
    prompts.ts          system prompt + interaction playbooks
  runner/
    flowRunner.ts       orchestration: connect → session → steps → report
    session.ts          deterministic capabilities + session lifecycle
    flowParser.ts       YAML/JSON/text/inline flow loading
    report.ts           console summary + JSON report
flows/                  example flows
```

## Design notes & trade-offs

- **Why appium-mcp instead of driving WebdriverIO directly?** It gives a stable,
  well-tested tool surface (gestures, alerts, app lifecycle, clipboard, etc.)
  over a streamable-HTTP server, and lets the agent pick up new tools without
  code changes — the same integration model mobilerun uses with its Portal
  tools. HTTP transport also makes it easy to run the device host separately
  from the agent (containers, CI, a shared Appium grid).
- **Context control.** Page-source XML is truncated and all but the last couple
  of screenshots are dropped from history, so long flows don't blow the context
  window or run away on cost.
- **Bounded loops.** Each step has an iteration budget (`MAX_STEP_ITERATIONS`)
  and the agent is told never to repeat a failing action more than twice — it
  changes strategy instead.
- **Resilience.** Tool errors are returned to the model as `tool_result`
  errors (not thrown), so it can recover; sessions are always torn down in a
  `finally` block.
- **Determinism where it matters.** Session/capability setup is code, not LLM,
  so runs are reproducible.

## Limitations

- Requires a functioning Appium environment; this project does not install
  Appium drivers or SDKs for you.
- The agent is non-deterministic by nature — use `retries`, `optional`, and a
  capable model for flaky or complex screens.
- Tool names assume the current `appium-mcp` surface
  (`appium_find_element`, `appium_gesture`, `appium_set_value`,
  `appium_session_management`, …). If the server renames tools, update
  `src/runner/session.ts` and the playbooks in `src/agent/prompts.ts`; the agent
  loop itself discovers tools dynamically.

## License

MIT
