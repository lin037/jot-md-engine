# 浏览器性能基准

[English](README.md) · **简体中文**

本套件在生产构建与无头 Chromium 环境下，对真实 `MarkdownEditor`（即时预览、CodeMirror 6 与 Rust/Wasm Web Worker）进行端到端性能测量。每次采样都会创建全新的编辑器与 Worker 实例，并使用离线生成的确定性混合样本。

## 运行基准测试

在仓库根目录执行：

```sh
# 运行默认全套基准（约 1 MiB 混合 Markdown，1 次预热 + 5 次采样）
pnpm run benchmark

# 跳过重建，指定单场景、样本字节数与输出路径
pnpm run benchmark --no-build --scenario cursor-insert --bytes 4194304 --samples 3 --output dist/benchmark-reports/cursor-4m.json

# 快速冒烟测试
pnpm run benchmark --no-build --bytes 65536 --samples 1 --output dist/benchmark-reports/smoke.json
```

如需指定 Chrome/Chromium 路径，可设置 `CHROME_BIN`。测试报告默认输出至 `dist/benchmark-reports/browser.json`，包含原始采样、中位数/最大值统计、浏览器信息与 Wasm 哈希。

用 `--scenario replace-all-fences`、`replace-all-text`、`replace-all-dense` 可单独运行 1 MiB 的围栏、普通文本和连续字符全部替换。连续字符样本在同一行逐字替换。记录命令同步耗时、首次可见时间、可保存时间和从点击到浏览器文件流写入关闭的总耗时，并核对 Rust 快照、文件读回、一次撤销与重做。

## 测试场景

| 场景 | 测量内容 |
| --- | --- |
| **打开文档** | 以约 1 MiB 文档作为初始内容，从创建编辑器实例开始计时。 |
| **单字输入** | 在已打开并完成解析的 1 MiB 文档中输入单个字符。 |
| **选字替换** | 在解析完成的文档开头附近选中一个字符，输入等长的新字符。 |
| **滚动浏览** | 发送真实滚轮事件，核对视口偏移与新进入区域的内容渲染。 |
| **一次性插入** | 向空编辑器发送一次可信 `Input.insertText` 全量文本载荷。 |
| **粘贴事件** | 在页面内构造包含完整载荷的 `ClipboardEvent`，测量组件与 CodeMirror 的粘贴处理耗时（不含系统剪贴板耗时）。 |
| **文首大段插入** | 在已完成解析的 1 MiB 文档开头再插入一份 1 MiB 文本，并模拟插入后立即执行 `input.settled()` 与 `confirmedValue` 落盘校验。 |
| **拖放** | 通过 CDP 发送完整浏览器拖放事件序列。 |

## 指标定义与有效性校验

- `visibleMs`（**画面首次可见**）：从操作触发到页面连续两帧呈现目标内容的时间（记录首帧时刻）。
- `confirmedMs`（**正文确认可保存**）：从操作触发到 Rust/Wasm Worker 确认修订、宿主可安全读取 `editor.confirmedValue` 的时间。
- `parsedMs`（**全文解析完成**）：从操作触发到后台增量语法分析覆盖全文的时间。
- `afterConfirmMs`：`confirmedMs` 与 `parsedMs` 之间的间隔（同时返回时记为 `0`）。

每个样本都会检查视口，并核对编辑区和 `confirmedValue` 是否和预期一致。文档开头插入的场景还会读取 Rust 快照，把保存的文件读回来比对。[基准结果](../README.zh-CN.md#浏览器性能基准)
