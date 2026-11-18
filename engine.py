"""畢業學分檢核引擎（規則引擎，不使用 AI）。

計算一律由程式完成，結果可重現、可驗證；AI 只負責解析輸入與白話解釋。
用法：python engine.py rules/ba_114.json data/steven_transcript.json
"""
import json
import sys

PASS_SCORE = 60


PROJECT = False  # True 時把「未到」(修課中)視為預計及格，用來試算本學期修完後的狀態
IN_PROGRESS = ("未到",)


def passed(record):
    """及格判定：數字成績 >= 60，或文字成績含「通過」。"""
    grade = str(record.get("grade", "")).strip()
    if "通過" in grade:
        return True
    if PROJECT and grade in IN_PROGRESS:
        return True
    try:
        return float(grade) >= PASS_SCORE
    except ValueError:
        return False  # 停修、未到、空白等一律視為未取得


def matches(record, rule):
    """判斷一筆修課紀錄是否符合規則的 match 條件。"""
    m = rule.get("match", {})
    if "code_prefix" in m and not any(record["code"].startswith(p) for p in m["code_prefix"]):
        return False
    if "attr" in m and record["attr"] not in m["attr"]:
        return False
    if any(word in record["name"] for word in rule.get("exclude_name_contains", [])):
        return False
    return True


def check_program(program, transcript):
    """檢核單一學分學程：各組最低門數 + 總學分，實習至多認列上限。"""
    records = [r for r in transcript if passed(r)]
    result = {"name": program["name"], "groups": [], "credits": 0}
    counted = set()
    for g in program["groups"]:
        hits = [r for r in records if r["code"] in g["courses"] and r["code"] not in counted]
        counted.update(r["code"] for r in hits)
        result["groups"].append({"id": g["id"], "got": len(hits), "need": g["min_courses"],
                                 "courses": [r["code"] for r in hits]})
    intern = [r for r in records if any(r["code"].startswith(p) for p in program["internship_prefix"])]
    intern_credits = min(sum(r["credits"] for r in intern), program["internship_max_credits"])
    result["credits"] = sum(r["credits"] for r in records if r["code"] in counted) + intern_credits
    result["need"] = program["min_credits"]
    result["done"] = result["credits"] >= result["need"] and all(
        g["got"] >= g["need"] for g in result["groups"])
    return result


def check(rules, transcript, programs=None):
    records = [r for r in transcript if passed(r)]
    failed = [r for r in transcript if not passed(r)]
    used = set()  # 已被某一類別認列的課號，避免同一門課重複計算
    report = {"required": {}, "buckets": [], "counts": [], "electives": {}, "notes": []}

    # 1. 必修科目：依課號逐門比對
    for group, courses in rules["required_courses"].items():
        done, todo = [], []
        for c in courses:
            hit = next((r for r in records if r["code"] in c["codes"] and r["code"] not in used), None)
            if hit:
                used.add(hit["code"])
                done.append(c)
            else:
                todo.append(c)
        report["required"][group] = {
            "done_credits": sum(c["credits"] for c in done),
            "need_credits": sum(c["credits"] for c in courses),
            "todo": todo,
        }

    # 2. 學分類別（國文、外文、通識）
    for b in rules["credit_buckets"]:
        hits = [r for r in records if r["code"] not in used and matches(r, b)]
        got = sum(r["credits"] for r in hits)
        used.update(r["code"] for r in hits)
        report["buckets"].append({"id": b["id"], "got": got, "need": b["min_credits"],
                                  "courses": [r["code"] for r in hits], "note": b.get("note")})

    # 3. 次數類（體育、服務學習）
    for c in rules["count_requirements"]:
        hits = [r for r in records if matches(r, c)]
        used.update(r["code"] for r in hits)
        report["counts"].append({"id": c["id"], "got": len(hits), "need": c["min_count"], "note": c.get("note")})

    # 4. 選修：(a) 學程必修/必選課 2 門 (b) 本系課號選修 3 門 8 學分
    e = rules["electives"]
    program_core = set()
    for p in (programs or {}).values():
        for g in p["groups"]:
            if g["id"] != "選修":
                program_core.update(g["courses"])
    prog = [r for r in records if r["code"] not in used and r["code"] in program_core]
    prog = prog[:e["program_part"]["min_courses"]]  # 只取需要的門數，其餘可算本系選修
    used.update(r["code"] for r in prog)
    dept = [r for r in records if r["code"] not in used
            and any(r["code"].startswith(p) for p in e["dept_part"]["code_prefix"])]
    used.update(r["code"] for r in dept)
    report["electives"] = {
        "dept_courses": len(dept), "dept_credits": sum(r["credits"] for r in dept),
        "dept_need": e["dept_part"],
        "program_courses": [r["code"] for r in prog],
        "program_need": e["program_part"],
    }

    # 5. 其餘及格課程 = 自由選修
    free = [r for r in records if r["code"] not in used and r["credits"] > 0]
    total = sum(r["credits"] for r in records if not any(
        w in r["name"] for w in ["進修英文"]))
    report["free_elective_credits"] = sum(r["credits"] for r in free)
    report["total"] = {"got": total, "need": rules["min_total_credits"]}
    report["failed"] = failed
    report["notes"] = rules["warnings"]
    return report


