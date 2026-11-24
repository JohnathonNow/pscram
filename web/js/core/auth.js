/**
 * Authentication state, refreshable Bearer token management, and authenticated `api()` / `authFetch()` helpers.
 */

import { escapeHtml } from "./highlight.js";
import { toast } from "./ui_helpers.js";

// --- Auth & Refreshable Token Client ---
const AUTH_KEYS = {
  access: "mlnb_access_token",
  refresh: "mlnb_refresh_token",
  exp: "mlnb_access_exp",
};

const authState = {
  required: false,
  requiredGroup: null,
  user: null,
  refreshInFlight: null,
  loginWaiters: [],
  refreshTimer: null,
};

function getStoredAccessToken() {
  try { return localStorage.getItem(AUTH_KEYS.access) || null; } catch { return null; }
}
function getStoredRefreshToken() {
  try { return localStorage.getItem(AUTH_KEYS.refresh) || null; } catch { return null; }
}
function getStoredAccessExp() {
  try { return parseInt(localStorage.getItem(AUTH_KEYS.exp) || "0", 10) || 0; } catch { return 0; }
}
function saveAuthTokens(data) {
  try {
    if (data.access_token) localStorage.setItem(AUTH_KEYS.access, data.access_token);
    if (data.refresh_token) localStorage.setItem(AUTH_KEYS.refresh, data.refresh_token);
    if (data.expires_at) localStorage.setItem(AUTH_KEYS.exp, String(data.expires_at));
  } catch { /* ignore storage errors */ }
  if (data.user) authState.user = data.user;
  updateAuthUI();
}
function clearAuthTokens() {
  try {
    localStorage.removeItem(AUTH_KEYS.access);
    localStorage.removeItem(AUTH_KEYS.refresh);
    localStorage.removeItem(AUTH_KEYS.exp);
  } catch { /* ignore */ }
  authState.user = null;
  updateAuthUI();
}

function updateAuthUI() {
  const menu = document.getElementById("auth-user-menu");
  const uname = document.getElementById("auth-username");
  const badge = document.getElementById("auth-user-badge");
  if (!menu) return;
  if (authState.required && authState.user) {
    menu.classList.remove("hidden");
    if (uname) uname.textContent = authState.user.username;
    if (badge) {
      const expDate = authState.user.exp ? new Date(authState.user.exp * 1000).toLocaleTimeString() : "";
      const groups = Array.isArray(authState.user.groups) ? authState.user.groups.join(", ") : "";
      badge.title = `User: ${authState.user.username}${groups ? ` | Groups: ${groups}` : ""}${expDate ? ` | Access token expires: ${expDate}` : ""}`;
    }
  } else {
    menu.classList.add("hidden");
  }
}

function showLoginOverlay(errorMsg = "") {
  const overlay = document.getElementById("login-overlay");
  const grpBanner = document.getElementById("login-group-banner");
  const errEl = document.getElementById("login-error");
  if (!overlay) return;
  if (authState.requiredGroup && grpBanner) {
    grpBanner.innerHTML = `Access restricted to local Unix group <code>${escapeHtml(authState.requiredGroup)}</code>`;
    grpBanner.classList.remove("hidden");
  } else if (grpBanner) {
    grpBanner.classList.add("hidden");
  }
  if (errEl) {
    if (errorMsg) {
      errEl.textContent = errorMsg;
      errEl.classList.remove("hidden");
    } else {
      errEl.classList.add("hidden");
    }
  }
  overlay.classList.remove("hidden");
  setTimeout(() => {
    const u = document.getElementById("login-username");
    if (u && !u.value) u.focus();
    else document.getElementById("login-password")?.focus();
  }, 30);
}

function hideLoginOverlay() {
  document.getElementById("login-overlay")?.classList.add("hidden");
  const pw = document.getElementById("login-password");
  if (pw) pw.value = "";
  const waiters = authState.loginWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function waitForLogin() {
  showLoginOverlay();
  return new Promise((resolve) => authState.loginWaiters.push(resolve));
}

async function refreshAuthTokens() {
  if (authState.refreshInFlight) return authState.refreshInFlight;
  authState.refreshInFlight = (async () => {
    try {
      const rt = getStoredRefreshToken();
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rt ? { refresh_token: rt } : {}),
      });
      if (!res.ok) {
        clearAuthTokens();
        return false;
      }
      const data = await res.json();
      saveAuthTokens(data);
      return true;
    } catch {
      return false;
    } finally {
      authState.refreshInFlight = null;
    }
  })();
  return authState.refreshInFlight;
}

