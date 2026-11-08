/**
 * ============================================================================
 *  TG FILE STREAM  —  PRO EDITION  v3.0 "ULTRA"
 * ============================================================================
 *  A zero-database, edge-native Telegram file-to-link bot + streaming server
 *  for Cloudflare Workers. Single-file, dependency-free, paste-and-deploy.
 *
 *  Upgraded from `Vauth/filestream-cf` (and its fork
 *  `ryoaonetsuki/telegram-file-stream`), with features ported from the best
 *  projects across the ecosystem:
 *    • EverythingSuckz/TG-FileStreamBot (Go)   — multi-token round-robin, clean URLs
 *    • TheCaduceus/FileStreamBot (Python)      — TTL, password links, revocation ideas
 *    • ShivamNox/FileStreamBot-Pro (Python)    — rich bot UX, share buttons
 *    • Vauth/filestream-cf (JS)                — inline mode, channel-as-storage, /?file=
 *
 *  NO DATABASE. The clever tricks that replace one:
 *    1. The Telegram log channel IS the storage (files live there, for free).
 *    2. Links are self-describing & HMAC-SHA256 signed — nothing to look up.
 *    3. File metadata is resolved via a non-destructive editMessageReplyMarkup
 *       probe and edge-cached (Cache API) — no caption destruction, ever.
 *    4. TTL / expiry lives inside the signed payload — links kill themselves.
 *    5. Password links store only an HMAC proof of the password — never the
 *       password itself. Proof-of-knowledge, zero storage.
 *    6. Revocation = delete the channel message (/del) — every link dies.
 *    7. v3 links pack the same data into a ~45% shorter BINARY signed payload
 *       (varint + zigzag encoding) — small enough for QR codes.
 *    8. QR codes are generated in pure JS: a Model-2 encoder + a raw PNG
 *       writer with stored deflate blocks — zero libraries.
 *    9. The Mini App dashboard authenticates via Telegram initData HMAC —
 *       no session store, no cookies, no database.
 *   10. The storage channel doubles as a searchable catalog: every stored
 *       file gets a self-reply carrying its links (INDEX_ENABLED).
 *
 *  Deploy: see README.md. Secrets go in Worker Settings → Variables.
 *  License: MIT
 * ============================================================================
 */

/* ============================== CONFIG ==================================== */

const VERSION = "3.0.0";
const IS_BG = { /** deterministic bg gradient for pages */ };

