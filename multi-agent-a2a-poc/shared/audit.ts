/**
 * Structured audit log — guardrail #7.
 *
 * Every A2A call (and every guardrail event) is appended as one JSON line to
 * logs/<agent-name>.jsonl so a run can be inspected afterwards:
 *
 *   cat logs/main-agent.jsonl | jq .
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = process.env.LOG_DIR ?? path.join(process.cwd(), "logs");

export interface AuditEntry {
  /** e.g. "a2a-call", "a2a-serve", "guardrail", "llm-call" */
  event: string;
  from: string;
  to: string;
  taskId?: string;
  inputSummary?: string;
  outputSummary?: string;
  latencyMs?: number;
  /** Extra fields (guardrail name, flags, token counts, ...) */
  detail?: Record<string, unknown>;
}

/** Trim long strings so the log stays readable — full payloads live in memory only. */
export function summarize(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + "…";
}

export function audit(agentName: string, entry: AuditEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), agent: agentName, ...entry });
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${agentName}.jsonl`), line + "\n");
  } catch (err) {
    // Never let logging take the agent down; fall back to stderr.
    console.error("[audit] failed to write log:", err);
  }
  // Also mirror to stdout so `docker compose logs` shows the flow live.
  console.log(`[audit] ${line}`);
}
