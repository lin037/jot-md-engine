import { chinesePhrases, formatPhrase } from "./phrases.js";
import type { EditorCommand } from "./commands/types.js";

export type EditorTranslations = Readonly<Record<string, Readonly<Record<string, string>>>>;
type LabelTarget = "textContent" | "aria-label" | "title" | "placeholder";
type Label = { phrase: string | (() => string); values: readonly (string | number)[] };
const scopes = new WeakMap<HTMLElement, EditorI18n>();
// Built-in command metadata predates i18n. Keep the public registry and host commands intact.
const sources = new Map<string, string>();
for (const [english, chinese] of Object.entries(chinesePhrases)) {
  if (!sources.has(chinese)) sources.set(chinese, english);
}

function languageTag(value: string): string | undefined {
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return undefined; }
}

/** UI language and dictionaries belong to one editor, including its external panels. */
export class EditorI18n {
  readonly #catalogs = new Map<string, Readonly<Record<string, string>>>();
  readonly #roots = new Map<HTMLElement, string | null>();
  readonly #labels = new WeakMap<HTMLElement, Map<LabelTarget, Label>>();
  readonly #listeners = new Set<() => void>();
  readonly #window: Window | null;
  #choice: string;
  #locale = "";
  // CodeMirror reads this table on demand. Replacing its phrases facet rebuilds
  // the view and discards open input fields and active compositions.
  readonly #phrases: Record<string, string> = Object.create(null);
  readonly #onLanguageChange = () => { if (this.#choice === "auto") this.setLocale("auto"); };

  constructor(locale = "auto", translations: EditorTranslations = {}, window: Window | null = globalThis.window ?? null) {
    this.#window = window;
    this.#catalogs.set("en", {});
    this.#catalogs.set("zh-CN", {});
    for (const [tag, dictionary] of Object.entries(translations)) {
      const key = languageTag(tag);
      if (key) this.#catalogs.set(key, { ...this.#catalogs.get(key), ...dictionary });
    }
    this.#choice = locale;
    this.setLocale(locale);
    window?.addEventListener("languagechange", this.#onLanguageChange);
  }

  get locale(): string { return this.#locale; }
  get phrases(): Readonly<Record<string, string>> { return this.#phrases; }

  setLocale(choice: string): void {
    this.#choice = choice;
    const nav = this.#window?.navigator;
    const preferences = choice === "auto" ? [...(nav?.languages ?? []), nav?.language ?? "en"] : [choice];
    let locale = "en";
    for (const preference of preferences) {
      let tag = languageTag(preference) ?? "";
      while (tag && !this.#catalogs.has(tag)) {
        if (tag === "zh") { tag = "zh-CN"; break; }
        tag = tag.includes("-") ? tag.slice(0, tag.lastIndexOf("-")) : "";
      }
      if (tag) { locale = tag; break; }
    }
    if (locale === this.#locale) return;
    const subtags = locale.split("-");
    for (const key of Object.keys(this.#phrases)) delete this.#phrases[key];
    Object.assign(this.#phrases, this.#catalogs.get("en"));
    if (subtags[0] === "zh") Object.assign(this.#phrases, chinesePhrases);
    for (let count = 1; count <= subtags.length; count++) {
      Object.assign(this.#phrases, this.#catalogs.get(subtags.slice(0, count).join("-")));
    }
    this.#locale = locale;
    for (const root of this.#roots.keys()) {
      root.lang = locale;
      for (const element of [root, ...root.querySelectorAll<HTMLElement>("[data-jot-i18n]")]) {
        for (const [target, label] of this.#labels.get(element) ?? []) this.#write(element, target, label);
      }
    }
    for (const listener of this.#listeners) listener();
  }

  t(phrase: string, ...values: readonly (string | number)[]): string {
    const key = sources.get(phrase) ?? phrase;
    const template = Object.hasOwn(this.#phrases, key) ? this.#phrases[key]! : key;
    return formatPhrase(template, ...values);
  }

  command(command: EditorCommand): EditorCommand {
    return { ...command, title: this.t(command.title),
      ...(command.description === undefined ? {} : { description: this.t(command.description) }),
      ...(command.category === undefined ? {} : { category: this.t(command.category) }) };
  }

  /** Only explicitly bound UI labels are revisited. Source text and input values are never scanned. */
  bind(element: HTMLElement, target: LabelTarget, phrase: Label["phrase"], ...values: (string | number)[]): void {
    let labels = this.#labels.get(element);
    if (!labels) {
      labels = new Map();
      this.#labels.set(element, labels);
      element.setAttribute("data-jot-i18n", "");
    }
    const label = { phrase, values };
    labels.set(target, label);
    this.#write(element, target, label);
  }

  #write(element: HTMLElement, target: LabelTarget, label: Label): void {
    const value = typeof label.phrase === "string" ? this.t(label.phrase, ...label.values) : label.phrase();
    if (target === "textContent") {
      if (element.textContent !== value) element.textContent = value;
    } else if (element.getAttribute(target) !== value) element.setAttribute(target, value);
  }

  scope(root: HTMLElement): () => void {
    const old = root.getAttribute("lang");
    scopes.set(root, this);
    this.#roots.set(root, old);
    root.lang = this.#locale;
    return () => {
      if (scopes.get(root) !== this) return;
      scopes.delete(root);
      this.#roots.delete(root);
      if (old === null) root.removeAttribute("lang"); else root.lang = old;
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  dispose(): void {
    this.#window?.removeEventListener("languagechange", this.#onLanguageChange);
    for (const [root, old] of this.#roots) {
      scopes.delete(root);
      if (old === null) root.removeAttribute("lang"); else root.lang = old;
    }
    this.#roots.clear();
    this.#listeners.clear();
  }
}

const standalone = new EditorI18n("zh-CN", {}, null);
export function editorI18nAt(element: HTMLElement): EditorI18n {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const i18n = scopes.get(node);
    if (i18n) return i18n;
  }
  return standalone;
}
