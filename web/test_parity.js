// 網頁版（JavaScript）與 Python 版逐項比對。
// 每個科系各產生 60 份隨機成績單（含修課中、不及格、超修通識、外系選修、實習等情況），
// 兩邊各算一次，所有欄位都要一模一樣。執行：node web/test_parity.js
const { execFileSync } = require("child_process");
const fs = require("fs");
const G = require("./gradcheck.js");

const DEPTS = ["ba_114", "ec_114", "fm_113", "im_114", "op_114"];
const programs = JSON.parse(fs.readFileSync("rules/programs_114.json", "utf8")).programs;
const ALL = Object.keys(programs);

// 固定亂數種子，讓測試可重現
let seed = 20261118;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function randomTranscript(rules) {
  const pool = [];
  Object.values(rules.required_courses).flat().forEach((c) => pool.push([c.codes[0], c.credits, "必修"]));
  (rules.choose_groups || []).forEach((g) => g.courses.forEach((c) => pool.push([c.codes[0], c.credits, "選修"])));
  Object.values(programs).forEach((p) => p.groups.forEach((g) =>
    Object.entries(g.courses).forEach(([k, cr]) => pool.push([k, cr, "選修"]))));
  ["BA5002", "BA7042", "EC3001", "EC5005", "FM3005", "FM6001", "IM3058", "IM5001", "HR3001", "LS2001", "MT4012", "MT4013"]
    .forEach((k) => pool.push([k, k.startsWith("MT4") ? 2 : 3, "選修"]));
  const recs = [];
  const seen = new Set();
  const n = 15 + Math.floor(rand() * 45);
  for (let i = 0; i < n; i++) {
    const [code, credits, attr] = pick(pool);
    if (seen.has(code)) continue;
    seen.add(code);
    recs.push({ term: "t", code, name: code, attr, credits, grade: pick(["85", "72", "60", "45", "未到", "90"]) });
  }
  for (let i = 0; i < Math.floor(rand() * 12); i++)
    recs.push({ term: "t", code: `GS4${100 + i}`, name: "通識", attr: "通識", credits: pick([2, 3]), grade: pick(["80", "未到", "50"]) });
  recs.push({ term: "t", code: "CL0201", name: "國文", attr: "必修", credits: 2, grade: "80" });
  recs.push({ term: "t", code: "LN1005", name: "大一英文", attr: "必修", credits: 3, grade: pick(["80", "未到"]) });
  if (rand() < 0.3) recs.push({ term: "t", code: "LN2001", name: "進修英文", attr: "選修", credits: 2, grade: "80" });
  for (let i = 0; i < Math.floor(rand() * 6); i++)
    recs.push({ term: "t", code: `PE10${10 + i}`, name: "體育", attr: "體育", credits: 0, grade: "80" });
  recs.push({ term: "t", code: "SC0003", name: "服務學習課程", attr: "勞動服務", credits: 0, grade: "勞動服務通過" });
  return recs;
}

// 只比對有意義的欄位（排除課程物件裡的說明文字）
function shape(rep) {
  return {
    total: rep.total, earned: rep.earned, ongoing: rep.ongoing,
    required: Object.fromEntries(Object.entries(rep.required).map(([g, v]) => [g, [v.done_credits, v.need_credits, v.todo.map((c) => c.codes[0])]])),
    choose: rep.choose.map((g) => [g.id, g.got, g.courses, g.options.map((c) => c.codes[0])]),
    buckets: rep.buckets.map((b) => [b.id, b.got, b.overflow, b.courses]),
    counts: rep.counts.map((c) => [c.id, c.got]),
    electives: rep.electives.map((e) => [e.id, e.got_courses, e.got_credits, e.done, e.courses]),
    caps: rep.caps.map((c) => [c.id, c.got, c.counted]),
    free: rep.free_elective_credits,
    grad: [rep.graduation.graduated, rep.graduation.min_more, rep.graduation.unmet.map((u) => u.id + u.gap)],
    failed: rep.failed.map((r) => r.code),
    programs: Object.fromEntries(Object.entries(rep.programs).map(([k, v]) => [k, [v.credits, v.done, v.eligible, v.manual, v.courses, v.groups.map((g) => [g.got, g.got_credits, g.got_categories, g.done])]])),
  };
}

const cases = {};
for (const id of DEPTS) {
  const rules = JSON.parse(fs.readFileSync(`rules/${id}.json`, "utf8"));
  cases[id] = Array.from({ length: 60 }, () => randomTranscript(rules));
}
fs.writeFileSync("/tmp/parity_cases.json", JSON.stringify(cases));

