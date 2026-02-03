(function () {
  // Auto-detect API base URL
  function getApiBase() {
    // Check if we're on localhost
    const isLocalhost = window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';

    // If localhost, use localhost:4000, otherwise use same origin
    const DEFAULT_API_BASE = isLocalhost
      ? "http://localhost:4000/api"
      : window.location.origin + "/api";

    const meta = document.querySelector("meta[name='dentalprep-api']");
    const metaValue = meta ? meta.getAttribute("content") : null;

    return (
      window.DENTALPREP_API_URL ||
      metaValue ||
      localStorage.getItem("dentalprep_api") ||
      DEFAULT_API_BASE
    );
  }

  function getToken() {
    return localStorage.getItem("dentalprep_token");
  }

  function setToken(token) {
    localStorage.setItem("dentalprep_token", token);
  }

  function clearToken() {
    localStorage.removeItem("dentalprep_token");
  }

  async function apiFetch(path, options = {}) {
    const url = `${getApiBase()}${path}`;
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );

    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    if (!response.ok) {
      const message = (data && data.message) || "Request failed";
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async function getProfile() {
    return apiFetch("/user/profile", { method: "GET" });
  }

  function requireAuth(redirectUrl = "/login/") {
    if (!getToken()) {
      window.location.href = redirectUrl;
      return false;
    }
    return true;
  }

  window.DentalPrepApi = {
    getApiBase,
    getToken,
    setToken,
    clearToken,
    apiFetch,
    getProfile,
    requireAuth
  };
})();
