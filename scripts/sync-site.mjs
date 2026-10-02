#!/usr/bin/env node
// Applies site.config.json to the static site and regenerates
// site/ws-resources.json. Run it after changing a link, after adding or
// removing a file in site/, and after setting siteUrl once the SuiNS name
// exists. It never touches object_id, so updates keep targeting the same
// Walrus Site.
//
//   node scripts/sync-site.mjs          apply and write
//   node scripts/sync-site.mjs --check  exit 1 if anything is out of date

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const siteDir = join(root, "site");
const config = JSON.parse(readFileSync(join(root, "site.config.json"), "utf8"));
const check = process.argv.includes("--check");
let stale = false;

const write = (file, next) => {
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current === next) return;
  stale = true;
  if (check) console.log(`out of date: ${relative(root, file)}`);
  else {
    writeFileSync(file, next);
    console.log(`updated: ${relative(root, file)}`);
  }
};

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

// 1. Links and repeated text in every HTML page.
const siteUrl = config.siteUrl ? config.siteUrl.replace(/\/+$/, "") : "";
for (const file of walk(siteDir).filter((f) => f.endsWith(".html"))) {
  let html = readFileSync(file, "utf8");

  html = html.replace(/<a\b([^>]*?)\bhref="[^"]*"([^>]*?)\bdata-link="([a-z]+)"/g, (whole, before, between, key) => {
    const url = config.links[key];
    if (!url) throw new Error(`site.config.json has no links.${key} (used in ${relative(root, file)})`);
    return `<a${before}href="${escapeAttr(url)}"${between}data-link="${key}"`;
  });

  html = html.replace(/(<(span|code)\b[^>]*\bdata-text="([A-Za-z]+)"[^>]*>)([^<]*)(<\/\2>)/g, (whole, open, tag, key, _text, close) => {
    const value = config.text[key];
    if (value === undefined) throw new Error(`site.config.json has no text.${key} (used in ${relative(root, file)})`);
    return `${open}${escapeText(value)}${close}`;
  });

  // Absolute URLs for social previews, only once the public address is known.
  if (file === join(siteDir, "index.html")) {
    const block = siteUrl
      ? [
          `<!-- site-url:start -->`,
          `  <link rel="canonical" href="${escapeAttr(siteUrl)}/">`,
          `  <meta property="og:url" content="${escapeAttr(siteUrl)}/">`,
          `  <meta property="og:image" content="${escapeAttr(siteUrl)}/images/og.png">`,
          `  <meta name="twitter:image" content="${escapeAttr(siteUrl)}/images/og.png">`,
          `  <!-- site-url:end -->`,
        ].join("\n")
      : [
          `<!-- site-url:start -->`,
          `  <!-- Set siteUrl in site.config.json and rerun scripts/sync-site.mjs to make these absolute and add canonical and og:url. -->`,
          `  <meta property="og:image" content="images/og.png">`,
          `  <meta name="twitter:image" content="images/og.png">`,
          `  <!-- site-url:end -->`,
        ].join("\n");
    html = html.replace(/<!-- site-url:start -->[\s\S]*?<!-- site-url:end -->/, block);
  }

  write(file, html);
}

// 2. ws-resources.json. Header keys must be exact resource paths; the Walrus
// Sites portal does not support wildcards in the headers section.
const types = {
  ".html": ["text/html; charset=utf-8", "no-cache"],
  ".css": ["text/css; charset=utf-8", "max-age=3600"],
  ".js": ["application/javascript; charset=utf-8", "max-age=3600"],
  // Font and image files are renamed when they change, so they can be cached long.
  ".woff2": ["font/woff2", "max-age=31536000, immutable"],
  ".webp": ["image/webp", "max-age=604800"],
  ".png": ["image/png", "max-age=604800"],
  ".ico": ["image/x-icon", "max-age=604800"],
  ".svg": ["image/svg+xml", "max-age=604800"],
  ".txt": ["text/plain; charset=utf-8", "max-age=604800"],
};

const wsPath = join(siteDir, "ws-resources.json");
const previous = existsSync(wsPath) ? JSON.parse(readFileSync(wsPath, "utf8")) : {};

const headers = {};
for (const file of walk(siteDir).sort()) {
  const rel = "/" + relative(siteDir, file).split(sep).join("/");
  if (rel === "/ws-resources.json") continue;
  const type = types[extname(file).toLowerCase()];
  if (!type) throw new Error(`No Content-Type rule for ${rel}. Add its extension to scripts/sync-site.mjs.`);
  headers[rel] = { "Content-Type": type[0], "Cache-Control": type[1] };
}

const metadata = {
  description: config.description,
  project_url: config.links.repo,
  creator: config.creator,
};
if (siteUrl) {
  metadata.link = siteUrl;
  metadata.image_url = `${siteUrl}/images/og.png`;
}

const ws = {
  site_name: config.siteName,
  ...(previous.object_id ? { object_id: previous.object_id } : {}),
  metadata,
  headers,
};

write(wsPath, JSON.stringify(ws, null, 2) + "\n");

if (check && stale) process.exit(1);
if (!stale) console.log("site is in sync with site.config.json");
