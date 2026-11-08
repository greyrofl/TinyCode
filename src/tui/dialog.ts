import type { ToolApprovalRequest } from "../tools/types.js";
import { displayWidth, truncateWidth, wrapPlain } from "../util/ansi.js";
import { sanitizeText, singleLine } from "../util/text.js";
import type { Palette } from "./theme.js";
import type { Line } from "./types.js";
import { padLine, spaces } from "./types.js";

export interface RenderedDialog {
  lines: Line[];
  top: number;
}

interface DialogInput {
  title: string;
  body: Line[];
  footer: string;
  width: number;
  height: number;
  palette: Palette;
}

function boxLine(content: Line, boxWidth: number, palette: Palette): Line {
  return padLine(
    content.map((span) => ({ ...span, style: { ...span.style, bg: palette.panel } })),
    boxWidth,
    { bg: palette.panel },
  );
}

function footerLine(text: string, palette: Palette): Line {
  return text.split(/(esc|\by\b|\ba\b|\bn\b)/gi).filter(Boolean).map((part) => {
    if (/^esc$/i.test(part)) return { text: part, style: { fg: palette.warn, bold: true } };
    if (/^[ya]$/i.test(part)) return { text: part, style: { fg: palette.success, bold: true } };
    if (/^n$/i.test(part)) return { text: part, style: { fg: palette.error, bold: true } };
    return { text: part, style: { fg: palette.faint } };
  });
}

export function renderDialog(input: DialogInput): RenderedDialog {
  const { width, height, palette } = input;
  const boxWidth = Math.max(12, Math.min(width - 4, 72));
  const innerWidth = boxWidth - 4;
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const border = { fg: palette.border, bg: palette.panel };

  const title = truncateWidth(singleLine(sanitizeText(input.title)), Math.max(4, boxWidth - 8));
  const topPrefix = "╭─ ";
  const topFill = Math.max(0, boxWidth - displayWidth(topPrefix) - displayWidth(title) - 2);
  const rows: Line[] = [
    boxLine([
      { text: topPrefix, style: border },
      { text: title, style: { fg: palette.accent, bg: palette.panel, bold: true } },
      { text: ` ${"─".repeat(topFill)}╮`, style: border },
    ], boxWidth, palette),
  ];

  const allFooterLines = wrapPlain(sanitizeText(singleLine(input.footer)), innerWidth);
  const footerLines = allFooterLines.slice(0, 2);
  if (allFooterLines.length > 2) footerLines[1] = truncateWidth(`${footerLines[1] ?? ""}…`, innerWidth);
  for (const line of input.body.slice(0, Math.max(1, height - 4 - footerLines.length))) {
    rows.push(
      boxLine(
        [
          { text: "│ ", style: border },
          ...padLine(line, innerWidth, { bg: palette.panel }),
          { text: " │", style: border },
        ],
        boxWidth,
        palette,
      ),
    );
  }

  for (const footer of footerLines) rows.push(boxLine([
    { text: "│ ", style: border },
    ...padLine(footerLine(footer, palette), innerWidth),
    { text: " │", style: border },
  ], boxWidth, palette));
  rows.push(boxLine([{ text: `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, style: border }], boxWidth, palette));

  const boxHeight = rows.length;
  const top = Math.max(1, Math.min(height - boxHeight, Math.floor((height - boxHeight) / 2)));
  const fullWidth = rows.map((row) => padLine([...spaces(left), ...row], width));
  return { lines: fullWidth, top };
}

export function renderApproval(
  request: ToolApprovalRequest,
  width: number,
  height: number,
  palette: Palette,
): RenderedDialog {
  const boxWidth = Math.max(12, Math.min(width - 4, 72));
  const innerWidth = boxWidth - 4;
  const body: Line[] = [
    [
      { text: "Tool: ", style: { fg: palette.faint } },
      { text: sanitizeText(request.tool), style: { fg: palette.accent, bold: true } },
    ],
    [],
  ];

  for (const raw of wrapPlain(sanitizeText(request.summary), innerWidth)) {
    body.push([{ text: raw, style: { fg: palette.text } }]);
  }

  if (request.detail) {
    body.push([]);
    for (const raw of wrapPlain(sanitizeText(request.detail), innerWidth).slice(0, 10)) {
      body.push([{ text: raw, style: { fg: palette.faint } }]);
    }
  }

  return renderDialog({
    title: "Tool approval",
    body,
    footer: "y allow · a allow all · n / esc deny",
    width,
    height,
    palette,
  });
}
