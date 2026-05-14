// WIOM Auth — shared auth helpers (localStorage-based mock auth)
// Load this BEFORE other scripts on every protected page.

const WIOM_AUTH = (function () {
  const ADMIN_EMAILS = ["shamshul.siddiqui@wiom.in"];
  const SESSION_KEY = "wiom_session";
  const USERS_KEY = "wiom_users";
  const PROGRESS_KEY = "wiom_progress";

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  }

  function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = "login.html";
  }

  function getAllUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY) || "{}"); }
    catch { return {}; }
  }

  function saveAllUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

  function upsertUser(email, patch) {
    const users = getAllUsers();
    const existing = users[email] || {
      email, name: deriveName(email),
      role: ADMIN_EMAILS.includes(email) ? "admin" : "agent",
      assignedCategories: [],
      registeredAt: new Date().toISOString(),
    };
    users[email] = { ...existing, ...patch };
    saveAllUsers(users);
    return users[email];
  }

  function getUser(email) {
    return getAllUsers()[email] || null;
  }

  function deriveName(email) {
    const local = (email.split("@")[0] || "").replace(/\./g, " ");
    return local.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function isValidWiomEmail(email) {
    return /^[a-z0-9._%+-]+@wiom\.in$/i.test(email.trim());
  }

  function isAdmin(email) { return ADMIN_EMAILS.includes((email || "").toLowerCase()); }

  function login(email) {
    const norm = email.trim().toLowerCase();
    if (!isValidWiomEmail(norm)) {
      return { ok: false, error: "Sirf @wiom.in email se login allowed hai." };
    }
    const role = isAdmin(norm) ? "admin" : "agent";
    upsertUser(norm, { role });
    setSession({ email: norm, role, loggedInAt: new Date().toISOString() });
    return { ok: true, role };
  }

  // Page guard — call at top of any protected page
  function requireLogin(opts = {}) {
    const sess = getSession();
    if (!sess) {
      window.location.href = "login.html";
      return null;
    }
    if (opts.adminOnly && sess.role !== "admin") {
      window.location.href = "index.html";
      return null;
    }
    return sess;
  }

  // Progress (per-user)
  function getAllProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveAllProgress(p) { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); }

  function getProgressFor(email) {
    return getAllProgress()[email] || {};
  }

  function recordScore(email, categoryId, scoreObj) {
    const all = getAllProgress();
    if (!all[email]) all[email] = {};
    all[email][categoryId] = { ...scoreObj, completedAt: new Date().toISOString() };
    saveAllProgress(all);
  }

  function assignCategories(email, categoryIds) {
    upsertUser(email, { assignedCategories: categoryIds });
  }

  // Top-bar widget — call from any protected page after DOM ready
  function injectUserChip(targetSelector = ".topbar") {
    const sess = getSession();
    if (!sess) return;
    const user = getUser(sess.email);
    const target = document.querySelector(targetSelector);
    if (!target) return;
    // Remove existing chip if any
    const existing = target.querySelector(".wiom-user-chip");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.className = "wiom-user-chip";
    wrap.innerHTML = `
      <div class="wuc-info">
        <div class="wuc-name">${escapeHtml(user?.name || sess.email)}</div>
        <div class="wuc-role">${sess.role === "admin" ? "👑 Admin" : "🎧 Agent"}</div>
      </div>
      ${sess.role === "admin" ? '<a href="admin.html" class="wuc-link">Admin Panel</a>' : ""}
      <a href="#logout" class="wuc-link wuc-logout">Logout</a>
    `;
    // Replace or append to topbar's right side
    const reset = target.querySelector("#resetLink, #resetLinkV2");
    if (reset) reset.remove();
    target.appendChild(wrap);
    wrap.querySelector(".wuc-logout").addEventListener("click", (e) => {
      e.preventDefault();
      if (confirm("Logout karna hai?")) logout();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  return {
    ADMIN_EMAILS,
    getSession, login, logout, requireLogin,
    getUser, getAllUsers, upsertUser, isValidWiomEmail, isAdmin,
    getProgressFor, getAllProgress, recordScore, assignCategories,
    injectUserChip,
  };
})();
