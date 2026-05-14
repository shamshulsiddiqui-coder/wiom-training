/**
 * WIOM Training — Apps Script backend
 *
 * Deploys as a Web App (Anyone, even anonymous) and exposes JSON over GET.
 * Frontend (wiom-app.js) calls these endpoints to:
 *   1. Authenticate / auto-register users
 *   2. Submit quiz attempts (writes to Submissions tab)
 *   3. List users + submissions (admin dashboard)
 *
 * SETUP CHECKLIST (one-time):
 *   1. In the SAME Google Sheet that has your Categories tab, add 2 tabs:
 *
 *      Tab name: "Users"
 *        Headers (row 1):   Email | Name | Role
 *        Pre-fill row 2:    shamshul.siddiqui@wiom.in | Shamshul Siddiqui | admin
 *
 *      Tab name: "Submissions"
 *        Headers (row 1):   Timestamp | Email | Name | Category | Total Q | Correct | Score% | Result | Attempt#
 *
 *   2. In Apps Script (Extensions → Apps Script from your sheet), paste this file as `Code.gs`.
 *   3. Save → Deploy → New deployment → Type: Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *      → Deploy → Copy the Web App URL.
 *
 *   4. Paste the URL into `js/wiom-app.js` → APPS_SCRIPT_URL constant.
 *
 *   5. Done. App will auto-register users and stream submissions to the sheet.
 */

const USERS_TAB       = "Users";
const SUBMISSIONS_TAB = "Submissions";
const DEFAULT_ADMINS  = ["shamshul.siddiqui@wiom.in"];

// ---------- HTTP ENTRY POINTS ----------

function doGet(e)  { return handle_(e && e.parameter || {}); }
function doPost(e) {
  var p = (e && e.parameter) || {};
  if (e && e.postData && e.postData.contents) {
    try { var j = JSON.parse(e.postData.contents); for (var k in j) p[k] = j[k]; } catch (_) {}
  }
  return handle_(p);
}

function handle_(p) {
  try {
    var action = String(p.action || "").toLowerCase();
    var out;
    if      (action === "auth")        out = doAuth_(p);
    else if (action === "submit")      out = doSubmit_(p);
    else if (action === "users")       out = doListUsers_();
    else if (action === "submissions") out = doListSubmissions_();
    else if (action === "ping")        out = { ok: true, msg: "pong" };
    else                               out = { ok: false, error: "unknown action: " + action };
    return jsonResp_(out);
  } catch (err) {
    return jsonResp_({ ok: false, error: String(err) });
  }
}

function jsonResp_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- HELPERS ----------

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Tab not found: " + name);
  return sh;
}

function normEmail_(e) { return String(e || "").trim().toLowerCase(); }

// ---------- AUTH / AUTO-REGISTER ----------

function doAuth_(p) {
  var email = normEmail_(p.email);
  var name  = String(p.name || "").trim();
  if (!email || email.indexOf("@") < 0) return { ok: false, error: "valid email required" };

  var sh = sheet_(USERS_TAB);
  var data = sh.getDataRange().getValues();
  // data[0] is header
  for (var i = 1; i < data.length; i++) {
    if (normEmail_(data[i][0]) === email) {
      // Update name if user provided a new one and the cell is empty
      if (name && !data[i][1]) { sh.getRange(i + 1, 2).setValue(name); data[i][1] = name; }
      return {
        ok: true, email: email,
        name: data[i][1] || name,
        role: (data[i][2] || "agent").toString().toLowerCase()
      };
    }
  }
  // Auto-register
  var role = DEFAULT_ADMINS.indexOf(email) >= 0 ? "admin" : "agent";
  sh.appendRow([email, name, role]);
  return { ok: true, email: email, name: name, role: role };
}

// ---------- SUBMIT QUIZ ATTEMPT ----------

function doSubmit_(p) {
  var email   = normEmail_(p.email);
  if (!email) return { ok: false, error: "email required" };
  var name    = String(p.name || "");
  var cat     = String(p.category || "");
  var totalQ  = Number(p.totalQ || 0);
  var correct = Number(p.correct || 0);
  var score   = Number(p.score || 0);
  var passed  = String(p.passed) === "true" || p.passed === true;
  var attempt = Number(p.attempt || 1);

  sheet_(SUBMISSIONS_TAB).appendRow([
    new Date(), email, name, cat, totalQ, correct, score,
    passed ? "PASS" : "RETRY", attempt
  ]);
  return { ok: true };
}

// ---------- LISTS (for admin dashboard) ----------

function doListUsers_() {
  var data = sheet_(USERS_TAB).getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    rows.push({
      email: normEmail_(data[i][0]),
      name:  data[i][1] || "",
      role:  (data[i][2] || "agent").toString().toLowerCase()
    });
  }
  return { ok: true, rows: rows };
}

function doListSubmissions_() {
  var data = sheet_(SUBMISSIONS_TAB).getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][1]) continue; // skip empty rows
    rows.push({
      ts:       data[i][0] ? new Date(data[i][0]).getTime() : 0,
      email:    normEmail_(data[i][1]),
      name:     data[i][2] || "",
      category: data[i][3] || "",
      totalQ:   Number(data[i][4] || 0),
      correct:  Number(data[i][5] || 0),
      score:    Number(data[i][6] || 0),
      result:   String(data[i][7] || "").toUpperCase(),
      attempt:  Number(data[i][8] || 1)
    });
  }
  return { ok: true, rows: rows };
}
