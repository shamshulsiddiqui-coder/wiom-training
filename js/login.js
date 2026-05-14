// Login page logic

(function () {
  // If already logged in, redirect
  const sess = WIOM_AUTH.getSession();
  if (sess) {
    window.location.href = sess.role === "admin" ? "admin.html" : "index.html";
    return;
  }

  const form = document.getElementById("loginForm");
  const errEl = document.getElementById("authError");
  const emailEl = document.getElementById("email");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errEl.textContent = "";
    const email = emailEl.value.trim();
    const result = WIOM_AUTH.login(email);
    if (!result.ok) {
      errEl.textContent = result.error;
      return;
    }
    window.location.href = result.role === "admin" ? "admin.html" : "index.html";
  });
})();
