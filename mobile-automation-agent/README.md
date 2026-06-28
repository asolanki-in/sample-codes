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
        ┌────────────────────────┐      LLM tool-use
        │      MobileAgent        │◄───────────────┐
        │  OBSERVE→PLAN→ACT→VERIFY│         Ollama Cloud / Anthropic
        └────────────┬───────────┘                │
                     │ MCP tool calls             │
                     ▼  (streamable HTTP)          │
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
- **Record & deterministic replay** — capture an AI run as a replay file, then
  re-run it with no LLM/tokens and full verification. AI authors, a deterministic
  engine runs it in CI. See [Record once, replay forever](#record-once-ai-replay-forever).
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
- An **LLM provider key**: an **Ollama Cloud** key (default,
  [ollama.com](https://ollama.com)) or an **Anthropic** key
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
# LLM (Ollama Cloud by default)
LLM_PROVIDER=ollama
OLLAMA_API_KEY=...                    # from https://ollama.com
OLLAMA_MODEL=qwen3-coder:480b-cloud   # any cloud model with tool calling

# Device
PLATFORM=android
ANDROID_HOME=/path/to/android/sdk     # Android only
APP_PACKAGE=com.example.app           # optional; can live in the flow instead
APP_ACTIVITY=.MainActivity
```

CLI flags override `.env`.

### LLM providers

The agent is provider-neutral (see [`src/llm/`](src/llm)). Pick one:

- **Ollama Cloud (default)** — set `LLM_PROVIDER=ollama`, `OLLAMA_API_KEY`, and an
  `OLLAMA_MODEL` that supports **tool calling** (e.g. `qwen3-coder:480b-cloud`,
  `gpt-oss:120b`, `deepseek-v3.1:671b`). Self-hosted Ollama works too — point
  `OLLAMA_HOST` at it. Vision is off by default (the text UI snapshot is the
  primary grounding); enable `OLLAMA_VISION=true` only with a vision+tools model.
- **Anthropic / Claude** — set `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and
  optionally `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`). Supports vision.

Override per run with `--provider` and `--model`.

> Tool calling is required. Whichever model you pick must support it, or the
> agent can't drive the device.

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

## Parallel device execution

Run the same flow on many devices at once:

```bash
mobile-agent parallel flows/signup.flow.yaml \
  --device emulator-5554 --device emulator-5556 --device emulator-5558 \
  --concurrency 3 \
  --report-dir runs/reports --artifacts-dir runs/artifacts
```

Each device gets a **fully isolated** run: its own appium-mcp process on its own
port (`MCP_HTTP_PORT + index`), its own session pinned by `udid`, its own
`DeviceController` and LLM provider. `--concurrency` caps how many run at once;
the process exits non-zero if any device fails.

**How much can it handle?** There's no hard limit in this code — runs are
async/I/O-bound, so a single Node process can drive many concurrently. The real
ceilings are external:

1. **Devices/emulators** — the host's RAM/CPU (an Android emulator wants ~2 GB +
   a core, and KVM). This is usually the binding constraint locally; device
   farms scale to dozens.
2. **LLM rate limits** — every device is an independent agent loop making many
   model calls. At high fan-out the provider's rate/concurrency limit, not the
   devices, becomes the bottleneck. Use `--concurrency` to stay under it.
3. **adb/host throughput** — many simultaneous sessions add ADB and CPU load.

Rule of thumb: a beefy CI host comfortably runs ~4–8 emulators; **replay** mode
(no LLM) parallelizes far wider since limit #2 disappears — which is the cheap
way to fan out in CI:

```bash
mobile-agent parallel flows/signup.flow.yaml --device d1 --device d2 ... # author once
# then replay per device with no LLM (script around `replay`, or run replays in parallel)
```

> Note: parallel autostart allocates ports per device. If you attach to existing
> appium-mcp servers (`MCP_AUTOSTART=false`), give each its own server/port.

## Record once (AI), replay forever (deterministic)

The agent is great for *authoring* a flow, but you don't want to pay an LLM — or
tolerate its variance — every CI run. So a run can **record** the exact resolved
actions, and `replay` re-executes them with **no LLM and no tokens**:

```bash
# 1. Author with the agent, capturing a replay recording + evidence
mobile-agent run flows/signup.flow.yaml --record signup.replay.json --artifacts runs/signup

# 2. Re-run it deterministically (CI) — no API key needed for the LLM
mobile-agent replay signup.replay.json --report runs/ci.json
```

- The recording stores each step's **resolved actions** — reliable actions
  (`tap{text:"Continue"}`, `input_text`, `toggle`, …) keep their *queries*, so on
  replay they **re-resolve and re-verify** against the live screen (robust to
  minor layout shifts), not brittle absolute coordinates. Raw appium calls are
  recorded too, except UUID-bound ones (session-scoped) which can't replay.
- Replay keeps all the reliability guarantees: settle, tolerant match,
  verify-and-retry, and your `expect` assertions are re-checked. A step that the
  recording couldn't capture deterministically is flagged and skipped with a
  warning rather than silently passing.
- This is the "AI authors, deterministic engine runs" model that Maestro,
  agent-device and finalrun converge on — fast, free, and stable in CI.

## Evidence / artifacts

`--artifacts <dir>` writes, for every step, a screenshot
(`step-<n>-<status>.png`) plus the JSON `report.json` and a `replay.json`, so a
failed run leaves something an engineer can actually inspect.

## How actions are verified

The agent is **not** trusted blindly. Verification happens at three layers:

1. **Per-action post-conditions (deterministic, in code).**
   - `tap` — settles the UI and compares the view hierarchy before/after; if
     nothing changed it retries, and the result reports whether the UI actually
     changed.
   - `input_text` — reads the field value back after typing and **fails** if the
     expected text didn't land (alphanumeric, case-insensitive comparison;
     password fields are reported as unverifiable). No more "typed into the void".
   - `toggle` — re-reads the switch/checkbox state and confirms it matches the
     requested state.
   - `assert_visible` / `scroll_until_visible` — poll the real hierarchy for the
     element; they are verifiers by definition.

