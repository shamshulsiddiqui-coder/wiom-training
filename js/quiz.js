// Quiz engine — auto-generates MCQs from category's SOP + objection data
// quiz.html

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

  // Block access if agent tries to take a quiz for an unassigned category
  if (category && !isAdmin && !assignedIds.has(category.id)) {
    document.body.innerHTML =
      '<div style="padding:60px;text-align:center;font-family:sans-serif;">' +
      '<h2>🔒 Access nahi hai</h2>' +
      '<p style="margin:16px 0;color:#6B7280;">Aapko ye quiz abhi assign nahi hui hai.</p>' +
      '<a href="index.html" style="color:#2563EB;">← Dashboard par jaaye</a></div>';
    return;
  }

  if (!category) {
    document.body.innerHTML =
      '<div style="padding:60px;text-align:center;font-family:sans-serif;">' +
      '<h2>Quiz nahi mil paya 😕</h2>' +
      '<a href="index.html" style="color:#2563EB;">← Dashboard</a></div>';
    return;
  }

  // ============ MCQ AUTO-GENERATION ============

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Pool of distractors from OTHER categories — used to give wrong options
  function distractorsFromOtherCategories(field, exclude) {
    const pool = [];
    TRAINING_DATA.categories.forEach((c) => {
      if (c.id === exclude) return;
      if (field === "steps") pool.push(...c.sop.steps);
      if (field === "responses") pool.push(...c.objections.map((o) => o.response));
    });
    return pool;
  }

  function pickDistractors(pool, correct, n) {
    const filtered = pool.filter((x) => x !== correct);
    return shuffle(filtered).slice(0, n);
  }

  function generateQuestions() {
    const questions = [];

    // Type 1: SOP step ordering — "Process me [N]th step kya hai?"
    category.sop.steps.forEach((step, i) => {
      const otherSteps = category.sop.steps.filter((s) => s !== step);
      const otherCatSteps = distractorsFromOtherCategories("steps", category.id);
      const distractors = [
        ...pickDistractors(otherSteps, step, 2),
        ...pickDistractors(otherCatSteps, step, 1)
      ].slice(0, 3);
      questions.push({
        text: `${category.name} — Process me Step ${i + 1} kya hona chahiye?`,
        correct: step,
        options: shuffle([step, ...distractors]),
        explain: `Sahi step ${i + 1}: "${step}"`
      });
    });

    // Type 2: Objection → Correct response match
    category.objections.forEach((obj) => {
      const otherResponses = category.objections
        .filter((o) => o.response !== obj.response)
        .map((o) => o.response);
      const otherCatResponses = distractorsFromOtherCategories("responses", category.id);
      const distractors = [
        ...pickDistractors(otherResponses, obj.response, Math.min(2, otherResponses.length)),
        ...pickDistractors(otherCatResponses, obj.response, 3 - Math.min(2, otherResponses.length))
      ].slice(0, 3);
      questions.push({
        text: `CSP kehta hai: "${obj.objection}" — aapka best response kya hoga?`,
        correct: obj.response,
        options: shuffle([obj.response, ...distractors]),
        explain: `Best response: standard objection-handling script use karna.`
      });
    });

    // Type 3: First-step / Last-step recall
    questions.push({
      text: `${category.name} — Process ka SABSE PEHLA step kaunsa hai?`,
      correct: category.sop.steps[0],
      options: shuffle([
        category.sop.steps[0],
        ...pickDistractors(category.sop.steps.slice(1), category.sop.steps[0], 3)
      ]),
      explain: `Pehla step: ${category.sop.steps[0]}`
    });

    questions.push({
      text: `${category.name} — Call close karne se PEHLE aakhri step kya hona chahiye?`,
      correct: category.sop.steps[category.sop.steps.length - 1],
      options: shuffle([
        category.sop.steps[category.sop.steps.length - 1],
        ...pickDistractors(
          category.sop.steps.slice(0, -1),
          category.sop.steps[category.sop.steps.length - 1],
          3
        )
      ]),
      explain: `Aakhri step: ${category.sop.steps[category.sop.steps.length - 1]}`
    });

    return shuffle(questions).slice(0, category.questions || 8);
  }

  // ============ QUIZ STATE ============

  const questions = generateQuestions();
  let currentIdx = 0;
  let correctCount = 0;
  let answered = false;

  document.getElementById("quizTitle").textContent = `${category.icon} ${category.name} — MCQ`;
  document.getElementById("qTotal").textContent = questions.length;

  function renderQuestion() {
    answered = false;
    const q = questions[currentIdx];
    document.getElementById("qCurrent").textContent = currentIdx + 1;
    document.getElementById("quizProgress").style.width =
      `${(currentIdx / questions.length) * 100}%`;

    const area = document.getElementById("quizArea");
    area.innerHTML = `
      <div class="question-card">
        <div class="q-number">Question ${currentIdx + 1} of ${questions.length}</div>
        <div class="q-text">${escapeHtml(q.text)}</div>
        <div class="options-list" id="optionsList"></div>
        <div class="feedback" id="feedback"></div>
        <div style="text-align:right;">
          <button class="btn btn-primary" id="nextBtn" disabled style="opacity:0.5;">
            ${currentIdx === questions.length - 1 ? "Finish ✓" : "Next →"}
          </button>
        </div>
      </div>
    `;

    const optList = document.getElementById("optionsList");
    const letters = ["A", "B", "C", "D"];
    q.options.forEach((opt, i) => {
      const div = document.createElement("div");
      div.className = "option";
      div.innerHTML = `<div class="opt-letter">${letters[i]}</div><div>${escapeHtml(opt)}</div>`;
      div.addEventListener("click", () => selectOption(div, opt, q));
      optList.appendChild(div);
    });

    document.getElementById("nextBtn").addEventListener("click", nextQuestion);
  }

  function selectOption(el, chosen, q) {
    if (answered) return;
    answered = true;
    const allOpts = document.querySelectorAll(".option");
    allOpts.forEach((o) => {
      const text = o.querySelector("div:last-child").textContent;
      if (text === q.correct) o.classList.add("correct");
      else if (o === el && text !== q.correct) o.classList.add("wrong");
    });

    const fb = document.getElementById("feedback");
    if (chosen === q.correct) {
      correctCount++;
      fb.className = "feedback correct-fb show";
      fb.innerHTML = `✅ <strong>Sahi jawab!</strong> ${escapeHtml(q.explain || "")}`;
    } else {
      fb.className = "feedback wrong-fb show";
      fb.innerHTML = `❌ <strong>Galat.</strong> ${escapeHtml(q.explain || "")}`;
    }
    const btn = document.getElementById("nextBtn");
    btn.disabled = false;
    btn.style.opacity = "1";
  }

  function nextQuestion() {
    if (currentIdx < questions.length - 1) {
      currentIdx++;
      renderQuestion();
    } else {
      showResults();
    }
  }

  function showResults() {
    const total = questions.length;
    const pct = Math.round((correctCount / total) * 100);
    const passed = pct >= 70;

    // Save progress (per-user)
    try {
      WIOM_AUTH.recordScore(sess.email, category.id, {
        correct: correctCount,
        total: total,
        pct: pct,
        passed: passed,
      });
    } catch (e) {}

    document.getElementById("quizProgress").style.width = "100%";

    let emoji = "🎉", title = "Shaandaar!", msg = "Aapne is module ko clear kar liya.";
    if (!passed) {
      emoji = "📚"; title = "Thodi practice aur"; msg = "70% chahiye pass hone ke liye. SOP dobara padho aur try karo.";
    } else if (pct === 100) {
      emoji = "🏆"; title = "Perfect Score!"; msg = "Aap is topic ke expert ho!";
    }

    const area = document.getElementById("quizArea");
    area.innerHTML = `
      <div class="results-card">
        <div class="result-emoji">${emoji}</div>
        <h2>${title}</h2>
        <div class="score">${correctCount} / ${total}</div>
        <div class="score-label">${pct}% • ${passed ? "PASSED" : "RETRY KAREIN"}</div>
        <p style="margin-bottom:24px;">${msg}</p>
        <div class="cta-row">
          <a href="training.html?id=${category.id}" class="btn btn-secondary">📖 SOP dobara padho</a>
          <a href="index.html" class="btn btn-primary">🏠 Dashboard</a>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  renderQuestion();
})();
