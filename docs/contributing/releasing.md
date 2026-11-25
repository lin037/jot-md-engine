# Releasing & Deployment

**English** · [简体中文](../zh-CN/contributing/releasing.md)

This guide covers package releases and Demo deployment. The public npm package is `@jot-md/editor`.

## Repository Branch Rules

1. Enable GitHub Actions and Squash Merge in repository settings.
2. Under **Settings → Rules → Rulesets**, protect `main` by requiring pull requests, resolved conversations, and passing `Rust` and `Web and package` status checks.
3. Under **Settings → Actions → General**, keep default read-only permissions for pull requests from forks and require maintainer approval before running workflows on first-time fork PRs.

## Verifying the Package Locally

```sh
pnpm install --frozen-lockfile
pnpm run package:verify
```

This builds the tarball in `dist/release/` and tests the imports and Worker in a clean project. The current scripts still package `@lin037/jot-md-engine`. Update the package configuration and release scripts before using their output to release `@jot-md/editor`.

## Publishing to npm & GitHub Releases

1. Update the version in `packages/editor/package.json`. After merging to `main`, take the `jot-editor-package` artifact from the successful CI run for that commit. Check that the tarball contains the intended name and version.
2. Publish the verified `.tgz` with `npm publish` and `--access public`. For Trusted Publishing, enter `publish-npm.yml` as the workflow filename, select the `npm` environment, and allow direct publishing. Then run **Actions → Publish npm package** on `main` after the release scripts use the official package name.
3. Check the published tarball with `npm view @jot-md/editor@<version> dist.integrity`. Attach the verified tarball to the matching GitHub Release.

## Deploying the Demo

To publish the interactive Demo to GitHub Pages automatically on `main` pushes:

1. In **Settings → Pages**, set the source to **GitHub Actions**.
2. In **Settings → Secrets and variables → Actions → Variables**, set `DEPLOY_DEMO=true` (and optionally restrict the `github-pages` environment to `main`).

The Demo builds with relative asset paths (`./`), allowing deployment at repository subpaths.
