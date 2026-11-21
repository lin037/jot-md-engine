import assert from 'node:assert/strict';
import { keyboardEventKey } from '../../support/browser-test-utils.mjs';

// Exercise edits through the same CodeMirror input and explicit engine mirror
// ports that the product exposes. Do not derive Markdown semantics from DOM.
export async function runTreeEditScenarios({c,load,settle,confirmed,key,screenshot,results}) {
  const mod = await c.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`) ? 4 : 2;
  const runCase = (name) => !process.env.JOT_TREE_EDIT_CASE || process.env.JOT_TREE_EDIT_CASE.split(',').includes(name);

  async function press(name, modifiers = 0) {
    const code = name.length === 1 ? 'Key' + name.toUpperCase() : name;
    const virtual = name.length === 1 ? name.toUpperCase().charCodeAt(0) : undefined;
    const key = keyboardEventKey(name, modifiers);
    await c.command('Input.dispatchKeyEvent', {type:'keyDown', key, code, modifiers,
      ...(virtual === undefined ? {} : {windowsVirtualKeyCode:virtual})});
    await c.command('Input.dispatchKeyEvent', {type:'keyUp', key, code, modifiers});
  }

  async function type(text) {
    await c.command('Input.insertText', {text});
    await confirmed();
    await c.evaluate('editor.livePreview.settled()');
  }

  async function select(from, to = from) {
    await c.evaluate(`editor.input.setSelection(${from},${to});editor.focus()`);
    await settle();
  }

  async function snapshot() {
    return c.evaluate(`(() => {
      const main = view.state.selection.main;
      const lines = [...view.contentDOM.querySelectorAll('.cm-line')].map(line => {
        const box = line.getBoundingClientRect();
        return {text:line.textContent,top:box.top,height:box.height,className:line.className};
      });
      const tail = lines.find(line => line.text === 'TAIL_ANCHOR');
      return {
        source:editor.confirmedValue, optimistic:editor.value, mirror:editor.input.value, revision:Number(editor.revision),
        analysis:editor.session.adapter.analysis?.state,
        selection:{from:main.from,to:main.to,anchor:main.anchor,head:main.head},
        focus:document.activeElement?.className,
        roots:editor.session.adapter.blocks.blocks.map(block => ({
          id:block.id,kind:block.kind,from:Number(block.sourceRange.from),to:Number(block.sourceRange.to),version:block.contentVersion,dirty:block.dirty,
        })),
        live:{...editor.livePreview.snapshot}, tail, lines,
        widgets:[...view.contentDOM.querySelectorAll('.jot-live-preview-widget')].map(node=>{const rect=node.getBoundingClientRect();return {className:node.className,top:rect.top,height:rect.height,text:node.textContent.slice(0,240)}}),
        sourceShells:[...view.contentDOM.querySelectorAll('[data-jot-live-reserved-height]')].map(node=>({className:node.className,reserved:node.getAttribute('data-jot-live-reserved-height'),height:node.getBoundingClientRect().height})),
        strongMarks:view.contentDOM.querySelectorAll('.jot-live-preview-strong').length,
        inlineMath:view.contentDOM.querySelectorAll('.jot-live-preview-widget--inline-math').length,
      };
    })()`);
  }

  async function verify(source, label) {
    await c.evaluate('editor.livePreview.settled()');
    const state = await snapshot();
    assert.equal(state.source, source, label + ': confirmed source');
    assert.equal(state.mirror, source, label + ': CodeMirror mirror source');
    assert.equal(state.analysis, 'complete', label + ': semantic confirmation');
    assert(Number.isSafeInteger(state.revision) && state.revision >= 0, label + ': legal revision');
    assert.equal(Number(state.live.revision), state.revision, label + ': current projection revision');
    assert(state.selection.from >= 0 && state.selection.to <= source.length, label + ': legal native selection');
    assert(!state.live.truncated, label + ': bounded plan must not truncate a short document');
    return state;
  }

  function sameTail(before, after, label) {
    assert(before.tail && after.tail, label + ': following anchor must remain painted');
    assert(Math.abs(before.tail.top - after.tail.top) < 1, label + ': restored source must restore following geometry ' + JSON.stringify({before:before.tail.top,after:after.tail.top,beforeHead:before.selection.head,afterHead:after.selection.head}));
    assert(Math.abs(before.tail.height - after.tail.height) < 1, label + ': following line height');
  }

  async function undo(expected, label) {
    await press('z', mod); await confirmed();
    return verify(expected, label + ' undo');
  }

  async function redo(expected, label) {
    await press('z', mod | 8); await confirmed();
    return verify(expected, label + ' redo');
  }

  for (const [name, middle, kind] of [
    ['paragraph','ALFA ordinary text','paragraph'],
    ['heading','## ALFA heading','heading'],
    ['quote','> ALFA quotation','block-quote'],
    ['list','- ALFA list item','list-item'],
    ['inline','Text **ALFA** remains strong.','paragraph'],
  ].filter(([name])=>runCase(name))) {
    console.log('[tree-edit] same-span '+name);
    const source = 'intro\n\n' + middle + '\n\nTAIL_ANCHOR';
    const changed = source.replace('ALFA','BETA');
    await load(source);
    await select(source.indexOf('ALFA'), source.indexOf('ALFA') + 4);
    const before = await verify(source, name + ' before');
    const owner = before.roots.find(root => root.from <= source.indexOf('ALFA') && source.indexOf('ALFA') < root.to);
    assert.equal(owner?.kind,kind,name + ': Rust owner kind');
    await type('BETA');
    const after = await verify(changed, name + ' same-span edit');
    assert.equal(after.selection.head,source.indexOf('ALFA') + 4,name + ': insertion stays at native caret');
    assert(after.focus.includes('cm-content'),name + ': ordinary native input keeps focus');
    sameTail(before, after, name + ' same-span no-wrap geometry');
    const restored = await undo(source,name);
    sameTail(before, restored,name + ' undo geometry');
    const repeated = await redo(changed,name);
    sameTail(after,repeated,name + ' redo geometry');
    results.push({case:'tree-edit-' + name,before,after,restored,repeated});
  }

  for (const [name, original, replacement, selector] of [
    ['strong','textword','**word**','.jot-live-preview-strong'],
    ['math','plain','$x^2$','.jot-live-preview-widget--inline-math'],
  ].filter(([name])=>runCase('inline-'+name))) {
    console.log('[tree-edit] fixed-span inline '+name);
    assert.equal(original.length,replacement.length,name + ': inline topology change retains the exact UTF-16 span');
    const source = 'intro\n\nInline ' + original + ' content\n\nTAIL_ANCHOR';
    const changed = source.replace(original,()=>replacement);
    const offset=source.indexOf(original);
    await load(source); await select(offset,offset+original.length);
    const before = await verify(source, name + ' initial text');
    const owner=before.roots.find(root=>root.from<=offset&&offset<root.to);
    await type(replacement);
    await press('ArrowDown'); await settle();
    const after = await verify(changed,name + ' node insertion');
    const rewritten=after.roots.find(root=>root.from===owner.from&&root.to===owner.to);
    assert.equal(rewritten?.id,owner.id,name + ': fixed owner identity survives an inline topology replacement');
    assert(rewritten.version>owner.version,name + ': owner content version invalidates geometry and projections');
    assert(await c.evaluate(`view.contentDOM.querySelectorAll(${JSON.stringify(selector)}).length>0`),name + ': semantic result must be painted');
    const restored = await undo(source,name + ' structural inline');
    sameTail(before,restored,name + ' structural undo geometry');
    const activeRedo = await redo(changed,name + ' structural inline');
    await press('ArrowDown'); await settle();
    const repeated = await verify(changed,name + ' structural inline after blur');
    results.push({case:'tree-edit-inline-' + name,before,after,restored,activeRedo,repeated});
    sameTail(after,repeated,name + ' structural redo geometry');
  }

  // External mirror edits are explicit session transactions. The source host
  // must map them into its unique CM document; it cannot edit Preview DOM.
  async function mirrorReplace(from,to,insert) {
    await c.evaluate(`editor.session.transact({origin:'api',edits:[{range:{from:${from},to:${to}},insert:${JSON.stringify(insert)}}],viewport:{visibleRanges:[]},history:{type:'ignore'}})`);
    await confirmed();
    await c.evaluate('editor.livePreview.settled()');
  }

  // Equal UTF-16 span does not imply equal line geometry. The Rust owner range
  // can stay fixed while wide glyphs force CodeMirror to remeasure wrapping.
  if(runCase('wide-glyph-layout')) {
    console.log('[tree-edit] wide glyph layout');
    const narrow = ('ii ').repeat(30);
    const wide = ('WW ').repeat(30);
    const source = 'intro\n\n' + narrow + '\n\nTAIL_ANCHOR';
    const changed = source.replace(narrow,wide);
    assert.equal(narrow.length,wide.length,'wide glyph edit retains the same UTF-16 span');
    await c.evaluate(`document.querySelector('#integration').style.width='280px'`);
    try {
      await load(source); await select(source.indexOf(narrow),source.indexOf(narrow)+narrow.length);
      const before = await verify(source,'narrow glyph layout');
      await type(wide);
      const after = await verify(changed,'wide glyph layout');
      const originalLine = before.lines.find(line=>line.text.includes('ii ii'));
      const wrappedLine = after.lines.find(line=>line.text.includes('WW WW'));
      assert(originalLine && wrappedLine && wrappedLine.height>originalLine.height,'same-span wide glyphs must produce measured extra lines');
      assert(after.tail.top>=wrappedLine.top+wrappedLine.height-1,'following root must not overlap the remeasured owner');
      const cycles=[];
      for(let cycle=0;cycle<3;cycle++) {
        for(const text of ['intro','WW WW']) {
          const point=await c.evaluate(`(()=>{const line=[...view.contentDOM.querySelectorAll('.cm-line')].find(line=>line.textContent.includes(${JSON.stringify(text)}));const rect=line.getBoundingClientRect();return {x:rect.left+30,y:rect.top+8};})()`);
          await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
          await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
          await settle();
        }
        const repeated=await verify(changed,'wide glyph activation '+cycle);
        sameTail(after,repeated,'wide glyph activation '+cycle);
        cycles.push(repeated);
      }
      results.push({case:'tree-edit-wide-glyph-layout',before,after,cycles});
      await screenshot('tree-edit-wide-glyph-layout');
    } finally {await c.evaluate(`document.querySelector('#integration').style.width='900px'`);await settle();}
  }

  for (const [name, opener, invalid, closer, kind] of [
    ['fence','``` js begin','``` enX','``` end','fenced-code'],
    ['math','$$','$$X','$$','math-block'],
  ].filter(([name])=>runCase(name+'-closer'))) {
    console.log('[tree-edit] container mirror '+name);
    const source = `intro\n\n${opener}\nplain body\n# DOWNSTREAM_HEADING\n\n| Column |\n| --- |\n| cell |\n\n${invalid}\n\nTAIL_ANCHOR`;
    const changed = source.replace(invalid,()=>closer);
    await load(source);
    const from = source.indexOf(invalid);
    await select(from,from + invalid.length);
    const before = await verify(source,name + ' incomplete');
    assert(!before.roots.some(root => root.kind === kind),name + ': unclosed opener must not consume the tail');
    assert(before.roots.some(root => root.kind === 'heading') && before.roots.some(root => root.kind === 'table'),name + ': downstream blocks retain normal syntax');
    await type(closer);
    const closed = await verify(changed,name + ' completed');
    assert(closed.roots.some(root => root.kind === kind),name + ': closer forms the container');
    assert(!closed.roots.some(root => root.kind === 'heading' || root.kind === 'table'),name + ': closed container owns its content');
    assert.equal(closed.selection.from,closed.selection.to,name + ': text insertion produces one collapsed caret');
    assert.equal(closed.live.activeBlocks,1,name + ': collapsed native caret owns the source-active root');
    const restored = await undo(source,name + ' closer');
    sameTail(before,restored,name + ' unclosed undo geometry');
    const redone = await redo(changed,name + ' closer');
    assert(redone.selection.to>redone.selection.from,name + ': history restores a real native range selection');
    assert.equal(redone.live.activeBlocks,0,name + ': range selection retains Preview rather than source-activating every block');
    if(kind==='math-block') {
      assert(closed.sourceShells.some(shell=>shell.className.includes('--math-block')),name + ': collapsed caret uses the source shell');
      assert(redone.widgets.some(widget=>widget.className.includes('--math-block')&&widget.className.includes('--selected')),name + ': selected range keeps the selected math Preview widget');
    }
    const cycles = [];
    results.push({case:'tree-edit-' + name + '-closer',before,closed,restored,redone,cycles});
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const start = from;
      await mirrorReplace(start,start + closer.length,invalid);
      const reopened = await verify(source,name + ' external invalidation ' + cycle);
      const cycleRecord={reopened};cycles.push(cycleRecord);
      assert(!reopened.roots.some(root => root.kind === kind),name + ': mirror invalidation dissolves container');
      assert(reopened.roots.some(root => root.kind === 'heading') && reopened.roots.some(root => root.kind === 'table'),name + ': mirror invalidation restores downstream syntax');
      assert.deepEqual(reopened.selection,before.selection,name + ': external mirror must preserve the mapped unclosed selection');
      sameTail(before,reopened,name + ' mirror restore ' + cycle);
      await mirrorReplace(from,from + invalid.length,closer);
      const reclosed = await verify(changed,name + ' external completion ' + cycle);
      cycleRecord.reclosed=reclosed;
      assert.deepEqual(reclosed.selection,redone.selection,name + ': compare exactly the same closed native selection');
      assert.equal(reclosed.live.activeBlocks,redone.live.activeBlocks,name + ': compare the same closed presentation');
      sameTail(redone,reclosed,name + ' mirror completion ' + cycle);
    }
    await screenshot('tree-edit-' + name + '-closer');
  }

  if(runCase('table-cell')) {
  console.log('[tree-edit] mapped cell range and protected cross-cell input');
  const tableSource = 'intro\n\n| Long first column | Long second column |\n| --- | --- |\n| ALFA | unchanged |\n\nTAIL_ANCHOR';
  await load(tableSource);
  const from = tableSource.indexOf('ALFA');
  await select(from,from+4);
  await c.evaluate(`window.treeTable=view.contentDOM.querySelector('.jot-live-preview-widget--table');window.treeCell=view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell');`);
  const tableBefore = await verify(tableSource,'table cell before');
  const tableId = tableBefore.roots.find(root => root.kind === 'table').id;
  const widths = await c.evaluate(`editor.tableLayout(${JSON.stringify(tableId)}).widths`);
  await type('BETA');
  const tableAfter = await verify(tableSource.replace('ALFA','BETA'),'table cell change');
  const tablePaint = await c.evaluate(`(() => {
    const cell=view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell');
    const rect=cell.getBoundingClientRect(),style=getComputedStyle(cell);
    return {sameTable:treeTable===view.contentDOM.querySelector('.jot-live-preview-widget--table'),sameCell:treeCell===cell,
      text:cell.textContent,active:cell.classList.contains('jot-live-preview-table-cell--active'),
      caretHeight:parseFloat(style.getPropertyValue('--jot-live-table-caret-height')),height:rect.height,
      widths:editor.tableLayout(${JSON.stringify(tableId)}).widths};
  })()`);
  assert(tablePaint.sameTable && tablePaint.sameCell,'cell edit must preserve mounted table and cell identity');
  assert.equal(tablePaint.text,'BETA','changed cell must be painted');
  assert(tablePaint.active && tablePaint.caretHeight>0 && tablePaint.caretHeight<=tablePaint.height,'mapped source caret must remain inside the painted cell');
  assert.deepEqual(tablePaint.widths,widths,'same-width non-maximal cell edit must retain table columns');
  assert.equal(tableAfter.selection.head,from+4,'mapped input must retain exact CM head');
  sameTail(tableBefore,tableAfter,'table cell geometry');
  const tableRestored = await undo(tableSource,'table cell');
  sameTail(tableBefore,tableRestored,'table cell undo geometry');
  const tableRepeated = await redo(tableSource.replace('ALFA','BETA'),'table cell');
  sameTail(tableAfter,tableRepeated,'table cell redo geometry');
  results.push({case:'tree-edit-table-cell',before:tableBefore,after:tableAfter,restored:tableRestored,repeated:tableRepeated,paint:tablePaint});
  await load(tableSource);
  await select(from,tableSource.indexOf('unchanged')+'unchanged'.length);
  const crossingBefore=await verify(tableSource,'cross-cell before');
  await c.command('Input.insertText',{text:'must-not-escape'});await settle();
  const crossingAfter=await verify(tableSource,'cross-cell protected replacement');
  assert.equal(crossingAfter.revision,crossingBefore.revision,'cross-cell typing must not create an unrelated source edit');
  assert.deepEqual(crossingAfter.selection,crossingBefore.selection,'cross-cell rejection preserves the true source selection');
  results.push({case:'tree-edit-table-cross-cell-protection',before:crossingBefore,after:crossingAfter});
  await screenshot('tree-edit-table-cell');
  }

  if(runCase('ime-ordinary')) {
    console.log('[tree-edit] native ordinary IME');
    const source='intro\n\nordinary input\n\nTAIL_ANCHOR';
    await load(source);const from=source.indexOf(' input');await select(from);
    const before=await verify(source,'ordinary IME before');
    await c.evaluate(`window.treeCompositionEvents=[];window.treeImeRequests=[];const transact=editor.session.transact.bind(editor.session);editor.session.transact=intent=>{treeImeRequests.push({origin:intent.origin,metadata:intent.metadata,edits:intent.edits,events:treeCompositionEvents.map(event=>event.type)});return transact(intent);};for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])view.dom.addEventListener(type,event=>treeCompositionEvents.push({type:event.type,data:event.data,inputType:event.inputType,isComposing:event.isComposing,isTrusted:event.isTrusted,defaultPrevented:event.defaultPrevented,target:event.target.className,viewComposing:view.composing,from:view.state.selection.main.from,to:view.state.selection.main.to}),{capture:true});`);
    await c.command('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    await settle();
    const during=await snapshot();
    const record={case:'tree-edit-ime-ordinary',before,during,events:await c.evaluate('treeCompositionEvents'),requests:await c.evaluate('treeImeRequests')};results.push(record);
    assert.equal(during.source,source,'ordinary IME intermediate text must not reach confirmed source');
    assert.equal(during.revision,before.revision,'ordinary IME intermediate text must not create a committed revision');
    assert(await c.evaluate(`view.contentDOM.textContent.includes('zhong')`),'browser owns the visible ordinary composition');
    await type('中');
    const expected=source.slice(0,from)+'中'+source.slice(from);
    const committed=await verify(expected,'ordinary IME commit');
    record.committed=committed;
    assert.equal(committed.revision,before.revision+1,'ordinary IME commits exactly once');
    const restored=await undo(source,'ordinary IME');
    record.restored=restored;
    sameTail(before,restored,'ordinary IME undo geometry');
  }

  if(runCase('ime-table')) {
    console.log('[tree-edit] mapped table IME');
    const source='intro\n\n| Long first column | Second |\n| --- | --- |\n|  | stable |\n\nTAIL_ANCHOR';
    await load(source);
    const point=await c.evaluate(`(()=>{const cell=view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell');window.treeImeTable=cell.closest('.jot-live-preview-widget--table');const rect=cell.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
    await c.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await c.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await settle();
    const before=await verify(source,'mapped IME before');
    assert(before.focus.includes('jot-live-preview-table-ime'),'mapped cell must focus its one transient native IME surface');
    await c.command('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    await settle();
    const during=await snapshot();
    assert.equal(during.source,source,'mapped IME intermediate text must not reach confirmed source');
    assert.equal(during.mirror,source,'mapped IME intermediate text stays outside CM until commit');
    assert.equal(during.revision,before.revision,'mapped IME intermediate text must not commit');
    assert(await c.evaluate(`document.activeElement.value==='zhong'&&view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell').textContent===''`),'intermediate composition is held only by the shared native sink');
    await type('中');
    const expected=source.slice(0,before.selection.head)+'中'+source.slice(before.selection.head);
    const committed=await verify(expected,'mapped IME commit');
    assert.equal(committed.revision,before.revision+1,'mapped IME commits exactly once');
    assert(await c.evaluate(`treeImeTable===view.contentDOM.querySelector('.jot-live-preview-widget--table')&&view.contentDOM.querySelector('.jot-table-grid-body .jot-table-cell').textContent==='中'`),'mapped IME retains the table shell and paints only committed text');
    const restored=await undo(source,'mapped IME');
    sameTail(before,restored,'mapped IME undo geometry');
    results.push({case:'tree-edit-ime-table',before,during,committed,restored});
    await screenshot('tree-edit-ime-table');
  }
}
