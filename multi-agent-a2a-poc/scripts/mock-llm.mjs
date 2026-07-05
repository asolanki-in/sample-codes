/**
 * Scripted mock of the Ollama /api/chat endpoint, so the whole system can be
 * exercised WITHOUT an API key (npm run smoke uses it).
 *
 * The script deliberately walks the interesting paths:
 *  - Scope-gate calls (format has an `in_scope` property): tasks that smell
 *    creative/actiony ("poem", "flight", ...) are declared out of scope, so
 *    the orchestrator's refusal path can be tested.
 *  - First executor iteration (tools present, no tool results yet): returns
 *    TWO tool_calls — one allowed (run_shell_command) and one NOT in the
 *    allowlist (delete_everything) — to prove the allowlist guardrail fires.
 *  - Second executor iteration (tool results present): final text answer.
 *  - Verifier calls (format has a `pass` property): pass:false on the first
 *    attempt (forcing the orchestrator's retry-with-reason path), pass:true
 *    once the task text shows it's the retry.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 12434);

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/chat") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { messages, tools, format } = JSON.parse(body);
    const userText = messages.find((m) => m.role === "user")?.content ?? "";
    let message;

    if (format?.properties?.in_scope) {
      // Main agent's scope gate
      const outOfScope = /poem|flight|essay|joke|buy|book me/i.test(userText);
      message = {
        role: "assistant",
        content: JSON.stringify(
          outOfScope
            ? { in_scope: false, reason: "This requires creative writing or real-world actions, not system/file/web lookup." }
            : { in_scope: true, reason: "Answerable with the executor's tools." },
        ),
      };
    } else if (format) {
      // Verifier
      const isRetry = userText.includes("A previous attempt");
      message = {
        role: "assistant",
        content: JSON.stringify(
          isRetry
            ? { pass: true, reason: "Output now includes the kernel details requested.", confidence: 0.92 }
            : { pass: false, reason: "Output does not mention the kernel version.", confidence: 0.85 },
        ),
      };
    } else if (tools && !messages.some((m) => m.role === "tool")) {
      // Executor, first iteration: one allowed + one disallowed tool call
      message = {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "run_shell_command", arguments: { command: "uname -a" } } },
          { function: { name: "delete_everything", arguments: { target: "/" } } },
        ],
      };
    } else {
      // Executor, second iteration: answer from the first tool result
      const toolResult = messages.filter((m) => m.role === "tool").map((m) => m.content)[0] ?? "";
      message = { role: "assistant", content: `The host runs: ${toolResult.trim()}` };
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message, prompt_eval_count: 120, eval_count: 45 }));
  });
});

server.listen(PORT, () => console.log(`[mock-llm] scripted Ollama /api/chat on :${PORT}`));
