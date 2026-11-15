// Garaj serveri (bot-hosting uchun). Netlify o'rniga ishlaydi: sahifa + /api/* + SQLite baza.
// api.mjs fayliga TEGILMAYDI: undan Netlify'ga xos qismlar ishga tushishda avtomatik ajratib olinadi.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const DB_FILE = path.join(DIR, "garaj.db");

// 1) api.mjs dan faqat asosiy mantiqni (makeApi) olamiz
const raw = fs.readFileSync(path.join(DIR, "api.mjs"), "utf8");
const cut = raw.indexOf("// Netlify Blobs (bepul");
if (cut < 0) throw new Error("api.mjs ichida '// Netlify Blobs' belgisi topilmadi");
const core = raw.replace(/^import \{ getStore \} from "@netlify\/blobs";\s*$/m, "").slice(0, cut) + "\nexport { makeApi };\n";
fs.writeFileSync(path.join(DIR, ".core.mjs"), core);
const { makeApi } = await import(pathToFileURL(path.join(DIR, ".core.mjs")).href);

// 2) Netlify Blobs o'rniga SQLite ombori (get/put/list/del bir xil qoidalar bilan)
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
db.exec("CREATE TABLE IF NOT EXISTS kv (area TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, ver INTEGER NOT NULL, PRIMARY KEY (area, key))");
const qGet = db.prepare("SELECT data, ver FROM kv WHERE area=? AND key=?");
const qIns = db.prepare("INSERT OR IGNORE INTO kv (area,key,data,ver) VALUES (?,?,?,1)");
const qUpd = db.prepare("UPDATE kv SET data=?, ver=ver+1 WHERE area=? AND key=? AND ver=?");
const qUps = db.prepare("INSERT INTO kv (area,key,data,ver) VALUES (?,?,?,1) ON CONFLICT(area,key) DO UPDATE SET data=excluded.data, ver=ver+1");
const qList = db.prepare("SELECT key FROM kv WHERE area=? AND substr(key,1,?)=?");
const qDel = db.prepare("DELETE FROM kv WHERE area=? AND key=?");
function area(name) {
  return {
    async get(key) { const r = qGet.get(name, key); return r ? { data: JSON.parse(r.data), etag: String(r.ver) } : null; },
    async put(key, data, cond = {}) {
      const s = JSON.stringify(data);
      if (cond.ifNew) return qIns.run(name, key, s).changes === 1;
      if (cond.ifMatch) return qUpd.run(s, name, key, Number(cond.ifMatch)).changes === 1;
      qUps.run(name, key, s); return true;
    },
    async list(prefix) { return qList.all(name, prefix.length, prefix).map((r) => r.key); },
    async del(key) { qDel.run(name, key); },
  };
}
const store = { users: area("users"), lot: area("lot"), meta: area("meta") };
const api = makeApi(store, { ADMIN_KEY: process.env.ADMIN_KEY, SECRET_SALT: process.env.SECRET_SALT });

// 3) Statik fayllar
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8" };
const HIDDEN = /(^|\/)(\.|node_modules|server\.mjs|api\.mjs|package(-lock)?\.json|netlify\.toml|readme\.md|garaj\.db)/i;

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("Topilmadi"); }
    const ext = path.extname(file).toLowerCase();
    const heavy = /\/models\//.test(file.replaceAll("\\", "/")) || ![".html"].includes(ext);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "content-length": st.size, "cache-control": heavy ? "public, max-age=86400" : "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// 4) Kichik kesh: ommaviy GET ma'lumotlar (turargoh bo'laklari) bazani qiynamasin
const cache = new Map();
let pullFails = 0, pullLock = 0;
const CACHEABLE = /^\/(api\/)?(lotmeta|lot|stats)$/;

async function readBody(req, limit = 300000) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error("big"); parts.push(c); }
  return Buffer.concat(parts);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    // Bir martalik ko'chirish: Netlify'dagi ma'lumotni shu bazaga nusxalaydi (faqat ADMIN_KEY bilan)
    if (p === "/api/_pull" && req.method === "POST") {
      const reply = (st, o) => { res.writeHead(st, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
      if (pullLock > Date.now()) return reply(429, { error: "Juda ko'p noto'g'ri urinish. Keyinroq urinib ko'ring" });
      let b = {}; try { b = JSON.parse((await readBody(req)).toString() || "{}"); } catch { return reply(400, { error: "So'rov noto'g'ri" }); }
      const K = process.env.ADMIN_KEY || "";
      const good = K && typeof b.key === "string" && b.key.length === K.length && crypto.timingSafeEqual(Buffer.from(b.key), Buffer.from(K));
      if (!good) { if (++pullFails >= 8) { pullFails = 0; pullLock = Date.now() + 30 * 60e3; } return reply(403, { error: "Ruxsat yo'q" }); }
      pullFails = 0;
      if (!/^(https:\/\/|http:\/\/localhost)/.test(String(b.source || ""))) return reply(400, { error: "source https bilan boshlanishi kerak" });
      if (!["users", "lot", "meta"].includes(b.area)) return reply(400, { error: "area noto'g'ri" });
      if (b.reset) db.exec("DELETE FROM kv");
      const r = await fetch(String(b.source).replace(/\/+$/, "") + "/api/admin", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ key: b.key, action: "dump", area: b.area, from: b.from | 0 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(j.items)) return reply(502, { error: "Manbadan javob kelmadi", status: r.status, detail: j.error || null });
      for (const [k, data] of j.items) await store[b.area].put(k, data, {});
      cache.clear();
      return reply(200, { ok: true, area: b.area, copied: j.items.length, total: j.total, next: j.next ?? null });
    }

    if (p.startsWith("/api/") || p.startsWith("/.netlify/functions/api")) {
      const key = req.method === "GET" && CACHEABLE.test(p.replace(/^\/\.netlify\/functions/, "")) ? req.url : null;
      if (key) { const c = cache.get(key); if (c && Date.now() - c.t < 15000) { res.writeHead(c.status, c.headers); return res.end(c.body); } }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      if (!headers.get("x-forwarded-for")) headers.set("x-forwarded-for", req.socket.remoteAddress || "?");
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const body = hasBody ? await readBody(req) : undefined;
      const resp = await api.handle(new Request("http://localhost" + req.url, { method: req.method, headers, body }));
      const out = Buffer.from(await resp.arrayBuffer()), h = Object.fromEntries(resp.headers);
      delete h["netlify-cdn-cache-control"];
      if (key && resp.status === 200) cache.set(key, { t: Date.now(), status: 200, headers: h, body: out });
      res.writeHead(resp.status, h); return res.end(out);
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); return res.end(); }
    let rel = p === "/" ? "/index.html" : p;
    const file = path.normalize(path.join(DIR, rel));
    if (!file.startsWith(DIR + path.sep) || HIDDEN.test(path.relative(DIR, file).replaceAll("\\", "/"))) { res.writeHead(404); return res.end("Topilmadi"); }
    sendFile(req, res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(e.message === "big" ? 413 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Server xatosi" }));
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`Garaj serveri ishga tushdi: port ${PORT}`));
