// ===========================================================================
//  WIOM Training Portal — single-file app logic
//  - Sheet sync (published CSV)
//  - Sequential lock @ 100%
//  - Auto-generated MCQs from SOP + Objection data
//  - Per-laptop progress (localStorage)
// ===========================================================================

(function () {
  "use strict";

  // ---------------------------------------------------------------- CONFIG
  const SHEET_CSV_URL =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS64RYLi5Iom7MZUiHAmsUvU294R_djUCX3EXtfgqXE-PV1ywaE1SYavfCPqecpcApMncsZKd1kt-t3/pub?output=csv";

  // PASTE YOUR DEPLOYED APPS SCRIPT WEB-APP URL HERE.
  // Leave empty ("") to run in local-only mode (no cloud sync, admin view disabled).
  const APPS_SCRIPT_URL = "";

  // Google Form writeback — agents' quiz submissions stream into a linked sheet.
  const FORM_ENDPOINT =
    "https://docs.google.com/forms/d/e/1FAIpQLScfJCz0yo3NRFLPHFdtZqE7LNsyLb8DmBheKpEu0LXeb5cQ4Q/formResponse";
  const FORM_ENTRY_IDS = {
    email:    "entry.1752372676",
    name:     "entry.24046968",
    category: "entry.989897238",
    totalQ:   "entry.1496081168",
    correct:  "entry.1398515673",
    score:    "entry.777895519",
    result:   "entry.1600708348",
    attempt:  "entry.383369262",
  };
  // Once user publishes the linked sheet's "Form Responses 1" tab as CSV,
  // paste the public CSV URL here to enable the admin dashboard data read.
  const FORM_RESPONSES_CSV_URL =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQqWjGgwrzkM6G8JTko-WpdruTsSfZgNWQutfojHcCVmZ2zj678V5gjSpVvb_EnDDou5W8THegl55wE/pub?gid=1875926104&single=true&output=csv";

  const ADMIN_EMAIL_FALLBACK = "shamshul.siddiqui@wiom.in";
  const PASS_PCT = 100; // strict — agent must score 100% to unlock next
  const QUESTIONS_PER_SUB = 5; // 5 MCQs per sub-category; total per quiz = 5 × sub count

  // FRESH-START CUTOFF — submissions with a timestamp BEFORE this instant are
  // ignored by the admin dashboard and by the "restore progress from sheet"
  // logic. The row stays in the Form Responses sheet (historical record) but
  // does not appear in the app. Bump this whenever a full reset is wanted
  // (e.g. after a sheet swap, a category rename, or a training relaunch).
  //
  // 2026-09-23 — reset triggered after the sheet swap to the CATEGORY-level
  // MCQ-only build: old sub-category passes no longer map to the new 11
  // category cards, so the dashboard was showing "42 / 11" style counters.
  const FRESH_START_TS = Date.parse("2026-09-23T00:00:00Z");
  const ENABLE_VALUE = "enable"; // value in col 4 that means "show this card"
  const MAX_QUESTIONS = 8;

  const LS = {
    EMAIL:    "wiom.user.email",
    NAME:     "wiom.user.name",
    ROLE:     "wiom.user.role",
    PROGRESS: "wiom.progress",
    CACHE:    "wiom.csv.cache",
    CACHE_TS: "wiom.csv.cache.ts",
    VERSION:  "wiom.app.version",
    CAT_HASHES: "wiom.cat.hashes", // {catId: contentHash} — last-seen per category
  };

  // Bump this to force-logout all users on next page load.
  // Use case: a breaking change (new login flow, new schema) where stale state
  // would cause data loss or confusion.
  //   "2" — Form writeback launched (pre-Form agents needed fresh start).
  //   "3" — Source sheet swapped; grouping moved from sub-category rows to
  //         parent CATEGORY rows; SOP-reading view removed. Old category slugs
  //         no longer exist, so old localStorage progress is orphaned and gets
  //         wiped cleanly on next load.
  const APP_VERSION = "3";
  let WAS_RESET = false;

  // ---------------------------------------------------------------- DOM refs
  const $root        = document.getElementById("root");
  const $userName    = document.getElementById("userName");
  const $userAvatar  = document.getElementById("userAvatar");
  const $syncStatus  = document.getElementById("syncStatus");
  const $loginModal  = document.getElementById("loginModal");
  const $emailInput  = document.getElementById("emailInput");
  const $nameInput   = document.getElementById("nameInput");
  const $loginSubmit = document.getElementById("loginSubmit");
  const $loginError  = document.getElementById("loginError");
  const $switchUser  = document.getElementById("switchUserBtn");

  // ---------------------------------------------------------------- STATE
  let CATS = [];     // [{id, name, sopSteps, objections, level}]
  let PROGRESS = {}; // {catId: {best, last, attempts, passed}}
  let ADMIN_REFRESH_TIMER = null;
  let SHEET_REFRESH_TIMER = null;
  const ADMIN_REFRESH_MS = 30000;          // 30s auto-poll while admin view is open
  const SHEET_REFRESH_MS = 5 * 60 * 1000;  // 5 min — re-fetch sheet to pick up trainer edits

  // ===========================================================================
  //  UTILS
  // ===========================================================================

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function slugify(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 50);
  }
  // Simple non-cryptographic hash (DJB2 variant) — fingerprints a category's
  // DO's / DON'T's / Question Verbatims. When trainer edits any of these in the
  // sheet, the hash changes and prior passes get invalidated (agent must retake).
  function contentHashOf(dos, donts, verbatims) {
    const s =
      (dos || []).map(d => (d && d.text) || d || "").join("|") + "||" +
      (donts || []).map(d => (d && d.text) || d || "").join("|") + "||" +
      (verbatims || []).map(v => (v && v.text) || v || "").join("|");
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }
  function lsGet(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsGetJSON(k, fb) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSetJSON(k, obj) { lsSet(k, JSON.stringify(obj)); }
  // If APP_VERSION differs from what's stored, wipe ALL wiom.* localStorage keys.
  // Triggers a fresh login flow. Set WAS_RESET = true so login modal can show a note.
  function enforceAppVersion() {
    const stored = lsGet(LS.VERSION, "");
    if (stored === APP_VERSION) return;
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("wiom.") === 0) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* private mode etc. */ }
    lsSet(LS.VERSION, APP_VERSION);
    // Only flag as a "reset" if user had a prior session
    if (stored !== "") WAS_RESET = true;
  }

  function initials(name) {
    const parts = String(name).trim().split(/\s+/);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Auto-assign a category icon based on keywords in the name. Order matters —
  // most specific rules first (netbox before "net"; payout before "customer").
  const ICON_RULES = [
    [/router|device|netbox|adapter|hardware|swap|inventory|pickup/i, "📦"],
    [/payout|wallet|rating|payg|recharge|payment|cash|commission|fund|amount|bank/i, "💰"],
    [/ticket|grievance/i,        "🎫"],
    [/new project|launch/i,      "🚀"],
    [/technical|tech support|tech/i, "⚙️"],
    [/install|installation|connection|onboard/i, "🔧"],
    [/app|login|exit|crash/i,    "📱"],
    [/lead|sales/i,              "🎯"],
    [/csp account|account management|profile|kyc/i, "👤"],
    [/customer.*lifecycle|lifecycle|churn|onboarding/i, "👥"],
    [/partner|csp/i,             "🤝"],
    [/speed|upgrade|mbps|plan/i, "⚡"],
    [/network|outage|ssid|wifi|net|signal/i, "📡"],
    [/feedback|rating|survey/i,  "⭐"],
    [/escalation|complaint/i,    "⚠️"],
    [/customer|user/i,           "👤"],
    [/franchise|owner|merchand|t-shirt/i, "🏪"],
    [/security|refund|terminate|breach|fraud/i, "🛡️"],
    [/lottery|reward|bonus/i,    "🎁"],
    [/call|ivr|number/i,         "📞"],
    [/visit|engineer/i,          "🛠️"],
    [/status|update|info|detail|enquiry/i, "🔍"],
    [/other/i,                   "📋"],
  ];
  function iconFor(name) {
    for (const [re, emoji] of ICON_RULES) {
      if (re.test(name)) return emoji;
    }
    return "📋";
  }

  // ===========================================================================
  //  APPS SCRIPT API
  // ===========================================================================
  const API_ENABLED = !!APPS_SCRIPT_URL;

  function apiGet(params) {
    if (!API_ENABLED) return Promise.reject(new Error("api disabled"));
    const qs = Object.keys(params).map(k =>
      encodeURIComponent(k) + "=" + encodeURIComponent(params[k])
    ).join("&");
    return fetch(APPS_SCRIPT_URL + "?" + qs, { method: "GET" })
      .then(r => r.json())
      .then(j => { if (!j.ok) throw new Error(j.error || "api error"); return j; });
  }

  function apiAuth(email, name) {
    return apiGet({ action: "auth", email, name });
  }
  function apiSubmit(payload) {
    return apiGet(Object.assign({ action: "submit" }, payload));
  }
  function apiListUsers()       { return apiGet({ action: "users" }); }
  function apiListSubmissions() { return apiGet({ action: "submissions" }); }

  // ---- Google Form writeback (fire-and-forget, no-cors) ----
  const FORM_ENABLED = !!FORM_ENDPOINT;
  const LOGIN_CATEGORY = "__LOGIN__";
  function submitToForm(payload) {
    if (!FORM_ENABLED) return Promise.resolve();
    const fd = new FormData();
    fd.append(FORM_ENTRY_IDS.email,    payload.email    || "");
    fd.append(FORM_ENTRY_IDS.name,     payload.name     || "");
    fd.append(FORM_ENTRY_IDS.category, payload.category || "");
    fd.append(FORM_ENTRY_IDS.totalQ,   String(payload.totalQ   || 0));
    fd.append(FORM_ENTRY_IDS.correct,  String(payload.correct  || 0));
    fd.append(FORM_ENTRY_IDS.score,    String(payload.score    || 0));
    // Treat the login marker specially: Result = "LOGIN", else PASS / RETRY.
    let result = payload.passed ? "PASS" : "RETRY";
    if (payload.category === LOGIN_CATEGORY) result = "LOGIN";
    fd.append(FORM_ENTRY_IDS.result,   result);
    fd.append(FORM_ENTRY_IDS.attempt,  String(payload.attempt  || 1));
    return fetch(FORM_ENDPOINT, { method: "POST", mode: "no-cors", body: fd })
      .catch(() => { /* silent — agent never blocked by network issues */ });
  }
  function submitLoginEvent(email, name) {
    return submitToForm({
      email, name, category: LOGIN_CATEGORY,
      totalQ: 0, correct: 0, score: 0, passed: false, attempt: 0
    });
  }

  // ===========================================================================
  //  CSV PARSER (handles quoted multi-line cells)
  // ===========================================================================

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (c === "\r") { /* skip */ }
        else { field += c; }
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  // ===========================================================================
  //  OBJECTION PARSER — splits "👉 quoted-objection \n quoted-response" blocks
  // ===========================================================================

  // Parse a "✅ Do's ... ❌ Don'ts" style cell into two lists of bullets.
  // Bullets can be marked with * / • / - / numbered. Bold ** wrappers stripped.
  function parseDosDonts(text) {
    if (!text || !text.trim()) return { dos: [], donts: [] };
    const cleaned = String(text).replace(/\*\*/g, "");
    // Split on ❌ / Don'ts / Donts header
    const parts = cleaned.split(/❌\s*Don'?ts?\b|\bDon'?ts?\s*:?/i);
    const doPart   = (parts[0] || "").replace(/✅\s*Do'?s?\b|\bDo'?s?\s*:?/i, "").trim();
    const dontPart = (parts.slice(1).join(" ") || "").trim();
    const parseList = (s) => {
      return s.split(/\n+/)
        .map(l => l.replace(/^\s*(?:\d+[\.\):]|[\*•\-–—✓✅❌])\s*/, "").trim())
        .filter(l => l.length > 6 && !/^Do'?s?$|^Don'?ts?$/i.test(l));
    };
    return { dos: parseList(doPart), donts: parseList(dontPart) };
  }

  // Parse a "1. Q  2. Q  3. Q" numbered/bulleted column into a plain list.
  function parseVerbatims(text) {
    if (!text || !text.trim()) return [];
    const cleaned = String(text).replace(/\*\*/g, "");
    const out = [];
    for (const raw of cleaned.split(/\n+/)) {
      const stripped = raw.replace(/^\s*(?:\d+[\.\):]|[\*•\-–—])\s*/, "").trim();
      if (stripped.length > 8) out.push(stripped);
    }
    return out;
  }

  function parseObjections(text) {
    if (!text || !text.trim()) return [];
    // Supported sheet formats:
    //   A) 👉 "objection" \n "response"                (both curly-quoted)
    //   B) 🗣️ "objection" \n ✅ Response: "response"   (with explicit Response: marker)
    //   C) 👉 question plain text \n "response"        (question NOT quoted, response IS)
    //   D) 👉 **"objection"** \n "response"            (markdown bold wrappers)
    //   E) Q: question \n 👉 response                  (Q: prefix = objection, 👉 = response)
    // Plain straight quotes are also handled. Markdown bold (`**...**`) is stripped first.
    const cleaned = String(text).replace(/\*\*/g, "");

    // Format E detection: line-start "Q:" markers (commonly used together with 👉 as response).
    if (/(?:^|\n)\s*Q\s*[:.\-]\s*\S/i.test(cleaned)) {
      const pairs = [];
      // Split on Q: at line start. blocks[0] = preamble before first Q (often empty).
      const blocks = cleaned.split(/(?:^|\n)\s*Q\s*[:.\-]\s*/i);
      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        // Locate the first response marker (👉, 🗣, A:, ✅).
        const markerMatch = block.match(/👉|🗣️?|^\s*A\s*[:.\-]\s*|✅\s*/m);
        if (!markerMatch) continue;
        const idx = markerMatch.index;
        const objection = block.slice(0, idx).trim();
        const response = block.slice(idx + markerMatch[0].length)
          .replace(/^(?:Agent\s*)?Response\s*[:\-(]/i, "")
          .replace(/^[\s"“”‘’'.,\-—…:]+|[\s"“”‘’'.,\-—…:]+$/g, "")
          .trim();
        if (objection.length >= 4 && response.length >= 6) {
          pairs.push({ objection, response });
        }
      }
      // If we got at least 2 pairs, trust format E; otherwise fall through to the
      // legacy quote-based parser (some sheets have stray "Q:" in body text).
      if (pairs.length >= 2) return pairs;
    }

    const markerRegex = /👉|🗣️?|->|=>|---+/g;
    const chunks = cleaned.split(markerRegex).map(s => s.trim()).filter(Boolean);
    const pairs = [];
    // Quote pattern — accepts curly, straight, French, German variants.
    // Require 3+ chars inside to skip tiny accidental matches.
    const QUOTE_RE = /[“”„«»‘’"']([^“”„«»‘’"']{3,})[“”„«»‘’"']/g;

    for (const chunk of chunks) {
      // Collect every quoted span with its position
      const quotes = [];
      let m;
      QUOTE_RE.lastIndex = 0;
      while ((m = QUOTE_RE.exec(chunk)) !== null) {
        quotes.push({ text: m[1].trim(), start: m.index, end: QUOTE_RE.lastIndex });
      }

      let objection = "", response = "";

      if (quotes.length >= 2) {
        // Format A / B / D: first quote = objection, rest = response
        objection = quotes[0].text;
        response  = quotes.slice(1).map(q => q.text).join(" ");
      } else if (quotes.length === 1) {
        const q = quotes[0];
        // Substantial text BEFORE the quote? → Format C (question plain, response quoted)
        const beforeRaw = chunk.slice(0, q.start)
          .replace(/^[\s\n.,\-—…:“”„«»‘’"']+|[\s\n.,\-—…:“”„«»‘’"']+$/g, "");
        if (beforeRaw.length > 5) {
          // Format C
          objection = beforeRaw.replace(/\n+/g, " ").trim();
          response  = q.text;
        } else {
          // Format B-ish: quoted text is objection, response after
          objection = q.text;
          const after = chunk.slice(q.end);
          const respMarker = after.match(/(?:Response\s*[:\-]|✅)\s*([\s\S]+)/i);
          let rest;
          if (respMarker) rest = respMarker[1];
          else            rest = after;
          rest = rest.replace(/^[\s"“”'.,\-—…:]+|[\s"“”'.,\-—…:]+$/g, "").trim();
          if (rest.length > 4) response = rest;
        }
      } else {
        // No quotes at all — try splitting on first blank line / newline
        const lines = chunk.split(/\n+/).map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          objection = lines[0];
          response  = lines.slice(1).join(" ");
        }
      }

      // Guard: both sides must be substantial. Drop preamble-only chunks.
      if (objection.length >= 4 && response.length >= 6) {
        pairs.push({ objection, response });
      }
    }
    return pairs;
  }

  // ===========================================================================
  //  SOP PARSER — split big SOP block into readable steps
  // ===========================================================================

  function parseSopSteps(text) {
    if (!text || !text.trim()) return [];
    // Split on blank lines, trim each chunk
    const steps = String(text).split(/\n\s*\n/)
      .map(s => s.trim()).filter(s => s.length > 0);
    return steps;
  }

  // ===========================================================================
  //  SHEET FETCH + CACHE
  // ===========================================================================

  async function loadSheet() {
    setSync("loading", "Loading…");
    let csvText = null, fromCache = false;
    try {
      const res = await fetch(SHEET_CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      csvText = await res.text();
      lsSet(LS.CACHE, csvText);
      lsSet(LS.CACHE_TS, String(Date.now()));
      setSync("online", "Live · synced");
    } catch (e) {
      csvText = lsGet(LS.CACHE, null);
      fromCache = true;
      if (csvText) {
        const ts = parseInt(lsGet(LS.CACHE_TS, "0"), 10);
        const ago = Math.round((Date.now() - ts) / 60000);
        setSync("offline", `Offline · cached ${ago}m ago`);
      } else {
        setSync("error", "Cannot load sheet");
        throw new Error("No data and no cache");
      }
    }
    return parseSheet(csvText);
  }

  // Parse the new-format sheet:
  //   17 columns — S.No | Bucket | CATEGORY | SUB CATEGORY | Count | Accuracy |
  //   SOP | OBJECTION HANDLING | TOOLS | OWNER | DO'S AND DON'T | TAT |
  //   Question Verbatims | QUESTIONS-TEAM | ISSUE DESCRIPTION-SHAMSHUL |
  //   ISSUE DESCRIPTION-TEAM | cross check
  //
  // We group by CATEGORY (col 2) — one card per unique category (~11 total)
  // that aggregates DO's, DON'Ts, and Question Verbatims across all its
  // sub-category rows. This is what powers the MCQ quiz.
  //
  // Rows with an empty CATEGORY are skipped. No Enable/Test column — we simply
  // show every category that has at least ONE quiz-usable content item.
  function parseSheet(csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    const findCol = (matcher) => header.findIndex(matcher);
    const col = {
      category: findCol(h => h === "category" || h.startsWith("category ")),
      subCat:   findCol(h => h.includes("sub category") || h.includes("subcategory")),
      dosdont:  findCol(h => h.includes("do") && h.includes("don")),
      verbatim: findCol(h => h.includes("verbatim")),
      // Doc-URL columns — these hold Google Doc tab links whose bodies are
      // fetched at quiz time to source Scenario→Resolution and CSP→Agent
      // Q/A pairs (the primary quiz material).
      sopDoc:   findCol(h => h === "sop" || h.startsWith("sop l") || h === "sop l1"),
      objDoc:   findCol(h => h.includes("objection")),
      // Legacy old-sheet compat.
      sop:      findCol(h => h === "sop" || h.startsWith("sop l") || h === "sop l1"),
      obj:      findCol(h => h.includes("objection")),
      test:     findCol(h => h === "test" || h === "enable" || h.startsWith("test ")),
    };

    // Detect which shape we're dealing with
    const isNewShape = col.category >= 0 && (col.dosdont >= 0 || col.verbatim >= 0);

    if (!isNewShape) {
      // Fall back to the LEGACY parser for the old sheet format
      const list = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        if (col.test >= 0) {
          const flag = (r[col.test] || "").trim().toLowerCase();
          if (flag !== ENABLE_VALUE) continue;
        }
        const nameIdx = col.subCat >= 0 ? col.subCat : col.category;
        const name = (r[nameIdx] || "").trim();
        if (!name) continue;
        const sopSteps   = parseSopSteps(col.sop >= 0 ? r[col.sop] || "" : "");
        const objections = parseObjections(col.obj >= 0 ? r[col.obj] || "" : "");
        const level = /\bL2\b/i.test(name) ? "L2" : "L1";
        const id = slugify(name) || `cat-${i}`;
        list.push({
          id, name, level,
          sopSteps, objections, dos: [], donts: [], verbatims: [], subCategories: [name],
          icon: iconFor(name),
          order: list.length + 1,
          contentHash: contentHashOf(sopSteps.map(t => ({ text: t })),
                                     objections.map(o => ({ text: o.response })),
                                     []),
        });
      }
      return list;
    }

    // NEW-SHAPE parsing — group by CATEGORY, aggregate content.
    // Trainer-driven include filter: LAST column (currently "cross check") acts
    // as a per-row on/off switch. Write `test` in that cell to include the row
    // in the MCQ pool, leave it blank to hide the row. If NO row has "test",
    // fall back to including all rows so an empty filter column doesn't blank
    // out the whole dashboard by surprise.
    const lastColIdx = header.length - 1;
    const INCLUDE_VALUE = "test";
    let anyRowMarkedTest = false;
    for (let i = 1; i < rows.length; i++) {
      const v = ((rows[i] || [])[lastColIdx] || "").trim().toLowerCase();
      if (v === INCLUDE_VALUE) { anyRowMarkedTest = true; break; }
    }

    const groups = new Map();      // catName → aggregate object
    const orderedKeys = [];        // preserve first-seen order

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const catName = (r[col.category] || "").trim();
      if (!catName) continue;
      // Apply the per-row include filter (only when at least one row is marked)
      if (anyRowMarkedTest) {
        const flag = ((r[lastColIdx] || "").trim().toLowerCase());
        if (flag !== INCLUDE_VALUE) continue;
      }
      const subName = (col.subCat >= 0 ? (r[col.subCat] || "").trim() : "") || catName;
      const dosDontText = col.dosdont >= 0 ? r[col.dosdont] || "" : "";
      const verbText    = col.verbatim >= 0 ? r[col.verbatim] || "" : "";
      const { dos, donts } = parseDosDonts(dosDontText);
      const verbatims = parseVerbatims(verbText);

      if (!groups.has(catName)) {
        orderedKeys.push(catName);
        groups.set(catName, { subCategories: [], dos: [], donts: [], verbatims: [], docs: [] });
      }
      const g = groups.get(catName);
      if (subName && !g.subCategories.includes(subName)) g.subCategories.push(subName);
      dos.forEach(t => g.dos.push({ text: t, sub: subName }));
      donts.forEach(t => g.donts.push({ text: t, sub: subName }));
      verbatims.forEach(t => g.verbatims.push({ text: t, sub: subName }));
      // Collect SOP + Objection Google Doc tab URLs — dedup happens per-category
      // later inside fetchDocPairs (we push all first).
      const sopUrl = col.sopDoc >= 0 ? (r[col.sopDoc] || "").trim() : "";
      const objUrl = col.objDoc >= 0 ? (r[col.objDoc] || "").trim() : "";
      if (sopUrl.startsWith("http")) g.docs.push({ url: sopUrl, kind: "sop", sub: subName });
      if (objUrl.startsWith("http")) g.docs.push({ url: objUrl, kind: "obj", sub: subName });
    }

    const list = [];
    let order = 1;
    for (const catName of orderedKeys) {
      const g = groups.get(catName);
      // Require at least SOME quiz-usable content — else skip
      if (g.dos.length + g.donts.length + g.verbatims.length + g.docs.length === 0) continue;
      const id = slugify(catName) || `cat-${order}`;
      list.push({
        id, name: catName, level: "L1",
        icon: iconFor(catName),
        order: order++,
        subCategories: g.subCategories,
        dos: g.dos, donts: g.donts, verbatims: g.verbatims,
        docs: g.docs, // Doc tab URLs — fetched lazily at quiz time
        // Legacy fields kept empty for any old code paths that peek at them
        sopSteps: [], objections: [],
        contentHash: contentHashOf(g.dos, g.donts, g.verbatims),
      });
    }
    return list;
  }

  // ===========================================================================
  //  QUIZ GENERATION
  // ===========================================================================

  // Distractor pools for a category's quiz — pull DO's and DON'Ts from
  // OTHER categories so wrong options are plausible-but-clearly-wrong.
  function buildDistractorPools(thisCat) {
    const otherDos = [], otherDonts = [];
    CATS.forEach(c => {
      if (c.id === thisCat.id) return;
      (c.dos || []).forEach(d => otherDos.push(d.text));
      (c.donts || []).forEach(d => otherDonts.push(d.text));
    });
    return { otherDos, otherDonts };
  }
  function pickN(pool, exclude, n) {
    const filtered = pool.filter(x => x && x !== exclude && String(x).length > 5);
    return shuffle(filtered).slice(0, n);
  }

  // Helper — packages a question with its options shuffled and correctIdx
  // pre-computed. Using index-based identity avoids string-comparison bugs
  // when options contain newlines / quotes (HTML attribute normalization can
  // silently mangle whitespace).
  function makeQuestion(text, correctValue, options, explain) {
    const shuffled = shuffle(options);
    return {
      text,
      correct: correctValue,
      correctIdx: shuffled.indexOf(correctValue),
      options: shuffled,
      explain,
    };
  }

  // ==========================================================================
  //  DOC-BASED CONTENT — fetch each row's SOP + Objection Google Doc tab as
  //  plain text, extract Q/A pairs, and cache per-category. The main quiz
  //  source for the "process-oriented" questions the trainer requested.
  // ==========================================================================

  // Convert a Google Doc edit URL (with `?tab=t.XXX`) into an export?format=txt URL.
  function tabExportUrl(rawUrl) {
    if (!rawUrl) return "";
    const m = String(rawUrl).match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return "";
    const docId = m[1];
    const tabMatch = String(rawUrl).match(/[?&]tab=([a-zA-Z0-9._-]+)/);
    const tab = tabMatch ? tabMatch[1] : "";
    const base = "https://docs.google.com/document/d/" + docId + "/export?format=txt";
    return tab ? base + "&tab=" + tab : base;
  }

  // Extract Q/A pairs from a Google Doc text export. Supports:
  //   Format 1: `Scenario:\n <text>\nResolution:\n<bullets>`  (SOP tabs)
  //   Format 2: `N. CSP: <text>\nAgent:\n<text>`               (Objection tabs)
  // Blocks are separated by long underscore lines (5+). Header lines before
  // the first "N." are skipped.
  function parseDocContent(text) {
    if (!text || !text.trim()) return [];
    const pairs = [];
    // Normalize separators
    const cleaned = String(text).replace(/_{5,}/g, "\n---SEP---\n");
    const blocks = cleaned.split(/---SEP---/);

    for (let block of blocks) {
      block = block.trim();
      if (!block || block.length < 20) continue;

      // Try Scenario/Resolution first
      const scen = block.match(/Scenario\s*:\s*\n?([\s\S]+?)\nResolution\s*:\s*\n?([\s\S]+?)$/i);
      if (scen) {
        const q = scen[1].trim().replace(/\s+/g, " ");
        let a = scen[2].trim().replace(/\n+/g, " • ").replace(/\s+/g, " ");
        // Trim trailing "________________" leftovers
        a = a.replace(/[•\s]+$/g, "").trim();
        if (q.length > 12 && q.length < 500 && a.length > 15 && a.length < 800) {
          pairs.push({ q, a, kind: "process" });
        }
        continue;
      }

      // Try CSP/Agent pairs — require numbered prefix so we skip header lines
      const cspRe = /(?:^|\n)\s*\d+\.\s*(?:CSP\s*[:\-]\s*)?([\s\S]+?)\n\s*Agent\s*[:\-]\s*([\s\S]+?)(?=(?:\n\s*\d+\.)|$)/gi;
      let m;
      while ((m = cspRe.exec(block)) !== null) {
        let q = m[1].replace(/^\s*CSP\s*[:\-]\s*/i, "").replace(/\n+/g, " ").trim();
        let a = m[2].replace(/\n+/g, " ").trim();
        // Strip common trailing artefacts
        a = a.replace(/\s*[•\-]\s*$/, "").trim();
        if (q.length > 8 && q.length < 400 && a.length > 15 && a.length < 800) {
          pairs.push({ q, a, kind: "objection" });
        }
      }
    }
    return pairs;
  }

  // Per-category in-memory doc-pair cache (populated by fetchDocPairs).
  const DOC_PAIRS_CACHE = {};

  // Fetch every SOP + Objection Doc tab for a category, parse into Q/A pairs
  // TAGGED by the sub-category they came from. Deduplicates URLs to avoid
  // double-fetching when the same tab powers both SOP and OBJ columns.
  // Returns [] on total failure so quiz still works via DO/DON'T fallback.
  async function fetchDocPairs(cat) {
    if (DOC_PAIRS_CACHE[cat.id]) return DOC_PAIRS_CACHE[cat.id];
    // url → { subs:Set, kind }
    const urlMeta = new Map();
    for (const d of (cat.docs || [])) {
      const u = tabExportUrl(d.url);
      if (!u) continue;
      if (!urlMeta.has(u)) urlMeta.set(u, { subs: [], kind: d.kind });
      const meta = urlMeta.get(u);
      if (!meta.subs.includes(d.sub)) meta.subs.push(d.sub);
    }
    const urls = Array.from(urlMeta.keys());
    if (urls.length === 0) { DOC_PAIRS_CACHE[cat.id] = []; return []; }

    const results = await Promise.all(urls.map(u =>
      fetch(u, { cache: "no-store" })
        .then(r => r.ok ? r.text() : "")
        .catch(() => "")
    ));
    const allPairs = [];
    for (let i = 0; i < urls.length; i++) {
      const text = results[i];
      if (!text) continue;
      const meta = urlMeta.get(urls[i]);
      const sub = meta.subs[0]; // pick first sub as the tag
      const defaultKind = meta.kind; // sop | obj
      for (const p of parseDocContent(text)) {
        allPairs.push({
          q: p.q,
          a: p.a,
          kind: p.kind || defaultKind,
          sub,
        });
      }
    }
    // Dedupe by sub+question text (same content can appear across tabs).
    const uniq = [];
    const seenQ = {};
    for (const p of allPairs) {
      const key = (p.sub + "|" + p.q.slice(0, 80)).toLowerCase();
      if (seenQ[key]) continue;
      seenQ[key] = true;
      uniq.push(p);
    }
    DOC_PAIRS_CACHE[cat.id] = uniq;
    return uniq;
  }

  // NEW MODEL — generate QUESTIONS_PER_SUB (5) MCQs for EACH sub-category
  // in the category, tagged with the sub-cat name so the quiz UI can render
  // that name as a header above every question. Questions within a sub-cat
  // are shuffled; sub-cats are kept in sheet order so the quiz naturally
  // walks through the whole category.
  function generateQuiz(cat, docPairs) {
    docPairs = docPairs || [];
    const subOrder = (cat.subCategories || []).slice();
    // Ensure any sub that only appears via doc pairs is included too
    docPairs.forEach(p => { if (p.sub && !subOrder.includes(p.sub)) subOrder.push(p.sub); });
    if (subOrder.length === 0) subOrder.push(cat.name);

    // Group content per sub-category
    const bySub = {};
    subOrder.forEach(s => { bySub[s] = { docs: [], dos: [], donts: [] }; });
    docPairs.forEach(p => {
      const s = p.sub && bySub[p.sub] ? p.sub : subOrder[0];
      bySub[s].docs.push(p);
    });
    (cat.dos || []).forEach(d => {
      const s = d.sub && bySub[d.sub] ? d.sub : subOrder[0];
      bySub[s].dos.push(d.text);
    });
    (cat.donts || []).forEach(d => {
      const s = d.sub && bySub[d.sub] ? d.sub : subOrder[0];
      bySub[s].donts.push(d.text);
    });

    // Global distractor pools (all answers across the whole category + across
    // OTHER categories as second-tier fallback for small/empty subs).
    const catAnswers = docPairs.map(p => p.a);
    const otherAnswers = [];
    Object.keys(DOC_PAIRS_CACHE).forEach(otherId => {
      if (otherId === cat.id) return;
      (DOC_PAIRS_CACHE[otherId] || []).forEach(p => otherAnswers.push(p.a));
    });

    const questions = [];

    for (const sub of subOrder) {
      const s = bySub[sub] || { docs: [], dos: [], donts: [] };
      const subQuestions = [];

      // -- 1) Doc-based questions from THIS sub's own tabs (process + objection)
      const shuffledDocs = shuffle(s.docs);
      for (const pair of shuffledDocs) {
        if (subQuestions.length >= QUESTIONS_PER_SUB) break;
        // Distractor pool: OTHER sub's answers in same category first, then
        // other-category answers. Keeps distractors plausible but distinct.
        const otherInCat = catAnswers.filter(a => a !== pair.a);
        let distractors = pickN(otherInCat, pair.a, 3);
        if (distractors.length < 3) {
          distractors = distractors.concat(pickN(otherAnswers, pair.a, 3 - distractors.length));
        }
        distractors = distractors.slice(0, 3);
        if (distractors.length < 3) continue;
        // SIMPLE wording — trainer explicitly asked for simple, understandable.
        const prompt = pair.kind === "objection"
          ? `CSP kehta hai: "${pair.q}"\nAapka correct response kya hoga?`
          : `Situation: "${pair.q}"\nSahi tarika kya hai?`;
        const q = makeQuestion(
          prompt, pair.a,
          [pair.a, ...distractors],
          ""
        );
        q.subCategory = sub;
        subQuestions.push(q);
      }

      // -- 2) Top up with DO/DON'T questions from THIS sub if we're short of 5
      const seenDos = new Set(subQuestions.map(q => q.correct));
      const remainingDos = s.dos.filter(t => !seenDos.has(t));
      const shuffledDos = shuffle(remainingDos);
      for (const doItem of shuffledDos) {
        if (subQuestions.length >= QUESTIONS_PER_SUB) break;
        // Distractors: prefer this-sub DON'Ts, else cat-wide DON'Ts, else other-cat DON'Ts
        const catDonts = [];
        Object.values(bySub).forEach(x => catDonts.push(...x.donts));
        let distractors = pickN(s.donts, doItem, 3);
        if (distractors.length < 3) {
          distractors = distractors.concat(pickN(catDonts, doItem, 3 - distractors.length));
        }
        distractors = distractors.slice(0, 3);
        if (distractors.length < 3) continue;
        const q = makeQuestion(
          `"${sub}" me — kaunsa correct practice hai?`,
          doItem,
          [doItem, ...distractors],
          ""
        );
        q.subCategory = sub;
        subQuestions.push(q);
      }

      // Append this sub's questions to the master list (preserves sub order)
      questions.push(...subQuestions);
    }

    return questions;
  }

  // ===========================================================================
  //  PROGRESS / UNLOCK
  // ===========================================================================

  function loadProgress() {
    const email = currentEmail();
    if (!email) { PROGRESS = {}; return; }
    PROGRESS = lsGetJSON(LS.PROGRESS + "." + slugify(email), {});
  }
  function saveProgress() {
    const email = currentEmail();
    if (!email) return;
    lsSetJSON(LS.PROGRESS + "." + slugify(email), PROGRESS);
  }
  function recordAttempt(catId, correct, total, categoryName) {
    const pct = total === 0 ? 0 : Math.round((correct / total) * 100);
    const passed = pct >= PASS_PCT;
    const prev = PROGRESS[catId] || { best: 0, attempts: 0, passed: false };
    const attemptNum = prev.attempts + 1;
    const cat = CATS.find(c => c.id === catId);
    PROGRESS[catId] = {
      best: Math.max(prev.best, pct),
      last: pct,
      attempts: attemptNum,
      passed: prev.passed || passed,
      correct, total,
      synced: true, // this attempt is being submitted right now — skip in backfill
      // Snapshot content hash at the time of attempt. If trainer later edits
      // SOP/objections, statusFor() will see a mismatch and require retake.
      contentHash: cat ? cat.contentHash : (prev.contentHash || ""),
    };
    saveProgress();

    // Fire-and-forget submission — Apps Script (preferred) or Google Form (fallback)
    const submission = {
      email:    currentEmail(),
      name:     currentName(),
      category: categoryName || catId,
      totalQ:   total,
      correct:  correct,
      score:    pct,
      passed:   passed,
      attempt:  attemptNum
    };
    if (API_ENABLED) {
      apiSubmit(Object.assign({}, submission, { passed: passed ? "true" : "false" }))
        .catch(() => submitToForm(submission));
    } else {
      submitToForm(submission);
    }
    return { pct, passed };
  }

  /** Compute status for a category given its index in CATS. */
  function statusFor(idx) {
    const cat = CATS[idx];
    const p = PROGRESS[cat.id];
    if (p && p.passed) {
      // Content version check — if SOP/objections were edited since this pass,
      // require a fresh quiz attempt (status becomes "retry").
      if (p.contentHash && p.contentHash !== cat.contentHash) return "retry";
      return "done";
    }
    // First category, or previous one passed → eligible (unlock uses stored
    // pass flag, NOT hash — so edits don't cascade-lock the entire chain).
    const prev = idx === 0 ? null : PROGRESS[CATS[idx - 1].id];
    const unlocked = idx === 0 || (prev && prev.passed);
    if (!unlocked) return "locked";
    if (p && p.attempts > 0 && !p.passed) return "retry";
    return "open";
  }

  /** Cross-load content version tracking.
   *
   *  Compare the contentHash of every category against what we saw on the
   *  previous app load (stored in LS.CAT_HASHES). If a category's hash has
   *  changed AND the user already passed it, stamp the user's stored hash
   *  with the OLD value — that creates a mismatch with the new cat.contentHash,
   *  so statusFor() correctly returns "retry".
   *
   *  Then grandfather: for any passed category that still has NO stored hash
   *  (e.g. quiz taken before this feature shipped), stamp current hash so
   *  future edits will be detected on subsequent loads.
   */
  /**
   * Restore an agent's progress from the Form Responses sheet.
   *
   * Use case: agent's localStorage was wiped (browser cleared, incognito,
   * different laptop, etc.) but their submissions are still in the central
   * sheet. On login we rebuild PROGRESS by reading the sheet — agent never
   * has to redo a category they've already passed.
   *
   * Safe to call on every load: only writes entries that aren't already
   * present in PROGRESS, so an in-progress agent isn't disturbed.
   */
  async function restoreProgressFromSheet() {
    if (!FORM_RESPONSES_CSV_URL) return;
    const email = currentEmail();
    if (!email) return;
    try {
      const subs = await loadFormResponsesCsv();
      const mine = subs.filter(s => s.email === email && s.category !== LOGIN_CATEGORY);
      if (mine.length === 0) return;

      // Group attempts by category NAME (sheet stores names, app uses slug IDs).
      const byCategory = {};
      mine.forEach(s => {
        const k = s.category;
        if (!byCategory[k]) byCategory[k] = [];
        byCategory[k].push(s);
      });

      let restored = 0;
      for (const catName in byCategory) {
        const cat = CATS.find(c => c.name === catName);
        if (!cat) continue;
        if (PROGRESS[cat.id] && PROGRESS[cat.id].attempts) continue; // already have local data

        const attempts = byCategory[catName];
        const best = attempts.reduce((m, s) => Math.max(m, s.score || 0), 0);
        const passed = attempts.some(s => (s.result || "").toUpperCase() === "PASS");
        const sorted = [...attempts].sort((a, b) => b.ts - a.ts);
        const latest = sorted[0] || {};

        PROGRESS[cat.id] = {
          best,
          last: latest.score || 0,
          attempts: attempts.length,
          passed,
          correct: latest.correct || 0,
          total: latest.totalQ || 0,
          synced: true, // sheet IS the source — don't re-submit during backfill
          contentHash: cat.contentHash, // grandfather to current content version
        };
        restored++;
      }

      if (restored > 0) {
        saveProgress();
        // Tell the agent so they understand why their progress "reappeared".
        setTimeout(() => showToast("✅ " + restored + " pichli pass restore ho gayi"), 400);
        render(); // refresh grid so the restored "done" cards show immediately
      }
    } catch (e) {
      console.warn("[WIOM] progress restore failed:", e);
    }
  }

  function syncContentHashes() {
    const prev = lsGetJSON(LS.CAT_HASHES, {});
    const next = {};
    let changed = false;

    for (const cat of CATS) {
      next[cat.id] = cat.contentHash;
      const prevHash = prev[cat.id];
      const p = PROGRESS[cat.id];

      // Case A: content changed between the previous load and now
      if (prevHash && prevHash !== cat.contentHash) {
        if (p && p.passed) {
          // Force mismatch: stamp the OLD (now-stale) hash on the pass record.
          p.contentHash = prevHash;
          changed = true;
        }
        // continue — next gets new hash, no further action
        continue;
      }
      // Case B: passed category with no stored hash → grandfather to current
      if (p && p.passed && !p.contentHash) {
        p.contentHash = cat.contentHash;
        changed = true;
      }
    }

    lsSetJSON(LS.CAT_HASHES, next);
    if (changed) saveProgress();
  }

  function firstUnpassedIndex() {
    for (let i = 0; i < CATS.length; i++) {
      const p = PROGRESS[CATS[i].id];
      if (!p || !p.passed) return i;
    }
    return -1;
  }

  // ===========================================================================
  //  USER / LOGIN
  // ===========================================================================

  function currentEmail() { return lsGet(LS.EMAIL, ""); }
  function currentName()  { return lsGet(LS.NAME,  ""); }
  function currentRole()  { return lsGet(LS.ROLE,  "agent"); }
  function isAdmin()      { return currentRole() === "admin"; }

  function setUserUI(name, role) {
    if (name) {
      $userName.textContent = name + (role === "admin" ? " · Admin" : "");
      $userAvatar.textContent = initials(name);
    } else {
      $userName.textContent = "—";
      $userAvatar.textContent = "?";
    }
  }
  function setSync(state, msg) {
    $syncStatus.className = "sync-status " + state;
    $syncStatus.textContent = msg;
  }

  function showLoginError(msg) {
    $loginError.textContent = msg;
    $loginError.classList.add("show");
  }
  function clearLoginError() { $loginError.classList.remove("show"); }

  function promptLogin(force) {
    const curEmail = currentEmail();
    const curName  = currentName();
    const curRole  = currentRole();
    if (curEmail && curName && !force) {
      setUserUI(curName, curRole);
      return Promise.resolve({ email: curEmail, name: curName, role: curRole });
    }
    return new Promise(resolve => {
      $loginModal.classList.remove("hidden");
      $emailInput.value = curEmail || "";
      $nameInput.value  = curName  || "";
      clearLoginError();
      if (WAS_RESET) {
        showLoginError("App updated 🚀 — kripya dobara login karein. Aage saari progress automatically save hogi.");
        WAS_RESET = false;
      }
      setTimeout(() => $emailInput.focus(), 100);

      const submit = async () => {
        clearLoginError();
        const email = $emailInput.value.trim().toLowerCase();
        const name  = $nameInput.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          showLoginError("Sahi email enter karein (e.g. name@wiom.in)");
          $emailInput.focus(); return;
        }
        if (name.length < 2) {
          showLoginError("Apna pura naam likhein");
          $nameInput.focus(); return;
        }
        $loginSubmit.disabled = true;
        $loginSubmit.textContent = "Checking…";

        let role = "agent";
        if (API_ENABLED) {
          try {
            const j = await apiAuth(email, name);
            role = (j.role || "agent").toLowerCase();
          } catch (err) {
            // network/api issue — fall back to local-only with safe role detection
            role = (email === ADMIN_EMAIL_FALLBACK) ? "admin" : "agent";
            showLoginError("Cloud sync offline — local mode chal raha hai.");
          }
        } else {
          // No API configured — detect admin by hardcoded fallback
          role = (email === ADMIN_EMAIL_FALLBACK) ? "admin" : "agent";
        }

        lsSet(LS.EMAIL, email);
        lsSet(LS.NAME,  name);
        lsSet(LS.ROLE,  role);
        setUserUI(name, role);
        $loginModal.classList.add("hidden");

        // Fire-and-forget login event so admin dashboard shows the user immediately,
        // even before they submit any quiz. Skip for admin role (don't pollute data).
        if (role !== "admin") submitLoginEvent(email, name);
        $loginSubmit.disabled = false;
        $loginSubmit.textContent = "Continue →";
        $loginSubmit.removeEventListener("click", submit);
        $emailInput.removeEventListener("keydown", onKey);
        $nameInput.removeEventListener("keydown", onKey);
        resolve({ email, name, role });
      };
      const onKey = (e) => { if (e.key === "Enter") submit(); };
      $loginSubmit.addEventListener("click", submit);
      $emailInput.addEventListener("keydown", onKey);
      $nameInput.addEventListener("keydown", onKey);
    });
  }

  $switchUser.addEventListener("click", (e) => {
    e.preventDefault();
    if (!confirm("Switch user? Naye email se login karne par alag profile khulega.")) return;
    lsSet(LS.EMAIL, ""); lsSet(LS.NAME, ""); lsSet(LS.ROLE, "");
    promptLogin(true).then(() => boot(true));
  });

  // ===========================================================================
  //  ROUTER
  // ===========================================================================

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  window.addEventListener("hashchange", render);

  function stopAdminRefresh() {
    if (ADMIN_REFRESH_TIMER) {
      clearInterval(ADMIN_REFRESH_TIMER);
      ADMIN_REFRESH_TIMER = null;
    }
  }

  function render() {
    const hash = location.hash || "#/";

    // Stop admin auto-refresh on any navigation; renderAdmin restarts it.
    const onAdminRoute = isAdmin() && (hash === "#/" || hash === "" || hash === "#/admin");
    if (!onAdminRoute) stopAdminRefresh();

    // Admin lives on its own route
    if (isAdmin()) {
      if (hash === "#/" || hash === "" || hash === "#/admin") return renderAdmin();
      if (hash === "#/agent") return renderGrid(); // admin can preview agent view
      // For #/cat/* or #/quiz/* — admin uses the agent flow as a preview
    }

    if (hash === "#/" || hash === "") return renderGrid();
    const m = hash.match(/^#\/(cat|quiz)\/([^/]+)$/);
    if (!m) return renderGrid();
    const [, view, id] = m;
    const cat = CATS.find(c => c.id === id);
    if (!cat) return renderGrid();
    const idx = CATS.indexOf(cat);
    const stat = statusFor(idx);
    if (stat === "locked" && !isAdmin()) return renderGrid();
    // "Education" (SOP + Objection reading) view is turned off — every category
    // click goes straight to the quiz. Legacy #/cat/* URLs redirect for safety.
    if (view === "cat") { location.replace("#/quiz/" + id); return; }
    if (view === "quiz") return renderQuiz(cat, idx);
  }

  // ===========================================================================
  //  VIEWS — GRID
  // ===========================================================================

  function renderGrid() {
    const total = CATS.length;
    // Use statusFor so "retry" (content edited since pass) doesn't inflate done count.
    let done = 0;
    CATS.forEach((_, i) => { if (statusFor(i) === "done") done++; });
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    // Level = how many done + 1 (current target). Capped at total.
    const level = Math.min(done + 1, total);
    // Lifetime streak = consecutive done from start (content-version aware).
    let streak = 0;
    for (let i = 0; i < CATS.length; i++) {
      if (statusFor(i) === "done") streak++;
      else break;
    }

    let cardsHtml = "";
    CATS.forEach((c, idx) => {
      const stat = statusFor(idx);
      const p = PROGRESS[c.id] || {};
      const isLocked = stat === "locked";
      const isOpen   = stat === "open";
      const isDone   = stat === "done";
      const STATUS_LBL = {
        done:   { label: "Passed",       cls: "done"   },
        open:   { label: "Ready",        cls: "open"   },
        retry:  { label: "Retry",        cls: "retry"  },
        locked: { label: "Locked",       cls: "locked" },
      }[stat];

      let footer;
      if (isDone) {
        footer = `
          <span class="score-text">Score · <strong>${p.best || 100}%</strong></span>
          <button class="btn ghost" data-act="quiz" data-id="${c.id}">Retake</button>`;
      } else if (isOpen) {
        footer = `
          <span class="score-text">Ready to start</span>
          <button class="btn primary" data-act="quiz" data-id="${c.id}">Start Quiz →</button>`;
      } else if (stat === "retry") {
        footer = `
          <span class="score-text">Last · <strong class="fail">${p.last || 0}%</strong></span>
          <button class="btn primary" data-act="quiz" data-id="${c.id}">Retry →</button>`;
      } else {
        footer = `
          <span class="lock-note">Previous 100% needed</span>
          <button class="btn disabled" disabled>Locked</button>`;
      }

      const cardCls = ["card"];
      if (isLocked) cardCls.push("locked");
      if (isOpen || stat === "retry") cardCls.push("is-open");
      if (isDone) cardCls.push("is-done");

      const subCount = (c.subCategories || []).length || 1;
      const verbCount = (c.verbatims || []).length;
      const dosCount = (c.dos || []).length + (c.donts || []).length;

      cardsHtml += `
        <div class="${cardCls.join(" ")}" data-act="quiz" data-id="${isLocked ? "" : c.id}">
          <div class="card-top">
            <div class="cat-icon">${c.icon}</div>
            ${isDone ? "" : `<span class="status ${STATUS_LBL.cls}"><span class="dot"></span>${STATUS_LBL.label}</span>`}
          </div>
          <div class="cat-id">${c.level} · ${String(c.order).padStart(2, "0")} of ${total}</div>
          <h3>${escapeHtml(c.name)}</h3>
          <div class="meta">
            <span class="meta-item">📂 <strong>${subCount}</strong> sub-categor${subCount === 1 ? "y" : "ies"}</span>
            <span class="meta-item">❓ <strong>${verbCount}</strong> questions</span>
            <span class="meta-item">✅ <strong>${dosCount}</strong> do/don't</span>
          </div>
          <div class="card-footer">${footer}</div>
        </div>`;
    });

    const counts = {
      done: CATS.filter((_, i) => statusFor(i) === "done").length,
      open: CATS.filter((_, i) => statusFor(i) === "open").length,
      retry: CATS.filter((_, i) => statusFor(i) === "retry").length,
      locked: CATS.filter((_, i) => statusFor(i) === "locked").length,
    };

    const firstName = (currentName().split(/\s+/)[0]) || "Agent";
    const greet =
      (new Date().getHours() < 12) ? "Good morning" :
      (new Date().getHours() < 17) ? "Good afternoon" : "Good evening";

    $root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${greet}, ${escapeHtml(firstName)} <span class="emoji-bounce">👋</span></h1>
          <div class="lede">Har category ke liye MCQ test do — quiz me <strong>100%</strong> score karein tabhi agli category unlock hogi.</div>
          <div class="progress-track" style="margin-top:18px;"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div style="margin-top:8px; font-size:12px; color:var(--muted);"><strong style="color:var(--ink);">${done} / ${total}</strong> categories complete · ${pct}%</div>
        </div>
        <div class="stats-block">
          <div class="stat-pill xp">
            <div class="ico">🏆</div>
            <div><div class="num">${done}</div><div class="lbl">Passed</div></div>
          </div>
          <div class="stat-pill streak">
            <div class="ico">🔥</div>
            <div><div class="num">${streak}</div><div class="lbl">Streak</div></div>
          </div>
          <div class="stat-pill level">
            <div class="ico">⚡</div>
            <div><div class="num">${level}</div><div class="lbl">Level</div></div>
          </div>
        </div>
      </div>
      <div class="section-head">
        <h2>Your Training Path</h2>
        <span class="count">
          <span class="dot-passed">${counts.done} passed</span>
          <span class="dot-retry">${counts.retry} retry</span>
          <span class="dot-ready">${counts.open} ready</span>
          <span class="dot-locked">${counts.locked} locked</span>
        </span>
      </div>
      <div class="grid">${cardsHtml || `<div class="error-block">Koi category load nahi hui — sheet check karein.</div>`}</div>
    `;

    // Every card click goes STRAIGHT to the quiz — no education / SOP-reading
    // step in between (per new dashboard design: "sirf har category ka MCQ test").
    $root.querySelectorAll('[data-act="quiz"][data-id]').forEach(el => {
      const id = el.getAttribute("data-id");
      if (!id) return;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        go(`#/quiz/${id}`);
      });
    });
  }

  // ===========================================================================
  //  VIEWS — DETAIL (SOP + Objection)
  // ===========================================================================

  function renderDetail(cat, idx) {
    let stepsHtml = "";
    cat.sopSteps.forEach((s, i) => {
      stepsHtml += `
        <div class="sop-step">
          <div class="num">${i + 1}</div>
          <div class="txt">${escapeHtml(s)}</div>
        </div>`;
    });
    if (!stepsHtml) stepsHtml = `<div class="lock-note">Is category ke liye SOP available nahi hai.</div>`;

    let objHtml = "";
    cat.objections.forEach(o => {
      objHtml += `
        <div class="obj-pair">
          <div class="obj-q">${escapeHtml(o.objection)}</div>
          <div class="obj-a">${escapeHtml(o.response)}</div>
        </div>`;
    });
    if (!objHtml) objHtml = `<div class="lock-note">Is category ke liye objection handling available nahi hai.</div>`;

    const p = PROGRESS[cat.id] || {};
    const attemptLine = p.attempts
      ? `<div class="item">📈 Best ${p.best}%</div><div class="item">🔁 ${p.attempts} attempt${p.attempts > 1 ? "s" : ""}</div>`
      : `<div class="item">✨ First attempt</div>`;

    $root.innerHTML = `
      <div class="detail-head">
        <a href="#/" class="back">← All categories</a>
      </div>

      <div class="detail-hero">
        <div class="crumb">${cat.icon} ${cat.level} · CATEGORY ${String(idx + 1).padStart(2, "0")} / ${CATS.length}</div>
        <h1>${escapeHtml(cat.name)}</h1>
        <div class="hero-meta">
          <div class="item">📋 ${cat.sopSteps.length} SOP steps</div>
          <div class="item">💬 ${cat.objections.length} objections</div>
          ${attemptLine}
        </div>
      </div>

      <div class="detail-section">
        <h3><span class="ico">📋</span> SOP — Standard Operating Procedure</h3>
        ${stepsHtml}
      </div>

      <div class="detail-section">
        <h3><span class="ico">💬</span> Objection Handling</h3>
        ${objHtml}
      </div>

      <div class="cta-row">
        <a href="#/" class="btn ghost lg">← Back</a>
        <a href="#/quiz/${cat.id}" class="btn primary lg">🎯 Start Quiz</a>
      </div>
    `;
  }

  // ===========================================================================
  //  VIEWS — QUIZ
  // ===========================================================================

  async function renderQuiz(cat, idx) {
    // Show a loader while we fetch Doc content (parallel per-tab export).
    // First visit to a category typically fetches ~5-15 tabs (~1-3 sec).
    // Repeat visits use in-memory cache (instant).
    $root.innerHTML = `
      <div class="quiz-shell">
        <div class="detail-head"><a href="#/" class="back">← All categories</a></div>
        <div class="spinner-block">
          <div class="spinner"></div>
          <div>${escapeHtml(cat.name)} ke liye MCQ tayaar ho rahi hai…</div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px;">Process SOP + Objection docs load ho rahe hain.</div>
        </div>
      </div>`;

    let docPairs = [];
    try { docPairs = await fetchDocPairs(cat); }
    catch (e) { console.warn("[WIOM] doc fetch failed:", e); docPairs = []; }

    // If user navigated away while docs were loading, bail out silently.
    const hashNow = location.hash || "#/";
    if (hashNow !== "#/quiz/" + cat.id) return;

    const questions = generateQuiz(cat, docPairs);
    if (questions.length === 0) {
      $root.innerHTML = `
        <div class="error-block">
          Is category ke liye quiz generate nahi ho payi — content thoda kam hai. Trainer se check karayein.
          <br><a href="#/" style="color:inherit;text-decoration:underline;">← Back</a>
        </div>`;
      return;
    }

    let qIdx = 0;
    let correctCount = 0;
    let answered = false;
    let streak = 0; // consecutive correct in THIS attempt

    $root.innerHTML = `
      <div class="quiz-shell">
        <div class="detail-head">
          <a href="#/" class="back">← All categories</a>
        </div>
        <div class="quiz-head">
          <div class="qtitle">${cat.icon} <strong>${escapeHtml(cat.name)}</strong></div>
          <div style="display:flex; gap:10px; align-items:center;">
            <span class="streak-chip" id="streakChip" style="display:none;">🔥 <span id="streakNum">0</span></span>
            <span class="qtitle"><span id="qCurr">1</span> / <span id="qTotal">${questions.length}</span></span>
          </div>
        </div>
        <div class="quiz-progress-bar"><span id="qBar" style="width:0%"></span></div>
        <div id="qArea"></div>
      </div>
    `;

    function drawQuestion() {
      answered = false;
      const q = questions[qIdx];
      document.getElementById("qCurr").textContent = qIdx + 1;
      document.getElementById("qBar").style.width = `${(qIdx / questions.length) * 100}%`;

      const letters = ["A", "B", "C", "D", "E"];
      // Use data-idx (number) for identity — safer than data-val when options
      // contain newlines/quotes (HTML attribute whitespace normalization).
      const optsHtml = q.options.map((opt, i) =>
        `<div class="option" data-idx="${i}">
          <div class="letter">${letters[i]}</div>
          <div>${escapeHtml(opt)}</div>
        </div>`
      ).join("");

      // Show a sub-category header ABOVE each question — quiz walks through
      // the category one sub-category at a time (5 Qs per sub), and the agent
      // should always know which topic they're being tested on.
      const subHeader = q.subCategory
        ? `<div class="q-sub">📂 ${escapeHtml(q.subCategory)}</div>`
        : "";

      document.getElementById("qArea").innerHTML = `
        <div class="q-card">
          ${subHeader}
          <div class="q-number">Question ${qIdx + 1} of ${questions.length}</div>
          <div class="q-text">${escapeHtml(q.text)}</div>
          <div class="options" id="optsList">${optsHtml}</div>
          <div class="feedback" id="fb"></div>
          <div class="quiz-footer">
            <div class="hint">100% chahiye pass ke liye</div>
            <button class="btn primary" id="nextBtn" disabled style="opacity:0.5;">
              ${qIdx === questions.length - 1 ? "Finish 🏁" : "Next →"}
            </button>
          </div>
        </div>`;

      document.querySelectorAll("#optsList .option").forEach(el => {
        el.addEventListener("click", () => onSelect(el, q));
      });
      document.getElementById("nextBtn").addEventListener("click", onNext);
    }

    function onSelect(el, q) {
      if (answered) return;
      answered = true;
      const chosenIdx = parseInt(el.getAttribute("data-idx"), 10);
      const isRight = chosenIdx === q.correctIdx;
      if (isRight) { correctCount++; streak++; }
      else { streak = 0; }

      // Update streak chip
      const chip = document.getElementById("streakChip");
      const num = document.getElementById("streakNum");
      if (streak >= 2) {
        chip.style.display = "inline-flex";
        num.textContent = streak;
        chip.classList.remove("active"); void chip.offsetWidth; chip.classList.add("active");
      } else {
        chip.style.display = "none";
      }

      document.querySelectorAll("#optsList .option").forEach(o => {
        o.classList.add("disabled");
        const idx = parseInt(o.getAttribute("data-idx"), 10);
        if (idx === q.correctIdx) o.classList.add("correct");
        else if (o === el) o.classList.add("wrong");
      });

      const fb = document.getElementById("fb");
      if (isRight) {
        fb.className = "feedback correct-fb show";
        fb.innerHTML = `✓ <strong>${pickPraise(streak)}</strong> ${escapeHtml(q.explain || "")}`;
        floatChip(streak >= 3 ? `🔥 ${streak} in a row!` : `+ Sahi!`);
      } else {
        fb.className = "feedback wrong-fb show";
        fb.innerHTML = `✗ <strong>Galat.</strong> Sahi answer upar highlighted hai.`;
      }
      const btn = document.getElementById("nextBtn");
      btn.disabled = false;
      btn.style.opacity = "1";
    }

    function pickPraise(s) {
      if (s >= 5) return "Unstoppable!";
      if (s >= 3) return "On fire!";
      if (s >= 2) return "Nice combo!";
      return "Sahi jawab!";
    }

    function floatChip(text) {
      const el = document.createElement("div");
      el.className = "float-chip";
      el.textContent = text;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1200);
    }

    function onNext() {
      if (qIdx < questions.length - 1) {
        qIdx++;
        drawQuestion();
      } else {
        showResult();
      }
    }

    function showResult() {
      const wasPassed = !!PROGRESS[cat.id]?.passed; // before recording
      const { pct, passed } = recordAttempt(cat.id, correctCount, questions.length, cat.name);
      document.getElementById("qBar").style.width = "100%";

      let emoji, title, msg, cls;
      if (passed) {
        emoji = "🏆"; title = "Perfect Score!"; cls = "pass";
        const nextIdx = idx + 1;
        if (nextIdx < CATS.length) {
          msg = `${correctCount} / ${questions.length} sahi! Agli category — <strong>${escapeHtml(CATS[nextIdx].name)}</strong> — ab unlock ho gayi 🔓`;
        } else {
          msg = `🎉 Aapne saari ${CATS.length} categories complete kar li! <strong>Training champion!</strong>`;
        }
      } else {
        const wrong = questions.length - correctCount;
        if (pct >= 80) {
          emoji = "😤"; title = "Itne paas!"; cls = "fail";
        } else if (pct >= 50) {
          emoji = "📚"; title = "Aur thodi practice"; cls = "fail";
        } else {
          emoji = "🤔"; title = "SOP dobara padho"; cls = "fail";
        }
        msg = `<strong>${correctCount} sahi · ${wrong} galat.</strong><br>Aage badhne ke liye saare ${questions.length} sahi karne honge — 100% chahiye. Wapas SOP padh ke retry karo.`;
      }

      const next = CATS[idx + 1];
      $root.innerHTML = `
        <div class="result-card ${cls}">
          <div class="emoji">${emoji}</div>
          <h2>${title}</h2>
          <div class="score-big ${cls}">${pct}%</div>
          <div class="lbl ${cls}">${correctCount} / ${questions.length} ${passed ? "· PASSED" : "· RETRY NEEDED"}</div>
          <div class="msg">${msg}</div>
          <div class="cta-row">
            <a href="#/" class="btn ghost lg">🏠 Dashboard</a>
            ${passed
              ? (next
                  ? `<a href="#/quiz/${next.id}" class="btn primary lg">Next Quiz →</a>`
                  : `<a href="#/" class="btn primary lg">🎉 All Done</a>`)
              : `<a href="#/quiz/${cat.id}" class="btn primary lg">🔁 Retry Quiz</a>`}
          </div>
          <div style="margin-top:20px;font-size:12px;"><a href="#/" style="color:var(--muted);text-decoration:none;">← All categories</a></div>
        </div>`;

      if (passed) {
        launchConfetti();
        if (!wasPassed && next) {
          showToast(`🔓 Unlocked: ${next.name}`);
        }
      }
    }

    function launchConfetti() {
      const wrap = document.createElement("div");
      wrap.className = "confetti-wrap";
      const colors = ["#EC008C", "#FF3DA9", "#F59E0B", "#10B981", "#7C3AED", "#FFE3F0"];
      const count = 80;
      for (let i = 0; i < count; i++) {
        const piece = document.createElement("div");
        piece.className = "confetti";
        piece.style.left = (Math.random() * 100) + "vw";
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = (Math.random() * 0.5) + "s";
        piece.style.animationDuration = (1.8 + Math.random() * 1.4) + "s";
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        if (Math.random() > 0.5) {
          piece.style.borderRadius = "50%";
          piece.style.width = "8px"; piece.style.height = "8px";
        }
        wrap.appendChild(piece);
      }
      document.body.appendChild(wrap);
      setTimeout(() => wrap.remove(), 4000);
    }

    function showToast(text) {
      const el = document.createElement("div");
      el.className = "toast";
      el.innerHTML = text;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4200);
    }

    drawQuestion();
  }

  // ===========================================================================
  //  VIEWS — ADMIN DASHBOARD
  // ===========================================================================

  function timeAgo(ts) {
    if (!ts) return "—";
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60)         return Math.floor(diff) + "s ago";
    if (diff < 3600)       return Math.floor(diff / 60) + "m ago";
    if (diff < 86400)      return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  async function renderAdmin() {
    const hasApi = API_ENABLED;
    const hasCsv = !!FORM_RESPONSES_CSV_URL;

    if (!hasApi && !hasCsv) {
      $root.innerHTML = `
        <div class="page-head"><div><h1>Admin Dashboard <span class="emoji-bounce">📊</span></h1></div></div>
        <div class="error-block">
          ⚠️ Cloud sync setup pending hai. Admin dashboard ke liye Form Responses sheet ko CSV-publish karke URL bhejna hai.
          <br><br>Tab tak agents ki training data unke laptops me localStorage me save ho rahi hai, aur Form ke through linked sheet me bhi aa rahi hai (jab cheh kar sheet khologe).
        </div>`;
      return;
    }

    $root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Admin Dashboard <span class="emoji-bounce">📊</span></h1>
          <div class="lede">Pure team ka live training data. Sab agents ke email-wise progress.</div>
        </div>
        <div>
          <a href="#/agent" class="btn ghost">Preview Agent View →</a>
        </div>
      </div>
      <div class="spinner-block"><div class="spinner"></div>Loading team data…</div>
    `;

    let users = [], subs = [];
    try {
      if (hasApi) {
        const [u, s] = await Promise.all([apiListUsers(), apiListSubmissions()]);
        users = u.rows || [];
        subs  = s.rows || [];
      } else {
        // Read submissions from published Form Responses CSV
        subs = await loadFormResponsesCsv();
        // Synthesize a users list from submission emails
        const seen = {};
        users = [];
        subs.forEach(s => {
          if (!s.email || seen[s.email]) return;
          seen[s.email] = true;
          users.push({ email: s.email, name: s.name, role: s.email === ADMIN_EMAIL_FALLBACK ? "admin" : "agent" });
        });
        // Ensure admin row exists even with no submissions
        if (!seen[ADMIN_EMAIL_FALLBACK]) {
          users.unshift({ email: ADMIN_EMAIL_FALLBACK, name: "Admin", role: "admin" });
        }
      }
    } catch (e) {
      $root.innerHTML = `<div class="error-block">Admin data load nahi hua: ${escapeHtml(e.message)}</div>`;
      return;
    }

    drawAdmin(users, subs);

    // Start auto-refresh (idempotent — stopAdminRefresh runs in render()).
    stopAdminRefresh();
    ADMIN_REFRESH_TIMER = setInterval(() => {
      // Only refresh while still on admin route
      const hash = location.hash || "#/";
      if (!isAdmin() || (hash !== "#/" && hash !== "" && hash !== "#/admin")) {
        stopAdminRefresh();
        return;
      }
      silentRefreshAdmin();
    }, ADMIN_REFRESH_MS);
  }

  // Background refresh — fetch new data and redraw without flashing spinner.
  async function silentRefreshAdmin() {
    try {
      let users = [], subs = [];
      if (API_ENABLED) {
        const [u, s] = await Promise.all([apiListUsers(), apiListSubmissions()]);
        users = u.rows || [];
        subs  = s.rows || [];
      } else {
        subs = await loadFormResponsesCsv();
        const seen = {};
        users = [];
        subs.forEach(s => {
          if (!s.email || seen[s.email]) return;
          seen[s.email] = true;
          users.push({ email: s.email, name: s.name, role: s.email === ADMIN_EMAIL_FALLBACK ? "admin" : "agent" });
        });
        if (!seen[ADMIN_EMAIL_FALLBACK]) {
          users.unshift({ email: ADMIN_EMAIL_FALLBACK, name: "Admin", role: "admin" });
        }
      }
      drawAdmin(users, subs);
    } catch (e) {
      // Silent — don't disrupt the dashboard on transient failures.
      console.warn("[WIOM] silent refresh failed:", e);
    }
  }

  async function loadFormResponsesCsv() {
    const res = await fetch(FORM_RESPONSES_CSV_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("CSV " + res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    if (rows.length < 2) return [];
    // Form responses sheet has columns:
    //   Timestamp | Email | Name | Category | Total Q | Correct | Score | Result | Attempt
    // First column "Timestamp" is auto-added by Google Forms.
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = {
      ts:       header.findIndex(h => h.includes("timestamp")),
      email:    header.findIndex(h => h === "email"),
      name:     header.findIndex(h => h === "name"),
      category: header.findIndex(h => h === "category"),
      totalQ:   header.findIndex(h => h.includes("total")),
      correct:  header.findIndex(h => h === "correct"),
      score:    header.findIndex(h => h === "score"),
      result:   header.findIndex(h => h === "result"),
      attempt:  header.findIndex(h => h.includes("attempt")),
    };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[idx.email]) continue;
      const ts = Date.parse(r[idx.ts] || "") || 0;
      // Discard pre-cutoff submissions (see FRESH_START_TS comment).
      if (FRESH_START_TS && ts < FRESH_START_TS) continue;
      out.push({
        ts,
        email:    String(r[idx.email]).trim().toLowerCase(),
        name:     r[idx.name] || "",
        category: r[idx.category] || "",
        totalQ:   parseInt(r[idx.totalQ] || "0", 10) || 0,
        correct:  parseInt(r[idx.correct] || "0", 10) || 0,
        score:    parseInt(r[idx.score] || "0", 10) || 0,
        result:   String(r[idx.result] || "").toUpperCase(),
        attempt:  parseInt(r[idx.attempt] || "1", 10) || 1,
      });
    }
    return out;
  }

  function drawAdmin(users, subs) {
    const totalEnabled = CATS.length;

    // Build per-agent aggregates
    const agg = {}; // email → { name, role, attempts, passedCats:Set, last:ts, scoreSum, scoreN }
    users.forEach(u => {
      agg[u.email] = {
        email: u.email, name: u.name, role: u.role,
        attempts: 0, passedCats: new Set(), last: 0, scoreSum: 0, scoreN: 0,
        history: []
      };
    });
    subs.forEach(s => {
      let a = agg[s.email];
      if (!a) {
        // submission from a user not in Users tab (rare) — synthesize
        a = agg[s.email] = {
          email: s.email, name: s.name, role: "agent",
          attempts: 0, passedCats: new Set(), last: 0, scoreSum: 0, scoreN: 0,
          history: []
        };
      }
      // Always update name from latest submission if blank
      if (!a.name && s.name) a.name = s.name;
      // Always update last seen
      if (s.ts > a.last) a.last = s.ts;
      // LOGIN events: count toward "active" but not attempts/passes
      const isLogin = s.category === LOGIN_CATEGORY || s.result === "LOGIN";
      if (isLogin) return;
      a.attempts++;
      a.scoreSum += s.score;
      a.scoreN++;
      if (s.result === "PASS") a.passedCats.add(s.category);
      a.history.push(s);
    });

    const rows = Object.values(agg);
    rows.sort((a, b) => b.passedCats.size - a.passedCats.size || b.last - a.last);

    // Stats
    const totalAgents  = rows.filter(r => r.role !== "admin").length;
    const totalPasses  = rows.reduce((acc, r) => acc + r.passedCats.size, 0);
    const totalAttempts = subs.length;
    const activeToday  = rows.filter(r => r.last && (Date.now() - r.last) < 86400000).length;
    const avgScore = subs.length ? Math.round(subs.reduce((a, s) => a + s.score, 0) / subs.length) : 0;

    $root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Admin Dashboard <span class="emoji-bounce">📊</span></h1>
          <div class="lede">Pure team ka live training data. Sab agents ke email-wise progress.</div>
        </div>
        <div>
          <a href="#/agent" class="btn ghost">Preview Agent View →</a>
        </div>
      </div>

      <div class="admin-stats">
        <div class="admin-stat">
          <div class="ico">👥</div>
          <div><div class="num">${totalAgents}</div><div class="lbl">Total Agents</div></div>
        </div>
        <div class="admin-stat green">
          <div class="ico">🏆</div>
          <div><div class="num">${totalPasses}</div><div class="lbl">Total Passes</div></div>
        </div>
        <div class="admin-stat gold">
          <div class="ico">📝</div>
          <div><div class="num">${totalAttempts}</div><div class="lbl">Quiz Attempts</div></div>
        </div>
        <div class="admin-stat purple">
          <div class="ico">⚡</div>
          <div><div class="num">${activeToday}</div><div class="lbl">Active (24h)</div></div>
        </div>
      </div>

      <div class="admin-toolbar">
        <input type="text" id="adminSearch" class="admin-search" placeholder="🔍 Search by name or email…" />
        <span style="font-size:12px;color:var(--muted);">Avg score: <strong style="color:var(--ink);">${avgScore}%</strong></span>
        <span style="font-size:11px;color:var(--green-dark);background:var(--green-bg);padding:4px 10px;border-radius:50px;display:inline-flex;align-items:center;gap:5px;">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse-dot 1.4s infinite;"></span>
          Auto-refresh · 30s
        </span>
      </div>

      <div class="agent-table">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Email</th>
              <th>Categories Passed</th>
              <th>Attempts</th>
              <th>Avg Score</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody id="adminTbody"></tbody>
        </table>
      </div>
    `;

    function renderRows(filterTxt) {
      const tbody = document.getElementById("adminTbody");
      const f = filterTxt.trim().toLowerCase();
      const filtered = rows.filter(r =>
        !f || r.email.includes(f) || (r.name || "").toLowerCase().includes(f)
      );
      if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-block"><div class="big">🔍</div>Koi match nahi mila</div></td></tr>`;
        return;
      }
      tbody.innerHTML = filtered.map((r, idx) => {
        const avg = r.scoreN ? Math.round(r.scoreSum / r.scoreN) : 0;
        const passedCount = r.passedCats.size;
        return `
          <tr class="agent-row" data-idx="${idx}">
            <td>
              <div class="agent-name">
                <div class="av">${initials(r.name || r.email)}</div>
                <span>${escapeHtml(r.name || "(no name)")}${r.role === "admin" ? '<span class="role-admin">Admin</span>' : ''}</span>
              </div>
            </td>
            <td class="email-cell">${escapeHtml(r.email)}</td>
            <td><span class="pill-passed">${passedCount} <span class="frac">/ ${totalEnabled}</span></span></td>
            <td>${r.attempts}</td>
            <td>${r.scoreN ? avg + "%" : "—"}</td>
            <td class="relative-time">${timeAgo(r.last)}</td>
          </tr>
          <tr class="expand-row" data-host="${idx}" style="display:none;"><td colspan="6"></td></tr>`;
      }).join("");

      tbody.querySelectorAll(".agent-row").forEach(tr => {
        tr.addEventListener("click", () => {
          const idx = tr.getAttribute("data-idx");
          const expand = tbody.querySelector(`.expand-row[data-host="${idx}"]`);
          if (!expand) return;
          const isOpen = expand.style.display !== "none";
          // close all others
          tbody.querySelectorAll(".expand-row").forEach(x => x.style.display = "none");
          if (isOpen) return;
          const agent = filtered[idx];
          const cell = expand.querySelector("td");
          if (agent.history.length === 0) {
            cell.innerHTML = `<div class="expand-content"><h4>Attempts</h4><div class="empty-block">Abhi tak koi quiz attempt nahi</div></div>`;
          } else {
            const sorted = [...agent.history].sort((a, b) => b.ts - a.ts);
            cell.innerHTML = `
              <div class="expand-content">
                <h4>Attempts (${agent.history.length})</h4>
                <div class="attempt-list">
                  ${sorted.map(h => `
                    <div class="attempt-item">
                      <div>
                        <div class="cat">${escapeHtml(h.category)}</div>
                        <div class="meta">Attempt ${h.attempt} · ${timeAgo(h.ts)}</div>
                      </div>
                      <span class="verdict ${h.result === 'PASS' ? 'pass' : 'retry'}">${h.score}%</span>
                    </div>`).join("")}
                </div>
              </div>`;
          }
          expand.style.display = "table-row";
        });
      });
    }

    renderRows("");
    document.getElementById("adminSearch").addEventListener("input", (e) => renderRows(e.target.value));
  }

  // ===========================================================================
  //  BOOTSTRAP
  // ===========================================================================

  // Sync any localStorage attempts that were never POSTed to the Form
  // (e.g. attempts made before Form writeback was wired). Idempotent — each
  // category's progress is marked .synced=true after one successful push.
  function backfillUnsyncedProgress() {
    if (!FORM_ENABLED) return;
    if (!currentEmail()) return;
    let count = 0;
    for (const catId in PROGRESS) {
      const p = PROGRESS[catId];
      if (!p || !p.attempts || p.synced) continue;
      const cat = CATS.find(c => c.id === catId);
      submitToForm({
        email:    currentEmail(),
        name:     currentName(),
        category: cat ? cat.name : catId,
        totalQ:   p.total || 0,
        correct:  p.correct || 0,
        score:    p.best || p.last || 0,
        passed:   !!p.passed,
        attempt:  p.attempts
      });
      p.synced = true;
      count++;
    }
    if (count > 0) {
      saveProgress();
      console.info("[WIOM] backfilled " + count + " past attempt(s) to Form");
    }
  }

  // Quick fingerprint of a category list — change in name / order / count = different.
  // Used to detect when re-fetched sheet actually has new content vs no-op.
  function fingerprintCats(list) {
    return (list || []).map(c => c.id + ":" + (c.sopSteps || []).length + ":" + (c.objections || []).length).join("|");
  }

  // Silent background poll — re-fetch sheet every SHEET_REFRESH_MS so trainer
  // edits (enable/disable/SOP changes) reach agents without manual refresh.
  // Skips when user is mid-quiz to avoid disrupting them.
  function startSheetAutoRefresh() {
    if (SHEET_REFRESH_TIMER) clearInterval(SHEET_REFRESH_TIMER);
    SHEET_REFRESH_TIMER = setInterval(async () => {
      const hash = location.hash || "#/";
      const midQuiz = /^#\/quiz\//.test(hash);
      if (midQuiz) return; // don't yank the rug out mid-quiz
      try {
        const fresh = await loadSheet();
        if (!fresh || fresh.length === 0) return;
        if (fingerprintCats(fresh) === fingerprintCats(CATS)) return; // no change
        // Compare against in-memory CATS (the previous poll cycle's snapshot).
        // For any category whose contentHash changed AND user has passed it,
        // stamp the user's stored hash with the OLD value — so statusFor()
        // sees a mismatch with the new hash and returns "retry".
        const flippedToRetry = [];
        let progressChanged = false;
        fresh.forEach(nc => {
          const oldCat = CATS.find(c => c.id === nc.id);
          if (!oldCat) return;
          if (oldCat.contentHash === nc.contentHash) return; // content unchanged
          const p = PROGRESS[nc.id];
          if (p && p.passed) {
            p.contentHash = oldCat.contentHash; // force mismatch with new
            progressChanged = true;
            flippedToRetry.push(nc.name);
          }
        });
        // Also refresh the LS.CAT_HASHES snapshot so next boot sees the truth.
        const next = {};
        fresh.forEach(c => { next[c.id] = c.contentHash; });
        lsSetJSON(LS.CAT_HASHES, next);
        if (progressChanged) saveProgress();

        CATS = fresh;
        render();
        if (flippedToRetry.length > 0) {
          const sample = flippedToRetry.slice(0, 2).map(n => escapeHtml(n)).join(", ");
          const more = flippedToRetry.length > 2 ? ` +${flippedToRetry.length - 2} aur` : "";
          showToast("📚 SOP updated — retake: " + sample + more);
        } else {
          showToast("📋 Categories updated · " + CATS.length + " total");
        }
      } catch (_) { /* network blip — try again next interval */ }
    }, SHEET_REFRESH_MS);
  }

  // Lightweight toast — visible at module scope so non-quiz views can call it.
  function showToast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function boot(skipLogin) {
    enforceAppVersion();
    if (!skipLogin) {
      await promptLogin(false);
    } else {
      setUserUI(currentName(), currentRole());
    }
    loadProgress();
    try {
      CATS = await loadSheet();
    } catch (e) {
      $root.innerHTML = `<div class="error-block">Sheet load nahi ho payi: ${escapeHtml(e.message)}. Internet check karein.</div>`;
      return;
    }
    if (CATS.length === 0) {
      $root.innerHTML = `<div class="error-block">Sheet me koi category "Enable" mark nahi mili.</div>`;
      return;
    }
    // One-time silent backfill for users who attempted quizzes before
    // Form writeback was wired. Runs once per attempt (synced flag in progress).
    if (currentRole() !== "admin") backfillUnsyncedProgress();
    // Sync content hashes — detect edits between loads and flip passed
    // categories to "retry" when SOP/objections changed.
    syncContentHashes();
    // Rebuild progress from sheet if localStorage was lost (different laptop,
    // cleared browser, incognito, etc.). Agents never have to redo past work.
    if (currentRole() !== "admin") restoreProgressFromSheet();
    // Kick off the background poll so trainer-side sheet edits propagate
    // to every laptop without anyone having to hard-refresh.
    startSheetAutoRefresh();
    if (!API_ENABLED && !FORM_RESPONSES_CSV_URL && isAdmin()) {
      // Allow admin route to surface its config warning
      go("#/admin");
      return;
    }
    render();
  }

  boot();
})();
