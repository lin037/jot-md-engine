# Code Style & Conventions

**English** · [简体中文](../zh-CN/contributing/code-style.md)

## File Organization

- Organize each module from top to bottom: module overview, imports, types and constants, public entry points, internal helpers, and local unit tests at the bottom.
- **Rust imports**: Group in order—`std`, external crates, current crate / sibling modules.
- **TypeScript imports**: Group external packages first, then workspace packages (`@jot-md/...`), then relative local imports. Use `import type` (or inline `type`) for type-only imports, and include the `.js` extension on relative ESM imports.

## Comments & Naming

- Write code comments in English so contributors worldwide can read and maintain the codebase.
- Comment *why* an invariant, ordering requirement, or boundary check exists—not what trivial code already expresses. For public entry points, document coordinate units (for example UTF-16 offsets), failure behavior, and lifecycle expectations.
- Name tests after the observable behavior they verify.

## Required Checks

Before opening or updating a pull request, run:

- **Rust**:
  ```sh
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo clippy --workspace --target wasm32-unknown-unknown --all-targets -- -D warnings
  cargo test --workspace
  ```
- **TypeScript & Architecture**:
  ```sh
  pnpm run build:protocol
  pnpm run typecheck
  pnpm run test:ts
  ```
  `pnpm run test:ts` also runs `check:architecture` (`scripts/checks/check-editor-architecture.mjs`) to enforce clean layering between `core/`, `components/`, `layout/`, `render/`, and `hosts/`.

When changing wire types, verify both Rust (`crates/editor-protocol`) and TypeScript (`packages/editor-protocol`) against [Wire Protocol](../architecture/protocol.md). When changing rendering geometry, verify both DOM rendering and off-screen estimation against [Virtual Layout](../architecture/virtual-layout.md).
