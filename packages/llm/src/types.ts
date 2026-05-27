/**
 * @macrokit/llm re-exports the runtime's LLM types so concrete adapters can
 * be authored against a single canonical contract. The source of truth lives
 * in @macrokit/runtime/src/llm-types.ts.
 */
export type {
  ChatMessage,
  ChatRole,
  CompleteOptions,
  CompleteResult,
  FinishReason,
  LLMAdapter,
  NormalizedToolCall,
  ToolSpec,
} from "@macrokit/runtime";
export { LLMAdapterError } from "@macrokit/runtime";
