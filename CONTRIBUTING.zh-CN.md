# 参与 Jot 开发

[English](CONTRIBUTING.md) · **简体中文**

感谢你关注并参与 Jot 的建设！无论是反馈缺陷、提出功能建议、完善文档还是提交代码修复，这份指南都能帮助你快速上手。

## 提交 Issue

提交[缺陷报告](.github/ISSUE_TEMPLATE/bug_report.md)时，请尽量提供：

- **最小复现样例**：能够触发问题的最短纯文本 Markdown 片段。
- **运行环境**：操作系统、浏览器版本、编辑模式（`live-preview`、`split`、`source` 或 `preview`）以及相关配置。
- **操作步骤与结果**：具体的操作流程、按键组合或输入法组词阶段，以及预期结果与实际表现。

如果你计划调整 Markdown 语法规则、通信协议、默认快捷键或主题 API，建议先提交[功能建议](.github/ISSUE_TEMPLATE/feature_request.md)与维护者对齐需求与影响范围。

## 提交 Pull Request

1. **Fork 并新建分支**：在 GitHub 上 Fork 本仓库，并从 `main` 创建目标明确的工作分支。
2. **本地复现与开发**：环境搭建请参阅[首页](README.zh-CN.md#从源码构建)与[开发与测试指南](docs/zh-CN/contributing/development.md)。
   - 语法与解析问题优先从 Rust 引擎侧（`crates/editor-engine`）复现。
   - 输入、选区、IME、光标或虚拟布局问题从浏览器套件（`scripts/browser`）复现。
3. **补充测试与文档**：
   - 在最贴近的 Rust、TypeScript 或浏览器测试套件中添加回归用例。
   - 若改动涉及对外 API、行为边界或命令配置，请同步更新中英文文档。
4. **提交前验证**：在本地运行相关检查（详见[编码规范](docs/zh-CN/contributing/code-style.md)），并确认 `git diff` 中不包含构建产物（`dist/`、`target/`）或临时日志。
5. **发起 PR**：使用清晰可读的标题，按 [PR 模板](.github/pull_request_template.md) 填写变更内容与验证结果，并关联相关 Issue。

每个 PR 都会经过 CI。只改[指定路径的文档](.github/workflows/ci.yml)时，CI 会跳过构建和浏览器测试。检查通过、评审意见处理完后，由维护者合并，通常使用 Squash merge。

## 更多参考

- [开发与测试指南](docs/zh-CN/contributing/development.md) — 源码目录、测试分层与 `md-inspect` 调试工具。
- [编码规范](docs/zh-CN/contributing/code-style.md) — 格式化、静态检查与跨层修改核对清单。
- [发布与部署手册](docs/zh-CN/contributing/releasing.md) — 维护者发包至 npm 与部署 Demo 的流程。
