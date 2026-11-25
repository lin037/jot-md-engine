# Markdown Dialect & Extensions

**English** · [简体中文](../zh-CN/guides/markdown.md)

Jot implements a fast, predictable Markdown dialect designed for line-oriented incremental editing and clean source preservation. Most standard Markdown and GFM constructs work as expected, with a few explicit rules around physical lines, code fences, block quotes, and list continuations.

## Supported Syntax

| Construct | Syntax & Behavior |
| --- | --- |
| Headings | ATX headings `# Title` through `###### Title` (requires space or tab after `#` when text is present). |
| Thematic breaks | A standalone line with 3 or more matching `-`, `*`, or `_` characters (spaces allowed between markers). |
| Inline formatting | `**bold**`, `*italic*`, `~~strikethrough~~`, and `` `inline code` `` (delimiters inside code are preserved literally). |
| Links & images | `[text](url)`, `![alt](url)`, `<https://example.org>`, `<user@example.org>`. Balanced parentheses in URLs are supported. |
| Lists & tasks | Unordered (`-`, `*`, `+`), ordered (`1.`, `1)`), and task items (`- [ ]`, `- [x]`). Ordered items preserve source numbers. |
| Math | Inline `$x+y$` or `\(x+y\)` on a single physical line. Block math via standalone `$$` / `$$`, `\[` / `\]`, or single-line `\[x+y\]`. |
| Tables | GFM pipe tables. Header and delimiter row column counts must match; delimiter columns require at least three `-` (`:---`, `:---:`, `---:`). Escaped or code-wrapped pipes remain cell content. |
| Raw HTML | Displayed safely as literal text rather than injected as raw DOM HTML. |

## Key Design Differences

### Physical-Line Paragraphs

Every normal physical line is parsed as its own paragraph node, and blank lines retain explicit positions in the syntax tree. Setext headings (`---` under text) are intentionally not used—`---` on the following line parses as a paragraph followed by a thematic break.

### Code Fences

By default, backtick fences use three backticks with a single ASCII space before the language name:

````markdown
``` rust
let count = 3;
```
````

To display nested bare fences safely inside a Markdown block, you can pair `begin` and `end`:

````markdown
``` markdown begin
``` rust
let count = 3;
```
``` end
````

Tilde fences (`~~~` or longer) accept an attached language name directly and close with a matching or longer tilde line:

````markdown
~~~~js
const marker = "~~~";
~~~~
````

#### CommonMark Language Extension

To allow standard CommonMark attached language names on backtick fences (such as ```` ```ts ```` or ```` ```mermaid ````), enable the built-in extension in `syntaxProfile`:

```ts
syntaxProfile: {
  id: "default",
  version: 1,
  enabledExtensions: [{ id: "commonmark-fence-language", version: "1.0.0" }],
}
```

With a single caret at the end of an opening fence, press `Enter` to complete the pair and move inside the block. If the fence is already paired and its first line is empty, the caret moves there. Use `Shift+Enter` for a plain newline, or turn off completion with `input: { autoCloseCodeFences: false }`.

Unclosed opening fences or math blocks remain plain text when loading a document so that subsequent headings and paragraphs parse independently.

### Block Quotes

Every physical line inside a block quote carries its own `>` prefix (a bare `>` denotes an empty line within the quote):

```markdown
> Level 1
> > Level 2
>
> Next paragraph in the same quote
Outside the quote
```

Up to three leading ASCII spaces are allowed before each `>`, followed by an optional space or tab. Both `>> text` and `> > text` create nested quotes. Headings, lists, tables, and closed code blocks can appear inside quotes (in Live Preview, tables inside quotes stay as source lines; switch to Split or Preview to inspect rendered quoted tables).

### List Item Continuations

Pressing `Enter` starts the next list item (or exits the list on an empty item). Pressing `Shift+Enter` inside a confirmed list item in Live Preview inserts two trailing spaces, a newline, and indents the continuation line to the item's content column:

```text
- First line··
··Still part of item one
- Second item
```

*(Dots `·` indicate space positions.)* When authoring manually, indent the continuation line to at least the item's content column; a line starting with another list marker begins a new item.
