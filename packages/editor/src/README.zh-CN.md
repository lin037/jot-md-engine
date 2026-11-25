# 浏览器端编辑器源码（`packages/editor/src`）

[English](README.md) · **简体中文**

完整的编辑链路可从 `component/markdown-editor.ts` 入手阅读：CodeMirror 6 接收按键与输入法事件，`adapter/` 将事务串行发送至 Web Worker，Rust/Wasm 引擎确认版本并返回语法投影，最后由渲染宿主在保留选区与滚动锚点的前提下更新可见 DOM。

## 目录结构

```text
src/
├── index.ts                 组件公开入口
├── component/               MarkdownEditor 生命周期、主题、命令面板与快捷键界面
├── adapter/                 Worker 会话、串行事务协调、UTF-16 文本索引与稀疏投影缓存
├── worker/                  Wasm 初始化、请求分发与后台分析泵
├── core/
│   ├── commands/            命令与快捷键注册表
│   ├── projection/          投影契约、布局参数与缓存键
│   └── virtual/             逻辑尺寸轴、已挂载节点管理与滚动锚点
├── components/              内置命令与各语法节点的渲染/交互策略
│   ├── common/              节点到 DOM 映射、URL 安全过滤、图片尺寸与光标换算
│   ├── closed-container/    闭合代码块与公式块的边界保护规则
│   ├── math/                同步与按需加载的 KaTeX 渲染器
│   └── table/               单元格编辑、行列命令、列宽计算与布局模型
│       └── adapters/        面向只读预览与即时预览的二维虚拟表格适配器
├── hosts/
│   ├── source/              CodeMirror 输入、查找替换与事务同步
│   ├── live-preview/        原位编辑装饰、视口投影窗口与部件生命周期
│   ├── preview/             只读预览与 PreText 布局调试视图
│   │   └── projection/      按节点类型决定预览与预布局的投影深度
│   ├── folding/             多视图共享的章节折叠状态
│   └── shared/              跨宿主复用的不可变源码快照工具
├── layout/                  引用/列表显示几何与自定义滚动条
│   └── pretext/             基于字体、宽度与排版指标的离屏高度估算
├── render/
│   └── runtime/             共用的语义节点挂载、局部更新与回收运行时
├── plugins/                 插件注册表、工具栏、大纲、标题折叠与 Mermaid
└── observability/           覆盖输入、协议、解析与布局的事务级可观测性
```

只读预览（`hosts/preview`）与即时预览（`hosts/live-preview`）共用语义渲染器与 `TableGrid` 组件，各自维护滚动容器与 DOM 生命周期。所有协议坐标均以 UTF-16 码元计，不可将浏览器选区或 DOM 偏移直接当作协议坐标。

## 子模块说明

- [Table 组件](components/table/README.zh-CN.md)
- [即时预览宿主](hosts/live-preview/README.zh-CN.md)
- [离屏高度估算（`layout/pretext`）](layout/pretext/README.zh-CN.md)
- [Worker 调度](worker/README.zh-CN.md)