function buildConfig(env = {}) {
  const tokens = String(env.BOT_TOKENS || env.BOT_TOKEN || "")
    .split(",").map((t) => t.trim()).filter(Boolean);

  const bool = (v, dflt) =>
    v === undefined || v === null || v === "" ? dflt : /^(1|true|yes|on)$/i.test(String(v));

  const cfg = {
    tokens,
    channel: parseInt(env.BOT_CHANNEL, 10) || 0,
    ownerIds: String(env.OWNER_IDS || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite),
    publicBot: bool(env.PUBLIC_BOT, false),
    linkSecret: env.LINK_SECRET || env.SIA_SECRET || "",
    legacySecret: env.LEGACY_SECRET || env.SIA_SECRET || env.LINK_SECRET || "",
    webhookSecret: env.WEBHOOK_SECRET || "",
    webhookPath: env.WEBHOOK_PATH || "/webhook",
    botApiBase: String(env.BOT_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
    autoChannelLink: bool(env.AUTO_CHANNEL_LINK, true),
    enableInline: bool(env.ENABLE_INLINE, true),
    enableLegacy: bool(env.ENABLE_LEGACY, true),
    maxRemoteMb: Number(env.MAX_REMOTE_MB || 50),
    brand: env.BOT_NAME || "TG FileStream PRO",
    adminKey: env.ADMIN_KEY || "",
    botUsername: env.BOT_USERNAME || "",
    sourceUrl: "https://github.com/ryoaonetsuki/telegram-file-stream",

    /* ---- v3 ULTRA ---- */
    langDefault: env.DEFAULT_LANG || "en",
    forceSub: (env.FORCE_SUB_CHANNEL || "").trim(),
    forceSubUrl: (env.FORCE_SUB_URL || "").trim(),
    tsSite: env.TURNSTILE_SITE_KEY || "",
    tsSecret: env.TURNSTILE_SECRET_KEY || "",
    allowedReferrers: String(env.ALLOWED_REFERRERS || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    rateRpm: Number(env.RATE_LIMIT_RPM || 0),
    indexEnabled: bool(env.INDEX_ENABLED, true),
    qrEnabled: bool(env.ENABLE_QR, true),
    appEnabled: bool(env.ENABLE_MINI_APP, true),
  };

  const missing = [];
  if (!cfg.tokens.length) missing.push("BOT_TOKEN (or BOT_TOKENS)");
  if (!cfg.channel) missing.push("BOT_CHANNEL");
  if (!cfg.linkSecret) missing.push("LINK_SECRET");
  if (!cfg.webhookSecret) missing.push("WEBHOOK_SECRET");
  cfg.missing = missing;
  cfg.ok = missing.length === 0;

  cfg.owners = (id) => cfg.ownerIds.includes(Number(id));
  cfg.canUse = (userId) => cfg.publicBot || cfg.owners(userId);
  return cfg;
}

/* ============================== UTILS ===================================== */

const TE = new TextEncoder();
const TD = new TextDecoder();

/** HTML-escape a string for safe use in Telegram HTML parse-mode / pages. */
function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Human readable bytes. */
function fmtBytes(n) {
  if (n === undefined || n === null || isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

/** Parse "30m", "12h", "7d" (or plain seconds) into seconds. 0 = invalid. */
function parseTtl(str = "") {
  const m = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(str.trim());
  if (!m) return 0;
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] || "s").toLowerCase()];
  return parseInt(m[1], 10) * mult;
}

/** Kind metadata: icon + label. k: d doc, v video, a audio, p photo, g gif, n videonote, o voice */
const KINDS = {
  d: { icon: "📁", label: "Document",  send: "document" },
  v: { icon: "🎬", label: "Video",     send: "document" },
  a: { icon: "🎵", label: "Audio",     send: "document" },
  p: { icon: "🖼️", label: "Photo",     send: "photo"    },
  g: { icon: "🎞️", label: "Animation", send: "document" },
  n: { icon: "📹", label: "Video note",send: "document" },
  o: { icon: "🎙️", label: "Voice",     send: "document" },
};

/** Basic extension → mime fallback map (when channel metadata lacks mime). */
const EXT_MIME = {
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4",
  wav: "audio/wav", flac: "audio/flac", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", pdf: "application/pdf", zip: "application/zip",
  rar: "application/vnd.rar", "7z": "application/x-7z-compressed", txt: "text/plain",
  apk: "application/vnd.android.package-archive", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function extOf(name = "") {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Guess mime from name, falling back to a sensible default per kind. */
function guessMime(name, kind, fallback = "") {
  const ext = extOf(name);
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (fallback) return fallback;
  return kind === "p" ? "image/jpeg" : "application/octet-stream";
}

/**
 * RFC 6266 / RFC 5987 safe Content-Disposition.
 * Prevents header injection via crafted filenames (an upgrade over the
 * original, which interpolated raw names into the header).
 */
function contentDisposition(type, name = "file") {
  const clean = String(name).replace(/[\r\n"\\]/g, "_").replace(/[\u0000-\u001f]/g, "");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `${type}; filename="${ascii || "file"}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/* ============================ B64URL + HMAC =============================== */

function b64uEnc(input) {
  const bytes = typeof input === "string" ? TE.encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDec(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hmacKeys = new Map();
async function hmacKey(secret) {
  if (!hmacKeys.has(secret)) {
    hmacKeys.set(secret, crypto.subtle.importKey(
      "raw", TE.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    ));
  }
  return hmacKeys.get(secret);
}

async function hmacBytes(secret, msg) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, TE.encode(msg)));
}

/** HMAC over raw bytes (used by the v3 binary payload format). */
async function hmacRaw(secret, bytes) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
}

/** Constant-time-ish comparison of two byte arrays. */
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ============================ SIGNED PAYLOADS ============================= */
/**
 * A link payload is:  b64url(JSON) + "." + b64url(sig[0..16])
 *   { c: channelId, m: messageId, k: kind,
 *     e: expiryEpoch?,          → self-expiring links (TTL)
 *     q: passwordHmacPrefix?    → password-protected links }
 * Nothing else is needed to serve the file forever — no database.
 */

async function signPayload(cfg, data) {
  const json = JSON.stringify(data);
  const sig = await hmacBytes(cfg.linkSecret, json);
  return `${b64uEnc(json)}.${b64uEnc(sig.slice(0, 16))}`;
}

/**
 * Verify + parse a payload string. Returns { data, raw } or null.
 * Tries the v2 JSON format first, then the v3 binary frame.
 * Enforces HMAC integrity and TTL expiry (expiry checked separately).
 */
async function verifyPayload(cfg, payload) {
  try {
    if (!payload || typeof payload !== "string") return null;
    if (payload.includes(".")) {
      const [body, sig] = payload.split(".");
      const jsonBytes = b64uDec(body);
      const json = TD.decode(jsonBytes);
      const expect = (await hmacBytes(cfg.linkSecret, json)).slice(0, 16);
      if (!bytesEqual(expect, b64uDec(sig))) return null;
      const data = JSON.parse(json);
      if (!Number.isFinite(data.c) || !Number.isFinite(data.m) || !KINDS[data.k]) return null;
      return { data, raw: payload };
    }
    return await decodeBinaryPayload(cfg, payload);
  } catch {
    return null;
  }
}

/** Password proof-of-knowledge: we store HMAC(secret,"pwd:"+pw) — never the pw. */
async function passwordProof(cfg, pw) {
  const sig = await hmacBytes(cfg.linkSecret, "pwd:" + pw);
  return b64uEnc(sig.slice(0, 8));
}

function requestPasswordKey(request) {
  const url = new URL(request.url);
  return url.searchParams.get("key") || url.searchParams.get("password") || "";
}

/* ====================== BINARY PAYLOADS (v3 — 45% shorter) ==================
 * v3 links pack the exact same data as the v2 JSON payloads into a compact
 * binary frame before signing. Layout (all integers little-endian varints):
 *
 *   byte 0      : 0x03 (format version)
 *   byte 1      : flags — bits 0-2 kind (d0 v1 a2 p3 g4 n5 o6),
 *                 bit 3 has-expiry, bit 4 has-password, bit 5 has-name
 *   varint      : zigzag(channelId)
 *   varint      : messageId
 *   uint32 BE   : expiry epoch            (if bit 3)
 *   8 bytes     : password HMAC proof    (if bit 4)
 *   varint+utf8 : display name override  (if bit 5)
 *   16 bytes    : HMAC-SHA256(prefix)[0..16]
 *
 * The whole frame is b64url — a typical link is ~44 chars vs ~72 for JSON.
 * v2 JSON payloads stay valid forever (one-way upgrade, no migration).
 */

const KIND_CODE = { d: 0, v: 1, a: 2, p: 3, g: 4, n: 5, o: 6 };
const CODE_KIND = Object.fromEntries(Object.entries(KIND_CODE).map(([k, v]) => [v, k]));

function writeVarint(bytes, n) {
  // 53-bit safe (Telegram channel ids reach ~±1.1e12 — >>> 0 would corrupt them)
  n = Math.floor(Number(n));
  if (n < 0) throw new Error("varint requires an unsigned value");
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    bytes.push(byte);
  } while (n > 0);
}

function readVarint(bytes, pos) {
  let result = 0, shift = 0, i = pos;
  for (;;) {
    if (i >= bytes.length) throw new Error("varint overrun");
    const b = bytes[i++];
    result += (b & 127) * Math.pow(2, shift);
    if (!(b & 128)) break;
    shift += 7;
    if (shift > 42) throw new Error("varint overflow");
  }
  return [result, i];
}

const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/** Mint a compact v3 binary payload. Same fields as signPayload() + name. */
async function mintPayload(cfg, data) {
  const bytes = [3];
  let flags = KIND_CODE[data.k] || 0;
  if (data.e) flags |= 8;
  if (data.q) flags |= 16;
  if (data.name) flags |= 32;
  bytes.push(flags);
  writeVarint(bytes, zigzag(data.c));
  writeVarint(bytes, data.m);
  if (data.e) {
    const e = Number(data.e);
    bytes.push(Math.floor(e / 16777216) & 255, Math.floor(e / 65536) & 255, Math.floor(e / 256) & 255, e & 255);
  }
  if (data.q) for (const b of b64uDec(data.q)) bytes.push(b);
  if (data.name) {
    const nb = TE.encode(String(data.name).slice(0, 120));
    writeVarint(bytes, nb.length);
    for (const b of nb) bytes.push(b);
  }
  const prefix = new Uint8Array(bytes);
  const sig = await hmacRaw(cfg.linkSecret, prefix);
  const all = new Uint8Array(prefix.length + 16);
  all.set(prefix, 0);
  all.set(sig.slice(0, 16), prefix.length);
  return b64uEnc(all);
}

/** Verify + decode a v3 binary payload. Returns { data, raw } or null. */
async function decodeBinaryPayload(cfg, str) {
  const bytes = b64uDec(str);
  if (bytes.length < 20 || bytes[0] !== 3) return null;
  const prefix = bytes.subarray(0, bytes.length - 16);
  const sig = bytes.subarray(bytes.length - 16);
  const expect = (await hmacRaw(cfg.linkSecret, prefix)).slice(0, 16);
  if (!bytesEqual(expect, sig)) return null;
  try {
    let p = 1;
    const flags = bytes[p++];
    const k = CODE_KIND[flags & 7];
    if (!k) return null;
    const [zc, p1] = readVarint(bytes, p);
    const [m, p2] = readVarint(bytes, p1);
    const data = { c: unzigzag(zc), m, k };
    p = p2;
    const end = bytes.length - 16;
    if (flags & 8) {
      if (p + 4 > end) return null;
      data.e = bytes[p] * 16777216 + bytes[p + 1] * 65536 + bytes[p + 2] * 256 + bytes[p + 3];
      p += 4;
    }
    if (flags & 16) {
      if (p + 8 > end) return null;
      data.q = b64uEnc(bytes.subarray(p, p + 8));
      p += 8;
    }
    if (flags & 32) {
      const [len, p3] = readVarint(bytes, p);
      p = p3;
      if (p + len > end) return null;
      data.name = TD.decode(bytes.subarray(p, p + len));
      p += len;
    }
    return { data, raw: str };
  } catch {
    return null;
  }
}

/* ============================== I18N ====================================== */
/**
 * 8 languages out of the box. Detection is free: Telegram tells us the
 * user's language_code on every update. A manual /lang choice is stored in
 * the edge Cache API (per user) — still zero database, still one file.
 */

const LANGS = ["en", "id", "zh", "es", "hi", "ar", "ru", "pt"];
const LANG_NAMES = { en: "English", id: "Indonesia", zh: "中文", es: "Español", hi: "हिन्दी", ar: "العربية", ru: "Русский", pt: "Português" };

const I18N = {
  en: {
    w_title: `👋 <b>Welcome to {bot}!</b>`,
    w_body: `Send me <b>any file</b> — video, audio, docs, photos — and I'll turn it into instant <b>streaming &amp; download links</b>.\n\n⚡ Instant stream + download links\n🎬 HTML5 watch page with seeking\n⏳ Self-expiring links (<code>/ttl 30m</code>)\n🙊 Password-protected links (<code>/pwd</code>)\n✏️ Rename links (<code>/rename</code>)\n📎 Upload straight from a URL (<code>/upload</code>)\n🔗 Mint links from any message (<code>/gen</code>)\n🔳 QR codes for every link (<code>/qr</code>)\n♻️ Revocable — delete = all links die\n🌍 8 languages (<code>/lang</code>)\n🧬 Zero database, 100% edge`,
    card_ready: `🔗 <b>Link ready!</b>`,
    card_name: `📄 <b>Name:</b>`,
    card_size: `📦 <b>Size:</b>`,
    card_exp: `⏳ <b>Expires:</b>`,
    card_pwd: `🙊 <b>Password:</b> share as <code>{url}?key=YOUR_PASSWORD</code>`,
    card_tip: `<i>Reply to the original file with <code>/ttl 30m</code>, <code>/pwd secret</code> or <code>/rename new-name.mp4</code>.</i>`,
    forbidden: `🚫 <b>Access restricted.</b> This bot is private — deploy your own instance from the source link below.`,
    no_file: `🤷 That message has no supported file. Send me a <b>video, document, audio, photo, GIF, voice or video note</b>.`,
    help: `📖 <b>Commands</b>\n\n📤 <i>Just send / forward any file</i> → instant links\n/ttl &lt;time&gt; — reply to a file: <code>30m</code>, <code>12h</code>, <code>7d</code>\n/pwd &lt;secret&gt; — reply to a file: password-protect it\n/rename &lt;name&gt; — reply to a link card: rename the file\n/qr — reply to a link card: get a QR code image\n/upload &lt;url&gt;… — fetch files from the web (≤ {max} MB each)\n/gen &lt;t.me link&gt; — mint links from any message the bot can read\n/lang &lt;code&gt; — switch language ({langs})\n/del &lt;payload&gt; — revoke all links (owner)\n/id — show chat / user ids\n/ping — latency check\n/stats — service diagnostics (owner)\n\n🔎 <b>Inline:</b> type <code>@{bot} &lt;payload&gt;</code> in any chat to resend a file.`,
    upload_usage: `📎 Usage: <code>/upload &lt;url&gt; [url2 …] | custom-name.mp4</code>\nMax size per file: {max} MB.`,
    upload_fetch: `⏳ Fetching <code>{url}</code> …`,
    upload_fail: `❌ <b>Upload failed:</b> {err}`,
    ttl_usage: `⏳ Usage: reply to a file with <code>/ttl 30m</code> (or 12h / 7d / 90s).`,
    pwd_usage: `🙊 Usage: reply to a file with <code>/pwd my-secret</code>.`,
    del_usage: `🗑 Usage: <code>/del &lt;payload&gt;</code> (the <code>#payload</code> from a link card).`,
    del_done: `🗑 <b>Revoked.</b> Every stream / download / watch link for this payload is now dead.`,
    rename_usage: `✏️ Usage: reply to a link card with <code>/rename new-name.mp4</code>.`,
    rename_done: `✏️ <b>Renamed to</b> <code>{name}</code> — fresh links below.`,
    lang_set: `🌍 Language set to <b>{lang}</b>.`,
    lang_list: `🌍 Available languages: {langs}\nUsage: <code>/lang &lt;code&gt;</code>`,
    gen_usage: `🔗 Usage: <code>/gen https://t.me/c/1234567/89</code> — or reply to a media message with <code>/gen</code>.`,
    gen_fail: `❌ Couldn't copy that message — make sure the bot can read that chat and that it contains a file.\n<code>{err}</code>`,
    unknown: `🤔 Unknown command. Send /help — or just send me a file!`,
    join_first: `🔒 <b>Subscribe required.</b> Join the channel first, then try again.`,
    join_btn: `📢 Join channel`,
  },
  id: {
    w_title: `👋 <b>Selamat datang di {bot}!</b>`,
    w_body: `Kirimkan <b>file apa pun</b> — video, audio, dokumen, foto — dan saya ubah menjadi <b>tautan streaming &amp; unduhan</b> instan.\n\n⚡ Tautan stream + unduh instan\n🎬 Halaman tonton HTML5 dengan seek\n⏳ Tautan kedaluwarsa otomatis (<code>/ttl 30m</code>)\n🙊 Tautan terproteksi sandi (<code>/pwd</code>)\n✏️ Ubah nama tautan (<code>/rename</code>)\n📎 Unggah langsung dari URL (<code>/upload</code>)\n🔗 Buat tautan dari pesan mana pun (<code>/gen</code>)\n🔳 Kode QR untuk setiap tautan (<code>/qr</code>)\n♻️ Dapat dicabut — hapus = semua tautan mati\n🌍 8 bahasa (<code>/lang</code>)\n🧬 Tanpa database, 100% edge`,
    card_ready: `🔗 <b>Tautan siap!</b>`,
    card_name: `📄 <b>Nama:</b>`,
    card_size: `📦 <b>Ukuran:</b>`,
    card_exp: `⏳ <b>Kedaluwarsa:</b>`,
    card_pwd: `🙊 <b>Sandi:</b> bagikan sebagai <code>{url}?key=SANDI_ANDA</code>`,
    card_tip: `<i>Balas file asli dengan <code>/ttl 30m</code>, <code>/pwd rahasia</code>, atau <code>/rename nama-baru.mp4</code>.</i>`,
    forbidden: `🚫 <b>Akses dibatasi.</b> Bot ini privat — deploy instansi Anda sendiri dari tautan sumber di bawah.`,
    no_file: `🤷 Pesan itu tidak berisi file yang didukung. Kirim <b>video, dokumen, audio, foto, GIF, suara, atau video note</b>.`,
    help: `📖 <b>Perintah</b>\n\n📤 <i>Kirim / teruskan file apa pun</i> → tautan instan\n/ttl &lt;waktu&gt; — balas file: <code>30m</code>, <code>12h</code>, <code>7d</code>\n/pwd &lt;sandi&gt; — balas file: proteksi sandi\n/rename &lt;nama&gt; — balas kartu tautan: ubah nama\n/qr — balas kartu tautan: kirim kode QR\n/upload &lt;url&gt;… — ambil file dari web (≤ {max} MB)\n/gen &lt;tautan t.me&gt; — buat tautan dari pesan mana pun\n/lang &lt;kode&gt; — ganti bahasa ({langs})\n/del &lt;payload&gt; — cabut semua tautan (owner)\n/id — ID chat / pengguna\n/ping — cek latensi\n/stats — diagnostik (owner)\n\n🔎 <b>Inline:</b> ketik <code>@{bot} &lt;payload&gt;</code> di chat mana pun.`,
    upload_usage: `📎 Cara pakai: <code>/upload &lt;url&gt; [url2 …] | nama-custom.mp4</code>\nMaks per file: {max} MB.`,
    upload_fetch: `⏳ Mengambil <code>{url}</code> …`,
    upload_fail: `❌ <b>Gagal unggah:</b> {err}`,
    ttl_usage: `⏳ Cara pakai: balas file dengan <code>/ttl 30m</code> (atau 12h / 7d / 90s).`,
    pwd_usage: `🙊 Cara pakai: balas file dengan <code>/pwd rahasia</code>.`,
    del_usage: `🗑 Cara pakai: <code>/del &lt;payload&gt;</code> (kode <code>#payload</code> dari kartu tautan).`,
    del_done: `🗑 <b>Dicabut.</b> Semua tautan stream / unduh / tonton untuk payload ini kini mati.`,
    rename_usage: `✏️ Cara pakai: balas kartu tautan dengan <code>/rename nama-baru.mp4</code>.`,
    rename_done: `✏️ <b>Diubah menjadi</b> <code>{name}</code> — tautan baru di bawah.`,
    lang_set: `🌍 Bahasa diatur ke <b>{lang}</b>.`,
    lang_list: `🌍 Bahasa tersedia: {langs}\nCara pakai: <code>/lang &lt;kode&gt;</code>`,
    gen_usage: `🔗 Cara pakai: <code>/gen https://t.me/c/1234567/89</code> — atau balas pesan media dengan <code>/gen</code>.`,
    gen_fail: `❌ Tidak bisa menyalin pesan itu — pastikan bot dapat membaca chat itu dan pesannya berisi file.\n<code>{err}</code>`,
    unknown: `🤔 Perintah tidak dikenal. Kirim /help — atau kirim file saja!`,
    join_first: `🔒 <b>Wajib berlangganan.</b> Bergabung dengan channel dulu, lalu coba lagi.`,
    join_btn: `📢 Gabung channel`,
  },
  zh: {
    w_title: `👋 <b>欢迎使用 {bot}！</b>`,
    w_body: `给我发送<b>任何文件</b>（视频、音频、文档、图片），我会立刻生成<b>在线播放和下载链接</b>。\n\n⚡ 秒发播放 / 下载链接\n🎬 HTML5 观看页，支持拖动进度\n⏳ 自动过期链接（<code>/ttl 30m</code>）\n🙊 密码保护链接（<code>/pwd</code>）\n✏️ 链接重命名（<code>/rename</code>）\n📎 直接从 URL 上传（<code>/upload</code>）\n🔗 从任意消息生成链接（<code>/gen</code>）\n🔳 每个链接都能生成二维码（<code>/qr</code>）\n♻️ 可吊销——删除即全部失效\n🌍 支持 8 种语言（<code>/lang</code>）\n🧬 零数据库，纯边缘运行`,
    card_ready: `🔗 <b>链接已生成！</b>`,
    card_name: `📄 <b>文件名：</b>`,
    card_size: `📦 <b>大小：</b>`,
    card_exp: `⏳ <b>过期时间：</b>`,
    card_pwd: `🙊 <b>密码：</b>分享时使用 <code>{url}?key=你的密码</code>`,
    card_tip: `<i>回复原文件可使用 <code>/ttl 30m</code>、<code>/pwd 密码</code> 或 <code>/rename 新名字.mp4</code>。</i>`,
    forbidden: `🚫 <b>访问受限。</b>本机器人仅限私有使用——请从下方源码链接部署你自己的实例。`,
    no_file: `🤷 该消息没有可识别的文件。请发送<b>视频、文档、音频、图片、GIF、语音或视频圆</b>。`,
    help: `📖 <b>命令列表</b>\n\n📤 <i>直接发送 / 转发任意文件</i> → 秒得链接\n/ttl &lt;时间&gt; — 回复文件：<code>30m</code>、<code>12h</code>、<code>7d</code>\n/pwd &lt;密码&gt; — 回复文件：密码保护\n/rename &lt;名称&gt; — 回复链接卡片：重命名\n/qr — 回复链接卡片：发送二维码\n/upload &lt;url&gt;… — 从网页抓取文件（≤ {max} MB）\n/gen &lt;t.me 链接&gt; — 从任意消息生成链接\n/lang &lt;代码&gt; — 切换语言（{langs}）\n/del &lt;payload&gt; — 吊销全部链接（管理员）\n/id — 查看 ID\n/ping — 延迟测试\n/stats — 服务诊断（管理员）\n\n🔎 <b>内联模式：</b>在任意聊天输入 <code>@{bot} &lt;payload&gt;</code> 重发文件。`,
    upload_usage: `📎 用法：<code>/upload &lt;url&gt; [url2 …] | 自定义名.mp4</code>\n单个文件上限：{max} MB。`,
    upload_fetch: `⏳ 正在获取 <code>{url}</code> …`,
    upload_fail: `❌ <b>上传失败：</b>{err}`,
    ttl_usage: `⏳ 用法：回复文件并输入 <code>/ttl 30m</code>（或 12h / 7d / 90s）。`,
    pwd_usage: `🙊 用法：回复文件并输入 <code>/pwd 密码</code>。`,
    del_usage: `🗑 用法：<code>/del &lt;payload&gt;</code>（链接卡片中的 <code>#payload</code>）。`,
    del_done: `🗑 <b>已吊销。</b>该 payload 的所有播放 / 下载 / 观看链接均已失效。`,
    rename_usage: `✏️ 用法：回复链接卡片并输入 <code>/rename 新名字.mp4</code>。`,
    rename_done: `✏️ <b>已重命名为</b> <code>{name}</code>——新链接如下。`,
    lang_set: `🌍 语言已设置为 <b>{lang}</b>。`,
    lang_list: `🌍 可用语言：{langs}\n用法：<code>/lang &lt;代码&gt;</code>`,
    gen_usage: `🔗 用法：<code>/gen https://t.me/c/1234567/89</code>——或回复媒体消息并输入 <code>/gen</code>。`,
    gen_fail: `❌ 无法复制该消息——请确保机器人能读取该对话，且消息中包含文件。\n<code>{err}</code>`,
    unknown: `🤔 未知命令。发送 /help——或直接给我发文件！`,
    join_first: `🔒 <b>需要先订阅。</b>请先加入频道，然后再试一次。`,
    join_btn: `📢 加入频道`,
  },
  es: {
    w_title: `👋 <b>¡Bienvenido a {bot}!</b>`,
    w_body: `Envíame <b>cualquier archivo</b> —video, audio, documentos, fotos— y lo convertiré al instante en <b>enlaces de streaming y descarga</b>.\n\n⚡ Enlaces de stream + descarga al instante\n🎬 Página de visionado HTML5 con buscador\n⏳ Enlaces que caducan solos (<code>/ttl 30m</code>)\n🙊 Enlaces con contraseña (<code>/pwd</code>)\n✏️ Renombrar enlaces (<code>/rename</code>)\n📎 Subir desde una URL (<code>/upload</code>)\n🔗 Crear enlaces desde cualquier mensaje (<code>/gen</code>)\n🔳 Códigos QR para cada enlace (<code>/qr</code>)\n♻️ Revocables — borrar = todos los enlaces mueren\n🌍 8 idiomas (<code>/lang</code>)\n🧬 Sin base de datos, 100% edge`,
    card_ready: `🔗 <b>¡Enlace listo!</b>`,
    card_name: `📄 <b>Nombre:</b>`,
    card_size: `📦 <b>Tamaño:</b>`,
    card_exp: `⏳ <b>Caduca:</b>`,
    card_pwd: `🙊 <b>Contraseña:</b> comparte como <code>{url}?key=TU_CLAVE</code>`,
    card_tip: `<i>Responde al archivo original con <code>/ttl 30m</code>, <code>/pwd clave</code> o <code>/rename nuevo.mp4</code>.</i>`,
    forbidden: `🚫 <b>Acceso restringido.</b> Este bot es privado — despliega tu propia instancia desde el enlace fuente.`,
    no_file: `🤷 Ese mensaje no tiene un archivo compatible. Envíame un <b>video, documento, audio, foto, GIF, voz o nota de video</b>.`,
    help: `📖 <b>Comandos</b>\n\n📤 <i>Envía o reenvía cualquier archivo</i> → enlaces al instante\n/ttl &lt;tiempo&gt; — responde a un archivo: <code>30m</code>, <code>12h</code>, <code>7d</code>\n/pwd &lt;clave&gt; — responde a un archivo: protege con contraseña\n/rename &lt;nombre&gt; — responde a una tarjeta: renombra el archivo\n/qr — responde a una tarjeta: recibe el código QR\n/upload &lt;url&gt;… — trae archivos de la web (≤ {max} MB)\n/gen &lt;enlace t.me&gt; — crea enlaces desde cualquier mensaje\n/lang &lt;código&gt; — cambia el idioma ({langs})\n/del &lt;payload&gt; — revoca todos los enlaces (owner)\n/id — muestra IDs\n/ping — prueba de latencia\n/stats — diagnóstico (owner)\n\n🔎 <b>Inline:</b> escribe <code>@{bot} &lt;payload&gt;</code> en cualquier chat.`,
    upload_usage: `📎 Uso: <code>/upload &lt;url&gt; [url2 …] | nombre.mp4</code>\nMáximo por archivo: {max} MB.`,
    upload_fetch: `⏳ Descargando <code>{url}</code> …`,
    upload_fail: `❌ <b>Error al subir:</b> {err}`,
    ttl_usage: `⏳ Uso: responde a un archivo con <code>/ttl 30m</code> (o 12h / 7d / 90s).`,
    pwd_usage: `🙊 Uso: responde a un archivo con <code>/pwd mi-clave</code>.`,
    del_usage: `🗑 Uso: <code>/del &lt;payload&gt;</code> (el <code>#payload</code> de una tarjeta).`,
    del_done: `🗑 <b>Revocado.</b> Todos los enlaces de este payload están muertos.`,
    rename_usage: `✏️ Uso: responde a una tarjeta con <code>/rename nuevo-nombre.mp4</code>.`,
    rename_done: `✏️ <b>Renombrado a</b> <code>{name}</code> — enlaces nuevos abajo.`,
    lang_set: `🌍 Idioma cambiado a <b>{lang}</b>.`,
    lang_list: `🌍 Idiomas disponibles: {langs}\nUso: <code>/lang &lt;código&gt;</code>`,
    gen_usage: `🔗 Uso: <code>/gen https://t.me/c/1234567/89</code> — o responde a un mensaje con medios.`,
    gen_fail: `❌ No pude copiar ese mensaje — asegúrate de que el bot pueda leer ese chat y que contenga un archivo.\n<code>{err}</code>`,
    unknown: `🤔 Comando desconocido. Envía /help — ¡o simplemente mándame un archivo!`,
    join_first: `🔒 <b>Suscripción requerida.</b> Únete al canal primero y vuelve a intentarlo.`,
    join_btn: `📢 Unirse al canal`,
  },
  hi: {
    w_title: `👋 <b>{bot} में आपका स्वागत है!</b>`,
    w_body: `मुझे <b>कोई भी फ़ाइल</b> भेजें — वीडियो, ऑडियो, दस्तावेज़, फ़ोटो — और मैं तुरंत <b>स्ट्रीमिंग और डाउनलोड लिंक</b> बना दूँगा।\n\n⚡ तुरंत स्ट्रीम + डाउनलोड लिंक\n🎬 सीक सहित HTML5 वॉच पेज\n⏳ स्वयं-समाप्त लिंक (<code>/ttl 30m</code>)\n🙊 पासवर्ड-सुरक्षित लिंक (<code>/pwd</code>)\n✏️ लिंक का नाम बदलें (<code>/rename</code>)\n📎 URL से सीधे अपलोड (<code>/upload</code>)\n🔗 किसी भी संदेश से लिंक बनाएँ (<code>/gen</code>)\n🔳 हर लिंक के लिए QR कोड (<code>/qr</code>)\n♻️ रद्द करने योग्य — डिलीट = सभी लिंक बंद\n🌍 8 भाषाएँ (<code>/lang</code>)\n🧬 शून्य डेटाबेस, 100% एज`,
    card_ready: `🔗 <b>लिंक तैयार!</b>`,
    card_name: `📄 <b>नाम:</b>`,
    card_size: `📦 <b>आकार:</b>`,
    card_exp: `⏳ <b>समाप्ति:</b>`,
    card_pwd: `🙊 <b>पासवर्ड:</b> इस रूप में साझा करें <code>{url}?key=आपका_पासवर्ड</code>`,
    card_tip: `<i>मूल फ़ाइल को रिप्लाई करें: <code>/ttl 30m</code>, <code>/pwd गुप्त</code> या <code>/rename नया-नाम.mp4</code>.</i>`,
    forbidden: `🚫 <b>पहुँच प्रतिबंधित।</b> यह बॉट निजी है — नीचे दिए गए स्रोत लिंक से अपना उदाहरण तैनात करें।`,
    no_file: `🤷 इस संदेश में कोई समर्थित फ़ाइल नहीं है। कृपया <b>वीडियो, दस्तावेज़, ऑडियो, फ़ोटो, GIF, वॉयस या वीडियो नोट</b> भेजें।`,
    help: `📖 <b>कमांड</b>\n\n📤 <i>कोई भी फ़ाइल भेजें / फ़ॉरवर्ड करें</i> → तुरंत लिंक\n/ttl &lt;समय&gt; — फ़ाइल को रिप्लाई: <code>30m</code>, <code>12h</code>, <code>7d</code>\n/pwd &lt;गुप्त&gt; — फ़ाइल को रिप्लाई: पासवर्ड सुरक्षा\n/rename &lt;नाम&gt; — लिंक कार्ड को रिप्लाई: नाम बदलें\n/qr — लिंक कार्ड को रिप्लाई: QR कोड पाएँ\n/upload &lt;url&gt;… — वेब से फ़ाइल लाएँ (≤ {max} MB)\n/gen &lt;t.me लिंक&gt; — किसी भी संदेश से लिंक बनाएँ\n/lang &lt;कोड&gt; — भाषा बदलें ({langs})\n/del &lt;payload&gt; — सभी लिंक रद्द करें (owner)\n/id — chat/user ID देखें\n/ping — लेटेंसी जाँच\n/stats — निदान (owner)\n\n🔎 <b>इनलाइन:</b> किसी भी चैट में <code>@{bot} &lt;payload&gt;</code> टाइप करें।`,
    upload_usage: `📎 उपयोग: <code>/upload &lt;url&gt; [url2 …] | नाम.mp4</code>\nअधिकतम: {max} MB प्रति फ़ाइल।`,
    upload_fetch: `⏳ लाया जा रहा है <code>{url}</code> …`,
    upload_fail: `❌ <b>अपलोड विफल:</b> {err}`,
    ttl_usage: `⏳ उपयोग: फ़ाइल को रिप्लाई करें <code>/ttl 30m</code> (या 12h / 7d / 90s)।`,
    pwd_usage: `🙊 उपयोग: फ़ाइल को रिप्लाई करें <code>/pwd मेरा-गुप्त</code>।`,
    del_usage: `🗑 उपयोग: <code>/del &lt;payload&gt;</code> (लिंक कार्ड का <code>#payload</code>)।`,
    del_done: `🗑 <b>रद्द कर दिया।</b> इस payload के सभी लिंक अब बंद हैं।`,
    rename_usage: `✏️ उपयोग: लिंक कार्ड को रिप्लाई करें <code>/rename नया-नाम.mp4</code>।`,
    rename_done: `✏️ <b>नाम बदला गया</b> <code>{name}</code> — नए लिंक नीचे।`,
    lang_set: `🌍 भाषा बदली गई: <b>{lang}</b>`,
    lang_list: `🌍 उपलब्ध भाषाएँ: {langs}\nउपयोग: <code>/lang &lt;कोड&gt;</code>`,
    gen_usage: `🔗 उपयोग: <code>/gen https://t.me/c/1234567/89</code> — या किसी मीडिया संदेश को रिप्लाई करें।`,
    gen_fail: `❌ वह संदेश कॉपी नहीं हो सका — सुनिश्चित करें कि बॉट उस चैट को पढ़ सकता है और उसमें फ़ाइल है।\n<code>{err}</code>`,
    unknown: `🤔 अज्ञात कमांड। /help भेजें — या सीधे फ़ाइल भेजें!`,
    join_first: `🔒 <b>सब्सक्रिप्शन आवश्यक।</b> पहले चैनल से जुड़ें, फिर पुनः प्रयास करें।`,
    join_btn: `📢 चैनल से जुड़ें`,
  },
  ar: {
    w_title: `👋 <b>مرحبًا بك في {bot}!</b>`,
    w_body: `أرسل لي <b>أي ملف</b> — فيديو، صوت، مستندات، صور — وسأحوّله فورًا إلى <b>روابط بث وتنزيل</b>.\n\n⚡ روابط بث وتنزيل فورية\n🎬 صفحة مشاهدة HTML5 مع تقديم/تأخير\n⏳ روابط تنتهي تلقائيًا (<code>/ttl 30m</code>)\n🙊 روابط محمية بكلمة مرور (<code>/pwd</code>)\n✏️ إعادة تسمية الروابط (<code>/rename</code>)\n📎 رفع مباشر من رابط (<code>/upload</code>)\n🔗 إنشاء روابط من أي رسالة (<code>/gen</code>)\n🔳 رمز QR لكل رابط (<code>/qr</code>)\n♻️ قابلة للإلغاء — الحذف يقتل كل الروابط\n🌍 8 لغات (<code>/lang</code>)\n🧬 بلا قواعد بيانات، 100% على الحافة`,
    card_ready: `🔗 <b>الرابط جاهز!</b>`,
    card_name: `📄 <b>الاسم:</b>`,
    card_size: `📦 <b>الحجم:</b>`,
    card_exp: `⏳ <b>ينتهي:</b>`,
    card_pwd: `🙊 <b>كلمة المرور:</b> شاركها كـ <code>{url}?key=كلمتك</code>`,
    card_tip: `<i>رد على الملف الأصلي بـ <code>/ttl 30m</code> أو <code>/pwd كلمة_المرور</code> أو <code>/rename اسم-جديد.mp4</code>.</i>`,
    forbidden: `🚫 <b>الوصول مقيّد.</b> هذا البوت خاص — انشر نسختك الخاصة من رابط المصدر أدناه.`,
    no_file: `🤷 لا توجد ملفات مدعومة في هذه الرسالة. أرسل <b>فيديو أو مستندًا أو صوتًا أو صورة أو GIF أو رسالة صوتية أو فيديو دائري</b>.`,
    help: `📖 <b>الأوامر</b>\n\n📤 <i>أرسل / أعِد توجيه أي ملف</i> → روابط فورية\n/ttl &lt;وقت&gt; — رد على ملف: <code>30m</code>، <code>12h</code>، <code>7d</code>\n/pwd &lt;كلمة&gt; — رد على ملف: حماية بكلمة مرور\n/rename &lt;اسم&gt; — رد على بطاقة رابط: إعادة تسمية\n/qr — رد على بطاقة رابط: احصل على رمز QR\n/upload &lt;رابط&gt;… — اجلب ملفات من الويب (حتى {max} MB)\n/gen &lt;رابط t.me&gt; — أنشئ روابط من أي رسالة\n/lang &lt;رمز&gt; — غيّر اللغة ({langs})\n/del &lt;payload&gt; — ألغِ كل الروابط (للمالك)\n/id — عرض المعرّفات\n/ping — فحص الاستجابة\n/stats — تشخيص الخدمة (للمالك)\n\n🔎 <b>سطر الأوامر المدمج:</b> اكتب <code>@{bot} &lt;payload&gt;</code> في أي محادثة.`,
    upload_usage: `📎 الاستخدام: <code>/upload &lt;رابط&gt; [رابط2 …] | اسم.mp4</code>\nالحد الأقصى: {max} MB للملف.`,
    upload_fetch: `⏳ جارٍ جلب <code>{url}</code> …`,
    upload_fail: `❌ <b>فشل الرفع:</b> {err}`,
    ttl_usage: `⏳ الاستخدام: رد على ملف بـ <code>/ttl 30m</code> (أو 12h / 7d / 90s).`,
    pwd_usage: `🙊 الاستخدام: رد على ملف بـ <code>/pwd كلمتك</code>.`,
    del_usage: `🗑 الاستخدام: <code>/del &lt;payload&gt;</code> (الـ <code>#payload</code> من بطاقة الرابط).`,
    del_done: `🗑 <b>تم الإلغاء.</b> كل روابط هذا الـ payload أصبحت ميتة الآن.`,
    rename_usage: `✏️ الاستخدام: رد على بطاقة رابط بـ <code>/rename اسم-جديد.mp4</code>.`,
    rename_done: `✏️ <b>أُعيدت التسمية إلى</b> <code>{name}</code> — الروابط الجديدة أدناه.`,
    lang_set: `🌍 تم ضبط اللغة إلى <b>{lang}</b>.`,
    lang_list: `🌍 اللغات المتاحة: {langs}\nالاستخدام: <code>/lang &lt;رمز&gt;</code>`,
    gen_usage: `🔗 الاستخدام: <code>/gen https://t.me/c/1234567/89</code> — أو رد على رسالة وسائط.`,
    gen_fail: `❌ تعذّر نسخ الرسالة — تأكد أن البوت يستطيع قراءة تلك المحادثة وأنها تحتوي ملفًا.\n<code>{err}</code>`,
    unknown: `🤔 أمر غير معروف. أرسل /help — أو أرسل ملفًا مباشرة!`,
    join_first: `🔒 <b>الاشتراك مطلوب.</b> انضم إلى القناة أولًا ثم أعد المحاولة.`,
    join_btn: `📢 انضم إلى القناة`,
  },
  ru: {
    w_title: `👋 <b>Добро пожаловать в {bot}!</b>`,
    w_body: `Пришлите мне <b>любой файл</b> — видео, аудио, документы, фото — и я мгновенно превращу его в <b>ссылки для стриминга и скачивания</b>.\n\n⚡ Мгновенные ссылки stream + download\n🎬 HTML5-страница просмотра с перемоткой\n⏳ Самоуничтожающиеся ссылки (<code>/ttl 30m</code>)\n🙊 Ссылки с паролем (<code>/pwd</code>)\n✏️ Переименование ссылок (<code>/rename</code>)\n📎 Загрузка прямо по URL (<code>/upload</code>)\n🔗 Ссылки из любого сообщения (<code>/gen</code>)\n🔳 QR-коды для каждой ссылки (<code>/qr</code>)\n♻️ Отзываемые — удаление убивает все ссылки\n🌍 8 языков (<code>/lang</code>)\n🧬 Без базы данных, 100% edge`,
    card_ready: `🔗 <b>Ссылка готова!</b>`,
    card_name: `📄 <b>Имя:</b>`,
    card_size: `📦 <b>Размер:</b>`,
    card_exp: `⏳ <b>Истекает:</b>`,
    card_pwd: `🙊 <b>Пароль:</b> делитесь так: <code>{url}?key=ВАШ_ПАРОЛЬ</code>`,
    card_tip: `<i>Ответьте на исходный файл: <code>/ttl 30m</code>, <code>/pwd пароль</code> или <code>/rename новое-имя.mp4</code>.</i>`,
    forbidden: `🚫 <b>Доступ ограничен.</b> Бот приватный — разверните свой экземпляр по ссылке на исходники ниже.`,
    no_file: `🤷 В сообщении нет поддерживаемого файла. Пришлите <b>видео, документ, аудио, фото, GIF, голосовое или видеосообщение</b>.`,
    help: `📖 <b>Команды</b>\n\n📤 <i>Просто отправьте / перешлите файл</i> → мгновенные ссылки\n/ttl &lt;время&gt; — ответ на файл: <code>30m</code>, <code>12h</code>, <code>7d</code>\n/pwd &lt;пароль&gt; — ответ на файл: защита паролем\n/rename &lt;имя&gt; — ответ на карточку: переименовать\n/qr — ответ на карточку: получить QR-код\n/upload &lt;url&gt;… — забрать файлы из интернета (≤ {max} МБ)\n/gen &lt;ссылка t.me&gt; — создать ссылки из любого сообщения\n/lang &lt;код&gt; — сменить язык ({langs})\n/del &lt;payload&gt; — отозвать все ссылки (владелец)\n/id — показать ID\n/ping — проверка задержки\n/stats — диагностика (владелец)\n\n🔎 <b>Inline:</b> введите <code>@{bot} &lt;payload&gt;</code> в любом чате.`,
    upload_usage: `📎 Использование: <code>/upload &lt;url&gt; [url2 …] | имя.mp4</code>\nМаксимум: {max} МБ на файл.`,
    upload_fetch: `⏳ Загружаю <code>{url}</code> …`,
    upload_fail: `❌ <b>Ошибка загрузки:</b> {err}`,
    ttl_usage: `⏳ Использование: ответьте на файл <code>/ttl 30m</code> (или 12h / 7d / 90s).`,
    pwd_usage: `🙊 Использование: ответьте на файл <code>/pwd мой-пароль</code>.`,
    del_usage: `🗑 Использование: <code>/del &lt;payload&gt;</code> (<code>#payload</code> из карточки).`,
    del_done: `🗑 <b>Отозвано.</b> Все ссылки этого payload теперь мертвы.`,
    rename_usage: `✏️ Использование: ответьте на карточку <code>/rename новое-имя.mp4</code>.`,
    rename_done: `✏️ <b>Переименовано в</b> <code>{name}</code> — новые ссылки ниже.`,
    lang_set: `🌍 Язык изменён на <b>{lang}</b>.`,
    lang_list: `🌍 Доступные языки: {langs}\nИспользование: <code>/lang &lt;код&gt;</code>`,
    gen_usage: `🔗 Использование: <code>/gen https://t.me/c/1234567/89</code> — или ответьте на сообщение с медиа.`,
    gen_fail: `❌ Не удалось скопировать сообщение — убедитесь, что бот может читать этот чат и что там есть файл.\n<code>{err}</code>`,
    unknown: `🤔 Неизвестная команда. Отправьте /help — или просто пришлите файл!`,
    join_first: `🔒 <b>Требуется подписка.</b> Сначала присоединитесь к каналу, затем повторите.`,
    join_btn: `📢 Присоединиться`,
  },
  pt: {
    w_title: `👋 <b>Bem-vindo ao {bot}!</b>`,
    w_body: `Envie-me <b>qualquer arquivo</b> — vídeo, áudio, documentos, fotos — e eu o transformo instantaneamente em <b>links de streaming e download</b>.\n\n⚡ Links de stream + download instantâneos\n🎬 Página de visualização HTML5 com seek\n⏳ Links que expiram sozinhos (<code>/ttl 30m</code>)\n🙊 Links protegidos por senha (<code>/pwd</code>)\n✏️ Renomear links (<code>/rename</code>)\n📎 Upload direto de URL (<code>/upload</code>)\n🔗 Criar links de qualquer mensagem (<code>/gen</code>)\n🔳 Códigos QR para cada link (<code>/qr</code>)\n♻️ Revogáveis — apagar = todos os links morrem\n🌍 8 idiomas (<code>/lang</code>)\n🧬 Sem banco de dados, 100% edge`,
    card_ready: `🔗 <b>Link pronto!</b>`,
    card_name: `📄 <b>Nome:</b>`,
    card_size: `📦 <b>Tamanho:</b>`,
    card_exp: `⏳ <b>Expira:</b>`,
    card_pwd: `🙊 <b>Senha:</b> compartilhe como <code>{url}?key=SUA_SENHA</code>`,
    card_tip: `<i>Responda ao arquivo original com <code>/ttl 30m</code>, <code>/pwd senha</code> ou <code>/rename novo-nome.mp4</code>.</i>`,
    forbidden: `🚫 <b>Acesso restrito.</b> Este bot é privado — implante sua própria instância pelo link do código-fonte.`,
    no_file: `🤷 Essa mensagem não tem um arquivo suportado. Envie um <b>vídeo, documento, áudio, foto, GIF, voz ou video note</b>.`,
    help: `📖 <b>Comandos</b>\n\n📤 <i>Envie / encaminhe qualquer arquivo</i> → links instantâneos\n/ttl &lt;tempo&gt; — responda a um arquivo: <code>30m</code>, <code>12h</code>, <code>7d</code>\n/pwd &lt;senha&gt; — responda a um arquivo: proteja com senha\n/rename &lt;nome&gt; — responda a um card: renomeie o arquivo\n/qr — responda a um card: receba o QR code\n/upload &lt;url&gt;… — traga arquivos da web (≤ {max} MB)\n/gen &lt;link t.me&gt; — crie links de qualquer mensagem\n/lang &lt;código&gt; — mude o idioma ({langs})\n/del &lt;payload&gt; — revogue todos os links (owner)\n/id — mostra os IDs\n/ping — teste de latência\n/stats — diagnóstico (owner)\n\n🔎 <b>Inline:</b> digite <code>@{bot} &lt;payload&gt;</code> em qualquer chat.`,
    upload_usage: `📎 Uso: <code>/upload &lt;url&gt; [url2 …] | nome.mp4</code>\nMáximo por arquivo: {max} MB.`,
    upload_fetch: `⏳ Buscando <code>{url}</code> …`,
    upload_fail: `❌ <b>Falha no upload:</b> {err}`,
    ttl_usage: `⏳ Uso: responda a um arquivo com <code>/ttl 30m</code> (ou 12h / 7d / 90s).`,
    pwd_usage: `🙊 Uso: responda a um arquivo com <code>/pwd minha-senha</code>.`,
    del_usage: `🗑 Uso: <code>/del &lt;payload&gt;</code> (o <code>#payload</code> de um card).`,
    del_done: `🗑 <b>Revogado.</b> Todos os links deste payload estão mortos agora.`,
    rename_usage: `✏️ Uso: responda a um card com <code>/rename novo-nome.mp4</code>.`,
    rename_done: `✏️ <b>Renomeado para</b> <code>{name}</code> — links novos abaixo.`,
    lang_set: `🌍 Idioma alterado para <b>{lang}</b>.`,
    lang_list: `🌍 Idiomas disponíveis: {langs}\nUso: <code>/lang &lt;código&gt;</code>`,
    gen_usage: `🔗 Uso: <code>/gen https://t.me/c/1234567/89</code> — ou responda a uma mensagem com mídia.`,
    gen_fail: `❌ Não consegui copiar a mensagem — verifique se o bot pode ler aquele chat e se há um arquivo nela.\n<code>{err}</code>`,
    unknown: `🤔 Comando desconhecido. Envie /help — ou simplesmente me mande um arquivo!`,
    join_first: `🔒 <b>Assinatura obrigatória.</b> Entre no canal primeiro e tente de novo.`,
    join_btn: `📢 Entrar no canal`,
  },
};

function detectLang(from) {
  const code = String(from?.language_code || "").toLowerCase();
  if (!code) return "en";
  if (code.startsWith("zh")) return "zh";
  if (code.startsWith("pt")) return "pt";
  const base = code.split(/[-_]/)[0];
  return LANGS.includes(base) ? base : "en";
}

/** t(lang, key, vars) — falls back to English, then to the raw key. */
function t(lang, key, vars = {}) {
  let s = I18N[lang]?.[key] ?? I18N.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const langCache = new Map(); // userId -> lang (per-isolate memo)
async function getUserLang(cfg, userId, from) {
  if (userId && langCache.has(userId)) return langCache.get(userId);
  const cache = globalThis.caches?.default || null;
  const key = new URL(`https://lang.internal/u/${userId || 0}`);
  if (cache && userId) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const { l } = await hit.json();
        if (LANGS.includes(l)) { langCache.set(userId, l); return l; }
      }
    } catch { /* ignore */ }
  }
  const lang = detectLang(from) || cfg.langDefault;
  return lang;
}

async function setUserLang(cfg, userId, lang) {
  langCache.set(userId, lang);
  const cache = globalThis.caches?.default || null;
  if (cache) {
    try {
      await cache.put(new URL(`https://lang.internal/u/${userId}`),
        new Response(JSON.stringify({ l: lang }),
          { headers: { "content-type": "application/json", "cache-control": "public, max-age=31536000" } }));
    } catch { /* ignore */ }
  }
}

/* ======================== LEGACY COMPAT (filestream-cf) =================== */
/**
 * Faithful port of the original Vauth/filestream-cf hash scheme
 * (base32 + salted XOR keystream), so existing ?file=<hash> links keep
 * working after the upgrade. Security note: this scheme is inherently
 * weaker than the new HMAC payloads; it exists purely for compatibility.
 * Disable with ENABLE_LEGACY=false.
 */

function legacyBaseDecode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const lookup = {};
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;
  let buffer = 0, bitsLeft = 0, output = "";
  for (let i = 0; i < input.length; i++) {
    const v = lookup[input[i]];
    if (v === undefined) throw new Error("bad char");
    buffer = (buffer << 5) | v;
    bitsLeft += 5;
    if (bitsLeft >= 8) { output += String.fromCharCode((buffer >> (bitsLeft - 8)) & 255); bitsLeft -= 8; }
  }
  return output;
}

