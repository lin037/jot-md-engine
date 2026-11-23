import { EditorView } from "@codemirror/view";

const unprojectedBlankLine = ".cm-content.jot-live-preview-content > .cm-line:not([data-jot-live-node]):has(> :is(br:only-child,[data-jot-blank-text]))";

/**
 * Live Preview 只保留 CodeMirror 宿主特有的规则。
 *
 * 标题、段落、引用、列表、代码和表格的语义样式来自共享 Preview CSS；
 * 这里不能再次复制一套 renderer 的排版规则。剩余规则只处理 decoration
 * 状态、Runtime widget 的尺寸约束以及 CodeMirror caret 的投影显示。
 */
export const livePreviewTheme = EditorView.baseTheme({
  // Keep responsive images and tables bounded by the editor width.
  ".cm-content.jot-live-preview-content": {
    width: "100%",
    minWidth: "0",
  },
  // Code remains native editable lines, but long lines scroll inside their
  // common block instead of widening and moving the entire document.
  ".cm-content.jot-live-preview-content .jot-live-preview-code-scroll": {
    boxSizing: "border-box",
    width: "100%",
    minWidth: "0",
    maxWidth: "100%",
    overflowX: "auto",
    overflowY: "hidden",
    background: "var(--jot-code-background, color-mix(in srgb, currentColor 5%, transparent))",
  },
  // Every source line of an active code block has the active class. Paint its
  // tint once on the stationary viewport, otherwise short lines carry their
  // own viewport-wide tint sideways and leave a vertical color seam.
  ".cm-content.jot-live-preview-content .jot-live-preview-code-scroll:has(> .cm-line.jot-live-preview-active-line)": {
    backgroundImage: "linear-gradient(color-mix(in srgb, currentColor 4%, transparent), color-mix(in srgb, currentColor 4%, transparent))",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-code-scroll > .cm-line.jot-live-preview-source-fenced-code": {
    width: "max-content",
    minWidth: "100%",
    maxWidth: "none",
    backgroundColor: "transparent",
  },
  ".cm-content.jot-live-preview-content[data-jot-code-wrap=\"wrap\"] .jot-live-preview-code-scroll": {
    overflowX: "hidden",
  },
  ".cm-content.jot-live-preview-content[data-jot-code-wrap=\"wrap\"] .jot-live-preview-code-scroll > .cm-line.jot-live-preview-source-fenced-code": {
    width: "100%",
    minWidth: "0",
    maxWidth: "100%",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  // CodeMirror's height oracle measures an undecorated `.cm-line` dummy when
  // the visible document has no short text line. Give that dummy the common
  // root-block reserve so a long native document has the right scrollbar
  // before every line has entered the viewport. Concrete continuation,
  // blank, source-shell and widget lines override this reserve below.
  ".cm-content.jot-live-preview-content > .cm-line": {
    boxSizing: "border-box",
    lineHeight: "var(--jot-paragraph-line-height)",
    paddingBlockEnd: "var(--jot-live-preview-block-gap)",
    borderBlockEnd: "var(--jot-boundary-width) solid transparent",
  },
  // Ordinary Markdown text remains real CodeMirror line content. Keeping the
  // line DOM native preserves browser hit-testing, selection, IME and CM6's
  // viewport virtualization; only syntax delimiters are hidden by inline
  // decorations. The root block gap is stable in both active/inactive states.
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block": {
    boxSizing: "border-box",
    minWidth: "0",
    maxWidth: "100%",
    paddingBlockEnd: "0",
    borderBlockEnd: "0 solid transparent",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--last": {
    paddingBlockEnd: "var(--jot-live-preview-block-gap)",
    borderBlockEnd: "var(--jot-boundary-width) solid color-mix(in srgb, currentColor 18%, transparent)",
  },
  // Keep native paragraphs aligned with their Preview counterparts.
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--paragraph:not(.jot-live-preview-list-item):not(.jot-live-preview-native-block--block-quote)": {
    paddingInline: "var(--jot-paragraph-padding-x)",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-list-item": {
    position: "relative",
    "--jot-live-list-marker-column": "max(var(--jot-list-indent), calc(var(--jot-live-list-marker-columns, 0ch) + .5em))",
    "--jot-live-list-effective-indent": "min(var(--jot-live-list-indent, 0ch), max(0px, calc(100% - var(--jot-live-quote-inset, 0px) - var(--jot-live-list-end-inset, 0px) - var(--jot-live-list-marker-column) - var(--jot-list-min-content, 64px))))",
    paddingInlineStart: "calc(var(--jot-live-list-effective-indent) + var(--jot-live-list-marker-column))",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-list-item::before": {
    content: "attr(data-jot-live-list-marker)",
    position: "absolute",
    insetInlineStart: "var(--jot-live-list-effective-indent)",
    inlineSize: "max(0px, calc(var(--jot-live-list-marker-column) - .5em))",
    textAlign: "end",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "pre",
    pointerEvents: "none",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-live-preview-line": {
    // A single native line may belong to several confirmed quote ancestors.
    // Paint their inset rules without adding DOM or a second editing surface.
    "--jot-live-quote-step": "max(3px, var(--jot-quote-padding-x))",
    "--jot-live-quote-inset": "min(calc(var(--jot-live-quote-depth, 1) * var(--jot-quote-padding-x)), max(0px, calc(100% - var(--jot-quote-padding-x) - var(--jot-quote-min-content, 64px))))",
    "--jot-live-quote-root-open": "clamp(0, calc(var(--jot-live-quote-open, 0) - var(--jot-live-quote-depth, 1) + 1), 1)",
    "--jot-live-quote-root-close": "clamp(0, calc(var(--jot-live-quote-close, 0) - var(--jot-live-quote-depth, 1) + 1), 1)",
    "--jot-live-quote-before": "calc(var(--jot-live-quote-root-open) * var(--jot-quote-padding-y))",
    "--jot-live-quote-after": "calc(var(--jot-live-quote-root-close) * var(--jot-quote-padding-y))",
    "--jot-live-quote-gap": "0px",
    paddingInlineStart: "var(--jot-live-quote-inset)",
    paddingInlineEnd: "var(--jot-quote-padding-x)",
    paddingBlockStart: "var(--jot-live-quote-before)",
    paddingBlockEnd: "calc(var(--jot-live-quote-after) + var(--jot-live-quote-gap))",
    borderInlineStart: "0",
    boxShadow: "none",
    backgroundImage: "repeating-linear-gradient(to right, var(--jot-quote-border, color-mix(in srgb, currentColor 25%, transparent)) 0 3px, transparent 3px, transparent var(--jot-live-quote-step))",
    backgroundSize: "min(calc((var(--jot-live-quote-depth, 1) - 1) * var(--jot-quote-padding-x) + 3px), calc(var(--jot-live-quote-inset) + 3px)) 100%",
    backgroundPosition: "left top",
    backgroundRepeat: "no-repeat",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-live-preview-native-block--last": {
    "--jot-live-quote-gap": "var(--jot-live-preview-block-gap)",
  },
  // CM's zero-width cursor buffers around a hidden quote prefix otherwise
  // create a break opportunity before a long unbroken word, leaving a whole
  // empty visual row. Adjacent leading inline/list markers need the same
  // treatment. Retain the buffers for native selection and IME mapping;
  // later markers and nonempty widgets keep their normal text flow. A row
  // containing only the quote prefix must retain CM's in-flow buffers: they
  // are its native line box and caret geometry, as on an ordinary empty line.
  '.cm-content.jot-live-preview-content .cm-line[data-jot-quote-marker-hidden="true"]:not([data-jot-quote-marker-only="true"]) > .cm-widgetBuffer:has(+ .jot-live-preview-leading-quote-marker)': {
    position: "absolute",
  },
  '.cm-content.jot-live-preview-content .cm-line[data-jot-quote-marker-hidden="true"]:not([data-jot-quote-marker-only="true"]) > .jot-live-preview-leading-quote-marker + .cm-widgetBuffer': {
    position: "absolute",
  },
  // Keep the current row's own line height while a local deletion awaits
  // confirmation. `lh` preserves code, math and heading metrics; collapsed
  // delimiter rows keep their dedicated geometry.
  '.cm-content.jot-live-preview-content .cm-line[data-jot-quote-marker-hidden="true"]:where(:not(.jot-live-preview-structural-line,.jot-live-preview-code-boundary))': {
    minHeight: "calc(1lh + var(--jot-live-quote-before) + var(--jot-live-quote-after) + var(--jot-live-quote-gap))",
  },
  // An empty quote is still a quote paragraph. The top-level blank-line
  // metric is deliberately independent and must not shrink this editing row.
  '.cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote:is([data-jot-quote-marker-only="true"],.jot-live-preview-blank-line):where(:not(.jot-live-preview-structural-line,.jot-live-preview-code-boundary,.jot-live-preview-source-fenced-code,.jot-live-preview-source-math-block,.jot-live-preview-source-heading))': {
    lineHeight: "var(--jot-paragraph-line-height)",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-live-preview-list-item": {
    "--jot-live-list-end-inset": "var(--jot-quote-padding-x)",
    "--jot-live-quote-inset": "min(calc(var(--jot-live-quote-depth, 1) * var(--jot-quote-padding-x)), max(0px, calc(100% - var(--jot-quote-padding-x) - var(--jot-live-list-marker-column) - var(--jot-list-min-content, 64px))))",
    paddingInlineStart: "calc(var(--jot-live-quote-inset) + var(--jot-live-list-effective-indent) + var(--jot-live-list-marker-column))",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-live-preview-list-item::before": {
    insetInlineStart: "calc(var(--jot-live-quote-inset) + var(--jot-live-list-effective-indent))",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote:dir(rtl)": {
    backgroundPosition: "right top",
  },
  // Block replacement widgets live inside CodeMirror's line shell. The shell
  // must not contribute a second line-height, otherwise every Preview block
  // acquires an artificial blank row and vertical navigation uses the wrong
  // geometry.
  ".cm-content.jot-live-preview-content .cm-line:has(.jot-live-preview-widget--block)": {
    minHeight: "0",
    paddingBlock: "0",
    borderBlock: "0",
    lineHeight: "0",
  },
  // Clear CodeMirror's default line inset inside source shells. Quote shells
  // use the more specific per-line rules above for confirmed nesting; their
  // opening and closing padding is counted only where a quote starts or ends.
  ".cm-content.jot-live-preview-content .jot-live-preview-source-block-shell > .cm-line": {
    paddingInline: "0",
    paddingBlock: "0",
    borderBlock: "0",
  },
  // Both quote states use the same marker-free wrapping geometry.
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-block-quote": {
    // CodeMirror lineWrapping uses `break-spaces`, while Preview inline text
    // uses `pre-wrap`. For a long quote the two algorithms can choose
    // different trailing-space break opportunities and add a whole physical
    // source line. Quote source explicitly adopts Preview's wrapping contract.
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
    position: "relative",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-widget--block": {
    verticalAlign: "top",
    // `.cm-line` itself stays at zero line-height to avoid a residual
    // CodeMirror row. The block widget must immediately restore a semantic
    // line-height; otherwise `0` inherits into source/deferred text and every
    // paragraph is painted on the same baseline.
    lineHeight: "var(--jot-paragraph-line-height)",
  },
  ".cm-content.jot-live-preview-content h1.jot-live-preview-widget--block": {
    lineHeight: "var(--jot-heading-1-line-height)",
  },
  ".cm-content.jot-live-preview-content h2.jot-live-preview-widget--block": {
    lineHeight: "var(--jot-heading-2-line-height)",
  },
  ".cm-content.jot-live-preview-content h3.jot-live-preview-widget--block": {
    lineHeight: "var(--jot-heading-3-line-height)",
  },
  ".cm-content.jot-live-preview-content h4.jot-live-preview-widget--block": {
    lineHeight: "var(--jot-heading-4-line-height)",
  },
  ".cm-content.jot-live-preview-content h5.jot-live-preview-widget--block": {
    lineHeight: "var(--jot-heading-5-line-height)",
  },
  ".cm-content.jot-live-preview-content h6.jot-live-preview-widget--block": {
    lineHeight: "var(--jot-heading-6-line-height)",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-widget--fenced-code": {
    lineHeight: "var(--jot-code-line-height)",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-widget--math-block": {
    lineHeight: "var(--jot-math-line-height)",
  },
  // 标题级别由 Rust RenderNode -> Planner line attributes 统一传入。选择器
  // 只依赖统一 class + level attribute，不再存在只命中 h1 的独立分支。
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading[data-jot-heading-level=\"1\"]": {
    fontSize: "var(--jot-heading-1-font-size)",
    lineHeight: "var(--jot-heading-1-line-height)",
    fontWeight: "700",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading[data-jot-heading-level=\"2\"]": {
    fontSize: "var(--jot-heading-2-font-size)",
    lineHeight: "var(--jot-heading-2-line-height)",
    fontWeight: "700",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading[data-jot-heading-level=\"3\"]": {
    fontSize: "var(--jot-heading-3-font-size)",
    lineHeight: "var(--jot-heading-3-line-height)",
    fontWeight: "700",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading[data-jot-heading-level=\"4\"]": {
    fontSize: "var(--jot-heading-4-font-size)",
    lineHeight: "var(--jot-heading-4-line-height)",
    fontWeight: "700",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading[data-jot-heading-level=\"5\"]": {
    fontSize: "var(--jot-heading-5-font-size)",
    lineHeight: "var(--jot-heading-5-line-height)",
    fontWeight: "700",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading[data-jot-heading-level=\"6\"]": {
    fontSize: "var(--jot-heading-6-font-size)",
    lineHeight: "var(--jot-heading-6-line-height)",
    fontWeight: "700",
  },
  // CM inserts zero-width image buffers around hidden heading syntax. Their
  // default 1em height can exceed a configured heading line-height and move
  // every following block. They still provide cursor boundaries at zero size.
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-heading > .cm-widgetBuffer": {
    height: "0",
    verticalAlign: "baseline",
  },
  // CodeMirror gives a new empty physical row a lone BR before projection.
  // Match the confirmed blank metrics on that native row from its first frame.
  [`${unprojectedBlankLine}, .cm-content.jot-live-preview-content .cm-line.jot-live-preview-blank-line`]: {
    minHeight: "var(--jot-blank-line-height)",
    lineHeight: "var(--jot-blank-line-height)",
    paddingBlock: "0",
    borderBlock: "0",
  },
  // A root blank row is the same editing position as the paragraph that the
  // first input creates. Do not retain CM's default 6px line inset here.
  [`${unprojectedBlankLine}, .cm-content.jot-live-preview-content .cm-line.jot-live-preview-blank-line:not(.jot-live-preview-native-block--block-quote):not(.jot-live-preview-list-item):not(.jot-live-preview-source-fenced-code):not(.jot-live-preview-source-math-block)`]: {
    paddingInline: "var(--jot-paragraph-padding-x)",
  },
  // Closed math delimiters remain in the CodeMirror document but are not a
  // Live Preview editing surface. Their marker-only physical lines collapse;
  // the active source shell keeps the measured rendered block height.
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-structural-line": {
    boxSizing: "border-box",
    minHeight: "0",
    height: "0",
    lineHeight: "0",
    paddingBlock: "0",
    borderBlock: "0",
    overflow: "hidden",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-line:not(.jot-live-preview-blank-line):not([data-jot-quote-marker-only='true']):not(.jot-live-preview-source-heading):not(.jot-live-preview-source-fenced-code):not(.jot-live-preview-source-math-block)": {
    lineHeight: "var(--jot-paragraph-line-height)",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-fenced-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    lineHeight: "var(--jot-code-line-height)",
    whiteSpace: "pre",
    overflowWrap: "normal",
    wordBreak: "normal",
  },
  // Quoted code has no separate scroll wrapper. Preserve the configured code
  // background when the quote becomes active instead of tinting every code
  // row only after the next confirmed projection.
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-native-block--block-quote.jot-live-preview-source-fenced-code": {
    backgroundColor: "var(--jot-code-background, color-mix(in srgb, currentColor 5%, transparent))",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-source-math-block": {
    fontFamily: "serif",
    lineHeight: "var(--jot-math-line-height)",
  },
  ".cm-content.jot-live-preview-content .cm-line.jot-live-preview-code-boundary": {
    height: "var(--jot-code-padding-half)",
    minHeight: "var(--jot-code-padding-half)",
    lineHeight: "0",
    paddingBlock: "0",
    borderBlock: "0",
    overflow: "hidden",
  },
  ".jot-live-preview-inline-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: ".92em",
    padding: "0 .18em",
    backgroundColor: "var(--jot-code-background, color-mix(in srgb, currentColor 8%, transparent))",
  },
  // Active source keeps Markdown delimiters visible, but the semantic link
  // label retains Preview's underline token. This is a visual source skin,
  // not a second parser or a hidden-range decoration.
  ".cm-content.jot-live-preview-content .jot-live-preview-source-link": {
    color: "var(--jot-link-color, LinkText)",
    textDecorationLine: "underline",
    textDecorationThickness: "from-font",
    textUnderlineOffset: ".12em",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-source-strong": {
    fontWeight: "700",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-source-emphasis": {
    fontStyle: "italic",
  },
  ".cm-content.jot-live-preview-content .jot-live-preview-source-inline-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: ".92em",
    padding: "0 .18em",
    backgroundColor: "var(--jot-code-background, color-mix(in srgb, currentColor 8%, transparent))",
  },
  ".jot-live-preview-table-cell--active": {
    backgroundColor: "color-mix(in srgb, currentColor 11%, transparent)",
    boxShadow: "inset 0 0 0 2px color-mix(in srgb, currentColor 48%, transparent)",
    position: "relative",
  },
  ".jot-live-preview-table-cell--selected": {
    backgroundColor: "color-mix(in srgb, Highlight 22%, transparent)",
  },
  ".jot-live-preview-table-cell--active::after": {
    content: "\"\"",
    position: "absolute",
    zIndex: "3",
    insetInlineStart: "var(--jot-live-table-caret-inline-start, 0px)",
    insetBlockStart: "var(--jot-live-table-caret-block-start, 0px)",
    blockSize: "var(--jot-live-table-caret-height, 1em)",
    inlineSize: "1px",
    minInlineSize: "1px",
    backgroundColor: "currentColor",
    pointerEvents: "none",
    animation: "jot-live-preview-table-caret-blink 1s steps(1, end) infinite",
  },
  ".jot-live-preview-table-cell--ime::after": {
    visibility: "hidden",
  },
  // Persistent browser input sink for the active mapped cell. It is focused
  // before compositionstart so the OS never binds IME to hidden Markdown. The
  // one-pixel box anchors the candidate window but cannot paint composition
  // text over the rendered cell.
  ".jot-live-preview-table-ime": {
    display: "none",
    position: "absolute",
    zIndex: "20",
    boxSizing: "border-box",
    inlineSize: "1px",
    minInlineSize: "1px",
    maxInlineSize: "1px",
    margin: "0",
    padding: "0",
    border: "0",
    outline: "none",
    resize: "none",
    overflow: "hidden",
    whiteSpace: "pre",
    backgroundColor: "transparent",
    color: "transparent",
    caretColor: "transparent",
    textShadow: "none",
    pointerEvents: "none",
  },
  ".jot-live-preview-table-ime--active": {
    display: "block",
  },
  "@keyframes jot-live-preview-table-caret-blink": {
    "0%, 48%": { opacity: "1" },
    "49%, 100%": { opacity: "0" },
  },
  ".jot-live-preview-table-focus-active .cm-cursor": {
    visibility: "hidden",
  },
  // Quote rows already have their semantic block background. Applying the
  // root-wide active tint only after selection reconciliation makes the
  // entire quote flash when a caret enters it; keep that background stable.
  ".jot-live-preview-active-line:not(.jot-live-preview-native-block--block-quote)": {
    backgroundColor: "color-mix(in srgb, currentColor 4%, transparent)",
  },
  ".jot-live-preview-dirty-line": { opacity: ".86" },
  ".jot-live-preview-widget": { maxWidth: "100%" },
  ".cm-content.jot-live-preview-content .jot-live-preview-widget--source-companion": {
    display: "block",
  },
  ".jot-live-preview-widget--geometry": {
    pointerEvents: "none",
    opacity: "0",
    overflow: "hidden",
    contain: "layout paint",
  },
  ".jot-live-preview-widget--selected": {
    backgroundColor: "color-mix(in srgb, Highlight 24%, transparent)",
  },
  // Keep the whole formula atomic for line wrapping. An inline outer span
  // lets CodeMirror's widget boundary push the inner KaTeX box past the line.
  ".jot-live-preview-widget--inline-math": {
    display: "inline-block",
    width: "max-content",
    maxWidth: "100%",
    verticalAlign: "middle",
    overflowX: "auto",
  },
  ".jot-live-preview-widget--image": { display: "inline-block", verticalAlign: "middle" },
  ".jot-live-preview-widget--math-block": {
    display: "block",
    boxSizing: "border-box",
    maxWidth: "100%",
    overflowX: "auto",
  },
});
