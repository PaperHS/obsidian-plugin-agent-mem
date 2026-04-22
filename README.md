# Mem Plugin — Build (Obsidian plugin)

> 把 Obsidian vault + mem-plugin raw store 编译成一个**结构化的知识库**，让 Claude Code 或其他 agent 通过 MCP 直接 recall。
>
> **插件只做 Build。Recall 由上层 `mem-plugin` MCP server 完成。**

## 为什么要这个插件

Obsidian 目前的 AI 插件（Smart Connections / Copilot / Smart Second Brain / Khoj / …）**全部停留在 RAG 层**——每次提问临时 embedding 召回，质量取决于命中率。

没有一个插件做 Karpathy 意义上的 **LLM as Compiler**：
定期把 vault 扫一遍，让 LLM 跨笔记做实体提取、关联发现、摘要压缩，生成一份**预先编译好的**知识库。

本插件填补的就是这一层。

## 可插拔编译器

所有 provider 都实现同一个 `CompilerAdapter` 接口：

```typescript
interface CompilerAdapter {
  build(sources: Source[]): Promise<BuildResult>;
  query(question: string): Promise<QueryResult>;
  dispose?(): Promise<void>;
}
```

内置适配器：

| Provider | 模式 | 备注 |
|---------|------|------|
| **NotebookLM** | 主力 | 通过 `notebooklm-client` 逆向接入；零 prompt 工程，Google 内部完成编译；首次需登录 |
| **Anthropic (Claude)** | 通用 LLM | 标准 build prompt；支持 `baseURL`（代理/网关） |
| **OpenAI** | 通用 LLM | 支持 `baseURL`；可对接任意 OpenAI-compatible 端点（Azure / OpenRouter / vLLM / Ollama 兼容层） |
| **Gemini** | 通用 LLM | 直调 `@google/generative-ai`，NotebookLM 降级选项 |
| **Custom** | 用户自带 | 指定 `baseURL` + `apiKey` + `model` + 协议格式（OpenAI / Anthropic） |

想加 GraphRAG、Cognee、本地 RAPTOR？实现 `CompilerAdapter` 再注册到 `compilers/index.ts` 就行。

## 工作流

```
┌─────────────┐       ┌──────────────┐       ┌─────────────────┐
│ Obsidian    │──────▶│ CompilerAdp  │──────▶│ knowledge store │
│  vault +    │       │  (Notebook   │       │  (YAML+MD,      │
│  raw store  │       │   LM / LLM)  │       │   mem-plugin    │
└─────────────┘       └──────────────┘       │    format)      │
                                             └────────┬────────┘
                                                      ▼
                                             mem-plugin MCP server
                                                      │ recall
                                                      ▼
                                                Claude Code
```

编译产物落到与 `mem-plugin` 完全兼容的 YAML frontmatter + Markdown，所以 MCP server 上的 `recall` tool **零改动**就能读到。

## 安装

```bash
cd obsidian-plugin
npm install
npm run build
```

把整个 `obsidian-plugin` 文件夹（含 `manifest.json` 和 `main.js`）拷贝到你的 vault 的 `.obsidian/plugins/mem-plugin-build/`，然后在 Obsidian 的 Community Plugins 里启用。

> **注意**：NotebookLM 适配器依赖 `notebooklm-client`，需要 Node + Puppeteer/Chromium，只能在桌面版 Obsidian 使用（`isDesktopOnly: true`）。

## 配置

Settings → Mem Plugin — Build：

1. **Provider**：选一个 compiler
2. **Knowledge store path**：绝对路径，例如 `~/.mem-plugin/knowledge`（需要和你的 mem-plugin MCP server 配置的 `--knowledge-store` 一致）
3. **Raw store path**（可选）：`~/.mem-plugin/raw`，把 CC 存下来的 session 记录一起编译
4. **Include / Exclude folders**：限定 vault 中哪些目录参与编译
5. **Provider settings**：API key / baseURL / model

## 命令

- `Mem: Run build`——手动触发一次编译
- `Mem: Query knowledge`——直接对 compiler 提问（仅 NotebookLM 支持实时 query；其它 provider 请走 MCP recall）
- `Mem: Dispose compiler session`——关闭 NotebookLM 浏览器会话

## NotebookLM 工作流细节

```ts
// 第一次 build：
const { notebookId } = await client.createNotebook();
for (src of sources) await client.addTextSource(notebookId, src.title, src.content);

// query：
await client.sendChat(notebookId, question, sourceIds);
```

NotebookLM 在云端做跨文档编译，本插件不存 JSON KB，只在 knowledge store 里写一条元数据记录（`source: built, tags: [notebooklm, compiled]`）作为书签。
Recall 时走 compiler 的 `query()` 或者直接打开 NotebookLM 看。

如果你希望 NotebookLM 的结果也能被 `recall` 检索，在设置里指定 `pinnedNotebookId` 并定期运行 `runReport`（后续版本会内置）。

## 降级/数据隐私

NotebookLM 数据走 Google，敏感项目建议走 Anthropic / OpenAI / 自托管 LLM + Custom provider。所有 adapter 都能一键切换，knowledge store 格式完全相同。

## 许可

MIT，见仓库根的 `LICENSE`。
