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

This builds the tarball in `dist/release/` and tests the imports and Worker in a clean project.

## Publishing to npm & GitHub Releases

1. Update the public documentation and benchmark results when applicable, bump the version in `packages/editor/package.json`, and include these changes in the PR. Code PRs run the full checks, and PRs from branches in this repository save the verified package. You can merge several PRs before releasing.
2. When you are ready to publish, run **Actions → Publish release** on `main` and enter the version. If a successful CI run saved a package for the exact same files, the workflow reuses it. If the files differ or the package is unavailable, the workflow runs the full checks on the selected `main` commit and uses the package from that run.
3. The workflow publishes the verified `.tgz` to npm and attaches the same file to the matching GitHub Release. If publishing fails, rerun the failed jobs from that release run.

Set up [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) once. Enter `publish-npm.yml` as the workflow filename, select the `npm` environment, and allow direct publishing.

## Deploying the Demo

The **Deploy Demo** workflow builds and deploys GitHub Pages separately when relevant files reach `main`.

1. In **Settings → Pages**, set the source to **GitHub Actions**.
2. In **Settings → Secrets and variables → Actions → Variables**, set `DEPLOY_DEMO=true` (and optionally restrict the `github-pages` environment to `main`).

The Demo builds with relative asset paths (`./`), allowing deployment at repository subpaths.
