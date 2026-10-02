# Design notes: OctoKeep site

## Reference

The layout follows the Walrus Memory dashboard at memory.walrus.xyz/dashboard: a black canvas, one centred column about 1100px wide, a sticky header with a wordmark on the left and a monospace pill plus an outlined pill button on the right, a very large tight heading, a bordered notice with an accent icon, a full-width action card, a row of three resource cards, and large rounded panels holding tables, code blocks, tabs and a segmented toggle.

The brand is OctoKeep's own. The header uses the OctoKeep logo and a two-line `octo` / `keep` wordmark; nothing on the page uses the Walrus or Walrus Memory logo or wordmark, and Walrus Memory is named only where OctoKeep depends on it (the setup guide, the resources card and the footer).

## Typography

The reference page could not be inspected directly from the build environment, so its exact font family was not confirmed. The page uses:

- **Geist** for all text, as a variable font (weights 100 to 900). It is a modern geometric grotesk with the tight, wide-set look of the reference headings.
- **Geist Mono** for code, commands, the handle pill and transcripts.

Both are licensed under the SIL Open Font License 1.1, which allows self-hosting in an open-source project. The licence texts ship next to the font files in `site/fonts/`. Only the Latin subset is included (29 KB and 23 KB as WOFF2), loaded with `font-display: swap`. No font is loaded from a third-party CDN, so the page renders fully from Walrus.

If the reference turns out to use a freely licensed family you prefer, swap the two `@font-face` rules in `site/styles/tokens.css` and the files in `site/fonts/`, give the new files new names, and run `node scripts/sync-site.mjs`.

## Colour

All colours are custom properties in `site/styles/tokens.css`.

| Token | Value | Source |
|---|---|---|
| `--bg` | `#000000` | reference canvas |
| `--surface` | `#151515` | reference panels |
| `--surface-raised` | `#1d1d1d` | reference table rows |
| `--border` / `--border-strong` | `#2b2b2b` / `#3a3a3a` | reference panel and table borders |
| `--text` / `--text-muted` | `#f5f5f2` / `#a3a3a3` | reference headings and subtitles |
| `--accent` | `#d6f26a` | reference key names, badges and info icon |
| `--danger` | `#f26d6d` | reference delete button |
| `--code-keyword` / `--code-string` | `#b49bff` / `#e2f07c` | reference code block |
| `--brand-1` / `--brand-2` | `#ff6a5c` / `#a35cff` | sampled from `assets/OctoKeepBot-logo.png` (octopus body and speech bubble) |

The brand pair is used only for the `keep` half of the wordmark and for focus rings, so the reference palette carries the page and the mascot carries the identity.

Contrast, measured: muted text `#a3a3a3` on the panel surface `#151515` is 7.2:1; the faintest text `#8c8c8c` is 6.3:1 on black and 5.0:1 on table rows; the danger red on table rows is 5.8:1. All pass WCAG AA for body text.

## Images

| File | Made from | Size |
|---|---|---|
| `images/logo-96.webp` | `assets/OctoKeepBot-logo.png`, cropped and scaled | 96 x 96 |
| `images/mascot-520.webp` | `assets/octobot-mascot.png`, cropped and scaled | 520 x 520, shown at up to 220 px |
| `favicon.ico`, `images/favicon-32.png`, `apple-touch-icon.png` | the logo | 16 to 180 px |
| `images/og.png` | `design/og-template.html`, rendered at 1200 x 630 | social preview |

To re-render the social image after a copy or brand change, serve the site (`scripts/preview-site.sh`), copy `design/og-template.html` into `site/` temporarily, screenshot it at 1200 x 630 with any headless browser, save it over `site/images/og.png` under a new name if the content changed, and delete the temporary copy.

## Behaviour

`site/scripts/main.js` is the only script. It handles copy buttons (with a fallback for browsers without the async clipboard API, and a screen-reader announcement), the two tab lists, and the transcript toggle, following the WAI-ARIA tabs pattern with arrow, Home and End keys. With JavaScript off, every link still works and the first tab of each set is visible.

## Responsive

- 1440 px: matches the reference proportions.
- 900 px and below: tables become stacked label and value rows, never horizontal scroll.
- 760 px and below: the handle pill hides, the hero mascot moves above the heading, panels tighten, code blocks give the copy button its own row and scroll inside their box.
- 420 px and below: the header button shortens to "Open".
