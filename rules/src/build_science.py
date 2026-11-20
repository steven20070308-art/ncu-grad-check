"""理學院各系（物理、化學、數學兩組）應修規則產生器。
來源：學生提供的 114 學年度應修科目表 PDF。
學期（上／下）以 115-1 開課資料判斷：有在上學期開的算上學期，否則算下學期；年級取課號第 3 碼。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FALL = set()
for f in (ROOT / "data").glob("offerings_1151_*.txt"):
    FALL.update(re.findall(r"^([A-Z]{2}[A-Z0-9]\d{3})-", f.read_text(encoding="utf-8"), re.M))


def C(code, name, cr, term=None):
    if term is None:
        y = int(code[2]) if code[2].isdigit() else 4
        term = f"{min(max(y, 1), 4)}{'上' if code in FALL else '下'}"
    return {"codes": code.split("/"), "name": name, "credits": cr, "term": term}


def common(overflow=None, gen_note=""):
    gen = {
        "id": "通識",
        "min_credits": 14,
        "match": {"attr": ["通識"]},
        "note": "含核心必修、選修；" + gen_note + "（本工具未檢查領域）",
    }
    if overflow is not None:
        gen["overflow_max"] = overflow
    return [
        {"id": "國文", "min_credits": 5, "match": {"code_prefix": ["CL"]}},
        {
            "id": "外文",
            "min_credits": 6,
            "match": {"code_prefix": ["LN"]},
            "exclude_name_contains": ["進修英文"],
            "note": "可選「大一英文」科學課群 6 學分、英文系其他英文課 6 學分，或同一種第二外語 6 學分（課號不是 LN 開頭時本工具可能沒算到，請自行確認）；進修英文不列入畢業學分",
        },
        gen,
    ]


COUNTS = [
    {"id": "體育", "min_count": 5, "match": {"attr": ["體育"]}, "note": "大一上下、大二上下、大三上各一學期，0學分"},
    {"id": "服務學習", "min_count": 2, "match": {"code_prefix": ["SC"]}, "note": "0 學分，兩學期"},
]

NON_DEPT = ["CL", "LN", "GS", "CC", "PE", "SC"]  # 國文、語言中心、通識、體育、服務學習
WARN = ["共同科目及其他畢業條件請見學校應修科目表注意事項", "雙主修依本校「學生修讀雙主修辦法」辦理"]


def dept(id_, name, req, required_total, buckets, choose=(), electives=(), warnings=()):
    return {
        "id": id_,
        "dept": name,
        "entry_year": 114,
        "source": f"{name} 114 學年度入學應修科目表（學生提供 PDF）",
        "min_total_credits": 128,
        "required_total_check": required_total,
        "required_courses": req,
        "choose_groups": list(choose),
        "credit_buckets": buckets,
        "count_requirements": COUNTS,
        "elective_rules": list(electives),
        "total_caps": [],
        "warnings": WARN + list(warnings),
        "college": "理學院",
    }


CALC = [C("MA1001", "微積分(上)", 4, "1上"), C("MA1002", "微積分(下)", 4, "1下")]

# ---------- 物理系 ----------
PH_REQ = {
    "系訂必修": CALC
    + [
        C("PH1029", "實驗物理與方法 I(上)", 6, "1上"),
        C("PH1030", "實驗物理與方法 I(下)", 6, "1下"),
        C("PH1027", "力學", 4, "1上"),
        C("PH1028", "電磁學", 4, "1下"),
        C("PH2003", "應用數學(上)", 3, "2上"),
        C("PH2004", "應用數學(下)", 3, "2下"),
        C("PH3011", "熱物理", 3, "2上"),
        C("PH3009", "量子物理", 3, "2下"),
        C("PH2029", "實驗物理與方法 II(上)", 6, "2上"),
        C("PH2030", "實驗物理與方法 II(下)", 6, "2下"),
    ]
}
PH_OUT = {
    "type": "outside",
    "id": "系訂必修：跨領域課程",
    "min_credits": 6,
    "exclusive": True,
    "exclude_prefix": ["PH"] + NON_DEPT,
    "exclude_attr": ["通識", "體育"],
    "note": "須選修並通過外系課程 6 學分，不含通識中心、語言中心及體育室課程；課名或內容與物理系課程相近者不採認（本工具無法判斷，請自行確認）",
}
PH_PRE = {
    "type": "prefix",
    "code_prefix": ["PH"],
    "exclusive": True,
    "exclude_name_contains": ["專題", "論文研習", "普通物理"],
}
TOPIC = [
    C("PH3015", "物理專題I", 3),
    C("PH3016", "物理專題II", 3),
    C("PH4015", "物理專題III", 3),
    C("PH4016", "物理專題IV", 3),
]
THESIS = [
    C("PH3017", "論文研習與撰寫I", 3),
    C("PH3018", "論文研習與撰寫II", 3),
    C("PH4017", "論文研習與撰寫III", 3),
    C("PH4018", "論文研習與撰寫IV", 3),
]
ph_gen = "核心必修為人文與思想、應用科學、社會思潮與現象三大領域中至少一個領域"

ph_a = dept(
    "ph_114_a",
    "物理學系（甲類）",
    PH_REQ,
    83,
    common(gen_note=ph_gen),
    choose=[
        {
            "id": "甲類：擇二科(6學分)",
            "pick": 2,
            "courses": [
                C("PH3057", "計算物理導論", 3),
                C("PH3036", "近代物理實驗", 3),
                C("PH3063", "電子學(含實驗)I", 3),
                C("PH3064", "電子學(含實驗)II", 3),
            ]
            + TOPIC
            + [
                C("PH3021", "業界實習I", 3),
                C("PH3022", "業界實習II", 3),
                C("PH4021", "業界實習III", 3),
                C("PH4022", "業界實習IV", 3),
            ],
        }
    ],
    electives=[
        PH_OUT,
        dict(
            PH_PRE,
            id="本系選修(甲類)",
            min_credits=15,
            note="修業期限內至少選修並通過 PH 開頭選修 15 學分（專題類課程除外；外系用的普通物理不計）",
        ),
    ],
    warnings=["物理系須在甲類、乙類擇一；本頁為甲類規則"],
)

ph_b = dept(
    "ph_114_b",
    "物理學系（乙類）",
    PH_REQ,
    83,
    common(gen_note=ph_gen),
    choose=[
        {"id": "乙類：物理專題(擇二)", "pick": 2, "courses": TOPIC},
        {"id": "乙類：論文研習與撰寫(擇二)", "pick": 2, "courses": THESIS},
    ],
    electives=[
        PH_OUT,
        dict(
            PH_PRE,
            id="本系選修(乙類)",
            min_credits=9,
            note="修業期限內至少選修並通過 PH 開頭選修 9 學分（專題類課程除外；外系用的普通物理不計）",
        ),
    ],
    warnings=[
        "物理系須在甲類、乙類擇一；本頁為乙類規則",
        "乙類須擇二組「物理專題＋同編號論文研習與撰寫」（例 PH3015＋PH3017），本工具只分別檢查各修兩門，請自行確認有成對",
        "乙類另須參加物理小年會壁報展並報告、完成畢業論文並繳交 pdf、通過論文口試",
    ],
)

# ---------- 化學系 ----------
cm = dept(
    "cm_114",
    "化學學系",
    {
        "系訂必修": CALC
        + [
            C("CM1001", "普通化學 I", 3, "1上"),
            C("CM1002", "普通化學 II", 3, "1下"),
            C("CM1003", "普化實驗(上)", 1, "1上"),
            C("CM1004", "普化實驗(下)", 1, "1下"),
            C("PH1033", "普通物理B(上)", 3, "1上"),
            C("PH1034", "普通物理B(下)", 3, "1下"),
            C("PH1003", "普物實驗(上)", 1, "1上"),
            C("PH1004", "普物實驗(下)", 1, "1下"),
            C("CM2021", "分析化學(上)", 3, "2上"),
            C("CM2022", "分析化學(下)", 4, "2下"),
            C("CM2031", "有機化學(上)", 4, "2上"),
            C("CM2032", "有機化學(下)", 4, "2下"),
            C("CM2081", "分析與有機化學實驗(上)", 3, "2上"),
            C("CM2082", "分析與有機化學實驗(下)", 3, "2下"),
            C("CM3041", "物理化學(上)", 4, "3上"),
            C("CM3042", "物理化學(下)", 4, "3下"),
            C("CM3043", "物理化學實驗(上)", 2, "3上"),
            C("CM3044", "物理化學實驗(下)", 2, "3下"),
            C("CM3051", "無機化學(上)", 3, "3上"),
            C("CM3052", "無機化學(下)", 3, "3下"),
            C("CM3055", "無機化學實驗", 2, "3下"),
            C("CM4001", "書報討論(上)", 1, "4上"),
            C("CM4002", "書報討論(下)", 1, "4下"),
        ]
    },
    92,
    common(gen_note="核心必修四大領域中至少一個領域"),
    choose=[{"id": "本系必選", "pick": 2, "elective": True, "courses": [C("CM2011", "化學數學", 3), C("CM2012", "化學動力學", 3)]}],
    electives=[
        {
            "type": "prefix",
            "id": "本系選修(含必選)",
            "code_prefix": ["CM"],
            "min_credits": 10,
            "include_choose": True,
            "exclude_codes": ["CM1008", "CM1009", "CM1010"],
            "note": "10 學分本系選修，含必選 CM2011 化學數學、CM2012 化學動力學（化學系替其他系開的普通化學不計）",
        },
        {
            "type": "outside",
            "id": "外院系選修",
            "min_credits": 6,
            "exclusive": True,
            "exclude_prefix": ["CM", "MT", "BA", "IM", "FM", "EC", "HR", "IA", "AC", "HK", "LG", "PD", "FL", "EL"] + NON_DEPT,
            "exclude_attr": ["通識", "體育"],
            "note": "6 學分須為本系外之理、工、資電、生醫理工或地科學院科目（本工具以排除管理、文、客家、法政學院等課號判斷，請自行確認）",
        },
    ],
    warnings=["必選科目 CM2011、CM2012 成績可以不及格，但不及格的學分不列入畢業學分（本工具只認及格的課，不及格也算修過的情況請向系辦確認）"],
)

ma_ms_note = "「程式語言及其應用」數學系所開的 MA5021 也可修，及格後辦理抵免"

# ---------- 數學系 ----------
MA_COMMON = CALC + [
    C("MA2007", "線性代數I", 3, "2上"),
    C("MA2008", "線性代數II", 3, "2下"),
    C("MA1015", "基礎數學", 3, "1上"),
    C("MA1013", "計算機概論I", 3, "1上"),
]
SCI3 = {
    "id": "組訂必修：普物B／普化／普生三科擇一(上下學期)",
    "pick": 2,
    "courses": [
        C("PH1033", "普通物理B(上)", 3, "1上"),
        C("PH1034", "普通物理B(下)", 3, "1下"),
        C("CM1009", "普通化學 I", 3, "1上"),
        C("CM1010", "普通化學 II", 3, "1下"),
        C("LS1013", "普通生物學 I", 3, "1上"),
        C("LS1014", "普通生物學 II", 3, "1下"),
    ],
}
MA_ELECT = {
    "type": "prefix",
    "id": "數學系所選修",
    "code_prefix": ["MA"],
    "min_credits": 12,
    "exclusive": True,
    "exclude_codes": ["MA1003", "MA1004", "MA1005", "MA1006", "MA1009", "MA1112"],
    "note": "另修數學系所 12 學分課程（數學系替其他系開的微積分、微積分先修不計）",
}
MA_GEN = common(overflow=10, gen_note="核心必修四大領域中至少一個領域；通識最多認定 24 學分")
MA_WARN = [
    "三科擇一須修同一科的上下學期（例 PH1033＋PH1034），本工具只檢查修兩門，請自行確認",
    "「計算機概論I」需於本系修習，不得以外系計算機概論抵修",
]

ma_cds = dept(
    "ma_114_cds",
    "數學系（計算與資料科學組）",
    {
        "組訂必修": MA_COMMON
        + [
            C("MA1018", "科學計算導論", 3, "1下"),
            C("MA2049", "分析導論 I", 3, "2上"),
            C("MA2050", "分析導論 II", 3, "2下"),
            C("MA2021", "機率論", 3, "2上"),
            C("MA2030", "數值線性代數", 3, "2上"),
            C("MA3067", "數學建模", 3, "3上"),
            C("MA2011", "統計學", 3, "2下"),
            C("MA2044", "數值微分方程", 3, "2下"),
            C("MA2063", "最佳化方法與應用", 3, "3下"),
        ]
    },
    87,
    MA_GEN,
    choose=[
        SCI3,
        {
            "id": "組訂核心選修：三科擇二",
            "pick": 2,
            "courses": [
                C("MA3111", "數學影像處理", 3),
                C("MA3121", "金融數學導論", 3),
                C("MA3131", "資料科學導論", 3),
            ],
        },
        {
            "id": "組訂核心選修：四科擇一",
            "pick": 1,
            "courses": [
                C("MA3103", "科學計算專題 I", 3),
                C("MA3113", "影像處理專題 I", 3),
                C("MA3123", "金融數學專題 I", 3),
                C("MA3133", "資料科學專題 I", 3),
            ],
        },
    ],
    electives=[MA_ELECT],
    warnings=MA_WARN,
)

ma_ms = dept(
    "ma_114_ms",
    "數學系（數學科學組）",
    {
        "組訂必修": MA_COMMON
        + [
            C("MA2045", "高等微積分 I", 4, "2上"),
            C("MA2046", "高等微積分 II", 4, "2下"),
            C("MA2025", "代數 I", 3, "2上"),
            C("MA2041", "微分方程 I", 3, "2上"),
            C("MA2021", "機率論", 3, "2上"),
            C("MA3015", "複變函數論 I", 3, "3上"),
        ]
    },
    83,
    MA_GEN,
    choose=[
        SCI3,
        {
            "id": "組訂核心選修(12學分，擇四科)",
            "pick": 4,
            "courses": [
                C("MA2026", "代數 II", 3),
                C("MA2042", "微分方程 II", 3),
                C("MA2051/MA5021", "程式語言及其應用", 3),
                C("MA3025", "數理統計 I", 3),
                C("MA2047", "高等微積分 III", 3),
                C("MA3034", "離散數學 I", 3),
                C("MA4005", "幾何學 I", 3),
                C("MA3036", "近世代數", 3),
                C("MA3003", "拓樸學", 3),
            ],
        },
    ],
    electives=[MA_ELECT],
    warnings=MA_WARN + [ma_ms_note, "高等微積分、複變、程式語言、數理統計有先修成績門檻，請見應修科目表備註"],
)

for d in (ph_a, ph_b, cm, ma_cds, ma_ms):
    req = sum(c["credits"] for g in d["required_courses"].values() for c in g)
    req += (
        sum(
            c["credits"]
            for g in d["choose_groups"][:1]
            if not g.get("elective")
            for c in g["courses"][: g["pick"]]
        )
        if d["id"].startswith("ma")
        else 0
    )
    (ROOT / "rules" / f"{d['id']}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    print(d["id"], d["dept"], "必修課程合計", req, "+共同 25 =", req + 25)