function legacyGetKey(salt, secret, iterations = 1000, keyLength = 32) {
  const key = new Uint8Array(keyLength);
  for (let i = 0; i < keyLength; i++)
    key[i] = (secret.charCodeAt(i % secret.length) + salt.charCodeAt(i % salt.length)) % 256;
  for (let j = 0; j < iterations; j++)
    for (let i = 0; i < keyLength; i++)
      key[i] = (key[i] + secret.charCodeAt(i % secret.length) + salt.charCodeAt(i % salt.length)) % 256;
  return key;
}

/** Decode an old-style hash → messageId string (channel is always BOT_CHANNEL). */
function legacyDeHash(hashed, secret) {
  const decoded = legacyBaseDecode(hashed);
  if (decoded.length < 17) throw new Error("too short");
  const salt = decoded.substring(0, 16);
  const encoded = decoded.substring(16);
  const key = legacyGetKey(salt, secret);
  let text = "";
  for (let i = 0; i < encoded.length; i++)
    text += String.fromCharCode(encoded.charCodeAt(i) ^ key[i % key.length]);
  if (!/^\d+$/.test(text)) throw new Error("not a message id");
  return text;
}

/* ============================== QR CODES ================================== */
/**
 * Dependency-free QR encoder (Model 2, byte mode, ECC level M, versions
 * 1-10) — enough capacity for every link this bot can mint (~213 bytes).
 * Includes a raw PNG writer (grayscale, stored deflate blocks — no zlib
 * library needed) so the bot can send real QR images to Telegram.
 */

