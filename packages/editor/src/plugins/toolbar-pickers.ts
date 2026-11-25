import type { EditorI18n } from "../core/i18n.js";
import { TABLE_INSERTION_LIMITS } from "../components/block-commands.js";
import type { TableInsertionSize } from "../core/commands/index.js";

export function createImagePicker(
  panel: HTMLElement, i18n: EditorI18n, insert: (destination: string) => void, pickFiles?: () => void,
): HTMLElement {
  const document = panel.ownerDocument;
  const file = document.createElement("button");
  if (pickFiles) {
    file.type = "button";
    file.className = "jot-editor-toolbar__image-file";
    i18n.bind(file, "textContent", "Choose image files…");
    file.addEventListener("click", pickFiles);
    panel.append(file);
  }
  const form = document.createElement("form");
  form.className = "jot-editor-toolbar__image-form";
  const label = document.createElement("label");
  const caption = document.createElement("span");
  i18n.bind(caption, "textContent", "Image address");
  const address = document.createElement("input");
  address.name = "destination";
  address.placeholder = "https://…";
  address.required = true;
  address.spellcheck = false;
  address.inputMode = "url";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.disabled = true;
  i18n.bind(submit, "textContent", "Insert");
  address.addEventListener("input", () => { submit.disabled = !address.value.trim(); });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const destination = address.value.trim();
    if (destination) insert(destination);
  });
  label.append(caption, address);
  form.append(label, submit);
  panel.append(form);
  return pickFiles ? file : address;
}

export function createTablePicker(
  panel: HTMLElement,
  i18n: EditorI18n,
  insert: (size: TableInsertionSize) => void,
): HTMLElement {
  const document = panel.ownerDocument;
  const gridRows = 6;
  const gridColumns = 8;
  const form = document.createElement("form");
  form.className = "jot-editor-toolbar__table-form";
  const dimensions = document.createElement("div");
  dimensions.className = "jot-editor-toolbar__dimensions";

  const field = (name: string, unit: string, limit: number) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    i18n.bind(caption, "textContent", unit);
    label.append(caption);
    const input = document.createElement("input");
    input.name = name;
    input.type = "number";
    input.min = "1";
    input.max = String(limit);
    input.step = "1";
    input.required = true;
    input.value = "3";
    label.append(input);
    dimensions.append(label);
    return input;
  };

  const rows = field("rows", "Rows (including header)", TABLE_INSERTION_LIMITS.rows);
  const columns = field("columns", "Columns", TABLE_INSERTION_LIMITS.columns);
  const submit = document.createElement("button");
  submit.type = "submit";
  i18n.bind(submit, "textContent", "Insert table");

  const preview = document.createElement("div");
  preview.className = "jot-editor-toolbar__table-preview";
  const grid = document.createElement("div");
  grid.className = "jot-editor-toolbar__table-grid";
  grid.setAttribute("role", "grid");
  i18n.bind(grid, "aria-label", "Select table rows and columns");
  const sizeLabel = document.createElement("div");
  sizeLabel.className = "jot-editor-toolbar__table-size";

  const gridLines = Array.from({ length: gridRows }, () => {
    const row = document.createElement("div");
    row.setAttribute("role", "row");
    grid.append(row);
    return row;
  });
  let focused = 2 * gridColumns + 2;
  const cells = Array.from({ length: gridRows * gridColumns }, (_, index) => {
    const cell = document.createElement("button");
    const size = { rows: Math.floor(index / gridColumns) + 1, columns: index % gridColumns + 1 };
    cell.type = "button";
    cell.tabIndex = index === focused ? 0 : -1;
    cell.setAttribute("role", "gridcell");
    i18n.bind(cell, "aria-label", "$1 × $2 (rows × columns)", size.rows, size.columns);
    cell.addEventListener("focus", () => {
      cells[focused]!.cell.tabIndex = -1;
      focused = index;
      cell.tabIndex = 0;
      draw(size);
    });
    cell.dataset["rows"] = String(size.rows);
    cell.dataset["columns"] = String(size.columns);
    cell.addEventListener("pointerdown", (event) => event.preventDefault());
    cell.addEventListener("pointerenter", () => draw(size));
    cell.addEventListener("click", () => insert(size));
    gridLines[size.rows - 1]!.append(cell);
    return { cell, size };
  });

  function draw(size: TableInsertionSize): void {
    for (const entry of cells) {
      entry.cell.toggleAttribute("data-selected", entry.size.rows <= size.rows && entry.size.columns <= size.columns);
    }
    i18n.bind(sizeLabel, "textContent", "$1 × $2 (rows × columns)", size.rows || "–", size.columns || "–");
  }

  grid.addEventListener("keydown", event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const { rows, columns } = cells[focused]!.size;
    let row = rows, column = columns;
    switch (event.key) {
      case "ArrowLeft": column--; break;
      case "ArrowRight": column++; break;
      case "ArrowUp": row--; break;
      case "ArrowDown": row++; break;
      case "Home": column = 1; break;
      case "End": column = gridColumns; break;
      default: return;
    }
    event.preventDefault();
    const index = (Math.max(1, Math.min(gridRows, row)) - 1) * gridColumns + Math.max(1, Math.min(gridColumns, column)) - 1;
    cells[index]!.cell.focus({ preventScroll: true });
  });

  const fieldSize = () => ({ rows: rows.valueAsNumber, columns: columns.valueAsNumber });
  grid.addEventListener("pointerleave", () => draw(cells[focused]!.size));
  dimensions.addEventListener("input", () => draw(fieldSize()));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    insert(fieldSize());
  });
  const heading = document.createElement("div");
  heading.className = "jot-editor-toolbar__table-heading";
  const title = document.createElement("strong");
  i18n.bind(title, "textContent", "Insert table");
  heading.append(title, sizeLabel);
  preview.append(heading, grid);
  form.append(dimensions, submit);
  const custom = document.createElement("details");
  const summary = document.createElement("summary");
  i18n.bind(summary, "textContent", "Custom size");
  custom.append(summary, form);
  panel.append(preview, custom);
  draw(fieldSize());
  return cells[focused]!.cell;
}
