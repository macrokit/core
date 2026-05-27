// Re-export the contract from runtime so adopters can import everything
// from a single package if they only need adapters + types.
export type {
  ChatMessage,
  ChatRole,
  CompleteOptions,
  CompleteResult,
  FinishReason,
  LLMAdapter,
  NormalizedToolCall,
  ToolSpec,
} from "./types.js";
export { LLMAdapterError } from "./types.js";

export {
  OpenAICompatibleAdapter,
  type OpenAICompatibleOptions,
} from "./openai-compatible.js";
export { OllamaAdapter, type OllamaOptions } from "./ollama.js";
export { AnthropicAdapter, type AnthropicAdapterOptions } from "./anthropic.js";
