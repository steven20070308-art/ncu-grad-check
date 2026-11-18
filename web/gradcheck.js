/* 畢業學分檢核核心（瀏覽器版）：與 engine.py / agent.py 的邏輯一致。
 * 純函式、不碰畫面，可在 Node 執行測試（web/test_parity.js 會和 Python 結果逐項比對）。
 */
(function (root) {
  "use strict";

  const PASS_SCORE = 60;
  const IN_PROGRESS = ["未到"];
  const ATTRS = ["必修", "選修", "通識", "體育", "勞動服務", "軍訓"];

  function passed(r, project) {
    const g = String(r.grade ?? "").trim();
    if (g.includes("通過")) return true;
    if (project && IN_PROGRESS.includes(g)) return true;
    const n = Number(g);
    return g !== "" && !Number.isNaN(n) && n >= PASS_SCORE;
  }

  function matches(r, rule) {
    const m = rule.match || {};
    if (m.code_prefix && !m.code_prefix.some((p) => r.code.startsWith(p))) return false;
    if (m.attr && !m.attr.includes(r.attr)) return false;
    if ((rule.exclude_name_contains || []).some((w) => r.name.includes(w))) return false;
    return true;
  }

  // ---------- 解析：成績查詢頁複製的文字 ----------
  function parseTable(text) {
    const records = [], problems = [];
    const termRe = /第\s*(\d+)\s*學年度第\s*(\d)\s*學期/g;
    const marks = [];
    let t;
    while ((t = termRe.exec(text))) marks.push([t.index, `${t[1]}-${t[2]}`]);
    const codeRe = /^([A-Z]{2,3}\d{4})\b/gm;
    const hits = [];
    let c;
    while ((c = codeRe.exec(text))) hits.push([c.index, c[1]]);
    hits.forEach(([pos, code], i) => {
      const chunk = text.slice(pos, i + 1 < hits.length ? hits[i + 1][0] : text.length);
      const term = (marks.filter(([p]) => p < pos).pop() || [0, "未知"])[1];
      const tokens = chunk.split(/[\t\n]/).map((s) => s.trim()).filter(Boolean);
      const a = tokens.findIndex((tk) => ATTRS.includes(tk));
      const name = a > 0 ? tokens.slice(1, a).find((tk) => /[一-鿿]/.test(tk)) : undefined;
      const credits = a >= 0 ? parseInt(tokens[a + 2], 10) : NaN;
      const grade = a >= 0 ? tokens[a + 3] : undefined;
      if (a < 0 || !name || Number.isNaN(credits) || grade === undefined) {
        problems.push(chunk.trim().slice(0, 80));
        return;
      }
      records.push({ term, code, name, attr: tokens[a], credits, grade });
    });
    return { records, problems };
  }

  // ---------- 解析：手動輸入「課號 成績」一行一門 ----------
  function guessAttr(code) {
    if (/^(GS|CC)/.test(code)) return "通識";
    if (code.startsWith("PE")) return "體育";
    if (code.startsWith("SC")) return "勞動服務";
    return "必修";
  }

  function parseManual(text, catalog) {
    const records = [], problems = [], guessed = [];
    text.split(/\n/).forEach((line) => {
      const m = line.trim().toUpperCase().match(/^([A-Z]{2,3}\d{4})\s*(\S+)?/);
      if (!line.trim()) return;
      if (!m) { problems.push(line.trim().slice(0, 80)); return; }
      const code = m[1];
      let grade = m[2] || "通過";
      if (/修課中|未到|進行中/.test(grade)) grade = "未到";
      const attr = guessAttr(code);
      let credits = catalog[code]?.credits;
      if (credits === undefined) {
        credits = attr === "體育" || attr === "勞動服務" ? 0 : 3;
        if (credits) guessed.push(code);
      }
      records.push({ term: "手動輸入", code, name: catalog[code]?.name || code, attr, credits, grade });
    });
    return { records, problems, guessed };
  }

  function parse(text, catalog) {
    const t = parseTable(text);
    if (t.records.length) return { ...t, guessed: [], mode: "成績頁" };
    return { ...parseManual(text, catalog), mode: "手動輸入" };
  }

  // 課號 → 名稱與學分（手動輸入時查學分用）
  function buildCatalog(rules, programs) {
    const cat = {};
    Object.values(rules.required_courses).flat().concat((rules.choose_groups || []).flatMap((g) => g.courses))
      .forEach((c) => c.codes.forEach((code) => (cat[code] = { name: c.name, credits: c.credits })));
    Object.values(programs).forEach((p) => p.groups.forEach((g) =>
      Object.entries(g.courses).forEach(([code, cr]) => { if (!cat[code]) cat[code] = { credits: cr }; })));
    return cat;
  }

  // ---------- 規則引擎 ----------
  function checkProgram(program, transcript, project) {
    const records = transcript.filter((r) => passed(r, project));
    const counted = new Set();
    const groups = program.groups.map((g) => {
      const hits = records.filter((r) => r.code in g.courses && !counted.has(r.code));
      hits.forEach((r) => counted.add(r.code));
      return { id: g.id, got: hits.length, need: g.min_courses, courses: hits.map((r) => r.code),
               options: Object.keys(g.courses) };
    });
    const intern = records.filter((r) => program.internship_prefix.some((p) => r.code.startsWith(p)));
    const internCredits = Math.min(intern.reduce((s, r) => s + r.credits, 0), program.internship_max_credits);
    const credits = records.filter((r) => counted.has(r.code)).reduce((s, r) => s + r.credits, 0) + internCredits;
    return { name: program.name, groups, credits, need: program.min_credits,
             done: credits >= program.min_credits && groups.every((g) => g.got >= g.need) };
  }

  const sum = (rs) => rs.reduce((s, r) => s + r.credits, 0);
  const notEnglishPlus = (r) => !r.name.includes("進修英文");
  const hasPrefix = (code, list) => (list || []).some((p) => code.startsWith(p));

  /* 規則引擎（各系共用）。認列順序：
   * 必修 → 擇N必修 → 國文/外文/通識 → 體育/服務學習 → 選修規則 → 其餘為自由選修。
   * used：已被必修、共同科目認列的課；electUsed：已被選修類「擇N」或獨占型選修規則認列的課。 */
  function check(rules, transcript, programs, project) {
    const records = transcript.filter((r) => passed(r, project));
    const used = new Set(), electUsed = new Set();
    const rep = { required: {}, choose: [], buckets: [], counts: [], electives: [], caps: [] };

    for (const [group, courses] of Object.entries(rules.required_courses)) {
      const done = [], todo = [];
      for (const c of courses) {
        const hit = records.find((r) => c.codes.includes(r.code) && !used.has(r.code));
        if (hit) { used.add(hit.code); done.push(c); } else todo.push(c);
      }
      rep.required[group] = { done_credits: done.reduce((s, c) => s + c.credits, 0),
                              need_credits: courses.reduce((s, c) => s + c.credits, 0), todo };
    }
    for (const g of rules.choose_groups || []) {
      const codes = g.courses.flatMap((c) => c.codes);
      const hits = records.filter((r) => codes.includes(r.code) && !used.has(r.code) && !electUsed.has(r.code)).slice(0, g.pick);
      hits.forEach((r) => (g.elective ? electUsed : used).add(r.code));
      const have = hits.map((r) => r.code);
      rep.choose.push({ id: g.id, pick: g.pick, got: hits.length, elective: !!g.elective, courses: have,
                        options: g.courses.filter((c) => !c.codes.some((x) => have.includes(x))) });
    }
    let bucketExcess = 0, overflowForCaps = 0;
    for (const b of rules.credit_buckets) {
      const hits = records.filter((r) => !used.has(r.code) && matches(r, b));
      hits.forEach((r) => used.add(r.code));
      const got = sum(hits);
      const over = Math.max(0, got - b.min_credits);
      const overMax = b.overflow_max ?? Infinity;
      bucketExcess += Math.max(0, over - overMax);
      if (b.overflow_max !== undefined) overflowForCaps += Math.min(over, overMax);
      rep.buckets.push({ id: b.id, got, need: b.min_credits, courses: hits.map((r) => r.code), note: b.note || null,
                         overflow: over, overflow_max: b.overflow_max ?? null });
    }
    for (const c of rules.count_requirements) {
      const hits = records.filter((r) => matches(r, c));
      hits.forEach((r) => used.add(r.code));
      rep.counts.push({ id: c.id, got: hits.length, need: c.min_count, note: c.note || null });
    }

    const programSet = (names, coreOnly, exclude) => {
      const set = new Set();
      names.forEach((n) => (programs[n]?.groups || []).forEach((g) => {
        if (coreOnly && g.id === "選修") return;
        Object.keys(g.courses).forEach((k) => { if (!hasPrefix(k, exclude)) set.add(k); });
      }));
      return set;
    };
    for (const e of rules.elective_rules || []) {
      let hits = [];
      if (e.type === "program_core") {
        const set = programSet(e.programs, true, []);
        hits = records.filter((r) => !used.has(r.code) && !electUsed.has(r.code) && set.has(r.code)).slice(0, e.min_courses);
      } else if (e.type === "prefix") {
        hits = records.filter((r) => !used.has(r.code) && r.credits > 0 && hasPrefix(r.code, e.code_prefix)
          && (!electUsed.has(r.code) || (!e.exclusive && e.include_choose)));
      } else if (e.type === "program_set") {
        const set = programSet(e.programs, false, e.exclude_prefix);
        hits = records.filter((r) => !used.has(r.code) && set.has(r.code));
      } else if (e.type === "elective_total") {
        hits = records.filter((r) => !used.has(r.code) && r.credits > 0 && !(e.exclude_attr || []).includes(r.attr));
      }
      if (e.exclusive) hits.forEach((r) => electUsed.add(r.code));
      const res = { id: e.id, type: e.type, got_courses: hits.length, got_credits: sum(hits),
                    need_courses: e.min_courses ?? null, need_credits: e.min_credits ?? null,
                    courses: hits.map((r) => r.code), note: e.note || null };
      res.done = (res.need_courses === null || res.got_courses >= res.need_courses)
              && (res.need_credits === null || res.got_credits >= res.need_credits);
      rep.electives.push(res);
    }

    const chooseCodes = new Set((rules.choose_groups || []).flatMap((g) => g.courses.flatMap((c) => c.codes)));
    let capExcess = 0;
    for (const cap of rules.total_caps || []) {
      const pool = records.filter((r) => !used.has(r.code) && !chooseCodes.has(r.code) && r.credits > 0
                                         && !hasPrefix(r.code, cap.exclude_prefix));
      let credits = sum(pool) + overflowForCaps;
      for (const sc of cap.sub_caps || []) {
        const sub = sum(pool.filter((r) => hasPrefix(r.code, sc.code_prefix)));
        credits -= Math.max(0, sub - sc.max);
      }
      const counted = Math.min(credits, cap.max);
      capExcess += credits - counted + (sum(pool) + overflowForCaps - credits);
      rep.caps.push({ id: cap.id, got: credits, max: cap.max, counted, note: cap.note || null });
    }

    const free = records.filter((r) => !used.has(r.code) && !electUsed.has(r.code) && r.credits > 0);
    rep.free_elective_credits = sum(free);
    rep.total = { got: sum(records.filter(notEnglishPlus)) - bucketExcess - capExcess, need: rules.min_total_credits };
    rep.earned = project ? check(rules, transcript, programs, false).total.got : rep.total.got;
    rep.ongoing = rep.total.got - rep.earned;
    rep.failed = transcript.filter((r) => !passed(r, project) && !IN_PROGRESS.includes(String(r.grade).trim()));
    rep.programs = Object.fromEntries(Object.entries(programs).map(([k, p]) => [k, checkProgram(p, transcript, project)]));
    rep.notes = rules.warnings;
    return rep;
  }

  // AI 只拿到摘要，不拿原始成績
  function slimReport(rep) {
    return {
      total: rep.total,
      credit_status: { "已取得": rep.earned, "修課中或試算(預計)": rep.ongoing,
                       "說明": "total.got 已包含修課中與試算的預計學分，尚未真正取得" },
      required: Object.fromEntries(Object.entries(rep.required).map(([g, v]) => [g, {
        done: v.done_credits, need: v.need_credits,
        todo: v.todo.map((c) => `${c.name} ${c.codes[0]}（${c.term}）`) }])),
      choose: rep.choose.map((g) => ({ id: g.id, got: g.got, need: g.pick, courses: g.courses,
        "可選": g.options.map((c) => `${c.name} ${c.codes[0]}`) })),
      buckets: rep.buckets.map(({ id, got, need, note }) => ({ id, got, need, note })),
      counts: rep.counts.map(({ id, got, need, note }) => ({ id, got, need, note })),
      electives: rep.electives.map(({ id, got_courses, got_credits, need_courses, need_credits, note }) =>
        ({ id, got_courses, got_credits, need_courses, need_credits, note })),
      caps: rep.caps,
      free_elective_credits: rep.free_elective_credits,
      programs: Object.fromEntries(Object.entries(rep.programs).map(([k, v]) => [k, {
        name: v.name, credits: v.credits, need: v.need, done: v.done,
        groups: v.groups.map(({ id, got, need, courses }) => ({ id, got, need, courses })),
        "必修必選可選課號": Object.fromEntries(v.groups.filter((g) => g.id !== "選修").map((g) => [g.id, g.options])) }])),
    };
  }

  // ---------- 稽核：回答中的數字必須出現在報告或問題裡 ----------
  function numbersIn(obj, out = new Set()) {
    if (Array.isArray(obj)) obj.forEach((v) => numbersIn(v, out));
    else if (obj && typeof obj === "object") Object.values(obj).forEach((v) => numbersIn(v, out));
    else if (typeof obj === "number") out.add(Math.trunc(obj));
    else if (typeof obj === "string") (obj.match(/\d+/g) || []).forEach((n) => out.add(parseInt(n, 10)));
    return out;
  }

  function audit(answer, report, question) {
    const allowed = numbersIn(report);
    numbersIn(question, allowed);
    const base = [...allowed];
    for (const a of base) for (const b of base) if (a - b >= 0 && a - b <= 200) allowed.add(a - b);
    const found = (answer.replace(/[A-Z]{2,3}\d{4}/g, "").match(/\d+/g) || []).map((n) => parseInt(n, 10));
    return [...new Set(found.filter((n) => !allowed.has(n)))].sort((a, b) => a - b);
  }

  const SYSTEM_PROMPT = `你是中央大學的畢業學分顧問。
規則：
1. 所有數字只能來自【檢核報告】，不可自行加總、推算或猜測。
2. 報告標示「待確認」「note」的地方，要提醒學生向系辦確認，不可替系辦下結論。
3. 用繁體中文、口語、條列，先講結論再講細節，200 字以內。
4. 若有 before（試算前）與 main（試算後），要說明修這些課之後改變了什麼。
5. total.got 含修課中的預計學分，要分開講「已取得」與「修課中」，不可說成已修得。
6. 建議學程課程時，只能從報告的「必修必選可選課號」挑，並說明每組要修幾門。`;

  const api = { passed, parse, parseTable, parseManual, buildCatalog, check, checkProgram,
                slimReport, audit, SYSTEM_PROMPT, IN_PROGRESS };
  if (typeof module !== "undefined") module.exports = api;
  else root.GradCheck = api;
})(this);
