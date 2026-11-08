/**
 * TG FileStream PRO v3 "ULTRA" — offline test harness.
 * Mocks the Telegram Bot API + Cache API in pure Node (no deps) and exercises
 * the real worker end-to-end: upload → link card → stream/dl/watch/embed/api,
 * Range/206/HEAD, TTL, password, binary v3 payloads, QR codes, i18n,
 * force-sub, hotlink + rate-limit guards, token failover, /rename, /gen,
 * Mini App initData verification, upload-by-URL (batch), revocation, legacy.
 *
 * Run: node test/worker.test.mjs
 */
import assert from "node:assert/strict";
import zlib from "node:zlib";
import crypto from "node:crypto";
import worker, {
  buildConfig, signPayload, passwordProof, legacyDeHash,
  mintPayload, verifyPayload, qrMatrix, pngQrBytes, svgQr,
  validateInitData, signGateCookie, gateCookieOk,
} from "../worker.js";

/* ------------------------------ mock Telegram ---------------------------- */

const CHANNEL = -1001111111111;
const FILE_SIZE = 1000;
const fileBytes = () => new Uint8Array(FILE_SIZE).map((_, i) => i % 256);

const state = {
  seq: 100,
  channelMsgs: new Map(),   // message_id -> message
  srcMsgs: new Map(),       // message_id -> message (for copyMessage)
  knownFileIds: new Map(),  // file_id -> media metadata
  calls: [],                // {method, params}
  deleted: [],
  memberStatus: "member",   // for getChatMember
  failGetFileFor: null,     // Set of tokens that fail getFile
};

state.knownFileIds.set("doc1", {
  file_id: "doc1", file_unique_id: "u-doc1", file_name: "video.mp4",
  mime_type: "video/mp4", file_size: FILE_SIZE,
});

function mediaFromValue(v) {
  if (typeof v === "string") return state.knownFileIds.get(v) || {
    file_id: v, file_unique_id: "u-" + v, file_name: `file_${v}.bin`,
    mime_type: "application/octet-stream", file_size: FILE_SIZE,
  };
  const id = "up-" + (++state.seq);
  const meta = {
    file_id: id, file_unique_id: "u" + id, file_name: v.name || "file.bin",
    mime_type: v.type || "application/octet-stream", file_size: v.size || FILE_SIZE,
  };
  state.knownFileIds.set(id, meta);
  return meta;
}

function handleTg(token, method, params) {
  state.calls.push({ method, params, token });
  const msg = (media) => ({ message_id: ++state.seq, chat: { id: CHANNEL }, ...media });

  switch (method) {
    case "getMe":
      return { ok: true, result: { id: 1, is_bot: true, first_name: "FS", username: "testbot" } };
    case "sendDocument": {
      const media = { document: mediaFromValue(params.document) };
      const m = msg(media);
      state.channelMsgs.set(m.message_id, m);
      return { ok: true, result: m };
    }
    case "sendPhoto": {
      const media = { photo: [mediaFromValue(params.photo)] };
      const m = msg(media);
      state.channelMsgs.set(m.message_id, m);
      return { ok: true, result: m };
    }
    case "copyMessage": {
      const src = state.srcMsgs.get(params.message_id);
      if (!src) return { ok: false, error_code: 400, description: "Bad Request: message not found" };
      const copy = JSON.parse(JSON.stringify(src));
      copy.message_id = ++state.seq;
      copy.chat = { id: CHANNEL };
      state.channelMsgs.set(copy.message_id, copy);
      return { ok: true, result: { message_id: copy.message_id } };
    }
    case "getChatMember":
      return { ok: true, result: { user: { id: params.user_id }, status: state.memberStatus, is_member: state.memberStatus === "restricted" } };
    case "getChat":
      return { ok: true, result: { id: params.chat_id, username: "catalog", invite_link: "https://t.me/joinchat/xyz" } };
    case "editMessageReplyMarkup": {
      const m = state.channelMsgs.get(params.message_id);
      if (!m) return { ok: false, error_code: 400, description: "Bad Request: message to edit not found" };
      return { ok: true, result: m };
    }
    case "deleteMessage": {
      state.deleted.push({ chat: params.chat_id, id: params.message_id });
      state.channelMsgs.delete(params.message_id);
      return { ok: true, result: true };
    }
    case "sendMessage":
      return { ok: true, result: { message_id: ++state.seq, chat: { id: params.chat_id }, text: params.text } };
    case "getFile":
      if (state.failGetFileFor?.has(token)) {
        return { ok: false, error_code: 400, description: "Bad Request: wrong remote file_id" };
      }
      return { ok: true, result: { file_id: params.file_id, file_path: `documents/${String(params.file_id).replace(/[^a-z0-9_-]/gi, "_")}.bin` } };
    case "setWebhook": case "setMyCommands": case "answerInlineQuery":
    case "answerCallbackQuery": case "deleteWebhook": case "setChatMenuButton":
      return { ok: true, result: true };
    default:
      return { ok: true, result: true };
  }
}