async function getFreshAccessToken() {
  const tok = getStoredAccessToken();
  if (!authState.required) return tok;
  const exp = getStoredAccessExp();
  const now = Math.floor(Date.now() / 1000);
  if (!tok || (exp > 0 && exp - now <= 60)) {
    const ok = await refreshAuthTokens();
    if (ok) return getStoredAccessToken();
  }
  return getStoredAccessToken();
}

window.MlnbAuth = {
  getAccessToken: getFreshAccessToken,
  refresh: refreshAuthTokens,
  isRequired: () => authState.required,
};

async function authFetch(url, opts = {}, retryOn401 = true) {
  const headers = { ...(opts.headers || {}) };
  if (authState.required) {
    const tok = await getFreshAccessToken();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  }
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && authState.required && retryOn401) {
    const refreshed = await refreshAuthTokens();
    if (refreshed) {
      return authFetch(url, opts, false);
    }
    showLoginOverlay("Your session has expired. Please sign in again.");
  }
  return res;
}

// --- API Helpers ---
async function api(url, opts = {}) {
  const res = await authFetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function startAuthRefreshLoop() {
  if (authState.refreshTimer) clearInterval(authState.refreshTimer);
  if (!authState.required) return;
  authState.refreshTimer = setInterval(async () => {
    if (!authState.user) return;
    const exp = getStoredAccessExp();
    const now = Math.floor(Date.now() / 1000);
    if (exp > 0 && exp - now <= 90) {
      await refreshAuthTokens();
    }
  }, 30_000);
}

export function initAuthControls() {
  // Auth UI event handlers
  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const uInput = document.getElementById("login-username");
    const pInput = document.getElementById("login-password");
    const errEl = document.getElementById("login-error");
    const submitBtn = document.getElementById("login-submit");
    const username = (uInput?.value || "").trim();
    const password = pInput?.value || "";
    if (!username || !password) return;
    if (errEl) errEl.classList.add("hidden");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in...";
    }
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || `Login failed (HTTP ${res.status})`;
          errEl.classList.remove("hidden");
        }
        if (pInput) { pInput.value = ""; pInput.focus(); }
        return;
      }
      saveAuthTokens(data);
      const nextUrl = new URLSearchParams(window.location.search).get("next");
      if (nextUrl && nextUrl.startsWith("/")) {
        window.location.assign(nextUrl);
        return;
      }
      hideLoginOverlay();
      toast(`Signed in as ${data.user?.username || username}`, "success");
    } catch (err) {
      if (errEl) {
        errEl.textContent = `Network error: ${err.message}`;
        errEl.classList.remove("hidden");
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign In";
      }
    }
  });

  document.getElementById("btn-auth-refresh")?.addEventListener("click", async () => {
    const ok = await refreshAuthTokens();
    if (ok) {
      toast("Access & refresh tokens rotated", "success");
    } else {
      toast("Session expired; please sign in again", "error");
      showLoginOverlay("Session expired. Please sign in again.");
    }
  });

  document.getElementById("btn-auth-logout")?.addEventListener("click", async () => {
    const rt = getStoredRefreshToken();
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rt ? { refresh_token: rt } : {}),
      });
    } catch { /* ignore */ }
    clearAuthTokens();
    toast("Signed out", "info");
    if (authState.required) {
      showLoginOverlay();
    }
  });
}

export {
  AUTH_KEYS,
  authState,
  getStoredAccessToken,
  getStoredRefreshToken,
  getStoredAccessExp,
  saveAuthTokens,
  clearAuthTokens,
  updateAuthUI,
  showLoginOverlay,
  hideLoginOverlay,
  waitForLogin,
  refreshAuthTokens,
  getFreshAccessToken,
  authFetch,
  api,
  startAuthRefreshLoop,
};
