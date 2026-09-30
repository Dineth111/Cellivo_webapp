const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

/**
 * Health check: verify backend status & MongoDB connectivity
 */
export async function checkHealth() {
  const res = await fetch(`${API_BASE}/health`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.database?.status || `Health check failed (${res.status})`);
  }
  return res.json();
}

const ACCESS_KEY = 'cellivo_jwt';
const REFRESH_KEY = 'cellivo_refresh';

// "Remember this device" keeps the session in localStorage, otherwise in sessionStorage.
const stores = () => [localStorage, sessionStorage];
const findStore = () => stores().find((s) => s.getItem(REFRESH_KEY)) || null;

export function saveSession({ token, refreshToken }, remember = true) {
  clearSession();
  const store = remember ? localStorage : sessionStorage;
  store.setItem(ACCESS_KEY, token);
  store.setItem(REFRESH_KEY, refreshToken);
}

export function clearSession() {
  for (const s of stores()) {
    s.removeItem(ACCESS_KEY);
    s.removeItem(REFRESH_KEY);
  }
}

export const hasSession = () => !!findStore();

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Request failed.');
  return data;
}

// Trade the refresh token for a new access token. Several calls at once share one request,
// because the refresh token rotates and can only be used once.
let refreshing = null;
function refreshAccessToken() {
  const store = findStore();
  if (!store) return Promise.reject(new Error('Not logged in'));
  refreshing ??= post('/auth/refresh', { refreshToken: store.getItem(REFRESH_KEY) })
    .then((data) => {
      store.setItem(ACCESS_KEY, data.token);
      store.setItem(REFRESH_KEY, data.refreshToken);
      return data.token;
    })
    .catch((err) => {
      clearSession();
      throw err;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** fetch with the Bearer token; on 401 it refreshes the session once and retries. */
export async function authFetch(path, options = {}) {
  const send = (token) =>
    fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` },
    });
  let res = await send((findStore() || localStorage).getItem(ACCESS_KEY));
  if (res.status === 401) res = await send(await refreshAccessToken());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Request failed.');
  return data;
}

/** Log in with email & password. Returns { token, refreshToken, user }; the caller stores it with saveSession. */
export const loginUser = ({ email, password }) => post('/auth/login', { email, password });

/** Register a new shop (owner account). */
export const registerUser = ({ name, shopName, email, password, phone }) =>
  post('/auth/register', { name, shopName, email, password, phone });

export async function logoutUser() {
  try {
    await authFetch('/auth/logout', { method: 'POST' });
  } finally {
    clearSession();
  }
}

/** Current user with role and permissions. */
export const getAuthProfile = () => authFetch('/auth/me');

export const updateAuthProfile = (profileData) =>
  authFetch('/auth/profile', { method: 'PUT', body: JSON.stringify(profileData) });
