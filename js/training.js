// Training module page logic — training.html

(function () {
  // Auth guard
  const sess = WIOM_AUTH.requireLogin();
  if (!sess) return;
  WIOM_AUTH.injectUserChip(".topbar");

  const user = WIOM_AUTH.getUser(sess.email);
  const isAdmin = sess.role === "admin";
  const assignedIds = new Set(user?.assignedCategories || []);

  const params = new URLSearchParams(window.location.search);
  const categoryId = params.get("id");
  const category = TRAINING_DATA.categories.find((c) => c.id === categoryId);

  // Block access if agent tries to open a category they aren't assigned
  if (category && !isAdmin && !assignedIds.has(category.id)) {
    document.body.innerHTML =
      '<div style="padding:60px;text-align:center;font-family:sans-serif;">' +
      '<h2>🔒 Access nahi hai</h2>' +
      '<p style="margin:16px 0;color:#6B7280;">Aapko ye category abhi assign nahi hui hai.</p>' +
      '<a href="index.html" style="color:#2563EB;">← Dashboard par jaaye</a></div>';
    return;
  }

  if (!category) {
    document.body.innerHTML =
      '<div style="padding:60px;text-align:center;font-family:sans-serif;">' +
      '<h2>Category nahi mili 😕</h2>' +
      '<p style="margin:16px 0;">Aap dashboard se koi category select karein.</p>' +
      '<a href="index.html" style="color:#2563EB;">← Dashboard par jaaye</a></div>';
    return;
  }

  // Hero section
  document.getElementById("trainingHero").style.background = category.gradient;
  document.getElementById("levelBadge").textContent = `${category.level} • ${category.duration}`;
  document.getElementById("categoryName").textContent = `${category.icon} ${category.name}`;
  document.getElementById("categoryMeta").textContent =
    `${category.sop.steps.length} SOP steps • ${category.objections.length} objections • ${category.questions} MCQs`;

  // SOP
  document.getElementById("sopTitle").textContent = category.sop.title;
  const sopContainer = document.getElementById("sopSteps");
  category.sop.steps.forEach((step, i) => {
    const div = document.createElement("div");
    div.className = "sop-step";
    div.innerHTML = `<div class="step-num">${i + 1}</div><div class="step-text">${step}</div>`;
    sopContainer.appendChild(div);
  });

  // Objections
  const objContainer = document.getElementById("objectionsList");
  category.objections.forEach((obj) => {
    const div = document.createElement("div");
    div.className = "objection-card";
    div.innerHTML = `
      <div class="objection-text">${obj.objection}</div>
      <div class="response-text">${obj.response}</div>
    `;
    objContainer.appendChild(div);
  });

  // Quiz button
  document.getElementById("startQuizBtn").addEventListener("click", () => {
    window.location.href = `quiz.html?id=${category.id}`;
  });

  // Page title
  document.title = `${category.name} — WIOM Training`;
})();
