/**
 * Ollama Cloud client.
 *
 * The agent is deterministic-first: the LLM is consulted only when the
 * grammar parser or the element matcher cannot resolve a step on their
 * own. Every call uses structured outputs (`format` = JSON schema) at
 * temperature 0 so responses are small, cheap and machine-checkable.
 *
 * API: POST {OLLAMA_HOST}/api/chat with `Authorization: Bearer $OLLAMA_API_KEY`.
 * Works identically against a local Ollama (no key needed).
 */
import type { Config } from "./config.js";

export class LLMUnavailableError extends Error {}

export interface TokenUsage {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class OllamaLLM {
  private usage_: TokenUsage = {
    llmCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
  };

  constructor(private cfg: Config) {}

  get usage(): TokenUsage {
    return { ...this.usage_ };
  }

  get available(): boolean {
    if (!this.cfg.enableLlm) return false;
    // Local hosts don't need a key; ollama.com does.
    if (this.cfg.ollamaHost.includes("ollama.com") && !this.cfg.ollamaApiKey) {
      return false;
    }
    return true;
  }

  /**
   * One structured-output round trip. Throws LLMUnavailableError when the
   * LLM is disabled/unreachable so callers can fall back gracefully.
   */
  async chatJson<T>(
    system: string,
    user: string,
    schema: object,
    retries = 2,
  ): Promise<T> {
    if (!this.available) {
      throw new LLMUnavailableError(
        "LLM disabled or OLLAMA_API_KEY not set " +
        "(create one at https://ollama.com/settings/keys)",
      );
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.ollamaApiKey) {
      headers.authorization = `Bearer ${this.cfg.ollamaApiKey}`;
    }
    const body = JSON.stringify({
      model: this.cfg.model,
      stream: false,
      format: schema,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(
          `${this.cfg.ollamaHost.replace(/\/$/, "")}/api/chat`,
          {
            method: "POST", headers, body,
            signal: AbortSignal.timeout(this.cfg.llmTimeoutMs),
          },
        );
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
        }
        const data = (await resp.json()) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        this.usage_.llmCalls += 1;
        this.usage_.promptTokens += data.prompt_eval_count ?? 0;
        this.usage_.completionTokens += data.eval_count ?? 0;
        this.usage_.totalTokens =
          this.usage_.promptTokens + this.usage_.completionTokens;
        return JSON.parse(data.message?.content ?? "") as T;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new LLMUnavailableError(`Ollama call failed after retries: ${lastErr}`);
  }
}

// ---- JSON schemas for structured outputs (kept tiny on purpose) ----

export const COMMAND_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "tap", "long_press", "input", "set_date", "select", "toggle",
        "scroll", "assert_visible", "assert_not_visible", "wait",
        "back", "home", "hide_keyboard", "launch", "press_key",
      ],
    },
    target: { type: ["string", "null"] },
    value: { type: ["string", "null"] },
    direction: { type: ["string", "null"], enum: ["up", "down", "left", "right", null] },
    toggle_state: { type: ["string", "null"], enum: ["on", "off", null] },
  },
  required: ["kind"],
} as const;

export const DISAMBIG_SCHEMA = {
  type: "object",
  properties: { element_index: { type: ["integer", "null"] } },
  required: ["element_index"],
} as const;
