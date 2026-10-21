export async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : { error: await response.text() };
  if (response.status === 401) {
    location.href = url.includes('/admin') ? '/admin-login.html' : '/learning-area-access.html';
    throw new Error('Your session has expired.');
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
}

export function formatDate(value, withTime = true) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-NG', withTime ? { dateStyle:'medium', timeStyle:'short' } : { dateStyle:'medium' });
}

export function showNotice(id, message, type = 'success') {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  el.className = `notice show ${type}`;
  el.innerHTML = message;
  el.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

export function hideNotice(id) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (el) el.className = 'notice';
}

export function classStatus(item) {
  if (item.status === 'cancelled' || item.status === 'ended' || item.status === 'live') return item.status;
  const now = Date.now();
  const start = Date.parse(item.start_time);
  const end = item.end_time ? Date.parse(item.end_time) : start + 2 * 60 * 60 * 1000;
  if (now >= start && now <= end) return 'live';
  if (now > end) return 'ended';
  return 'scheduled';
}

export async function getSession() {
  return api('/api/auth/session');
}

export async function logout() {
  const session = await getSession();
  const endpoint = session.role === 'student' ? '/api/auth/student/logout' : '/api/auth/admin/logout';
  const data = await api(endpoint, { method:'POST', body:'{}' });
  location.href = data.redirect;
}

export function wireLogout() {
  document.querySelectorAll('[data-logout]').forEach((button) => button.addEventListener('click', logout));
}
