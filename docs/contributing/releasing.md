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

该命令在 `dist/release/` 生成一个公开包 `@lin037/jot-md-engine` 的归档和 `manifest.json`。归档包含 JS、类型声明、样式、Worker/Wasm 和内部协议依赖。验证会在空项目安装这个包，逐个导入公开入口，并启动真实 Worker 往返读写文档。

## 发布 npm 与 GitHub Release

1. 在 PR 中更新 `packages/editor/package.json` 的版本。合并后，等对应的 `main` 提交通过完整 CI。在这次运行的 Artifacts 下载 `jot-editor-package` 并解压，其中的同一个 `.tgz` 用于 npm 和 GitHub Release。
2. 首次发布由 npm 个人账号 `lin037` 授权。在该提交的检出目录中运行以下命令，将 `./release` 替换为解压目录。脚本会核对包名、版本和清单中的 SHA-512 后发布。重试时，注册表里内容一致的版本会被跳过。

   ```sh
   npm login
   node scripts/release/publish-editor-package.mjs ./release 0.4.0
   ```

3. 使用 `npm view @lin037/jot-md-engine@0.4.0 dist.integrity` 核对 npm 上的 SHA-512，并在空项目运行 `npm install @lin037/jot-md-engine`。从通过 CI 的同一提交创建版本标签和 GitHub Release，上传已核对的归档。
4. 后续要使用 GitHub Actions 直接发布，可在 npm 包的 **Settings → Trusted Publisher** 登记 `lin037/jot-md-engine`、`publish-npm.yml` 和环境 `npm`，并在 GitHub 创建同名环境，将部署分支限制为 `main`。在 **Actions → Publish npm package** 选择 `main` 和版本号，工作流会按提交 SHA 下载通过 CI 的归档并用 OIDC 发布。[npm Trusted Publishing 设置](https://docs.npmjs.com/trusted-publishers/)

## 部署 Demo

在 **Settings → Pages** 将 Source 设置为 **GitHub Actions**，然后在 **Settings → Secrets and variables → Actions → Variables** 添加 `DEPLOY_DEMO=true`。可以把 `github-pages` 环境限制为默认分支。默认分支下次推送且 CI 通过时，会将 `dist/demo/` 部署到 GitHub Pages。Demo 使用相对资源路径，可部署在仓库子路径。

[GitHub Pages 发布源设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
