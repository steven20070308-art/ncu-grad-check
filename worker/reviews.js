// 中大畢業學分檢核：課程評價 API（Cloudflare Workers + D1）
//
// 評價內容只有星等與固定選項（作業量／給分／點名），不收文字，避免需要審核留言。
// 身分：前端用 Google 登入取得 ID token，這裡驗證簽章、確認是學校網域帳號。
// 隱私：不存信箱或姓名，只存 SHA-256(REVIEW_SALT + Google 帳號 ID)，用來確保一人一課一評。
//
// 環境設定（Cloudflare 後台 → Settings → Variables and Secrets / Bindings）：
//   DB               D1 資料庫綁定（先執行 schema.sql 建表）
//   GOOGLE_CLIENT_ID Google OAuth 用戶端 ID（Text）
//   REVIEW_SALT      隨機長字串（Secret），設定後不要再改，否則同一人會被當成新的人
//   ALLOWED_ORIGIN   允許的網站，逗號分隔（預設 https://steven20070308-art.github.io）
//   ALLOWED_DOMAINS  允許的 Google 帳號網域，逗號分隔（預設 g.ncu.edu.tw）
//   MIN_SHOW         一門課至少幾則評價才公開統計（預設 3）
//   DAILY_WRITES     每人每天最多新增／修改幾則（預設 30）
//
// API：
//   GET  /summary?keys=BA1003|王小明,IM2045|      → 各課統計（未達 MIN_SHOW 只回則數）
//   POST /mine    { token }                          → 自己評過的課（用來預填表單）
//   POST /review  { token, code, teacher, stars, workload, grading, attendance }
//   POST /review  { token, code, teacher, delete: true }

const CODE_RE = /^(?:[A-Z]{2}[A-Z0-9]\d{3}|[A-Z]{3}\d{4})$/;
const TEACHER_RE = /^(?:[㐀-鿿]{2,4}(?:、[㐀-鿿]{2,4}){0,4})?$/;
const CHOICES = {
  workload: ["light", "medium", "heavy"],
  grading: ["lenient", "normal", "strict"],
  attendance: ["none", "sometimes", "always"],
};
const MAX_KEYS = 80;
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

let jwksCache = { keys: null, until: 0 };

const list = (v, dflt) => String(v || dflt).split(",").map((s) => s.trim()).filter(Boolean);

