"""畢業學分檢核引擎（規則引擎，不使用 AI）。各系共用，規則寫在 rules/*.json。

計算一律由程式完成，結果可重現、可驗證；AI 只負責解析輸入與白話解釋。
網頁版 web/gradcheck.js 是同一套邏輯，web/test_parity.js 會逐項比對兩者結果。

認列順序：必修 → 擇N必修 → 國文/外文/通識 → 體育/服務學習 → 選修規則 → 其餘為自由選修
用法：python engine.py rules/ba_114.json rules/programs_114.json data/sample_transcript.json [--project]
"""
import json
import sys

PASS_SCORE = 60
PROJECT = False  # True 時把「未到」(修課中)視為預計及格，用來試算本學期修完後的狀態
IN_PROGRESS = ("未到",)


def passed(record, project=None):
    """及格判定：數字成績 >= 60，或文字成績含「通過」。"""
    project = PROJECT if project is None else project
    grade = str(record.get("grade", "")).strip()
    if "通過" in grade:
        return True
    if project and grade in IN_PROGRESS:
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


def _sum(rs):
    return sum(r["credits"] for r in rs)


def _has_prefix(code, prefixes):
    return any(code.startswith(p) for p in prefixes or [])


def check_program(program, transcript, project=None, dept_rules=None):
    """檢核單一學分學程：各組最低門數/學分 + 總學分。
    equiv：可互相替代的課號（例：BA3004 或 IM1018）只算一門；實習有認列上限。"""
    records = [r for r in transcript if passed(r, project)]
    counted = set()
    groups = []
    for g in program["groups"]:
        hits = [r for r in records if r["code"] in g["courses"] and r["code"] not in counted]
        for eq in g.get("equiv", []):
            in_eq = [r for r in hits if r["code"] in eq]
            if len(in_eq) > 1:
                hits = [r for r in hits if r not in in_eq[1:]]
        counted.update(r["code"] for r in hits)
        credits = _sum(hits)
        done = len(hits) >= (g.get("min_courses") or 0) and credits >= (g.get("min_credits") or 0)
        groups.append({"id": g["id"], "got": len(hits), "need": g.get("min_courses") or 0, "got_credits": credits,
                       "need_credits": g.get("min_credits"), "done": done,
                       "courses": [r["code"] for r in hits], "options": list(g["courses"])})
    intern = [r for r in records if _has_prefix(r["code"], program.get("internship_prefix"))]
    intern_credits = min(_sum(intern), program.get("internship_max_credits", 0))
    credits = _sum([r for r in records if r["code"] in counted]) + intern_credits
    eligible = (dept_rules or {}).get("college") not in program.get("exclude_colleges", [])
    return {"name": program["name"], "groups": groups, "credits": credits, "need": program["min_credits"],
            "eligible": eligible, "done": credits >= program["min_credits"] and all(g["done"] for g in groups)}


def _program_set(programs, names, core_only, exclude):
    s = set()
    for n in names:
        for g in programs.get(n, {}).get("groups", []):
            if core_only and g["id"] == "選修":
                continue
            s.update(k for k in g["courses"] if not _has_prefix(k, exclude))
    return s


