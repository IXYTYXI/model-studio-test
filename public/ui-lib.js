export function createApi({ getToken = () => '', onUnauthorized = () => {}, fetcher = fetch } = {}) {
  return async function api(path, { method = 'GET', body, signal } = {}) {
    const publicLogin = path === '/api/login' || path === '/api/auth/google/start';
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && !publicLogin) headers['X-CSRF-Token'] = getToken();
    let response;
    try {
      response = await fetcher(path, { method, headers, ...(signal ? {signal} : {}), credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      throw new Error('网络连接中断。请检查连接后重试。');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('服务暂时无法响应，请稍后重试。'); }
    if (!response.ok) {
      if (response.status === 401 && !publicLogin) onUnauthorized();
      const error = new Error(data.error?.message || '请求失败，请稍后重试。');
      error.code = data.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  };
}

export function googleAuthorizationUrl(value) {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (url.origin !== 'https://accounts.google.com' || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new Error('Google 登录暂时不可用，请稍后重试。'); }
}

export function googleLoginError(code) {
  if (code === null || code === undefined) return '';
  switch (code) {
    case 'cancelled': return '已取消 Google 登录，你可以重新尝试。';
    case 'disabled': return '此账号暂时无法登录，请联系管理员。';
    case 'capacity': return '工作空间已达到成员上限，请联系管理员。';
    case 'unavailable': return 'Google 登录暂时不可用，请稍后重试或使用密码登录。';
    default: return 'Google 登录未完成，请重试。';
  }
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
