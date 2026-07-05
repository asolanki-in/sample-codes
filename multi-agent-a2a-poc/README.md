# Multi-Agent A2A Protocol PoC

Three independent Node.js/TypeScript microservices that talk to each other with the
**A2A (Agent2Agent) protocol v1.0**, implemented **by hand** — no LangChain, no CrewAI,
no A2A SDK, no LLM SDK. The agent loop, the JSON-RPC protocol layer, and every
guardrail are plain, readable code, because the point of this repo is to show the
underlying mechanics.

The LLM backend is the **Ollama chat API** called with raw `fetch` — works against
Ollama cloud (`https://ollama.com`) or a local Ollama server.

```
                 ┌────────────────────────────────────┐
  user           │  MAIN AGENT :4000                  │
  POST /task ───>│  (orchestrator, no tools)          │
  POST /automation  A2A client + server, file-backed  │
  GET  /automation/:id  task store (survives restarts)│
                 └──┬──────────┬─────────┬─────────┬──┘
       message/send │          │         │         │  message/send (async)
       (blocking)   v          v         v         v  + tasks/get polling
        ┌───────────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐
        │ EXECUTOR :4001│ │ VERIFIER │ │ MOBILE │ │ BROWSER │
        │ ReAct loop +  │ │ :4002    │ │ :4003  │ │ :4004   │
        │ 3 mock tools  │ │ LLM judge│ │ 20-step│ │ 15-step │
        └──────┬────────┘ └────┬─────┘ │ mock UI│ │ mock web│
               │               │       │ + OTP  │ │ + 2FA   │
               └─> Ollama API <┘       │ pause  │ │ pause   │
                (raw fetch, no SDK)    └────────┘ └─────────┘
                                       long-running, persistent,
                                       resume-after-crash (no LLM)
```

## Layout

```
multi-agent-a2a-poc/
├── main-agent/src/index.ts       # orchestrator: A2A client + server, retry logic
├── executor-agent/src/index.ts   # ReAct loop with iteration/token guards
├── executor-agent/src/tools.ts   # tool registry + allowlist (mocked tools)
├── verifier-agent/src/index.ts   # LLM-as-judge with enforced JSON schema
├── mobile-agent/src/index.ts     # long-running mobile automation (mock, OTP pause)
├── browser-agent/src/index.ts    # long-running browser automation (mock, 2FA pause)
├── shared/
│   ├── types.ts                  # A2A Task/Message/AgentCard + JSON-RPC envelope
│   ├── a2a-client.ts             # card discovery, message/send, timeout+retry
│   ├── jsonrpc-server.ts         # JSON-RPC endpoint plumbing, error objects
│   ├── task-store.ts             # Map + state machine, optional file persistence
│   ├── automation-agent.ts       # long-running agent factory (steps, pause, resume)
│   ├── guardrails.ts             # Zod validation, injection scan, rate limiter
│   ├── llm.ts                    # raw fetch to {OLLAMA_HOST}/api/chat
│   └── audit.ts                  # jsonl audit logger
├── scripts/
│   ├── mock-llm.mjs              # scripted Ollama mock (for keyless testing)
│   └── smoke.mjs                 # end-to-end smoke test: npm run smoke
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## Running it

### 1. Configure the LLM backend

```bash
cp .env.example .env
# put your key from https://ollama.com/settings/keys into OLLAMA_API_KEY
```

Any cloud model with tool-calling works (`gpt-oss:120b` is the default; `qwen3-coder:480b`
also works). For a **local** Ollama instead, set `OLLAMA_HOST=http://host.docker.internal:11434`
(or `http://localhost:11434` when running without docker) and leave the key empty.

### 2a. Docker (recommended)

```bash
docker compose up --build
```

### 2b. Or locally, three terminals

```bash
npm install
npm run start:executor   # :4001
npm run start:verifier   # :4002
npm run start:main       # :4000  (discovers the other two at startup)
```

### 3. Send a task

```bash
curl -s -X POST http://localhost:4000/task \
  -H 'content-type: application/json' \
  -d '{"task": "Find out what OS kernel the demo host is running and report it."}' | jq .
```

Sample response (from a real run):

