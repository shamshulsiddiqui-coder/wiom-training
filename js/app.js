// Dashboard logic — index.html

(function () {
  // Auth guard
  const sess = WIOM_AUTH.requireLogin();
  if (!sess) return;
  WIOM_AUTH.injectUserChip(".topbar");

  const user = WIOM_AUTH.getUser(sess.email);
  const isAdmin = sess.role === "admin";

  // Greeting based on hour
  const hour = new Date().getHours();
  let greet = "Namaste 👋";
  if (hour < 12) greet = "Good Morning ☀️";
  else if (hour < 17) greet = "Good Afternoon 🌤️";
  else greet = "Good Evening 🌙";
  document.getElementById("greeting").textContent =
    `${greet}, ${user?.name?.split(" ")[0] || ""}`;

  // Today's date
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
  document.getElementById("todayDate").textContent = dateStr;

  // WIOM intro placeholders
  document.getElementById("introText").textContent = TRAINING_DATA.brand.intro;
  document.getElementById("problemText").textContent = TRAINING_DATA.brand.marketProblem;
  document.getElementById("contributionText").textContent = TRAINING_DATA.brand.contribution;

  // Determine which categories the current user can see
  // - Admin: sees all categories
  // - Agent: sees only assigned categories
  const allCats = TRAINING_DATA.categories;
  const assignedIds = new Set(user?.assignedCategories || []);
  const visibleCats = isAdmin ? allCats : allCats.filter((c) => assignedIds.has(c.id));

  document.getElementById("todayCount").textContent = visibleCats.length;

  // No assignment for agents — show empty state, hide grids
  if (!isAdmin && visibleCats.length === 0) {
    const main = document.querySelector("main.container");
    if (main) {
      main.innerHTML = `
        <div class="no-assignment-block">
          <div class="na-emoji">🎓</div>
          <h2>Abhi tak koi training assign nahi hui</h2>
          <p>
            Aapke admin ne abhi tak aapko koi topic assign nahi kiya hai.<br/>
            Kripya admin se contact karein — assignment hone ke baad yahan training start kar payenge.
          </p>
        </div>
      `;
    }
    return;
  }

  function getProgress() {
    return WIOM_AUTH.getProgressFor(sess.email);
  }

  function renderCard(category, container, progress) {
    const card = document.createElement("div");
    card.className = "category-card";
    const score = progress[category.id];
    const isCompleted = score && score.passed;
    if (isCompleted) card.classList.add("completed");

    const progressPct = score ? Math.round((score.correct / score.total) * 100) : 0;

    card.innerHTML = `
      <div class="card-banner" style="background: ${category.gradient};">${category.icon}</div>
      <div class="card-body">
        <span class="level-badge">${category.level} • ${category.duration}</span>
        <h3>${category.name}</h3>
        <div class="meta">
          <span>📚 ${category.sop.steps.length} steps</span>
          <span>💬 ${category.objections.length} objections</span>
          <span>📝 ${category.questions} MCQs</span>
        </div>
        <div class="progress-bar">
          <div class="progress-bar-fill" style="width: ${progressPct}%"></div>
        </div>
        <button class="start-btn">${isCompleted ? "Completed — Revise" : "Start Training"}</button>
      </div>
    `;
    card.addEventListener("click", () => {
      window.location.href = `training.html?id=${category.id}`;
    });
    container.appendChild(card);
  }

  function renderAll() {
    const progress = getProgress();
    const todayGrid = document.getElementById("todayGrid");
    const allGrid = document.getElementById("allGrid");
    todayGrid.innerHTML = "";
    allGrid.innerHTML = "";

    // For agents: same set in both grids (their assigned)
    // For admin: today plan from data + all categories
    const todayPlanIds = isAdmin
      ? (TRAINING_DATA.todayPlan || []).filter((id) => allCats.some((c) => c.id === id))
      : visibleCats.map((c) => c.id);
    const todaySet = new Set(todayPlanIds);

    visibleCats.forEach((cat) => {
      if (todaySet.has(cat.id)) renderCard(cat, todayGrid, progress);
      renderCard(cat, allGrid, progress);
    });

    // Hide "Saari Categories" section if it equals today's plan (agent case)
    if (!isAdmin) {
      const allSection = allGrid.closest("section");
      if (allSection) allSection.style.display = "none";
    }
  }

  renderAll();
})();
