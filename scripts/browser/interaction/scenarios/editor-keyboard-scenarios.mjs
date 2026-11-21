import assert from 'node:assert/strict';

/** Native component integration: after loading, every editing action is a real key. */
export async function runKeyboardScenarios({ c, load, settle, confirmed, key, screenshot, results }) {
  const mac = await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`);
  const mod = mac ? 4 : 2;
  const editorMod = mac ? 2 : mod;
  async function press(name, { modifier = 0, shift = false } = {}) {
    const modifiers = modifier | (shift ? 8 : 0);
    const code = /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name === ' ' ? 'Space' : name;
    const key = shift && /^[a-z]$/i.test(name) ? name.toUpperCase() : name;
    const virtual = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ' ': 32, F3: 114, ArrowDown: 40, ArrowUp: 38 }[name]
      ?? (/^[a-z]$/i.test(name) ? name.toUpperCase().charCodeAt(0) : undefined);
    await c.command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers,
      ...(name === 'Enter' && modifiers === 0 ? { text: '\r', unmodifiedText: '\r' } : {}),
      // Chromium's macOS embedding normally translates Cmd-A into this edit
      // command. CDP bypasses that OS translation; send it with the real key
      // event, rather than changing input.selectionStart from page script.
      ...(name.toLowerCase() === 'a' && modifier === mod && !shift ? { commands: ['selectAll'] } : {}),
      ...(virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }) });
    await c.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  }
  async function text(value) { await c.command('Input.insertText', { text: value }); }
  async function selectFieldText() {
    await press('a', { modifier: mod });
    assert(await c.evaluate(`(()=>{const field=document.activeElement;return field instanceof HTMLInputElement&&field.selectionStart===0&&field.selectionEnd===field.value.length;})()`),
      'platform select-all shortcut selects the native text field');
  }
  async function focused(selector) { return c.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)}) ?? false`); }
  async function tabTo(selector) {
    const limit = Math.max(24, await c.evaluate(`document.querySelectorAll('input:not(:disabled),button:not(:disabled)').length + 2`));
    for (let attempt = 0; attempt < limit; attempt++) {
      if (await focused(selector)) return;
      await press('Tab');
    }
    assert.fail(`keyboard Tab failed to reach ${selector}`);
  }
  async function fresh(source, from = 0, to = from) {
    await c.evaluate(`(async()=>{editor.input.closeSearch(); editor.setReadOnly(false); await editor.setMode('live-preview'); document.querySelector('#integration').style.width='900px';})()`);
    await load(source);
    await c.evaluate(`editor.input.setSelection(${from},${to}); editor.focus()`);
    await settle();
  }
  async function searchFor(query) {
    console.log('[keyboard] search', query);
    await press('f', { modifier: mod });
    assert(await focused('.cm-search input[name=search]'), 'Mod-f focuses the native search field');
    await selectFieldText();
    await text(query);
    await press('Enter');
    await settle();
  }
  async function matchBox(expected) {
    const actual = await c.evaluate(`(()=>{
      const s=view.state.selection.main,p=view.scrollDOM.getBoundingClientRect(),r=view.coordsAtPos(s.from);
      return {text:view.state.sliceDoc(s.from,s.to),from:s.from,to:s.to,top:view.scrollDOM.scrollTop,
        mounted:view.contentDOM.querySelectorAll('.cm-line').length,
        caret:r&&{top:r.top,bottom:r.bottom},pane:{top:p.top,bottom:p.bottom},
        painted:view.contentDOM.textContent};
    })()`);
    assert.equal(actual.text, expected, 'search selects the exact UTF-16 source match');
    assert(actual.caret && actual.caret.bottom > actual.caret.top, 'search match owns a nonempty painted line box');
    assert(actual.caret.top >= actual.pane.top - 1 && actual.caret.bottom <= actual.pane.bottom + 1,
      'offscreen search match is revealed within the actual scroller');
    assert(actual.painted.includes(expected), 'selected source match is visible in rendered DOM');
    return { ...actual, painted: undefined };
  }

  if (!process.env.JOT_SEARCH_REPLACE_ONLY) {
  const large = 'start needle-end\n\n' + Array.from({ length: 20_000 }, (_, i) => `paragraph ${i}`).join('\n\n') + '\n\nfinish needle-end';
  console.log('[keyboard] load 20,000 paragraphs');
  await fresh(large);
  console.log('[keyboard] loaded');
  await searchFor('needle-end');
  const first = await matchBox('needle-end');
  await press('Enter'); await settle();
  const last = await matchBox('needle-end');
  console.log('[keyboard] offscreen match',last.from);
  assert.equal(last.from, large.lastIndexOf('needle-end'));
  assert(last.top > 100_000, 'search crosses a virtualized document, not only mounted nodes');
  assert(last.mounted < 200, 'full document search keeps bounded native DOM');
  await press('Enter', { shift: true }); await settle();
  assert.equal((await matchBox('needle-end')).from, first.from, 'Shift-Enter selects the previous match');
  await press(mac ? 'g' : 'F3', { modifier: mac ? 2 : 0 }); await settle();
  assert.equal((await matchBox('needle-end')).from, last.from, 'Find Next shares the same search state');
  await press('Escape'); await settle();
  assert(await c.evaluate('view.hasFocus'), 'Escape returns from search to native source input');
  results.push({ case: 'keyboard-full-document-search', first, last });
  await screenshot('keyboard-full-document-search');

  for (const [name, source, query] of [
    ['formula', 'intro\n\n$$\nhiddenformula + x\n$$\n\nend', 'hiddenformula'],
    ['code-fence', 'intro\n\n``` js begin\nconst value = 1;\n``` end\n\nend', 'js begin'],
  ]) {
    await fresh(source);
    await searchFor(query);
    const found = await matchBox(query);
    await press('Escape'); await settle();
    assert(await c.evaluate('view.hasFocus'));
    assert.equal(await c.evaluate('editor.value'), source, 'search reveal does not change Markdown');
    results.push({ case: `keyboard-search-hidden-${name}`, found });
    await screenshot(`keyboard-search-hidden-${name}`);
  }

  }
  console.log('[keyboard] replace all');
  const original = '# token1\n\n> token2\n\n``` js begin\ntoken3\n``` end';
  await fresh(original);
  await press('f', { modifier: mod });
  await text('token(\\d)');
  await tabTo('.cm-search input[name=re]'); await press(' ');
  await press('h', { modifier: editorMod, shift: true });
  assert(await focused('.cm-search input[name=replace]'), 'replace shortcut focuses native replacement field');
  await text('value-$1');
  await tabTo('.cm-search button[name=replaceAll]'); await press('Enter'); await confirmed();
  const replaced = await c.evaluate('editor.value');
  assert.equal(replaced, original.replace(/token(\d)/gu, 'value-$1'), 'regex capture replacement crosses different Markdown blocks');
  await press('Escape'); await press('z', { modifier: mod }); await confirmed();
  assert.equal(await c.evaluate('editor.value'), original, 'replace-all is restored by a single undo');
  await press('z', { modifier: mod, shift: true }); await confirmed();
  assert.equal(await c.evaluate('editor.value'), replaced, 'replace-all redoes through native history');
  await press('z', { modifier: mod }); await confirmed();
  results.push({ case: 'keyboard-regex-replace-all-history', original, replaced });
  await screenshot('keyboard-replace-all-undo');

  await press('f', { modifier: mod });
  await selectFieldText(); await text('['); await settle();
  assert(await c.evaluate(`document.querySelector('.cm-search input[name=search]').getAttribute('aria-invalid')==='true'`), 'invalid regex is reported in the real search UI');
  await press('Enter');
  assert.equal(await c.evaluate('editor.value'), original, 'invalid query cannot modify the source');
  await selectFieldText(); await text('token');
  await c.evaluate('editor.setReadOnly(true)'); await settle();
  assert(await c.evaluate(`[...document.querySelectorAll('.cm-search input[name=replace], .cm-search button[name=replace], .cm-search button[name=replaceAll]')].every(n=>n.disabled)`), 'read-only changes disable every native replacement control while open');
  await press('Enter'); await settle();
  await matchBox('token');
  await press('h', { modifier: editorMod, shift: true });
  assert(!(await focused('.cm-search input[name=replace]')), 'read-only replace shortcut keeps focus in searchable controls');
  assert.equal(await c.evaluate('editor.value'), original);
  await c.evaluate('editor.setReadOnly(false)'); await settle();
  assert(await c.evaluate(`!document.querySelector('.cm-search input[name=replace]').disabled`), 'leaving read-only restores replacement controls');
  await press('Escape');
  results.push({ case: 'keyboard-search-readonly-invalid-regex' });

  // 大文档防抖期间，面板外调用 replaceAll()/searchQuery 必须读取面板当前显示的新词。
  const debouncedReplaceDoc = `red blue\n${'filler line\n'.repeat(4000)}`;
  await fresh(debouncedReplaceDoc);
  await c.evaluate(`(async () => {
    await editor.openSearch();
    editor.setSearchQuery({ search: 'red', replace: 'green' });
  })()`);
  const debouncedReplace = await c.evaluate(`(() => {
    const input = document.querySelector('.cm-search input[name=search]');
    input.value = 'blue';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const queryBeforeReplace = editor.searchQuery.search;
    const replaced = editor.replaceAll();
    return {
      queryBeforeReplace,
      replaced,
      firstLine: editor.value.split('\\n', 1)[0],
    };
  })()`);
  await confirmed();
  assert.equal(debouncedReplace.queryBeforeReplace, 'blue', 'public searchQuery reflects pending panel input during debounce');
  assert.equal(debouncedReplace.replaced, true, 'external replaceAll executes against pending panel input');
  assert.equal(debouncedReplace.firstLine, 'red green', 'external replaceAll replaces the live panel query rather than the stale pre-debounce query');
  await press('Escape');
  results.push({ case: 'keyboard-search-debounced-external-replace-all', ...debouncedReplace });

  await fresh('keyboard text', 0, 8);
  await press('p', { modifier: editorMod, shift: true }); await settle();
  assert(await c.evaluate(`document.activeElement instanceof HTMLInputElement && !view.contentDOM.contains(document.activeElement)`), 'command palette opens and owns keyboard focus');
  await text('加粗'); await press('Enter'); await confirmed();
  assert.equal(await c.evaluate('editor.value'), '**keyboard** text', 'palette executes semantic edit on original source selection');
  assert(await c.evaluate('view.hasFocus'), 'executing palette command returns focus to source input');
  await press('z', { modifier: mod }); await confirmed();
  assert.equal(await c.evaluate('editor.value'), 'keyboard text');
  results.push({ case: 'keyboard-command-palette-format' });
  await screenshot('keyboard-command-palette-format');

  await fresh('intro');
  await press('p', { modifier: editorMod, shift: true }); await settle();
  await text('插入代码块'); await press('Enter'); await confirmed();
  assert(await c.evaluate('editor.value.includes("``` js begin") || editor.value.includes("``` text begin") || /```[^\\n]*begin/.test(editor.value)'), 'palette inserts the supported fenced container grammar');
  assert(await c.evaluate('view.hasFocus'), 'insert-block command returns native keyboard focus');
  await text('keyboardCode'); await confirmed();
  assert(await c.evaluate(`view.contentDOM.textContent.includes('keyboardCode') && editor.value.includes('keyboardCode')`), 'inserted code content accepts keyboard input and paints it');
  results.push({ case: 'keyboard-command-palette-insert-code', source: await c.evaluate('editor.value') });
  await screenshot('keyboard-command-palette-insert-code');

  await fresh('intro');
  await press('p', { modifier: editorMod, shift: true }); await settle();
  await text('插入表格');
  assert.equal(await c.evaluate(`document.querySelector('.jot-command-dialog [role=option][aria-selected=true]')?.dataset.jotCommand`),
    'insert.table', 'an exact command title ranks before other table operations containing the same words');
  await screenshot('keyboard-command-palette-table-menu');
  await press('Enter');
  // Do not wait for Rust or projection between insertion and the first input:
  // a keyboard workflow must retain the target while the table is confirmed.
  await text('keyboardCell'); await confirmed();
  const insertedTable = await c.evaluate(`(()=>{
    const cell=[...view.dom.querySelectorAll('.jot-table-grid-body .jot-table-cell')].find(n=>n.textContent==='keyboardCell');
    const rect=cell?.getBoundingClientRect(),pane=view.scrollDOM.getBoundingClientRect();
    const selection=view.state.selection.main;
    return {source:editor.value,selection:{from:selection.from,to:selection.to},cell:rect&&{text:cell.textContent,column:Number(cell.dataset.jotColumnIndex),from:Number(cell.dataset.jotSourceFrom),to:Number(cell.dataset.jotSourceTo),top:rect.top,bottom:rect.bottom,height:rect.height,width:rect.width},pane:{top:pane.top,bottom:pane.bottom}};
  })()`);
  assert(/\|[ \t]*keyboardCell[ \t]*\|/u.test(insertedTable.source), 'immediate input belongs to the inserted Markdown table cell');
  assert(insertedTable.cell && insertedTable.cell.width > 0 && insertedTable.cell.height > 0, 'inserted table paints the typed cell as a real box');
  assert.equal(insertedTable.cell.column, 0, 'insertion keeps the first body column selected');
  assert.equal(insertedTable.cell.from, insertedTable.source.indexOf('keyboardCell'), 'painted cell begins at the typed source range');
  assert.equal(insertedTable.cell.to, insertedTable.cell.from + 'keyboardCell'.length, 'painted cell covers the complete typed text');
  assert.deepEqual(insertedTable.selection, {from:insertedTable.cell.to,to:insertedTable.cell.to}, 'caret remains after the typed text inside its painted cell');
  assert(insertedTable.cell.top >= insertedTable.pane.top - 1 && insertedTable.cell.bottom <= insertedTable.pane.bottom + 1, 'newly typed cell remains visible');
  results.push({ case: 'keyboard-command-palette-insert-table', ...insertedTable });
  await screenshot('keyboard-command-palette-insert-table');

  await fresh('preview keyboard search target');
  await press('p', { modifier: editorMod, shift: true }); await settle();
  await text('mode.preview'); await press('Enter'); await settle();
  assert(await c.evaluate(`editor.mode==='preview' && editor.inputPane.hidden`), 'palette changes to the visible Preview surface');
  await press('p', { modifier: editorMod, shift: true }); await settle();
  assert(await focused('.jot-command-dialog input[aria-label="搜索编辑命令"]'), 'Preview still exposes the keyboard command palette');
  await text('search.open'); await press('Enter'); await settle();
  assert(await c.evaluate(`editor.mode==='live-preview' && !editor.inputPane.hidden`), 'search command reveals its required input surface');
  assert(await focused('.cm-search input[name=search]'), 'search opened from Preview focuses its visible native field');
  await selectFieldText(); await text('target'); await press('Enter'); await settle();
  const fromPreview = await matchBox('target');
  await press('Escape'); await settle();
  assert(await c.evaluate('view.hasFocus'), 'search opened from Preview returns to visible editor focus');
  results.push({ case: 'keyboard-preview-palette-search', match: fromPreview });
  await screenshot('keyboard-preview-palette-search');

  await fresh('shortcut settings keyboard text');
  await press('p', { modifier: editorMod, shift: true }); await settle();
  await text('shortcut.settings'); await press('Enter'); await settle();
  const searchBinding = '.jot-shortcut-settings input[name="search.open"]';
  const replacementBinding = 'Ctrl-Shift-y';
  await tabTo(searchBinding); await selectFieldText(); await text(replacementBinding);
  await screenshot('keyboard-shortcut-settings-edit');
  await press('Enter'); await settle();
  assert(await focused(searchBinding), 'saving shortcut settings retains the same logical field focus');
  assert(await c.evaluate(`document.querySelector('.jot-shortcut-settings [role=alert]').textContent==='已保存'`), 'Enter submits the native shortcut form');
  assert.equal(await c.evaluate(`editor.commands.shortcuts.find(n=>n.id==='search.open')?.key`), replacementBinding);
  await press('Escape'); await settle();
  assert(await c.evaluate('view.hasFocus'), 'Escape returns from shortcut settings to the editor');
  await press('y', { modifier: 2, shift: true }); await settle();
  assert(await focused('.cm-search input[name=search]'), 'saved binding opens native search');
  results.push({ case: 'keyboard-shortcut-settings-rebind', binding: replacementBinding });
  await screenshot('keyboard-shortcut-settings-rebind');

  await press('Escape');
  await press('p', { modifier: editorMod, shift: true }); await settle();
  await text('shortcut.settings'); await press('Enter'); await settle();
  await tabTo(searchBinding); await selectFieldText(); await text('Mod-z');
  await press('Enter'); await settle();
  assert(await c.evaluate(`document.querySelector('.jot-shortcut-settings [role=alert]').textContent.includes('快捷键冲突')`));
  assert.equal(await c.evaluate(`editor.commands.shortcuts.find(n=>n.id==='search.open')?.key`), replacementBinding);
  await selectFieldText(); await press('Backspace');
  await press('Enter'); await settle();
  assert.equal(await c.evaluate(`editor.commands.shortcuts.some(n=>n.id==='search.open')`), false);
  await press('Escape');
  await press('y', { modifier: 2, shift: true }); await settle();
  assert.equal(await c.evaluate(`Boolean(document.querySelector('.cm-search'))`), false);

  await press('p', { modifier: editorMod, shift: true }); await settle();
  await text('shortcut.settings'); await press('Enter'); await settle();
  await tabTo('.jot-shortcut-settings button[type=button]'); await press('Enter'); await settle();
  assert.equal(await c.evaluate(`editor.commands.shortcuts.find(n=>n.id==='search.open')?.key`), 'Mod-f');
  await press('Escape'); await settle();
  await press('f', { modifier: mod }); await settle();
  assert(await focused('.cm-search input[name=search]'), 'reset restores the working default key');
  await press('Escape');
  results.push({ case: 'keyboard-shortcut-settings-conflict-disable-reset' });

  await fresh('first\n\nsecond target\n\nlast');
  await press(mac ? 'l' : 'g', { modifier: mac ? 2 : mod | 1, shift: mac }); await settle();
  assert(await focused('.cm-goto-line input[name=line]'), 'go-to-line shortcut opens the native field');
  await selectFieldText(); await text('3'); await press('Enter'); await settle();
  const goto = await c.evaluate(`(()=>{
    const head=view.state.selection.main.head,line=view.state.doc.lineAt(head),rect=view.coordsAtPos(head),pane=view.scrollDOM.getBoundingClientRect();
    return {head,line:{number:line.number,from:line.from,text:line.text},focus:view.hasFocus,painted:view.contentDOM.textContent.includes('second target'),caret:rect&&{top:rect.top,bottom:rect.bottom},pane:{top:pane.top,bottom:pane.bottom}};
  })()`);
  assert.equal(goto.line.number, 3, 'go-to-line uses physical source lines including blank separators');
  assert.equal(goto.line.text, 'second target');
  assert.equal(goto.head, goto.line.from, 'go-to-line puts the caret at the requested line start');
  assert(goto.focus && goto.painted, 'go-to-line restores editor focus over the painted target');
  assert(goto.caret && goto.caret.bottom > goto.caret.top && goto.caret.top >= goto.pane.top - 1 && goto.caret.bottom <= goto.pane.bottom + 1,
    'go-to-line reveals a real caret box within the editor viewport');
  results.push({ case: 'keyboard-goto-line', ...goto });
  await screenshot('keyboard-goto-line');
}
