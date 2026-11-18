"""測試：解析器要跟手工輸入的資料完全一致；稽核要抓得到 AI 編造的數字。
執行：python test_agent.py
"""
import json

import agent

with open("data/sample_paste.txt", encoding="utf-8") as f:
    records, problems = agent.parse_transcript(f.read())
with open("data/sample_transcript.json", encoding="utf-8") as f:
    hand = json.load(f)


def key(r):
    return (r["term"], r["code"], r["attr"], r["credits"], str(r["grade"]).replace(".00", ""))


# 1. 解析結果與手工資料逐筆比對
assert not problems, problems
assert len(records) == len(hand), (len(records), len(hand))
mismatch = set(map(key, records)) ^ set(map(key, hand))
assert not mismatch, mismatch
print(f"✓ 解析：{len(records)} 門課與手工輸入完全一致")

# 2. 稽核：報告裡沒有的數字要被抓出來
report = {"main": {"total": {"got": 69, "need": 128}}}
assert agent.audit("你還差 59 學分", report, "") == []          # 128-69，允許
assert agent.audit("你還差 50 學分", report, "") == [50]        # 編造的數字
assert agent.audit("修 BA5040 之後還差 59", report, "") == []   # 課號裡的數字不算
print("✓ 稽核：能抓出不在報告中的數字，課號與差值不誤判")

# 3. 路由：有課號走試算
assert agent.find_course_codes("如果我修 ba5040 跟 BA7114") == ["BA5040", "BA7114"]
assert agent.find_course_codes("我還差多少學分") == []
print("✓ 路由：問題含課號時走試算")

# 及格判定：「一般課程不通過」含「通過」兩字，不能算及格（學長成績單實際案例）
import engine
for g, want in [("一般課程不通過", False), ("勞動服務通過", True), ("通過", True), ("不通過", False), ("59", False), ("60", True), ("停修", False)]:
    assert engine.passed({"grade": g}, False) is want, g
print("✓ 及格判定：「一般課程不通過」不算取得學分")