/* ------------------------------ mock fetch ------------------------------- */

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = init?.headers || {};

  if (url.startsWith("https://api.telegram.org/bot")) {
    const m = url.match(/\/bot([^/]+)\/(\w+)/);
    let params = {};
    if (init?.body) {
      if (init.body instanceof FormData) {
        for (const [k, v] of init.body.entries()) params[k] = typeof v === "string" ? v : v;
      } else if (typeof init.body === "string") params = JSON.parse(init.body);
    }
    return new Response(JSON.stringify(handleTg(m[1], m[2], params)),
      { headers: { "content-type": "application/json" } });
  }

  if (url.startsWith("https://api.telegram.org/file/bot")) {
    const range = headers["Range"] || (init?.headers instanceof Headers && init.headers.get("Range")) || null;
    const bytes = fileBytes();
    if (range) {
      const mm = /bytes=(\d+)-(\d+)?/.exec(range);
      const start = parseInt(mm[1], 10);
      const end = mm[2] ? parseInt(mm[2], 10) : bytes.length - 1;
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(FILE_SIZE) },
    });
  }

  if (url.startsWith("https://remote.example/")) {
    if (init?.method === "HEAD" || input?.method === "HEAD")
      return new Response(null, { status: 200, headers: { "content-length": "2000", "content-type": "video/mp4" } });
    const body = new Uint8Array(2000).map((_, i) => i % 7);
    return new Response(body, { status: 200, headers: { "content-type": "video/mp4" } });
  }

  if (url.startsWith("https://challenges.cloudflare.com/")) {
    return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
  }

  return new Response("mock 404", { status: 404 });
};

/* ------------------------------ mock caches ------------------------------ */

const cacheStore = new Map();
globalThis.caches = {
  default: {
    match: async (req) => {
      const text = cacheStore.get(String(req));
      return text === undefined ? undefined : new Response(text);
    },
    put: async (req, res) => cacheStore.set(String(req), await res.text()),
    delete: async (req) => cacheStore.delete(String(req)),
  },
};

/* --------------------------------- helpers ------------------------------- */

const env = {
  BOT_TOKENS: "123:AAA,456:BBB",
  BOT_CHANNEL: String(CHANNEL),
  OWNER_IDS: "777",
  LINK_SECRET: "test-link-secret",
  WEBHOOK_SECRET: "whsec",
  ADMIN_KEY: "adminkey",
  BOT_USERNAME: "testbot",
  PUBLIC_BOT: "false",
};

const BASE = "https://pro.example";
const cfg = buildConfig(env);

