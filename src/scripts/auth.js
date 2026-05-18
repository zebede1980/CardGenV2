// Authentication module for SillyTavern Character Generator
// Manages JWT tokens, login/register UI, and authenticated fetch

const AUTH_TOKEN_KEY = "cardgen_auth_token";
const AUTH_USER_KEY = "cardgen_auth_user";

// ── Token helpers ─────────────────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || "null");
  } catch {
    return null;
  }
}

function setStoredUser(user) {
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

// ── Authenticated fetch wrapper ───────────────────────────────────────────────
// Drop-in replacement for fetch() that injects the Bearer token and redirects
// to the login screen on 401 responses.

window.authFetch = async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && token && getToken() === token) {
    // Only clear + redirect if the token we sent is still the current one.
    // This prevents an in-flight request (made with an old/expired token)
    // from wiping a freshly-issued token after a successful re-login.
    clearToken();
    window.location.reload();
  }
  return res;
};

// ── API calls ─────────────────────────────────────────────────────────────────

async function apiLogin(username, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");
  return data;
}

async function apiRegister(username, password) {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Registration failed");
  return data;
}

async function apiMe() {
  const token = getToken();
  if (!token) return null;
  const res = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function isRegistrationOpen() {
  try {
    const res = await fetch("/api/auth/registration-open");
    if (!res.ok) return false;
    const data = await res.json();
    return data.open === true;
  } catch {
    return false;
  }
}

async function apiChangePassword(currentPassword, newPassword, targetUsername = null) {
  const token = getToken();
  if (!token) throw new Error("Not logged in");

  const body = { newPassword };
  if (currentPassword) body.currentPassword = currentPassword;
  if (targetUsername) body.targetUsername = targetUsername;

  const res = await fetch("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to change password");
  return data;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function initChangePasswordUI() {
  const btn = document.getElementById("change-password-btn");
  const modal = document.getElementById("change-password-modal");
  const closeBtn = document.getElementById("change-password-modal-close-btn");
  const form = document.getElementById("change-password-form");

  if (!btn || !modal || !form) return;

  const targetUserSection = document.getElementById("admin-target-user-section");
  const currentPasswordSection = document.getElementById("cp-current-password-section");
  const targetUsernameInput = document.getElementById("cp-target-username");
  const currentPasswordInput = document.getElementById("cp-current-password");

  btn.addEventListener("click", () => {
    const user = getStoredUser();
    // Safe case-insensitive check so logging in as "Admin" or "admin" both work
    const isAdmin = user && user.username && user.username.toLowerCase() === "admin";

    if (isAdmin && targetUserSection) {
      targetUserSection.style.display = "block";
    } else if (targetUserSection) {
      targetUserSection.style.display = "none";
    }

    form.reset();
    document.getElementById("cp-error").style.display = "none";
    document.getElementById("cp-success").style.display = "none";
    document.getElementById("cp-submit-btn").disabled = false;
    currentPasswordSection.style.display = "block";

    modal.classList.add("show");
    document.body.style.overflow = "hidden";
  });

  if (targetUsernameInput) {
    targetUsernameInput.addEventListener("input", (e) => {
      if (e.target.value.trim() !== "") {
        currentPasswordSection.style.display = "none";
        currentPasswordInput.removeAttribute("required");
      } else {
        currentPasswordSection.style.display = "block";
        currentPasswordInput.setAttribute("required", "true");
      }
    });
  }

  const closeModal = () => {
    modal.classList.remove("show");
    document.body.style.overflow = "";
  };

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("show")) closeModal(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const targetUsername = targetUsernameInput?.value.trim() || null;
    const currentPassword = currentPasswordInput?.value || null;
    const newPassword = document.getElementById("cp-new-password")?.value || "";
    const confirmPassword = document.getElementById("cp-confirm-password")?.value || "";
    const errEl = document.getElementById("cp-error");
    const succEl = document.getElementById("cp-success");
    const submitBtn = document.getElementById("cp-submit-btn");

    errEl.style.display = "none";
    succEl.style.display = "none";

    if (!targetUsername && !currentPassword) {
      errEl.textContent = "Current password is required.";
      errEl.style.display = "block";
      return;
    }
    if (newPassword.length < 8) {
      errEl.textContent = "New password must be at least 8 characters.";
      errEl.style.display = "block";
      return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = "New passwords do not match.";
      errEl.style.display = "block";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Changing...";
    try {
      const result = await apiChangePassword(currentPassword, newPassword, targetUsername);
      succEl.textContent = result.message || "Password changed successfully!";
      succEl.style.display = "block";
      form.reset();
      setTimeout(() => closeModal(), 2000);
    } catch (err) {
      errEl.textContent = err.message || "Failed to change password.";
      errEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Change Password";
    }
  });
}

function showAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.style.display = "flex";
  const app = document.getElementById("app-root");
  if (app) app.style.display = "none";
}

function hideAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.style.display = "none";
  const app = document.getElementById("app-root");
  if (app) app.style.display = "";
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (el) {
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }
}

function setAuthLoading(loading) {
  const btn = document.getElementById("auth-submit-btn");
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : btn.dataset.label;
}

function updateUserBar(username) {
  const bar = document.getElementById("user-bar");
  const nameEl = document.getElementById("user-bar-name");
  if (bar) bar.style.display = username ? "flex" : "none";
  if (nameEl) nameEl.textContent = username ? `👤 ${username}` : "";
}

// Switch between login and register forms
function setAuthMode(mode) {
  const loginFields = document.getElementById("auth-login-fields");
  const registerFields = document.getElementById("auth-register-fields");
  const toggleEl = document.getElementById("auth-mode-toggle");
  const submitBtn = document.getElementById("auth-submit-btn");
  const titleEl = document.getElementById("auth-title");

  if (mode === "register") {
    if (registerFields) registerFields.style.display = "block";
    if (toggleEl) toggleEl.innerHTML = 'Already have an account? <a href="#" id="auth-toggle-link">Sign In</a>';
    if (submitBtn) { submitBtn.textContent = "Create Account"; submitBtn.dataset.label = "Create Account"; submitBtn.dataset.mode = "register"; }
    if (titleEl) titleEl.textContent = "Create Account";
  } else {
    if (registerFields) registerFields.style.display = "none";
    if (toggleEl) toggleEl.innerHTML = 'Don\'t have an account? <a href="#" id="auth-toggle-link">Sign Up</a>';
    if (submitBtn) { submitBtn.textContent = "Sign In"; submitBtn.dataset.label = "Sign In"; submitBtn.dataset.mode = "login"; }
    if (titleEl) titleEl.textContent = "Sign In";
  }

  setAuthError("");
  // Re-bind toggle link
  const link = document.getElementById("auth-toggle-link");
  if (link) link.addEventListener("click", (e) => { e.preventDefault(); setAuthMode(mode === "login" ? "register" : "login"); });
}

// ── Story Writer tab detection ─────────────────────────────────────────────

async function checkStoryApp() {
  try {
    const res = await authFetch("/api/story-app/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data.available && data.url) {
      const tab = document.getElementById("story-writer-tab");
      if (tab) {
        tab.href = data.url;
        tab.style.display = "inline-flex";
      }
    }
  } catch (_) {
    // Story Writer not reachable — tab stays hidden, no error shown
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function initAuth() {
  // Check if registration is open and configure the overlay accordingly
  const regOpen = await isRegistrationOpen();

  const toggleRow = document.getElementById("auth-toggle-row");
  if (toggleRow) toggleRow.style.display = regOpen ? "block" : "none";

  // Wire up form submission
  const form = document.getElementById("auth-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const mode = document.getElementById("auth-submit-btn")?.dataset.mode || "login";
      const username = document.getElementById("auth-username")?.value.trim() || "";
      const password = document.getElementById("auth-password")?.value || "";
      const confirmPassword = mode === "register"
        ? document.getElementById("auth-confirm-password")?.value || ""
        : null;

      setAuthError("");

      if (!username || !password) {
        setAuthError("Username and password are required.");
        return;
      }

      if (mode === "register") {
        if (password.length < 8) {
          setAuthError("Password must be at least 8 characters.");
          return;
        }
        if (confirmPassword !== null && password !== confirmPassword) {
          setAuthError("Passwords do not match.");
          return;
        }
      }

      setAuthLoading(true);
      try {
        const result = mode === "login"
          ? await apiLogin(username, password)
          : await apiRegister(username, password);

        setToken(result.token);
        setStoredUser({ username: result.username });
        updateUserBar(result.username);
        hideAuthOverlay();
        checkStoryApp();
        // Trigger app initialisation if it hasn't started yet
        if (typeof window.onAuthSuccess === "function") {
          window.onAuthSuccess();
        }
      } catch (err) {
        setAuthError(err.message);
      } finally {
        setAuthLoading(false);
      }
    });
  }

  // Wire up logout button
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearToken();
      // Reload the page to ensure all application state is wiped from memory
      window.location.reload();
    });
  }

  // Set default mode
  setAuthMode("login");

  initChangePasswordUI();

  // Check if already authenticated
  const user = await apiMe();
  if (user) {
    setStoredUser(user);
    updateUserBar(user.username);
    hideAuthOverlay();
    checkStoryApp();
    return true; // already authenticated
  } else {
    clearToken();
    showAuthOverlay();
    return false;
  }
}

// Expose for other modules
window.cardgenAuth = { getToken, clearToken, initAuth, apiChangePassword };
