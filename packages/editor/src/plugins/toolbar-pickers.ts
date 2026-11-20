import { TABLE_INSERTION_LIMITS } from "../components/block-commands.js";
import type { TableInsertionSize } from "../core/commands/index.js";

export function createTablePicker(
  panel: HTMLElement,
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
    label.append(unit);
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

  const rows = field("rows", "行数（含表头）", TABLE_INSERTION_LIMITS.rows);
  const columns = field("columns", "列数", TABLE_INSERTION_LIMITS.columns);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "插入表格";

  const preview = document.createElement("div");
  preview.className = "jot-editor-toolbar__table-preview";
  const grid = document.createElement("div");
  grid.className = "jot-editor-toolbar__table-grid";
  // Numeric fields provide the same selection for keyboard and assistive technology.
  preview.setAttribute("aria-hidden", "true");
  const sizeLabel = document.createElement("div");
  sizeLabel.className = "jot-editor-toolbar__table-size";

  const cells = Array.from({ length: gridRows * gridColumns }, (_, index) => {
    const cell = document.createElement("button");
    const size = { rows: Math.floor(index / gridColumns) + 1, columns: index % gridColumns + 1 };
    cell.type = "button";
    cell.tabIndex = -1;
    cell.dataset["rows"] = String(size.rows);
    cell.dataset["columns"] = String(size.columns);
    cell.addEventListener("pointerdown", (event) => event.preventDefault());
    cell.addEventListener("pointerenter", () => draw(size));
    cell.addEventListener("click", () => insert(size));
    grid.append(cell);
    return { cell, size };
  });

  function draw(size: TableInsertionSize): void {
    for (const entry of cells) {
      entry.cell.toggleAttribute("data-selected", entry.size.rows <= size.rows && entry.size.columns <= size.columns);
    }
    sizeLabel.textContent = `${size.rows || "–"} 行 × ${size.columns || "–"} 列`;
  }

  const fieldSize = () => ({ rows: rows.valueAsNumber, columns: columns.valueAsNumber });
  grid.addEventListener("pointerleave", () => draw(fieldSize()));
  dimensions.addEventListener("input", () => draw(fieldSize()));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    insert(fieldSize());
  });
  preview.append(grid, sizeLabel);
  form.append(dimensions, submit);
  panel.append(preview, form);
  draw(fieldSize());
  return rows;
}
