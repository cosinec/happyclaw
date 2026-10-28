## 概要

<!-- 改了什么，为什么。 -->

## 验证

<!-- 实际运行过的命令和结果；没跑的写明原因。 -->

- [ ] `CLAUDE.md`「提交前门槛」中的命令均已通过
- [ ] 改动 Runner Prompt（`container/agent-runner/prompts/`）、`systemPrompt`、工具或 MCP 时，附上同一脚本化或真实运行在改动前后的缓存命中占比：`cache_read_input_tokens` ÷（`input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`），按轮列出
