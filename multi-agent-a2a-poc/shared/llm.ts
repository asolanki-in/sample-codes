/**
 * Minimal LLM client — raw `fetch` to the Ollama chat API, no SDK.
 *
 * Works against:
 *   - Ollama cloud:  OLLAMA_HOST=https://ollama.com  + OLLAMA_API_KEY=...
 *   - local Ollama:  OLLAMA_HOST=http://localhost:11434  (no key needed)
 *
 * Endpoint: POST {OLLAMA_HOST}/api/chat   (non-streaming)
 * Docs: https://docs.ollama.com/api  and https://docs.ollama.com/cloud
 */
import { audit, summarize } from "./audit.js";

const OLLAMA_HOST = (process.env.OLLAMA_HOST ?? "https://ollama.com").replace(/\/$/, "");
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gpt-oss:120b";
const LLM_TIMEOUT_MS = 120_000;

// --- Wire types for the Ollama chat API (only the fields we use) -----------

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on assistant messages when the model wants to call tools. */
  tool_calls?: ToolCall[];
  /** Set on role:"tool" messages so the model knows which tool the result is from. */
  tool_name?: string;
}

/** JSON-Schema style tool definition, as the Ollama API expects. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface ChatResult {
  message: ChatMessage;
  /** Token accounting, used by the executor's max-token guard. */
  promptTokens: number;
  completionTokens: number;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /**
   * Structured output: pass a JSON schema object and Ollama constrains the
   * response to valid JSON matching it (used by the verifier).
   */
  format?: Record<string, unknown>;
}

export async function chat(agentName: string, opts: ChatOptions): Promise<ChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (OLLAMA_API_KEY) headers["authorization"] = `Bearer ${OLLAMA_API_KEY}`;

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: opts.messages,
        tools: opts.tools,
        format: opts.format,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM API error ${res.status}: ${summarize(body, 300)}`);
    }

    const data = (await res.json()) as {
      message: ChatMessage;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const result: ChatResult = {
      message: data.message,
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
    };

    audit(agentName, {
      event: "llm-call",
      from: agentName,
      to: `${OLLAMA_HOST} (${OLLAMA_MODEL})`,
      latencyMs: Date.now() - started,
      outputSummary: summarize(
        result.message.tool_calls?.length
          ? `tool_calls: ${result.message.tool_calls.map((t) => t.function.name).join(", ")}`
          : result.message.content,
      ),
      detail: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
    });

    return result;
  } finally {
    clearTimeout(timer);
  }
}