const QR_GEXP = new Uint8Array(512);
const QR_GLOG = new Uint8Array(256);
(function initGf() {
  for (let i = 0; i < 8; i++) QR_GEXP[i] = 1 << i;
  for (let i = 8; i < 256; i++) QR_GEXP[i] = QR_GEXP[i - 4] ^ QR_GEXP[i - 5] ^ QR_GEXP[i - 6] ^ QR_GEXP[i - 8];
  for (let i = 0; i < 255; i++) QR_GLOG[QR_GEXP[i]] = i;
  for (let i = 255; i < 512; i++) QR_GEXP[i] = QR_GEXP[i - 255];
})();

function qrGmul(a, b) {
  return a === 0 || b === 0 ? 0 : QR_GEXP[(QR_GLOG[a] + QR_GLOG[b]) % 255];
}

/* RS block layout per version, ECC level M: [count, totalPerBlock, dataPerBlock] */
const QR_RS_M = {
  1: [[1, 26, 16]], 2: [[1, 44, 28]], 3: [[1, 70, 44]], 4: [[2, 50, 32]],
  5: [[2, 67, 43]], 6: [[4, 43, 27]], 7: [[4, 49, 31]],
  8: [[2, 60, 38], [2, 61, 39]], 9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]],
};
const QR_ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function qrRsBlocks(ver) {
  const out = [];
  for (const [count, total, data] of QR_RS_M[ver])
    for (let i = 0; i < count; i++) out.push({ total, data, ec: total - data });
  return out;
}

function qrPolyMul(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) r[i + j] ^= qrGmul(a[i], b[j]);
  return r;
}

/** Reed-Solomon ECC codewords for one data block. */
function qrEc(data, ecLen) {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) gen = qrPolyMul(gen, [1, QR_GEXP[i]]);
  const res = data.slice();
  for (let i = 0; i < ecLen; i++) res.push(0);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0)
      for (let j = 0; j < gen.length; j++) res[i + j] ^= qrGmul(gen[j], coef);
  }
  return res.slice(data.length);
}

function qrCapacity(ver) {
  return qrRsBlocks(ver).reduce((s, b) => s + b.data, 0);
}