function req(path, init = {}) {
  return new Request(BASE + path, init);
}
async function hit(path, init) {
  return worker.fetch(req(path, init), env, {});
}
async function webhook(update) {
  return worker.fetch(req("/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "whsec", "content-type": "application/json" },
    body: JSON.stringify(update),
  }), env, {}); // no waitUntil → processUpdate runs inline → deterministic
}
async function webhookEnv(envX, update) {
  return worker.fetch(req("/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "whsec", "content-type": "application/json" },
    body: JSON.stringify(update),
  }), envX, {});
}
const lastCall = (method) => [...state.calls].reverse().find((c) => c.method === method);
function payloadFromCard(cardText) {
  const all = [...String(cardText).matchAll(/#([A-Za-z0-9_-]{16,})/g)].map((m) => m[1]);
  assert.ok(all.length, "card contains payload");
  return all[all.length - 1];
}
function seedChannelMsg(mid, docFileId = "doc1") {
  state.channelMsgs.set(mid, { message_id: mid, document: state.knownFileIds.get(docFileId) });
}
let testsRun = 0;
const t = async (name, fn) => { testsRun++; await fn(); console.log("  ✓", name); };

/* --------------------------------- tests --------------------------------- */

console.log("TG FileStream PRO v3 ULTRA — offline test suite\n");

/* ---------- config & payloads ---------- */

await t("config: missing-var detection", async () => {
  const bad = buildConfig({});
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("BOT_TOKEN (or BOT_TOKENS)"));
});

await t("payload: v2 JSON sign → verify round-trip", async () => {
  const p = await signPayload(cfg, { c: CHANNEL, m: 42, k: "v" });
  const v = await verifyPayload(cfg, p);
  assert.equal(v.data.m, 42);
  assert.equal(v.data.k, "v");
});

await t("payload: v3 binary round-trip incl. 53-bit chat id + name + ttl + pwd", async () => {
  const proof = await passwordProof(cfg, "pw123");
  const data = { c: -1003333333333, m: 123456789, k: "d", e: 1900000000, q: proof, name: "résumé 文件.pdf" };
  const p = await mintPayload(cfg, data);
  const v = await verifyPayload(cfg, p);
  assert.ok(v, "binary payload verifies");
  assert.equal(v.data.c, -1003333333333);
  assert.equal(v.data.m, 123456789);
  assert.equal(v.data.k, "d");
  assert.equal(v.data.e, 1900000000);
  assert.equal(v.data.name, "résumé 文件.pdf");
  assert.equal(v.data.q, proof);
});

await t("payload: v3 binary is ~45% shorter than v2 JSON", async () => {
  const jsonP = await signPayload(cfg, { c: CHANNEL, m: 42, k: "v" });
  const binP = await mintPayload(cfg, { c: CHANNEL, m: 42, k: "v" });
  assert.ok(binP.length < jsonP.length * 0.75, `bin ${binP.length} vs json ${jsonP.length}`);
});

await t("payload: v2 tampering is rejected", async () => {
  const p = await signPayload(cfg, { c: CHANNEL, m: 42, k: "v" });
  const evil = p.replace(/(.{4})./, "$1A");
  assert.equal(await verifyPayload(cfg, evil), null);
});

await t("payload: v3 tampering is rejected", async () => {
  const p = await mintPayload(cfg, { c: CHANNEL, m: 42, k: "d" });
  const evil = p.slice(0, 5) + (p[5] === "A" ? "B" : "A") + p.slice(6);
  assert.equal(await verifyPayload(cfg, evil), null);
});

await t("payload: cross-secret forgery is rejected", async () => {
  const other = buildConfig({ ...env, LINK_SECRET: "other-secret" });
  const p = await mintPayload(other, { c: CHANNEL, m: 1, k: "d" });
  assert.equal(await verifyPayload(cfg, p), null);
});

await t("legacy: old filestream-cf hash decodes", async () => {
  const SECRET = "test-link-secret";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let salt = ""; for (let i = 0; i < 16; i++) salt += chars[Math.floor(Math.random() * chars.length)];
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (SECRET.charCodeAt(i % SECRET.length) + salt.charCodeAt(i % salt.length)) % 256;
  for (let j = 0; j < 1000; j++)
    for (let i = 0; i < 32; i++)
      key[i] = (key[i] + SECRET.charCodeAt(i % SECRET.length) + salt.charCodeAt(i % salt.length)) % 256;
  const text = "4242";
  let encoded = ""; for (let i = 0; i < text.length; i++) encoded += String.fromCharCode(text.charCodeAt(i) ^ key[i % key.length]);
  const input = salt + encoded;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "", buffer = 0, bitsLeft = 0;
  for (let i = 0; i < input.length; i++) { buffer = (buffer << 8) | input.charCodeAt(i); bitsLeft += 8;
    while (bitsLeft >= 5) { out += alphabet[(buffer >> (bitsLeft - 5)) & 31]; bitsLeft -= 5; } }
  if (bitsLeft > 0) out += alphabet[(buffer << (5 - bitsLeft)) & 31];

  assert.equal(legacyDeHash(out, SECRET), "4242");
});

/* ---------- webhook & bot ---------- */

await t("webhook: wrong secret rejected", async () => {
  const res = await worker.fetch(req("/webhook", { method: "POST", body: "{}" }), env, {});
  assert.equal(res.status, 403);
});

let payload;
await t("bot: owner sends file → v3 link card", async () => {
  const res = await webhook({
    message: {
      chat: { id: 777, type: "private" }, message_id: 1, from: { id: 777 },
      video: { ...state.knownFileIds.get("doc1"), thumbnail: { file_id: "thumb1" } },
    },
  });
  assert.equal(await res.text(), "Ok");
  const card = lastCall("sendMessage");
  payload = payloadFromCard(card.params.text);
  assert.match(card.params.text, /Link ready/);
  assert.match(card.params.text, /video\.mp4/);
  assert.ok(!payload.includes("."), "new links are v3 binary (no dot)");
});

await t("bot: storage channel gets a catalog self-reply (zero-DB index)", async () => {
  const cat = state.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === CHANNEL);
  assert.ok(cat.length > 0, "catalog reply sent to channel");
  assert.match(cat[cat.length - 1].params.text, /🗂/);
  assert.match(cat[cat.length - 1].params.text, new RegExp(payload.slice(-12)));
});