def print_report(rules, rep):
    print(f"=== {rules['dept']} {rules['entry_year']} 學年度入學 畢業學分檢核 ===\n")
    t = rep["total"]
    print(f"總學分：{t['got']} / {t['need']}（還差 {max(0, t['need'] - t['got'])}）\n")

    for group, g in rep["required"].items():
        print(f"【{group}】{g['done_credits']} / {g['need_credits']}")
        for c in g["todo"]:
            print(f"   - 未修：{c['name']} {c['codes'][0]}（{c['credits']}學分，建議 {c['term']}）")
    print()
    for b in rep["buckets"]:
        status = "✓" if b["got"] >= b["need"] else f"還差 {b['need'] - b['got']}"
        print(f"【{b['id']}】{b['got']} / {b['need']}  {status}")
        if b["note"]:
            print(f"   ⚠ {b['note']}")
    for c in rep["counts"]:
        status = "✓" if c["got"] >= c["need"] else f"還差 {c['need'] - c['got']} 次"
        print(f"【{c['id']}】{c['got']} / {c['need']} 次  {status}")
        if c["note"]:
            print(f"   ⚠ {c['note']}")
    e = rep["electives"]
    print(f"\n【選修】本系課號 {e['dept_courses']} 門 {e['dept_credits']} 學分"
          f"（需 {e['dept_need']['min_courses']} 門 {e['dept_need']['min_credits']} 學分）")
    print(f"   學程必修/必選：已有 {len(e['program_courses'])} 門 {e['program_courses']}"
          f"（需 {e['program_need']['min_courses']} 門，{e['program_need']['from']}）")
    print(f"【自由選修】目前 {rep['free_elective_credits']} 學分")
    if rep["failed"]:
        print("\n未通過課程：", ", ".join(r["code"] for r in rep["failed"]))
    print("\n提醒：")
    for n in rep["notes"]:
        print(f" - {n}")


def print_programs(programs, transcript):
    print("\n=== 學分學程 ===")
    for key, p in programs.items():
        if key == "open_questions":
            continue
        r = check_program(p, transcript)
        mark = "✓ 已修畢" if r["done"] else f"還差 {max(0, r['need'] - r['credits'])} 學分"
        print(f"【{r['name']}】{r['credits']} / {r['need']}  {mark}")
        for g in r["groups"]:
            if g["need"]:
                ok = "✓" if g["got"] >= g["need"] else f"還差 {g['need'] - g['got']} 門"
                print(f"   {g['id']}：{g['got']} / {g['need']} 門 {ok}")
    print("\n待確認：")
    for q in programs["open_questions"] if "open_questions" in programs else []:
        print(f" - {q}")


if __name__ == "__main__":
    # 用法：python engine.py 規則檔 學程檔 成績檔1 [成績檔2 ...] [--project]
    args = [a for a in sys.argv[1:] if a != "--project"]
    PROJECT = "--project" in sys.argv
    with open(args[0], encoding="utf-8") as f:
        rules = json.load(f)
    with open(args[1], encoding="utf-8") as f:
        programs = json.load(f)
    questions = programs.pop("open_questions", [])
    transcript = []
    for path in args[2:]:
        with open(path, encoding="utf-8") as f:
            transcript += json.load(f)
    if PROJECT:
        print("※ 試算模式：本學期修課中的課程視為及格\n")
    print_report(rules, check(rules, transcript, programs))
    programs["open_questions"] = questions
    print_programs(programs, transcript)
