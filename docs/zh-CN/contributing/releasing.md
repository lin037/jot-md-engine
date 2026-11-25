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

命令会把归档打到 `dist/release/`，再到空项目里检查导入和 Worker。当前脚本打出的包仍叫 `@lin037/jot-md-engine`。用脚本发正式包前，先把包配置和发布脚本改成 `@jot-md/editor`。

## 发布到 npm 与 GitHub Release

1. 在 `packages/editor/package.json` 更新版本号。合入 `main` 后，从该提交通过的 CI 下载 `jot-editor-package`，核对归档中的包名和版本。
2. 用 `npm publish` 发布核对过的 `.tgz`，加上 `--access public`。若用 npm 的 Trusted Publisher，工作流文件名填 `publish-npm.yml`，环境填 `npm`，勾选允许直接发布。等发布脚本切到正式包名后，再从 `main` 运行 **Actions → Publish npm package**。
3. 用 `npm view @jot-md/editor@<version> dist.integrity` 核对 npm 上的归档，再把验证过的同一份归档附到对应的 GitHub Release。

## 部署在线 Demo

若需在每次合入 `main` 后自动部署在线 Demo 到 GitHub Pages：

1. 在 **Settings → Pages** 中将 Source 设为 **GitHub Actions**。
2. 在 **Settings → Secrets and variables → Actions → Variables** 中添加变量 `DEPLOY_DEMO=true`（建议将 `github-pages` 环境限制为仅允许 `main` 分支）。

Demo 构建采用相对资源路径（`./`），可直接托管在仓库子路径下。
