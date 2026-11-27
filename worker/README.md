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

---

# 課程評價 API（選用）

`reviews.js` 讓使用者用學校 Google 帳號登入（Firebase Authentication）後，評價自己修過的課（1–5 星＋作業量、給分、點名，不收文字），排課建議旁會顯示統計。評價存在 Cloudflare D1 資料庫。

**分工**：Firebase 只負責「登入」，評價資料存在 Cloudflare D1，由 Worker 驗證 Firebase 發的登入 token 後才寫入。

**隱私設計**：資料庫只存 `SHA-256(REVIEW_SALT + Firebase 使用者 ID)`、課號、老師與選項，不存信箱、姓名或成績單。同一門課（同老師）累積 `MIN_SHOW` 則（預設 3）以上才公開統計。

## 部署步驟（約 30 分鐘，都用免費方案）

### 一、確認學校帳號網域

用學校 Google 帳號登入 Gmail，看信箱是 `@g.ncu.edu.tw` 還是其他網域。下面的 `ALLOWED_DOMAINS` 和網頁的 `REVIEW_DOMAIN` 都要填這個網域。

### 二、設定 Firebase 登入

1. 到 <https://console.firebase.google.com/>，**新增專案**（名稱例如 `ncu-grad-check`，Google Analytics 可以關掉）。建議開新專案，不要和其他網站共用，登入畫面才會顯示這個網站的名稱。
2. 左側 **Build → Authentication → Get started → Sign-in method**，選 **Google**，打開「啟用」，填「專案公開名稱」（例如「中大畢業學分檢核」）和支援信箱，儲存。
3. **Authentication → Settings → Authorized domains（授權網域）→ Add domain**，加入 `steven20070308-art.github.io`。
4. 齒輪 **Project settings → General → Your apps**，按 **</>（Web）** 註冊網頁應用程式（不用勾 Firebase Hosting），複製畫面上的 `firebaseConfig` 物件。
5. 同一頁記下 **Project ID**（Worker 要用）。

> `firebaseConfig` 裡的 `apiKey` 是公開資訊，不是密鑰，可以放在網頁和 GitHub 上；安全性靠授權網域和 Worker 驗證 token。
> 學校的 Google 管理員可能限制學生帳號登入外部網站。部署完先用自己的學校帳號試登入；如果出現「存取遭封鎖」，到 Google Cloud Console 同一個專案的 **OAuth consent screen** 確認已發布（Publish app）。

### 三、建立 D1 資料庫

1. Cloudflare 後台 **Storage & Databases → D1 → Create database**，名稱 `ncu-grad-reviews`。
2. 進入資料庫的 **Console**，貼上 `schema.sql` 全部內容，按 Execute。

### 四、建立評價 Worker

1. **Workers & Pages → Create → Create Worker**，名稱 `ncu-grad-reviews`，按 Deploy。
2. **Edit code**，把 `reviews.js` 全部內容貼上，按 Deploy。
3. **Settings → Bindings → Add → D1 database**：變數名稱 `DB`，選 `ncu-grad-reviews`。
4. **Settings → Variables and Secrets**：
   - Text `FIREBASE_PROJECT_ID`＝第二步的 Project ID
   - Text `ALLOWED_ORIGIN`＝`https://steven20070308-art.github.io`
   - Text `ALLOWED_DOMAINS`＝第一步確認的網域（例如 `g.ncu.edu.tw`）
   - **Secret** `REVIEW_SALT`＝一串 32 字以上的隨機字（可用密碼管理器產生）。**設定後不要再改**，否則所有人會被當成新的人。
   - 選填 Text `MIN_SHOW`（預設 3）、`DAILY_WRITES`（每人每天可新增／修改幾則，預設 30）
5. 打開 `https://ncu-grad-reviews.xxx.workers.dev/summary?keys=BA1003|`，看到 `{}` 就代表 Worker 和資料庫都接好了。

### 五、接上網頁

在 `web/template.html` 填入：

```js
const REVIEW_API = "https://ncu-grad-reviews.xxx.workers.dev";
const FIREBASE_CONFIG = { apiKey: "AIza…", authDomain: "xxx.firebaseapp.com", projectId: "xxx", appId: "1:…:web:…" };  // 第二步複製的 firebaseConfig
const REVIEW_DOMAIN = "g.ncu.edu.tw";   // 第一步確認的網域
```

執行 `python web/build.py` 後推送。兩個值沒填時，網頁不會出現評價功能。

## 防濫用與驗證

- 後端依 Firebase 官方規則驗證 ID token：簽章、發行者與專案 ID、簽發與到期時間；並要求登入方式是 Google、信箱已驗證、信箱網域在 `ALLOWED_DOMAINS` 裡
- 一人一課（同老師）只算一則，再評是修改；每人每天新增／修改次數有上限
- 只接受 `ALLOWED_ORIGIN` 網站送來的寫入請求；課號、老師姓名、選項都有格式檢查
- 網頁只讓使用者評價成績單上已及格的課，但成績單不上傳，伺服器無法確認真的修過
- 本機測試：`node worker/test_reviews.mjs`
