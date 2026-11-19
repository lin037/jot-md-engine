import { mixedLargeSample } from "./mixed-sample.js";

export const ARTICLE = `# 排版手记

正文采用 **17 px** 的系统字体，*旁注*同字号。标题按 \`em\` 缩放，一级标题是正文的 $28/17$ 倍。

## 校样清单

> 先看连续两段正文，再决定标题需要多大。

- 比较一级和二级标题
- 检查页边
  - 折叠箭头放在文字左侧

| 名称 | 说明 |
| --- | --- |
| 正文 | 17 px |
| 一级标题 | 28 px |

\`\`\` css begin
article { font-size: 17px; }
h1 { font-size: calc(28em / 17); }
\`\`\` end

按正文的字号换算，一级标题的大小是

$$
17 \\times \\frac{28}{17} = 28
$$

![布局示意图](./pretext-layout.svg)

从左到右是文档结构、估算的块高和最终预览。
`;

export function sample(name: string): string {
  switch (name) {
    case "mermaid": return "# 图表示例\n\n点击图表可以编辑源码。\n\n```mermaid\nflowchart LR\n  S[Markdown 源码] -->|解析| E[语法树]\n  E --> D[可见范围的投影]\n  D --> Q[编辑器预览]\n```\n\n## 图表后的章节\n\n这里仍然是普通正文。";
    case "inline-task": return `# 一份待办\n\n- [ ] 整理资料\n- [x] 完成初稿\n\n保留 *斜体*，标记 ~~已完成内容~~，单个 ~ 与 \\~转义波浪号\\~ 是普通文字。\n\n[带括号的链接](https://example.com/a_(b))\n<https://example.com>\n<reader@example.com>\n`;
    case "list": return "# 大列表\n\n" + Array.from({ length: 5000 }, (_, i) => `- 项目 ${i + 1}：支持独立编辑与换行`).join("\n") + "\n\n列表结束。";
    case "table": return "# 大表格\n\n| 序号 | 名称 | 说明 |\n| --- | --- | --- |\n" + Array.from({ length: 2000 }, (_, i) => `| ${i + 1} | 项目 ${i + 1} | ${i % 5 === 0 ? "长内容用于检查换行后的行高与对齐。".repeat(6) : "可编辑内容"} |`).join("\n") + "\n\n表格结束。";
    case "code": return "# 大代码块\n\n``` ts begin\n" + Array.from({ length: 10000 }, (_, i) => `const value${i} = ${i};`).join("\n") + "\n``` end\n\n代码结束。";
    case "text": return mixedLargeSample();
    default: return ARTICLE;
  }
}