function cors(env, origin) {
  const allowed = list(env.ALLOWED_ORIGIN, "https://steven20070308-art.github.io");
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const reply = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Google ID token 驗證 ----------
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const parsePart = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function googleKeys(force = false) {
  if (!force && jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new HttpError(503, "暫時無法驗證 Google 登入，請稍後再試");
  const maxAge = Number((r.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = { keys: (await r.json()).keys || [], until: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

export async function verifyGoogleToken(token, env, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "請先用學校 Google 帳號登入");
  let header, payload;
  try { header = parsePart(parts[0]); payload = parsePart(parts[1]); } catch (e) { throw new HttpError(401, "登入資訊格式錯誤"); }
  if (header.alg !== "RS256") throw new HttpError(401, "登入資訊格式錯誤");

  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid);  // Google 換金鑰時重抓一次
  if (!jwk) throw new HttpError(401, "登入資訊無法驗證，請重新登入");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new HttpError(401, "登入資訊無法驗證，請重新登入");

  if (!ISSUERS.includes(payload.iss)) throw new HttpError(401, "登入資訊無法驗證，請重新登入");
  if (!env.GOOGLE_CLIENT_ID || payload.aud !== env.GOOGLE_CLIENT_ID) throw new HttpError(401, "登入資訊不是本網站發出的");
  if (!(payload.exp * 1000 > now)) throw new HttpError(401, "登入已過期，請重新登入");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new HttpError(403, "這個 Google 帳號的信箱尚未驗證");

  const domains = list(env.ALLOWED_DOMAINS, "g.ncu.edu.tw");
  const emailDomain = String(payload.email || "").split("@")[1] || "";
  if (!domains.includes(payload.hd) || !domains.includes(emailDomain)) {
    throw new HttpError(403, `只接受學校帳號（${domains.map((d) => "@" + d).join("、")}）`);
  }
  return payload;
}

async function userHash(env, sub) {
  if (!env.REVIEW_SALT) throw new HttpError(500, "伺服器尚未設定 REVIEW_SALT");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.REVIEW_SALT}:${sub}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- 輸入檢查 ----------
function courseKey(code, teacher) {
  code = String(code || "").trim().toUpperCase();
  teacher = String(teacher || "").trim();
  if (!CODE_RE.test(code)) throw new HttpError(400, "課號格式不正確");
  if (!TEACHER_RE.test(teacher)) throw new HttpError(400, "教師姓名格式不正確");
  return { code, teacher };
}

function ratings(body) {
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, "星等要是 1 到 5");
  const out = { stars };
  for (const [k, opts] of Object.entries(CHOICES)) {
    if (!opts.includes(body[k])) throw new HttpError(400, `請選擇${{ workload: "作業量", grading: "給分", attendance: "點名" }[k]}`);
    out[k] = body[k];
  }
  return out;
}

// ---------- 各路由 ----------
async function summary(env, url) {
  const raw = (url.searchParams.get("keys") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_KEYS);
  const keys = [];
  for (const k of raw) {
    const [code, teacher = ""] = k.split("|");
    try { const c = courseKey(code, teacher); keys.push(`${c.code}|${c.teacher}`); } catch (e) { /* 略過格式錯誤的 key */ }
  }
  if (!keys.length) return {};
  const minShow = Number(env.MIN_SHOW || 3);
  const sql = `SELECT course_code || '|' || teacher AS k, COUNT(*) AS n, AVG(stars) AS avg,
      SUM(workload = 'light') AS w_light, SUM(workload = 'medium') AS w_medium, SUM(workload = 'heavy') AS w_heavy,
      SUM(grading = 'lenient') AS g_lenient, SUM(grading = 'normal') AS g_normal, SUM(grading = 'strict') AS g_strict,
      SUM(attendance = 'none') AS a_none, SUM(attendance = 'sometimes') AS a_sometimes, SUM(attendance = 'always') AS a_always
    FROM reviews WHERE course_code || '|' || teacher IN (${keys.map(() => "?").join(",")})
    GROUP BY course_code, teacher`;
  const { results = [] } = await env.DB.prepare(sql).bind(...keys).all();
  const out = {};
  for (const r of results) {
    if (r.n < minShow) { out[r.k] = { n: r.n }; continue; }
    out[r.k] = {
      n: r.n, avg: Math.round(r.avg * 10) / 10,
      workload: { light: r.w_light, medium: r.w_medium, heavy: r.w_heavy },
      grading: { lenient: r.g_lenient, normal: r.g_normal, strict: r.g_strict },
      attendance: { none: r.a_none, sometimes: r.a_sometimes, always: r.a_always },
    };
  }
  return out;
}

async function mine(env, body) {
  const user = await userHash(env, (await verifyGoogleToken(body.token, env)).sub);
  const { results = [] } = await env.DB.prepare(
    "SELECT course_code AS code, teacher, stars, workload, grading, attendance FROM reviews WHERE user_hash = ?").bind(user).all();
  return { reviews: results };
}

async function review(env, body) {
  const payload = await verifyGoogleToken(body.token, env);
  const user = await userHash(env, payload.sub);
  const { code, teacher } = courseKey(body.code, body.teacher);
  const now = Date.now();

  if (body.delete === true) {
    await env.DB.prepare("DELETE FROM reviews WHERE user_hash = ? AND course_code = ? AND teacher = ?").bind(user, code, teacher).run();
    return { ok: true, deleted: true };
  }
  const r = ratings(body);
  const limit = Number(env.DAILY_WRITES || 30);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE user_hash = ? AND updated_at > ?").bind(user, now - 86400000).first();
  if ((recent?.n || 0) >= limit) throw new HttpError(429, "今天評價的次數已達上限，明天再來");

  await env.DB.prepare(`INSERT INTO reviews (user_hash, course_code, teacher, stars, workload, grading, attendance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_hash, course_code, teacher) DO UPDATE SET
        stars = excluded.stars, workload = excluded.workload, grading = excluded.grading,
        attendance = excluded.attendance, updated_at = excluded.updated_at`)
    .bind(user, code, teacher, r.stars, r.workload, r.grading, r.attendance, now, now).run();
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(env, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/summary") {
        return reply(await summary(env, url), 200, { ...headers, "Cache-Control": "public, max-age=60" });
      }
      if (request.method === "POST" && (url.pathname === "/review" || url.pathname === "/mine")) {
        if (headers["Access-Control-Allow-Origin"] !== origin) throw new HttpError(403, "來源網站不在允許清單");
        let body;
        try { body = await request.json(); } catch (e) { throw new HttpError(400, "格式錯誤"); }
        return reply(url.pathname === "/mine" ? await mine(env, body) : await review(env, body), 200, headers);
      }
      throw new HttpError(404, "找不到這個路徑");
    } catch (e) {
      if (e instanceof HttpError) return reply({ error: e.message }, e.status, headers);
      return reply({ error: "伺服器錯誤，請稍後再試" }, 500, headers);
    }
  },
};
