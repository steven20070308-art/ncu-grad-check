// 網頁版與 Python 版逐項比對：python3 -c 產生基準，node 計算後比較
const { execSync } = require("child_process");
const fs = require("fs");
const G = require("./gradcheck.js");
const rules = JSON.parse(fs.readFileSync("rules/ba_114.json", "utf8"));
const programs = JSON.parse(fs.readFileSync("rules/programs_114.json", "utf8"));
delete programs.open_questions;
const text = fs.readFileSync("data/sample_paste.txt", "utf8");
let fail = 0;
const eq = (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fail++; console.log("✗", label, JSON.stringify(a), "≠", JSON.stringify(b)); }
};
for (const project of [false, true]) {
  const py = JSON.parse(execSync(`python3 -c "
import json, agent, engine
recs,_ = agent.parse_transcript(open('data/sample_paste.txt',encoding='utf-8').read())
r = json.load(open('rules/ba_114.json',encoding='utf-8')); p = json.load(open('rules/programs_114.json',encoding='utf-8')); p.pop('open_questions')
engine.PROJECT = ${project ? "True" : "False"}
rep = engine.check(r, recs, p)
progs = {k: engine.check_program(v, recs) for k, v in p.items()}
print(json.dumps({'n': len(recs), 'rep': {k: rep[k] for k in ['total','buckets','counts','free_elective_credits']}, 'req': {g: [v['done_credits'], v['need_credits'], [c['codes'][0] for c in v['todo']]] for g, v in rep['required'].items()}, 'el': [rep['electives']['dept_courses'], rep['electives']['dept_credits'], rep['electives']['program_courses']], 'progs': {k: [v['credits'], v['done'], [g['got'] for g in v['groups']]] for k, v in progs.items()}}, ensure_ascii=False))
"`).toString());
  const { records } = G.parseTable(text);
  const rep = G.check(rules, records, programs, project);
  const tag = project ? "[試算]" : "[已取得]";
  eq(tag + "門數", records.length, py.n);
  eq(tag + "總學分", rep.total, py.rep.total);
  eq(tag + "國文外文通識", rep.buckets, py.rep.buckets);
  eq(tag + "體育服務學習", rep.counts, py.rep.counts);
  eq(tag + "自由選修", rep.free_elective_credits, py.rep.free_elective_credits);
  for (const [g, v] of Object.entries(rep.required))
    eq(tag + g, [v.done_credits, v.need_credits, v.todo.map((c) => c.codes[0])], py.req[g]);
  eq(tag + "選修", [rep.electives.dept_courses, rep.electives.dept_credits, rep.electives.program_courses], py.el);
  for (const [k, v] of Object.entries(rep.programs))
    eq(tag + k, [v.credits, v.done, v.groups.map((g) => g.got)], py.progs[k]);
}
// 稽核行為與 Python 測試相同
const report = { main: { total: { got: 69, need: 128 } } };
eq("稽核-差值", G.audit("你還差 59 學分", report, ""), []);
eq("稽核-編造", G.audit("你還差 50 學分", report, ""), [50]);
eq("稽核-課號", G.audit("修 BA5040 之後還差 59", report, ""), []);
// 手動輸入
const cat = G.buildCatalog(rules, programs);
const m = G.parse("BA1003 98\nGS3096\nPE1011 85\nBA5040 修課中\nXX\n", cat);
eq("手動-門數", m.records.length, 4);
eq("手動-學分查表", m.records.map((r) => r.credits), [3, 3, 0, 3]);
eq("手動-修課中", m.records[3].grade, "未到");
eq("手動-猜學分", m.guessed, ["GS3096"]);
eq("手動-無法解析", m.problems, ["XX"]);
console.log(fail ? `✗ ${fail} 項不一致` : "✓ 網頁版與 Python 版結果完全一致（含試算模式、稽核、手動輸入）");
process.exit(fail ? 1 : 0);
