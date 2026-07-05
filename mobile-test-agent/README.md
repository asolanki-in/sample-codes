# Mobile Test Automation Agent

A custom AI agent that executes plain-English mobile test steps on real
devices/emulators through **[appium-mcp](https://github.com/appium/appium-mcp)**
(the official Appium MCP server — no custom MCP server is written), with
**Ollama Cloud** as the LLM brain and **[Maestro](https://github.com/mobile-dev-inc/Maestro)**'s
reliability model as the execution philosophy.

```yaml
steps:
  - Tap ok continue
  - Enter username as hello
  - Enter pin as 7807283          # typos like "Entet" are tolerated
  - Enter date of birth as 01 01 1990
  - Tap on account number 1238735444
  - Verify account details is visible
```

Every step runs a **find → act → verify** loop: resolve the element from a
live UI snapshot, perform the action, then check an explicit postcondition
on a fresh snapshot — retrying with a recovery ladder until it passes or
the step budget is exhausted.

---

## 1. Agent landscape research (why this design)

| Agent / framework | Approach | Token cost | Reliability characteristics |
|---|---|---|---|
| **[Maestro](https://github.com/mobile-dev-inc/Maestro)** (~10.8k★) | Declarative YAML flows, no LLM at runtime | 0 | Best-in-class flakiness tolerance: auto-waiting, hierarchy polling, built-in retries. But steps must match exact selectors — no NL understanding. |
| **[DroidRun / mobilerun](https://github.com/droidrun/mobilerun)** | LLM plans every step from full screen state | ~3,225 tokens & ~$0.075 **per task** ([benchmark](https://aimultiple.com/mobile-ai-agent)) | Strongest autonomous agent in a 65-task benchmark — yet only **43% task success**. LLM-in-the-loop for every action is powerful but expensive and non-deterministic. |
| **[mobile-mcp](https://github.com/mobile-next/mobile-mcp)** | MCP server (accessibility-tree first) | depends on client | Good primitive layer; still needs an agent brain on top. |
| **[appium/appium-mcp](https://github.com/appium/appium-mcp)** | Official Appium MCP server | `NO_UI` mode saves 500–5000+ tokens/request | Rich toolset (gestures, W3C actions, set_value, optional `appium_ai` vision), locator-priority guidance, embedded UiAutomator2/XCUITest drivers. |
| AppAgent / Mobile-Agent (research) | Vision/screenshot per step | very high (images every step) | Impressive demos, weak repeatability for regression testing. |

**Conclusion:** pure-LLM agents (DroidRun-style) are reliable ~43–70% of the
time and burn thousands of tokens per task; pure-deterministic frameworks
(Maestro) are ~99%+ reliable and free but can't read human steps. This agent
takes the hybrid: **Maestro's deterministic engine with an LLM used only as
an escape hatch**, over the official appium-mcp toolset.

## 2. Architecture

```
 plain-English flow (yaml/txt)
        │
        ▼
 ┌──────────────┐  unparseable step   ┌──────────────────────┐
 │ grammar       │ ──────────────────► │ Ollama Cloud          │
 │ parser (0 tk) │                     │ structured JSON, t=0  │
 └──────┬───────┘                      └──────────────────────┘
        ▼ typed Command
 ┌──────────────┐  ambiguous match     ┌──────────────────────┐
 │ snapshot +    │ ───────────────────► │ LLM disambiguation    │
 │ fuzzy matcher │  (compact element    │ (~300 tk, rare)       │
 │ (0 tk)        │   table only)        └──────────────────────┘
 └──────┬───────┘
        ▼ element + coordinates
 ┌───────────────────────────────────────────────┐
 │ ACT  via appium-mcp (MCP stdio client)         │
 │  W3C pointer actions → gesture tool → locator  │
 ├───────────────────────────────────────────────┤
 │ VERIFY postcondition on fresh snapshot         │
 │  fail → recovery ladder → retry (≤3, ≤30s)     │
 └───────────────────────────────────────────────┘
```

### Maestro principles adopted

1. **Declarative command vocabulary** — steps compile to a closed set of
   typed commands (`tap`, `input`, `set_date`, `toggle`, `select`,
   `scroll`, `assert_visible`, …). Execution is always deterministic; the
   LLM never free-forms device actions.
2. **Auto-waiting, never `sleep()`** — before every find, the agent polls
   the page source until two consecutive snapshot hashes agree
   (UI idle), bounded by a timeout.
3. **Tolerance to flakiness** — every step gets a retry ladder: settle UI
   → hide keyboard → re-snapshot → re-find (scroll-to-find with
   end-of-list detection) → alternate action path (coordinates → native
   gesture → locator click → per-char key events).
4. **Coordinate taps from the live hierarchy** — like Maestro, actions
   target centers computed from the current tree, immune to stale-element
   and locator-drift errors.

### Why the token bill stays near zero

- The raw page source (20–100 KB XML) **never reaches the LLM**. It is
  distilled into an indexed table of interactive elements (~5–10% the size).
- Deterministic first: grammar parsing and fuzzy matching (exact text →
  content-desc → resource-id incl. **acronyms** like `date of birth` →
  `input_dob` → containment → token fuzzy → digit-run anchoring) resolve
  typical steps at **0 tokens**. The sample flow above costs 0 tokens.
- When the LLM is consulted, it answers through **structured outputs**
  (JSON schema, temperature 0) with a truncated element table — a few
  hundred tokens, not thousands.
- `NO_UI=true` is set for appium-mcp, trimming 500–5000 tokens of HTML
  from every tool response.
- `--no-llm` runs fully deterministic (CI-friendly, 0 tokens).

### Complex components handled

| Component | Strategy |
|---|---|
| **Date pickers** | Editable field → type the date in the order the field's own hint asks for (`mm/dd/yyyy` beats config). Android Material calendar → edit/pencil toggle first (found by locale-proof resource-id `mtrl_picker_header_toggle`, English content-desc as fallback; dialogs already in text mode are typed into directly), else year list scroll + month arrows + day cell (content-desc aware). Android spinner mode → type into the `NumberPicker`'s inner EditText, swipe-per-column fallback with value feedback. iOS wheels → direct `set_value` per `PickerWheel`. iOS inline/compact calendar (iOS 14+) → tap the "Month Year" header to flip into wheels and set them, chevron navigation fallback, day cell by accessibility label. Then auto-tap OK/Done and **verify the field shows the date**. |
| **Toggles / switches / checkboxes** | State-aware: reads `checked`, taps **only if needed**, re-reads to verify, one corrective retry. "Turn on X" when X is already on is a 0-action pass. |
| **Dropdowns / spinners / option lists** | Tap anchor → wait for options → scroll-to-find option → tap → verify selection visible. |
| **Secure fields (PIN/password)** | Auto-detected; verification accepts masked text instead of comparing literals. |
| **Long lists** | Scroll-to-find in both directions with end-of-list detection via snapshot hashing. |
| **Account rows by number** | Digit-run anchoring: `tap on account number 1238735444` can only match an element actually containing that number. |

### Failure-rate engineering (the 0.1% goal)

Reliability is multiplicative. Per step: deterministic resolution on a
settled UI (~99% first try) × 3 verified attempts with recovery between
them × alternate action paths. A step only *passes* when its postcondition
is observed — so silent no-ops (the classic flaky killer) become retries,
not downstream mystery failures. Steps whose effect is briefly
unobservable are reported `PASSED_UNVERIFIED` instead of masking risk.
Every run emits a JSON report with per-step status, attempts, timing, and
exact token usage, so reliability is measurable, not vibes.

## 3. Setup

```bash
cd mobile-test-agent
npm install
npm run build                          # tsc -> dist/

# appium-mcp prerequisites: Node 22+, JDK 8+, ANDROID_HOME (Android) / Xcode (iOS)
# The agent launches `npx -y appium-mcp@latest` itself over stdio.

export OLLAMA_API_KEY=...              # https://ollama.com/settings/keys
export AGENT_MODEL=gpt-oss:120b        # any Ollama Cloud model
# Local Ollama instead: export OLLAMA_HOST=http://localhost:11434
```

## 4. Usage

```bash
# parse a flow offline (shows which steps are deterministic)
npx tsx src/cli.ts dry-run flows/login_sample.yaml     # or: node dist/cli.js ...

# run on a device
node dist/cli.js run flows/login_sample.yaml \
    --platform android --caps caps.json --report report.json

# fully deterministic (0 LLM tokens)
node dist/cli.js run flows/login_sample.yaml --no-llm

# enable appium-mcp's vision fallback as the last resort
node dist/cli.js run flows/login_sample.yaml --vision

# see what tools your appium-mcp version exposes (for toolmap overrides)
node dist/cli.js list-tools

# offline test suite
npm test
```

`caps.json` example:

```json
{
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:appPackage": "com.mybank",
  "appium:appActivity": ".MainActivity"
}
```

## 5. Layout

```
src/
  parser.ts      # NL grammar -> typed commands (typo-tolerant, 0 tokens)
  snapshot.ts    # page-source XML -> compact element table + idle-hash
  matcher.ts     # deterministic element resolution (fuzzy, acronyms, digits)
  similarity.ts  # dependency-free Dice-bigram string similarity
  mcpClient.ts   # MCP stdio client for appium-mcp (+ toolmap overrides)
  actions.ts     # executors: taps, typing, date pickers, toggles, scrolls
  verify.ts      # per-command postconditions (the VERIFY in find-act-verify)
  agent.ts       # orchestrator: retry ladder + LLM escalation + reporting
  llm.ts         # Ollama Cloud client (structured outputs, token metering)
  config.ts      # all tunables (thresholds, timeouts, models, toolmap)
  cli.ts         # run | dry-run | list-tools
  index.ts       # library exports
tests/           # offline vitest suite: 18 tests, no device or network needed
flows/           # sample flow using the steps from the task description
```

## 6. Notes & limits

- appium-mcp tool names/schemas can drift between releases; the client
  resolves logical names against the live tool list and argument shapes
  are tried in fallback order. If a rename breaks resolution, map it in a
  copy of `toolmap.example.yaml` (`AGENT_TOOLMAP=...`) — no code changes.
- End-to-end behaviour on a real device should be validated once per
  appium-mcp version (`list-tools`, then run the sample flow).
- Sources: [Maestro](https://github.com/mobile-dev-inc/Maestro) ·
  [appium/appium-mcp](https://github.com/appium/appium-mcp) ·
  [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) ·
  [droidrun/mobilerun](https://github.com/droidrun/mobilerun) ·
  [AIMultiple mobile-AI-agent benchmark](https://aimultiple.com/mobile-ai-agent) ·
  [Ollama cloud API auth](https://docs.ollama.com/api/authentication)
