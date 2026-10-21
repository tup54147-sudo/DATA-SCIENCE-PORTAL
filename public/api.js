export async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : { error: await response.text() };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function showMessage(element, message, type = 'error') {
  element.className = `auth-message ${type}`;
  element.innerHTML = message;
  element.style.display = 'flex';
}

export function setupPasswordToggle(inputId, buttonId) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);
  if (!input || !button) return;
  button.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    button.innerHTML = input.type === 'password' ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
  });
}
