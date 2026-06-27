/**
 * Ollama Cloud implementation of LlmProvider.
 *
 * Connects to the hosted Ollama API (default https://ollama.com) using an API
 * key, and uses native tool calling (`tools` + `message.tool_calls`).
 *
 * Notes / trade-offs:
 *  - Ollama tool calls have no id, so we synthesise stable ids and map tool
 *    results back by name + order (one tool message per call, in order).
 *  - Tool-result images aren't part of Ollama's tool protocol, so images only
 *    ride along on user messages, and only when a vision-capable model is used
 *    (`supportsImages`). The compact text UI snapshot is the primary grounding
 *    anyway, so this degrades gracefully.
 */

import { Ollama, type Message, type Tool } from "ollama";
import type { ChatMessage, LlmProvider, LlmRequest, LlmResult, ToolDef } from "./types.js";

export interface OllamaProviderOptions {
  host: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  vision: boolean;
}

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly supportsImages: boolean;
  private readonly client: Ollama;
  private readonly maxTokens: number;

  constructor(opts: OllamaProviderOptions) {
    this.client = new Ollama({
      host: opts.host,
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
    this.supportsImages = opts.vision;
  }

  async chat(req: LlmRequest): Promise<LlmResult> {
    const messages = toOllamaMessages(req.system, req.messages, this.supportsImages);
    const response = await this.client.chat({
      model: this.model,
      messages,
      tools: req.tools.map(toOllamaTool),
      stream: false,
      think: false,
      options: { num_predict: this.maxTokens },
    });

    const msg = response.message;
    const text = (msg.content ?? "").trim();
    const toolCalls = (msg.tool_calls ?? []).map((tc, idx) => ({
      id: `call_${Date.now()}_${idx}`,
      name: tc.function.name,
      input: normaliseArgs(tc.function.arguments),
    }));

    return { text: text || undefined, toolCalls };
  }
}

function toOllamaTool(tool: ToolDef): Tool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema as Tool["function"]["parameters"],
    },
  };
}

function toOllamaMessages(
  system: string,
  messages: ChatMessage[],
  withImages: boolean,
): Message[] {
  const out: Message[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("\n");
      const images = withImages
        ? m.parts.filter((p) => p.type === "image").map((p) => (p.type === "image" ? p.data : ""))
        : [];
      const msg: Message = { role: "user", content: text };
      if (images.length > 0) msg.images = images;
      out.push(msg);
    } else if (m.role === "assistant") {
      const msg: Message = { role: "assistant", content: m.text ?? "" };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.input },
        }));
      }
      out.push(msg);
    } else {
      const text = m.parts
        .map((p) => (p.type === "text" ? p.text : "[image omitted]"))
        .join("\n");
      out.push({ role: "tool", content: text, tool_name: m.name });
    }
  }
  return out;
}

/** Ollama usually returns parsed args, but be defensive about string payloads. */
function normaliseArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  return {};
}
