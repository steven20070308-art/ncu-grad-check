"""畢業學分檢核 Agent：AI 負責「讀」與「說」，程式負責「算」與「查」。

流程（每一步都可單獨測試）：
  1. 解析 Parser    ：貼上的成績頁文字 → 修課紀錄 JSON（先用規則解析，失敗才交給 AI）
  2. 路由 Router    ：問題裡有課號 → 走「試算」；沒有 → 走「解釋」
  3. 計算 Engine    ：engine.py 規則引擎算學分（AI 不碰數字計算）
  4. 解釋 Explainer ：AI 把檢核報告翻成白話，只能引用報告裡的數字
  5. 稽核 Auditor   ：檢查 AI 回答中的每個數字都出現在報告裡，否則標記「請人工確認」

AI 服務採 OpenAI 相容格式，可接 Google Gemini、Azure OpenAI、OpenAI 或本機 Ollama。
（GitHub Models 已於 2026-07-30 停止服務，不可使用）
設定環境變數（請放在 .env，不要上傳 GitHub）：
  LLM_BASE_URL  例：https://generativelanguage.googleapis.com/v1beta/openai
  LLM_API_KEY   你的金鑰
  LLM_MODEL     例：gemini-3.8-flash
沒有設定時自動使用離線模擬模式（--mock），方便測試流程。

用法：
  python agent.py --paste data/sample_paste.txt --ask "我還差多少學分才能畢業？"
  python agent.py --paste data/sample_paste.txt --ask "如果我修 BA5040 BA7114 BA5061 會怎樣？"
"""
import argparse
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.request

import engine