await t("bot: non-owner gets forbidden card", async () => {
  await webhook({ message: { chat: { id: 999, type: "private" }, message_id: 2, from: { id: 999 }, document: state.knownFileIds.get("doc1") } });
  const card = lastCall("sendMessage");
  assert.match(card.params.text, /Access restricted/);
});

/* ---------- streaming ---------- */

await t("stream: 200 with correct bytes + headers", async () => {
  const res = await hit(`/stream/${payload}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.match(res.headers.get("content-disposition"), /inline/);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body.length, FILE_SIZE);
  assert.equal(body[10], 10);
});

await t("stream: Range → 206 partial content", async () => {
  const res = await hit(`/stream/${payload}`, { headers: { Range: "bytes=100-199" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 100-199/1000");
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(body.length, 100);
  assert.equal(body[0], 100);
});

await t("stream: HEAD returns headers only", async () => {
  const res = await hit(`/stream/${payload}`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(FILE_SIZE));
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

await t("stream: If-None-Match → 304", async () => {
  const first = await hit(`/stream/${payload}`);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const res = await hit(`/stream/${payload}`, { headers: { "If-None-Match": etag } });
  assert.equal(res.status, 304);
});

await t("dl: forces attachment disposition", async () => {
  const res = await hit(`/dl/${payload}`);
  assert.match(res.headers.get("content-disposition"), /attachment/);
});

await t("stream: ?dl=1 forces attachment", async () => {
  const res = await hit(`/stream/${payload}?dl=1`);
  assert.match(res.headers.get("content-disposition"), /attachment/);
});

await t("stream: forged payload → 404", async () => {
  const evil = payload.slice(0, -2) + "AA";
  const res = await hit(`/stream/${evil}`);
  assert.equal(res.status, 404);
});

await t("aliases: /s/ and /w/ serve like stream/watch", async () => {
  const s = await hit(`/s/${payload}`);
  assert.equal(s.status, 200);
  const w = await hit(`/w/${payload}`);
  assert.equal(w.status, 200);
  assert.match(await w.text(), /<video[^>]+poster="\/thumb\//);
});

/* ---------- pages & api ---------- */

await t("watch: player page renders", async () => {
  const res = await hit(`/watch/${payload}`);
  const html = await res.text();
  assert.match(html, /<video[^>]+poster="\/thumb\//);
  assert.match(html, /video\.mp4/);
  assert.match(html, /og:video/);
  assert.match(html, /\/qr\//);
  assert.match(html, /ArrowRight/);
});

await t("embed: /e/ minimal iframe player", async () => {
  const res = await hit(`/e/${payload}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<video/);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors \*/);
});

await t("api/info: JSON metadata with embed + qr urls", async () => {
  const res = await hit(`/api/info/${payload}`);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.name, "video.mp4");
  assert.equal(j.mime, "video/mp4");
  assert.equal(j.urls.watch, `${BASE}/watch/${payload}`);
  assert.equal(j.urls.embed, `${BASE}/e/${payload}`);
  assert.equal(j.urls.qr, `${BASE}/qr/${payload}`);
});

await t("ttl: expired link → 410", async () => {
  const exp = await signPayload(cfg, { c: CHANNEL, m: 77, k: "d", e: Math.floor(Date.now() / 1000) - 10 });
  seedChannelMsg(77);
  const res = await hit(`/stream/${exp}`);
  assert.equal(res.status, 410);
});

await t("password: proof-of-knowledge gating (binary payload too)", async () => {
  const proof = await passwordProof(cfg, "hunter2");
  const pp = await mintPayload(cfg, { c: CHANNEL, m: 78, k: "d", q: proof });
  seedChannelMsg(78);
  const no = await hit(`/stream/${pp}`);
  assert.equal(no.status, 403);
  const yes = await hit(`/stream/${pp}?key=hunter2`);
  assert.equal(yes.status, 200);
});

