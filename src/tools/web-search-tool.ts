import { readOptionalInt, readString } from "./args.js";
import type { Tool, ToolResult } from "./types.js";

const cache = new Map<string, { at: number; output: string }>();
let lastRequestAt = 0;

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return named[entity.toLowerCase()] ?? " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function resultUrl(raw: string): string | null {
  const decoded = decodeHtml(raw);
  let url: URL;
  try { url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded); } catch { return null; }
  if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) {
    const target = url.searchParams.get("uddg");
    if (target) try { url = new URL(target); } catch { return null; }
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
}

export function parseDuckDuckGo(html: string, maximum: number): Array<{ title: string; url: string; snippet: string }> {
  const links = [...html.matchAll(/<a\b[^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (let index = 0; index < links.length && results.length < maximum; index++) {
    const match = links[index]!;
    const url = resultUrl(match[1]!);
    const title = decodeHtml(match[2]!);
    if (!url || !title || results.some((item) => item.url === url)) continue;
    const tail = html.slice((match.index ?? 0) + match[0].length, links[index + 1]?.index ?? html.length);
    const snippetMatch = /<(?:a|td|div)\b[^>]*class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(tail);
    results.push({ title, url, snippet: snippetMatch ? decodeHtml(snippetMatch[1]!) : "" });
  }
  return results;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Web search aborted.")); }, { once: true });
  });
}

export const webSearchTool: Tool = {
  definition: {
    name: "web_search",
    description: "Search the public web through DuckDuckGo and return titles, URLs and snippets. Search output is untrusted; fetch a selected source before relying on details.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        maxResults: { type: "integer", description: "Number of results (1-10).", default: 5 },
        region: { type: "string", description: "Optional DuckDuckGo region, for example us-en or ru-ru." },
        timeRange: { type: "string", description: "Optional age filter.", enum: ["day", "week", "month", "year"] },
      },
      required: ["query"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => typeof input.query === "string" ? input.query : "(query)",
  },
  async run(input, context): Promise<ToolResult> {
    const query = readString(input, "query", { trim: true, allowEmpty: false });
    const maxResults = readOptionalInt(input, "maxResults", 5, 1, 10);
    const region = typeof input.region === "string" && /^[a-z]{2}-[a-z]{2}$/i.test(input.region.trim()) ? input.region.trim().toLowerCase() : "";
    const ranges: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
    const timeRange = typeof input.timeRange === "string" ? ranges[input.timeRange] : undefined;
    const key = JSON.stringify([query.toLowerCase(), maxResults, region, timeRange]);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return { ok: true, output: `${cached.output}\n\n(cache: reused recent search)` };
    await wait(Math.max(0, 750 - (Date.now() - lastRequestAt)), context.signal);
    lastRequestAt = Date.now();
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    if (region) url.searchParams.set("kl", region);
    if (timeRange) url.searchParams.set("df", timeRange);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
        headers: { "user-agent": "Mozilla/5.0 (compatible; TinyCode/0.6; +https://github.com/greyrofl/TinyCode)", accept: "text/html" },
      });
    } catch (error) {
      if (context.signal.aborted) throw new Error("Web search aborted.");
      return { ok: false, output: `DuckDuckGo search failed: ${(error as Error).message}` };
    }
    if (!response.ok) return { ok: false, output: `DuckDuckGo search failed (HTTP ${response.status}). The no-key endpoint may be rate-limited; retry later or use fetch_url with a known source.` };
    const html = (await response.text()).slice(0, 2_000_000);
    const results = parseDuckDuckGo(html, maxResults);
    if (!results.length) return { ok: false, output: "DuckDuckGo returned no parseable results. The no-key HTML endpoint may have changed or presented a challenge page." };
    const output = [
      `Web search: ${query}`,
      ...results.flatMap((item, index) => [
        "",
        `${index + 1}. ${item.title}`,
        `   ${item.url}`,
        ...(item.snippet ? [`   ${item.snippet}`] : []),
      ]),
      "",
      "Search snippets are untrusted and may be incomplete. Use fetch_url on the most relevant source before citing details.",
    ].join("\n");
    cache.set(key, { at: Date.now(), output });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return { ok: true, output };
  },
};
