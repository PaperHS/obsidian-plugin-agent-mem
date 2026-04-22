import Anthropic from '@anthropic-ai/sdk';
import type { CompilerAdapter } from './CompilerAdapter.js';
import { BUILD_SYSTEM_PROMPT, CompilerUnsupportedError, formatSourcesForPrompt, parseBuildJson } from './CompilerAdapter.js';
import type { BuildResult, ProviderConfig, QueryResult, Source } from '../types.js';

export class AnthropicCompiler implements CompilerAdapter {
  readonly id = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(cfg: ProviderConfig) {
    const opts: ConstructorParameters<typeof Anthropic>[0] = {};
    if (cfg.apiKey) opts.apiKey = cfg.apiKey;
    if (cfg.baseURL) opts.baseURL = cfg.baseURL;
    this.client = new Anthropic(opts);
    this.model = cfg.model || 'claude-sonnet-4-5';
  }

  async build(sources: Source[]): Promise<BuildResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: BUILD_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: formatSourcesForPrompt(sources) }],
    });
    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('No text block in Anthropic response');
    return {
      entries: parseBuildJson(block.text),
      meta: { provider: 'anthropic', sourceCount: sources.length, builtAt: new Date().toISOString() },
    };
  }

  async query(_q: string): Promise<QueryResult> {
    throw new CompilerUnsupportedError('query', this.id);
  }
}
