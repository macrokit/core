import { OpenAICompatibleAdapter } from "./openai-compatible.js";

export interface OllamaOptions {
  /** Base URL of an Ollama server. Default http://localhost:11434. */
  baseUrl?: string;
  /** Model tag, e.g. "qwen2.5:7b-instruct". */
  model: string;
  /** Custom fetch. */
  fetch?: typeof fetch;
}

/**
 * Ollama adapter — thin subclass of OpenAICompatibleAdapter. Ollama exposes
 * an OpenAI-compatible surface at `/v1`, so we reuse the same transport and
 * just default the base URL and skip the bogus API key.
 *
 * Note: tool-call support in Ollama depends on the underlying model AND on
 * the Ollama version. Recent versions of Qwen 2.5 / Llama 3.1 / Mistral
 * tool-tuned models work; older models will silently drop the `tools` field.
 */
export class OllamaAdapter extends OpenAICompatibleAdapter {
  constructor(opts: OllamaOptions) {
    super({
      baseUrl: `${(opts.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "")}/v1`,
      model: opts.model,
      apiKey: "ollama",
      provider: "ollama",
      fetch: opts.fetch,
    });
  }
}