2. **Author-declared step assertions (deterministic, authoritative).** A step can
   declare post-conditions that the **runner** checks after the agent finishes —
   independent of what the agent claimed. If they fail, the step fails:

   ```yaml
   - text: Tap on Continue
     expect:
       visible: Username          # must be on screen afterwards
       notVisible: Error message  # must not be
   ```

   `visible` / `notVisible` accept a string (matched by text) or
   `{ text | id | accessibilityId }`, and a single value or a list.

3. **Agent self-report (lowest trust).** The model ends each step with
   `report_step_result`. This is the weakest signal and is **overridden** by the
   checks above — a step the model calls "success" still fails if its `expect`
   assertions or an `input_text` read-back fail.

So: trust deterministic post-conditions and your `expect` assertions; the agent's
own verdict is only the fallback when you haven't declared anything to check.

> Tip: add `expect` to the steps whose outcome matters (login succeeded, screen
> changed). That converts a flow from "the agent thinks it worked" into a real,
> repeatable test.

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

**Unlabeled fields & relative selectors.** A common hard case is an editable
field with no text/id of its own and a static label above it (e.g. a
"Date of Birth" label over an empty `EditText`). Element geometry is kept
internally (bounding boxes, stripped from the model payload) so:

- `input_text{ into: { text: "Date of Birth" }, text: "01/01/1990" }` automatically
  resolves to the editable field **directly below** that label — even with
  several stacked unlabeled fields.
- Relative anchors `below` / `above` / `leftOf` / `rightOf` (Maestro-style) are
  available on `tap` and `input_text` to disambiguate, e.g.
  `input_text{ into: { below: { text: "Last Name" } }, text: "Smith" }`.

**Dates from a plain instruction.** The user only says *"Enter date of birth as
01 01 1990"*; the agent parses it (day/month/year, 4-digit group = year) and
performs the multi-step picker interaction — typing into a date field, or
driving an Android calendar/spinner or iOS wheel — per the date-picker playbook.

## Project layout

```
src/
  index.ts              CLI (commander)
  config.ts             env config, zod-validated
  logger.ts             dependency-free structured logger
  types.ts              shared domain types
  mcp/appiumClient.ts   appium-mcp transport client (httpStream/stdio) + results
  mcp/uiSnapshot.ts     page-source XML -> compact JSON with precomputed locators
  llm/
    types.ts            provider-neutral LLM types (messages, tools, provider)
    provider.ts         factory: picks Ollama / Anthropic from config
    ollamaProvider.ts   Ollama Cloud (native tool calling)
    anthropicProvider.ts Anthropic / Claude (Messages API)
    toolAdapter.ts      neutral tool defs + MCP result -> message parts
  agent/
    agent.ts            the observe/plan/act/verify/finish loop
    device.ts           Maestro-style reliability: settle, match, verify, retry
    prompts.ts          system prompt + interaction playbooks
  runner/
    flowRunner.ts       orchestration: AI run + record, and deterministic replay
    parallelRunner.ts   multi-device concurrency (isolated config per device)
    session.ts          deterministic capabilities + session lifecycle
    flowParser.ts       YAML/JSON/text/inline flow + replay-file loading
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
