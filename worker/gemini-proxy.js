// 中大畢業學分檢核：Gemini 中繼站（Cloudflare Workers）
// 用途：讓 GitHub Pages 上的網頁不用使用者自己的金鑰也能「問 AI」。
// 金鑰放在 Cloudflare 後台的 Secret（GEMINI_API_KEY），不會出現在程式碼或 GitHub 上。
//
// 防濫用：
// 1. 只接受來自 ALLOWED_ORIGIN 的網頁（瀏覽器的 CORS 檢查）
// 2. 只轉送本網頁的提問格式（開頭必須是系統提示），內容長度有上限
// 3. 每個 IP 每天最多 DAILY_LIMIT 次（存在 KV；沒綁 KV 時退回記憶體，重新部署就歸零）

const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
const PROMPT_PREFIX = "你是中央大學的畢業學分顧問。";
const MAX_CHARS = 30000;
const memoryCount = new Map();

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || "https://steven20070308-art.github.io").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const reply = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

async function overLimit(env, ip) {
  const limit = Number(env.DAILY_LIMIT || 20);
  const key = `${new Date().toISOString().slice(0, 10)}:${ip}`;
  if (env.RATE) {
    const n = Number((await env.RATE.get(key)) || 0);
    if (n >= limit) return true;
    await env.RATE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 26 });
    return false;
  }
  const n = memoryCount.get(key) || 0;
  memoryCount.set(key, n + 1);
  return n >= limit;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(env, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return reply({ error: "只接受 POST" }, 405, headers);
    if (!headers["Access-Control-Allow-Origin"].includes(origin)) return reply({ error: "來源網站不在允許清單" }, 403, headers);

    let prompt = "";
    try { prompt = String((await request.json()).prompt || ""); } catch (e) { return reply({ error: "格式錯誤" }, 400, headers); }
    if (!prompt.startsWith(PROMPT_PREFIX) || prompt.length > MAX_CHARS) return reply({ error: "只接受本網頁的提問" }, 400, headers);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await overLimit(env, ip)) return reply({ error: "今天的免費提問次數用完了" }, 429, headers);

    let last = "";
    for (const model of MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      });
      if (r.ok) {
        const data = await r.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        if (text) return reply({ text, model }, 200, headers);
      }
      last = `${model} 回覆 ${r.status}`;
      if (r.status === 400 || r.status === 401 || r.status === 403) break;  // 金鑰問題，換模型也沒用
    }
    return reply({ error: `AI 暫時無法回答（${last}）` }, 502, headers);
  },
};
