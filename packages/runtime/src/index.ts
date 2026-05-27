export { MacroRegistry } from "./registry.js";
export { SessionLog } from "./session-log.js";
export type { SessionLogOptions } from "./session-log.js";
export { Dispatcher } from "./dispatcher.js";
export type { DispatcherOptions } from "./dispatcher.js";
export { Runtime } from "./runtime.js";
export type { RuntimeOptions } from "./runtime.js";
export { IntentRouter } from "./router.js";
export type { IntentRouterOptions, ChatResult } from "./router.js";
export {
  detectBailOut,
  type BailOutCode,
  type BailOutDetectorOptions,
  type BailOutFire,
  type BailOutPass,
  type BailOutResult,
} from "./bail-out-detector.js";
export type {
  Macro,
  MacroContext,
  MacroError,
  Schema,
  SessionLogEntry,
  SessionLogEntryInput,
  SessionLogEntryType,
  SessionLogLike,
  ToolCall,
  ToolResult,
} from "./types.js";
export type {
  ChatMessage,
  ChatRole,
  CompleteOptions,
  CompleteResult,
  FinishReason,
  LLMAdapter,
  NormalizedToolCall,
  ToolSpec,
} from "./llm-types.js";
export { LLMAdapterError } from "./llm-types.js";