```json
{
  "taskId": "62e282d7-963d-4fbe-a1aa-495788b54533",
  "contextId": "1e3b7b79-9733-42a9-9bf2-20dff2513d5b",
  "state": "completed",
  "answer": "The host runs: Linux poc-host 6.8.0-mock #1 SMP x86_64 GNU/Linux",
  "verified": true,
  "attempts": [
    {
      "attempt": 1,
      "executorTaskId": "714c7a2a-...",
      "executorState": "completed",
      "output": "The host runs: Linux poc-host 6.8.0-mock ...",
      "verifierTaskId": "db125a65-...",
      "verdict": { "pass": false, "reason": "Output does not mention the kernel version.", "confidence": 0.85 }
    },
    {
      "attempt": 2,
      "executorTaskId": "7c9f280f-...",
      "executorState": "completed",
      "output": "The host runs: Linux poc-host 6.8.0-mock ...",
      "verifierTaskId": "97b1cf20-...",
      "verdict": { "pass": true, "reason": "Output now includes the kernel details requested.", "confidence": 0.92 }
    }
  ],
  "injectionFlagged": false,
  "injectionMatches": []
}
```

Note the `attempts` array: attempt 1 was rejected by the verifier, so the orchestrator
retried the executor **once** with the verifier's reason appended to the task text, and
attempt 2 passed. That whole negotiation happened over A2A `message/send` calls.

## Smoke test — no API key needed

```bash
npm install
npm run smoke
```

This boots a **scripted mock** of the Ollama chat API (`scripts/mock-llm.mjs`) plus all
three agents, then asserts the full flow end to end: the happy path (including the
verifier-forced retry), the scope-gate refusal, schema-mismatch 400s, the injection
flag, raw JSON-RPC `tasks/get` / error codes, the 429 rate limit, and that the
allowlist/scope/injection events all landed in the audit log. The mock deliberately
requests a disallowed tool (`delete_everything`) and fails the first verification so
those guardrail paths are exercised on every run. Exit code 0 = all green.

## The A2A protocol surface (identical on all three agents)

| Endpoint | What it is |
|---|---|
| `GET /.well-known/agent-card.json` | Static agent card: name, url, skills, input/output modes, capabilities, auth |
| `POST /` | JSON-RPC 2.0 endpoint: `message/send`, `tasks/get` |
| `POST /task` | *(main-agent only)* human-friendly entry point |

Discovery: at startup the main agent fetches both sub-agents' cards **once**, caches
them, and uses the `url` field each card declares for all subsequent `message/send`
calls — it never hardcodes where a skill lives beyond the initial card URL.

Try the raw protocol yourself:

```bash
# talk A2A directly to the executor
curl -s -X POST http://localhost:4001/ -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": {
    "kind": "message", "role": "user", "messageId": "m-1",
    "parts": [{ "kind": "text", "text": "What Node version does package.json require?" }]
  }}}' | jq .result.status.state

# poll any task later by id
curl -s -X POST http://localhost:4001/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<taskId>"}}' | jq .

# errors are standard JSON-RPC error objects — no stack traces on the wire
# {"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"Task not found: nope"}}
```

Tasks live in a `Map` keyed by uuid (file-backed via `DATA_DIR`, so they survive
restarts) and follow the A2A state machine (`shared/task-store.ts` throws on illegal
transitions):

```
submitted ──> working ──> completed | failed
     │         ^   └────> input-required ──┐  (paused for the user; a message/send
     │         └───────────────────────────┘   with the same taskId resumes it)
     └──────> rejected   (scope gate refused the task before any work started)
```

## Walkthrough of one end-to-end request

What happens for the `POST /task` above, and **where each guardrail fires**:

1. **`main-agent` receives `POST /task`**
   - *Guardrail — rate limit*: token bucket (10 req/min) checked first → `429` when empty.
   - *Guardrail — input validation*: body parsed by Zod (`{task: string}`) → `400 {"error":"Invalid request body", issues:[...]}` on mismatch.
   - *Guardrail — prompt-injection scan*: raw task text is scanned for patterns like
     "ignore previous instructions" / role overrides. Matches are **logged and flagged**
     (surfaced as `injectionFlagged` in the response) but the text is *not* silently
     modified — stripping would hide the attack from downstream auditing.
   - A local task is created in `submitted` state.
   - *Guardrail — task-scope gate*: the orchestrator only accepts work its two
     sub-agents can actually do. A JSON-constrained LLM classification call decides
     `{in_scope, reason}` against the capability list **derived from the cached agent
     cards** (so it tracks what the sub-agents really advertise). The verdict is
     Zod-validated with one correction retry, and the gate **fails closed** — if the
     classifier is unreachable or returns garbage twice, the task is refused.
     Out-of-scope ⇒ the task goes `submitted → rejected`, the executor is never
     called, and the caller gets HTTP `422` with an explicit refusal:

     ```json
     {
       "state": "rejected",
       "answer": "I can only handle tasks my sub-agents support: gathering system/file/web information via the executor's tools (run_shell_command, read_file, web_lookup) and verifying its output. This request is outside that scope: This requires creative writing or real-world actions, not system/file/web lookup.",
       "rejected": true,
       "attempts": []
     }
     ```
   - In-scope ⇒ the task moves to `working` and orchestration begins.

