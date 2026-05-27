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

export {
  detectBailOut,
  type BailOutCode,
  type BailOutDetectorOptions,
  type BailOutFire,
  type BailOutPass,
  type BailOutResult,
} from "./bail-out-detector.js";
