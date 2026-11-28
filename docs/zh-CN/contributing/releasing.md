# 发布与部署手册

[English](../../contributing/releasing.md) · **简体中文**

这份手册用于发包和部署 Demo。正式 npm 包名是 `@jot-md/editor`。

## GitHub 仓库保护配置

1. 在仓库设置中启用 GitHub Actions 与 Squash merge。
2. 在 **Settings → Rules → Rulesets** 中为 `main` 分支配置保护规则：要求通过 Pull Request 合并、所有评审意见已解决，且必需检查 `Rust` 与 `Web and package` 均通过。
3. 在 **Settings → Actions → General** 中保持 Fork 工作流默认只读权限，由维护者审查变更后再放行首次外部 PR 的工作流运行。

## 本地打包与安装校验

```sh
pnpm install --frozen-lockfile
pnpm run package:verify
```

命令会把归档打到 `dist/release/`，再到空项目里检查导入和 Worker。

## 发布到 npm 与 GitHub Release

1. 在 `packages/editor/package.json` 更新版本号，通过 PR 合入 `main`。代码改动会跑完整检查，本仓库分支开的 PR 还会保存检查过的包。可以合入多个 PR 后再发版。
2. 准备发版时，在 **Actions → Publish release** 选择 `main` 并输入版本号。工作流会复用与当前文件完全一致、且已经通过检查的包。文件有变化或包已不可用时，才对这次选中的 `main` 提交跑完整检查并使用这次产出的包。
3. 工作流会把核对过的 `.tgz` 发布到 npm，并把同一份文件放到对应的 GitHub Release。如果发布中途失败，在这次发布记录里重跑失败的任务即可。

首次使用前配置 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。工作流文件名填 `publish-npm.yml`，环境填 `npm`，勾选允许直接发布。

## 部署在线 Demo

相关改动合入 `main` 后，由独立的 **Deploy Demo** 工作流构建并部署到 GitHub Pages。

1. 在 **Settings → Pages** 中将 Source 设为 **GitHub Actions**。
2. 在 **Settings → Secrets and variables → Actions → Variables** 中添加变量 `DEPLOY_DEMO=true`（建议将 `github-pages` 环境限制为仅允许 `main` 分支）。

Demo 构建采用相对资源路径（`./`），可直接托管在仓库子路径下。
