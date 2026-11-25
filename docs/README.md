# Jot Documentation

**English** · [简体中文](zh-CN/README.md)

## Using the Editor

- [Package Guide (`@jot-md/editor`)](../packages/editor/README.md) — Installation, quick start, plugins, i18n, and API reference
- [Editor Interaction & Configuration](guides/editor.md) — Modes, shortcuts, search, tables, outline, focus management, and saving
- [Markdown Dialect & Extensions](guides/markdown.md) — Supported syntax, code fences, block quotes, and list continuations
- [Theming & Layout Customization](guides/theming.md) — CSS variables, layout metrics, outline styling, and safe overrides

## Architecture & Internals

- [Editing Pipeline](architecture/editing-pipeline.md) — From keystroke to Rust/Wasm confirmation and DOM updates
- [Wire Protocol](architecture/protocol.md) — Main thread, Worker, and Wasm message contracts and revision safety
- [Virtual Layout & Scrolling](architecture/virtual-layout.md) — Projection windows, height estimation, and scroll compensation
- [Engineering Invariants & Pitfalls](architecture/regressions.md) — Key constraints across parsing, IME, tables, and virtual scrolling

## Contributing

- [Contributing Guide](../CONTRIBUTING.md) — Reporting issues and submitting pull requests
- [Development & Testing](contributing/development.md) — Repository layout, test suites, and debugging tools
- [Code Style & Checks](contributing/code-style.md) — Coding conventions and CI verification commands
- [Releasing & Deployment](contributing/releasing.md) — Maintainer guide for npm publishing and Demo deployment
