/**
 * Provider factory: builds the configured LlmProvider.
 */

import type { AppConfiguration } from "../config.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import type { LlmProvider } from "./types.js";

export function createProvider(config: AppConfiguration): LlmProvider {
  const llm = config.llm;
  if (llm.provider === "ollama") {
    return new OllamaProvider({
      host: llm.ollama.host,
      apiKey: llm.ollama.apiKey ?? "",
      model: llm.ollama.model,
      maxTokens: llm.ollama.maxTokens,
      vision: llm.ollama.vision,
    });
  }
  return new AnthropicProvider({
    apiKey: llm.anthropic.apiKey ?? "",
    model: llm.anthropic.model,
    maxTokens: llm.anthropic.maxTokens,
  });
}
