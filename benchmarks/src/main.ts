import { FRONTEND_REQUEST_ID_MAX, PROTOCOL_VERSION, type DocumentId, type ResponseEnvelope, type Revision } from "@jot-md/editor-protocol";

import { MarkdownEditor } from "../../packages/editor/src/index.js";

type Scenario = "open" | "insert" | "paste" | "drop" | "typing" | "replace" | "scroll" | "cursor-insert" | "paste-paragraph" | "find-next" | "undo" | "redo" | keyof typeof replacements;

const replacements = {
  "replace-all-fences": ["```", "EX_FENCE"],
  "replace-all-text": ["中文", "改写"],
  "replace-all-dense": ["a", "b"],
} as const;

const paragraph = "会议小结：已核对正文与表格，下一步整理本周的待办事项。";
const searchTarget = "FINAL_SENTINEL";

interface Timing {
  visibleMs?: number;
  matches?: number;
  dispatchMs?: number;
  saveReadyMs?: number;
  savedMs?: number;
  confirmedMs?: number;
  parsedMs?: number;
  afterConfirmMs?: number;
  mountedLines?: number;
}

const root = document.querySelector<HTMLElement>("#editor")!;
let dispose = () => {};
let finish: Promise<Timing>;
let paste: () => void;
let replaceAll: () => void;
let runCommand: () => void;
let insertAtCursor: () => void;

Object.assign(window, {
  benchmark: {
    prepare,
    finish: () => finish,
    paste: () => paste(),
    replaceAll: () => replaceAll(),
    runCommand: () => runCommand(),
    insertAtCursor: () => insertAtCursor(),
    dispose: () => dispose(),
  },
});

function isBulkReplacement(scenario: Scenario): scenario is keyof typeof replacements {
  return Object.hasOwn(replacements, scenario);
}