def check(rules, transcript, programs=None, project=None, selected=()):
    project = PROJECT if project is None else project
    programs = programs or {}
    records = [r for r in transcript if passed(r, project)]
    used, elect_used = set(), set()  # used：必修與共同科目；elect_used：選修類擇N與獨占型選修規則
    rep = {"required": {}, "choose": [], "buckets": [], "counts": [], "electives": [], "caps": []}

    # 1. 必修：依課號逐門比對
    for group, courses in rules["required_courses"].items():
        done, todo = [], []
        for c in courses:
            hit = next((r for r in records if r["code"] in c["codes"] and r["code"] not in used), None)
            if hit:
                used.add(hit["code"])
                done.append(c)
            else:
                todo.append(c)
        rep["required"][group] = {"done_credits": sum(c["credits"] for c in done),
                                  "need_credits": sum(c["credits"] for c in courses), "todo": todo}

    # 2. 擇N（例：經濟系六科擇三、財金系法律三擇二）
    for g in rules.get("choose_groups", []):
        codes = [x for c in g["courses"] for x in c["codes"]]
        hits = [r for r in records if r["code"] in codes and r["code"] not in used
                and r["code"] not in elect_used][:g["pick"]]
        (elect_used if g.get("elective") else used).update(r["code"] for r in hits)
        have = [r["code"] for r in hits]
        rep["choose"].append({"id": g["id"], "pick": g["pick"], "got": len(hits), "elective": bool(g.get("elective")),
                              "courses": have, "options": [c for c in g["courses"] if not set(c["codes"]) & set(have)]})

    # 3. 學分類別（國文、外文、通識），超修部分可設認列上限
    bucket_excess, overflow_for_caps = 0, 0
    for b in rules["credit_buckets"]:
        hits = [r for r in records if r["code"] not in used and matches(r, b)]
        used.update(r["code"] for r in hits)
        got = _sum(hits)
        over = max(0, got - b["min_credits"])
        over_max = b.get("overflow_max", float("inf"))
        bucket_excess += max(0, over - over_max)
        if "overflow_max" in b:
            overflow_for_caps += min(over, over_max)
        rep["buckets"].append({"id": b["id"], "got": got, "need": b["min_credits"],
                               "courses": [r["code"] for r in hits], "note": b.get("note"),
                               "overflow": over, "overflow_max": b.get("overflow_max")})

    # 4. 次數類（體育、服務學習）
    for c in rules["count_requirements"]:
        hits = [r for r in records if matches(r, c)]
        used.update(r["code"] for r in hits)
        rep["counts"].append({"id": c["id"], "got": len(hits), "need": c["min_count"], "note": c.get("note")})

    # 5. 選修規則（各系不同）
    for e in rules.get("elective_rules", []):
        t = e["type"]
        if t == "program_core":
            s = _program_set(programs, e["programs"], True, [])
            hits = [r for r in records if r["code"] not in used and r["code"] not in elect_used
                    and r["code"] in s][:e["min_courses"]]
        elif t == "prefix":
            hits = [r for r in records if r["code"] not in used and r["credits"] > 0
                    and _has_prefix(r["code"], e["code_prefix"])
                    and (r["code"] not in elect_used or (not e.get("exclusive") and e.get("include_choose")))]
        elif t == "program_set":
            s = _program_set(programs, e["programs"], False, e.get("exclude_prefix"))
            hits = [r for r in records if r["code"] not in used and r["code"] in s]
        elif t == "elective_total":
            hits = [r for r in records if r["code"] not in used and r["credits"] > 0
                    and r["attr"] not in e.get("exclude_attr", [])]
        else:
            raise ValueError(f"未知的選修規則型別：{t}")
        if e.get("exclusive"):
            elect_used.update(r["code"] for r in hits)
        res = {"id": e["id"], "type": t, "got_courses": len(hits), "got_credits": _sum(hits),
               "need_courses": e.get("min_courses"), "need_credits": e.get("min_credits"),
               "courses": [r["code"] for r in hits], "note": e.get("note")}
        res["done"] = ((res["need_courses"] is None or res["got_courses"] >= res["need_courses"])
                       and (res["need_credits"] is None or res["got_credits"] >= res["need_credits"]))
        rep["electives"].append(res)

    # 6. 認列上限（例：資管系外系選修至多 12 學分）
    choose_codes = {x for g in rules.get("choose_groups", []) for c in g["courses"] for x in c["codes"]}
    cap_excess = 0
    for cap in rules.get("total_caps", []):
        pool = [r for r in records if r["code"] not in used and r["code"] not in choose_codes
                and r["credits"] > 0 and not _has_prefix(r["code"], cap.get("exclude_prefix"))]
        raw = _sum(pool) + overflow_for_caps
        credits = raw
        for sc in cap.get("sub_caps", []):
            sub = _sum([r for r in pool if _has_prefix(r["code"], sc["code_prefix"])])
            credits -= max(0, sub - sc["max"])
        counted = min(credits, cap["max"])
        cap_excess += raw - counted
        rep["caps"].append({"id": cap["id"], "got": credits, "max": cap["max"], "counted": counted,
                            "note": cap.get("note")})

    free = [r for r in records if r["code"] not in used and r["code"] not in elect_used and r["credits"] > 0]
    rep["free_elective_credits"] = _sum(free)
    rep["total"] = {"got": _sum([r for r in records if "進修英文" not in r["name"]]) - bucket_excess - cap_excess,
                    "need": rules["min_total_credits"]}
    rep["earned"] = check(rules, transcript, programs, False, ())["total"]["got"] if project else rep["total"]["got"]
    rep["ongoing"] = rep["total"]["got"] - rep["earned"]
    rep["failed"] = [r for r in transcript if not passed(r, project)
                     and str(r.get("grade", "")).strip() not in IN_PROGRESS]
    # 只檢核使用者勾選的學分學程；學程不影響畢業判定
    rep["programs"] = {k: check_program(programs[k], transcript, project, rules) for k in selected if k in programs}
    rep["notes"] = rules["warnings"]
    rep["graduation"] = graduation_status(rep)
    return rep


