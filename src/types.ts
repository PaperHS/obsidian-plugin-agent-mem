export type ProviderId = 'notebooklm' | 'anthropic' | 'openai' | 'gemini' | 'custom';

export interface Source {
  id: string;
  title: string;
  content: string;
  path?: string;
}

export interface KnowledgeEntry {
  summary: string;
  facts: string[];
  tags: string[];
}

export interface BuildResult {
  entries: KnowledgeEntry[];
  meta?: {
    provider: ProviderId;
    notebookId?: string;
    sourceCount: number;
    builtAt: string;
  };
}

export interface QueryResult {
  answer: string;
  citations?: Array<{ sourceId: string; snippet?: string }>;
}

export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  extraHeaders?: Record<string, string>;
}

export interface PreprocessorConfig {
  apiKey?: string;
  baseURL?: string;
  /** Model for summarization and concept extraction. Default: claude-haiku-4-5-20251001 */
  model?: string;
}

export interface MemPluginSettings {
  provider: ProviderId;
  knowledgeStorePath: string;   // absolute path, written in mem-plugin-compatible format
  rawStorePath?: string;        // optional: read sessions from here
  includeFolders: string[];     // vault folders to compile; empty = entire vault
  excludeFolders: string[];
  fileExtensions: string[];     // ['.md'] by default
  autoBuildOnChange: boolean;
  autoBuildDebounceMs: number;

  // ── Build pipeline options ──────────────────────────────────────────────
  /** Only compile new/changed files since last build. */
  incrementalBuild: boolean;
  /** Pre-summarize each document before sending to the main compiler. */
  preSummarize: boolean;
  /** Extract cross-document concepts as separate knowledge entries. */
  extractConcepts: boolean;
  /** LLM used for pre-summarization and concept extraction. */
  preprocessor: PreprocessorConfig;

  providers: {
    notebooklm: {
      transport: 'auto' | 'browser' | 'http' | 'curl-impersonate' | 'tls-client';
      pinnedNotebookId?: string;
      homeDir?: string;     // overrides ~/.notebooklm (sets NOTEBOOKLM_HOME equivalent)
      chromePath?: string;  // Chrome executable for interactive login
    };
    anthropic: ProviderConfig;
    openai: ProviderConfig;
    gemini: ProviderConfig;
    custom: ProviderConfig & { format: 'openai' | 'anthropic' };
  };
}

export const DEFAULT_SETTINGS: MemPluginSettings = {
  provider: 'anthropic',
  knowledgeStorePath: '',
  rawStorePath: '',
  includeFolders: [],
  excludeFolders: [],
  fileExtensions: ['.md'],
  autoBuildOnChange: false,
  autoBuildDebounceMs: 60_000,
  incrementalBuild: true,
  preSummarize: false,
  extractConcepts: false,
  preprocessor: {},
  providers: {
    notebooklm: { transport: 'auto' },
    anthropic: { model: 'claude-sonnet-4-5' },
    openai: { model: 'gpt-4o-mini' },
    gemini: { model: 'gemini-2.0-flash' },
    custom: { format: 'openai', model: '' },
  },
};
