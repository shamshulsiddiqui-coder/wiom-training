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
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQYPYyZhwUSueU8eqS16RwqU8N3SQOhrZrS5hIqjjE_IAUpkqCy5ViyqdL3VY1y-Xn5z5_wbbwXQmXU/pub?gid=1409757378&single=true&output=csv";

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
  };

  // Bump this to force-logout all users on next page load.
  // Use case: a breaking change (new login flow, new schema) where stale state
  // would cause data loss or confusion. Was bumped to "2" when Form writeback
  // went live so pre-Form agents start fresh.
  const APP_VERSION = "2";
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
  const ADMIN_REFRESH_MS = 30000; // 30s auto-poll while admin view is open

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

  // Auto-assign a category icon based on keywords in the name.
  const ICON_RULES = [
    [/partner|csp/i,             "🤝"],
    [/payg|recharge|payment|cash|payout|commission|fund|amount|bank/i, "💰"],
    [/speed|upgrade|mbps|plan/i, "🚀"],
    [/app|login|exit|crash/i,    "📱"],
    [/install|installation|connection|onboard/i, "🔧"],
    [/network|outage|ssid|wifi|net|signal/i,     "📡"],
    [/router|device|netbox|adapter|hardware|swap|inventory|pickup/i,   "📦"],
    [/lead|sales/i,              "🎯"],
    [/feedback|rating|survey/i,  "⭐"],
    [/escalation|complaint|ticket|grievance/i,   "⚠️"],
    [/customer|user/i,           "👤"],
    [/franchise|owner|merchand|t-shirt/i,        "🏪"],
    [/security|refund|terminate|breach|fraud/i,  "🛡️"],
    [/lottery|reward|bonus/i,    "🎁"],
    [/call|ivr|number/i,         "📞"],
    [/visit|engineer/i,          "🛠️"],
    [/status|update|info|detail|enquiry/i,       "🔍"],
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

  function parseObjections(text) {
    if (!text || !text.trim()) return [];
    // Two sheet formats supported:
    //   Style A: 👉 "objection" / "response"
    //   Style B: 🗣️ "objection" / ✅ Response: "response"  separated by ---
    // Split on either objection marker. Also break on "---" separator for safety.
    const markerRegex = /👉|🗣️?|->|=>|---+/g;
    const chunks = String(text).split(markerRegex).map(s => s.trim()).filter(Boolean);
    const pairs = [];
    const QUOTE = /[“”„«»‘’"']([^“”„«»‘’"']+)[“”„«»‘’"']/g;

    for (const chunk of chunks) {
      // Skip preamble chunks that don't look like an objection (e.g. "Multiple Objection Handling – IVR Calling Issue SOP")
      // Heuristic: must contain at least one quoted string.
      const found = [];
      let m;
      QUOTE.lastIndex = 0;
      while ((m = QUOTE.exec(chunk)) !== null) {
        const v = m[1].trim();
        if (v.length > 2) found.push(v);
      }
      if (found.length >= 2) {
        pairs.push({ objection: found[0], response: found.slice(1).join(" ") });
      } else if (found.length === 1) {
        // One quote: the quoted part is the objection. Look for response after "Response:" or "✅"
        const afterResponse = chunk.match(/(?:Response\s*[:\-]|✅)\s*([\s\S]+)/i);
        if (afterResponse) {
          const respText = afterResponse[1].replace(QUOTE, "").trim() || afterResponse[1].trim();
          // Try to extract a quoted response from the original chunk that came AFTER the first quoted objection
          const all = [...chunk.matchAll(QUOTE)];
          if (all.length >= 2) {
            pairs.push({ objection: found[0], response: all[1][1].trim() });
          } else {
            // Last-resort: response is whatever follows "Response:" verbatim
            const stripped = respText.replace(/^["“”]+|["“”]+$/g, "").trim();
            if (stripped.length > 4) pairs.push({ objection: found[0], response: stripped });
          }
        }
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

  function parseSheet(csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    // Locate columns by header name (tolerant of trailing spaces)
    const col = {
      name: header.findIndex(h => h.includes("sub category") || h.includes("category")),
      sop:  header.findIndex(h => h.includes("sop")),
      obj:  header.findIndex(h => h.includes("objection")),
      test: header.findIndex(h => h.includes("test") || h.includes("enable")),
    };

    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const flag = (r[col.test] || "").trim().toLowerCase();
      if (flag !== ENABLE_VALUE) continue;
      const name = (r[col.name] || "").trim();
      if (!name) continue;
      const sopText = r[col.sop] || "";
      const objText = r[col.obj] || "";
      const sopSteps = parseSopSteps(sopText);
      const objections = parseObjections(objText);
      // Detect level from name (heuristic)
      const level = /\bL2\b/i.test(name) ? "L2" : "L1";
      const id = slugify(name) || `cat-${i}`;
      list.push({
        id, name, level,
        sopSteps, objections,
        icon: iconFor(name),
        order: list.length + 1,
      });
    }
    return list;
  }

  // ===========================================================================
  //  QUIZ GENERATION
  // ===========================================================================

  function buildDistractorPools(thisCat) {
    const responses = [], steps = [];
    CATS.forEach(c => {
      if (c.id === thisCat.id) return;
      c.objections.forEach(o => responses.push(o.response));
      c.sopSteps.forEach(s => steps.push(s));
    });
    return { responses, steps };
  }
  function pickN(pool, exclude, n) {
    const filtered = pool.filter(x => x && x !== exclude && x.length > 5);
    return shuffle(filtered).slice(0, n);
  }

  function generateQuiz(cat) {
    const questions = [];
    const pools = buildDistractorPools(cat);

    // Type 1: Objection → response match (richest signal)
    cat.objections.forEach(obj => {
      const sameCatOtherResp = cat.objections.filter(o => o.response !== obj.response).map(o => o.response);
      const distractors = [
        ...pickN(sameCatOtherResp, obj.response, 2),
        ...pickN(pools.responses, obj.response, 3),
      ].slice(0, 3);
      if (distractors.length < 3) return;
      questions.push({
        text: `CSP kehta hai: "${obj.objection}" — aapka SAHI response kya hoga?`,
        correct: obj.response,
        options: shuffle([obj.response, ...distractors]),
        explain: `Sahi response: standard objection-handling script use karein.`,
      });
    });

    // Type 2: SOP step recall — "kaunsa step is category ka hissa hai?"
    cat.sopSteps.forEach(step => {
      if (step.length < 12) return;
      const distractors = pickN(pools.steps, step, 3);
      if (distractors.length < 3) return;
      questions.push({
        text: `Is category "${cat.name}" ke SOP me se ek STEP kaunsa hai?`,
        correct: step,
        options: shuffle([step, ...distractors]),
        explain: `Yeh SOP ka actual step hai.`,
      });
    });

    // Type 3: First-step recall (if 3+ steps)
    if (cat.sopSteps.length >= 3) {
      const first = cat.sopSteps[0];
      const others = cat.sopSteps.slice(1);
      questions.push({
        text: `"${cat.name}" — process ka SABSE PEHLA step kya hai?`,
        correct: first,
        options: shuffle([first, ...pickN(others, first, 3)]),
        explain: `Pehla step: yahi hai.`,
      });
    }

    return shuffle(questions).slice(0, MAX_QUESTIONS);
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
    PROGRESS[catId] = {
      best: Math.max(prev.best, pct),
      last: pct,
      attempts: attemptNum,
      passed: prev.passed || passed,
      correct, total,
      synced: true, // this attempt is being submitted right now — skip in backfill
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
    if (p && p.passed) return "done";
    // First category, or previous one passed → eligible
    const prev = idx === 0 ? null : PROGRESS[CATS[idx - 1].id];
    const unlocked = idx === 0 || (prev && prev.passed);
    if (!unlocked) return "locked";
    if (p && p.attempts > 0 && !p.passed) return "retry";
    return "open";
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
    if (view === "cat") return renderDetail(cat, idx);
    if (view === "quiz") return renderQuiz(cat, idx);
  }

  // ===========================================================================
  //  VIEWS — GRID
  // ===========================================================================

  function renderGrid() {
    const total = CATS.length;
    let done = 0;
    CATS.forEach(c => { if (PROGRESS[c.id]?.passed) done++; });
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    // Level = how many done + 1 (current target). Capped at total.
    const level = Math.min(done + 1, total);
    // Lifetime streak = consecutive done from start
    let streak = 0;
    for (const c of CATS) {
      if (PROGRESS[c.id]?.passed) streak++;
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
          <button class="btn ghost" data-act="open" data-id="${c.id}">Review</button>`;
      } else if (isOpen) {
        footer = `
          <span class="score-text">Ready to start</span>
          <button class="btn primary" data-act="open" data-id="${c.id}">Begin →</button>`;
      } else if (stat === "retry") {
        footer = `
          <span class="score-text">Last · <strong class="fail">${p.last || 0}%</strong></span>
          <button class="btn primary" data-act="open" data-id="${c.id}">Retry →</button>`;
      } else {
        footer = `
          <span class="lock-note">Previous 100% needed</span>
          <button class="btn disabled" disabled>Locked</button>`;
      }

      const cardCls = ["card"];
      if (isLocked) cardCls.push("locked");
      if (isOpen || stat === "retry") cardCls.push("is-open");
      if (isDone) cardCls.push("is-done");

      cardsHtml += `
        <div class="${cardCls.join(" ")}" data-act="open" data-id="${isLocked ? "" : c.id}">
          <div class="card-top">
            <div class="cat-icon">${c.icon}</div>
            ${isDone ? "" : `<span class="status ${STATUS_LBL.cls}"><span class="dot"></span>${STATUS_LBL.label}</span>`}
          </div>
          <div class="cat-id">${c.level} · ${String(c.order).padStart(2, "0")} of ${total}</div>
          <h3>${escapeHtml(c.name)}</h3>
          <div class="meta">
            <span class="meta-item">📋 <strong>${c.sopSteps.length}</strong> steps</span>
            <span class="meta-item">💬 <strong>${c.objections.length}</strong> objections</span>
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
          <div class="lede">SOP padhein, objection handling samjhein, fir quiz me <strong>100%</strong> score karein — tabhi agli category unlock hogi.</div>
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

    $root.querySelectorAll('[data-act="open"][data-id]').forEach(el => {
      const id = el.getAttribute("data-id");
      if (!id) return;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        go(`#/cat/${id}`);
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

  function renderQuiz(cat, idx) {
    const questions = generateQuiz(cat);
    if (questions.length === 0) {
      $root.innerHTML = `
        <div class="error-block">
          Is category ke liye quiz generate nahi ho payi — SOP/objection data thoda kam hai.
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
          <a href="#/cat/${cat.id}" class="back">← Back to SOP</a>
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
      const optsHtml = q.options.map((opt, i) =>
        `<div class="option" data-val="${escapeHtml(opt)}">
          <div class="letter">${letters[i]}</div>
          <div>${escapeHtml(opt)}</div>
        </div>`
      ).join("");

      document.getElementById("qArea").innerHTML = `
        <div class="q-card">
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
      const chosen = el.getAttribute("data-val");
      const isRight = chosen === q.correct;
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
        const v = o.getAttribute("data-val");
        if (v === q.correct) o.classList.add("correct");
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
            <a href="#/cat/${cat.id}" class="btn ghost lg">📖 Review SOP</a>
            ${passed
              ? (next
                  ? `<a href="#/cat/${next.id}" class="btn primary lg">Next Category →</a>`
                  : `<a href="#/" class="btn primary lg">🏠 Dashboard</a>`)
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
      out.push({
        ts:       Date.parse(r[idx.ts] || "") || 0,
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
    if (!API_ENABLED && !FORM_RESPONSES_CSV_URL && isAdmin()) {
      // Allow admin route to surface its config warning
      go("#/admin");
      return;
    }
    render();
  }

  boot();
})();
