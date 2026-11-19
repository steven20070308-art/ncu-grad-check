# Gemini 中繼站（選用）

GitHub Pages 是純靜態網頁，不能放 API 金鑰。網頁的「問 AI」預設請使用者貼自己的 Gemini 金鑰（只存在他的瀏覽器）。
如果想讓使用者**不用金鑰**就能問（例如比賽展示），可以把這個中繼站部署到 Cloudflare Workers（免費方案即可），金鑰放在 Cloudflare 後台。

## 部署步驟（約 15 分鐘）

1. 到 <https://dash.cloudflare.com/sign-up> 註冊並登入。
2. 左側選 **Workers & Pages → Create → Create Worker**，名稱填 `ncu-grad-ai`，按 Deploy。
3. 按 **Edit code**，把 `gemini-proxy.js` 全部內容貼上，取代原本的程式，按 Deploy。
4. 回到這個 Worker 的 **Settings → Variables and Secrets**：
   - 新增 **Secret** `GEMINI_API_KEY`＝你的 Gemini 金鑰（<https://aistudio.google.com/apikey>）
   - 新增 Text `ALLOWED_ORIGIN`＝`https://steven20070308-art.github.io`
   - 選填 Text `DAILY_LIMIT`＝每個 IP 每天可問幾次（預設 20）
5. （建議）**Storage & Databases → KV → Create namespace**，名稱 `ncu-grad-rate`；再回 Worker 的 **Settings → Bindings → Add → KV namespace**，變數名稱填 `RATE`。沒有 KV 也能用，但次數限制在重新部署後會歸零。
6. 複製 Worker 網址（像 `https://ncu-grad-ai.xxx.workers.dev`），填到 `web/template.html` 的 `const AI_PROXY = "";`，執行 `python web/build.py` 後 push。

## 防濫用

- 只接受 `ALLOWED_ORIGIN` 網站送來的請求
- 只轉送本網頁格式的提問（開頭必須是系統提示），長度上限 30,000 字
- 每個 IP 每天次數上限

使用者自己有設定金鑰時，網頁會優先用他的金鑰，不消耗中繼站的額度。
