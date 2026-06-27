/**
 * Provider-neutral LLM abstraction.
 *
 * The agent loop is written against these types so it does not care whether the
 * backend is Anthropic (Claude) or Ollama Cloud. Each provider implements
 * `LlmProvider` and translates to/from its own wire format.
 */

export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image";
  /** base64-encoded image data. */
  data: string;
  /** e.g. "image/png". */
  mime: string;
}
export type Part = TextPart | ImagePart;

/** A model's request to call a tool. */
export interface ToolCall {
  /** Stable id (provider-supplied for Anthropic, synthesised for Ollama). */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  parts: Part[];
}
export interface AssistantMessage {
  role: "assistant";
  text?: string;
  toolCalls?: ToolCall[];
}
export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  parts: Part[];
  isError?: boolean;
}
export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

/** Provider-neutral tool definition (JSON-Schema object for the input). */
export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
}

export interface LlmResult {
  text?: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  /** Human-readable provider name, e.g. "anthropic" / "ollama". */
  readonly name: string;
  /** The model id in use (for reporting). */
  readonly model: string;
  /** Whether images may be sent to the model. */
  readonly supportsImages: boolean;
  chat(req: LlmRequest): Promise<LlmResult>;
}
