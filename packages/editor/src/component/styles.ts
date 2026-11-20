export const MARKDOWN_EDITOR_CSS = `
.jot-markdown-editor {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  contain: layout style;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  color: var(--jot-text-color, CanvasText);
  background: var(--jot-background, Canvas);
}
.jot-markdown-editor[data-jot-editor-mode="split"] {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.jot-markdown-editor--with-toolbar {
  grid-template-rows: auto minmax(0, 1fr);
}
.jot-editor-toolbar {
  position: relative;
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--jot-toolbar-gap, 4px 8px);
  padding: var(--jot-toolbar-padding, 4px 10px);
  color: var(--jot-toolbar-text, inherit);
  background: var(--jot-toolbar-background, color-mix(in srgb, var(--jot-background, Canvas) 97%, currentColor));
  border-block-end: 1px solid color-mix(in srgb, currentColor 14%, transparent);
}
.jot-editor-toolbar__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.jot-editor-toolbar__group:not([hidden]) ~ .jot-editor-toolbar__group {
  border-inline-start: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  padding-inline-start: 8px;
}
.jot-editor-toolbar[hidden], .jot-editor-toolbar__group[hidden] { display: none; }
.jot-editor-toolbar__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-inline-size: var(--jot-toolbar-button-size, 34px);
  min-block-size: var(--jot-toolbar-button-size, 34px);
  border: 0;
  border-radius: var(--jot-toolbar-button-radius, 6px);
  padding: 0 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.jot-editor-toolbar__button[hidden] { display: none; }
.jot-editor-toolbar__button svg { width: var(--jot-toolbar-icon-size, 19px); height: var(--jot-toolbar-icon-size, 19px); }
.jot-editor-toolbar__button .jot-editor-toolbar__chevron { width: 12px; height: 12px; }
.jot-editor-toolbar__button:disabled { opacity: .4; cursor: default; }
.jot-editor-toolbar__button:hover:not(:disabled),
.jot-editor-toolbar__button[aria-expanded="true"] {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.jot-editor-toolbar :focus-visible { outline: 2px solid var(--jot-toolbar-accent, var(--jot-link-color, currentColor)); outline-offset: -2px; }
.jot-editor-toolbar__status {
  position: absolute;
  z-index: 1;
  inset-block-start: calc(100% + 4px);
  inset-inline-end: 6px;
  max-inline-size: calc(100% - 12px);
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 5px;
  background: var(--jot-background, Canvas);
  font: 12px/1.4 system-ui, sans-serif;
  pointer-events: none;
}
.jot-editor-toolbar__picker {
  --jot-toolbar-picker-accent: var(--jot-toolbar-accent, var(--jot-link-color, currentColor));
  --jot-toolbar-picker-rule: color-mix(in srgb, currentColor 16%, transparent);
  box-sizing: border-box;
  position: fixed;
  inset: auto;
  margin: 0;
  width: max-content;
  max-width: calc(100vw - 12px);
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--jot-toolbar-picker-rule);
  border-radius: 10px;
  background: var(--jot-toolbar-picker-background, var(--jot-background, Canvas));
  color: var(--jot-text-color, CanvasText);
  color-scheme: inherit;
  box-shadow: 0 8px 24px #0003;
  font: 13px/1.4 system-ui, sans-serif;
}
.jot-editor-toolbar__picker button {
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.jot-editor-toolbar__picker button:hover {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.jot-editor-toolbar__picker--heading button,
.jot-editor-toolbar__picker--more button {
  display: block;
  inline-size: 100%;
  min-inline-size: 144px;
  padding: 4px 12px;
  text-align: start;
  font-size: var(--jot-toolbar-heading-size, 13px);
  font-weight: 600;
}
.jot-editor-toolbar__picker--heading [aria-current="true"] {
  color: var(--jot-toolbar-picker-accent);
  background: color-mix(in srgb, var(--jot-toolbar-picker-accent) 12%, transparent);
}
.jot-editor-toolbar__picker--table { width: 264px; padding: 12px; }
.jot-editor-toolbar__table-grid {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 4px;
}
.jot-editor-toolbar__table-grid button {
  aspect-ratio: 1;
  border: 1px solid var(--jot-toolbar-picker-rule);
  border-radius: 3px;
}
.jot-editor-toolbar__table-grid button[data-selected] {
  background: color-mix(in srgb, var(--jot-toolbar-picker-accent) 18%, transparent);
  border-color: var(--jot-toolbar-picker-accent);
}
.jot-editor-toolbar__table-size { text-align: center; padding-block: 6px; font-variant-numeric: tabular-nums; }
.jot-editor-toolbar__table-form { display: grid; gap: 10px; border-block-start: 1px solid var(--jot-toolbar-picker-rule); padding-block-start: 8px; }
.jot-editor-toolbar__dimensions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.jot-editor-toolbar__dimensions label { display: grid; gap: 3px; }
.jot-editor-toolbar__dimensions input {
  box-sizing: border-box;
  inline-size: 100%;
  padding: 5px 8px;
  border: 1px solid var(--jot-toolbar-picker-rule);
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
}
.jot-editor-toolbar__table-form button {
  justify-self: end;
  padding: 6px 10px;
  color: var(--jot-toolbar-picker-accent);
  background: color-mix(in srgb, var(--jot-toolbar-picker-accent) 12%, transparent);
  font-weight: 600;
}
.jot-markdown-editor__input,
.jot-markdown-editor__surface {
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
}
.jot-markdown-editor__input {
  /* 滚动权属于 CodeMirror 的 cm-scroller。避免外层和 CodeMirror 同时出现
     横/纵滚动条，并保证 Live Preview 的视口宽度有唯一来源。 */
  overflow: hidden;
}
.jot-markdown-editor__surface {
  overflow: auto;
}
.jot-markdown-editor__input > .cm-editor {
  font-size: inherit;
  height: 100%;
  min-height: 100%;
  min-width: 0;
}
.jot-markdown-editor__input .cm-scroller {
  min-width: 0;
  line-height: var(--jot-paragraph-line-height, 22px);
}
.jot-markdown-editor__input > .cm-editor.cm-focused {
  outline: none;
}

/* Live Preview 仍由 CodeMirror 承载选区，但视觉内容来自共享 RenderRuntime。
   清掉 source 宿主常用的等宽字体、代码背景和额外 padding，避免同一
   RenderNode 在 Preview 与 Live Preview 中出现两套排版。具体纸张颜色与外层
   留白由宿主主题决定，组件只提供模式边界。 */
.jot-markdown-editor[data-jot-editor-mode="live-preview"] .jot-markdown-editor__input {
  /* CodeMirror 的 cm-scroller 是唯一物理滚动宿主；外层不能再形成第二条轴。 */
  overflow: hidden;
}
.jot-markdown-editor[data-jot-editor-mode="live-preview"] .jot-markdown-editor__input > .cm-editor {
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
}
.jot-markdown-editor[data-jot-editor-mode="live-preview"] .jot-markdown-editor__input .cm-scroller {
  padding: 0;
  font-family: inherit;
}
.jot-markdown-editor[data-jot-editor-mode="live-preview"] .jot-markdown-editor__input .cm-content {
  min-height: 100%;
  padding: 0;
}
.jot-command-overlay{position:absolute;inset:0;z-index:20;background:#0003;display:flex;align-items:flex-start;justify-content:center;padding:16px;box-sizing:border-box}
.jot-command-overlay[hidden]{display:none}
.jot-command-dialog{width:min(560px,100%);max-height:100%;overflow:auto;padding:12px;box-sizing:border-box;border:1px solid #8886;border-radius:8px;background:var(--jot-background,Canvas);color:var(--jot-text-color,CanvasText);box-shadow:0 8px 30px #0002;font:13px/1.45 system-ui,sans-serif}
.jot-command-dialog__header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.jot-command-dialog input{box-sizing:border-box;max-width:100%;font:inherit;padding:4px 6px}
.jot-command-dialog input[type=search]{width:100%}
.jot-command-list{max-height:320px;overflow:auto;margin-top:8px}
.jot-command-list button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;border:0;border-radius:4px;padding:6px 8px;text-align:start;background:transparent;color:inherit;font:inherit;cursor:pointer}
.jot-command-list button[aria-selected=true]{background:Highlight;color:HighlightText}
.jot-command-list small{display:block;opacity:.75;font-size:12px}
.jot-command-list kbd{white-space:nowrap;font-size:12px}
.jot-command-status{font-size:12px;margin-bottom:0}
.jot-shortcut-settings__row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 0}
.jot-markdown-editor .cm-gutters:has(> .jot-heading-fold-gutter:only-child){background:transparent;border:0}
.jot-markdown-editor .cm-gutter.jot-heading-fold-gutter{width:var(--jot-heading-fold-gutter-width,1.5em);min-width:var(--jot-heading-fold-gutter-width,1.5em);overflow:visible;background:transparent;border:0;color:var(--jot-text-color,CanvasText)}
.jot-heading-fold-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:var(--jot-heading-fold-button-size,20px);height:var(--jot-heading-fold-button-size,20px);padding:0;border:0;border-radius:2px;background:transparent;color:var(--jot-heading-fold-color,inherit);font-family:var(--jot-heading-fold-icon-font,system-ui,sans-serif);font-size:var(--jot-heading-fold-font-size,20px);font-weight:normal;line-height:1;cursor:pointer;opacity:var(--jot-heading-fold-opacity,.7)}
.jot-heading-fold-gutter .jot-heading-fold-button{position:relative;inset-inline-start:var(--jot-heading-fold-offset,0px)}
.jot-heading-fold-button::before{content:var(--jot-heading-fold-expanded-icon,"⌄")}
.jot-heading-fold-button[aria-expanded="false"]::before{content:var(--jot-heading-fold-collapsed-icon,"›")}
.jot-heading-fold-button[aria-busy="true"]::before{content:var(--jot-heading-fold-pending-icon,"…")}
.jot-heading-fold-button:hover,.jot-heading-fold-button:focus-visible{opacity:1;background:var(--jot-heading-fold-hover-background,color-mix(in srgb,currentColor 8%,transparent))}
.jot-heading-fold-button:focus-visible{outline:1px solid var(--jot-heading-fold-focus-color,currentColor);outline-offset:1px}
.jot-editor-content.jot-heading-fold-enabled{box-sizing:border-box;padding-inline-start:var(--jot-heading-fold-gutter-width,1.5em)}
.jot-editor-content [data-jot-kind="heading"],.jot-pretext-block--heading{position:relative}
.jot-editor-content.jot-heading-fold-enabled .jot-pretext-block--heading{overflow:visible;contain:layout}
.jot-editor-content [data-jot-kind="heading"] > .jot-heading-fold-button,.jot-pretext-block--heading > .jot-heading-fold-button{position:absolute;inset-inline-start:calc(-1 * var(--jot-heading-fold-button-size,20px));top:0}
.jot-heading-fold-placeholder{color:inherit;opacity:.65;cursor:pointer;white-space:nowrap}
`;

const installed = new WeakSet<Document>();

export function installMarkdownEditorStyles(document: Document): void {
  if (installed.has(document)) return;
  const style = document.createElement("style");
  style.dataset["jotMarkdownEditorStyles"] = "";
  style.textContent = MARKDOWN_EDITOR_CSS;
  document.head.append(style);
  installed.add(document);
}