/* ---------- upload flows ---------- */

await t("upload-by-url: /upload fetches remote file and stores it", async () => {
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 3, from: { id: 777 }, text: "/upload https://remote.example/movie.mp4" } });
  const card = lastCall("sendMessage");
  assert.match(card.params.text, /Link ready/);
  const fdDoc = state.calls
    .filter((c) => c.method === "sendDocument")
    .map((c) => c.params.document)
    .find((v) => typeof v === "object" && v !== null && "name" in v);
  assert.ok(fdDoc, "multipart document was sent");
  assert.equal(fdDoc.name, "movie.mp4");
});

await t("upload-batch: two URLs → two files, | rename applies", async () => {
  const before = state.calls.filter((c) => c.method === "sendDocument").length;
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 31, from: { id: 777 }, text: "/upload https://remote.example/a.mp4 https://remote.example/b.mp4 | renamed.mp4" } });
  const docs = state.calls
    .filter((c) => c.method === "sendDocument")
    .slice(before)
    .map((c) => c.params.document)
    .filter((v) => typeof v === "object" && v !== null && "name" in v)
    .map((v) => v.name);
  assert.ok(docs.includes("renamed.mp4"), "custom name applied");
  assert.equal(docs.length, 2, "both files uploaded");
});

/* ---------- inline / rename / gen / qr ---------- */

await t("inline: answerInlineQuery with document", async () => {
  await webhook({ inline_query: { id: "q1", from: { id: 777 }, query: payload } });
  const ans = lastCall("answerInlineQuery");
  const results = JSON.parse(ans.params.results);
  assert.equal(results[0].type, "document");
  assert.equal(results[0].document_file_id, "doc1");
});

await t("rename: /rename mints a new link carrying the custom name", async () => {
  seedChannelMsg(88);
  const p88 = await mintPayload(cfg, { c: CHANNEL, m: 88, k: "d" });
  await webhook({
    message: {
      chat: { id: 777, type: "private" }, message_id: 11, from: { id: 777 },
      text: "/rename my-cool-video.mp4",
      reply_to_message: { message_id: 50, text: `card #${p88}`, chat: { id: 777 } },
    },
  });
  const card = lastCall("sendMessage");
  assert.match(card.params.text, /Renamed to/);
  const fresh = payloadFromCard(card.params.text);
  assert.notEqual(fresh, p88);
  const info = await hit(`/api/info/${fresh}`);
  const j = await info.json();
  assert.equal(j.ok, true);
  assert.equal(j.name, "my-cool-video.mp4");
  assert.equal(j.renamed, true);
});

await t("gen: /gen copies a t.me message and mints links", async () => {
  state.srcMsgs.set(55, { message_id: 55, document: state.knownFileIds.get("doc1") });
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 12, from: { id: 777 }, text: "/gen https://t.me/c/3333333333/55" } });
  const card = lastCall("sendMessage");
  assert.match(card.params.text, /Link ready/);
  const copy = state.calls.filter((c) => c.method === "copyMessage");
  assert.equal(copy.length, 1);
  assert.equal(copy[0].params.from_chat_id, -1003333333333);
});

await t("gen: unknown link → usage message", async () => {
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 13, from: { id: 777 }, text: "/gen not-a-link" } });
  assert.match(lastCall("sendMessage").params.text, /Usage|t\.me/);
});

await t("qr: /qr sends a real PNG photo", async () => {
  seedChannelMsg(89);
  const p89 = await mintPayload(cfg, { c: CHANNEL, m: 89, k: "d" });
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 14, from: { id: 777 }, text: `/qr ${p89}` } });
  const sp = lastCall("sendPhoto");
  assert.ok(sp, "sendPhoto called");
  assert.ok(typeof sp.params.photo === "object", "multipart PNG attached");
});

await t("qr: /qr/<payload> serves edge-cached SVG", async () => {
  const r1 = await hit(`/qr/${payload}`);
  assert.equal(r1.headers.get("content-type"), "image/svg+xml");
  const svg = await r1.text();
  assert.match(svg, /<svg[^>]*crispEdges/);
  const r2 = await hit(`/qr/${payload}`);
  assert.equal(r2.status, 200);
});

/* ---------- revocation ---------- */

