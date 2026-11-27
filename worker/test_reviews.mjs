// 課程評價 Worker 的本機測試：假的 Google 金鑰＋SQLite 模擬 D1。執行：node worker/test_reviews.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import worker, { verifyFirebaseToken } from "./reviews.js";

const ORIGIN = "https://steven20070308-art.github.io";
const PROJECT = "ncu-grad-test";

// --- 模擬 D1 ---
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const D1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    return { bind: (...a) => ({
      all: async () => ({ results: st.all(...a).map((r) => ({ ...r })) }),
      first: async () => { const r = st.get(...a); return r ? { ...r } : null; },
      run: async () => st.run(...a),
    }) };
  },
};
const env = { DB: D1, FIREBASE_PROJECT_ID: PROJECT, REVIEW_SALT: "salt", ALLOWED_DOMAINS: "g.ncu.edu.tw", MIN_SHOW: "2", DAILY_WRITES: "5" };

// --- 假的 Firebase 金鑰與 ID token ---
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
globalThis.fetch = async (url) => {
  assert.equal(String(url), "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Cache-Control": "max-age=600" } });
};
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function token(claims = {}, key = kp.privateKey, kid = "k1") {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: "uid1001", email: "s1@g.ncu.edu.tw", email_verified: true,
    iat: now, auth_time: now, exp: now + 3600, firebase: { sign_in_provider: "google.com", identities: {} }, ...claims };
  const data = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(body)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(sig).toString("base64url")}`;
}

const call = async (method, path, body, origin = ORIGIN) => {
  const r = await worker.fetch(new Request(`https://w.example${path}`, {
    method, headers: { Origin: origin, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, data: await r.json() };
};
const rate = (extra) => ({ code: "BA1003", teacher: "王小明", stars: 5, workload: "light", grading: "lenient", attendance: "none", ...extra });

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

// --- 驗證 ---
await t("合法學校帳號通過", async () => assert.equal((await verifyFirebaseToken(await token(), env)).sub, "uid1001"));
await t("信箱大寫也認得", async () => assert.equal((await verifyFirebaseToken(await token({ email: "S1@G.NCU.EDU.TW" }), env)).sub, "uid1001"));
for (const [name, claims, status] of [
  ["個人 Gmail 被擋", { email: "x@gmail.com" }, 403],
  ["相似網域被擋", { email: "x@g.ncu.edu.tw.evil.com" }, 403],
  ["別的 Firebase 專案的 token 被擋", { aud: "other", iss: "https://securetoken.google.com/other" }, 401],
  ["aud 對但發行者不對被擋", { iss: "https://accounts.google.com" }, 401],
  ["過期 token 被擋", { exp: Math.floor(Date.now() / 1000) - 10 }, 401],
  ["未來簽發的 token 被擋", { iat: Math.floor(Date.now() / 1000) + 3600 }, 401],
  ["信箱未驗證被擋", { email_verified: false }, 403],
  ["不是 Google 登入（帳密登入）被擋", { firebase: { sign_in_provider: "password" } }, 403],
  ["匿名登入被擋", { firebase: { sign_in_provider: "anonymous" }, email: undefined }, 403],
]) await t(name, async () => assert.equal((await call("POST", "/review", { token: await token(claims), ...rate() })).status, status));
await t("偽造簽章被擋", async () => assert.equal((await call("POST", "/review", { token: await token({}, other.privateKey), ...rate() })).status, 401));
await t("竄改內容被擋", async () => {
  const [h, , s] = (await token()).split(".");
  const forged = `${h}.${enc({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: "uid1001", email: "s1@g.ncu.edu.tw", email_verified: true, iat: 0, auth_time: 0, exp: 9e9, firebase: { sign_in_provider: "google.com" } })}.${s}`;
  assert.equal((await call("POST", "/review", { token: forged, ...rate() })).status, 401);
});
await t("沒登入被擋", async () => assert.equal((await call("POST", "/review", rate())).status, 401));
await t("別的網站來源被擋", async () => assert.equal((await call("POST", "/review", { token: await token(), ...rate() }, "https://evil.example")).status, 403));

// --- 輸入檢查 ---
for (const [name, extra] of [
  ["星等超出範圍", { stars: 6 }], ["星等不是整數", { stars: 4.5 }], ["作業量亂填", { workload: "none" }],
  ["課號格式錯", { code: "BA10" }], ["教師欄塞文字", { teacher: "<script>" }], ["教師欄太長", { teacher: "王小明、".repeat(6) + "王小明" }],
]) await t(`${name}被擋`, async () => assert.equal((await call("POST", "/review", { token: await token(), ...rate(extra) })).status, 400));

// --- 寫入、一人一評、統計 ---
await t("第一則評價成功", async () => assert.equal((await call("POST", "/review", { token: await token(), ...rate() })).status, 200));
await t("未達門檻只回則數", async () => {
  const { data } = await call("GET", "/summary?keys=BA1003|王小明");
  assert.deepEqual(data, { "BA1003|王小明": { n: 1 } });
});
await t("同一人再評是修改不是新增", async () => {
  await call("POST", "/review", { token: await token(), ...rate({ stars: 3, workload: "heavy" }) });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reviews").get().n, 1);
  assert.equal(db.prepare("SELECT stars FROM reviews").get().stars, 3);
});
await t("資料庫不存信箱與帳號 ID", async () => {
  const row = JSON.stringify(db.prepare("SELECT * FROM reviews").get());
  assert.ok(!row.includes("s1@g.ncu.edu.tw") && !row.includes("uid1001"));
});
await t("達門檻後公開統計", async () => {
  await call("POST", "/review", { token: await token({ sub: "1002", email: "s2@g.ncu.edu.tw" }), ...rate({ stars: 4, grading: "strict" }) });
  const { data } = await call("GET", "/summary?keys=BA1003|王小明,IM2045|,bad|key");
  const s = data["BA1003|王小明"];
  assert.equal(s.n, 2); assert.equal(s.avg, 3.5);
  assert.deepEqual(s.workload, { light: 1, medium: 0, heavy: 1 });
  assert.deepEqual(s.grading, { lenient: 1, normal: 0, strict: 1 });
  assert.equal(data["IM2045|"], undefined);
});
await t("同課不同老師分開算", async () => {
  await call("POST", "/review", { token: await token(), ...rate({ teacher: "李大華" }) });
  const { data } = await call("GET", "/summary?keys=BA1003|李大華");
  assert.equal(data["BA1003|李大華"].n, 1);
});
await t("查自己的評價", async () => {
  const { data } = await call("POST", "/mine", { token: await token() });
  assert.equal(data.reviews.length, 2);
  assert.ok(data.reviews.every((r) => !("user_hash" in r)));
});
await t("刪除自己的評價", async () => {
  await call("POST", "/review", { token: await token(), code: "BA1003", teacher: "李大華", delete: true });
  assert.equal((await call("POST", "/mine", { token: await token() })).data.reviews.length, 1);
});
await t("每日上限", async () => {
  const tk = await token({ sub: "2000", email: "s3@g.ncu.edu.tw" });
  const codes = ["BA1001", "BA1002", "BA1004", "BA1005", "BA1006", "BA1007"];
  const st = [];
  for (const code of codes) st.push((await call("POST", "/review", { token: tk, ...rate({ code }) })).status);
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429]);
});
await t("未知路徑 404", async () => assert.equal((await call("GET", "/nope")).status, 404));

console.log(`\n全部 ${n} 項通過`);
