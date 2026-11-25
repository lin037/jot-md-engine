import { EditorI18n } from "../../src/core/i18n.js";
import { createDefaultEditorCommandRegistry } from "../../src/components/commands.js";

function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}

const browser = Object.assign(new EventTarget(), {
  navigator: { languages: ["de-DE", "zh-TW"], language: "en-US" },
});
const i18n = new EditorI18n("auto", {
  zh: { Search: "检索" },
  "zh-CN": { Bold: "粗体" },
  fr: { Bold: "Gras" },
  "fr-CA": { "Insert image": "Insérer une image", "$1 × $2 (rows × columns)": "$2 colonnes, $1 lignes" },
  "zh-Hant": { Search: "搜尋" },
  "zh-Hant-TW": { Bold: "粗體" },
}, browser as unknown as Window);
equal(i18n.locale, "zh");
equal(i18n.t("Go to line"), "跳转到行");
i18n.setLocale("zh-CN");
equal(i18n.t("Search"), "检索");
equal(i18n.t("Bold"), "粗体");
i18n.setLocale("auto");

let changes = 0;
const unsubscribe = i18n.subscribe(() => { changes++; });
browser.navigator.languages = ["fr-ca"];
browser.dispatchEvent(new Event("languagechange"));
equal(i18n.locale, "fr-CA");
equal(i18n.t("Bold"), "Gras");
equal(i18n.t("Insert image"), "Insérer une image");
equal(i18n.t("Search"), "Search");
equal(i18n.t("$1 × $2 (rows × columns)", 3, 4), "4 colonnes, 3 lignes");
equal(changes, 1);
i18n.setLocale("fr-CA");
browser.navigator.languages = ["en-GB"];
browser.dispatchEvent(new Event("languagechange"));
equal(i18n.locale, "fr-CA");
equal(changes, 1);

i18n.setLocale("zh-Hant-TW");
equal(i18n.t("Search"), "搜尋");
equal(i18n.t("Italic"), "斜体");
equal(i18n.t("Bold"), "粗體");
i18n.setLocale("auto");
equal(i18n.locale, "en");
browser.navigator.languages = ["de"];
browser.dispatchEvent(new Event("languagechange"));
equal(i18n.locale, "en");
i18n.setLocale("not a tag");
equal(i18n.locale, "en");

const registry = createDefaultEditorCommandRegistry("MacIntel");
for (const command of registry.commands) {
  const localized = i18n.command(command);
  equal(localized.id, command.id);
  equal(localized.run, command.run);
  if (/\p{Script=Han}/u.test([localized.title, localized.category, localized.description].join(" "))) {
    throw new Error(`missing English phrase in ${command.id}`);
  }
}
equal(registry.command("format.bold")?.title, "加粗");
i18n.setLocale("auto");
unsubscribe();
i18n.dispose();
browser.navigator.languages = ["zh-CN"];
browser.dispatchEvent(new Event("languagechange"));
equal(i18n.locale, "en");