await t("revoke: /del kills every link (v3 + purge caches)", async () => {
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 4, from: { id: 777 }, text: `/del #${payload}` } });
  assert.ok(state.deleted.length > 0, "deleteMessage called");
  const res = await hit(`/stream/${payload}`);
  assert.equal(res.status, 404);
});

/* ---------- commands ---------- */

await t("commands: /start, /help, /id, /ping respond", async () => {
  for (const cmd of ["/start", "/help", "/id", "/ping"]) {
    await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 5, from: { id: 777 }, text: cmd } });
    const card = lastCall("sendMessage");
    assert.ok(card.params.text.length > 10, `${cmd} replied`);
  }
});

await t("commands: /version and /index", async () => {
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 6, from: { id: 777 }, text: "/version" } });
  assert.match(lastCall("sendMessage").params.text, /ULTRA/);
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 7, from: { id: 777 }, text: "/index" } });
  assert.match(lastCall("sendMessage").params.text, /t\.me\/catalog/);
});

await t("i18n: /lang zh persists, /start replies in Chinese", async () => {
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 8, from: { id: 777, language_code: "en" }, text: "/lang zh" } });
  assert.match(lastCall("sendMessage").params.text, /语言已设置/);
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 9, from: { id: 777 }, text: "/start" } });
  assert.match(lastCall("sendMessage").params.text, /欢迎/);
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 10, from: { id: 777 }, text: "/lang zz" } });
  assert.match(lastCall("sendMessage").params.text, /可用语言|Available languages|Available/);
  await webhook({ message: { chat: { id: 777, type: "private" }, message_id: 16, from: { id: 777 }, text: "/lang en" } });
  assert.match(lastCall("sendMessage").params.text, /Language set to/); // restore for later tests
});

await t("i18n: auto-detect from language_code", async () => {
  await webhook({ message: { chat: { id: 555, type: "private" }, message_id: 15, from: { id: 555, language_code: "es" }, text: "/help" } });
  assert.match(lastCall("sendMessage").params.text, /Comandos/);
});

/* ---------- guards (separate env instances) ---------- */

await t("force-sub: non-member blocked, member passes, owner bypasses", async () => {
  const envFS = { ...env, FORCE_SUB_CHANNEL: "-1002222222", FORCE_SUB_URL: "https://t.me/joinchat/abc", PUBLIC_BOT: "true" };
  state.memberStatus = "left";
  await webhookEnv(envFS, { message: { chat: { id: 888, type: "private" }, message_id: 20, from: { id: 888 }, document: state.knownFileIds.get("doc1") } });
  const joinCard = lastCall("sendMessage");
  assert.match(joinCard.params.text, /Subscribe required/);
  assert.match(String(joinCard.params.reply_markup), /t\.me\/joinchat\/abc/, "join button in keyboard");

  state.memberStatus = "member";
  await webhookEnv(envFS, { message: { chat: { id: 889, type: "private" }, message_id: 21, from: { id: 889 }, document: state.knownFileIds.get("doc1") } });
  assert.match(lastCall("sendMessage").params.text, /Link ready/);

  state.memberStatus = "left"; // owner bypasses the gate
  await webhookEnv(envFS, { message: { chat: { id: 777, type: "private" }, message_id: 22, from: { id: 777 }, document: state.knownFileIds.get("doc1") } });
  assert.match(lastCall("sendMessage").params.text, /Link ready/);
  state.memberStatus = "member";
});

await t("hotlink: ALLOWED_REFERRERS blocks foreign referers only", async () => {
  seedChannelMsg(90);
  const p90 = await mintPayload(cfg, { c: CHANNEL, m: 90, k: "d" });
  const envRef = { ...env, ALLOWED_REFERRERS: "mysite.com" };
  const bad = await worker.fetch(req(`/stream/${p90}`, { headers: { Referer: "https://evil.example/x" } }), envRef, {});
  assert.equal(bad.status, 403);
  const good = await worker.fetch(req(`/stream/${p90}`, { headers: { Referer: "https://cdn.mysite.com/x" } }), envRef, {});
  assert.equal(good.status, 200);
  const direct = await worker.fetch(req(`/stream/${p90}`), envRef, {});
  assert.equal(direct.status, 200);
});

