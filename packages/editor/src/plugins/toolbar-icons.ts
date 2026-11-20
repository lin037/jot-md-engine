// Tabler Icons v3.45.0 (MIT). See THIRD-PARTY-NOTICES.txt.
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
  "chevron-down": [
    "M6 9l6 6l6 -6",
  ],
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
  "quote": [
    "M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
    "M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
  ],
} as const;

export type ToolbarIcon = keyof typeof paths;

export function toolbarIcon(document: Document, name: ToolbarIcon): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const data of paths[name]) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}
