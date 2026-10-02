import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { fetchTranscript, type TranscriptResult, type TranscriptSegment } from "youtube-transcript-plus";
import type { Content } from "../types.js";

export type FetchResult = { ok: true; content: Content } | { ok: false; reason: "paste" | "unreachable"; source: string; title?: string };

const UA = "Mozilla/5.0 (compatible; OctoKeepBot/1.0; +https://t.me/OctoKeep_bot)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MAX_BYTES = 3_000_000;
const MAX_TEXT = 20_000;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;

export function findUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  // Trailing punctuation from the surrounding sentence is not part of the URL.
  return m[0].replace(/[),.;:!?\]]+$/, "");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const host = (u: URL) => u.hostname.replace(/^(www\.|m\.|mobile\.)/, "");

async function get(url: string, opts: { ua?: string; accept?: string; timeoutMs?: number } = {}): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": opts.ua ?? BROWSER_UA, accept: opts.accept ?? "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en" },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
  });
}

async function readText(res: Response): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("page too large");
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}

export function youtubeId(u: URL): string | null {
  const h = host(u);
  if (h === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (h.endsWith("youtube.com")) {
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
    if (m) return m[2]!;
  }
  return null;
}

async function youtube(u: URL, id: string): Promise<FetchResult> {
  let title = "YouTube video";
  try {
    const o = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.toString())}`, { accept: "application/json" });
    if (o.ok) title = ((await o.json()) as { title?: string }).title ?? title;
  } catch {
    // Title is a nicety; the transcript is what matters.
  }
  try {
    const res: TranscriptResult = await fetchTranscript(id, { videoDetails: true, retries: 1 });
    const text = clean(res.segments.map((s: TranscriptSegment) => s.text).join(" "));
    const details = res.videoDetails;
    if (text.length > 40) {
      return {
        ok: true,
        content: {
          title: details?.title ?? title,
          source: `YouTube${details?.author ? `, ${details.author}` : ""}`,
          text: `${details?.description ? `Description: ${details.description.slice(0, 1500)}\n\nTranscript: ` : ""}${text}`.slice(0, MAX_TEXT),
          url: u.toString(),
        },
      };
    }
  } catch {
    // YouTube often blocks transcript requests from cloud servers. Fall through.
  }
  return { ok: false, reason: "paste", source: "YouTube", title };
}

async function oembedText(endpoint: string, source: string, u: URL): Promise<FetchResult> {
  try {
    const res = await get(`${endpoint}${encodeURIComponent(u.toString())}`, { accept: "application/json" });
    if (res.ok) {
      const data = (await res.json()) as { html?: string; title?: string; author_name?: string };
      const fromHtml = data.html ? clean(parseHTML(`<div>${data.html}</div>`).document.querySelector("blockquote, div")?.textContent ?? "") : "";
      const text = clean(fromHtml || data.title || "");
      if (text.length > 20) {
        return { ok: true, content: { title: (data.title || text).slice(0, 100), source: `${source}${data.author_name ? `, ${data.author_name}` : ""}`, text, url: u.toString() } };
      }
    }
  } catch {
    // Fall through to asking for the text.
  }
  return { ok: false, reason: "paste", source };
}

async function reddit(u: URL): Promise<FetchResult> {
  try {
    const jsonUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}.json?limit=8&raw_json=1`;
    const res = await get(jsonUrl, { ua: UA, accept: "application/json" });
    if (res.ok) {
      const data = (await res.json()) as Array<{ data: { children: Array<{ data: { title?: string; selftext?: string; body?: string; subreddit?: string; score?: number } }> } }>;
      const post = data[0]?.data.children[0]?.data;
      if (post?.title) {
        const comments = (data[1]?.data.children ?? [])
          .map((c) => c.data)
          .filter((c) => c.body)
          .slice(0, 6)
          .map((c) => `- ${clean(c.body!).slice(0, 600)}`)
          .join("\n");
        return {
          ok: true,
          content: {
            title: post.title,
            source: `Reddit${post.subreddit ? `, r/${post.subreddit}` : ""}`,
            text: `${clean(post.selftext ?? "")}\n\nTop comments:\n${comments}`.slice(0, MAX_TEXT),
            url: u.toString(),
          },
        };
      }
    }
  } catch {
    // Reddit rate-limits anonymous requests; try the page itself.
  }
  return article(u);
}

export function extractArticle(html: string, url: string): Content | null {
  const { document } = parseHTML(html);
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  const ogTitle = meta('meta[property="og:title"]') || document.querySelector("title")?.textContent?.trim() || "";
  const ogDesc = meta('meta[property="og:description"]') || meta('meta[name="description"]');
  const siteName = meta('meta[property="og:site_name"]');
  let title = ogTitle;
  let text = "";
  try {
    const parsed = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
    if (parsed?.textContent) {
      text = clean(parsed.textContent);
      title = parsed.title?.trim() || title;
    }
  } catch {
    // Readability fails on some layouts; the meta description is the fallback.
  }
  if (text.length < 200 && ogDesc) text = clean(`${ogDesc} ${text}`);
  if (text.length < 40) return null;
  let source = siteName;
  if (!source) {
    try {
      source = host(new URL(url));
    } catch {
      source = "Web page";
    }
  }
  return { title: title || url, source, text: text.slice(0, MAX_TEXT), url };
}

async function article(u: URL): Promise<FetchResult> {
  try {
    const res = await get(u.toString());
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("html")) {
      const content = extractArticle(await readText(res), res.url || u.toString());
      if (content) return { ok: true, content };
    }
    return { ok: false, reason: res.ok ? "paste" : "unreachable", source: host(u) };
  } catch {
    return { ok: false, reason: "unreachable", source: host(u) };
  }
}

export async function fetchContent(rawUrl: string): Promise<FetchResult> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unreachable", source: "link" };
  }
  const h = host(u);
  const yt = youtubeId(u);
  if (yt) return youtube(u, yt);
  if (h === "x.com" || h === "twitter.com") return oembedText("https://publish.twitter.com/oembed?omit_script=1&url=", "X", u);
  if (h.endsWith("tiktok.com")) return oembedText("https://www.tiktok.com/oembed?url=", "TikTok", u);
  // Instagram, Facebook and Threads need an app token for oEmbed and forbid
  // scraping, so the user pastes the caption instead.
  if (h.endsWith("instagram.com") || h.endsWith("facebook.com") || h === "fb.watch" || h.endsWith("threads.net") || h.endsWith("threads.com")) {
    return { ok: false, reason: "paste", source: h.split(".")[0]!.replace(/^./, (c) => c.toUpperCase()) };
  }
  if (h.endsWith("reddit.com") || h === "redd.it") return reddit(u);
  return article(u);
}