2. **`main-agent` → `executor-agent`: `message/send`** (using the cached agent card's url)
   - *Guardrail — timeout + retry*: the HTTP call aborts after **15s**; one retry on
     transport failure (JSON-RPC *error responses* are not retried — the remote already answered).
   - *Guardrail — audit log*: the call is appended to `logs/main-agent.jsonl`
     (from, to, taskId, latency, input/output summaries).

3. **`executor-agent` runs its ReAct loop**
   - Envelope + params re-validated with Zod; injection scan runs again on the inbound
     text (sub-agents don't trust callers).
   - Loop: raw `fetch` to Ollama `/api/chat` with the tool definitions → model returns
     `tool_calls` → *Guardrail — tool allowlist*: each `tool_call.name` is checked
     against a `Set` built from the registry. An unknown tool (a hallucinated
     `delete_everything`, say) is **never executed**; the model gets back
     `Error: tool '...' is not in the allowlist` and the rejection is audit-logged.
   - Tool args are Zod-validated, the (mocked) tool runs, the result is fed back as a
     `role:"tool"` message, and the loop repeats.
   - *Guardrail — max iterations*: hard cap of **5** loop turns.
   - *Guardrail — max tokens*: running total (prompt+completion) capped at **20k**.
     Either cap ⇒ task transitions to `failed` with an explanatory status message.
   - On success the answer becomes a task **artifact** and the task completes; the full
     task object is the JSON-RPC `result`.

4. **`main-agent` → `verifier-agent`: `message/send`** with `{"task": ..., "output": ...}`.

5. **`verifier-agent` judges the output** — no tools, one LLM call
   - The payload is Zod-validated before the LLM sees it.
   - The LLM call is constrained to JSON (schema passed as `format`), and the reply is
     parsed with Zod against `{pass: boolean, reason: string, confidence: 0..1}`.
   - *Guardrail — output schema enforcement*: if parsing fails, **one** correction
     round-trip ("respond only with that JSON object"); if it fails again the task is
     marked `failed` — the verdict is never guessed.

6. **`main-agent` aggregates**
   - `verdict.pass === true` → done.
   - `verdict.pass === false` → **one** retry: the executor is re-invoked with the
     verifier's `reason` appended as extra context, then re-verified (that's the
     two-entry `attempts` array above).
   - The local task completes (or fails) and the caller gets answer + verdict + trace.

## Long-running automation agents (mobile + browser)

The executor/verifier flow is *synchronous*: `message/send` blocks until the task is
done. The mobile (`:4003`) and browser (`:4004`) agents demonstrate the **other** A2A
mode — long-running tasks:

- `message/send` returns **immediately** with the task in `working` state; the (mock)
  automation steps run in the background of the sub-agent's own process.
- Progress is **coarse by design** — phase (`started`, `in-progress`,
  `waiting-for-input`, `completed`) plus `stepsCompleted/totalSteps` in
  `task.metadata.progress` — polled via `tasks/get`, not a step-by-step stream.
- Mid-task the agent needs the user (mobile: OTP at step 10; browser: 2FA at step 5):
  it transitions to **`input-required`** and stops. The user's answer travels as a
  normal `message/send` carrying the **same `taskId`** (A2A continuation), which
  resumes the run. Sending input to a task that isn't waiting returns JSON-RPC
  `-32004` (mapped to HTTP `409` by the orchestrator).
- **Everything is persisted** (`data/*.tasks.json`, atomic writes). Close the main
  agent and come back later: it reloads its task pointers and keeps polling. Kill the
  automation agent mid-run: on reboot it resumes unfinished tasks *from the last
  completed step* — progress is never lost. (Both scenarios are asserted by
  `npm run smoke`, sections 10 and 13.)

The user-facing flow through the orchestrator:

```bash
# 1. Start — returns at once with a taskId (HTTP 202), work continues remotely
curl -s -X POST http://localhost:4000/automation -H 'content-type: application/json' \
  -d '{"agent": "mobile", "task": "Order a veg pizza in the FoodNow app"}' | jq .
# { "taskId": "...", "state": "working",
#   "progress": { "phase": "started", "stepsCompleted": 0, "totalSteps": 20, ... } }

# 2. Poll whenever you like — including after restarting the main agent
curl -s http://localhost:4000/automation/<taskId> | jq '{state, progress}'
# { "state": "working",
#   "progress": { "phase": "in-progress", "stepsCompleted": 7, "totalSteps": 20,
#                 "note": "Step 7/20: Selecting the top result" } }

# 3. Eventually it pauses and tells you what it needs
# { "state": "input-required",
#   "inputPrompt": "Enter the OTP shown on the device to continue the automation." }
curl -s -X POST http://localhost:4000/automation/<taskId>/input \
  -H 'content-type: application/json' -d '{"input": "123456"}' | jq .state
# "working" — resumed

# 4. Poll to completion
curl -s http://localhost:4000/automation/<taskId> | jq '{state, result}'
# { "state": "completed", "result": "Mobile automation finished: 20/20 UI steps ..." }
```

Routing note: `POST /automation` names the target agent explicitly, so scoping is a
deterministic check (does that agent exist and is it up) — the LLM scope gate is only
needed on `/task`, where the orchestrator must judge free-form requests. The
automation agents are pure mocks (no LLM): each "step" is a `STEP_MS` sleep plus a
persisted progress update, which is exactly enough to exercise the protocol
mechanics — swap the step-runner with real Appium/Playwright calls and the A2A
surface stays identical.

## Inspecting a run: the audit log

Every A2A call, LLM call, tool call and guardrail event is one JSON line in
`logs/<agent>.jsonl` (mounted to `./logs` by docker-compose):

```bash
jq -c 'select(.event=="guardrail") | {agent, detail}' logs/*.jsonl
```

How the events look (first three captured from a real run):

```json
{"agent":"executor-agent","detail":{"guardrail":"tool-allowlist","rejectedTool":"delete_everything"}}
{"agent":"main-agent","detail":{"guardrail":"prompt-injection-scan","flagged":true,"matches":["ignore-previous-instructions","system-prompt-probe"]}}
{"agent":"main-agent","detail":{"guardrail":"input-validation","issues":[{"path":["task"],"message":"Required"}]}}
{"agent":"verifier-agent","detail":{"guardrail":"output-schema","attempt":1,"willRetry":true}}
{"agent":"verifier-agent","detail":{"guardrail":"rate-limit","limit":"10/min"}}
{"agent":"main-agent","detail":{"guardrail":"task-scope","inScope":false,"reason":"This requires creative writing or real-world actions, not system/file/web lookup."}}
```

Try the scope gate yourself:

```bash
curl -s -X POST http://localhost:4000/task \
  -H 'content-type: application/json' \
  -d '{"task": "Write me a romantic poem about the moon."}' | jq '{state, answer}'
# -> HTTP 422, state "rejected", answer starts with "I can only handle tasks my sub-agents support: ..."
```

## Guardrail summary

| # | Guardrail | Where | Mechanism |
|---|---|---|---|
| 1 | Input validation | every HTTP body, every agent | Zod schema before anything touches an LLM; `400` / JSON-RPC `-32600`/`-32602` |
| 2 | Prompt-injection scan | inbound text, every agent | regex pattern list; log + flag, never silently strip |
| 3 | Tool allowlist | executor ReAct loop | `Set` membership check before execution; args Zod-validated too |
| 4 | Max iterations / tokens | executor ReAct loop | 5 iterations, 20k tokens per task; exceed ⇒ task `failed` |
| 5 | Output schema enforcement | verifier | Zod on LLM output, one correction retry, then `failed` — never guess |
| 6 | Timeout + retry | every inter-agent call | 15s `AbortSignal` per attempt, single retry on transport errors |
| 7 | Audit log | every agent | one JSON line per event to `logs/<agent>.jsonl` |
| 8 | Rate limit | every agent endpoint | in-memory token bucket, 10 req/min ⇒ `429` |
| 9 | Task-scope gate | main-agent, before delegation | LLM classifier over the sub-agents' card-declared skills, Zod-validated, fail-closed; out-of-scope ⇒ `rejected` + "I can only do X" refusal, executor never invoked |

## What's deliberately out of scope

- Real tool execution and real device/browser automation (everything returns canned
  data or mock steps), auth between agents, streaming (`message/stream`), and push
  notifications — polling via `tasks/get` stands in for both.
- Input-required tasks wait forever (no expiry) and inputs are not idempotent — a
  production system would add a timeout on the pause and dedupe repeated submissions.
