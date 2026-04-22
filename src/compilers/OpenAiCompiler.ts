import OpenAI from 'openai';
import type { CompilerAdapter } from './CompilerAdapter.js';
import { BUILD_SYSTEM_PROMPT, CompilerUnsupportedError, formatSourcesForPrompt, parseBuildJson } from './CompilerAdapter.js';
import type { BuildResult, ProviderConfig, QueryResult, Source } from '../types.js';

export class OpenAiCompiler implements CompilerAdapter {
  readonly id: string;
  private client: OpenAI;
  private model: string;

  constructor(cfg: ProviderConfig, id = 'openai') {
    this.id = id;
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: cfg.apiKey ?? 'sk-not-set',
    };
    if (cfg.baseURL) opts.baseURL = cfg.baseURL;
    if (cfg.extraHeaders) opts.defaultHeaders = cfg.extraHeaders;
    this.client = new OpenAI(opts);
    this.model = cfg.model || 'gpt-4o-mini';
  }

  async build(sources: Source[]): Promise<BuildResult> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: BUILD_SYSTEM_PROMPT },
        { role: 'user', content: formatSourcesForPrompt(sources) },
      ],
      response_format: { type: 'json_object' },
    });
    const text = res.choices[0]?.message?.content;
    if (!text) throw new Error('No content in OpenAI response');
    // OpenAI json_object mode wraps array — try both shapes.
    let entries;
    try {
      entries = parseBuildJson(text);
    } catch {
      const obj = JSON.parse(text);
      entries = Array.isArray(obj.entries) ? obj.entries : Array.isArray(obj.knowledge) ? obj.knowledge : null;
      if (!entries) throw new Error('Could not locate knowledge array in OpenAI response');
    }
    return {
      entries,
      meta: { provider: this.id === 'custom' ? 'custom' : 'openai', sourceCount: sources.length, builtAt: new Date().toISOString() },
    };
  }

  async query(_q: string): Promise<QueryResult> {
    throw new CompilerUnsupportedError('query', this.id);
  }
}
