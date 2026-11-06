import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ILLMProvider } from '../llm-provider.interface';
import { ScriptAnalysisSchema } from '../gemini.service';

@Injectable()
export class GeminiProvider implements ILLMProvider {
  private llm: ChatGoogleGenerativeAI;
  private structuredLlm: any;
  private structuredModelCache = new WeakMap<object, any>();
  private readonly logger = new Logger(GeminiProvider.name);
  private isConfigured = false;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GOOGLE_GEMINI_API_KEY');
    if (!apiKey) {
      this.logger.warn('GOOGLE_GEMINI_API_KEY not configured');
      return;
    }

    const modelName =
      this.configService.get<string>('GEMINI_MODEL_NAME') || 'gemini-2.5-flash';

    this.llm = new ChatGoogleGenerativeAI({
      model: modelName,
      apiKey,
      temperature: 0.2,
      maxOutputTokens: 65536,
      // Disable safety filters — screenplays routinely contain violence, adult
      // language, and mature themes that would otherwise be blocked by Gemini's
      // default thresholds, causing LangChain to crash on the empty response.
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_NONE',
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_NONE',
        },
      ] as any,
    });

    this.structuredLlm = this.llm.withStructuredOutput(ScriptAnalysisSchema);
    this.structuredModelCache.set(ScriptAnalysisSchema, this.structuredLlm);
    this.isConfigured = true;

    this.logger.log(`Google Gemini AI initialized (model: ${modelName})`);
  }

  getModel(): ChatGoogleGenerativeAI {
    if (!this.isConfigured) {
      throw new Error(
        'Gemini provider is not configured. Set GOOGLE_GEMINI_API_KEY.',
      );
    }
    return this.llm;
  }

  getStructuredModel(): any {
    if (!this.isConfigured) {
      throw new Error(
        'Gemini provider is not configured. Set GOOGLE_GEMINI_API_KEY.',
      );
    }
    return this.structuredLlm;
  }

  createStructuredModel(schema: object): any {
    if (!this.isConfigured) {
      throw new Error(
        'Gemini provider is not configured. Set GOOGLE_GEMINI_API_KEY.',
      );
    }

    const cachedModel = this.structuredModelCache.get(schema);
    if (cachedModel) {
      return cachedModel;
    }

    const structuredModel = this.llm.withStructuredOutput(schema as any);
    this.structuredModelCache.set(schema, structuredModel);
    return structuredModel;
  }

  getProviderName(): string {
    return 'Gemini';
  }

  isAvailable(): boolean {
    return this.isConfigured;
  }
}
