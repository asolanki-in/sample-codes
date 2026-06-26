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
                     ▼                                       │
        ┌────────────────────────┐                          │
        │   appium-mcp (stdio)    │──────────────────────────┘
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

## Project layout

```
src/
  index.ts              CLI (commander)
  config.ts             env config, zod-validated
  logger.ts             dependency-free structured logger
  types.ts              shared domain types
  mcp/appiumClient.ts   appium-mcp stdio client wrapper + result normalisation
  llm/toolAdapter.ts    MCP tools <-> Anthropic tool-use; result conversion
  agent/
    agent.ts            the observe/plan/act/verify/finish loop
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
  over a single stdio process, and lets the agent pick up new tools without code
  changes — the same integration model mobilerun uses with its Portal tools.
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
