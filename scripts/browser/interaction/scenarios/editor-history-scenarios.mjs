import assert from "node:assert/strict";
import { waitForEvaluation } from "../../support/browser-test-utils.mjs";

export async function runHistoryScenarios({ c, results }) {
  const run = (fn, ...args) => c.evaluate(`(${fn})(${args.map(arg => JSON.stringify(arg)).join(",")})`);
  await run(async (rootPath) => {
    const { MarkdownEditor } = await import(rootPath + "/packages/editor/src/index.ts");
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;inset:0;background:white";
    document.body.append(root);
    const snapshots = new Map();
    const errors = [];
    let editor, worker;
    window.historyFixture = {
      get value() {
        return editor.value;
      },
      async open(documentId, source, from = documentId, generation = 1) {
        if (worker) throw new Error("Previous test session was not closed");
        worker = new Worker("/src/worker.ts", { type: "module" });
        editor = new MarkdownEditor({
          root,
          mode: documentId === "first" ? "live-preview" : "source",
          history: snapshots.get(from),
          session: {
            endpoint: worker, documentId, generation, source,
            syntaxProfile: { id: "default", version: 1, enabledExtensions: [] },
          },
          onError: error => errors.push(String(error)),
        });
        await editor.open();
        editor.focus();
      },
      async append(text) {
        const view = editor.input.view;
        view.dispatch({
          changes: { from: editor.value.length, insert: text },
          userEvent: "input.type",
        });
        await editor.input.settled();
      },
      async command(id) {
        const applied = editor.executeCommand(id);
        await editor.input.settled();
        return { applied, value: editor.confirmedValue };
      },
      async leave(id) {
        await editor.input.settled();
        const history = editor.captureHistory();
        if (id !== undefined) {
          if (history === undefined) snapshots.delete(id);
          else snapshots.set(id, history);
        }
        const value = editor.confirmedValue;
        editor.dispose();
        worker.terminate();
        editor = worker = undefined;
        return { saved: history !== undefined, value };
      },
      remove(id) {
        snapshots.delete(id);
      },
      finish() {
        editor?.dispose();
        worker?.terminate();
        root.remove();
        delete window.historyFixture;
        return errors;
      },
    };
  }, "/@fs" + process.cwd());

  try {
    await run(() => historyFixture.open("first", "Alpha notes"));
    await c.command("Input.insertText", { text: "Draft " });
    await waitForEvaluation(c, 'historyFixture.value === "Draft Alpha notes"', 5_000);
    await run(() => historyFixture.append(" ✅"));
    assert.deepEqual(await run(() => historyFixture.command("history.undo")),
      { applied: true, value: "Draft Alpha notes" });
    assert.deepEqual(await run(() => historyFixture.leave("first")),
      { saved: true, value: "Draft Alpha notes" });

    // Recreate each session with its own Worker while earlier tabs keep only history.
    await run(async () => {
      for (let index = 0; index < 20; index++) {
        const id = "tab-" + index;
        await historyFixture.open(id, "notes " + index);
        await historyFixture.append("!");
        await historyFixture.leave(id);
      }
    });
    await run(() => historyFixture.open("tab-19", "notes 19!"));
    assert.deepEqual(await run(() => historyFixture.command("history.undo")),
      { applied: true, value: "notes 19" });
    await run(() => historyFixture.leave("tab-19"));

    await run(() => historyFixture.open("first", "Draft Alpha notes", "first", 2));
    assert.deepEqual(await run(() => historyFixture.command("history.redo")),
      { applied: true, value: "Draft Alpha notes ✅" });
    assert.deepEqual(await run(() => historyFixture.command("history.undo")),
      { applied: true, value: "Draft Alpha notes" });
    assert.deepEqual(await run(() => historyFixture.command("history.undo")),
      { applied: true, value: "Alpha notes" });
    assert.deepEqual(await run(() => historyFixture.command("history.redo")),
      { applied: true, value: "Draft Alpha notes" });
    await run(() => historyFixture.leave("first"));

    for (const [id, source] of [["different-id", "Draft Alpha notes"], ["first", "Draft Bravo notes"]]) {
      await run((id, source) => historyFixture.open(id, source, "first"), id, source);
      assert.deepEqual(await run(() => historyFixture.command("history.undo")), { applied: false, value: source });
      assert.deepEqual(await run(() => historyFixture.command("history.redo")), { applied: false, value: source });
      assert.deepEqual(await run(() => historyFixture.leave()), { saved: false, value: source });
    }

    await run(async () => {
      historyFixture.remove("first");
      await historyFixture.open("first", "Draft Alpha notes");
    });
    assert.deepEqual(await run(() => historyFixture.command("history.undo")),
      { applied: false, value: "Draft Alpha notes" });
    assert.deepEqual(await run(() => historyFixture.leave()),
      { saved: false, value: "Draft Alpha notes" });
    results.push({ case: "undo-history-across-document-sessions", visitedDocuments: 21 });
  } finally {
    assert.deepEqual(await run(() => historyFixture.finish()), []);
  }
}