await t("rate-limit: 4th request within a minute → 429", async () => {
  seedChannelMsg(91);
  const p91 = await mintPayload(cfg, { c: CHANNEL, m: 91, k: "d" });
  const envRate = { ...env, RATE_LIMIT_RPM: "3" };
  for (let i = 0; i < 3; i++) {
    const r = await worker.fetch(req(`/stream/${p91}`), envRate, {});
    assert.equal(r.status, 200, `request ${i + 1} should pass`);
  }
  const r4 = await worker.fetch(req(`/stream/${p91}`), envRate, {});
  assert.equal(r4.status, 429);
});

await t("failover: getFile failing on token 1 → token 2 serves the file", async () => {
  seedChannelMsg(92);
  const p92 = await mintPayload(cfg, { c: CHANNEL, m: 92, k: "d" });
  state.failGetFileFor = new Set(["123:AAA"]);
  try {
    const res = await hit(`/stream/${p92}`);
    assert.equal(res.status, 200);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(body.length, FILE_SIZE);
  } finally {
    state.failGetFileFor = null;
  }
});

/* ---------- QR internals ---------- */

await t("qr: matrix structure (finders, timing, dark module, determinism)", async () => {
  const q = qrMatrix("HELLO WORLD"); // 11 bytes → version 1 (no alignment patterns)
  assert.equal(q.version, 1);
  assert.equal(q.size, 21);
  assert.equal(q.modules.length, q.size);
  assert.equal(q.modules[0][0], true);
  assert.equal(q.modules[0][6], true);
  assert.equal(q.modules[6][0], true);
  assert.equal(q.modules[0][7], false); // separator
  assert.equal(q.modules[7][0], false);
  for (let i = 8; i < q.size - 8; i++) {
    assert.equal(q.modules[6][i], i % 2 === 0, `timing col ${i}`);
    assert.equal(q.modules[i][6], i % 2 === 0, `timing row ${i}`);
  }
  assert.equal(q.modules[q.size - 8][8], true, "dark module");
  const q2 = qrMatrix("HELLO WORLD");
  assert.equal(JSON.stringify(q.modules), JSON.stringify(q2.modules), "deterministic");
});

await t("qr: version scaling + capacity guard", async () => {
  const big = qrMatrix("y".repeat(210));
  assert.equal(big.version, 10);
  assert.throws(() => qrMatrix("x".repeat(214)));
});

await t("qr: PNG is valid (signature, IHDR dims, zlib streams inflate)", async () => {
  const png = pngQrBytes("https://pro.example/watch/abc", 8);
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50); // 'P'
  assert.equal(png[2], 0x4e); // 'N'
  assert.equal(png[3], 0x47); // 'G'
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === "IHDR") { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); }
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  assert.ok(w > 0 && h > 0 && w === h, "square IHDR");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, h * (w + 1), "raw scanlines");
  assert.equal(raw[0], 0, "first filter byte");
  assert.equal(raw[1], 255, "quiet-zone pixel is white");
});

await t("qr: svgQr output is an SVG with rects", async () => {
  const svg = svgQr("https://pro.example/watch/abc");
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /<rect/);
});

/* ---------- gate cookie + mini app ---------- */

await t("turnstile: signed gate cookie round-trip", async () => {
  const cfgT = buildConfig({ ...env, TURNSTILE_SECRET_KEY: "tssec" });
  const cookie = await signGateCookie(cfgT, 100);
  assert.match(cookie, /^\d+\.[A-Za-z0-9_-]+$/);
  const okReq = req("/stream/x", { headers: { cookie: `tsg=${cookie}; other=1` } });
  assert.equal(await gateCookieOk(cfgT, okReq), true);
  const stale = await signGateCookie(cfgT, -10);
  const staleReq = req("/stream/x", { headers: { cookie: `tsg=${stale}` } });
  assert.equal(await gateCookieOk(cfgT, staleReq), false);
  const forgedReq = req("/stream/x", { headers: { cookie: "tsg=9999999999.AAAA" } });
  assert.equal(await gateCookieOk(cfgT, forgedReq), false);
  assert.equal(await gateCookieOk(cfg, okReq), true, "disabled → always pass");
});

function buildInitData(token) {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify({ id: 777, first_name: "Owner" }));
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAF");
  const dcs = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  return `${params.toString()}&hash=${hash}`;
}

await t("mini app: initData HMAC validation accepts real, rejects forged", async () => {
  const good = await validateInitData(cfg, buildInitData("123:AAA"));
  assert.ok(good && good.id === 777, "valid initData accepted");
  const bad = await validateInitData(cfg, buildInitData("123:AAA") + "x");
  assert.equal(bad, null, "tampered initData rejected");
  const otherToken = await validateInitData(cfg, buildInitData("456:BBB"));
  assert.equal(otherToken, null, "wrong bot token rejected");
});

