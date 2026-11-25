// Use the public component with a real CodeMirror view, Worker, and external panels.
export async function checkEditorLocales(client) {
  const base = '/@fs' + process.cwd() + '/packages/editor/src';
  await client.evaluate(`(async () => {
    const { mountShortcutSettings } = await import(${JSON.stringify(base + '/component/index.ts')});
    const { mountOutline } = await import(${JSON.stringify(base + '/plugins/outline.ts')});
    await (${exercise.toString()})(mountShortcutSettings, mountOutline);
  })()`);
}

async function exercise(mountShortcutSettings, mountOutline) {
  const equal = (actual, expected, label) => {
    if (actual !== expected) throw Error(label + ': expected ' + expected + ', got ' + actual);
  };
  disposeToolbarEditor();
  const languages = Object.getOwnPropertyDescriptor(navigator, 'languages');
  const setLanguages = (...value) => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value });
    window.dispatchEvent(new Event('languagechange'));
  };
  editor.setLocale('en');
  setLanguages('de-DE', 'zh-HK');
  createToolbarEditor({}, { locale: 'auto', translations: { fr: { Bold: 'Gras' } } });
  const instance = toolbarEditor;
  await instance.open();
  const { session, input: { view } } = instance;
  const root = instance.inputPane.parentElement;
  const q = selector => root.querySelector(selector);
  const toolbar = id => q('[data-jot-toolbar-command="' + id + '"]');
  const sidebar = document.createElement('aside');
  document.body.append(sidebar);
  const settings = mountShortcutSettings(sidebar, instance.commands, instance.i18n);
  const outline = mountOutline(sidebar, instance);
  const changes = [];
  const stop = instance.onDocumentChange(change => changes.push(change));
  try {
    equal(root.lang, 'zh-CN', 'browser language resolved in order');
    equal(toolbar('format.bold').ariaLabel, '加粗', 'localized toolbar');
    instance.input.setSelection(0, 5);
    instance.executeCommand('format.bold');
    await instance.settled();
    instance.input.setSelection(2, 4);
    const original = instance.confirmedValue;
    const revision = instance.revision;
    const selection = JSON.stringify(view.state.selection.toJSON());
    const changeCount = changes.length;
    setLanguages('en-GB');
    equal(root.lang, 'en', 'languagechange on mounted editor');
    equal(toolbar('format.bold').ariaLabel, 'Bold', 'English toolbar');
    equal(view.state.phrase('Go to line'), 'Go to line', 'CodeMirror phrases');
    instance.setLocale('fr-CA');
    setLanguages('zh-CN');
    equal(toolbar('format.bold').ariaLabel, 'Gras', 'custom regional fallback and manual override');
    equal(toolbar('format.italic').ariaLabel, 'Italic', 'missing custom translation');
    equal(editor.locale, 'en', 'second editor stayed independent');
    equal(instance.session === session && instance.input.view === view, true, 'same live editor and session');
    equal(instance.confirmedValue, original, 'unchanged Markdown');
    equal(instance.revision, revision, 'unchanged revision');
    equal(changes.length, changeCount, 'no document change event');
    equal(JSON.stringify(view.state.selection.toJSON()), selection, 'unchanged selection');
    instance.executeCommand('history.undo');
    await instance.settled();
    equal(instance.confirmedValue, 'ready', 'undo across locale change');
    instance.setLocale('en');
    toolbar('toolbar.open-table').click();
    const panel = q('.jot-editor-toolbar__picker--table');
    panel.querySelector('details').open = true;
    const rows = panel.querySelector('input[name=rows]');
    rows.value = '12';
    rows.focus();
    instance.setLocale('zh-CN');
    equal(panel.querySelector('summary').textContent, '自定义尺寸', 'open picker translated in place');
    equal(panel.matches(':popover-open') && document.activeElement === rows, true, 'open picker retained focus');
    equal(rows.value, '12', 'picker draft');
    toolbar('toolbar.open-table').click();

    instance.openSearch();
    const search = q('.cm-search input[name=search]');
    search.value = 'ready';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    instance.setLocale('en');
    equal(search.placeholder, 'Search', 'open search field');
    equal(document.activeElement === search && search.value === 'ready', true, 'focused query preserved');
    instance.input.closeSearch();
    instance.executeCommand('document.goto-line');
    const line = q('.cm-goto-line input');
    line.value = '3';
    instance.setLocale('zh-CN');
    equal(line.parentElement.firstChild.textContent.trim(), '跳转到行:', 'open native CodeMirror panel');
    equal(line.value, '3', 'line number survived locale change');
    q('.cm-dialog-close').click();

    const keyField = sidebar.querySelector('input[name="format.bold"]');
    keyField.value = 'F11';
    keyField.focus();
    keyField.setSelectionRange(1, 2);
    instance.setLocale('en');
    equal(keyField.ariaLabel, 'Bold', 'external shortcuts label');
    equal(document.activeElement === keyField && keyField.selectionStart === 1 && keyField.value === 'F11', true, 'shortcut draft and caret');
    equal(sidebar.querySelector('nav').ariaLabel, 'Document outline', 'external outline');
    instance.openCommandPalette();
    const query = q('.jot-command-dialog input');
    query.value = 'format.bold';
    query.dispatchEvent(new Event('input', { bubbles: true }));
    instance.setLocale('auto');
    equal(query.ariaLabel, '搜索编辑命令', 'open palette');
    equal(q('[data-jot-command="format.bold"] span').firstChild.textContent, '加粗', 'palette kept query and localized results');
    equal(query.value, 'format.bold', 'palette query');
    q('.jot-command-dialog__header button').click();
    instance.setValue('# Search\n\nBody');
    await instance.settled();
    await instance.setMode('pretext');
    await instance.settled();
    const heading = q('.jot-pretext-block[data-jot-kind=heading]');
    equal(heading.querySelector('[data-jot-pretext-role=label]').textContent, '1 级标题', 'layout mode label');
    instance.setLocale('en');
    equal(heading.querySelector('[data-jot-pretext-role=label]').textContent, 'Heading 1', 'mounted layout block');
    equal(heading.querySelector('[data-jot-pretext-role=preview]').textContent, 'Search', 'user heading stays literal');
  } finally {
    stop();
    outline.dispose();
    settings.dispose();
    sidebar.remove();
    if (languages) Object.defineProperty(navigator, 'languages', languages);
    else delete navigator.languages;
    window.dispatchEvent(new Event('languagechange'));
  }
}
