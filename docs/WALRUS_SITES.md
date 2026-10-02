# Hosting the OctoKeep site on Walrus Sites

The landing page in `site/` is plain static HTML, CSS and a small script. It deploys to Walrus Sites unchanged and also works on any static host. Nothing in it is secret, and nothing in it may ever be: everything on Walrus Sites is public.

Commands below are for Git Bash on Windows unless marked otherwise. Install and config steps follow the official docs at [docs.wal.app](https://docs.wal.app/docs/sites); check there if a command has changed.

## What you need before deploying

- A Sui wallet address with SUI for gas and WAL for storage, on the network you deploy to.
- The `sui`, `walrus` and `site-builder` command-line tools.
- About 20 SUI per year for a SuiNS name of 5 or more characters (`octokeep` qualifies), if you want the `octokeep.wal.app` address. Check the current price on suins.io before buying.

## 1. Install the tools

`suiup` installs `sui` and `walrus`. On Windows it is easiest from WSL or Git Bash; if `suiup` does not run on your setup, use the pre-built binaries linked from the docs.

```bash
curl -sSfL https://raw.githubusercontent.com/Mystenlabs/suiup/main/install.sh | sh
suiup install sui@mainnet
suiup install walrus@mainnet
suiup install site-builder@mainnet
```

Native Windows binary for `site-builder` (PowerShell), then move `site-builder.exe` into a folder on your PATH:

```powershell
(New-Object System.Net.WebClient).DownloadFile("https://storage.googleapis.com/mysten-walrus-binaries/site-builder-mainnet-latest-windows-x86_64.exe", "site-builder.exe")
```

Check all three:

```bash
sui --version
walrus --version
site-builder --help
```

## 2. Configure them

Walrus client config, which holds both mainnet and testnet contexts:

```bash
curl --create-dirs https://docs.wal.app/setup/client_config.yaml -o ~/.config/walrus/client_config.yaml
```

Site-builder config. Use `mainnet` here for the public `wal.app` address:

```bash
curl --create-dirs https://raw.githubusercontent.com/MystenLabs/walrus-sites/refs/heads/mainnet/sites-config.yaml -o ~/.config/walrus/sites-config.yaml
```

If `site-builder` says it cannot find a sites configuration file, set `SITES_CONFIG` in `.env` to the full path of that file. `scripts/deploy-site.sh` passes it through with `--config`.

The site-builder picks its Sui network from `wallet_env` in `sites-config.yaml`, not from `sui client active-env`, so your Sui client must have an environment with that name. Create and fund an address:

```bash
sui client new-address ed25519
sui client active-address
```

Send SUI to that address, then get WAL. On mainnet, buy or swap for WAL in a Sui wallet. On testnet, use the faucet for SUI and then `walrus get-wal --context testnet`.

```bash
sui client balance
```

## 3. Deploy

From the repository root:

```bash
scripts/deploy-site.sh
```

The script:

1. checks that `site-builder`, `walrus`, `sui` and `node` are installed;
2. runs `node scripts/sync-site.mjs` if `site/` is out of date with `site.config.json`;
3. prints the network, epochs, address, balance, and whether it will create a new site or update the existing one;
4. asks before spending anything, then runs `site-builder --context=<network> deploy --epochs <epochs> ./site`;
5. prints the new site object ID and what to commit.

Settings come from the environment or `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `WALRUS_SITE_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `WALRUS_SITE_EPOCHS` | `max` | How long storage is paid for. 1 epoch is 14 days on mainnet and 1 day on testnet. The maximum is 53 epochs, about two years on mainnet. |
| `SITES_CONFIG` | unset | Path to `sites-config.yaml` if it is not in a default location |

## 4. Commit the object ID

The first deploy writes `object_id` into `site/ws-resources.json`. Commit it straight away:

```bash
git add site/ws-resources.json
git commit -m "chore(site): record walrus site object id"
```

Without it, the next deploy creates a brand new site object instead of updating this one. If the file is ever lost, pass the ID directly: `site-builder deploy --object-id <ID> --epochs max ./site`.

## 5. Link the SuiNS name (mainnet)

The public portal at `wal.app` only serves mainnet sites, and only through a SuiNS name; Base36 subdomains do not work there.

1. Open [suins.io](https://suins.io) and connect the wallet.
2. Search for `octokeep`. Names may use only `a-z` and `0-9`, and `wal.app` resolves names up to 21 characters.
3. Buy it. The cost is shown in SUI before you confirm.
4. Open Names You Own, open the menu on the name, choose Link To Walrus Site, and paste the site object ID.
5. After the transaction confirms, the site is at `https://octokeep.wal.app`.

## 6. Point the page at its new address

Set `siteUrl` in `site.config.json`:

```json
"siteUrl": "https://octokeep.wal.app"
```

Then sync and redeploy:

```bash
node scripts/sync-site.mjs
scripts/deploy-site.sh
git add site.config.json site/index.html site/ws-resources.json
git commit -m "feat(site): set public site url"
```

This adds the canonical link and `og:url`, makes the social image URLs absolute so link previews work, and fills `link` and `image_url` in the on-chain site metadata.

## Updating the site later

Edit files in `site/`, then:

```bash
node scripts/sync-site.mjs
scripts/deploy-site.sh
```

`sync-site.mjs` rewrites every link marked `data-link` and every text marked `data-text` from `site.config.json`, and regenerates the `headers` and `metadata` in `site/ws-resources.json`. It never changes `object_id`. Header keys must be exact file paths, because the portal does not support wildcards there, which is why the script lists every file. Run `node scripts/sync-site.mjs --check` in CI to fail when they drift.

If you replace a font or image with different content, give it a new file name. Those files are served with long cache lifetimes.

## Keeping it alive

Storage is paid per epoch. When blobs expire, the portal shows "This content is no longer available" and the site is gone until you redeploy. Check expiry dates:

```bash
site-builder sitemap <site-object-id>
```

Running `scripts/deploy-site.sh` again with `WALRUS_SITE_EPOCHS=max` extends storage to the maximum. Put a reminder in your calendar a few weeks before the earliest expiry date.

## Testnet

There is no public testnet portal; `wal.app` is mainnet only. To view a testnet deploy, run a local portal. It needs Docker, and its version must match your `site-builder`:

```bash
git clone https://github.com/MystenLabs/walrus-sites.git
cd walrus-sites
git checkout mainnet
scripts/local-docker-portal.sh testnet
```

Then open `http://<base36-site-id>.localhost:3000`. The deploy script prints the Base36 form; `site-builder convert <object-id>` gives it too.

## Previewing without deploying

```bash
scripts/preview-site.sh
```

This serves `site/` at `http://localhost:4173` with a plain static server. Missing pages show that server's own 404 rather than `site/404.html`; the Walrus portal serves `site/404.html` for any path it cannot find.

## Fallback hosting

`site/` uses relative paths for everything except `404.html`, which uses root-relative paths because a portal serves it for any missing URL. It works unchanged on GitHub Pages, Vercel, Netlify or any static host. Point the host at the `site/` folder with no build command. Keep the Walrus deploy as the primary address and treat any other host as a mirror.