/** Bit-buffer encode (mode 0100, byte payload, terminator + pad). */
function qrEncodeBytes(bytes, ver) {
  const totalData = qrCapacity(ver);
  const lengthBits = ver < 10 ? 8 : 16;
  if (bytes.length * 8 + 4 + lengthBits > totalData * 8) return null;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, lengthBits);
  for (const b of bytes) push(b, 8);
  const totalBits = totalData * 8;
  push(0, Math.min(4, totalBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const pad = [0xec, 0x11];
  let pi = 0;
  while (bits.length < totalBits) push(pad[pi++ % 2], 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  return data;
}

function qrFinalBytes(ver, dataCw) {
  const blocks = qrRsBlocks(ver);
  const dc = [], ec = [];
  let off = 0;
  for (const b of blocks) {
    dc.push(dataCw.slice(off, off + b.data));
    off += b.data;
    ec.push(qrEc(dc[dc.length - 1], b.ec));
  }
  const out = [];
  const maxDc = Math.max(...blocks.map((b) => b.data));
  const maxEc = Math.max(...blocks.map((b) => b.ec));
  for (let i = 0; i < maxDc; i++)
    for (let j = 0; j < dc.length; j++) if (i < dc[j].length) out.push(dc[j][i]);
  for (let i = 0; i < maxEc; i++)
    for (let j = 0; j < ec.length; j++) if (i < ec[j].length) out.push(ec[j][i]);
  return out;
}

function qrBchDigit(d) { let n = 0; while (d !== 0) { n++; d >>>= 1; } return n; }

/** 15-bit format info (ECC level M = 0b00) for a mask pattern. */
function qrFormatBits(mask) {
  const G15 = 0x537, G15_MASK = 0x5412;
  let d = mask;
  while (qrBchDigit(d) - qrBchDigit(G15) >= 0) d ^= G15 << (qrBchDigit(d) - qrBchDigit(G15));
  return ((mask << 10) | d) ^ G15_MASK;
}

/** 18-bit version info (versions 7-10). */
function qrVersionBits(ver) {
  const G18 = 0x1f25;
  let d = ver;
  while (qrBchDigit(d) - qrBchDigit(G18) >= 0) d ^= G18 << (qrBchDigit(d) - qrBchDigit(G18));
  return (ver << 12) | d;
}

const QR_MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

function qrMapData(m, data, mask, size) {
  const maskFn = QR_MASKS[mask];
  let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (const c of [0, 1]) {
        if (m[row][col - c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          if (maskFn(row, col - c)) dark = !dark;
          m[row][col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
}

function qrPlaceFormat(m, mask, size) {
  const bits = qrFormatBits(mask);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    if (i < 6) m[i][8] = mod;
    else if (i < 8) m[i + 1][8] = mod;
    else m[size - 15 + i][8] = mod;
    if (i < 8) m[8][size - i - 1] = mod;
    else if (i < 9) m[8][15 - i - 1 + 1] = mod;
    else m[8][15 - i - 1] = mod;
  }
  m[size - 8][8] = true; // the eternal dark module
}

/** Standard penalty score (N1-N4) — used to pick the optimal mask. */
function qrPenalty(m, size) {
  let p = 0, dark = 0;
  for (let dir = 0; dir < 2; dir++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        const cur = j < size ? (dir === 0 ? m[i][j] : m[j][i]) : null;
        const prev = dir === 0 ? m[i][j - 1] : m[j - 1][i];
        if (j < size && cur === prev) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
    }
  }
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) p += 3;
    }
  const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let dir = 0; dir < 2; dir++)
    for (let i = 0; i < size; i++)
      for (let j = 0; j <= size - 11; j++) {
        let m1 = true, m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = (dir === 0 ? m[i][j + k] : m[j + k][i]) ? 1 : 0;
          if (v !== PAT1[k]) m1 = false;
          if (v !== PAT2[k]) m2 = false;
          if (!m1 && !m2) break;
        }
        if (m1 || m2) p += 40;
      }
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

/** Encode text to a QR module matrix. Throws when the text exceeds v10-M. */
function qrMatrix(text) {
  const bytes = TE.encode(String(text));
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (bytes.length * 8 + headerBits <= qrCapacity(v) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error(`QR: text too long (${bytes.length} bytes; v10-M caps at 213)`);
  const size = 17 + 4 * ver;
  const base = Array.from({ length: size }, () => new Array(size).fill(null));

  const setProbe = (r, c) => {
    for (let i = -1; i <= 7; i++)
      for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        base[rr][cc] = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
          (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
          (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      }
  };
  setProbe(0, 0);
  setProbe(size - 7, 0);
  setProbe(0, size - 7);

  for (const r of QR_ALIGN[ver - 1])
    for (const c of QR_ALIGN[ver - 1]) {
      if (base[r][c] !== null) continue;
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++)
          base[r + i][c + j] = i === -2 || i === 2 || j === -2 || j === 2 || (i === 0 && j === 0);
    }

  for (let i = 8; i < size - 8; i++) {
    if (base[i][6] === null) base[i][6] = i % 2 === 0;
    if (base[6][i] === null) base[6][i] = i % 2 === 0;
  }

  if (ver >= 7) {
    const bits = qrVersionBits(ver);
    for (let i = 0; i < 18; i++) {
      const mod = ((bits >> i) & 1) === 1;
      base[Math.floor(i / 3)][i % 3 + size - 8 - 3] = mod;
      base[i % 3 + size - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  const dataCw = qrFinalBytes(ver, qrEncodeBytes(bytes, ver));
  let best = null, bestPen = Infinity, bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((r) => r.slice());
    qrPlaceFormat(m, mask, size);
    qrMapData(m, dataCw, mask, size);
    const pen = qrPenalty(m, size);
    if (pen < bestPen) { bestPen = pen; best = m; bestMask = mask; }
  }
  return { size, version: ver, mask: bestMask, modules: best };
}

/** QR as a standalone SVG string. */
function svgQr(text, opts = {}) {
  const q = qrMatrix(text);
  const quiet = opts.quiet ?? 4, scale = opts.scale ?? 8;
  const dark = opts.dark || "#000", light = opts.light || "#fff";
  const dim = (q.size + quiet * 2) * scale;
  let rects = "";
  for (let r = 0; r < q.size; r++)
    for (let c = 0; c < q.size; c++)
      if (q.modules[r][c])
        rects += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}

/* --------------------------- tiny PNG writer ------------------------------ */

let QR_CRC_T = null;
function crc32(buf) {
  if (!QR_CRC_T) {
    QR_CRC_T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
      QR_CRC_T[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = (QR_CRC_T[(c ^ b) & 255] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (const x of buf) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit grayscale PNG via stored (uncompressed) deflate blocks. */
function pngGray(pix, w, h) {
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    raw.set(pix.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const blocks = [];
  let off = 0;
  do {
    const n = Math.min(65535, raw.length - off);
    const blk = new Uint8Array(5 + n);
    blk[0] = off + n >= raw.length ? 1 : 0;
    blk[1] = n & 255;
    blk[2] = (n >> 8) & 255;
    blk[3] = ~n & 255;
    blk[4] = (~n >> 8) & 255;
    blk.set(raw.subarray(off, off + n), 5);
    blocks.push(blk);
    off += n;
  } while (off < raw.length);
  const z = new Uint8Array(2 + blocks.reduce((s, b) => s + b.length, 0) + 4);
  z[0] = 0x78; z[1] = 0x01;
  let zo = 2;
  for (const b of blocks) { z.set(b, zo); zo += b.length; }
  const ad = adler32(raw);
  z[zo++] = (ad >>> 24) & 255;
  z[zo++] = (ad >>> 16) & 255;
  z[zo++] = (ad >>> 8) & 255;
  z[zo++] = ad & 255;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", z),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** QR code as a real PNG (Uint8Array) — sent to Telegram as a photo. */
function pngQrBytes(text, scale = 8) {
  const q = qrMatrix(text);
  const quiet = 4;
  const dim = (q.size + quiet * 2) * scale;
  const pix = new Uint8Array(dim * dim).fill(255);
  for (let r = 0; r < q.size; r++)
    for (let c = 0; c < q.size; c++)
      if (q.modules[r][c])
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            pix[((r + quiet) * scale + dy) * dim + (c + quiet) * scale + dx] = 0;
  return pngGray(pix, dim, dim);
}

/* ============================ TELEGRAM API ================================ */

let rrCounter = Math.floor(Math.random() * 1024);

/** Round-robin token index — ported from filestream.bot's "Multi-Bot Workers". */
function pickTokenIdx(cfg) {
  if (cfg.tokens.length < 2) return 0;
  rrCounter = (rrCounter + 1) % cfg.tokens.length;
  return rrCounter;
}

/** Primary token (used for webhook ops & the storage channel). */
function primaryToken(cfg) {
  return cfg.tokens[0];
}

async function tg(token, method, params = {}, fetchInit = null) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let init = fetchInit;
  if (!init) {
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) };
    if (Object.keys(params).length === 0) init.body = "{}";
  }
  try {
    const res = await fetch(url, init);
    const json = await res.json().catch(() => ({ ok: false, error_code: res.status, description: "bad json" }));
    return json.ok ? json : { ok: false, error_code: json.error_code || res.status, description: json.description || "unknown error" };
  } catch (e) {
    return { ok: false, error_code: 502, description: `network error: ${e.message}` };
  }
}

const botUserCache = new Map();
async function getBotUsername(cfg) {
  if (cfg.botUsername) return cfg.botUsername;
  if (botUserCache.has(0)) return botUserCache.get(0);
  const me = await tg(primaryToken(cfg), "getMe");
  if (me.ok) {
    botUserCache.set(0, me.result.username);
    return me.result.username;
  }
  return "";
}

/** Preferred token order: round-robin pick first, then the rest (failover). */
function tokenOrder(cfg) {
  const n = cfg.tokens.length;
  if (n <= 1) return [0];
  const first = pickTokenIdx(cfg);
  return Array.from({ length: n }, (_, i) => (first + i) % n);
}

/** getFile — resolves a file_id to a downloadable file_path. */
async function tgGetFile(token, fileId) {
  return tg(token, "getFile", { file_id: fileId });
}

/** Download bytes (streaming). Pass a Range header through to Telegram. */
async function tgFetchFile(cfg, token, filePath, rangeHeader) {
  const headers = {};
  if (rangeHeader) headers["Range"] = rangeHeader;
  return fetch(`${cfg.botApiBase}/file/bot${token}/${filePath}`, { headers });
}

/* ============================== GUARDS ==================================== */
/**
 * Edge-only protection layer: live counters, per-IP rate limiting, hotlink
 * protection, Turnstile captcha gating and Telegram Mini App initData
 * verification. Every one of these works without a database.
 */

const STATS = {
  boot: Date.now(), req: 0, bot: 0, stream: 0, dl: 0, watch: 0,
  api: 0, cacheHits: 0, probes: 0, bytes: 0, errors: 0,
};
function bumpStats(key, n = 1) {
  if (key in STATS) STATS[key] += n;
}

const rateBuckets = new Map();
function rateLimit(cfg, request) {
  if (!cfg.rateRpm) return true;
  const ip = request.headers.get("cf-connecting-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "anon";
  const now = Date.now();
  let arr = (rateBuckets.get(ip) || []).filter((ts) => now - ts < 60000);
  if (arr.length >= cfg.rateRpm) { rateBuckets.set(ip, arr); return false; }
  arr.push(now);
  rateBuckets.set(ip, arr);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // crude memory guard
  return true;
}

/** Hotlink protection: when ALLOWED_REFERRERS is set, off-site embeds 403. */
function referrerOk(cfg, request) {
  if (!cfg.allowedReferrers.length) return true;
  const ref = request.headers.get("referer") || request.headers.get("origin");
  if (!ref) return true; // direct opens (apps, curl) stay allowed
  try {
    const host = new URL(ref).hostname.toLowerCase();
    return cfg.allowedReferrers.some((d) => host === d || host.endsWith("." + d));
  } catch { return true; }
}

/* ---- Turnstile gate: anonymous proof-of-humanness, stored as a signed cookie ---- */

const GATE_COOKIE = "tsg";

async function signGateCookie(cfg, ttlSec = 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = (await hmacBytes(cfg.linkSecret, "gate:" + exp)).slice(0, 16);
  return `${exp}.${b64uEnc(sig)}`;
}

async function gateCookieOk(cfg, request) {
  if (!cfg.tsSecret) return true; // feature disabled → always pass
  const m = new RegExp(`(?:^|;\\s*)${GATE_COOKIE}=([^;]+)`).exec(request.headers.get("cookie") || "");
  if (!m) return false;
  const [expStr, sig] = m[1].split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const expect = (await hmacBytes(cfg.linkSecret, "gate:" + exp)).slice(0, 16);
  try { return bytesEqual(expect, b64uDec(sig || "")); } catch { return false; }
}

async function turnstileVerify(cfg, token, ip) {
  const body = new URLSearchParams({ secret: cfg.tsSecret, response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const j = await res.json().catch(() => ({ success: false }));
  return !!j.success;
}

/* ---- Telegram Mini App initData verification (HMAC-SHA256, spec-compliant) ---- */

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function validateInitData(cfg, initData, maxAgeSec = 86400) {
  try {
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const hash = (params.get("hash") || "").toLowerCase();
    if (!hash || hash.length !== 64 || /[^0-9a-f]/.test(hash)) return null;
    params.delete("hash");
    const dcs = [...params.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`).join("\n");
    const enc = { name: "HMAC", hash: "SHA-256" };
    const outer = await crypto.subtle.importKey("raw", TE.encode("WebAppData"), enc, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", outer, TE.encode(primaryToken(cfg)));
    const inner = await crypto.subtle.importKey("raw", secret, enc, false, ["sign"]);
    const calc = new Uint8Array(await crypto.subtle.sign("HMAC", inner, TE.encode(dcs)));
    if (!bytesEqual(calc, hexToBytes(hash.toLowerCase()))) return null;
    const authDate = parseInt(params.get("auth_date") || "0", 10);
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSec) return null;
    return JSON.parse(params.get("user") || "null");
  } catch { return null; }
}

/* ---- Force-subscribe gate (bot-side) ---- */

const memberCache = new Map(); // userId -> {ok, ts}
async function isMember(cfg, userId) {
  if (!cfg.forceSub) return true;
  const hit = memberCache.get(userId);
  if (hit && Date.now() - hit.ts < 600000) return hit.ok;
  const r = await tg(primaryToken(cfg), "getChatMember", { chat_id: cfg.forceSub, user_id: userId });
  let ok = false;
  if (r.ok) {
    const s = r.result.status;
    ok = s === "creator" || s === "administrator" || s === "member" || (s === "restricted" && r.result.is_member);
  } else {
    ok = true; // fail-open on API errors — never lock everyone out
  }
  memberCache.set(userId, { ok, ts: Date.now() });
  return ok;
}

const joinLinkCache = { url: null, ts: 0 };
async function joinLink(cfg) {
  if (cfg.forceSubUrl) return cfg.forceSubUrl;
  if (joinLinkCache.url && Date.now() - joinLinkCache.ts < 3600000) return joinLinkCache.url;
  const r = await tg(primaryToken(cfg), "getChat", { chat_id: cfg.forceSub });
  let url = null;
  if (r.ok) url = r.result.username ? `https://t.me/${r.result.username}` : r.result.invite_link || null;
  if (url) { joinLinkCache.url = url; joinLinkCache.ts = Date.now(); }
  return url;
}

/* ------------------------- send helpers ---------------------------------- */

async function tgSend(token, method, params) {
  return tg(token, method, params);
}

async function replyHTML(cfg, chatId, text, keyboard = null, replyTo = null) {
  const params = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard ? JSON.stringify({ inline_keyboard: keyboard }) : undefined,
  };
  if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  return tg(primaryToken(cfg), "sendMessage", params);
}

/* ====================== METADATA PROBE (the key trick) ==================== */
/**
 * Resolve file metadata for a stored channel message WITHOUT destroying it.
 *
 * The original project called editMessageCaption with a random UUID, which
 * nuked the file's caption on every request. We instead call
 * editMessageReplyMarkup with a "Stream" button whose URL fragment changes
 * every probe — so the API never answers "message is not modified", the
 * caption stays untouched, and the response still contains the full Message
 * object (file_id, name, mime, size, thumbnail).
 *
 * Bonus: the returned file_id is valid for the *calling* bot token, which is
 * exactly what makes multi-token rotation possible on a Bot-API-only stack.
 *
 * Results are edge-cached per (payload, tokenIdx) via the Cache API.
 */

async function probeKeyboard(cfg, watchUrl) {
  return {
    inline_keyboard: [[
      { text: "⚡ Stream", url: `${watchUrl}#${Date.now().toString(36)}` },
      { text: "⬇️ Download", url: `${watchUrl.replace("/watch/", "/dl/")}` },
    ]],
  };
}

function extractMeta(msg, kind) {
  if (!msg) return null;
  // Auto-detect kind (used by the legacy-link resolver where kind is unknown).
  if (!kind || kind === "auto") {
    const mo = mediaOf(msg);
    if (!mo) return null;
    kind = mo.kind;
  }
  const d = msg.document, v = msg.video, a = msg.audio, g = msg.animation,
    n = msg.video_note, o = msg.voice, p = msg.photo;

  // NOTE: everything except photos is stored via sendDocument (to preserve
  // file_name + mime). So for media kinds, fall back to the document copy.
  if (kind === "p") {
    if (!p || !p.length) return null;
    const big = p[p.length - 1];
    return {
      kind, name: `${big.file_unique_id}.jpg`, mime: "image/jpeg",
      size: big.file_size, fileId: big.file_id, thumb: null,
    };
  }

  const native = { d, v, a, g, n, o }[kind];
  const src = native || (kind === "d" ? null : d);
  if (!src) return null;

  const fbName = {
    d: `file_${src.file_unique_id}`, v: `video_${src.file_unique_id}.mp4`,
    a: `audio_${src.file_unique_id}.mp3`, g: `anim_${src.file_unique_id}.mp4`,
    n: `note_${src.file_unique_id}.mp4`, o: `voice_${src.file_unique_id}.ogg`,
  }[kind];
  const fbMime = {
    d: "application/octet-stream", v: "video/mp4", a: "audio/mpeg",
    g: "video/mp4", n: "video/mp4", o: "audio/ogg",
  }[kind];

  return {
    kind,
    name: src.file_name || fbName,
    mime: src.mime_type || fbMime,
    size: src.file_size,
    fileId: src.file_id,
    thumb: src.thumbnail?.file_id || null,
  };
}

/**
 * Resolve metadata for a payload with a given token index.
 * Uses edge cache first; falls back to the reply-markup probe.
 */
async function resolveMeta(cfg, data, raw, idx, origin) {
  const cache = globalThis.caches?.default || null;
  const cacheKey = new URL(`https://meta.internal/${idx}/${raw}`);
  const watchUrl = `${origin}/watch/${raw}`;

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      try {
        const meta = await hit.json();
        if (meta && meta.fileId) { bumpStats("cacheHits"); return meta; }
      } catch { /* corrupt cache entry → re-probe */ }
    }
  }

  bumpStats("probes");
  const res = await tg(cfg.tokens[idx], "editMessageReplyMarkup", {
    chat_id: data.c,
    message_id: data.m,
    reply_markup: JSON.stringify(await probeKeyboard(cfg, watchUrl)),
  });
  if (!res.ok) return null;

  const meta = extractMeta(res.result, data.k);
  if (!meta) return null;

  if (cache) {
    const headers = { "content-type": "application/json", "cache-control": "public, max-age=1800" };
    await cache.put(cacheKey, new Response(JSON.stringify(meta), { headers }));
  }
  return meta;
}

/* ========================= STREAMING ENGINE =============================== */
/**
 * True streaming proxy — the original buffered the ENTIRE file into memory
 * with arrayBuffer() (and only supported ≤20 MB, unseekable). We pipe
 * upstream.body straight to the client, forward Range headers so players can
 * seek, support HEAD, and set sane cache/ETag headers.
 */

function payloadExpired(data) {
  return data.e && data.e < Math.floor(Date.now() / 1000);
}

async function guardQuery(cfg, request, data) {
  // Password proof-of-knowledge check (if the payload carries one).
  if (!data.q) return { ok: true };
  const key = requestPasswordKey(request);
  return bytesEqual(b64uDec(data.q), b64uDec(await passwordProof(cfg, key)))
    ? { ok: true }
    : { ok: false };
}

function baseFileHeaders(meta, disposition, request) {
  const url = new URL(request.url);
  return {
    "content-type": meta.mime,
    "content-disposition": contentDisposition(disposition, meta.name),
    "accept-ranges": "bytes",
    etag: `"${url.pathname}"`,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range, Content-Type",
    "cache-control": "public, max-age=86400",
  };
}

/**
 * Serve the actual bytes behind a verified payload.
 * mode: "inline" (stream in browser) | "attachment" (force download).
 * v3: token failover — if the round-robin token can't resolve or fetch the
 * file (429, revoked session, regional hiccup), the next token takes over.
 */
async function handleFileBytes(request, cfg, data, raw, mode) {
  if (payloadExpired(data)) {
    return pageError(410, "Link expired", "This link carried a TTL and has self-destructed. Ask the sender for a fresh one.");
  }
  const pw = await guardQuery(cfg, request, data);
  if (!pw.ok) {
    return pageError(403, "Password required",
      `This file is protected. Append <code>?key=your-password</code> to the URL.`, true);
  }

  const origin = new URL(request.url).origin;
  let metaSeen = false, lastErr = null;

  for (const idx of tokenOrder(cfg)) {
    let meta = await resolveMeta(cfg, data, raw, idx, origin);
    if (!meta) continue;
    metaSeen = true;
    if (data.name) meta = { ...meta, name: String(data.name) }; // /rename override

    if (request.method === "HEAD") {
      const h = baseFileHeaders(meta, mode === "attachment" ? "attachment" : "inline", request);
      if (meta.size) h["content-length"] = String(meta.size);
      return new Response(null, { status: 200, headers: h });
    }

    const file = await tgGetFile(cfg.tokens[idx], meta.fileId);
    if (!file.ok) { lastErr = file.description || "getFile failed"; continue; }

    const upstream = await tgFetchFile(cfg, cfg.tokens[idx], file.result.file_path,
      request.headers.get("range"));
    if (!upstream.ok && upstream.status !== 206) {
      lastErr = `Telegram returned ${upstream.status}`;
      try { await upstream.body?.cancel(); } catch { /* ignore */ }
      continue;
    }

    const h = baseFileHeaders(meta, mode === "attachment" ? "attachment" : "inline", request);
    const inm = request.headers.get("if-none-match");
    if (inm && inm === h.etag && !request.headers.get("range")) {
      return new Response(null, { status: 304, headers: { etag: h.etag } });
    }
    for (const k of ["content-length", "content-range", "last-modified"]) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    if (request.headers.get("range") && upstream.status === 200) {
      // Upstream ignored Range; be honest with the player.
      h["accept-ranges"] = "none";
    }
    const len = parseInt(upstream.headers.get("content-length") || "0", 10);
    if (len) bumpStats("bytes", len);
    return new Response(upstream.body, { status: upstream.status, headers: h });
  }

  return metaSeen
    ? pageError(502, "Telegram error", `Every bot token failed: ${esc(lastErr || "unknown")}`)
    : pageError(404, "File not found", "The underlying Telegram message was deleted or is unreachable — all links for it are dead.");
}

/** Thumbnail proxy (edge-cached, immutable). */
async function handleThumb(request, cfg, data, raw) {
  const pw = await guardQuery(cfg, request, data);
  if (!pw.ok) return pageError(403, "Password required", "This thumbnail is protected. Append <code>?key=your-password</code>.", true);
  if (payloadExpired(data)) return pageError(410, "Link expired", "TTL is over.");

  const cache = globalThis.caches?.default || null;
  const cacheKey = new URL(`https://thumb.internal/${raw}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const origin = new URL(request.url).origin;
  const meta = await resolveMeta(cfg, data, raw, 0, origin);
  if (!meta || !meta.thumb) return pageError(404, "No thumbnail", "This file has no thumbnail.");

  const file = await tgGetFile(primaryToken(cfg), meta.thumb);
  if (!file.ok) return pageError(404, "No thumbnail", "Thumbnail unavailable.");

  const upstream = await tgFetchFile(cfg, primaryToken(cfg), file.result.file_path, null);
  if (!upstream.ok) return pageError(404, "No thumbnail", "Thumbnail unavailable.");

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") || "image/jpeg",
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
  if (cache) { try { await cache.put(cacheKey, res.clone()); } catch { /* ignore */ } }
  return res;
}

/* ============================== BOT BRAIN ================================= */

function forbiddenCard(cfg) {
  return [
    `🚫 <b>Access restricted.</b>`,
    ``,
    `This bot is private. Deploy your own instance — it takes 2 minutes and costs nothing:`,
    `<a href="${cfg.sourceUrl}">📌 TG FileStream PRO (open source)</a>`,
  ].join("\n");
}

/** Extract the media entity + kind from any message. */
function mediaOf(msg) {
  if (!msg) return null;
  if (msg.document) return { kind: "d", m: msg.document };
  if (msg.video)    return { kind: "v", m: msg.video };
  if (msg.animation)return { kind: "g", m: msg.animation };
  if (msg.video_note) return { kind: "n", m: msg.video_note };
  if (msg.voice)    return { kind: "o", m: msg.voice };
  if (msg.audio)    return { kind: "a", m: msg.audio };
  if (msg.photo)    return { kind: "p", m: msg.photo[msg.photo.length - 1] };
  return null;
}

/** Build the canonical URLs for a payload. */
function buildLinks(origin, raw) {
  const b = (p) => `${origin}${p}`;
  return {
    stream: b(`/stream/${raw}`),
    dl:     b(`/dl/${raw}`),
    watch:  b(`/watch/${raw}`),
    thumb:  b(`/thumb/${raw}`),
  };
}

function linkCard(cfg, meta, raw, origin, opts = {}) {
  const lang = opts.lang || "en";
  const k = KINDS[meta.kind] || KINDS.d;
  const L = buildLinks(origin, raw);
  const kb = [
    [
      { text: "⚡ Stream", url: L.stream },
      { text: "⬇️ Download", url: L.dl },
      { text: "🎬 Watch", url: L.watch },
    ],
    [
      { text: "📤 Share", url: `https://t.me/share/url?url=${encodeURIComponent(L.watch)}&text=${encodeURIComponent(meta.name)}` },
      { text: "♻️ Get again", url: `https://t.me/${cfg.botUsername || "thisbot"}?start=${raw}` },
    ],
  ];
  if (cfg.qrEnabled && raw.length <= 56) kb.push([{ text: "🔳 QR code", callback_data: `qr:${raw}` }]);
  if (opts.owner && opts.cardId) {
    kb.push([{ text: "🗑 Delete + revoke links", callback_data: `del:${raw}:${opts.cardId}` }]);
  }
  const lines = [
    t(lang, "card_ready"),
    ``,
    `${t(lang, "card_name")} <code>${esc(meta.name)}</code>`,
    `${t(lang, "card_size")} ${fmtBytes(meta.size)}  •  🏷 <code>${esc(meta.mime)}</code>`,
    `🔗 <b>Payload:</b> <code>#${esc(raw)}</code>`,
  ];
  if (opts.expiry) lines.push(`${t(lang, "card_exp")} ${new Date(opts.expiry * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`);
  if (opts.password) lines.push(t(lang, "card_pwd", { url: L.watch }));
  lines.push(``, t(lang, "card_tip"));
  return { text: lines.join("\n"), keyboard: kb };
}

/**
 * Core upload flow: take a media message → mirror it to the storage channel
 * (the "database") → mint a signed v3 binary payload → reply with a link card.
 * Bonus: the bot self-replies under the stored file with its watch link, so
 * the channel itself becomes a searchable catalog (INDEX_ENABLED).
 */
async function handleIncomingFile(cfg, msg, opts = {}) {
  const media = mediaOf(msg);
  const lang = await getUserLang(cfg, msg.from?.id, msg.from);
  if (!media) {
    return replyHTML(cfg, msg.chat.id, t(lang, "no_file"), null, msg.message_id);
  }

  if (!cfg.canUse(msg.from?.id)) {
    return replyHTML(cfg, msg.chat.id,
      `${t(lang, "forbidden")}\n<a href="${cfg.sourceUrl}">📌 ${esc(cfg.brand)} (open source)</a>`, null, msg.message_id);
  }

  // Force-subscribe gate (owners always pass).
  if (cfg.forceSub && !cfg.owners(msg.from?.id) && !(await isMember(cfg, msg.from.id))) {
    const link = await joinLink(cfg);
    const kb = link ? [[{ text: t(lang, "join_btn"), url: link }]] : null;
    return replyHTML(cfg, msg.chat.id, t(lang, "join_first"), kb, msg.message_id);
  }

  const token = primaryToken(cfg);
  const sendKind = KINDS[media.kind].send;
  const method = sendKind === "photo" ? "sendPhoto" : "sendDocument";
  const saved = await tg(token, method, {
    chat_id: cfg.channel,
    [sendKind]: media.m.file_id,
  });

  if (!saved.ok) {
    const hint = /chat not found|not enough rights|bot is not a member/i.test(saved.description || "")
      ? `\n\n⚠️ Make sure the bot is an <b>admin</b> of the storage channel (<code>BOT_CHANNEL</code>) with post rights.`
      : "";
    return replyHTML(cfg, msg.chat.id, `❌ <b>Storage failed:</b> <code>${esc(saved.description || "unknown")}</code>${hint}`, null, msg.message_id);
  }

  const data = { c: cfg.channel, m: saved.result.message_id, k: media.kind };
  if (opts.ttl) data.e = Math.floor(Date.now() / 1000) + opts.ttl;
  if (opts.password) data.q = await passwordProof(cfg, opts.password);

  const raw = await mintPayload(cfg, data);
  const origin = opts.origin;
  const meta = {
    kind: media.kind,
    name: media.m.file_name || media.m.file_unique_id && (media.kind === "p" ? `${media.m.file_unique_id}.jpg` : `file_${media.m.file_unique_id}`) || "file",
    mime: media.m.mime_type || guessMime(media.m.file_name || "", media.kind),
    size: media.m.file_size,
  };

  // Catalog self-reply inside the storage channel (search = the "database").
  if (cfg.indexEnabled && origin) {
    try {
      await tg(token, "sendMessage", {
        chat_id: cfg.channel,
        text: `🗂 <b>${esc(meta.name)}</b> (${fmtBytes(meta.size)}) — ${origin}/watch/${raw}`,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: saved.result.message_id, allow_sending_without_reply: true },
      });
    } catch { /* catalog is best-effort — never block the link card */ }
  }

  const card = linkCard(cfg, meta, raw, origin, {
    owner: cfg.owners(msg.from?.id),
    cardId: null, // filled after send below
    expiry: data.e,
    password: !!data.q,
    lang,
  });
  const sent = await replyHTML(cfg, msg.chat.id, card.text, card.keyboard, msg.message_id);

  // Attach the delete button only now that we know our own card message id.
  if (cfg.owners(msg.from?.id) && sent.ok) {
    const kb2 = linkCard(cfg, meta, raw, origin, { owner: true, cardId: sent.result.message_id, lang }).keyboard;
    await tg(token, "editMessageReplyMarkup", {
      chat_id: msg.chat.id, message_id: sent.result.message_id,
      reply_markup: JSON.stringify({ inline_keyboard: kb2 }),
    });
  }
  return sent;
}

/** Reply-to-file regeneration: /ttl 30m and /pwd secret. */
async function regenerate(cfg, msg, opts, usageKey = "ttl_usage") {
  const lang = await getUserLang(cfg, msg.from?.id, msg.from);
  const target = msg.reply_to_message;
  if (!target || !mediaOf(target)) {
    return replyHTML(cfg, msg.chat.id, t(lang, usageKey), null, msg.message_id);
  }
  if (!cfg.canUse(msg.from?.id)) return replyHTML(cfg, msg.chat.id, t(lang, "forbidden"), null, msg.message_id);
  return handleIncomingFile(cfg, target, { ...opts, origin: opts.origin });
}

/** /del — revoke every link for a payload by deleting the channel message. */
async function revokePayload(cfg, raw, chatId, cardMsgId) {
  const v = await verifyPayload(cfg, raw);
  if (!v) return false;
  const token = primaryToken(cfg);
  await tg(token, "deleteMessage", { chat_id: v.data.c, message_id: v.data.m });

  // Instant revocation: purge every edge-cached metadata entry for this
  // payload (all token slots + the legacy alias + thumbnail + QR) so no
  // stream request can serve a stale copy.
  const cache = globalThis.caches?.default || null;
  if (cache) {
    const legacyRaw = `legacy-${v.data.m}`;
    const slots = Array.from({ length: Math.max(cfg.tokens.length, 1) }, (_, i) => i);
    await Promise.allSettled([
      ...slots.map((i) => cache.delete(new URL(`https://meta.internal/${i}/${raw}`))),
      ...slots.map((i) => cache.delete(new URL(`https://meta.internal/${i}/${legacyRaw}`))),
      cache.delete(new URL(`https://thumb.internal/${raw}`)),
      cache.delete(new URL(`https://qr.internal/${raw}`)),
    ]);
  }

  if (chatId && cardMsgId) await tg(token, "deleteMessage", { chat_id: chatId, message_id: cardMsgId });
  return true;
}

/* ---------------------------- command router ----------------------------- */

async function handleCommand(cfg, msg, origin) {
  const text = (msg.text || "").trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.replace(/@[\w_]+$/, "").toLowerCase();
  const arg = rest.join(" ");
  const chatId = msg.chat.id;
  const uid = msg.from?.id;

  switch (cmd) {
    case "/start": {
      if (arg) return resendByPayload(cfg, msg, arg, origin);
      const lang = await getUserLang(cfg, uid, msg.from);
      const un = cfg.botUsername || await getBotUsername(cfg);
      return replyHTML(cfg, chatId, [
        t(lang, "w_title", { bot: esc(cfg.brand) }),
        ``,
        t(lang, "w_body"),
        ``,
        un ? `📣 Add me to a channel as admin to auto-generate links for posts.` : ``,
      ].join("\n"), [
        [{ text: "➕ Add to Channel", url: `https://t.me/${un || "BotFather"}` }],
        [{ text: "📖 Commands", callback_data: "help" }, { text: "ℹ️ About", callback_data: "about" }],
      ], msg.message_id);
    }

    case "/help":
    case "/about": {
      const lang = await getUserLang(cfg, uid, msg.from);
      return replyHTML(cfg, chatId, t(lang, "help", {
        max: cfg.maxRemoteMb,
        langs: LANGS.join(" / "),
        bot: cfg.botUsername || "bot",
      }), null, msg.message_id);
    }

    case "/id":
      return replyHTML(cfg, chatId,
        `🆔 <b>Chat:</b> <code>${chatId}</code>\n👤 <b>User:</b> <code>${uid || "—"}</code>${msg.chat.type === "channel" ? `\n📣 <b>Channel id for BOT_CHANNEL/OWNER_IDS:</b> <code>${chatId}</code>` : ""}`,
        null, msg.message_id);

    case "/ping": {
      const t0 = Date.now();
      const me = await tg(primaryToken(cfg), "getMe");
      return replyHTML(cfg, chatId, `🏓 Pong! Telegram API round-trip: <b>${Date.now() - t0} ms</b>${me.ok ? "" : `\n⚠️ ${esc(me.description)}`}`, null, msg.message_id);
    }

    case "/stats": {
      if (!cfg.owners(uid)) return replyHTML(cfg, chatId, forbiddenCard(cfg), null, msg.message_id);
      const up = Math.floor((Date.now() - STATS.boot) / 1000);
      const upt = up > 86400 ? `${(up / 86400).toFixed(1)}d` : up > 3600 ? `${(up / 3600).toFixed(1)}h` : `${Math.floor(up / 60)}m`;
      return replyHTML(cfg, chatId, [
        `📊 <b>Service diagnostics</b>`,
        ``,
        `🏷 Version: <code>v${VERSION}</code>`,
        `⏱ Isolate uptime: <code>${upt}</code>`,
        `🤖 Bot tokens: <code>${cfg.tokens.length}</code> (round-robin + failover)`,
        `🗄 Storage channel: <code>${cfg.channel}</code>`,
        `🌐 Bot API: <code>${esc(cfg.botApiBase)}</code>`,
        `🔓 Public: <code>${cfg.publicBot}</code> · 🔍 Inline: <code>${cfg.enableInline}</code> · 🕰 Legacy: <code>${cfg.enableLegacy}</code>`,
        `🌍 Languages: <code>${LANGS.join(", ")}</code>`,
        `🛡 Force-sub: <code>${cfg.forceSub || "off"}</code> · Turnstile: <code>${cfg.tsSecret ? "on" : "off"}</code> · Rate: <code>${cfg.rateRpm || "off"}</code>/min`,
        ``,
        `📡 <b>This isolate:</b> ${STATS.req} web reqs · ${STATS.bot} bot updates · ${STATS.stream} streams · ${STATS.dl} downloads`,
        `⚡ Cache hits: ${STATS.cacheHits} · probes: ${STATS.probes} · bytes: ${fmtBytes(STATS.bytes)}`,
        `🧬 Database: <b>none</b> — stateless by design`,
      ].join("\n"), null, msg.message_id);

    }

    case "/upload": {
      if (!cfg.canUse(uid)) return replyHTML(cfg, chatId, forbiddenCard(cfg), null, msg.message_id);
      const lang = await getUserLang(cfg, uid, msg.from);
      // /upload <url> [url2 …] | custom-name.mp4 — batch (≤5) + optional rename.
      let nameOverride = null;
      let argPart = arg;
      if (argPart.includes("|")) {
        const [a, b] = argPart.split("|");
        argPart = a;
        nameOverride = b.trim();
      }
      const urls = argPart.split(/\s+/).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5);
      if (!urls.length) {
        return replyHTML(cfg, chatId, t(lang, "upload_usage", { max: cfg.maxRemoteMb }), null, msg.message_id);
      }
      let lastSent = null;
      for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        const shown = u.length > 80 ? u.slice(0, 80) + "…" : u;
        const wait = await replyHTML(cfg, chatId,
          t(lang, "upload_fetch", { url: esc(shown) }) + (urls.length > 1 ? `\n<i>${i + 1}/${urls.length}</i>` : ""), null, msg.message_id);
        try {
          const res = await fetch(u);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (buf.byteLength > cfg.maxRemoteMb * 1024 * 1024) throw new Error(`file too large (${fmtBytes(buf.byteLength)} > ${cfg.maxRemoteMb} MB)`);
          const urlObj = new URL(u);
          let fname = nameOverride || decodeURIComponent((urlObj.pathname.split("/").pop() || "").trim()) || "file.bin";
          const mime = res.headers.get("content-type")?.split(";")[0] || guessMime(fname, "d");
          const fd = new FormData();
          fd.append("chat_id", String(cfg.channel));
          fd.append("document", new Blob([buf], { type: mime }), fname);
          const saved = await tg(primaryToken(cfg), "sendDocument", {}, { method: "POST", body: fd });
          if (!saved.ok) throw new Error(saved.description || "upload to telegram failed");
          if (wait.ok) await tg(primaryToken(cfg), "deleteMessage", { chat_id: chatId, message_id: wait.result.message_id });
          lastSent = await handleIncomingFile(cfg, { chat: msg.chat, from: msg.from, message_id: wait.ok ? wait.result.message_id : msg.message_id, document: saved.result.document, photo: null, video: null }, { origin });
        } catch (e) {
          await replyHTML(cfg, chatId, t(lang, "upload_fail", { err: esc(e.message) }), null, msg.message_id);
        }
      }
      return lastSent || replyHTML(cfg, chatId, t(lang, "upload_fail", { err: "nothing uploaded" }), null, msg.message_id);
    }

    case "/ttl": {
      const lang = await getUserLang(cfg, uid, msg.from);
      const secs = parseTtl(arg);
      if (!secs) return replyHTML(cfg, chatId, t(lang, "ttl_usage"), null, msg.message_id);
      return regenerate(cfg, msg, { ttl: secs, origin }, "ttl_usage");
    }

    case "/pwd": {
      const lang = await getUserLang(cfg, uid, msg.from);
      const secret = arg.trim();
      if (!secret) return replyHTML(cfg, chatId, t(lang, "pwd_usage"), null, msg.message_id);
      return regenerate(cfg, msg, { password: secret, origin }, "pwd_usage");
    }

    case "/del": {
      if (!cfg.owners(uid)) return replyHTML(cfg, chatId, forbiddenCard(cfg), null, msg.message_id);
      const lang = await getUserLang(cfg, uid, msg.from);
      const raw = (arg.match(/#?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/) || [])[1];
      if (!raw) return replyHTML(cfg, chatId, t(lang, "del_usage"), null, msg.message_id);
      const ok = await revokePayload(cfg, raw, chatId, msg.message_id);
      return replyHTML(cfg, chatId, ok ? t(lang, "del_done") : `❌ Invalid payload.`, null, msg.message_id);
    }

    case "/lang": {
      const lang = await getUserLang(cfg, uid, msg.from);
      const want = arg.trim().toLowerCase();
      if (!want || !LANGS.includes(want)) {
        return replyHTML(cfg, chatId, t(lang, "lang_list", { langs: LANGS.map((l) => `${l} (${LANG_NAMES[l]})`).join(", ") }), null, msg.message_id);
      }
      await setUserLang(cfg, uid, want);
      return replyHTML(cfg, chatId, t(want, "lang_set", { lang: LANG_NAMES[want] }), null, msg.message_id);
    }

    case "/rename": {
      if (!cfg.canUse(uid)) return replyHTML(cfg, chatId, forbiddenCard(cfg), null, msg.message_id);
      const lang = await getUserLang(cfg, uid, msg.from);
      const newName = arg.trim().replace(/^["']|["']$/g, "").slice(0, 120);
      const target = msg.reply_to_message;
      const raw = target?.text ? (target.text.match(/#([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/) || [])[1] : null;
      if (!newName || !raw) return replyHTML(cfg, chatId, t(lang, "rename_usage"), null, msg.message_id);
      const v = await verifyPayload(cfg, raw);
      if (!v) return replyHTML(cfg, chatId, `❌ Invalid payload.`, null, msg.message_id);
      const fresh = await mintPayload(cfg, { ...v.data, name: newName });
      const meta = await resolveMeta(cfg, v.data, v.raw, 0, origin);
      const card = linkCard(cfg, { ...(meta || { kind: v.data.k, mime: "", size: 0 }), name: newName }, fresh, origin, { owner: cfg.owners(uid), lang });
      bumpStats("api");
      return replyHTML(cfg, chatId, [t(lang, "rename_done", { name: esc(newName) }), ``, card.text].join("\n"), card.keyboard, msg.message_id);
    }

    case "/gen": {
      if (!cfg.canUse(uid)) return replyHTML(cfg, chatId, forbiddenCard(cfg), null, msg.message_id);
      const lang = await getUserLang(cfg, uid, msg.from);
      // Reply-to-media shortcut → regular mint flow.
      if (msg.reply_to_message && mediaOf(msg.reply_to_message)) {
        return handleIncomingFile(cfg, msg.reply_to_message, { origin });
      }
      const tgt = parseTgLink(arg.trim());
      if (!tgt) return replyHTML(cfg, chatId, t(lang, "gen_usage"), null, msg.message_id);
      const copy = await tg(primaryToken(cfg), "copyMessage", {
        chat_id: cfg.channel, from_chat_id: tgt.chat, message_id: tgt.msg,
      });
      if (!copy.ok) {
        return replyHTML(cfg, chatId, t(lang, "gen_fail", { err: esc(copy.description || "unknown") }), null, msg.message_id);
      }
      const mid = copy.result.message_id;
      const probe = await resolveMeta(cfg, { c: cfg.channel, m: mid, k: "auto" }, `gen-${mid}`, 0, origin);
      if (!probe) return replyHTML(cfg, chatId, t(lang, "gen_fail", { err: "no media found" }), null, msg.message_id);
      const fresh = await mintPayload(cfg, { c: cfg.channel, m: mid, k: probe.kind });
      const card = linkCard(cfg, probe, fresh, origin, { owner: cfg.owners(uid), lang });
      bumpStats("api");
      return replyHTML(cfg, chatId, card.text, card.keyboard, msg.message_id);
    }

    case "/qr": {
      const lang = await getUserLang(cfg, uid, msg.from);
      if (!cfg.qrEnabled) return replyHTML(cfg, chatId, `❌ QR is disabled (ENABLE_QR=false).`, null, msg.message_id);
      const target = msg.reply_to_message;
      const raw = (arg.match(/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/) || [])[1]
        || (target?.text ? (target.text.match(/#([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/) || [])[1] : null);
      if (!raw) {
        return replyHTML(cfg, chatId, `🔳 Usage: reply to a link card with <code>/qr</code> — or <code>/qr &lt;payload&gt;</code>.`, null, msg.message_id);
      }
      return sendQrPhoto(cfg, chatId, `${origin}/watch/${raw}`, raw, msg.message_id);
    }

    case "/index": {
      const lang = await getUserLang(cfg, uid, msg.from);
      if (!cfg.indexEnabled) return replyHTML(cfg, chatId, `🗂 Catalog replies are off (INDEX_ENABLED=false).`, null, msg.message_id);
      const gc = await tg(primaryToken(cfg), "getChat", { chat_id: cfg.channel });
      const uname = gc.ok ? gc.result.username : null;
      const link = uname ? `https://t.me/${uname}` : (gc.ok && gc.result.invite_link) || null;
      return replyHTML(cfg, chatId, [
        `🗂 <b>The storage channel IS the catalog.</b>`,
        ``,
        `Every stored file gets a self-reply carrying its watch link — open the channel and use Telegram search by name. Zero database; Telegram search is the index.`,
        link ? `\n📣 ${esc(link)}` : ``,
        `\n<i>Disable with INDEX_ENABLED=false.</i>`,
      ].join("\n"), null, msg.message_id);
    }

    case "/version":
      return replyHTML(cfg, chatId, [
        `⚡ <b>${esc(cfg.brand)}</b> v${VERSION} "ULTRA"`,
        `🧬 zero database · pure edge · single file, zero dependencies`,
        `📦 binary signed links · 🔳 QR encoder · 🌍 8 languages · 📱 mini app`,
      ].join("\n"), null, msg.message_id);

    default: {
      const lang = await getUserLang(cfg, uid, msg.from);
      return replyHTML(cfg, chatId, t(lang, "unknown"), null, msg.message_id);
    }
  }
}

/** /start <payload|legacy-hash> → fetch & send the file into the chat. */
async function resendByPayload(cfg, msg, rawArg, origin) {
  const arg = rawArg.trim();
  let v = await verifyPayload(cfg, arg);
  if (!v && cfg.enableLegacy && /^\d+$/.test(legacyDeHashSafe(cfg, arg) || "")) {
    v = { data: { c: cfg.channel, m: parseInt(legacyDeHashSafe(cfg, arg), 10), k: "d" } };
  }
  if (!v) return replyHTML(cfg, msg.chat.id, `❌ Invalid or expired link payload.`, null, msg.message_id);
  if (payloadExpired(v.data)) return replyHTML(cfg, msg.chat.id, `⏳ This link expired (TTL). Ask for a fresh one.`, null, msg.message_id);

  const meta = await resolveMeta(cfg, v.data, v.raw || arg, 0, origin);
  if (!meta) return replyHTML(cfg, msg.chat.id, `❌ File not found (deleted from storage).`, null, msg.message_id);

  const token = primaryToken(cfg);
  const sendKind = KINDS[meta.kind].send;
  const method = sendKind === "photo" ? "sendPhoto" : "sendDocument";
  return tg(token, method, {
    chat_id: msg.chat.id,
    [sendKind]: meta.fileId,
    caption: `<b>${esc(meta.name)}</b>\n${fmtBytes(meta.size)} • via ${esc(cfg.brand)}`,
    parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: [[
      { text: "🎬 Watch", url: `${origin}/watch/${v.raw || arg}` },
      { text: "⚡ Stream", url: `${origin}/stream/${v.raw || arg}` },
    ]] }),
  });
}

function legacyDeHashSafe(cfg, hash) {
  try { return legacyDeHash(hash, cfg.legacySecret); } catch { return null; }
}

/** Parse t.me/c/<id>/<msg> or t.me/<user>/<msg> links. */
function parseTgLink(link) {
  let m = /(?:https?:\/\/)?t\.me\/c\/(\d+)\/(\d+)/i.exec(link);
  if (m) return { chat: Number(`-100${m[1]}`), msg: parseInt(m[2], 10) };
  m = /(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/i.exec(link);
  if (m) return { chat: `@${m[1]}`, msg: parseInt(m[2], 10) };
  return null;
}

/** Render a QR PNG and send it as a photo. */
async function sendQrPhoto(cfg, chatId, url, raw, replyTo) {
  const png = pngQrBytes(url, 8);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("photo", new Blob([png], { type: "image/png" }), "qr.png");
  fd.append("caption", `🔳 Scan to watch:\n${url}${raw ? `\n\npayload: #${raw}` : ""}`.slice(0, 1000));
  return tg(primaryToken(cfg), "sendPhoto", {}, { method: "POST", body: fd });
}

/* ------------------------------ callbacks -------------------------------- */

async function handleCallback(cfg, cb, origin) {
  const data = cb.data || "";
  const lang = await getUserLang(cfg, cb.from?.id, cb.from);
  if (data === "help" || data === "about") {
    return tg(primaryToken(cfg), "answerCallbackQuery", { callback_query_id: cb.id, text: "Send /help for the full command list." });
  }
  if (data.startsWith("qr:")) {
    if (!cfg.canUse(cb.from?.id)) {
      return tg(primaryToken(cfg), "answerCallbackQuery", { callback_query_id: cb.id, text: "Owner only.", show_alert: true });
    }
    const raw = data.slice(3);
    const chatId = cb.message?.chat?.id;
    if (chatId && cfg.qrEnabled) {
      await sendQrPhoto(cfg, chatId, `${origin}/watch/${raw}`, raw, cb.message?.message_id);
    }
    return tg(primaryToken(cfg), "answerCallbackQuery", { callback_query_id: cb.id });
  }
  if (data.startsWith("del:")) {
    if (!cfg.owners(cb.from?.id)) {
      return tg(primaryToken(cfg), "answerCallbackQuery", { callback_query_id: cb.id, text: "Owner only.", show_alert: true });
    }
    const [, raw, cardId] = data.split(":");
    const ok = await revokePayload(cfg, raw, cb.message?.chat?.id, cardId ? parseInt(cardId, 10) : null);
    return tg(primaryToken(cfg), "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: ok ? t(lang, "del_done").replace(/<[^>]+>/g, "") : "Invalid payload.",
      show_alert: true,
    });
  }
  return tg(primaryToken(cfg), "answerCallbackQuery", { callback_query_id: cb.id });
}

/* ------------------------------ inline mode ------------------------------ */

async function handleInline(cfg, iq, origin) {
  if (!cfg.enableInline) return;
  if (!cfg.canUse(iq.from?.id)) {
    return tg(primaryToken(cfg), "answerInlineQuery", {
      inline_query_id: iq.id, cache_time: 1,
      results: JSON.stringify([{
        type: "article", id: "1", title: "🚫 Access restricted",
        description: "Deploy your own instance from GitHub.",
        input_message_content: { message_text: esc(forbiddenCard(cfg)), parse_mode: "HTML" },
      }]),
    });
  }
  const q = (iq.query || "").trim();
  if (!q) return;

  let v = await verifyPayload(cfg, q);
  if (!v && cfg.enableLegacy) {
    const mid = legacyDeHashSafe(cfg, q);
    if (mid) v = { data: { c: cfg.channel, m: parseInt(mid, 10), k: "d" } };
  }
  if (!v) {
    return tg(primaryToken(cfg), "answerInlineQuery", {
      inline_query_id: iq.id, cache_time: 1,
      results: JSON.stringify([{
        type: "article", id: "1", title: "❓ Unknown payload",
        description: "Paste the payload from a link card (#abcdef.xyz).",
        input_message_content: { message_text: "❓ Unknown or invalid payload." },
      }]),
    });
  }

  const meta = await resolveMeta(cfg, v.data, v.raw || q, 0, origin);
  if (!meta) {
    return tg(primaryToken(cfg), "answerInlineQuery", {
      inline_query_id: iq.id, cache_time: 1,
      results: JSON.stringify([{
        type: "article", id: "1", title: "❌ File not found",
        description: "It may have been revoked.",
        input_message_content: { message_text: "❌ File not found (revoked?)." },
      }]),
    });
  }

  const isPhoto = meta.kind === "p";
  const result = isPhoto
    ? { type: "photo", id: "1", title: meta.name, photo_file_id: meta.fileId,
        caption: `<b>${esc(meta.name)}</b> • ${fmtBytes(meta.size)}`, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🎬 Watch in browser", url: `${origin}/watch/${v.raw || q}` }]] } }
    : { type: "document", id: "1", title: meta.name, document_file_id: meta.fileId, mime_type: meta.mime,
        caption: `<b>${esc(meta.name)}</b> • ${fmtBytes(meta.size)}`, parse_mode: "HTML",
        description: `${fmtBytes(meta.size)} • ${meta.mime}`,
        thumb_url: meta.thumb ? `${origin}/thumb/${v.raw || q}` : undefined,
        reply_markup: { inline_keyboard: [[{ text: "🎬 Watch in browser", url: `${origin}/watch/${v.raw || q}` }]] } };

  return tg(primaryToken(cfg), "answerInlineQuery", {
    inline_query_id: iq.id, cache_time: 1,
    results: JSON.stringify([result]),
  });
}

/* --------------------------- update dispatcher --------------------------- */

async function processUpdate(cfg, update, origin) {
  try {
    if (update.callback_query) return await handleCallback(cfg, update.callback_query, origin);
    if (update.inline_query) return await handleInline(cfg, update.inline_query, origin);

    const msg = update.message || update.channel_post;
    if (!msg) return;

    // Ignore echo messages produced by our own inline results.
    if (msg.via_bot) return;

    // Never re-process the storage channel itself.
    if (msg.chat && msg.chat.id === cfg.channel) return;

    if (msg.text && msg.text.startsWith("/")) return await handleCommand(cfg, msg, origin);

    const isFile = mediaOf(msg);
    if (!isFile) return;

    // Files in channels/groups where the bot is admin → auto link card.
    if (update.channel_post && !cfg.autoChannelLink) return;
    return await handleIncomingFile(cfg, msg, { origin });
  } catch (e) {
    console.error("update failed:", e && e.stack || e);
  }
}

/* ============================== WEB UI ==================================== */

const BASE_CSS = `
:root{--bg:#070a13;--card:rgba(255,255,255,.045);--line:rgba(255,255,255,.09);
--txt:#e8ecf8;--mut:#8b93ad;--ac:#7c5cff;--ac2:#22d3ee;--ok:#34d399;--err:#fb7185}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:var(--bg);color:var(--txt);min-height:100vh;line-height:1.55}
body::before{content:"";position:fixed;inset:0;z-index:-1;
background:radial-gradient(600px 400px at 15% 10%,rgba(124,92,255,.22),transparent 60%),
radial-gradient(700px 500px at 85% 20%,rgba(34,211,238,.14),transparent 60%),
radial-gradient(800px 600px at 50% 100%,rgba(124,92,255,.10),transparent 60%)}
.wrap{max-width:980px;margin:0 auto;padding:40px 20px 64px}
.badge{display:inline-flex;gap:8px;align-items:center;padding:6px 14px;border-radius:999px;
border:1px solid var(--line);background:var(--card);font-size:13px;color:var(--mut)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 12px var(--ok)}
h1{font-size:clamp(28px,5vw,44px);letter-spacing:-.02em;margin:18px 0 10px}
h1 .grad{background:linear-gradient(92deg,var(--ac),var(--ac2));-webkit-background-clip:text;
background-clip:text;color:transparent}
.sub{color:var(--mut);font-size:17px;max-width:640px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;
backdrop-filter:blur(12px)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:14px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:12px;
border:1px solid var(--line);background:var(--card);color:var(--txt);text-decoration:none;
font-weight:600;font-size:14px;transition:.18s;cursor:pointer}
.btn:hover{transform:translateY(-1px);border-color:rgba(124,92,255,.6)}
.btn.pri{background:linear-gradient(92deg,var(--ac),#5ea2ff);border:none;color:#fff}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:rgba(255,255,255,.06);
padding:2px 7px;border-radius:6px;word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:5px 12px;font-size:12.5px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td,th{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;color:var(--mut)}
td:first-child{color:var(--txt);font-family:ui-monospace,monospace;font-size:12.5px}
.foot{margin-top:44px;color:var(--mut);font-size:13px;text-align:center}
input{background:rgba(0,0,0,.35);border:1px solid var(--line);color:var(--txt);border-radius:12px;
padding:11px 14px;font-size:14px;outline:none;width:100%}
input:focus{border-color:var(--ac)}
.warn{border:1px solid rgba(251,113,133,.4);background:rgba(251,113,133,.08);border-radius:14px;
padding:14px 16px;font-size:14px;margin-bottom:18px}
video,img.thumb,audio{width:100%;border-radius:14px;background:#000;max-height:62vh}
.meta{color:var(--mut);font-size:13.5px;margin-top:10px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.copy{cursor:pointer;user-select:none}
`;

function pageShell(title, body, opts = {}) {
  const head = `
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
${opts.og || ""}
<style>${BASE_CSS}</style>`;
  return `<!doctype html><html lang="en"><head><title>${esc(title)}</title>${head}</head>
<body><div class="wrap">${body}
<div class="foot">⚡ TG FileStream PRO v${VERSION} — zero database, 100% Cloudflare edge · <a style="color:var(--mut)" href="https://github.com/ryoaonetsuki/telegram-file-stream">source</a></div>
</div></body></html>`;
}

function setupBanner(cfg) {
  if (cfg.ok) return "";
  return `<div class="warn">🚧 <b>Setup incomplete.</b> Missing variables: ${cfg.missing.map((m) => `<code>${m}</code>`).join(", ")}. See the README deploy guide — the bot endpoints won't work until these are set.</div>`;
}

function pageHome(cfg) {
  const feats = [
    ["⚡", "Instant links", "Send any file → stream & download URLs in one tap."],
    ["🎬", "Real streaming", "HTTP Range + 206 pass-through: video seeks instantly."],
    ["🧬", "Zero database", "The Telegram channel is the storage. Nothing else exists."],
    ["🔐", "HMAC-signed", "Links are self-describing and unforgeable (SHA-256)."],
    ["📦", "Binary links", "v3 payload format: varint + zigzag packing → ~45% shorter URLs, QR-ready."],
    ["🔳", "QR codes", "Pure-JS Model-2 encoder + raw PNG writer — no libraries, no network."],
    ["⏳", "Self-expiring", "/ttl 30m — links kill themselves at the timestamp baked into the signature."],
    ["🙊", "Password links", "/pwd — only an HMAC proof is stored, never the password."],
    ["✏️", "Rename", "/rename — a fresh signed link with any display name you like."],
    ["♻️", "Revocable", "Delete the channel message → every derived link dies instantly."],
    ["🤖", "Multi-token + failover", "Round-robin tokens, automatic failover mid-stream."],
    ["🌍", "8 languages", "Auto-detected from Telegram, /lang override, zero storage."],
    ["🛡️", "Hardened", "Turnstile gate, force-sub, rate limits, hotlink block, CSP."],
    ["📱", "Mini App", "In-Telegram dashboard, authenticated via initData HMAC."],
    ["📎", "Upload by URL", "/upload <url>… batch, with optional custom names."],
    ["🔗", "/gen anywhere", "Mint links from any t.me message the bot can read."],
    ["🖥️", "Watch + Embed", "HTML5 player page, oEmbed endpoint, iframe embeds."],
    ["🕰️", "Legacy safe", "Old ?file= links from the original bot keep working."],
  ];
  const rows = [
    ["/stream/{payload}", "Stream inline (Range-aware, Content-Disposition: inline) — /s/ alias"],
    ["/dl/{payload}", "Force download (attachment) — ?dl=1 also works on /stream"],
    ["/watch/{payload}", "HTML5 player page with QR + embed code — /w/ alias"],
    ["/e/{payload}", "Minimal embeddable player (iframe-ready, frame-ancestors: *)"],
    ["/thumb/{payload}", "Edge-cached thumbnail proxy"],
    ["/qr/{payload}", "QR code as SVG (edge-cached 1 h)"],
    ["/api/info/{payload}", "JSON metadata"],
    ["/api/oembed?url=…", "oEmbed JSON for a watch/stream URL"],
    ["/app", "Telegram Mini App dashboard (initData-verified)"],
    ["/healthz", "Health probe + live stats"],
  ];
  return pageShell(`${cfg.brand} — Telegram files, streamed from the edge`, `
  ${setupBanner(cfg)}
  <div class="badge"><span class="dot"></span> v${VERSION} · zero-database · edge-native</div>
  <h1>Turn Telegram files into <span class="grad">blazing streaming links</span></h1>
  <p class="sub">${esc(cfg.brand)} is a file-to-link bot running entirely on Cloudflare Workers.
  No server, no database, no egress bill — your files live in a Telegram channel and stream straight from the edge.</p>
  <div class="row">
    <a class="btn pri" href="https://t.me/${esc(cfg.botUsername || "BotFather")}">🤖 Open the bot</a>
    <a class="btn" href="${cfg.sourceUrl}">⭐ Source on GitHub</a>
  </div>

  <h1 style="font-size:24px;margin-top:40px">What's inside</h1>
  <div class="grid">${feats.map(([i, t, d]) => `
    <div class="card"><div style="font-size:26px">${i}</div>
    <div style="font-weight:700;margin:8px 0 4px">${t}</div>
    <div style="color:var(--mut);font-size:13.5px">${d}</div></div>`).join("")}
  </div>

  <h1 style="font-size:24px;margin-top:40px">HTTP API</h1>
  <div class="card"><table>
    <tr><th>Endpoint</th><th>Description</th></tr>
    ${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}
  </table>
  <p class="meta" style="margin-top:12px">Payload format: <code>b64url(JSON).sig</code> — HMAC-SHA256 verified per request. Supported media: video, documents, audio, photos, GIFs, voice & video notes.</p></div>

  <h1 style="font-size:24px;margin-top:40px">Inspect a link</h1>
  <div class="card">
    <input id="pl" placeholder="Paste a payload (abcdef123.XYZ…) and press Enter">
    <div id="out" class="meta"></div>
    <script>
    const pl=document.getElementById('pl'),out=document.getElementById('out');
    pl.addEventListener('keydown',async e=>{if(e.key!=='Enter')return;
      out.textContent='…';try{
      const r=await fetch('/api/info/'+encodeURIComponent(pl.value.trim()));
      const j=await r.json();
      if(!j.ok){out.innerHTML='❌ '+j.description;return}
      out.innerHTML='📄 <b>'+j.name+'</b> · '+j.size_human+' · '+j.mime+
        '<br>⚡ <a href="'+j.urls.stream+'">stream</a> · ⬇️ <a href="'+j.urls.download+'">download</a> · 🎬 <a href="'+j.urls.watch+'">watch</a>';
    }catch(err){out.textContent='Network error'}});</script>
  </div>`);
}

function watchPage(cfg, meta, raw, origin, data) {
  const k = KINDS[meta.kind] || KINDS.d;
  const isVideo = ["v", "g", "n"].includes(meta.kind);
  const isAudio = ["a", "o"].includes(meta.kind);
  const isImg = meta.kind === "p";
  const isPdf = meta.mime === "application/pdf";

  let player = "";
  if (isVideo) player = `<video controls preload="metadata" poster="/thumb/${raw}" src="/stream/${raw}"></video>`;
  else if (isAudio) player = `<audio controls preload="metadata" src="/stream/${raw}" style="width:100%;margin-top:8px"></audio><div style="font-size:64px;text-align:center">🎵</div>`;
  else if (isImg) player = `<img class="thumb" src="/stream/${raw}" alt="${esc(meta.name)}">`;
  else if (isPdf) player = `<iframe src="/stream/${raw}" style="width:100%;height:62vh;border:1px solid var(--line);border-radius:14px;background:#fff"></iframe>`;
  else player = `<div class="card" style="text-align:center;padding:48px 20px"><div style="font-size:64px">${k.icon}</div>
    <p style="color:var(--mut);margin-top:8px">This file type doesn't preview in browsers.</p></div>`;

  const og = `
<meta property="og:title" content="${esc(meta.name)}">
<meta property="og:site_name" content="${esc(cfg.brand)}">
<meta property="og:type" content="${isVideo ? "video.other" : isImg ? "image" : "website"}">
<meta property="og:image" content="${origin}/thumb/${raw}">
${isVideo ? `<meta property="og:video" content="${origin}/stream/${raw}">
<meta property="og:video:type" content="${esc(meta.mime)}">` : ""}
<meta name="twitter:card" content="player">`;

  const exp = data.e
    ? `<span class="chip">⏳ expires <span id="cd"></span></span><script>
const e=${data.e}*1000,d=document.getElementById('cd');
(function t(){const s=Math.max(0,Math.floor((e-Date.now())/1000));
d.textContent=s>86400?(s/86400).toFixed(1)+'d':s>3600?(s/3600).toFixed(1)+'h':s>60?(s/60).toFixed(0)+'m':s+'s';
if(s>0)setTimeout(t,1000)})();</script>`
    : "";

  return pageShell(meta.name, `
  <div class="card">
    ${player}
    <h1 style="font-size:20px;margin-top:16px;word-break:break-word">${k.icon} ${esc(meta.name)}</h1>
    <div class="chips">
      <span class="chip">📦 ${fmtBytes(meta.size)}</span>
      <span class="chip">🏷 ${esc(meta.mime)}</span>
      <span class="chip">${k.icon} ${k.label}</span>
      ${exp}
    </div>
    <div class="row">
      <a class="btn pri" href="/dl/${raw}">⬇️ Download</a>
      <a class="btn" href="/stream/${raw}">⚡ Raw stream</a>
      <a class="btn copy" onclick="navigator.clipboard.writeText(location.href);this.textContent='✅ Copied!'">🔗 Copy link</a>
      <a class="btn" href="https://t.me/share/url?url=${encodeURIComponent(`${origin}/watch/${raw}`)}&text=${encodeURIComponent(meta.name)}">📤 Share</a>
    </div>
    ${cfg.qrEnabled ? `
    <details style="margin-top:16px">
      <summary style="cursor:pointer;color:var(--mut)">🔳 QR code &amp; embed</summary>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:14px;align-items:center">
        <img src="/qr/${raw}" alt="QR code" width="180" height="180" loading="lazy"
             style="border-radius:12px;background:#fff;padding:8px;border:1px solid var(--line)">
        <div style="flex:1;min-width:240px">
          <div class="meta" style="margin-bottom:6px">Embed anywhere:</div>
          <input readonly value="${esc(`<iframe src=&quot;${origin}/e/${raw}&quot; width=&quot;640&quot; height=&quot;360&quot; frameborder=&quot;0&quot; allowfullscreen&gt;&lt;/iframe&gt;`)}" onclick="this.select()">
        </div>
      </div>
    </details>` : ""}
    <p class="meta">payload <code class="copy" onclick="navigator.clipboard.writeText('${raw}')">${raw}</code></p>
  </div>
  <script>/* player keyboard shortcuts: space, ←/→, f */
  document.addEventListener('keydown',e=>{
    const v=document.querySelector('video');if(!v)return;
    if(e.code==='Space'){e.preventDefault();v.paused?v.play():v.pause()}
    else if(e.key==='ArrowRight')v.currentTime+=5;
    else if(e.key==='ArrowLeft')v.currentTime-=5;
    else if(e.key==='f'){document.fullscreenElement?document.exitFullscreen():(v.requestFullscreen&&v.requestFullscreen())}
  });</script>`, { og });
}

/** Minimal chrome-less player for <iframe> embedding (/e/<payload>). */
function embedPage(cfg, meta, raw, origin) {
  const isVideo = ["v", "g", "n"].includes(meta.kind);
  const isAudio = ["a", "o"].includes(meta.kind);
  const isImg = meta.kind === "p";
  let player = "";
  if (isVideo) player = `<video controls playsinline preload="metadata" poster="/thumb/${raw}" src="/stream/${raw}" style="width:100%;border-radius:12px;background:#000;max-height:70vh"></video>`;
  else if (isAudio) player = `<audio controls preload="metadata" src="/stream/${raw}" style="width:100%"></audio>`;
  else if (isImg) player = `<img src="/stream/${raw}" style="width:100%;border-radius:12px" alt="${esc(meta.name)}">`;
  else player = `<div class="card" style="text-align:center;padding:32px 16px"><div style="font-size:44px">${(KINDS[meta.kind] || KINDS.d).icon}</div><p class="meta" style="margin-top:8px">${esc(meta.name)}</p></div>`;
  return pageShell(meta.name, `
  <div class="card" style="padding:12px">
    ${player}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px">
      <div style="font-size:14px;font-weight:600;word-break:break-word">${esc(meta.name)} <span style="color:var(--mut);font-weight:400">· ${fmtBytes(meta.size)}</span></div>
      <a class="btn" style="padding:6px 12px;font-size:12px" href="/dl/${raw}" target="_blank" rel="noopener">⬇️ Download</a>
    </div>
  </div>`, { og: `<meta property="og:title" content="${esc(meta.name)}">` });
}

/** Turnstile challenge page (only rendered when TURNSTILE keys are set). */
function captchaPage(cfg, raw) {
  return pageShell("Quick check", `
  <div class="card" style="max-width:420px;margin:10vh auto 0;text-align:center">
    <div style="font-size:48px">🛡️</div>
    <h1 style="font-size:20px;margin-top:8px">One quick check</h1>
    <p class="sub" style="margin:10px auto 16px">Verify you're human to unlock this stream. You won't be asked again for 24 h.</p>
    <form method="post" action="/gate">
      <input type="hidden" name="payload" value="${esc(raw)}">
      <div class="cf-turnstile" data-sitekey="${esc(cfg.tsSite)}" style="display:inline-block"></div>
      <div class="row" style="justify-content:center"><button class="btn pri" type="submit">Unlock →</button></div>
    </form>
  </div>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
}

/** Telegram Mini App dashboard — auth via initData HMAC, zero storage. */
function appPage(cfg) {
  return pageShell(`${cfg.brand} — dashboard`, `
  <div class="badge"><span class="dot"></span> Telegram Mini App · zero database · initData-HMAC auth</div>
  <h1 style="font-size:26px;margin-top:16px">📁 <span class="grad">Link dashboard</span></h1>
  <p class="sub">Paste a <b>t.me message link</b> (any chat the bot can read) or a <b>direct file URL</b> — get instant stream links.</p>
  <div class="card" style="margin-top:18px">
    <div class="meta" style="margin-bottom:8px">From a Telegram message</div>
    <input id="mlink" placeholder="https://t.me/c/2093847573/12">
    <div class="row"><button class="btn pri" onclick="go('link')">🔗 Generate</button></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="meta" style="margin-bottom:8px">From a direct URL (≤ ${cfg.maxRemoteMb} MB)</div>
    <input id="furl" placeholder="https://example.com/video.mp4">
    <div class="row"><button class="btn pri" onclick="go('url')">📎 Upload</button></div>
  </div>
  <div class="card" id="out" style="margin-top:14px;display:none"></div>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script>
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
  async function go(kind){
    const out=document.getElementById('out');
    out.style.display='block';
    out.innerHTML='⏳ working…';
    try{
      const body={init_data:(window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initData)||''};
      if(kind==='link')body.link=document.getElementById('mlink').value.trim();
      else body.url=document.getElementById('furl').value.trim();
      const r=await fetch('/api/app/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json();
      if(!j.ok){out.innerHTML='❌ '+esc(j.description||'failed');return}
      out.innerHTML='📄 <b>'+esc(j.name)+'</b> ('+esc(j.size_human)+')<br><br>'+
        '⚡ <a href="'+j.urls.stream+'">stream</a> · ⬇️ <a href="'+j.urls.download+'">download</a> · 🎬 <a href="'+j.urls.watch+'">watch</a>'+
        '<br><div class="meta" style="margin-top:8px">payload <code>'+esc(j.payload)+'</code></div>';
    }catch(e){out.innerHTML='❌ '+esc(e.message)}
  }
  </script>`);
}

/** oEmbed JSON (discovers web players, chat apps, forums). */
function oembedJson(cfg, meta, raw, origin) {
  const isVideo = ["v", "g", "n"].includes(meta.kind);
  return {
    version: "1.0",
    type: isVideo ? "video" : meta.kind === "p" ? "photo" : "link",
    title: meta.name,
    author_name: cfg.brand,
    provider_name: cfg.brand,
    ...(isVideo ? { html: `<iframe src="${origin}/e/${raw}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`, width: 640, height: 360 } : {}),
    thumbnail_url: `${origin}/thumb/${raw}`,
  };
}

/** Mini App backend: initData → user → mint links (message link or URL). */
async function handleAppGenerate(request, cfg, origin) {
  if (!cfg.appEnabled) return jsonResp({ ok: false, description: "mini app disabled" }, 404);
  if (!cfg.ok) return jsonResp({ ok: false, description: `missing: ${cfg.missing.join(", ")}` }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, description: "bad json" }, 400); }
  const user = await validateInitData(cfg, body.init_data);
  if (!user || !user.id) return jsonResp({ ok: false, description: "invalid Telegram initData — open this page via the bot menu" }, 401);
  if (!cfg.canUse(user.id)) return jsonResp({ ok: false, description: "access restricted" }, 403);

  if (body.url) {
    if (!/^https?:\/\//i.test(String(body.url))) return jsonResp({ ok: false, description: "bad url" }, 400);
    try {
      const res = await fetch(String(body.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > cfg.maxRemoteMb * 1024 * 1024) throw new Error(`file too large (${fmtBytes(buf.byteLength)} > ${cfg.maxRemoteMb} MB)`);
      const urlObj = new URL(String(body.url));
      const fname = decodeURIComponent((urlObj.pathname.split("/").pop() || "").trim()) || "file.bin";
      const mime = res.headers.get("content-type")?.split(";")[0] || guessMime(fname, "d");
      const fd = new FormData();
      fd.append("chat_id", String(cfg.channel));
      fd.append("document", new Blob([buf], { type: mime }), fname);
      const saved = await tg(primaryToken(cfg), "sendDocument", {}, { method: "POST", body: fd });
      if (!saved.ok) throw new Error(saved.description || "telegram failed");
      const media = mediaOf(saved.result);
      if (!media) return jsonResp({ ok: false, description: "telegram didn't accept the file" }, 502);
      const raw = await mintPayload(cfg, { c: cfg.channel, m: saved.result.message_id, k: media.kind });
      bumpStats("api");
      return jsonResp({
        ok: true, payload: raw,
        name: media.m.file_name || fname,
        size_human: fmtBytes(media.m.file_size),
        urls: buildLinks(origin, raw),
      });
    } catch (e) {
      return jsonResp({ ok: false, description: e.message }, 502);
    }
  }

  if (body.link) {
    const tgt = parseTgLink(String(body.link));
    if (!tgt) return jsonResp({ ok: false, description: "unrecognized t.me link" }, 400);
    const copy = await tg(primaryToken(cfg), "copyMessage", { chat_id: cfg.channel, from_chat_id: tgt.chat, message_id: tgt.msg });
    if (!copy.ok) return jsonResp({ ok: false, description: copy.description || "copy failed — can the bot read that chat?" }, 502);
    const mid = copy.result.message_id;
    const meta = await resolveMeta(cfg, { c: cfg.channel, m: mid, k: "auto" }, `gen-${mid}`, 0, origin);
    if (!meta) return jsonResp({ ok: false, description: "no media in that message" }, 404);
    const raw = await mintPayload(cfg, { c: cfg.channel, m: mid, k: meta.kind });
    bumpStats("api");
    return jsonResp({ ok: true, payload: raw, name: meta.name, size_human: fmtBytes(meta.size), urls: buildLinks(origin, raw) });
  }

  return jsonResp({ ok: false, description: "provide 'link' or 'url'" }, 400);
}

function pageUnlock(raw) {
  return pageShell("Password required", `
  <div class="card" style="max-width:440px;margin:8vh auto 0;text-align:center">
    <div style="font-size:56px">🙊</div>
    <h1 style="font-size:22px;margin-top:10px">This file is locked</h1>
    <p class="sub" style="margin:10px auto 18px">Enter the password the sender gave you.</p>
    <input id="k" type="password" placeholder="Password">
    <div class="row" style="justify-content:center">
      <button class="btn pri" onclick="go()">🔓 Unlock</button>
    </div>
  </div>
  <script>function go(){const k=document.getElementById('k').value;
    const u=new URL(location);u.searchParams.set('key',k);location=u}
    document.getElementById('k').addEventListener('keydown',e=>{if(e.key==='Enter')go()});</script>`);
}

function pageError(status, title, msg, isPassword = false) {
  const icons = { 403: "🙊", 404: "🛸", 410: "⏳", 500: "💥", 502: "📡" };
  return htmlResp(pageShell(`${status} · ${title}`, `
  <div class="card" style="max-width:520px;margin:10vh auto 0;text-align:center">
    <div style="font-size:56px">${icons[status] || "⚠️"}</div>
    <h1 style="font-size:24px;margin-top:10px">${esc(title)}</h1>
    <p class="sub" style="margin:12px auto">${msg}</p>
    <div class="row" style="justify-content:center"><a class="btn" href="/">🏠 Home</a></div>
  </div>`, {}), status);
}

/* ============================== ROUTER ==================================== */

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type, X-Telegram-Bot-Api-Secret-Token",
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

/** Baseline security headers for HTML responses (CSP configurable per page). */
function secHeaders(csp) {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": csp ||
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://telegram.org https://challenges.cloudflare.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'self' https://web.telegram.org",
  };
}

function htmlResp(html, status = 200, csp = null) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS, ...secHeaders(csp) },
  });
}

/** Register / unregister the webhook + bot commands. Guarded by ADMIN_KEY. */
async function registerWebhookOps(cfg, origin, unregister = false) {
  const r = await tg(primaryToken(cfg), "setWebhook", unregister ? { url: "" } : {
    url: `${origin}${cfg.webhookPath}`,
    secret_token: cfg.webhookSecret,
    allowed_updates: ["message", "edited_message", "channel_post", "callback_query", "inline_query"],
    max_connections: 100,
    drop_pending_updates: true,
  });
  if (r.ok && !unregister) {
    await tg(primaryToken(cfg), "setMyCommands", {
      commands: [
        { command: "start", description: "Start / resend a file by payload" },
        { command: "help", description: "How to use" },
        { command: "ttl", description: "Self-expiring link — reply to a file" },
        { command: "pwd", description: "Password-protect — reply to a file" },
        { command: "rename", description: "Rename a link — reply to its card" },
        { command: "qr", description: "QR code — reply to a link card" },
        { command: "upload", description: "Upload from URL — /upload <url>" },
        { command: "gen", description: "Mint links from any t.me message" },
        { command: "lang", description: "Change language — /lang <code>" },
        { command: "id", description: "Show chat & user ids" },
        { command: "ping", description: "Latency check" },
        { command: "stats", description: "Service diagnostics" },
      ],
    });
    if (cfg.appEnabled) {
      await tg(primaryToken(cfg), "setChatMenuButton", {
        menu_button: { type: "web_app", text: "📁 Dashboard", web_app: { url: `${origin}/app` } },
      });
    }
  }
  return r;
}

async function handleWebhook(request, cfg, ctx) {
  if (!cfg.ok) return jsonResp({ ok: false, missing: cfg.missing }, 500);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== cfg.webhookSecret) {
    return new Response("Unauthorized", { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response("Ok"); }
  const origin = new URL(request.url).origin;
  bumpStats("bot");
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(processUpdate(cfg, update, origin));
  } else {
    await processUpdate(cfg, update, origin); // test/dev fallback
  }
  return new Response("Ok");
}

/** Old links: /?file=<legacy-hash>&mode=inline|attachment → mint a fresh signed payload → 302. */
async function legacyRedirect(request, cfg, hash, mode) {
  if (!cfg.enableLegacy) return pageError(404, "Legacy links disabled", "This instance no longer accepts old-format hashes.");
  if (!cfg.ok) return pageError(500, "Not configured", `Missing variables: ${esc(cfg.missing.join(", "))}`);
  let mid;
  try { mid = legacyDeHash(hash, cfg.legacySecret); } catch {
    return pageError(404, "Invalid legacy hash", "This old-style hash could not be decoded.");
  }
  const origin = new URL(request.url).origin;
  const data = { c: cfg.channel, m: parseInt(mid, 10), k: "auto" };
  const meta = await resolveMeta(cfg, data, `legacy-${mid}`, 0, origin);
  if (!meta) return pageError(404, "File not found", "The original message is gone from the storage channel.");
  const payload = await signPayload(cfg, { c: cfg.channel, m: data.m, k: meta.kind });
  return Response.redirect(`${origin}/${mode === "inline" ? "stream" : "dl"}/${payload}`, 302);
}

async function handleFetch(request, env, ctx) {
  const cfg = buildConfig(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const origin = url.origin;
  const seg = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  bumpStats("req");

  try {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (path === cfg.webhookPath) {
      if (method !== "POST") return jsonResp({ ok: false, description: "POST only" }, 405);
      return handleWebhook(request, cfg, ctx);
    }

    switch (true) {
      case path === "/robots.txt":
        return new Response("User-agent: *\nAllow: /\nDisallow: /stream/\nDisallow: /dl/\n", { headers: { "content-type": "text/plain" } });

      case path === "/favicon.ico":
        return new Response(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>`, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        });

      case path === "/healthz": {
        const me = cfg.ok ? await tg(primaryToken(cfg), "getMe").catch(() => null) : null;
        return jsonResp({
          ok: true, configured: cfg.ok, missing: cfg.missing,
          service: "tg-file-stream-pro", version: VERSION,
          tokens: cfg.tokens.length,
          username: me && me.ok ? me.result.username : cfg.botUsername || null,
          colo: request.cf?.colo || null, ts: Date.now(),
          uptime_sec: Math.floor((Date.now() - STATS.boot) / 1000),
          stats: { req: STATS.req, bot: STATS.bot, streams: STATS.stream, cache_hits: STATS.cacheHits, bytes: STATS.bytes },
          features: {
            qr: cfg.qrEnabled, i18n: LANGS.length, mini_app: cfg.appEnabled,
            force_sub: !!cfg.forceSub, turnstile: !!cfg.tsSecret,
            rate_limit: cfg.rateRpm || null, hotlink: cfg.allowedReferrers.length || null,
          },
        });
      }

      case path === "/registerWebhook" || path === "/unregisterWebhook": {
        const key = url.searchParams.get("key") || request.headers.get("x-admin-key");
        if (!cfg.ok) return jsonResp({ ok: false, missing: cfg.missing }, 500);
        if (!cfg.adminKey || key !== cfg.adminKey) return jsonResp({ ok: false, description: "Unauthorized — pass ?key=<ADMIN_KEY>" }, 403);
        const r = await registerWebhookOps(cfg, origin, path === "/unregisterWebhook");
        return jsonResp({ ok: r.ok, description: r.description || "done", webhook: `${origin}${cfg.webhookPath}` }, r.ok ? 200 : 502);
      }

      case path === "/": {
        const legacyHash = url.searchParams.get("file");
        if (legacyHash) return legacyRedirect(request, cfg, legacyHash, url.searchParams.get("mode"));
        return htmlResp(pageHome(cfg));
      }

      case (seg[0] === "stream" || seg[0] === "dl" || seg[0] === "file" || seg[0] === "s") && !!seg[1]: {
        if (!cfg.ok) return pageError(500, "Not configured", `Missing variables: ${esc(cfg.missing.join(", "))}`);
        bumpStats(seg[0] === "dl" ? "dl" : "stream");
        if (!referrerOk(cfg, request)) return pageError(403, "Hotlink blocked", "This server only allows embedded playback from approved domains (ALLOWED_REFERRERS).");
        if (!rateLimit(cfg, request)) return pageError(429, "Slow down", "Rate limit exceeded — try again in a minute.");
        const v = await verifyPayload(cfg, seg[1]);
        if (!v) return pageError(404, "Invalid link", "This link's signature failed verification — it's forged, corrupted, or from another instance.");
        if (cfg.tsSecret && !(await gateCookieOk(cfg, request))) {
          return Response.redirect(`${origin}/watch/${v.raw}`, 302);
        }
        const mode = seg[0] === "dl" || url.searchParams.get("dl") ? "attachment" : "inline";
        return handleFileBytes(request, cfg, v.data, v.raw, mode);
      }

      case seg[0] === "thumb" && !!seg[1]: {
        if (!cfg.ok) return pageError(500, "Not configured", `Missing: ${esc(cfg.missing.join(", "))}`);
        if (!referrerOk(cfg, request)) return pageError(403, "Hotlink blocked", "Not allowed from this referrer.");
        const v = await verifyPayload(cfg, seg[1]);
        if (!v) return pageError(404, "Invalid link", "Signature verification failed.");
        return handleThumb(request, cfg, v.data, v.raw);
      }

      case (seg[0] === "watch" || seg[0] === "w") && !!seg[1]: {
        if (!cfg.ok) return pageError(500, "Not configured", `Missing: ${esc(cfg.missing.join(", "))}`);
        bumpStats("watch");
        if (!rateLimit(cfg, request)) return pageError(429, "Slow down", "Rate limit exceeded — try again in a minute.");
        const v = await verifyPayload(cfg, seg[1]);
        if (!v) return pageError(404, "Invalid link", "Signature verification failed.");
        if (payloadExpired(v.data)) return pageError(410, "Link expired", "This link carried a TTL and has self-destructed.");
        if (cfg.tsSecret && !(await gateCookieOk(cfg, request))) return htmlResp(captchaPage(cfg, v.raw), 403);
        const pw = await guardQuery(cfg, request, v.data);
        if (!pw.ok) return htmlResp(pageUnlock(v.raw), 403);
        const meta = await resolveMeta(cfg, v.data, v.raw, 0, origin);
        if (!meta) return pageError(404, "File not found", "The underlying Telegram message was deleted — all links for it are dead.");
        if (v.data.name) meta.name = String(v.data.name);
        return htmlResp(watchPage(cfg, meta, v.raw, origin, v.data));
      }

      case (seg[0] === "e" || seg[0] === "embed") && !!seg[1]: {
        if (!cfg.ok) return pageError(500, "Not configured", `Missing: ${esc(cfg.missing.join(", "))}`);
        const v = await verifyPayload(cfg, seg[1]);
        if (!v) return pageError(404, "Invalid link", "Signature verification failed.");
        if (payloadExpired(v.data)) return pageError(410, "Link expired", "This link carried a TTL and has self-destructed.");
        const pw = await guardQuery(cfg, request, v.data);
        if (!pw.ok) return htmlResp(pageUnlock(v.raw), 403);
        const meta = await resolveMeta(cfg, v.data, v.raw, 0, origin);
        if (!meta) return pageError(404, "File not found", "The underlying Telegram message was deleted.");
        if (v.data.name) meta.name = String(v.data.name);
        return htmlResp(embedPage(cfg, meta, v.raw, origin), 200,
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-ancestors *");
      }

      case seg[0] === "qr" && !!seg[1]: {
        const cache = globalThis.caches?.default || null;
        const cacheKey = new URL(`https://qr.internal/${seg[1]}`);
        if (cache) {
          const hit = await cache.match(cacheKey).catch(() => null);
          if (hit) { bumpStats("cacheHits"); return hit; }
        }
        let svg;
        try { svg = svgQr(`${origin}/watch/${seg[1]}`); } catch (e) {
          return pageError(400, "QR failed", esc(e.message));
        }
        const res = new Response(svg, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600", ...CORS_HEADERS },
        });
        if (cache) { try { await cache.put(cacheKey, res.clone()); } catch { /* ignore */ } }
        return res;
      }

      case path === "/gate" && method === "POST": {
        if (!cfg.tsSecret) return pageError(404, "Not enabled", "Turnstile is not configured on this instance.");
        const form = await request.formData().catch(() => null);
        const payload = form?.get("payload");
        const cfToken = form?.get("cf-turnstile-response");
        const ip = request.headers.get("cf-connecting-ip");
        const v = payload ? await verifyPayload(cfg, String(payload)) : null;
        if (!v) return pageError(404, "Invalid link", "Unknown payload.");
        const ok = cfToken ? await turnstileVerify(cfg, String(cfToken), ip) : false;
        if (!ok) return htmlResp(captchaPage(cfg, v.raw), 403);
        const cookie = await signGateCookie(cfg, 86400);
        return new Response(null, {
          status: 302,
          headers: {
            location: `${origin}/watch/${v.raw}`,
            "set-cookie": `${GATE_COOKIE}=${cookie}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Lax`,
          },
        });
      }

      case path === "/app":
        if (!cfg.appEnabled) return pageError(404, "Disabled", "Mini App is disabled (ENABLE_MINI_APP=false).");
        return htmlResp(appPage(cfg));

      case path === "/api/app/generate" && method === "POST":
        return handleAppGenerate(request, cfg, origin);

      case seg[0] === "api" && seg[1] === "oembed": {
        const target = url.searchParams.get("url") || "";
        const m = /\/(?:watch|w|s|e)\/([A-Za-z0-9_.-]+)/.exec(target);
        if (!m) return jsonResp({ ok: false, description: "pass ?url=<watch or stream url>" }, 400);
        const v = await verifyPayload(cfg, m[1]);
        if (!v) return jsonResp({ ok: false, description: "invalid payload" }, 404);
        const meta = await resolveMeta(cfg, v.data, v.raw, 0, origin);
        if (!meta) return jsonResp({ ok: false, description: "file not found" }, 404);
        if (v.data.name) meta.name = String(v.data.name);
        bumpStats("api");
        return jsonResp(oembedJson(cfg, meta, v.raw, origin));
      }

      case seg[0] === "api" && seg[1] === "info" && !!seg[2]: {
        bumpStats("api");
        const v = await verifyPayload(cfg, seg[2]);
        if (!v) return jsonResp({ ok: false, description: "invalid payload (signature mismatch)" }, 404);
        if (payloadExpired(v.data)) return jsonResp({ ok: false, description: "link expired" }, 410);
        const pw = await guardQuery(cfg, request, v.data);
        if (!pw.ok) return jsonResp({ ok: false, description: "password required (?key=)" }, 403);
        const meta = await resolveMeta(cfg, v.data, v.raw, 0, origin);
        if (!meta) return jsonResp({ ok: false, description: "file not found (revoked?)" }, 404);
        if (v.data.name) meta.name = String(v.data.name);
        const L = buildLinks(origin, v.raw);
        return jsonResp({
          ok: true, name: meta.name, size: meta.size, size_human: fmtBytes(meta.size),
          mime: meta.mime, kind: meta.kind, kind_label: (KINDS[meta.kind] || KINDS.d).label,
          expiry: v.data.e || null, password_protected: !!v.data.q,
          renamed: !!v.data.name,
          urls: { stream: L.stream, download: L.dl, watch: L.watch, thumb: L.thumb, embed: `${origin}/e/${v.raw}`, qr: `${origin}/qr/${v.raw}` },
          service: "tg-file-stream-pro", version: VERSION,
        });
      }

      default:
        return pageError(404, "Page not found", `No route for <code>${esc(path)}</code>.`);
    }
  } catch (e) {
    console.error(e);
    return pageError(500, "Worker error", `<code>${esc(e && e.message || "unknown")}</code>`);
  }
}

export default {
  fetch: (request, env, ctx) => handleFetch(request, env, ctx),
};

/* Named exports for tests / integrations. */
export {
  buildConfig, signPayload, verifyPayload, passwordProof, legacyDeHash,
  mintPayload, decodeBinaryPayload, buildLinks, mediaOf, handleFetch,
  processUpdate, extractMeta, resolveMeta, qrMatrix, svgQr, pngQrBytes,
  validateInitData, signGateCookie, gateCookieOk, rateLimit, referrerOk,
  parseTgLink, detectLang, t, I18N, LANGS, STATS,
};
