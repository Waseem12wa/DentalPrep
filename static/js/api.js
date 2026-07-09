(function () {
  // Auto-detect API base URL
  function getApiBase() {
    const isLocalhost = window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.startsWith('192.168.') ||
      window.location.hostname.startsWith('10.') ||
      window.location.hostname.startsWith('172.') ||
      window.location.hostname.endsWith('.local');

    const DEFAULT_API_BASE = (isLocalhost && window.location.port && window.location.port !== '4000')
      ? `${window.location.protocol}//${window.location.hostname}:4000/api`
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

  // ===== Client-side GET cache =====
  // Short-lived cache for GET requests. Eliminates duplicate API calls when
  // navigating between pages or re-rendering components.
  var GET_CACHE_TTL_MS = 15000; // 15 seconds
  var getCache = new Map();

  function getCached(key) {
    var entry = getCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > GET_CACHE_TTL_MS) {
      getCache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  function setCached(key, data) {
    getCache.set(key, { data: data, ts: Date.now() });
    if (getCache.size > 80) {
      var oldest = getCache.keys().next().value;
      getCache.delete(oldest);
    }
  }

  // ===== In-flight request deduplication =====
  // If two callers request the same GET URL simultaneously, only one fetch
  // is made; both receive the same promise.
  var inflightGets = new Map();

  async function apiFetch(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var url = getApiBase() + path;

    var headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );

    var token = getToken();
    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    // Cache + deduplicate GET requests
    if (method === 'GET') {
      // Check cache first
      var cached = getCached(url);
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }

      // Deduplicate identical in-flight GETs
      if (inflightGets.has(url)) {
        return inflightGets.get(url);
      }

      var promise = _doFetch(url, options, headers, true, url);
      inflightGets.set(url, promise);
      return promise;
    }

    return _doFetch(url, options, headers, false, url);
  }

  async function _doFetch(url, options, headers, isGet, cacheKey) {
    try {
      var response = await fetch(url, Object.assign({}, options, { headers: headers }));

      var data = null;
      try {
        data = await response.json();
      } catch (err) {
        data = null;
      }

      if (!response.ok) {
        var message = (data && data.message) || "Request failed";
        var error = new Error(message);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      // Cache successful GET responses
      if (isGet && data) {
        setCached(cacheKey, data);
      }

      return data;
    } finally {
      if (isGet) {
        inflightGets.delete(cacheKey);
      }
    }
  }

  async function getProfile() {
    return apiFetch("/user/profile", { method: "GET" });
  }

  function requireAuth(redirectUrl) {
    redirectUrl = redirectUrl || '/login/';
    if (!getToken()) {
      window.location.href = redirectUrl;
      return false;
    }
    return true;
  }

  // Clear all cached GET data (call after mutations like POST/PUT/DELETE)
  function invalidateCache() {
    getCache.clear();
  }

  window.DentalPrepApi = {
    getApiBase: getApiBase,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    fetch: apiFetch,
    apiFetch: apiFetch,
    getProfile: getProfile,
    requireAuth: requireAuth,
    invalidateCache: invalidateCache
  };
})();
