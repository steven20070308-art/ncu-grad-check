"""把 gradcheck.js、規則檔與範例資料內嵌進 template.html，產生單一檔案 docs/index.html。
規則只維護 rules/ 一份，網頁與 Python 共用。執行：python web/build.py
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
html = (root / "web/template.html").read_text(encoding="utf-8")
js = lambda p: json.dumps(json.loads((root / p).read_text(encoding="utf-8")), ensure_ascii=False)
parts = {
    "/*__GRADCHECK_JS__*/": (root / "web/gradcheck.js").read_text(encoding="utf-8"),
    "/*__RULES_BA_114__*/null": js("rules/ba_114.json"),
    "/*__PROGRAMS_114__*/null": js("rules/programs_114.json"),
    '/*__SAMPLE_PASTE__*/""': json.dumps((root / "data/sample_paste.txt").read_text(encoding="utf-8"), ensure_ascii=False),
}
for k, v in parts.items():
    assert k in html, f"template 缺少 {k}"
    html = html.replace(k, v.replace("</script", "<\\/script"))
(root / "docs").mkdir(exist_ok=True)
(root / "docs/index.html").write_text(html, encoding="utf-8")
print(f"✓ docs/index.html（{len(html.encode()) // 1024} KB）")
