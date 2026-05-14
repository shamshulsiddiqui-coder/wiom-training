// Admin panel logic

(function () {
  const sess = WIOM_AUTH.requireLogin({ adminOnly: true });
  if (!sess) return;
  WIOM_AUTH.injectUserChip(".topbar");

  const cats = TRAINING_DATA.categories;
  let assignTargetEmail = null;
  let assignSelected = new Set();

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderStats(users, progressAll) {
    const agents = Object.values(users).filter((u) => u.role === "agent");
    const assignedAgents = agents.filter((u) => (u.assignedCategories || []).length > 0).length;
    let totalTopics = 0;
    let passes = 0;
    agents.forEach((a) => {
      totalTopics += (a.assignedCategories || []).length;
      const p = progressAll[a.email] || {};
      Object.values(p).forEach((s) => { if (s.passed) passes++; });
    });
    document.getElementById("statAgents").textContent = agents.length;
    document.getElementById("statAssigned").textContent = assignedAgents;
    document.getElementById("statTopics").textContent = totalTopics;
    document.getElementById("statPasses").textContent = passes;
  }

  function renderAgents() {
    const users = WIOM_AUTH.getAllUsers();
    const progressAll = WIOM_AUTH.getAllProgress();
    renderStats(users, progressAll);

    const agents = Object.values(users)
      .filter((u) => u.role === "agent")
      .sort((a, b) => (a.registeredAt || "").localeCompare(b.registeredAt || ""));

    const tbody = document.getElementById("agentsTbody");
    if (agents.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#6B7280;padding:24px;">
        Koi agent abhi register nahi hua. Agent ko apni @wiom.in email se login karne ko bolo.
      </td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    agents.forEach((a) => {
      const assignedCount = (a.assignedCategories || []).length;
      const userProg = progressAll[a.email] || {};
      const passedCount = Object.values(userProg).filter((s) => s.passed).length;
      const totalAttempted = Object.keys(userProg).length;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(a.email)}</td>
        <td>${escapeHtml(a.name)}</td>
        <td><span class="user-pill">Agent</span></td>
        <td><span class="assign-count">${assignedCount}</span> / ${cats.length}</td>
        <td class="score-cell">
          ${totalAttempted === 0
            ? "—"
            : `<strong>${passedCount}</strong> passed / ${totalAttempted} attempted`}
          ${totalAttempted > 0 ? `<br/><a href="#" class="view-progress" data-email="${escapeHtml(a.email)}" style="font-size:11px;color:#2563EB;">View detail</a>` : ""}
        </td>
        <td><button class="assign-btn" data-email="${escapeHtml(a.email)}">Assign Topics</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".assign-btn").forEach((b) => {
      b.addEventListener("click", () => openAssignModal(b.dataset.email));
    });
    tbody.querySelectorAll(".view-progress").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openProgressModal(a.dataset.email);
      });
    });
  }

  function openAssignModal(email) {
    assignTargetEmail = email;
    const user = WIOM_AUTH.getUser(email);
    assignSelected = new Set(user?.assignedCategories || []);
    document.getElementById("modalAgentName").textContent = user?.name || email;

    const grid = document.getElementById("assignGrid");
    grid.innerHTML = "";
    cats.forEach((c) => {
      const checked = assignSelected.has(c.id);
      const row = document.createElement("label");
      row.className = "assign-row" + (checked ? " checked" : "");
      row.innerHTML = `
        <input type="checkbox" data-id="${c.id}" ${checked ? "checked" : ""} />
        <div class="a-icon">${c.icon}</div>
        <div class="a-name">${escapeHtml(c.name)}</div>
        <div class="a-id">${c.level}</div>
      `;
      const cb = row.querySelector("input");
      cb.addEventListener("change", () => {
        if (cb.checked) assignSelected.add(c.id);
        else assignSelected.delete(c.id);
        row.classList.toggle("checked", cb.checked);
        updateSelectedCount();
      });
      grid.appendChild(row);
    });
    updateSelectedCount();
    document.getElementById("assignModal").classList.remove("hidden");
  }

  function updateSelectedCount() {
    document.getElementById("selectedCount").textContent =
      `${assignSelected.size} of ${cats.length} selected`;
  }

  function closeAssignModal() {
    document.getElementById("assignModal").classList.add("hidden");
    assignTargetEmail = null;
  }

  document.getElementById("modalClose").addEventListener("click", closeAssignModal);
  document.getElementById("modalCancel").addEventListener("click", closeAssignModal);

  document.getElementById("modalSave").addEventListener("click", () => {
    if (!assignTargetEmail) return;
    WIOM_AUTH.assignCategories(assignTargetEmail, [...assignSelected]);
    closeAssignModal();
    renderAgents();
  });

  document.getElementById("selectAll").addEventListener("click", () => {
    cats.forEach((c) => assignSelected.add(c.id));
    refreshAssignChecks();
  });
  document.getElementById("selectNone").addEventListener("click", () => {
    assignSelected.clear();
    refreshAssignChecks();
  });
  document.getElementById("selectL1").addEventListener("click", () => {
    assignSelected.clear();
    cats.forEach((c) => { if (c.level === "L1") assignSelected.add(c.id); });
    refreshAssignChecks();
  });

  function refreshAssignChecks() {
    const grid = document.getElementById("assignGrid");
    grid.querySelectorAll(".assign-row").forEach((row) => {
      const cb = row.querySelector("input");
      const id = cb.dataset.id;
      const on = assignSelected.has(id);
      cb.checked = on;
      row.classList.toggle("checked", on);
    });
    updateSelectedCount();
  }

  // Progress modal
  function openProgressModal(email) {
    const user = WIOM_AUTH.getUser(email);
    const prog = WIOM_AUTH.getProgressFor(email);
    document.getElementById("progressAgentName").textContent = user?.name || email;
    const body = document.getElementById("progressBody");
    const rows = (user?.assignedCategories || []).map((cid) => {
      const c = cats.find((x) => x.id === cid);
      const s = prog[cid];
      const status = s
        ? (s.passed
            ? `<span style="color:#059669;font-weight:600;">✓ Passed (${s.pct}%)</span>`
            : `<span style="color:#DC2626;font-weight:600;">✗ Failed (${s.pct}%)</span>`)
        : `<span style="color:#9CA3AF;">Not attempted</span>`;
      const when = s?.completedAt
        ? new Date(s.completedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
        : "—";
      return `
        <tr>
          <td>${c?.icon || ""} ${escapeHtml(c?.name || cid)}</td>
          <td>${status}</td>
          <td style="color:#6B7280;font-size:12px;">${when}</td>
        </tr>
      `;
    }).join("");
    body.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Category</th><th>Status</th><th>Last Attempt</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" style="color:#6B7280;text-align:center;padding:20px;">Koi assignment nahi hai.</td></tr>`}</tbody>
      </table>
    `;
    document.getElementById("progressModal").classList.remove("hidden");
  }
  document.getElementById("progressClose").addEventListener("click", () => {
    document.getElementById("progressModal").classList.add("hidden");
  });

  // ========== Add Agent modal ==========
  const addModal = document.getElementById("addAgentModal");
  const addEmail = document.getElementById("newAgentEmail");
  const addName = document.getElementById("newAgentName");
  const addError = document.getElementById("addAgentError");

  function openAddAgentModal() {
    addEmail.value = "";
    addName.value = "";
    addError.textContent = "";
    addModal.classList.remove("hidden");
    setTimeout(() => addEmail.focus(), 50);
  }
  function closeAddAgentModal() { addModal.classList.add("hidden"); }

  document.getElementById("addAgentBtn").addEventListener("click", openAddAgentModal);
  document.getElementById("addAgentClose").addEventListener("click", closeAddAgentModal);
  document.getElementById("addAgentCancel").addEventListener("click", closeAddAgentModal);

  document.getElementById("addAgentSave").addEventListener("click", () => {
    addError.textContent = "";
    const email = addEmail.value.trim().toLowerCase();
    const name = addName.value.trim();

    if (!email) {
      addError.textContent = "Email zaroori hai.";
      return;
    }
    if (!WIOM_AUTH.isValidWiomEmail(email)) {
      addError.textContent = "Sirf @wiom.in email allowed hai.";
      return;
    }
    if (WIOM_AUTH.isAdmin(email)) {
      addError.textContent = "Ye admin email hai — agent ke roop me add nahi ho sakta.";
      return;
    }

    const existing = WIOM_AUTH.getUser(email);
    if (existing) {
      addError.textContent = "Ye agent already exist karta hai.";
      return;
    }

    // Create the agent
    const patch = { role: "agent" };
    if (name) patch.name = name;
    WIOM_AUTH.upsertUser(email, patch);

    closeAddAgentModal();
    renderAgents();

    // Open assignment modal directly so admin can assign topics right away
    openAssignModal(email);
  });

  // Allow Enter key to submit Add Agent form
  [addEmail, addName].forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("addAgentSave").click();
      }
    });
  });

  // Initial render
  renderAgents();
})();
