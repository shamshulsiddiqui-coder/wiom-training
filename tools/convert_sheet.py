"""
WIOM Training — Google Sheet to data.js converter.

Reads the public Google Sheet, parses sop_full + Objection Handling text blobs
into structured arrays, and writes js/data.js.

Run:  python tools/convert_sheet.py
"""

import csv
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

SHEET_ID = "17L29B-UG47kD7Lt6J6fAMvGCgO0p5W5k5C7-hXK69Rg"
GID = "0"
CSV_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={GID}"

OUT_PATH = Path(__file__).parent.parent / "js" / "data.js"

# Color gradients — cycle through these per category
GRADIENTS = [
    "linear-gradient(135deg, #FF6B6B 0%, #EE5A6F 100%)",
    "linear-gradient(135deg, #4FACFE 0%, #00F2FE 100%)",
    "linear-gradient(135deg, #43E97B 0%, #38F9D7 100%)",
    "linear-gradient(135deg, #FA709A 0%, #FEE140 100%)",
    "linear-gradient(135deg, #A8EDEA 0%, #FED6E3 100%)",
    "linear-gradient(135deg, #667EEA 0%, #764BA2 100%)",
    "linear-gradient(135deg, #F093FB 0%, #F5576C 100%)",
    "linear-gradient(135deg, #5EE7DF 0%, #B490CA 100%)",
    "linear-gradient(135deg, #FFE259 0%, #FFA751 100%)",
    "linear-gradient(135deg, #30CFD0 0%, #330867 100%)",
    "linear-gradient(135deg, #38EF7D 0%, #11998E 100%)",
    "linear-gradient(135deg, #F2994A 0%, #F2C94C 100%)",
]


# WIOM intro content (already finalised by user)
BRAND = {
    "name": "WIOM",
    "tagline": "Ghar Wala Net",
    "intro": (
        "Wiom ek innovative home internet service provider hai jo customers ko flexible aur "
        "convenient internet usage ka option deta hai. Yahan par koi compulsion nahi hai ki "
        "broadband lene ke liye poore mahine ka plan hi lena pade — customer apni need ke "
        "hisaab se jitne din ka chahe utne din ka internet use kar sakta hai.\n\n"
        "Wiom ek customer-centric company hai jiska primary focus hai users ki problems ko "
        "quickly aur effectively solve karna. Ground level par Wiom ke saath CSPs (Connection "
        "Service Providers) jude hote hain, jo customers ke ghar par connection install karte "
        "hain aur unhe continuous service support bhi provide karte hain."
    ),
    "marketProblem": (
        "• Traditional broadband providers customers ko monthly ya long-term plans lene ke liye "
        "force karte hain, jisme flexibility nahi hoti.\n\n"
        "• Kai users (students, migrants, temporary users) ko short-term internet ki need hoti "
        "hai, lekin unke liye suitable plans available nahi hote.\n\n"
        "• Broadband installation process aksar slow aur complicated hota hai, jisse customer "
        "experience kharab hota hai.\n\n"
        "• Local level par reliable service aur quick support ki kami hoti hai, especially "
        "after installation.\n\n"
        "• Customers ko apni usage ke hisaab se pay-as-you-use model nahi milta, jisse "
        "unnecessary cost incur hoti hai.\n\n"
        "• Rural aur semi-urban areas me last-mile connectivity aur service reach weak hoti hai."
    ),
    "contribution": (
        "• CSP dwara batayi gayi har problem ko end-to-end solve karwana aur proper resolution "
        "ensure karna.\n\n"
        "• Ground se milne wali valuable feedback ko timely company tak pahuchana taaki process "
        "aur product improve ho sake.\n\n"
        "• Har important update aur signal ko time par communicate karna.\n\n"
        "• CSP ki har reported dikkat par active follow-up karke solution deliver karna.\n\n"
        "• CSP ko clearly guide karna ki App hi primary authority hai aur saare actions "
        "system-based hone chahiye.\n\n"
        "• Yeh ensure karna ki har process system se hi chale aur system se hi solution mile, "
        "taaki transparency aur tracking maintain rahe."
    ),
}