async function prepare(scenario: Scenario, fixture: string) {
  dispose();
  root.replaceChildren();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const abort = new AbortController();
  const errors: string[] = [];
  worker.addEventListener("error", event => errors.push(event.message));
  addEventListener("error", event => errors.push(event.message), { signal: abort.signal });
  const singleCharacter = scenario === "typing" || scenario === "replace";
  const existing = scenario !== "insert" && scenario !== "paste" && scenario !== "drop";
  const initial = existing ? fixture : "";
  const editAt = fixture.indexOf("BOLD_");
  const selectionEnd = editAt + (scenario === "replace" ? 1 : 0);
  const inserted = scenario === "paste-paragraph" ? paragraph : "字";
  const inlineEdit = singleCharacter || scenario === "paste-paragraph";
  const expected = inlineEdit ? fixture.slice(0, editAt) + inserted + fixture.slice(selectionEnd) : fixture;
  const revision = scenario === "open" || scenario === "scroll" ? 0 : 1;
  const startOpen = performance.now();
  const editor = new MarkdownEditor({
    root,
    mode: "live-preview",
    session: {
      endpoint: worker,
      documentId: "benchmark" as DocumentId,
      generation: 1,
      source: initial,
      syntaxProfile: { id: "default", version: 1, enabledExtensions: [] },
    },
    onError: error => errors.push(String(error)),
  });
  const view = editor.input.view;
  dispose = () => {
    abort.abort();
    editor.dispose();
    worker.terminate();
    dispose = () => {};
  };
  const opening = editor.open();
  if (scenario === "open") {
    finish = observe(startOpen, editor, scenario, expected, revision, errors);
    await opening;
    return;
  }

  await opening;
  // 每次编辑和滚动都从准备好的同一状态开始。首屏准备不计入样本。
  await observe(startOpen, editor, "open", initial, 0, errors, scenario === "replace-all-dense" ? "aaaa" : undefined);
  await editor.livePreview.settled();
  if (inlineEdit) view.dispatch({ selection: { anchor: editAt, head: selectionEnd } });
  editor.focus();
  if (!view.hasFocus) throw new Error("编辑器未获得焦点");

  if (scenario === "find-next") {
    const targetAt = fixture.lastIndexOf(searchTarget);
    if (targetAt < 0 || view.visibleRanges.some(r => r.to >= targetAt)) throw new Error("expected an offscreen match");
    runCommand = () => {
      const started = performance.now();
      editor.setSearchQuery({ search: searchTarget });
      if (!editor.findNext()) throw new Error("search failed");
      finish = observe(started, editor, scenario, fixture, 0, errors, searchTarget).then(timing => {
        const selection = view.state.selection.main;
        if (selection.from !== targetAt || selection.to !== targetAt + searchTarget.length) throw new Error("incorrect match");
        return timing;
      });
    };
    return;
  }

  if (scenario === "undo" || scenario === "redo") {
    const original = "BOLD_00000";
    const changed = "EDIT_00000";
    if (!fixture.startsWith(original, editAt)) throw new Error("history fixture marker missing");
    const edited = fixture.slice(0, editAt) + changed + fixture.slice(editAt + original.length);
    view.dispatch({ changes: { from: editAt, to: editAt + original.length, insert: changed }, userEvent: "input.type" });
    await editor.input.settled();
    if (editor.confirmedValue !== edited) throw new Error("history setup edit failed");
    if (scenario === "redo") {
      if (!editor.executeCommand("history.undo")) throw new Error("history setup undo failed");
      await editor.input.settled();
      if (editor.confirmedValue !== fixture) throw new Error("history setup undo lost text");
    }
    await editor.livePreview.settled();
    runCommand = () => {
      const started = performance.now();
      const nextRevision = Number(editor.revision) + 1;
      if (!editor.executeCommand("history." + scenario)) throw new Error("history command failed");
      finish = observe(started, editor, scenario, scenario === "undo" ? fixture : edited,
        nextRevision, errors, scenario === "undo" ? original : changed);
    };
    return;
  }

  if (isBulkReplacement(scenario)) {
    const [search, replace] = replacements[scenario];
    let matches = 0;
    for (let pos = fixture.indexOf(search); pos !== -1; pos = fixture.indexOf(search, pos + search.length)) matches++;
    if (matches === 0) throw new Error("replacement fixture has no matches");
    const result = fixture.replaceAll(search, replace);
    editor.setSearchQuery({ search, replace });
    replaceAll = () => {
      const started = performance.now();
      const painted = observe(started, editor, scenario, result, 1, errors, replace);
      if (!editor.replaceAll()) throw new Error("replaceAll did not edit the document");
      const dispatchMs = performance.now() - started;
      const saved = editor.input.settled().then(async () => {
        const saveReadyMs = performance.now() - started;
        if (editor.confirmedValue !== result) throw new Error("save returned stale text");
        const writtenAt = await verifySavedRevision(worker, editor.revision, editor.confirmedValue);
        return { saveReadyMs, savedMs: writtenAt - started };
      });
      finish = Promise.all([painted, saved]).then(async ([timing, save]) => {
        if (!editor.executeCommand("history.undo")) throw new Error("replaceAll was not undoable");
        await editor.input.settled();
        if (editor.confirmedValue !== fixture || editor.value !== fixture) throw new Error("undo lost original text");
        if (!editor.executeCommand("history.redo")) throw new Error("replaceAll was not redoable");
        await editor.input.settled();
        if (editor.confirmedValue !== result) throw new Error("redo lost replaced text");
        return { ...timing, matches, dispatchMs, ...save };
      });
    };
    return;
  }

  if (scenario === "cursor-insert") {
    // 让视口断言能区分刚插入的末行和原文中相同的一段。
    const payload = "\n" + fixture.replace("FINAL_SENTINEL", "INSERTED_SENTINEL") + "\n";
    const combined = payload + initial;
    view.dispatch({ selection: { anchor: 0 } });
    insertAtCursor = () => {
      const atStart = performance.now();
      let atConfirmation: string | undefined;
      const stop = editor.subscribe(effect => {
        if (effect.documentPatch?.revision === revision) atConfirmation = editor.confirmedValue;
      });
      const parsed = observe(atStart, editor, scenario, combined, revision, errors);
      view.dispatch(view.state.replaceSelection(payload), { userEvent: "input.paste", scrollIntoView: true });
      // 模拟插入后立刻点保存，在输入提交后取得同一修订的正文。
      const save = editor.input.settled().then(() => ({ text: editor.confirmedValue, revision: editor.revision }));
      finish = Promise.all([parsed, save]).then(async ([timing, saved]) => {
        if (atConfirmation !== combined || saved.text !== combined || saved.revision !== revision) {
          throw new Error("正文确认或保存操作遗漏了本次插入");
        }
        await verifySavedRevision(worker, saved.revision, saved.text);
        return timing;
      }).finally(stop);
    };
    return;
  }

  const eventType = { insert: "beforeinput", paste: "paste", "paste-paragraph": "paste", drop: "drop", typing: "beforeinput", replace: "beforeinput", scroll: "wheel" }[scenario];
  finish = new Promise((resolve, reject) => {
    root.addEventListener(eventType, event => {
      const started = performance.now();
      const received = event instanceof InputEvent ? event.data :
        event instanceof ClipboardEvent ? event.clipboardData?.getData("text/plain") :
        event instanceof DragEvent ? event.dataTransfer?.getData("text/plain") : undefined;
      if (scenario !== "scroll" && received !== (inlineEdit ? inserted : fixture)) {
        reject(new Error(`${scenario} 的输入与样本不同`));
        return;
      }
      if (event.isTrusted !== (scenario !== "paste" && scenario !== "paste-paragraph")) {
        reject(new Error(`${scenario} 的输入信任状态不符`));
        return;
      }
      resolve(observe(started, editor, scenario, expected, revision, errors));
    }, { capture: true, once: true, signal: abort.signal });
  });
  paste = () => {
    const data = new DataTransfer();
    data.setData("text/plain", scenario === "paste-paragraph" ? paragraph : fixture);
    view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  };
}

