# 中大畢業學分檢核 Agent（NCU Grad Check）

> 貼上成績，AI 告訴你還差什麼、下學期怎麼修最划算。

## 專題簡介

中央大學已有「畢業審核系統」，但跨類別的學分認列（例如通識超修能抵多少選修、學分學程與系選修能否共用）系統不會算，學生只能自己翻應修科目表手算，常到大四才發現少修。

本專題目前支援管理學院四個學系（企管 114、資管 114、財金 113、經濟 114 學年度入學），做一個畢業學分檢核 Agent：

- **AI 負責「讀」與「說」**：讀懂從成績查詢頁直接複製的文字、用白話解釋結果
- **程式負責「算」與「查」**：學分計算交給可驗證的規則引擎，AI 的回答再經過稽核

## 主要功能

| 功能 | 說明 |
|---|---|
| 成績解析 | 直接貼上成績查詢頁文字，自動整理成修課紀錄 |
| 畢業檢核 | 依應修科目表計算必修、通識、國文、外文、體育、服務學習、選修 |
| 學分學程 | 檢核「企業資源規劃」「商業智慧與分析」兩個學程的修畢條件 |
| 試算 | 問「如果我修 BA5040、BA7114 會怎樣？」，比較修課前後的差異 |
| 排課建議 | 讀入課程查詢頁的開課資料，依「還沒修的必修 → 擇N → 選修缺口」挑課、避開衝堂、不超過學分上限，畫出課表；每加一門都重算缺口，只收真正有幫助的課 |
| 數字稽核 | AI 回答中若出現報告裡沒有的數字，標記請人工確認 |
| 防呆 | 一門課都讀不到時直接停止，不輸出錯誤結論 |

## 網頁版（手機、電腦都能用）

- 線上使用：https://steven20070308-art.github.io/ncu-grad-check/ （需在 repo 設定開啟 GitHub Pages：Settings → Pages → main 分支 /docs）
- 選科系 → 貼上成績頁或手動輸入「課號 成績」→ 立即看到逐項核對、還沒修的必修、學分學程進度與試算
- **成績只在瀏覽器內計算，不會上傳**
- 「問 AI」需在 Claude 裡開啟頁面才能使用；GitHub Pages 版會自動隱藏 AI，其餘功能不受影響
- 網頁的計算邏輯 `web/gradcheck.js` 與 Python 版逐項比對一致（`node web/test_parity.js`）
- 修改規則或網頁後執行 `python web/build.py` 重新產生 `docs/index.html`

## 系統架構

```
貼上成績文字
   │
   ▼
① 解析 Parser ──(讀不到課程→停止)
   │
   ▼
② 路由 Router ── 問題含課號？ ─是→ 試算（修課前 vs 修課後）
   │                          否→ 解釋
   ▼
③ 規則引擎 engine.py（純程式計算，不用 AI）
   │
   ▼
④ AI 解釋（只能引用報告中的數字）
   │
   ▼
⑤ 稽核 Auditor（檢查回答中的數字）──→ 回覆學生
```

## 使用技術

- Python 3（只用內建函式庫，不需安裝套件）
- AI：OpenAI 相容 API，預設使用 **Google Gemini**（免費額度、不需信用卡）；也可換 Azure OpenAI（Azure for Students）、OpenAI 或本機 Ollama
- 規則來源：[企管系 114 學年度應修科目表](https://ba.mgt.ncu.edu.tw/upfile/course/2/2025/202508141210444450964.pdf)、[ERP 學分學程](https://in.ncu.edu.tw/ncu57170/114/14.pdf)、[商業智慧與分析學分學程](https://in.ncu.edu.tw/ncu57170/114/49.pdf)

## 安裝與執行

```bash
git clone https://github.com/steven20070308-art/ncu-grad-check.git
cd ncu-grad-check

# 1. 執行測試
python test_agent.py

# 2. 離線模擬（不需要金鑰）
python agent.py --paste data/sample_paste.txt --ask "我還差多少學分？" --mock

# 3. 接上 AI：複製 .env.example 為 .env，填入 Gemini 金鑰（https://aistudio.google.com/apikey）
python agent.py --paste data/sample_paste.txt --ask "我想修 ERP 學程要注意什麼？"
```

> ⚠ `.env` 已列入 `.gitignore`，請勿把金鑰上傳 GitHub。

## 操作流程

1. 登入中大成績查詢頁，在表格內點一下後 `Ctrl+A`、`Ctrl+C`
2. 貼到記事本，存成 `data/my_paste_private.txt`（檔名含 `private` 不會被上傳）
3. 執行 `python agent.py --paste data/my_paste_private.txt --ask "你的問題"`
4. 看結果：解析了幾門課 → 走哪條路由 → AI 回答 → 稽核結果

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `agent.py` | Agent 主程式：解析、路由、AI 解釋、稽核 |
| `engine.py` | 規則引擎：畢業學分與學分學程計算 |
| `rules/ba_114.json` | 企管系 114 學年度應修規則 |
| `rules/im_114.json`、`fm_113.json`、`ec_114.json`、`op_114.json` | 資管、財金、經濟、光電系應修規則 |
| `rules/programs_114.json` | 兩個學分學程的課表與修畢條件 |
| `data/sample_*` | **假成績**範例資料（課程清單為真實，成績為隨機產生） |
| `test_agent.py` | 解析、稽核、路由的自動測試 |
| `web/gradcheck.js` | 網頁版核心邏輯（解析、規則引擎、稽核），與 Python 版一致 |
| `web/template.html` | 網頁介面 |
| `web/build.py` | 把邏輯、規則與範例內嵌成單一檔案 `docs/index.html` |
| `data/offerings_*.txt` | 從課程查詢系統複製的開課資料（115-1 企管、資管、財金、經濟系共 190 個班，示範用） |
| `web/test_parity.js` | 網頁版與 Python 版結果比對測試 |

## 目前限制與待確認

- 目前支援 4 個科系；新增科系只要依應修科目表寫一份規則檔（每份都會用 PDF 的「必修科目計 N 學分」核對）
- 規則型別：必修、擇N（如經濟系六科擇三）、國文/外文/通識（可設超修認列上限）、體育/服務學習次數、本系選修學分、學程必修門數、管院數位素養、選修總學分、外系認列上限（如資管系 12 學分）
- 通識核心四領域的歸屬資料尚未取得
- 同一門課能否同時認列「系選修」與「學分學程」、兩學程重疊課程能否重複認列，需向系辦確認（程式目前預設可以）
- 本工具僅供參考，最終以系辦與註冊組審核為準
- ## 作者
- 企管2A張育晨
