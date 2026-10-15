export function createApi({ getToken = () => '', onUnauthorized = () => {}, fetcher = fetch } = {}) {
  return async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && path !== '/api/login') headers['X-CSRF-Token'] = getToken();
    let response;
    try {
      response = await fetcher(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('网络连接中断。请检查连接后重试。');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('服务暂时无法响应，请稍后重试。'); }
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/login') onUnauthorized();
      const error = new Error(data.error?.message || '请求失败，请稍后重试。');
      error.code = data.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  };
}

export function splitContent(value) {
  const content = String(value ?? '');
  const parts = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let start = 0;
  for (const match of content.matchAll(fence)) {
    if (match.index > start) parts.push({ type: 'text', content: content.slice(start, match.index) });
    parts.push({ type: 'code', language: match[1].trim(), content: match[2] });
    start = match.index + match[0].length;
  }
  if (start < content.length || !parts.length) parts.push({ type: 'text', content: content.slice(start) });
  return parts;
}
