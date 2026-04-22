import { GoogleGenerativeAI } from '@google/generative-ai';
import type { CompilerAdapter } from './CompilerAdapter.js';
import { BUILD_SYSTEM_PROMPT, CompilerUnsupportedError, formatSourcesForPrompt, parseBuildJson } from './CompilerAdapter.js';
import type { BuildResult, ProviderConfig, QueryResult, Source } from '../types.js';

export class GeminiCompiler implements CompilerAdapter {
  readonly id = 'gemini';
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(cfg: ProviderConfig) {
    if (!cfg.apiKey) throw new Error('Gemini requires apiKey');
    this.client = new GoogleGenerativeAI(cfg.apiKey);
    this.model = cfg.model || 'gemini-2.0-flash';
  }

  async build(sources: Source[]): Promise<BuildResult> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: BUILD_SYSTEM_PROMPT,
    });
    const res = await model.generateContent(formatSourcesForPrompt(sources));
    const text = res.response.text();
    return {
      entries: parseBuildJson(text),
      meta: { provider: 'gemini', sourceCount: sources.length, builtAt: new Date().toISOString() },
    };
  }

  async query(_q: string): Promise<QueryResult> {
    throw new CompilerUnsupportedError('query', this.id);
  }
}
