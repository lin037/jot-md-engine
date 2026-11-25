// Tabler Icons v3.45.0 (MIT). See THIRD-PARTY-NOTICES.txt.
import { chevronDownPaths, createStrokeIcon } from "../components/common/stroke-icon.js";

const paths = {
  "arrow-back-up": [
    "M9 14l-4 -4l4 -4",
    "M5 10h11a4 4 0 1 1 0 8h-1",
  ],
  "arrow-forward-up": [
    "M15 14l4 -4l-4 -4",
    "M19 10h-11a4 4 0 1 0 0 8h1",
  ],
  "heading": [
    "M7 12h10",
    "M7 5v14",
    "M17 5v14",
    "M15 19h4",
    "M15 5h4",
    "M5 19h4",
    "M5 5h4",
  ],
  "bold": [
    "M7 5h6a3.5 3.5 0 0 1 0 7h-6l0 -7",
    "M13 12h1a3.5 3.5 0 0 1 0 7h-7v-7",
  ],
  "italic": [
    "M11 5l6 0",
    "M7 19l6 0",
    "M14 5l-4 14",
  ],
  "code": [
    "M7 8l-4 4l4 4",
    "M17 8l4 4l-4 4",
    "M14 4l-4 16",
  ],
  "link": [
    "M9 15l6 -6",
    "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464",
    "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463",
  ],
  "table": [
    "M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14",
    "M3 10h18",
    "M10 3v18",
  ],
  "search": [
    "M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0",
    "M21 21l-6 -6",
  ],
  "command": [
    "M7 9a2 2 0 1 1 2 -2v10a2 2 0 1 1 -2 -2h10a2 2 0 1 1 -2 2v-10a2 2 0 1 1 2 2h-10",
  ],
  "chevron-down": chevronDownPaths,
  "dots": [
    "M5 12h.01",
    "M12 12h.01",
    "M19 12h.01",
  ],
  "list": [
    "M9 6l11 0",
    "M9 12l11 0",
    "M9 18l11 0",
    "M5 6l0 .01",
    "M5 12l0 .01",
    "M5 18l0 .01",
  ],
  "list-numbers": [
    "M11 6h9",
    "M11 12h9",
    "M12 18h8",
    "M4 16a2 2 0 1 1 4 0c0 .591 -.5 1 -1 1.5l-3 2.5h4",
    "M6 10v-6l-2 2",
  ],
  "checklist": ["M3 6l2 2 3-4 M11 6h10 M3 16l2 2 3-4 M11 16h10"],
  "checked": ["M9 12l2 2 4-5", "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"],
  "strike": ["M16 6c-1-1.5-2.4-2-4-2-5 0-6 5-2 7 M7 17c1.2 2.4 3.8 3.5 6.7 2.6 2.5-.8 3.5-3.5 1.4-5.6 M3 12h18"],
  "function": ["M6 20c3 1 4-1 4.5-4l1.8-10C13 3 15 3 17 4 M8 10h7"],
  "formula-box": ["M5 4H3v16h2 M19 4h2v16h-2 M15 8H9l3 4-3 4h6"],
  "code-box": ["M4 3h16v18H4z M10 9l-3 3 3 3 M14 9l3 3-3 3"],
  "image": ["M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4", "M14 8h.01"],
  "separator": ["M3 12h18 M8 6h8 M8 18h8"],
  "quote": [
    "M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
    "M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
  ],
} as const;

export type ToolbarIcon = keyof typeof paths;

export function toolbarIcon(document: Document, name: ToolbarIcon): SVGSVGElement {
  return createStrokeIcon(document, paths[name]);
}
