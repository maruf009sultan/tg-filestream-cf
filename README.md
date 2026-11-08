# ⚡ TG FileStream PRO

> **Telegram file → instant streaming link.** A zero-database file-to-link bot + streaming server that runs entirely on a single Cloudflare Worker. Single file, no dependencies, no KV, no D1, no R2, no server.

![version](https://img.shields.io/badge/version-3.0.0_ULTRA-7c5cff) ![platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-f48120?logo=cloudflare) ![database](https://img.shields.io/badge/database-NONE-34d399) ![license](https://img.shields.io/badge/license-MIT-8b93ad) ![tests](https://img.shields.io/badge/tests-54_passing-34d399)

```
Send file to bot ──▶ mirrored to your Telegram channel ──▶ signed link minted
                                                           │
   ┌──────────┬──────────┬──────────┬──────────┬───────────┼──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼           ▼          ▼          ▼
 /stream/   /dl/       /watch/    /e/        /qr/       /s/ /w/    @bot       Mini App
 stream     download   player     iframe     QR code    aliases   inline    dashboard
```

---

## 1 · Why this exists (the research)

This is a ground-up upgrade of [`ryoaonetsuki/telegram-file-stream`](https://github.com/ryoaonetsuki/telegram-file-stream) → which is itself a fork of [`Vauth/filestream-cf`](https://github.com/Vauth/filestream-cf) (87★, the first Workers-based file-to-link bot). Before rewriting, we surveyed the whole ecosystem across languages:

| Project | Language / Platform | Storage | Range / seek | Multi-token | TTL links | Password | Revocation | Inline | Upload-by-URL | Web UI |
|---|---|---|---|---|---|---|---|---|---|---|
| **TG FileStream PRO v3 (this repo)** | **JS / Cloudflare Workers** | **None (signed links)** | ✅ 206 pass-through | ✅ round-robin + **failover** | ✅ signed-in-link | ✅ HMAC proof | ✅ instant | ✅ | ✅ **batch** | ✅ player + **embed + mini app** |
| Vauth/filestream-cf (original) | JS / CF Workers | Telegram channel | ❌ buffers whole file | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ (config generator only) |
| ryoaonetsuki fork | JS / CF Workers | Telegram channel | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| [EverythingSuckz/TG-FileStreamBot](https://github.com/EverythingSuckz/TG-FileStreamBot) (1.9k★, filestream.bot) | Go / VPS+Docker | MongoDB | ✅ (MTProto) | ✅ up to 50 tokens | ❌ | ❌ | ❌ | ❌ | ❌ | minimal |
| [TheCaduceus/FileStreamBot](https://github.com/TheCaduceus/FileStreamBot) | Python (Pyrogram) / VPS+Docker | MongoDB | ✅ (MTProto) | ✅ token list | ❌ | ❌ | partial | ❌ | ❌ | ❌ |
| ShivamNox/FileStreamBot-Pro | Python (Pyrogram) / VPS | MongoDB | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Pyro-FileStreamBot | Python (Pyrogram) / VPS | MongoDB | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | demo page |
| MadelineProto-based bots ([danog/MadelineProto](https://github.com/danog/MadelineProto)) | PHP / VPS | Files/DB | ✅ (MTProto) | ✅ (userbots) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| codebam/cf-workers-telegram-bot | JS / CF Workers | KV | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Svelte app |

**What we ported and where from:**

- **Multi-token round-robin** — idea from filestream.bot's "Multi-Bot Workers" (Go). Rebuilt for the Bot API: each token converts the stored channel message into *its own* `file_id` via a metadata probe, then downloads. Works on the plain Bot API with zero MTProto.
- **Real HTTP streaming** — everything else that runs on Workers buffers the entire file (`arrayBuffer()`); we stream `upstream.body` straight through and forward `Range` headers so video seeks instantly (HTTP 206).
- **TTL + password links, revocation UX** — inspired by TheCaduceus-style bots, but reimplemented *without any database* (see §2).
- **Inline mode** — kept from the original filestream-cf (`@bot <payload>` resends the file into any chat), upgraded with real thumbnails and captions.
- **Upload-by-URL** — a classic mirror-bot feature (`/upload <url>`), size-guarded.
- **Legacy link support** — the original XOR+base32 hash scheme is ported verbatim, so old `/?file=<hash>` links keep working after migration.

---

## 2 · The zero-database tricks

Everything competitors store in MongoDB lives in the *link itself* here:

| Needs a DB elsewhere | How PRO does it (stateless) |
|---|---|
| File store | Your Telegram log channel **is** the storage. Files are mirrored there once. |
| Link → file lookup | Link payload = `b64url({channel, message, kind})` + **HMAC-SHA256 signature**. Self-describing, unforgeable. |
| File metadata (name/mime/size/thumb) | Resolved on demand with a **non-destructive `editMessageReplyMarkup` probe** (the original destroyed captions with `editMessageCaption`!) and edge-cached 30 min via the **Cache API**. Bonus: the probe returns a `file_id` valid for whichever bot token called it → multi-token for free. |
| Link expiry | `e` (epoch) inside the signed payload — links **kill themselves**, nothing to sweep. |
| Password protection | Only `HMAC(secret, "pwd:"+password)` is stored in the link. Proof-of-knowledge on every request — the password is *never* stored anywhere. |
| Ban / rate-limit | Environment allowlist (`OWNER_IDS`, `PUBLIC_BOT=false`) — zero storage. (Cloudflare's edge handles volumetric abuse.) |
| Revocation | `/del <payload>` deletes the channel message **and purges every edge cache entry** (all token slots + thumb) → all links die instantly. |

No KV. No D1. No R2. Not even a counter.

### v3 additions to the trick list

| Needs a DB elsewhere | v3 trick |
|---|---|
| Short-link table | **Binary payload format**: `[ver][flags][zigzag(chat)][varint(msg)][expiry?][proof?][name?] + HMAC[0:16]`, b64url — ~44 chars vs ~72 for JSON (−45%). Perfect for QR codes. v2 JSON links stay valid forever. |
| QR code service | A **pure-JS QR Model-2 encoder** (GF(256), Reed-Solomon, mask scoring) + a **raw PNG writer** (stored deflate blocks — no zlib lib). `/qr` sends a real PNG photo; `/qr/<payload>` serves SVG at the edge. |
| User settings store | Language is **auto-detected from Telegram's `language_code`**; `/lang <code>` choices are cached in the edge Cache API per user. Still zero storage. |
| Session store (mini app) | The Telegram **Mini App dashboard** authenticates with `initData` — HMAC-SHA256(`HMAC("WebAppData", token)`, data-check-string), the exact spec algorithm. No cookies, no sessions. |
| Captcha/abuse store | Optional **Cloudflare Turnstile**: verification mints an HMAC-signed cookie (`tsg`) valid 24 h — the “captcha database” is a signature. |
| Rate-limit counters | Per-isolate sliding window (`RATE_LIMIT_RPM`) — free, and Cloudflare WAF covers the volumetric stuff. |
| File catalog | The storage channel **is** the catalog: every stored file gets a self-reply with its watch link → Telegram search is your index (`INDEX_ENABLED`). |

---

## 3 · Features

**Core** — instant stream/download links · true streaming with Range/206/HEAD/304 (video seeking works) · photos, videos, documents, audio, GIFs, voice, video notes · `Content-Disposition` inline vs attachment · edge-cached thumbnails · CORS for embedding.

**v3 ULTRA** — 📦 binary signed links (45% shorter) · 🔳 QR codes (PNG photo + SVG route + watch page) · 🌍 8 languages (en/id/zh/es/hi/ar/ru/pt) auto-detected + `/lang` · ✏️ `/rename` custom filenames baked into the signature · 📎 batch `/upload url1 url2 | name` · 🔗 `/gen` mints links from any t.me message link · 📱 Telegram **Mini App dashboard** (`/app`, initData-HMAC auth, menu button auto-registered) · 🖥️ `/e/` embeddable iframe player + oEmbed endpoint · ⚡ **token failover** (a dead token can't break a stream) · 🗂 storage-channel catalog replies.

**Security** — HMAC-SHA256 signed URLs (forged links 404) · webhook secret validation · password-gated links · TTL self-expiring links · instant revocation (`/del` or the 🗑 button) · filename sanitization (header-injection safe) · `/registerWebhook` guarded by `ADMIN_KEY` · optional **Turnstile** captcha gate · optional **force-subscribe** channel gate (`FORCE_SUB_CHANNEL`) · **hotlink protection** (`ALLOWED_REFERRERS`) · **per-IP rate limiting** (`RATE_LIMIT_RPM`) · CSP + `nosniff` + referrer-policy headers on all pages.

**Bot UX** — rich HTML link cards with QR buttons · share/get-again buttons · reply-to-file `/ttl 30m` and `/pwd secret` regeneration (stateless context via replies!) · inline mode · channel auto-linking · `/start <payload>` re-send · `/id` `/ping` `/stats` `/version` `/index` `/help` · owner-only delete button.

**Web** — dark glassmorphism landing page · `/watch/<payload>` HTML5 player (video/audio/image/PDF preview) with OG/Twitter tags, keyboard shortcuts (space/←/→/f), QR + embed code · unlock page for protected files · captcha page · styled error pages.

**Ops** — `/healthz` probe with live per-isolate stats · one-URL webhook registration · `setMyCommands` + `setChatMenuButton` auto-config · multi-token load spreading · optional custom Bot API base (`BOT_API_BASE`) → files up to **2 GB** via a self-hosted Bot API server.

---

## 4 · Deploy

### Option A — Cloudflare Dashboard (copy-paste, ~3 minutes)

1. **Create the storage channel**: make a private Telegram channel, add your bot as **admin** with *post messages* + *edit messages* rights. Get its id (starts with `-100`) by forwarding a channel message to `@userinfobot` / `@idbot`.
2. **Get your user id** the same way (for `OWNER_IDS`).
3. Cloudflare Dashboard → **Workers & Pages → Create → Create Worker** → name it → Deploy → **Edit code**.
4. Paste the entire [`worker.js`](./worker.js) → Deploy.
5. Worker → **Settings → Variables & Secrets**, add:

   | Variable | Value |
   |---|---|
   | `BOT_TOKEN` | token from [@BotFather](https://t.me/BotFather) *(or `BOT_TOKENS` = comma-separated list for multi-token)* |
   | `BOT_CHANNEL` | `-100xxxxxxxxxx` storage channel id |
   | `OWNER_IDS` | your numeric Telegram id |
   | `LINK_SECRET` | long random string (link signatures) |
   | `WEBHOOK_SECRET` | another long random string `[A-Za-z0-9_-]` |
   | `ADMIN_KEY` | another random string (guards webhook registration) |
   | *(optional)* `SIA_SECRET` | your OLD `SIA_SECRET` from filestream-cf if you're migrating — keeps legacy `?file=` links alive |
   | *(optional)* `BOT_API_BASE` | e.g. `https://my-botapi.example` — self-hosted Bot API server → unlocks files > 20 MB |
   | *(optional)* `FORCE_SUB_CHANNEL` | channel id/`@name` users must join before the bot serves them |
   | *(optional)* `FORCE_SUB_URL` | fallback invite link if the channel is private |
   | *(optional)* `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | enable the captcha gate on watch/stream |
   | *(optional)* `ALLOWED_REFERRERS` | comma list of domains allowed to embed your streams |
   | *(optional)* `RATE_LIMIT_RPM` | per-IP requests/min cap on stream/dl/watch |
   | *(optional)* `DEFAULT_LANG` | default UI language, one of `en,id,zh,es,hi,ar,ru,pt` |

6. Open **`https://your-worker.workers.dev/registerWebhook?key=ADMIN_KEY`** — done. The landing page will show ✅.

### Option B — Wrangler CLI

```bash
npm i
npx wrangler secret put BOT_TOKENS      # "token1,token2"
npx wrangler secret put LINK_SECRET
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
curl "https://telegram-file-stream-pro.<you>.workers.dev/registerWebhook?key=<ADMIN_KEY>"
```

### Custom domain

Worker → Settings → Domains & Routes → Add custom domain. Links automatically use whatever host they're opened on.

### Files larger than 20 MB

The public Bot API caps `getFile` downloads at 20 MB. Run a [Bot API server](https://github.com/tdlib/telegram-bot-api) anywhere (one docker container), set `BOT_API_BASE` to it, and the same Worker streams up to 2 GB with no other changes.

---

## 5 · Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `BOT_TOKEN` / `BOT_TOKENS` | ✅ | — | Bot token(s); comma-separated list enables round-robin downloads |
| `BOT_CHANNEL` | ✅ | — | Storage channel id (`-100…`), bot must be admin with post+edit rights |
| `LINK_SECRET` | ✅ | `SIA_SECRET` fallback | HMAC secret for link signatures |
| `WEBHOOK_SECRET` | ✅ | — | Telegram webhook validation token |
| `ADMIN_KEY` | ✅* | — | Guards `/registerWebhook` / `/unregisterWebhook` (*required to register) |
| `OWNER_IDS` | recommended | — | Comma-separated owner user ids |
| `PUBLIC_BOT` | — | `false` | `true` = anyone may generate links (no rate-limit DB, be careful) |
| `WEBHOOK_PATH` | — | `/webhook` | Webhook endpoint path |
| `BOT_API_BASE` | — | `https://api.telegram.org` | Custom Bot API server (removes 20 MB cap) |
| `AUTO_CHANNEL_LINK` | — | `true` | Auto reply with links when files are posted in channels |
| `ENABLE_INLINE` | — | `true` | Inline query mode |
| `ENABLE_LEGACY` | — | `true` | Accept old filestream-cf `?file=<hash>` links |
| `LEGACY_SECRET` | — | `SIA_SECRET`/`LINK_SECRET` | Secret for decoding legacy hashes |
| `MAX_REMOTE_MB` | — | `50` | Cap for `/upload <url>` |
| `BOT_NAME` | — | `TG FileStream PRO` | Branding |
| `BOT_USERNAME` | — | *(auto via getMe)* | Skip the getMe call on landing page |
| `DEFAULT_LANG` | — | `en` | Fallback language (`en,id,zh,es,hi,ar,ru,pt`) |
| `FORCE_SUB_CHANNEL` | — | off | Channel users must join before the bot mints links |
| `FORCE_SUB_URL` | — | *(auto getChat)* | Invite link for private force-sub channels |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | — | off | Turnstile captcha on watch/stream (24 h signed cookie) |
| `ALLOWED_REFERRERS` | — | off | Hotlink protection: comma list of allowed embedder domains |
| `RATE_LIMIT_RPM` | — | off | Per-IP requests/minute on stream/dl/watch |
| `INDEX_ENABLED` | — | `true` | Catalog self-replies in the storage channel |
| `ENABLE_QR` | — | `true` | QR codes (`/qr`, QR button, watch page) |
| `ENABLE_MINI_APP` | — | `true` | `/app` dashboard + menu button registration |

## 6 · Bot commands

| Command | Description |
|---|---|
| *(send / forward a file)* | Instant link card: stream · download · watch · share · QR |
| `/ttl <30m\|12h\|7d>` — **reply to a file** | Regenerate the link with a self-expiry |
| `/pwd <secret>` — **reply to a file** | Regenerate password-protected |
| `/rename <name.mp4>` — **reply to a link card** | Fresh signed link with a custom display name |
| `/qr` — **reply to a link card** (or `/qr <payload>`) | Sends the QR code as a PNG photo |
| `/upload <url> [url2 …] \| custom-name.mp4` | Fetch from the web and host it (batch ≤ 5) |
| `/gen <t.me/c/…/… link>` — or reply to media | Mint links from any message the bot can read |
| `/lang <code>` | Switch language: `en id zh es hi ar ru pt` |
| `/del <payload>` | Revoke all links (owner; or the 🗑 button) |
| `/start <payload>` | Re-send a file into the chat |
| `/index` | Info about the zero-DB catalog (the channel itself) |
| `/id` · `/ping` · `/stats` · `/version` · `/help` | Utilities |
| `@yourbot <payload>` (inline) | Resend the file in any chat |

## 7 · HTTP API

| Endpoint | Description |
|---|---|
| `GET/HEAD /stream/{payload}` | Inline stream · Range/206/304 · correct MIME + filename (`/s/` alias, `?dl=1` forces download) |
| `GET/HEAD /dl/{payload}` | Forced download |
| `GET /watch/{payload}` | Player page (OG tags, keyboard shortcuts, QR, embed code) — `/w/` alias |
| `GET /e/{payload}` | Minimal iframe embed player (`frame-ancestors: *`) |
| `GET /qr/{payload}` | QR code SVG (edge-cached 1 h) |
| `GET /thumb/{payload}` | Edge-cached thumbnail |
| `GET /api/info/{payload}` | JSON metadata (incl. embed + qr urls, `renamed` flag) |
| `GET /api/oembed?url=…` | oEmbed JSON for a watch/stream URL |
| `GET /app` | Telegram Mini App dashboard |
| `POST /api/app/generate` | Mini App backend (`init_data` + `link`/`url`) |
| `POST /gate` | Turnstile verification → signed cookie |
| `GET /healthz` | Health probe + live stats + feature flags |
| `GET /registerWebhook?key=` | Register webhook + commands + menu button |

Payloads come in two flavors, both HMAC-SHA256 signed and tamper-proof:
- **v2**: `b64url(JSON).b64url(HMAC[0:16])`
- **v3 binary** (default for new links): one b64url blob packing version, flags, zigzag channel id, varint message id, optional expiry/password-proof/name + 16-byte signature — **45% shorter**.

## 8 · Upgrades over the original (filestream-cf)

| | Original | PRO |
|---|---|---|
| Streaming | `arrayBuffer()` — whole file in memory | True pipe-through, Range/206/HEAD |
| Metadata trick | `editMessageCaption` + random UUID — **destroys captions every request** | Non-destructive `editMessageReplyMarkup` probe + 30-min edge cache |
| Link crypto | Custom XOR + salt (forgeable-ish, `atob` errors) | HMAC-SHA256 (WebCrypto) |
| Config | Hardcoded in source | `env` vars + secrets, missing-var banner |
| `getMe()` | Called on **every message** | Cached per isolate / via `BOT_USERNAME` |
| File types | doc/audio/video/photo | + GIFs, video notes, voice, PDF preview |
| Bot API | api.telegram.org only | Custom `BOT_API_BASE` (2 GB) |
| Web | None (generator page) | Landing + watch player + error pages + API |
| Multi-token, TTL, password, revocation, upload-by-URL, channel auto-link, i18n-ready HTML parse mode | ❌ | ✅ |
| **v3: binary links, QR encoder+PNG, 8 languages, mini app, embed/oEmbed, Turnstile, force-sub, hotlink guard, rate limit, token failover, /rename, /gen, batch upload** | ❌ | ✅ |
| Old links | — | Still work (`?file=` → auto-upgraded redirect) |

## 9 · Development & tests

Zero-dependency offline test suite that mocks the Telegram Bot API, file downloads and the Cache API — it exercises upload → card → stream → Range → HEAD → 304 → TTL → password → binary payloads → QR encoder/PNG → i18n → force-sub → hotlink → rate-limit → token failover → /rename → /gen → mini-app initData → upload-by-URL (batch) → inline → revocation → legacy links:

```bash
node test/worker.test.mjs   # ✅ 54 tests
npm run dev                 # wrangler dev
```

## 10 · Credits & license

- Original concept & Workers port: [`Vauth/filestream-cf`](https://github.com/Vauth/filestream-cf) (MIT) and its fork `ryoaonetsuki/telegram-file-stream`.
- Feature inspiration: [`EverythingSuckz/TG-FileStreamBot`](https://github.com/EverythingSuckz/TG-FileStreamBot) (Go, AGPL), [`TheCaduceus/FileStreamBot`](https://github.com/TheCaduceus/FileStreamBot) and friends.
- This repo: MIT. Don't use it to host anything illegal — you're still bound by Telegram's ToS.
