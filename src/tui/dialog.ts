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

export function renderDialog(input: DialogInput): RenderedDialog {
  const { width, height, palette } = input;
  const boxWidth = Math.max(24, Math.min(width - 4, 72));
  const innerWidth = boxWidth - 4;
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const border = { fg: palette.border, bg: palette.panel };

  const title = truncateWidth(singleLine(sanitizeText(input.title)), Math.max(4, boxWidth - 8));
  const topContent = `╭─ ${title} `;
  const topFill = Math.max(0, boxWidth - displayWidth(topContent) - 1);
  const rows: Line[] = [
    boxLine([{ text: topContent + "─".repeat(topFill) + "╮", style: border }], boxWidth, palette),
  ];

  for (const line of input.body.slice(0, Math.max(1, height - 5))) {
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

  const footer = truncateWidth(sanitizeText(singleLine(input.footer)), Math.max(4, innerWidth));
  const footerPad = Math.max(0, innerWidth - displayWidth(footer));
  rows.push(
    boxLine(
      [
        { text: "│ ", style: border },
        { text: footer, style: { fg: palette.faint } },
        { text: " ".repeat(footerPad) },
        { text: " │", style: border },
      ],
      boxWidth,
      palette,
    ),
  );
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
  const boxWidth = Math.max(24, Math.min(width - 4, 72));
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
