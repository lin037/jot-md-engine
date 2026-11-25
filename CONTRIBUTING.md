# Contributing to Jot

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for your interest in contributing to Jot! Whether you are reporting a bug, proposing a feature, improving documentation, or submitting a fix, this guide helps you get started smoothly.

## Reporting Issues

When opening a [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md), please include:

- **Minimal reproduction**: The shortest Markdown snippet that triggers the issue.
- **Environment**: OS, browser, editor mode (`live-preview`, `split`, `source`, or `preview`), and relevant configuration.
- **Steps & observations**: Exact actions, keyboard shortcuts, or IME composition stages, along with expected vs. actual behavior.

When proposing changes to Markdown syntax, wire protocol, shortcuts, or theming APIs, please open a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) first to align on the design and affected callers.

## Submitting Pull Requests

1. **Fork and branch**: Fork the repository on GitHub and create a focused feature/fix branch from `main`.
2. **Develop locally**: Follow the setup instructions in the [README](README.md#building-from-source) and [Development Guide](docs/contributing/development.md).
   - Reproduce syntax or parser bugs on the Rust side (`crates/editor-engine`).
   - Reproduce input, selection, IME, or layout bugs in the browser suite (`scripts/browser`).
3. **Add tests and update docs**:
   - Add regression coverage in the closest existing Rust, TypeScript, or browser test suite.
   - Update both English and Chinese documentation when public APIs, behavior, or commands change.
4. **Verify before opening a PR**: Run the relevant checks locally (see [Code Style & Checks](docs/contributing/code-style.md)). Keep diffs clean—exclude build artifacts (`dist/`, `target/`) and temporary logs.
5. **Open the PR**: Use a concise, descriptive title and fill out the [PR template](.github/pull_request_template.md). Link any related issue.

CI checks every PR. Changes limited to [documentation paths](.github/workflows/ci.yml) skip the build and browser tests. Maintainers merge after checks pass and review comments are resolved, usually by squash merge.

## More Resources

- [Development & Testing Guide](docs/contributing/development.md) — Directory map, test suites, and `md-inspect` CLI.
- [Code Style & Conventions](docs/contributing/code-style.md) — Formatting, lints, and cross-layer checklist.
- [Releasing & Deployment](docs/contributing/releasing.md) — Maintainer guide for npm releases and Demo deployment.