def download_csv() -> str:
    """Download the public Google Sheet as CSV."""
    req = urllib.request.Request(CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_sop_steps(sop_full: str) -> list[str]:
    """
    Split sop_full text into discrete 'steps' / talking points.
    Strategy:
      - Split on blank lines (paragraph boundary)
      - Strip surrounding straight + curly quotes
      - Drop short header-only lines like "If Call from Bharat:-"
    Each resulting paragraph is one talking point in the SOP.
    """
    if not sop_full:
        return []

    text = _strip_quotes(sop_full.strip())
    paragraphs = re.split(r"\n\s*\n", text)
    steps = []
    for p in paragraphs:
        cleaned = _strip_quotes(p.strip())
        if not cleaned:
            continue
        if len(cleaned) < 12 and cleaned.endswith((":", ":-")):
            continue
        steps.append(cleaned)
    return steps


QUOTE_CHARS = '"\'“”‘’'  # straight + curly double + curly single
BULLET_RE = re.compile(r'^[•●◦∘\-–—•]\s*')


def _strip_quotes(s: str) -> str:
    """Strip surrounding straight + curly quote chars (multiple layers)."""
    s = s.strip()
    while s and s[0] in QUOTE_CHARS and s[-1] in QUOTE_CHARS and len(s) > 1:
        s = s[1:-1].strip()
    return s


def parse_objections(text: str) -> list[dict]:
    """
    Parse the 'Objection Handling' cell into [{objection, response}] pairs.

    Handles multiple formats in the source data:
      - 👉 "Q?"\n\n"A."           (most common)
      - Q: question? \n A: answer.
      - Q: question? \n 👉 answer  (PS22 — 👉 used for answer)
      - • Q: ... \n  A: ...        (PS26 — bulleted)
      - Case N: header \n 👉 Agent Response: \n "answer"  (PS20)
    """
    if not text:
        return []

    t = text.strip()
    t = _strip_quotes(t)
    t = t.replace('""', '"')  # un-double-escape inner quotes

    # Strip bullet prefix from each line so Q:/A: detection works on bulleted cells
    raw_lines = t.split("\n")
    lines = [BULLET_RE.sub('', l).rstrip() for l in raw_lines]

    pairs = []
    cur_q: str | None = None
    cur_a_lines: list[str] = []
    expecting_answer = False  # set True after a Q-marker; helps decide 👉 role

    def flush():
        nonlocal cur_q, cur_a_lines
        if cur_q is not None:
            q = _strip_quotes(cur_q.strip())
            a = _strip_quotes("\n".join(cur_a_lines).strip())
            # Drop conditional-marker prefixes (✔ / ❌)
            a = re.sub(r'^[✔❌✅☑]\s*[A-Za-z ]*?:\s*', '', a).strip()
            a = _strip_quotes(a)
            if q and a:
                pairs.append({"objection": q, "response": a})
        cur_q = None
        cur_a_lines = []
        return

    Q_MARKER = re.compile(r'^Q\s*\d*\s*[.:)]\s*', re.IGNORECASE)
    A_MARKER = re.compile(r'^A\s*[.:)]\s*', re.IGNORECASE)
    AGENT_RESP = re.compile(r'^Agent Response\s*:?\s*', re.IGNORECASE)

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Q-marker (Q:, Q1., Q. etc.)
        if Q_MARKER.match(stripped):
            flush()
            cur_q = Q_MARKER.sub('', stripped).strip()
            cur_a_lines = []
            expecting_answer = True
            continue

        # A-marker (A:, A.)
        if A_MARKER.match(stripped):
            if cur_q is not None:
                cur_a_lines.append(A_MARKER.sub('', stripped).strip())
                expecting_answer = False
            continue

        # 👉 marker
        if stripped.startswith('👉'):
            content = stripped[1:].strip()
            # Skip Case headers
            if re.match(r'^Case\s*\d', content, re.IGNORECASE):
                continue
            # 👉 Agent Response: ... — treat content as start of answer
            if AGENT_RESP.match(content):
                content = AGENT_RESP.sub('', content).strip()
                if cur_q is not None:
                    if content:
                        cur_a_lines.append(content)
                    expecting_answer = False
                continue
            # If we're sitting on an unanswered Q, this 👉 is the answer
            if expecting_answer and cur_q is not None:
                if content:
                    cur_a_lines.append(content)
                expecting_answer = False
            else:
                # Otherwise, this 👉 starts a new objection
                flush()
                cur_q = content
                cur_a_lines = []
                expecting_answer = True
            continue

        # Plain content line — appended to current answer (or as Q continuation)
        if cur_q is not None:
            if expecting_answer and not cur_a_lines:
                # Line right after a Q, no marker — treat as direct answer
                cur_a_lines.append(stripped)
                expecting_answer = False
            elif cur_a_lines:
                cur_a_lines.append(stripped)
            else:
                # Continuation of Q itself
                cur_q = (cur_q + " " + stripped).strip()

    flush()

    # Dedupe near-duplicates
    cleaned = []
    seen = set()
    for p in pairs:
        key = (p["objection"][:80], p["response"][:80])
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(p)
    return cleaned


def normalise_duration(d: str) -> str:
    if not d:
        return "10 min"
    return d.strip().lower().replace("min", "min")


def normalise_level(lvl: str) -> str:
    if not lvl:
        return "L1"
    return lvl.strip().upper()


def build_categories(rows: list[dict]) -> list[dict]:
    cats = []
    for i, row in enumerate(rows):
        cid = (row.get("category_id") or "").strip()
        if not cid:
            continue
        name = (row.get("category_name") or "").strip()
        level = normalise_level(row.get("level") or "L1")
        duration = normalise_duration(row.get("duration") or "10 min")
        icon = (row.get("icon") or "📘").strip() or "📘"
        sop_full = row.get("sop_full") or ""
        objection_block = row.get("Objection Handling") or row.get("objection_handling") or ""

        steps = parse_sop_steps(sop_full)
        objections = parse_objections(objection_block)

        # Quiz length: ~70% of (steps + objections), capped between 4 and 10
        approx = max(4, min(10, len(steps) + len(objections)))

        cats.append({
            "id": cid.lower(),
            "name": name,
            "icon": icon,
            "gradient": GRADIENTS[i % len(GRADIENTS)],
            "level": level,
            "duration": duration,
            "questions": approx,
            "sop": {
                "title": f"{level} SOP — {name}",
                "steps": steps,
            },
            "objections": objections,
        })
    return cats


def render_data_js(brand: dict, today_plan: list[str], categories: list[dict]) -> str:
    """Render the data.js file content."""
    payload = {
        "brand": brand,
        "todayPlan": today_plan,
        "categories": categories,
    }
    json_blob = json.dumps(payload, ensure_ascii=False, indent=2)
    return (
        "// WIOM Training Data — auto-generated from Google Sheet\n"
        "// Run: python tools/convert_sheet.py to regenerate\n\n"
        f"const TRAINING_DATA = {json_blob};\n"
    )


def main():
    print("Downloading sheet…")
    csv_text = download_csv()

    print("Parsing CSV…")
    reader = csv.DictReader(io.StringIO(csv_text))
    rows = list(reader)
    print(f"  {len(rows)} rows")

    categories = build_categories(rows)
    print(f"Built {len(categories)} categories")
    for c in categories:
        print(f"  - {c['id']}: {len(c['sop']['steps'])} steps, {len(c['objections'])} objections")

    # Today's plan — all categories by default
    today = [c["id"] for c in categories]

    out = render_data_js(BRAND, today, categories)
    OUT_PATH.write_text(out, encoding="utf-8")
    print(f"\nWrote {OUT_PATH}  ({len(out)} bytes)")


if __name__ == "__main__":
    main()