async function observe(
  start: number,
  editor: MarkdownEditor,
  scenario: Scenario,
  expected: string,
  revision: number,
  errors: readonly string[],
  visibleMarker?: string,
): Promise<Timing> {
  const view = editor.input.view;
  const timing: Timing = {};
  const initialScroll = view.scrollDOM.scrollTop;
  const initialRange = view.visibleRanges[0]?.from ?? 0;
  const editMarker: Partial<Record<Scenario, string>> = {
    "cursor-insert": "INSERTED_SENTINEL", typing: "字BOLD_", "paste-paragraph": paragraph, replace: "字OLD_",
  };
  const marker = visibleMarker ?? editMarker[scenario] ?? /(?:SECTION|BOLD|TABLE|LIST|QUOTE|CODE)_\d{5}|FINAL_SENTINEL/;
  let previousFrame: number | undefined;
  // 在确认和解析回调到达时取时。逐帧轮询会把同一帧内发生的两件事记为同时完成。
  const navigation = scenario === "scroll" || scenario === "find-next";
  const recordRevision = () => {
    const analysis = editor.session.adapter.analysis;
    if (navigation || editor.revision !== revision || analysis?.targetRevision !== revision ||
        editor.session.adapter.text.utf16Length !== expected.length) return;
    const elapsed = performance.now() - start;
    timing.confirmedMs ??= elapsed;
    if (analysis.state === "complete" && timing.parsedMs === undefined) {
      timing.parsedMs = elapsed;
      timing.afterConfirmMs = elapsed - timing.confirmedMs;
    }
  };
  const stop = editor.subscribe(recordRevision);
  recordRevision();
  try {
    while (performance.now() - start < 15_000) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (errors.length > 0) throw new Error(errors.join("\n"));
      const elapsed = performance.now() - start;
      if (timing.visibleMs === undefined && view.state.doc.length === expected.length) {
        const pane = view.scrollDOM.getBoundingClientRect();
        const moved = scenario !== "scroll" ||
          (view.scrollDOM.scrollTop > initialScroll && (view.visibleRanges[0]?.from ?? 0) > initialRange);
        const lines = view.contentDOM.querySelectorAll(".cm-line");
        const visible = expected.length === 0 || Array.from(lines).some(line => {
          const text = line.textContent ?? "";
          if (typeof marker === "string" ? !text.includes(marker) : !marker.test(text)) return false;
          const box = line.getBoundingClientRect();
          return box.height > 0 && box.bottom > pane.top && box.top < pane.bottom;
        });
        if (moved && visible) {
          // 连续两帧可见时，上一帧已获得绘制机会。
          if (previousFrame !== undefined) {
            timing.visibleMs = previousFrame;
            timing.mountedLines = lines.length;
          }
          previousFrame = elapsed;
        } else {
          previousFrame = undefined;
        }
      }

      if (timing.visibleMs !== undefined && (navigation || timing.parsedMs !== undefined)) {
        if (editor.value !== expected || editor.confirmedValue !== expected || Number(editor.revision) !== revision) {
          throw new Error(`${scenario} 的最终文本或版本不符`);
        }
        return timing;
      }
    }
    throw new Error(`${scenario} 未在 15 秒内完成 (${JSON.stringify(timing)})`);
  } finally {
    stop();
  }
}

// Time the real write first. Snapshot validation and file readback are outside that interval.
async function verifySavedRevision(worker: Worker, revision: Revision, confirmed: string): Promise<number> {
  const directory = await navigator.storage.getDirectory();
  const name = `confirmed-${crypto.randomUUID()}.md`;
  const file = await directory.getFileHandle(name, { create: true });
  try {
    const stream = await file.createWritable();
    await stream.write(confirmed);
    await stream.close();
    const writtenAt = performance.now();
    const snapshot = await readSnapshot(worker, revision);
    if (snapshot !== confirmed) throw new Error("已确认正文与 Rust 快照不同");
    if (await (await file.getFile()).text() !== snapshot) throw new Error("读回的文件与 Rust 快照不同");
    return writtenAt;
  } finally {
    await directory.removeEntry(name);
  }
}

async function readSnapshot(worker: Worker, revision: Revision): Promise<string> {
  // 每个样本使用新 Worker。诊断请求取前端编号上界，与本次会话自 1 递增的请求分开。
  const requestId = FRONTEND_REQUEST_ID_MAX;
  return new Promise<string>((resolve, reject) => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error("读取 Rust 正文快照超时"));
    }, 5000);
    worker.addEventListener("message", ({ data }: MessageEvent<ResponseEnvelope>) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      abort.abort();
      if (data.body.type === "snapshot-ready" && data.body.revision === revision) resolve(data.body.text);
      else reject(new Error("Rust 未返回指定修订的快照"));
    }, { signal: abort.signal });
    worker.postMessage({ protocolVersion: PROTOCOL_VERSION, generation: 1, documentId: "benchmark",
      requestId, body: { type: "get-snapshot", revision } });
  });
}
