import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ScriptAnalysisResult } from './gemini.service';

/**
 * Interface for LLM providers
 * Allows switching between different LLM providers (currently supports Gemini)
 */
export interface ILLMProvider {
  /**
   * Get the LangChain chat model instance
   */
  getModel(): BaseChatModel;

  /**
   * Get the structured output model (with Zod schema)
   */
  getStructuredModel(): any;

  /**
   * Get provider name for logging
   */
  getProviderName(): string;

  /**
   * Check if provider is configured and available
   */
  isAvailable(): boolean;
}
