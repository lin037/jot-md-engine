# 合并、发布与部署

## GitHub 仓库设置

1. 将代码推送到准备公开的 GitHub 仓库，并在仓库设置中启用 Actions 和 Squash merge。
2. 在 **Settings → Rules → Rulesets** 为默认分支建立规则，要求走 Pull Request、解决讨论并通过 `Rust` 和 `Web and package`。先让 CI 跑一次，GitHub 才能列出这些检查。有第二位维护者时可以要求一次批准，独立维护时可先保持零次必需批准。
3. 在 **Settings → Actions → General** 保持 Fork 工作流的默认只读权限。GitHub 要求审批时，维护者检查 PR 的源码和工作流变更后再批准运行。

[GitHub 分支规则](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) · [Fork 工作流审批](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks)

CI 对 PR、合并队列和默认分支提交执行检查。Rust 任务执行格式检查、原生和 Wasm Clippy、工作区测试。Web 任务执行类型与架构检查、TypeScript 测试、构建和独立项目装包、基准页构建及 Demo 浏览器分组。编辑交互、布局和引用回归按改动运行[对应分组](development.md#浏览器分组如何选)。基准报告用来比较同环境下的性能，合并检查使用构建及行为结果。

## 构建 npm 包

```sh
pnpm install --frozen-lockfile
pnpm run package:verify
```

`dist/packages/` 生成 `@jot-md/editor-protocol` 和 `@jot-md/editor` 的两个 `.tgz` 及 `manifest.json`。组件包含 JS、类型声明、样式和 Worker 所需的 Wasm。打包检查会拒绝 Demo 和基准目录，并在独立项目验证安装、公开入口、样式与 Worker 通信。只需生成归档时可运行 `pnpm run package:pack`。

GitHub Releases 使用 `pnpm run package:verify --standalone` 生成的单个归档，协议已随编辑器打入 `dist/release/`。也可以从 **Actions → CI → Run workflow** 下载 `jot-editor-package` 构建产物。

## 首次发布

1. 确认 npm 账号有权在 `@jot-md` scope 内发布。在两个包的 `package.json` 中填入真实的 `repository.url`，例如 `git+https://github.com/<owner>/<repo>.git`，并合并到默认分支。
2. 从待发布的提交运行 `pnpm run package:verify`。登录 npm，按归档清单中的文件名先发布协议包，再发布组件。以下是版本为 `0.1.0` 时的命令。

   ```sh
   npm login
   npm publish ./dist/packages/jot-md-editor-protocol-0.1.0.tgz --access public
   npm publish ./dist/packages/jot-md-editor-0.1.0.tgz --access public
   ```

3. 在两个 npm 包的 **Settings → Trusted Publisher** 分别绑定真实的 GitHub owner、仓库、工作流文件名 `publish-npm.yml` 和环境名 `npm`，允许直接发布。在 GitHub 的 **Settings → Environments** 创建 `npm`，将部署分支限制为默认分支，可按团队需要启用审批。

[npm Trusted Publishing 设置](https://docs.npmjs.com/trusted-publishers/) · [npm 首次公开发布](https://docs.npmjs.com/generating-provenance-statements/)

## 后续发布

1. 在同一个 PR 中更新两个 npm 包的版本号，填写本次变更，通过 CI 并合并。
2. 在 **Actions → Publish npm packages → Run workflow** 中选择默认分支，输入该版本。工作流重新构建并验证归档，然后用 OIDC 按协议包、组件的顺序发布。发布任务使用已验证的同一份归档。
3. 检查两个版本在 npm 可见后，从对应提交创建 GitHub 版本标签和 Release。安装入口是 `npm install @jot-md/editor`，协议包会作为依赖安装。

若协议包已发布而组件包失败，先处理权限或网络问题，再用 **Re-run failed jobs** 复用同一次运行的归档。发布任务仅跳过完整性匹配的已发布版本。若现有版本内容不同，修正后增加版本号再发布。

## 部署 Demo

在 **Settings → Pages** 将 Source 设置为 **GitHub Actions**，然后在 **Settings → Secrets and variables → Actions → Variables** 添加 `DEPLOY_DEMO=true`。可以把 `github-pages` 环境限制为默认分支。默认分支下次推送且 CI 通过时，会将 `dist/demo/` 部署到 GitHub Pages。Demo 使用相对资源路径，可部署在仓库子路径。

[GitHub Pages 发布源设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
