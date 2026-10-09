// Tiny fetch wrapper: JSON in/out, CSRF header on every change, friendly errors.
let csrf = '';
export const setCsrf = (t) => { if (t) csrf = t; };

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export async function api(method, url, body) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let res;
  try { res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError('No connection. Check your internet and try again.', 0); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (data?.csrfToken) setCsrf(data.csrfToken);
  if (!res.ok) throw new ApiError(data?.error || 'Something went wrong. Please try again.', res.status, data);
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const patch = (u, b) => api('PATCH', u, b ?? {});
export const del = (u, b) => api('DELETE', u, b ?? {});
