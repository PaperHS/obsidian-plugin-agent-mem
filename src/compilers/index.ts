import type { CompilerAdapter } from './CompilerAdapter.js';
import { AnthropicCompiler } from './AnthropicCompiler.js';
import { OpenAiCompiler } from './OpenAiCompiler.js';
import { GeminiCompiler } from './GeminiCompiler.js';
import { NotebookLmCompiler } from './NotebookLmCompiler.js';
import type { MemPluginSettings, ProviderId } from '../types.js';

export function createCompiler(id: ProviderId, settings: MemPluginSettings): CompilerAdapter {
  const p = settings.providers;
  switch (id) {
    case 'anthropic':
      return new AnthropicCompiler(p.anthropic);
    case 'openai':
      return new OpenAiCompiler(p.openai);
    case 'gemini':
      return new GeminiCompiler(p.gemini);
    case 'notebooklm':
      return new NotebookLmCompiler(p.notebooklm);
    case 'custom': {
      const { format, ...cfg } = p.custom;
      if (format === 'anthropic') return new AnthropicCompiler(cfg);
      return new OpenAiCompiler(cfg, 'custom');
    }
    default:
      throw new Error(`Unknown provider: ${id satisfies never}`);
  }
}

export type { CompilerAdapter } from './CompilerAdapter.js';