await t("mini app: /api/app/generate mints from t.me link (and 401s fakes)", async () => {
  state.srcMsgs.set(56, { message_id: 56, document: state.knownFileIds.get("doc1") });
  const bad = await hit("/api/app/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ init_data: "user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeefdeadbeef", link: "https://t.me/c/3333333333/56" }),
  });
  assert.equal(bad.status, 401);

  const res = await hit("/api/app/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ init_data: buildInitData("123:AAA"), link: "https://t.me/c/3333333333/56" }),
  });
  const j = await res.json();
  assert.equal(j.ok, true, j.description || "");
  assert.ok(j.payload);
  assert.equal(j.name, "video.mp4");
  assert.equal(j.urls.watch, `${BASE}/watch/${j.payload}`);
});

await t("oembed: JSON endpoint for watch urls", async () => {
  seedChannelMsg(93);
  const p93 = await mintPayload(cfg, { c: CHANNEL, m: 93, k: "d" });
  const res = await hit(`/api/oembed?url=${encodeURIComponent(`${BASE}/watch/${p93}`)}`);
  const j = await res.json();
  assert.equal(j.version, "1.0");
  assert.equal(j.title, "video.mp4");
  assert.equal(j.thumbnail_url, `${BASE}/thumb/${p93}`);
});

/* ---------- misc / ops ---------- */

await t("legacy web link: /?file=<hash> redirects to signed /dl/", async () => {
  seedChannelMsg(4242);
  const SECRET = cfg.legacySecret;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let salt = ""; for (let i = 0; i < 16; i++) salt += chars[Math.floor(Math.random() * chars.length)];
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (SECRET.charCodeAt(i % SECRET.length) + salt.charCodeAt(i % salt.length)) % 256;
  for (let j = 0; j < 1000; j++)
    for (let i = 0; i < 32; i++)
      key[i] = (key[i] + SECRET.charCodeAt(i % SECRET.length) + salt.charCodeAt(i % salt.length)) % 256;
  let encoded = ""; const text = "4242";
  for (let i = 0; i < text.length; i++) encoded += String.fromCharCode(text.charCodeAt(i) ^ key[i % key.length]);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "", buffer = 0, bitsLeft = 0;
  for (const ch of salt + encoded) { buffer = (buffer << 8) | ch.charCodeAt(0); bitsLeft += 8;
    while (bitsLeft >= 5) { out += alphabet[(buffer >> (bitsLeft - 5)) & 31]; bitsLeft -= 5; } }
  if (bitsLeft > 0) out += alphabet[(buffer << (5 - bitsLeft)) & 31];

  const res = await hit(`/?file=${out}&mode=attachment`);
  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.match(loc, /\/dl\//);
  const final = await hit(loc.replace(BASE, ""));
  assert.equal(final.status, 200);
});

await t("ops: /registerWebhook guarded by ADMIN_KEY (+ menu button)", async () => {
  const no = await hit(`/registerWebhook`);
  assert.equal(no.status, 403);
  const yes = await hit(`/registerWebhook?key=adminkey`);
  const j = await yes.json();
  assert.equal(j.ok, true);
  assert.ok(state.calls.some((c) => c.method === "setChatMenuButton"), "mini app menu button registered");
});

await t("misc: home, healthz, robots", async () => {
  const home = await hit(`/`);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /TG FileStream PRO|Telegram files/);
  assert.match(homeHtml, /Binary links|QR codes/, "v3 features on home page");
  const csp = home.headers.get("content-security-policy");
  assert.ok(csp && csp.includes("default-src 'none'"), "CSP present");

  const h = await hit(`/healthz`);
  const j = await h.json();
  assert.equal(j.configured, true);
  assert.equal(j.tokens, 2);
  assert.equal(j.features.qr, true);
  assert.equal(j.features.i18n, 8);

  const r = await hit(`/robots.txt`);
  assert.match(await r.text(), /Disallow: \/stream\//);
});

await t("app: /app mini app page renders", async () => {
  const res = await hit(`/app`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /telegram-web-app\.js/);
  assert.match(html, /api\/app\/generate/);
});

console.log(`\n✅ All ${testsRun} tests passed.`);