const pyOut = JSON.parse(execFileSync("python3", ["-c", `
import json, engine
cases = json.load(open('/tmp/parity_cases.json', encoding='utf-8'))
p = json.load(open('rules/programs_114.json', encoding='utf-8'))['programs']
def shape(rep):
    return {
      'total': rep['total'], 'earned': rep['earned'], 'ongoing': rep['ongoing'],
      'required': {g: [v['done_credits'], v['need_credits'], [c['codes'][0] for c in v['todo']]] for g, v in rep['required'].items()},
      'choose': [[g['id'], g['got'], g['courses'], [c['codes'][0] for c in g['options']]] for g in rep['choose']],
      'buckets': [[b['id'], b['got'], b['overflow'], b['courses']] for b in rep['buckets']],
      'counts': [[c['id'], c['got']] for c in rep['counts']],
      'electives': [[e['id'], e['got_courses'], e['got_credits'], e['done'], e['courses']] for e in rep['electives']],
      'caps': [[c['id'], c['got'], c['counted']] for c in rep['caps']],
      'free': rep['free_elective_credits'],
      'grad': [rep['graduation']['graduated'], rep['graduation']['min_more'], [u['id'] + str(u['gap']) for u in rep['graduation']['unmet']]],
      'failed': [r['code'] for r in rep['failed']],
      'programs': {k: [v['credits'], v['done'], v['eligible'], v['manual'], v['courses'], [[g['got'], g['got_credits'], g['got_categories'], g['done']] for g in v['groups']]] for k, v in rep['programs'].items()},
    }
out = {}
for d, ts in cases.items():
    r = json.load(open(f'rules/{d}.json', encoding='utf-8'))
    out[d] = [[shape(engine.check(r, t, p, proj, list(p))) for proj in (False, True)] for t in ts]
print(json.dumps(out, ensure_ascii=False))
`], { maxBuffer: 64 * 1024 * 1024 }).toString());

let fail = 0, total = 0;
for (const id of DEPTS) {
  const rules = JSON.parse(fs.readFileSync(`rules/${id}.json`, "utf8"));
  cases[id].forEach((t, i) => [false, true].forEach((proj, j) => {
    total++;
    const js = JSON.stringify(shape(G.check(rules, t, programs, proj, ALL)));
    const py = JSON.stringify(pyOut[id][i][j]);
    if (js !== py) {
      fail++;
      if (fail <= 3) console.log(`✗ ${id} 第${i}份 ${proj ? "試算" : "已取得"}\n  JS ${js.slice(0, 400)}\n  PY ${py.slice(0, 400)}`);
    }
  }));
}

// 成績頁解析、稽核、手動輸入
const ba = JSON.parse(fs.readFileSync("rules/ba_114.json", "utf8"));
const { records } = G.parseTable(fs.readFileSync("data/sample_paste.txt", "utf8"));
const eq = (label, a, b) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; console.log("✗", label, JSON.stringify(a), "≠", JSON.stringify(b)); } };
eq("範例成績頁門數", records.length, 29);
eq("範例總學分(試算)", G.check(ba, records, programs, true).total, { got: 69, need: 128 });
eq("未勾選學程時不顯示學程", Object.keys(G.check(ba, records, programs, true).programs), []);
const both = [{ term: "t", code: "BA3004", name: "x", attr: "必修", credits: 3, grade: "80" }, { term: "t", code: "IM1018", name: "x", attr: "必修", credits: 3, grade: "80" }];
eq("企管學程：BA3004 與 IM1018 只算一門", G.checkProgram(programs.BA, both, false, { college: "經濟" }).groups[0].got, 1);
eq("企管學程：管院學生不可修", G.checkProgram(programs.BA, both, false, ba).eligible, false);
const intl = ["CC0421","CC0418","GS3126","GS3224","GS3225"].map((code) => ({ term: "t", code, name: code, attr: "通識", credits: 2, grade: "80" }));
eq("國際事務：外交決策最多採計 8 學分", G.checkProgram(programs.INTL, intl, false, ba).groups[1].got_credits, 8);
eq("AI跨域：管院學生不適用理工版", G.checkProgram(programs.AI_STEM, [], false, ba).eligible, false);
eq("AI跨域：管院學生適用文管客版", G.checkProgram(programs.AI_HUM, [], false, ba).eligible, true);
eq("認知神經：無法自動檢核", G.checkProgram(programs.COGNEURO, intl, false, ba).done, false);
const report = { main: { total: { got: 69, need: 128 } } };
eq("稽核-差值", G.audit("你還差 59 學分", report, ""), []);
eq("稽核-編造", G.audit("你還差 50 學分", report, ""), [50]);
eq("稽核-課號", G.audit("修 BA5040 之後還差 59", report, ""), []);
const m = G.parse("BA1003 98\nGS3096\nPE1011 85\nBA5040 修課中\nXX\n", G.buildCatalog(ba, programs));
eq("手動-學分查表", m.records.map((r) => r.credits), [3, 3, 0, 3]);
eq("手動-修課中", m.records[3].grade, "未到");
eq("手動-無法解析", m.problems, ["XX"]);

console.log(fail ? `✗ ${fail} / ${total} 項不一致` : `✓ ${total} 項全部一致：${DEPTS.length} 個科系 × 60 份隨機成績單 × 2 種模式，加上解析與稽核`);
process.exit(fail ? 1 : 0);
