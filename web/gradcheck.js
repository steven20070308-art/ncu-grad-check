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
    if (g.includes("通過")) return !g.includes("不通過");  // 「一般課程不通過」也含「通過」兩字
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
    const codeRe = /^((?:[A-Z]{2}[A-Z0-9]\d{3}|[A-Z]{3}\d{4}))\b/gm;
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
      const m = line.trim().toUpperCase().match(/^((?:[A-Z]{2}[A-Z0-9]\d{3}|[A-Z]{3}\d{4}))\s*(\S+)?/);
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
      Object.entries(g.courses).forEach(([code, cr]) => { if (!cat[code]) cat[code] = { credits: cr, name: (p.names || {})[code] }; })));
    return cat;
  }

  // ---------- 規則引擎 ----------
  /* 檢核單一學分學程：各組最低門數/學分 + 總學分。
   * equiv：可互相替代的課號（例：BA3004 或 IM1018）只算一門；實習有認列上限。 */
  function checkProgram(program, transcript, project, deptRules) {
    const records = transcript.filter((r) => passed(r, project));
    const counted = new Set();
    const groups = program.groups.map((g) => {
      let hits = records.filter((r) => r.code in g.courses && !counted.has(r.code));
      for (const eq of g.equiv || []) {
        const inEq = hits.filter((r) => eq.includes(r.code));
        if (inEq.length > 1) hits = hits.filter((r) => !inEq.slice(1).includes(r));
      }
      hits.forEach((r) => counted.add(r.code));
      const raw = hits.reduce((s, r) => s + r.credits, 0);
      const credits = g.max_credits ? Math.min(raw, g.max_credits) : raw;  // 例：國際事務每個領域最多採計 8 學分
      const okCourses = hits.length >= (g.min_courses || 0);
      const okCredits = credits >= (g.min_credits || 0);
      // 「N 類選 M 類，各類至少一門」：categories 是課號→類別，數有修到幾個不同類別
      const cats = g.categories ? new Set(hits.map((r) => g.categories[r.code])).size : null;
      const okCats = !g.min_categories || cats >= g.min_categories;
      return { id: g.id, got: hits.length, need: g.min_courses || 0, got_credits: credits, need_credits: g.min_credits || null,
               got_categories: cats, need_categories: g.min_categories || null,
               done: okCourses && okCredits && okCats, courses: hits.map((r) => r.code), options: Object.keys(g.courses) };
    });
    const intern = records.filter((r) => (program.internship_prefix || []).some((p) => r.code.startsWith(p)));
    const internCredits = Math.min(intern.reduce((s, r) => s + r.credits, 0), program.internship_max_credits ?? 0);
    const credits = groups.reduce((s, g) => s + g.got_credits, 0) + internCredits;
    const college = deptRules?.college;
    const eligible = !(program.exclude_colleges || []).includes(college)
      && (!program.include_colleges || program.include_colleges.includes(college));
    // manual：PDF 沒有列課號，無法自動判斷是否修畢
    const courses = groups.reduce((s, g) => s + g.got, 0);
    return { name: program.name, groups, credits, need: program.min_credits, eligible, manual: !!program.manual,
             courses, need_courses: program.min_courses || null,
             done: !program.manual && credits >= program.min_credits && courses >= (program.min_courses || 0)
               && groups.every((g) => g.done) };
  }

  const sum = (rs) => rs.reduce((s, r) => s + r.credits, 0);
  const notEnglishPlus = (r) => !r.name.includes("進修英文");
  const hasPrefix = (code, list) => (list || []).some((p) => code.startsWith(p));

  /* 規則引擎（各系共用）。認列順序：
   * 必修 → 擇N必修 → 國文/外文/通識 → 體育/服務學習 → 選修規則 → 其餘為自由選修。
   * used：已被必修、共同科目認列的課；electUsed：已被選修類「擇N」或獨占型選修規則認列的課。 */
  function check(rules, transcript, programs, project, selected = []) {
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
          && !(e.exclude_name_contains || []).some((w) => r.name.includes(w))
          && !(e.exclude_codes || []).includes(r.code)
          && (!electUsed.has(r.code) || (!e.exclusive && e.include_choose)));
      } else if (e.type === "program_set") {
        const set = programSet(e.programs, false, e.exclude_prefix);
        hits = records.filter((r) => !used.has(r.code) && set.has(r.code));
      } else if (e.type === "outside") {
        hits = records.filter((r) => !used.has(r.code) && !electUsed.has(r.code) && r.credits > 0
          && !hasPrefix(r.code, e.exclude_prefix) && !(e.exclude_attr || []).includes(r.attr));
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
    rep.earned = project ? check(rules, transcript, programs, false, []).total.got : rep.total.got;
    rep.ongoing = rep.total.got - rep.earned;
    rep.failed = transcript.filter((r) => !passed(r, project) && !IN_PROGRESS.includes(String(r.grade).trim()));
    // 只檢核使用者勾選的學分學程；學程不影響畢業判定
    rep.programs = Object.fromEntries(selected.filter((k) => programs[k])
      .map((k) => [k, checkProgram(programs[k], transcript, project, rules)]));
    rep.notes = rules.warnings;
    rep.graduation = graduationStatus(rep);
    return rep;
  }

  /* 畢業判定：總學分夠「而且」每一項規定都完成，才算達到畢業條件。
   * min_more 是「至少還要再修幾學分」：總學分缺口與必修缺口取大者
   * （總學分已超過 128，但必修還沒修，仍然要再修那些必修的學分）。 */
  function graduationStatus(rep) {
    const unmet = [];
    for (const [g, v] of Object.entries(rep.required))
      if (v.done_credits < v.need_credits) unmet.push({ id: g, gap: v.need_credits - v.done_credits, unit: "學分" });
    rep.choose.forEach((g) => { if (g.got < g.pick) unmet.push({ id: g.id, gap: g.pick - g.got, unit: "門" }); });
    rep.buckets.forEach((b) => { if (b.got < b.need) unmet.push({ id: b.id, gap: b.need - b.got, unit: "學分" }); });
    rep.counts.forEach((c) => { if (c.got < c.need) unmet.push({ id: c.id, gap: c.need - c.got, unit: "次" }); });
    rep.electives.forEach((e) => {
      if (e.done) return;
      if (e.need_courses && e.got_courses < e.need_courses) unmet.push({ id: e.id, gap: e.need_courses - e.got_courses, unit: "門" });
      else unmet.push({ id: e.id, gap: e.need_credits - e.got_credits, unit: "學分" });
    });
    const totalGap = Math.max(0, rep.total.need - rep.total.got);
    const requiredGap = Object.values(rep.required).reduce((s, v) => s + v.need_credits - v.done_credits, 0)
      + rep.choose.reduce((s, g) => s + 3 * Math.max(0, g.pick - g.got), 0);
    return { graduated: totalGap === 0 && unmet.length === 0, total_gap: totalGap,
             min_more: Math.max(totalGap, requiredGap), unmet };
  }

  // AI 只拿到摘要，不拿原始成績
  function slimReport(rep) {
    return {
      total: rep.total,
      graduation: { "已達畢業條件": rep.graduation.graduated, "至少還要修": rep.graduation.min_more,
                    "未完成項目": rep.graduation.unmet.map((u) => `${u.id}還差${u.gap}${u.unit}`),
                    "說明": "總學分夠且每一項都完成才算達到畢業條件" },
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
        eligible: v.eligible, "無法自動檢核": v.manual,
        groups: v.groups.map(({ id, got, need, got_credits, need_credits, courses }) => ({ id, got, need, got_credits, need_credits, courses })),
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
    const found = (answer.replace(/(?:[A-Z]{2}[A-Z0-9]\d{3}|[A-Z]{3}\d{4})/g, "").match(/\d+/g) || []).map((n) => parseInt(n, 10));
    return [...new Set(found.filter((n) => !allowed.has(n)))].sort((a, b) => a - b);
  }

  const SYSTEM_PROMPT = `你是中央大學的畢業學分顧問。
規則：
1. 所有數字只能來自【檢核報告】，不可自行加總、推算或猜測。
2. 報告標示「待確認」「note」的地方，要提醒學生向系辦確認，不可替系辦下結論。
3. 用繁體中文、口語、條列，先講結論再講細節，200 字以內。
4. 若有 before（試算前）與 main（試算後），要說明修這些課之後改變了什麼。
5. 能不能畢業以 graduation 為準：總學分到了但還有未完成項目，就是還不能畢業，要列出未完成項目。
6. total.got 含修課中的預計學分，要分開講「已取得」與「修課中」，不可說成已修得。
7. 建議學程課程時，只能從報告的「必修必選可選課號」挑，並說明每組要修幾門。
8. 報告若有「排課建議」，回答下學期怎麼修時以它為主，不要自己另外編課表；可以說明每門課補的是哪個缺口。`;

  // ---------- 開課資料：課程查詢頁複製的文字 ----------
  const DAYS = "一二三四五六日";
  const PERIODS = "1234Z56789ABC";  // 中大節次順序：Z 為中午，A-C 為晚上

  function parseOfferings(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const starts = [];
    lines.forEach((l, i) => { if (/^\d{5}$/.test(l.trim())) starts.push(i); });
    const out = [];
    starts.forEach((st, k) => {
      const chunk = lines.slice(st + 1, k + 1 < starts.length ? starts[k + 1] : lines.length);
      const head = (chunk[0] || "").match(/^((?:[A-Z]{2}[A-Z0-9]\d{3}|[A-Z]{3}\d{4}))-(\S+)\t(.+)$/);
      if (!head) return;
      // 學分那一行以「數字+Tab」開頭；上課時間可能跨好幾行，直到「必修/選修 + 全/半」那一行為止。
      // 暑期密集課沒有上課時間，學分與選修別會擠在同一行（例：3\t\t必修\t半）。
      const ci = chunk.findIndex((l) => /^\d+\t/.test(l));
      if (ci < 0) return;
      let ti = chunk.findIndex((l, i) => i >= ci && /(?:^|\t)(必修|選修)\t(全|半)\t/.test(l));
      if (ti < 0) ti = chunk.length - 1;
      const block = chunk.slice(ci, ti + 1).join("\n");
      const credits = block.match(/^(\d+)\t/)[1];
      const typeM = block.match(/(?:^|\t|\n)(必修|選修)\t(全|半)\t/);
      const place = block.replace(/^\d+\t/, "").replace(/(?:^|\t|\n)(必修|選修)\t(全|半)\t[\s\S]*$/, "").replace(/\n/g, " ").trim();
      const slots = [];
      const re = /([一二三四五六日])([0-9ZABC]+)\//g;
      let m;
      while ((m = re.exec(place))) for (const p of m[2]) slots.push(m[1] + p);
      const tagLine = chunk.slice(1, ci).find((l) => l.includes("[")) || "";
      out.push({
        serial: lines[st].trim(), code: head[1], section: head[2],
        name: head[3].replace(/\s*\[已停開\]\s*/, "").trim(),
        canceled: head[3].includes("已停開"),
        credits: parseInt(credits, 10), slots, place: place || "時間未定（密集或暑期課程）",
        type: typeM ? typeM[1] : "",
        teachers: chunk.slice(1, ci).flatMap((l) => l.split("\t")).map((x) => x.trim())
          .filter((x) => /^[\u3400-\u9fff]{2,4}$/.test(x) && !/上課|授課|停開|選課|合班/.test(x)),  // 教師姓名：2-4 個中文字
        gradOnly: false,
        noFirstRound: tagLine.includes("不開放初選"),
        english: tagLine.includes("授課語言:英語"),
        note: chunk.slice(2, ci).filter((l) => !l.includes("[") && /[，。]|合班|密碼卡|筆電/.test(l)).join(" ").trim(),
      });
    });
    return out;
  }

  const conflicts = (a, b) => a.slots.some((x) => b.slots.includes(x));
  // 課號千位數代表年級層級（1-4 大學部、5 大學部/碩士、6 以上研究所）；
  // 第三碼是英文字母的課號（例：IMA022 碩專班）視為研究所課程
  const levelOf = (code) => (/^[A-Z]{3}/.test(code) ? 9 : parseInt(code.slice(2, 3), 10));

  /* 下學期排課建議：依優先序挑課，避開衝堂與已修/修課中的課，不超過學分上限。
   * 優先序：還沒修的必修 → 擇N 尚缺 → 選修規則尚缺（學程必選、本系選修、數位素養）。 */
  function planNextTerm(rules, programs, transcript, offerings, opts = {}) {
    const maxCredits = opts.maxCredits ?? 21;
    const selected = opts.selected || [];
    const taken = new Set(transcript.filter((r) => passed(r, true)).map((r) => r.code));
    const rep = check(rules, transcript, programs, true, selected);
    const programCore = new Set(), programAll = new Set();
    Object.values(programs).forEach((p) => p.groups.forEach((g) => Object.keys(g.courses).forEach((k) => {
      programAll.add(k); if (g.id !== "選修") programCore.add(k);
    })));
    // 大學部可修：課號千位數 1-5，或 7 開頭但列在「有勾選的學程」或本系規則引用的學程課表內（碩博同修）
    const relevant = new Set(selected.concat((rules.elective_rules || []).flatMap((e) => e.programs || [])));
    const programMine = new Set();
    Object.entries(programs).filter(([k]) => relevant.has(k))
      .forEach(([, p]) => p.groups.forEach((g) => Object.keys(g.courses).forEach((c) => programMine.add(c))));
    const known = new Set(Object.values(rules.required_courses).flat().concat((rules.choose_groups || []).flatMap((g) => g.courses))
      .flatMap((c) => c.codes));
    const stars = new Set(opts.favorites || []);  // 使用者加星號、想優先修的課
    const norm = (s) => String(s || "").replace(/[\s　]/g, "");
    const takenNames = new Set(transcript.filter((r) => passed(r, true)).map((r) => norm(r.name)));
    // 體育：0 學分但算次數。大一排大一體育，大二以上排興趣選項（不含代表隊、適應體育、PE4 開頭不列入畢業學分的班），同名課不重修
    const peOk = (o) => o.code.startsWith("PE") && o.credits === 0 && !/隊|適應/.test(o.name) && !takenNames.has(norm(o.name))
      && (year === 1 ? o.code.startsWith("PE1") : o.code.startsWith("PE2"));
    const genOk = (o) => /^(GS|CC)/.test(o.code) && o.slots.length > 0 && !takenNames.has(norm(o.name));
    const year = opts.year ?? 4;  // 下學期是大幾：只排建議學期不晚於這一年的必修
    const open = offerings.filter((o) => !o.canceled && (o.credits > 0 || peOk(o)) && !taken.has(o.code)
      && (levelOf(o.code) <= 5 || (levelOf(o.code) === 7 && programMine.has(o.code)))
      // 5 字頭但標「必修」又不在本系規則裡的，多半是碩士班必修（例：EC5006 口語表達），不推薦
      && !(levelOf(o.code) >= 5 && o.type === "必修" && !known.has(o.code) && !programAll.has(o.code)));
    const reasons = [];
    const allTodo = Object.values(rep.required).flatMap((v) => v.todo);
    const todoCodes = new Set(allTodo.flatMap((c) => c.codes));
    const tooEarly = new Set(allTodo.filter((c) => parseInt(c.term, 10) > year).flatMap((c) => c.codes));
    open.filter((o) => todoCodes.has(o.code) && !tooEarly.has(o.code)).forEach((o) => reasons.push([1, o, "必修，尚未修"]));
    rep.choose.filter((g) => g.got < g.pick).forEach((g) => {
      g.options.filter((c) => parseInt(c.term, 10) > year).forEach((c) => c.codes.forEach((x) => tooEarly.add(x)));
      const codes = new Set(g.options.filter((c) => !(parseInt(c.term, 10) > year)).flatMap((c) => c.codes));
      open.filter((o) => codes.has(o.code)).forEach((o) => reasons.push([2, o, `${g.id}，還差 ${g.pick - g.got} 門`]));
    });
    // 高年級才建議修的必修/擇N課，也不拿來充當選修
    const laterCodes = [...new Set(open.filter((o) => tooEarly.has(o.code)).map((o) => o.code))];
    const openNow = open.filter((o) => !tooEarly.has(o.code));
    (rules.elective_rules || []).forEach((e, i) => {
      const r = rep.electives[i];
      if (r.done) return;
      let ok = () => false;
      // 只用這條規則列出的學程課表（例：企管系「學程必修/必選」只認 ERP、商業智慧）
      const setOf = (coreOnly) => new Set((e.programs || []).flatMap((n) => (programs[n]?.groups || [])
        .filter((g) => !coreOnly || g.id !== "選修").flatMap((g) => Object.keys(g.courses))));
      if (e.type === "program_core") { const s = setOf(true); ok = (o) => s.has(o.code); }
      else if (e.type === "prefix") ok = (o) => hasPrefix(o.code, e.code_prefix) && !todoCodes.has(o.code)
        && !(e.exclude_name_contains || []).some((w) => (o.name || "").includes(w))
        && !(e.exclude_codes || []).includes(o.code);
      else if (e.type === "program_set") { const s = setOf(false); ok = (o) => s.has(o.code) && !hasPrefix(o.code, e.exclude_prefix); }
      else if (e.type === "outside") ok = (o) => !hasPrefix(o.code, e.exclude_prefix) && o.type === "選修";
      else if (e.type === "elective_total") ok = (o) => o.type === "選修";
      const both = (o) => programCore.has(o.code) ? "（也算學分學程）" : "";
      openNow.filter(ok).forEach((o) => reasons.push([3 + i, o, `${e.id}尚缺${both(o)}`]));
    });
    // 外文未滿：排大一英文。課群依學院（管理學院→管理課群，其他理學院等→科學課群）；初／中／高級班依英文分級，由使用者自己選
    const freshEng = rules.college === "管理學院" ? ["LN1005", "LN1006"] : ["LN1003", "LN1004"];
    rep.buckets.filter((b) => b.id === "外文" && b.got < b.need).forEach((b) => openNow
      .filter((o) => freshEng.includes(o.code))
      .forEach((o) => reasons.push([2, o, `外文還差 ${b.need - b.got} 學分（大一英文，請依英文分級選初／中／高級班）`])));
    // 通識未滿、體育次數未滿：從通識中心、體育室的課補（只排在必修與系上選修之後）
    rep.buckets.filter((b) => b.id === "通識" && b.got < b.need)
      .forEach((b) => openNow.filter(genOk).forEach((o) => reasons.push([30, o, `通識還差 ${b.need - b.got} 學分`])));
    rep.counts.filter((c) => c.id === "體育" && c.got < c.need)
      .forEach((c) => openNow.filter(peOk).forEach((o) => reasons.push([31, o, `體育還差 ${c.need - c.got} 次`])));
    // 使用者勾選、且可修的學分學程：補學程缺口
    selected.forEach((k, i) => {
      const pr = rep.programs[k];
      if (!pr || pr.done || !pr.eligible || pr.manual) return;
      const codes = new Set(programs[k].groups.flatMap((g) => Object.keys(g.courses)));
      openNow.filter((o) => codes.has(o.code)).forEach((o) => reasons.push([50 + i, o, `${pr.name}尚缺`]));
    });
    // 自選：全民國防教育（一學期排一門，勾選了就排在通識、體育之前，免得時段被佔走）與加星號的課。不補任何缺口，所以不做缺口檢查
    const hasReason = new Set(reasons.map((x) => x[1].code));
    if (opts.military) openNow.filter((o) => o.code.startsWith("MN") && !takenNames.has(norm(o.name)))
      .forEach((o) => reasons.push([29, o, "全民國防教育（自選，是否計入畢業學分依各系規定）", true]));
    openNow.filter((o) => stars.has(o.code) && !hasReason.has(o.code))
      .forEach((o) => reasons.push([70, o, "你加星號的課", true]));
    // 同一門課只留優先序最高的理由；同優先序時加星號的課優先，再來是學程課
    const best = new Map();
    // 加星號的課：排在必修與擇N之後、其他選修之前，避免被一般選修佔走時段
    reasons.forEach((x) => { if (stars.has(x[1].code) && x[0] > 2.5) x[0] = 2.5; });
    reasons.sort((a, b) => a[0] - b[0] || (stars.has(b[1].code) - stars.has(a[1].code))
      || (programCore.has(b[1].code) - programCore.has(a[1].code)));
    reasons.forEach(([pr, o, why, force]) => {
      const key = o.code;
      if (!best.has(key)) best.set(key, { priority: pr, code: o.code, name: o.name, credits: o.credits, why, force: !!force,
                                          starred: stars.has(o.code), sections: [] });
      if (best.get(key).priority === pr) best.get(key).sections.push(o);
    });
    const candidates = [...best.values()];
    // 「缺口分數」：還差的必修學分＋擇N缺門＋各選修規則缺口。每加一門課都重算，只收真正能縮小缺口的課，
    // 避免例如學程必選只差 2 門卻排了 3 門。
    const gapParts = (r) => {
      const parts = {};
      r.buckets.forEach((b) => (parts[b.id] = Math.max(0, b.need - b.got)));
      r.counts.forEach((c) => (parts[c.id] = 3 * Math.max(0, c.need - c.got)));
      Object.entries(r.required).forEach(([g, v]) => (parts[g] = v.need_credits - v.done_credits));
      r.choose.forEach((g) => (parts[g.id] = 3 * Math.max(0, g.pick - g.got)));
      r.electives.forEach((e) => (parts[e.id] = (e.need_courses ? 3 * Math.max(0, e.need_courses - e.got_courses) : 0)
        + (e.need_credits ? Math.max(0, e.need_credits - e.got_credits) : 0)));
      Object.values(r.programs).forEach((p) => {
        if (!p.eligible || p.manual) return;
        parts[p.name] = Math.max(0, p.need - p.credits) + p.groups.reduce((s, g) =>
          s + 3 * Math.max(0, g.need - g.got) + (g.need_credits ? Math.max(0, g.need_credits - g.got_credits) : 0)
            + (g.need_categories ? 3 * Math.max(0, g.need_categories - g.got_categories) : 0), 0);
      });
      return parts;
    };
    const total = (parts) => Object.values(parts).reduce((a, b) => a + b, 0);
    const attrOf = (code) => (/^(GS|CC)/.test(code) ? "通識" : code.startsWith("PE") ? "體育" : "選修");
    const asRecord = (c) => ({ term: "排課建議", code: c.code, name: c.name, attr: attrOf(c.code), credits: c.credits, grade: "未到" });
    const chosen = [];
    let credits = 0, current = gapParts(rep);
    for (const c of candidates) {
      if (credits + c.credits > maxCredits) { c.skipped = "超過學分上限"; continue; }
      if (c.code.startsWith("MN") && c.force && chosen.some((x) => x.code.startsWith("MN"))) { c.skipped = "全民國防教育一學期只排一門"; continue; }
      if (c.code.startsWith("PE") && chosen.some((x) => x.code.startsWith("PE"))) { c.skipped = "體育一學期只排一門"; continue; }
      if (chosen.some((x) => norm(x.name) === norm(c.name))) { c.skipped = "已經排了同名的課"; continue; }
      if (!c.starred && genOk(c.sections[0]) && chosen.filter((x) => genOk(x.section)).length >= 2) { c.skipped = "通識一學期最多排兩門（加星號的不受限）"; continue; }
      const next = gapParts(check(rules, transcript.concat(chosen.map(asRecord), [asRecord(c)]), programs, true, selected));
      if (!c.force && !c.starred && total(next) >= total(current)) { c.skipped = "前面排的課已經滿足這項要求"; continue; }
      const sec = c.sections.find((s) => chosen.every((x) => !conflicts(x.section, s)));
      if (!sec) { c.skipped = "每個班別都和已排的課衝堂"; continue; }
      if (c.force) { chosen.push({ ...c, why: c.why, section: sec }); credits += c.credits; current = next; continue; }
      // 理由寫實際縮小的那一項缺口
      const helped = Object.keys(next).filter((k) => next[k] < current[k]);
      const why = helped.length ? helped.map((k) => `補${k}`).join("、") + (c.starred ? "（你加星號的課）" : "") : "你加星號的課";
      chosen.push({ ...c, why, section: sec });
      credits += c.credits;
      current = next;
    }
    const after = check(rules, transcript.concat(chosen.map(asRecord)), programs, true, selected);
    return { chosen, credits, candidates, before: rep, after, maxCredits, year, later: laterCodes };
  }

  // 依成績單上有幾個學期，推估下學期是大幾（每學年兩學期）
  function guessNextYear(transcript) {
    const terms = new Set(transcript.map((r) => r.term).filter((t) => /^\d+-[12]$/.test(t)));
    return Math.min(4, Math.max(1, Math.ceil((terms.size + 1) / 2)));
  }

  const api = { guessNextYear, parseOfferings, planNextTerm, DAYS, PERIODS, passed, parse, parseTable, parseManual, buildCatalog, check, checkProgram,
                slimReport, audit, SYSTEM_PROMPT, IN_PROGRESS };
  if (typeof module !== "undefined") module.exports = api;
  else root.GradCheck = api;
})(this);
