const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
const KEY = 'cellivo_admin_jwt';

// Admin tokens live in sessionStorage only: closing the tab ends the session (12h cap on the server).
export const adminToken = () => sessionStorage.getItem(KEY);
export const saveAdminToken = (t) => sessionStorage.setItem(KEY, t);
export const clearAdminToken = () => sessionStorage.removeItem(KEY);

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API_BASE}/admin${path}`, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) clearAdminToken();
  if (!res.ok) throw Object.assign(new Error(data.message || 'Request failed.'), { status: res.status, code: data.code });
  return data;
}

export const adminLogin = (email, password) => call('/auth/login', { method: 'POST', body: { email, password } }).then((r) => r.data);
export const adminEnroll = (challenge) => call('/auth/enroll', { method: 'POST', body: { challenge } }).then((r) => r.data);
export const adminVerify = (challenge, code) => call('/auth/verify', { method: 'POST', body: { challenge, code } }).then((r) => r.data);

/** Authenticated admin call; returns the whole body ({ data, page, total }). */
export const admin = (path, opts) => call(path, { ...opts, token: adminToken() });
export const adminLogout = () => admin('/auth/logout', { method: 'POST' }).catch(() => {}).finally(clearAdminToken);