def load_env(path=".env"):
    """讀取 .env 檔（KEY=VALUE 格式）放進環境變數；不需要額外安裝套件。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                k = k.strip().lstrip("\ufeff")
                v = v.strip().strip('"').strip("'")
                os.environ.setdefault(k, v)


load_env()

ATTRS = ("必修", "選修", "通識", "體育", "勞動服務", "軍訓")
CODE_RE = re.compile(r"^([A-Z]{2,3}\d{4})\b", re.M)
TERM_RE = re.compile(r"第\s*(\d+)\s*學年度第\s*(\d)\s*學期")


# ---------- 1. 解析 ----------
def parse_transcript(text):
    """把從成績查詢頁複製貼上的文字解析成修課紀錄。

    回傳 (records, problems)。problems 是解析不出來的片段，之後交給 AI 或人工處理。
    """
    records, problems = [], []
    # 依「第X學年度第Y學期」切段，記住每門課屬於哪一學期
    marks = [(m.start(), f"{m.group(1)}-{m.group(2)}") for m in TERM_RE.finditer(text)]
    starts = [m.start() for m in CODE_RE.finditer(text)] + [len(text)]
    for i, (code_m) in enumerate(CODE_RE.finditer(text)):
        chunk = text[code_m.start():starts[i + 1]]
        term = next((t for pos, t in reversed(marks) if pos < code_m.start()), "未知")
        tokens = [t.strip() for t in re.split(r"[\t\n]", chunk) if t.strip()]
        try:
            a = next(j for j, t in enumerate(tokens) if t in ATTRS)
            name = next(t for t in tokens[1:a] if re.search(r"[一-鿿]", t))
            credits = int(tokens[a + 2])   # 屬性 → 學制 → 學分數
            grade = tokens[a + 3]          # 成績（數字、未到、勞動服務通過…）
        except (StopIteration, IndexError, ValueError):
            problems.append(chunk.strip()[:80])
            continue
        records.append({"term": term, "code": code_m.group(1), "name": name,
                        "attr": tokens[a], "credits": credits, "grade": grade})
    return records, problems


def agent_records_ok(text):
    """防呆：一門課都解析不到時不該繼續，否則會回答「還差 128 學分」這種錯誤結論。"""
    records, _ = parse_transcript(text)
    return len(records) > 0


# ---------- LLM 呼叫 ----------
TIMEOUT = int(os.getenv("LLM_TIMEOUT", "40"))  # 秒；每次等候上限
RETRY_CODES = {429, 500, 502, 503, 504}  # 暫時性錯誤：服務忙碌、超過頻率限制


LAST_MODEL = None


class AIUnavailable(Exception):
    """AI 服務暫時無法使用（重試後仍失敗）。"""


def llm_chat(messages, mock=False):
    base, key, model = (os.getenv("LLM_BASE_URL"), os.getenv("LLM_API_KEY"), os.getenv("LLM_MODEL"))
    if mock or not (base and key and model):
        return mock_llm(messages)
    # 備援模型可用逗號分隔多個，依序嘗試
    models = [model] + [m.strip() for m in os.getenv("LLM_FALLBACK_MODEL", "").split(",") if m.strip()]
    last_error = ""
    for m in models:
        tries = 2 if m == model else 1  # 主模型試 2 次，備援模型各試 1 次，避免等太久
        for attempt in range(tries):
            print(f"  …詢問 {m}（最多等 {TIMEOUT} 秒）", flush=True)
            try:
                answer = _call(base, key, m, messages)
                global LAST_MODEL
                LAST_MODEL = m  # 記錄實際回答的模型（可能是備援）
                return answer
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "ignore")[:300]
                if e.code not in RETRY_CODES:
                    raise SystemExit(f"✗ AI 服務回傳錯誤 {e.code}：{detail}\n"
                                     "  401/403 多半是金鑰錯誤或權限不足；404 多半是網址或模型名稱打錯。")
                last_error = f"{m} 回傳 {e.code}"
            except urllib.error.URLError as e:
                if isinstance(e.reason, TimeoutError):
                    last_error = f"{m} 逾時"
                else:
                    raise SystemExit(f"✗ 連不上 AI 服務：{e.reason}\n  請確認網路連線與 .env 裡的 LLM_BASE_URL。")
            except (TimeoutError, ConnectionError, http.client.HTTPException) as e:
                # 等候回應時逾時或連線被中斷：同樣視為暫時性錯誤
                last_error = f"{m} {'逾時' if isinstance(e, TimeoutError) else '連線中斷'}"
            print(f"  …{last_error}", flush=True)
            if attempt < tries - 1:
                time.sleep(2)
    raise AIUnavailable(last_error)


def _call(base, key, model, messages):
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.2}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        body = resp.read().decode("utf-8", "ignore")
        status, final_url = resp.status, resp.geturl()
        ctype = resp.headers.get("Content-Type", "")
    try:
        return json.loads(body)["choices"][0]["message"]["content"]
    except (json.JSONDecodeError, KeyError, IndexError):
        # 回應不是預期的 JSON：把診斷資訊印出來（不含金鑰），方便判斷是網址錯還是服務異常
        raise SystemExit(
            "✗ AI 服務的回應格式不對，無法讀取回答。\n"
            f"  呼叫網址：{req.full_url}\n  實際網址：{final_url}\n"
            f"  狀態碼：{status}　內容類型：{ctype or '(無)'}\n"
            f"  回應開頭：{body[:200] or '(空白)'}\n"
            "  若回應是網頁(HTML)或空白，多半是 .env 的 LLM_BASE_URL 打錯。")


def mock_llm(messages):
    """離線模擬：直接從報告挑重點組成回答，用來測試流程與稽核。"""
    rep = json.loads(messages[-1]["content"].split("【檢核報告】", 1)[1])
    return "（模擬回答）" + template_answer(rep)


def template_answer(rep):
    """不經 AI、直接由檢核報告組成的回答。AI 無法使用時的備援。"""
    t = rep["main"]["total"]
    lines = [f"你目前認列 {t['got']} 學分，畢業需要 {t['need']} 學分，還差 {t['need'] - t['got']} 學分。"]
    for b in rep["main"]["buckets"]:
        if b["got"] < b["need"]:
            lines.append(f"{b['id']}還差 {b['need'] - b['got']} 學分。")
    if "before" in rep:
        lines.append(f"加入試算課程前是 {rep['before']['total']['got']} 學分。")
    return "\n".join(lines)


# ---------- 2. 路由 + 3. 計算 ----------
def run_engine(records, rules, programs, project=True):
    """跑規則引擎，並整理成給 AI 的摘要（欄位與網頁版 slimReport 一致）。"""
    main = engine.check(rules, records, programs, project)
    # 只留 AI 需要的欄位，降低 token 用量
    return {
        "total": main["total"],
        "credit_status": {"已取得": main["earned"], "修課中或試算(預計)": main["ongoing"],
                          "說明": "total.got 已包含修課中與試算的預計學分，尚未真正取得"},
        "required": {g: {"done": v["done_credits"], "need": v["need_credits"],
                         "todo": [f"{c['name']} {c['codes'][0]}（{c['term']}）" for c in v["todo"]]}
                     for g, v in main["required"].items()},
        "choose": [{"id": g["id"], "got": g["got"], "need": g["pick"], "courses": g["courses"],
                    "可選": [f"{c['name']} {c['codes'][0]}" for c in g["options"]]} for g in main["choose"]],
        "buckets": [{k: b[k] for k in ("id", "got", "need", "note")} for b in main["buckets"]],
        "counts": [{k: c[k] for k in ("id", "got", "need", "note")} for c in main["counts"]],
        "electives": [{k: e[k] for k in ("id", "got_courses", "got_credits", "need_courses", "need_credits", "note")}
                      for e in main["electives"]],
        "caps": main["caps"],
        "free_elective_credits": main["free_elective_credits"],
        "programs": {k: {"name": v["name"], "credits": v["credits"], "need": v["need"], "done": v["done"],
                         "groups": [{k2: g[k2] for k2 in ("id", "got", "need", "courses")} for g in v["groups"]],
                         "必修必選可選課號": {g["id"]: g["options"] for g in v["groups"] if g["id"] != "選修"}}
                     for k, v in main["programs"].items()},
    }


def find_course_codes(question):
    return re.findall(r"\b([A-Z]{2,3}\d{4})\b", question.upper())


def planned_records(codes, programs):
    """把問題中的課號變成「預計修」紀錄；學分從學程課表查，查不到預設 3 並標記。"""
    lookup = {}
    for p in programs.values():
        for g in p["groups"]:
            lookup.update(g["courses"])
    recs, unknown = [], []
    for c in codes:
        if c not in lookup:
            unknown.append(c)
        recs.append({"term": "試算", "code": c, "name": f"試算課程 {c}", "attr": "選修",
                     "credits": lookup.get(c, 3), "grade": "未到"})
    return recs, unknown


# ---------- 4. 解釋 ----------
SYSTEM_PROMPT = """你是中央大學的畢業學分顧問。
規則：
1. 所有數字只能來自【檢核報告】，不可自行加總、推算或猜測。
2. 報告標示「待確認」「note」的地方，要提醒學生向系辦確認，不可替系辦下結論。
3. 用繁體中文、口語、條列，先講結論再講細節，200 字以內。
4. 若有 before（試算前）與 main（試算後），要說明修這些課之後改變了什麼。
5. total.got 含修課中的預計學分，要分開講「已取得」與「修課中」，不可說成已修得。
6. 建議學程課程時，只能從報告的「必修必選可選課號」挑，並說明每組要修幾門。"""


def explain(question, report, mock=False):
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"學生問題：{question}\n【檢核報告】{json.dumps(report, ensure_ascii=False)}"}]
    return llm_chat(messages, mock)


# ---------- 5. 稽核 ----------
def numbers_in(obj):
    found = set()
    if isinstance(obj, dict):
        for v in obj.values():
            found |= numbers_in(v)
    elif isinstance(obj, list):
        for v in obj:
            found |= numbers_in(v)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        found.add(int(obj))
    elif isinstance(obj, str):
        found |= {int(n) for n in re.findall(r"\d+", obj)}
    return found


def audit(answer, report, question):
    """回答中出現、但報告和問題都沒有的數字 → 可能是 AI 自己算或編的。

    允許「需求 - 已得」這種差值，因為那是報告兩欄直接相減。
    """
    allowed = numbers_in(report) | numbers_in(question)
    allowed |= {a - b for a in allowed for b in allowed if 0 <= a - b <= 200}
    in_answer = {int(n) for n in re.findall(r"\d+", re.sub(r"[A-Z]{2,3}\d{4}", "", answer))}
    return sorted(in_answer - allowed)


# ---------- 主流程 ----------
def run(paste_text, question, rules, programs, mock=False):
    records, problems = parse_transcript(paste_text)
    result = {"parsed_courses": len(records), "parse_problems": problems}

    codes = find_course_codes(question)
    if codes:  # 路由：試算
        plan, unknown = planned_records(codes, programs)
        report = {"before": run_engine(records, rules, programs),
                  "main": run_engine(records + plan, rules, programs),
                  "planned": codes, "unknown_codes": unknown}
        result["route"] = "試算"
    else:      # 路由：解釋
        report = {"main": run_engine(records, rules, programs)}
        result["route"] = "解釋"

    try:
        answer = explain(question, report, mock)
    except AIUnavailable as e:
        # 降級：AI 忙碌時改用程式直接產生的結果，學生仍拿得到正確數字
        answer = template_answer(report)
        result["notice"] = f"AI 暫時無法使用（{e}），以下為程式直接產生的結果"
        result["route"] += "（AI 降級）"
    suspicious = audit(answer, report, question)
    result.update({"answer": answer, "audit_flags": suspicious, "report": report})
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="畢業學分檢核 Agent")
    ap.add_argument("--paste", required=True, help="從成績查詢頁複製貼上的文字檔")
    ap.add_argument("--ask", required=True, help="要問的問題")
    ap.add_argument("--rules", default="rules/ba_114.json")
    ap.add_argument("--programs", default="rules/programs_114.json")
    ap.add_argument("--mock", action="store_true", help="不呼叫 AI，用離線模擬")
    ap.add_argument("--show-report", action="store_true")
    args = ap.parse_args()

    with open(args.rules, encoding="utf-8") as f:
        rules = json.load(f)
    with open(args.programs, encoding="utf-8") as f:
        programs = json.load(f)
    programs.pop("open_questions", None)
    with open(args.paste, encoding="utf-8") as f:
        text = f.read()

    if not agent_records_ok(text):
        raise SystemExit("✗ 解析：沒有讀到任何課程，已停止（避免把 0 學分當成真的結果）。\n"
                         "  請確認檔案內容是成績表格，或把檔案傳給開發者檢查格式。")
    out = run(text, args.ask, rules, programs, args.mock)
    print(f"[解析] {out['parsed_courses']} 門課；無法解析 {len(out['parse_problems'])} 段")
    using_ai = not args.mock and all(os.getenv(k) for k in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"))
    ai_label = (LAST_MODEL or f"{os.getenv('LLM_MODEL')}(未成功)") if using_ai else "離線模擬"
    print(f"[路由] {out['route']}　[AI] {ai_label}\n")
    if out.get("notice"):
        print(f"⚠ {out['notice']}")
    print(out["answer"])
    if out["audit_flags"]:
        print(f"\n⚠ 稽核：回答中的數字 {out['audit_flags']} 不在檢核報告內，請人工確認")
    else:
        print("\n✓ 稽核：回答中的數字都能在檢核報告找到")
    if args.show_report:
        print(json.dumps(out["report"], ensure_ascii=False, indent=2))
