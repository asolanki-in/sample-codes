/**
 * Anthropic (Claude) implementation of LlmProvider.
 *
 * Translates the neutral conversation model to Anthropic's Messages API:
 * assistant tool calls become `tool_use` blocks, and consecutive neutral `tool`
 * messages are merged into a single user message of `tool_result` blocks (which
 * is what the API expects to follow a tool-use turn).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, LlmProvider, LlmRequest, LlmResult, Part, ToolDef } from "./types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly supportsImages = true;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
  }

  async chat(req: LlmRequest): Promise<LlmResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: req.system,
      tools: req.tools.map(toAnthropicTool),
      messages: toAnthropicMessages(req.messages),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

    return { text: text || undefined, toolCalls };
  }
}

function toAnthropicTool(tool: ToolDef): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema as Anthropic.Tool["input_schema"],
  };
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "user") {
      out.push({ role: "user", content: m.parts.map(toAnthropicBlock) });
      i += 1;
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      if (content.length === 0) content.push({ type: "text", text: "(no content)" });
      out.push({ role: "assistant", content });
      i += 1;
    } else {
      // Merge consecutive tool results into one user message.
      const results: Anthropic.ContentBlockParam[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        const t = messages[i] as Extract<ChatMessage, { role: "tool" }>;
        results.push({
          type: "tool_result",
          tool_use_id: t.toolCallId,
          is_error: t.isError,
          content: t.parts.map(toAnthropicBlock),
        });
        i += 1;
      }
      out.push({ role: "user", content: results });
    }
  }
  return out;
}

function toAnthropicBlock(part: Part): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (part.type === "text") return { type: "text", text: part.text };
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: toMediaType(part.mime),
      data: part.data,
    },
  };
}

function toMediaType(mime: string): Anthropic.Base64ImageSource["media_type"] {
  switch (mime) {
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
    case "image/png":
      return mime;
    default:
      return "image/png";
  }
}