def graduation_status(rep):
    """畢業判定：總學分夠「而且」每一項規定都完成才算達到畢業條件（與網頁版 graduationStatus 相同）。"""
    unmet = []
    for g, v in rep["required"].items():
        if v["done_credits"] < v["need_credits"]:
            unmet.append({"id": g, "gap": v["need_credits"] - v["done_credits"], "unit": "學分"})
    for g in rep["choose"]:
        if g["got"] < g["pick"]:
            unmet.append({"id": g["id"], "gap": g["pick"] - g["got"], "unit": "門"})
    for b in rep["buckets"]:
        if b["got"] < b["need"]:
            unmet.append({"id": b["id"], "gap": b["need"] - b["got"], "unit": "學分"})
    for c in rep["counts"]:
        if c["got"] < c["need"]:
            unmet.append({"id": c["id"], "gap": c["need"] - c["got"], "unit": "次"})
    for e in rep["electives"]:
        if e["done"]:
            continue
        if e["need_courses"] and e["got_courses"] < e["need_courses"]:
            unmet.append({"id": e["id"], "gap": e["need_courses"] - e["got_courses"], "unit": "門"})
        else:
            unmet.append({"id": e["id"], "gap": e["need_credits"] - e["got_credits"], "unit": "學分"})
    total_gap = max(0, rep["total"]["need"] - rep["total"]["got"])
    required_gap = (sum(v["need_credits"] - v["done_credits"] for v in rep["required"].values())
                    + sum(3 * max(0, g["pick"] - g["got"]) for g in rep["choose"]))
    return {"graduated": total_gap == 0 and not unmet, "total_gap": total_gap,
            "min_more": max(total_gap, required_gap), "unmet": unmet}


def print_report(rules, rep):
    print(f"=== {rules['dept']} {rules['entry_year']} 學年度入學 畢業學分檢核 ===\n")
    t = rep["total"]
    print(f"總學分：{t['got']} / {t['need']}（已取得 {rep['earned']}、修課中 {rep['ongoing']}）")
    gs = rep["graduation"]
    if gs["graduated"]:
        print("✓ 已達畢業條件\n")
    else:
        items = "、".join(f"{u['id']}還差{u['gap']}{u['unit']}" for u in gs["unmet"])
        print(f"✗ 尚未達畢業條件：至少還要修 {gs['min_more']} 學分" + (f"；未完成：{items}" if items else "") + "\n")
    for group, g in rep["required"].items():
        print(f"【{group}】{g['done_credits']} / {g['need_credits']}")
        for c in g["todo"]:
            print(f"   - 未修：{c['name']} {c['codes'][0]}（{c['credits']}學分，建議 {c['term']}）")
    for g in rep["choose"]:
        print(f"【{g['id']}】{g['got']} / {g['pick']} 門  可選：" + "、".join(c["name"] for c in g["options"]))
    print()
    for b in rep["buckets"]:
        status = "✓" if b["got"] >= b["need"] else f"還差 {b['need'] - b['got']}"
        print(f"【{b['id']}】{b['got']} / {b['need']}  {status}")
        if b["note"]:
            print(f"   ⚠ {b['note']}")
    for c in rep["counts"]:
        status = "✓" if c["got"] >= c["need"] else f"還差 {c['need'] - c['got']} 次"
        print(f"【{c['id']}】{c['got']} / {c['need']} 次  {status}")
    for e in rep["electives"]:
        need = "、".join(x for x in [f"{e['need_courses']} 門" if e["need_courses"] else "",
                                      f"{e['need_credits']} 學分" if e["need_credits"] else ""] if x)
        print(f"【{e['id']}】{e['got_courses']} 門 {e['got_credits']} 學分（需 {need}）{'✓' if e['done'] else ''}")
    for c in rep["caps"]:
        print(f"【{c['id']}】{c['got']} 學分，認列 {c['counted']} / 上限 {c['max']}")
    print(f"【自由選修】目前 {rep['free_elective_credits']} 學分")
    if rep["failed"]:
        print("\n未通過課程：", ", ".join(r["code"] for r in rep["failed"]))
    print("\n提醒：")
    for n in rep["notes"]:
        print(f" - {n}")


def print_programs(rep, questions):
    print("\n=== 學分學程 ===")
    for r in rep["programs"].values():
        mark = "✓ 已修畢" if r["done"] else f"還差 {max(0, r['need'] - r['credits'])} 學分"
        print(f"【{r['name']}】{r['credits']} / {r['need']}  {mark}")
        for g in r["groups"]:
            if g["need"]:
                ok = "✓" if g["got"] >= g["need"] else f"還差 {g['need'] - g['got']} 門"
                print(f"   {g['id']}：{g['got']} / {g['need']} 門 {ok}")
    if questions:
        print("\n待確認：")
        for q in questions:
            print(f" - {q}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--project"]
    PROJECT = "--project" in sys.argv
    with open(args[0], encoding="utf-8") as f:
        rules = json.load(f)
    with open(args[1], encoding="utf-8") as f:
        programs = json.load(f)
    questions = programs.get("open_questions", [])
    programs = programs["programs"]
    transcript = []
    for path in args[2:]:
        with open(path, encoding="utf-8") as f:
            transcript += json.load(f)
    if PROJECT:
        print("※ 試算模式：本學期修課中的課程視為及格\n")
    rep = check(rules, transcript, programs, selected=list(programs))
    print_report(rules, rep)
    print_programs(rep, questions)
