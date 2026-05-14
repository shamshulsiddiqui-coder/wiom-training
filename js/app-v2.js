// Split-view dashboard (index-v2.html)

(function () {
  // Auth guard
  const sess = WIOM_AUTH.requireLogin();
  if (!sess) return;
  WIOM_AUTH.injectUserChip(".topbar");

  const user = WIOM_AUTH.getUser(sess.email);
  const isAdmin = sess.role === "admin";

  // Greeting
  const hour = new Date().getHours();
  let greet = "Namaste 👋";
  if (hour < 12) greet = "Good Morning ☀️";
  else if (hour < 17) greet = "Good Afternoon 🌤️";
  else greet = "Good Evening 🌙";
  document.getElementById("v2Greet").textContent =
    `${greet}, ${user?.name?.split(" ")[0] || ""}`;

  document.getElementById("v2Date").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "short"
  });

  function getProgress() { return WIOM_AUTH.getProgressFor(sess.email); }

  // Filter to assigned categories for agents; admin sees all
  const allCats = TRAINING_DATA.categories;
  const assignedIds = new Set(user?.assignedCategories || []);
  const cats = isAdmin ? allCats : allCats.filter((c) => assignedIds.has(c.id));

  // Empty state for agents with no assignment
  if (!isAdmin && cats.length === 0) {
    document.querySelector(".v2-shell").innerHTML = `
      <div class="no-assignment-block" style="margin: auto;">
        <div class="na-emoji">🎓</div>
        <h2>Abhi tak koi training assign nahi hui</h2>
        <p>
          Aapke admin ne abhi tak aapko koi topic assign nahi kiya hai.<br/>
          Kripya admin se contact karein — assignment hone ke baad yahan training start kar payenge.
        </p>
      </div>
    `;
    return;
  }

  let activeId = null;

  // Build sidebar
  const list = document.getElementById("v2CatList");
  function renderSidebar(filter = "") {
    list.innerHTML = "";
    const progress = getProgress();
    const f = filter.trim().toLowerCase();
    let doneCount = 0;

    cats.forEach((c) => {
      if (progress[c.id]?.passed) doneCount++;
      if (f && !c.name.toLowerCase().includes(f) && !c.id.includes(f)) return;

      const item = document.createElement("div");
      item.className = "v2-cat-item";
      if (c.id === activeId) item.classList.add("active");
      if (progress[c.id]?.passed) item.classList.add("completed");

      const stepCount = c.sop.steps.length;
      const objCount = c.objections.length;

      item.innerHTML = `
        <div class="v2-icon">${c.icon}</div>
        <div class="v2-cat-meta">
          <div class="v2-cat-name">${escape(c.name)}</div>
          <div class="v2-cat-sub">${c.level} • ${stepCount} steps • ${objCount} obj</div>
        </div>
        <div class="v2-status-dot" title="${progress[c.id]?.passed ? 'Completed' : 'Pending'}"></div>
      `;
      item.addEventListener("click", () => selectCategory(c.id));
      list.appendChild(item);
    });

    document.getElementById("v2DoneCount").textContent = doneCount;
    document.getElementById("v2TotalCount").textContent = cats.length;
  }

  function selectCategory(id) {
    activeId = id;
    renderSidebar(document.getElementById("v2Search").value);
    const c = cats.find((x) => x.id === id);
    if (!c) return;
    renderRightPane(c);
  }

  function renderRightPane(c) {
    const pane = document.getElementById("v2RightPane");
    const progress = getProgress();
    const score = progress[c.id];
    const scoreLine = score
      ? `<span style="background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:50px;margin-left:8px;">Last: ${score.correct}/${score.total} (${score.pct}%)</span>`
      : "";

    let stepsHtml = "";
    c.sop.steps.forEach((s, i) => {
      stepsHtml += `<div class="v2-step"><div class="v2-step-num">${i + 1}</div><div class="v2-step-text">${escape(s)}</div></div>`;
    });

    let objHtml = "";
    if (c.objections.length === 0) {
      objHtml = `<div style="color:#6B7280;font-style:italic;">Is category ke liye objection handling abhi available nahi hai.</div>`;
    } else {
      c.objections.forEach((o) => {
        objHtml += `
          <div class="v2-obj-card">
            <div class="v2-obj-q">${escape(o.objection)}</div>
            <div class="v2-obj-a">${escape(o.response)}</div>
          </div>
        `;
      });
    }

    pane.innerHTML = `
      <div class="v2-detail-hero" style="background: ${c.gradient};">
        <span class="v2-badge">${c.level} • ${c.duration}</span>
        <h1>${c.icon} ${escape(c.name)}</h1>
        <div class="v2-meta">
          ${c.sop.steps.length} SOP steps • ${c.objections.length} objections • ${c.questions} MCQs
          ${scoreLine}
        </div>
      </div>
      <div class="v2-detail-body">
        <div class="v2-section">
          <h3>📋 ${escape(c.sop.title)}</h3>
          ${stepsHtml}
        </div>
        <div class="v2-section">
          <h3>💬 Objection Handling</h3>
          ${objHtml}
        </div>
        <div class="v2-cta">
          <a href="quiz.html?id=${c.id}" class="btn btn-primary">📝 Start Quiz</a>
        </div>
      </div>
    `;
    pane.scrollTop = 0;
  }

  // Search
  document.getElementById("v2Search").addEventListener("input", (e) => {
    renderSidebar(e.target.value);
  });

  function escape(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Initial render — load first category by default
  renderSidebar();
  if (cats.length > 0) selectCategory(cats[0].id);
})();
