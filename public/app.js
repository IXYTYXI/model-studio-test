import { createApi, splitContent } from './ui-lib.js';

const $ = (id) => document.getElementById(id);
const themes = {
  openai: { route: '/codex', name: 'Codex', theme: 'codex', badge: 'CODE', symbol: '>_', eyebrow: 'A LITTLE CONTEXT. A BETTER ANSWER.', title: '把想法，写成下一步。', description: '梳理问题，拆解逻辑，打磨代码。让复杂的事情清晰一点。', placeholder: '描述你的问题，或粘贴一段代码…', caption: '从问题到思路，再到清晰的下一步。', prompts: [
    ['⌘', '理解一段代码', '理清结构与关键逻辑', '请帮我理解下面这段代码，先概述整体思路，再解释关键逻辑：\n'],
    ['↗', '拆解一个想法', '把目标转化为可执行的步骤', '请帮我把这个想法拆解为可执行的步骤，并指出需要提前确认的问题：\n'],
    ['◇', '一起排查问题', '从现象出发，定位可能原因', '我遇到了一个问题。请根据现象帮我分析可能原因，并给出验证步骤：\n'],
    ['≡', '写一份技术说明', '让复杂的内容更容易理解', '请帮我写一份清晰的技术说明。目标读者、背景和要点如下：\n']
  ] },
  anthropic: { route: '/claude', name: 'Claude', theme: 'claude', badge: 'THINK', symbol: '✳', eyebrow: 'SPACE FOR A THOUGHTFUL CONVERSATION', title: '今天，一起想清楚。', description: '一个想法、一段文字，或一个还没有答案的问题。', placeholder: '和 Claude 聊聊你的想法…', caption: '留一点空间，让好想法慢慢发生。', prompts: [
    ['✎', '打磨一段文字', '让表达更准确', '请帮我打磨下面这段文字，保留原意，让表达更清晰、自然：\n'],
    ['◈', '一起深入思考', '从不同角度看问题', '我想认真思考下面这个问题。请给出不同角度、相关假设和可能的反例：\n'],
    ['☷', '梳理复杂信息', '找到真正重要的部分', '请帮我梳理以下信息，提炼主要观点、证据和未解决的问题：\n'],
    ['☀', '为今天定个计划', '找到适合自己的节奏', '请根据以下目标和可用时间，帮我制定一个合理、可执行的今日计划：\n']
  ] },
  gemini: { route: '/gemini', name: 'Gemini', theme: 'gemini', badge: 'CREATE', symbol: '✧', eyebrow: 'YOUR NEXT IDEA STARTS HERE', title: '你好，让灵感发生。', description: '今天，想一起探索些什么？', placeholder: '向 Gemini 提问，探索更多可能…', caption: '给好奇心一个新的方向。', prompts: [
    ['✧', '给一个想法，探索更多可能', '打开思路', '请围绕这个想法进行头脑风暴，给出 8 个不同方向，每个方向说明适用场景：\n'],
    ['⌁', '把难懂的概念，讲得简单一点', '轻松理解', '请用直观的类比和循序渐进的例子，向初学者解释这个概念：\n'],
    ['↗', '为下一个目标，规划清晰路径', '从现在出发', '请帮我为下面的目标设计一条可行路径，包含关键里程碑、资源和风险：\n'],
    ['✎', '找一个新角度，让内容更有趣', '发现新鲜表达', '请为下面的主题提供 6 个新颖的内容角度，分别列出标题、切入点和结构：\n']
  ] }
};
const routeProvider = () => Object.keys(themes).find(id => themes[id].route === location.pathname) || 'openai';
const state = { session: null, provider: routeProvider(), activeId: null, conversations: [], messages: [], busy: false, loading: false, generation: 0, selections: {}, settingsTab: 'providers' };
let toastTimer;
const api = createApi({ getToken: () => state.session?.csrfToken || '', onUnauthorized: () => showLogin('登录已过期，请重新登录。') });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, className, action) {
  const node = el('button', className, label);
  node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
}
function showError(node, message = '') { node.textContent = message; node.hidden = !message; }
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function showLogin(message = '', success = false) {
  state.generation++;
  state.session = null;
  state.messages = [];
  state.selections = {};
  state.activeId = null;
  state.busy = false;
  state.loading = false;
  $('boot').hidden = true;
  $('workspace').hidden = true;
  $('login-view').hidden = false;
  $('settings-dialog').close();
  $('account-dialog').close();
  $('prompt').value = '';
  $('password').value = '';
  $('login-error').classList.toggle('login-success', success);
  showError($('login-error'), message);
  document.body.className = '';
  document.title = '登录 · Model Studio';
}
async function enterWorkspace(session) {
  state.session = session;
  $('boot').hidden = true;
  $('login-view').hidden = true;
  $('workspace').hidden = false;
  $('account-name').textContent = session.user.username;
  $('account-avatar').textContent = session.user.username.slice(0, 1).toUpperCase();
  $('account-role').textContent = session.user.role === 'admin' ? '工作空间管理员' : '工作空间成员';
  $('settings-button').hidden = session.user.role !== 'admin';
  $('top-settings').hidden = session.user.role !== 'admin';
  await selectProvider(routeProvider(), false);
}
function selectedProvider() { return state.session?.providers.find(provider => provider.id === state.provider); }
function updateQuota() {
  const usage = state.session?.usage || { used: 0, limit: 0 };
  $('quota-value').textContent = `${usage.used} / ${usage.limit}`;
  $('quota-progress').max = Math.max(1, usage.limit);
  $('quota-progress').value = usage.used;
}
function updateHeader() {
  const theme = themes[state.provider];
  const provider = selectedProvider();
  document.body.className = `theme-${theme.theme}`;
  document.title = `${theme.name} · Model Studio`;
  $('workspace-label').textContent = theme.name;
  $('workspace-badge').textContent = theme.badge;
  $('model-label').textContent = provider?.model || '未配置模型';
  $('composer-model').textContent = provider?.model || `${theme.name} · 等待配置`;
  $('composer-symbol').textContent = theme.symbol;
  $('composer-caption').textContent = theme.caption;
  $('prompt').placeholder = theme.placeholder;
  $('connection-dot').classList.toggle('connected', Boolean(provider?.configured && provider.enabled));
  $('provider-notice').replaceChildren();
  $('provider-notice').hidden = Boolean(provider?.configured && provider.enabled);
  if (!$('provider-notice').hidden) {
    const note = !provider?.enabled ? '此模型连接尚未启用。' : '此模型尚未完成连接配置。';
    $('provider-notice').append(document.createTextNode(note));
    if (state.session.user.role === 'admin') $('provider-notice').append(button('前往设置', '', () => openSettings('providers')));
    else $('provider-notice').append(document.createTextNode('请联系管理员。'));
  }
  updateQuota();
  renderNav();
  updateControls();
}
function renderNav() {
  $('provider-nav').replaceChildren(...Object.entries(themes).map(([id, theme]) => {
    const link = el('a', `provider-link${id === state.provider ? ' active' : ''}`);
    link.href = theme.route;
    if (id === state.provider) link.setAttribute('aria-current', 'page');
    link.append(el('span', 'provider-icon', theme.symbol), el('span', '', theme.name), el('small', '', theme.badge));
    link.addEventListener('click', event => { event.preventDefault(); if (!state.busy) selectProvider(id).catch(reportChatError); });
    link.setAttribute('aria-disabled', String(state.busy));
    return link;
  }));
}
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-backdrop').hidden = true; }
async function selectProvider(provider, push = true) {
  if (state.busy) return;
  state.provider = provider;
  state.activeId = state.selections[provider] || null;
  state.messages = [];
  state.conversations = [];
  state.loading = true;
  const generation = ++state.generation;
  if (push && location.pathname !== themes[provider].route) history.pushState({}, '', themes[provider].route);
  else if (!Object.values(themes).some(theme => theme.route === location.pathname)) history.replaceState({}, '', themes[provider].route);
  closeSidebar();
  $('prompt').value = '';
  showError($('chat-error'));
  updateHeader();
  renderMessages();
  $('history').replaceChildren(el('p', 'history-empty', '正在加载对话…'));
  try {
    const data = await api(`/api/conversations?provider=${encodeURIComponent(provider)}`);
    if (generation !== state.generation || !state.session) return;
    state.conversations = data.conversations;
    state.loading = false;
    renderHistory();
    if (state.activeId && data.conversations.some(item => item.id === state.activeId)) await openConversation(state.activeId);
    else { state.activeId = null; state.selections[provider] = null; renderMessages(); }
  } catch (error) {
    if (generation === state.generation && state.session) {
      state.loading = false;
      $('history').replaceChildren(el('p', 'history-empty', '暂时无法加载历史记录。'), button('重新加载', 'secondary-button', () => selectProvider(provider, false).catch(reportChatError)));
      reportChatError(error);
    }
  } finally { if (generation === state.generation && state.session) updateControls(); }
}
function renderHistory() {
  $('history-count').textContent = state.conversations.length;
  if (!state.conversations.length) {
    $('history').replaceChildren(el('p', 'history-empty', '这里还很安静。\n开始一段对话，思路会被好好保存。'));
    return;
  }
  $('history').replaceChildren(...state.conversations.map(conversation => {
    const row = el('div', `history-item${conversation.id === state.activeId ? ' active' : ''}`);
    const title = button(conversation.title || '新对话', 'history-title', () => openConversation(conversation.id).catch(reportChatError));
    title.title = conversation.title || '新对话';
    title.disabled = state.busy;
    if (conversation.id === state.activeId) title.setAttribute('aria-current', 'true');
    const remove = button('×', 'history-delete', () => deleteConversation(conversation).catch(reportChatError));
    remove.setAttribute('aria-label', `删除对话：${conversation.title || '新对话'}`);
    remove.disabled = state.busy;
    row.append(title, remove);
    return row;
  }));
}
async function openConversation(id) {
  if (state.busy) return;
  const generation = ++state.generation;
  state.loading = true;
  updateControls();
  showError($('chat-error'));
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (generation !== state.generation || !state.session) return;
    state.activeId = id;
    state.selections[state.provider] = id;
    state.messages = data.messages;
    $('prompt').value = '';
    renderHistory();
    renderMessages();
    closeSidebar();
    scrollToBottom();
  } finally { if (generation === state.generation && state.session) { state.loading = false; updateControls(); } }
}
async function deleteConversation(conversation) {
  if (state.busy || !confirm(`删除「${conversation.title || '新对话'}」？此操作无法撤销。`)) return;
  const provider = state.provider;
  await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
  if (state.selections[provider] === conversation.id) state.selections[provider] = null;
  if (provider !== state.provider) return;
  state.conversations = state.conversations.filter(item => item.id !== conversation.id);
  if (state.activeId === conversation.id) { state.activeId = null; state.messages = []; renderMessages(); }
  renderHistory();
  toast('对话已删除');
}
function newConversation() {
  if (state.busy) return;
  ++state.generation;
  state.loading = false;
  state.activeId = null;
  state.selections[state.provider] = null;
  state.messages = [];
  $('prompt').value = '';
  showError($('chat-error'));
  renderHistory();
  renderMessages();
  updateControls();
  closeSidebar();
  $('prompt').focus();
}
function renderWelcome() {
  const theme = themes[state.provider];
  const heading = state.provider === 'gemini' ? `你好，${state.session?.user.username || '朋友'}。` : theme.title;
  $('welcome').replaceChildren(el('div', 'welcome-heading-icon', theme.symbol), el('div', 'welcome-eyebrow', theme.eyebrow), el('h1', '', heading), el('p', 'welcome-description', theme.description));
  const cards = el('div', 'quick-prompts');
  for (const [symbol, title, description, prompt] of theme.prompts) {
    const card = button('', 'prompt-card', () => { $('prompt').value = prompt; updateControls(); $('prompt').focus(); });
    card.append(el('span', 'prompt-icon', symbol), el('h3', '', title), el('p', '', description), el('span', 'prompt-arrow', '↗'));
    cards.append(card);
  }
  $('welcome').append(cards, el('p', 'welcome-note', '每个工作空间独立保存对话 · 当前支持文本交流'));
}
async function copyText(text, control) {
  try {
    await navigator.clipboard.writeText(text);
    const previous = control.textContent;
    control.textContent = '已复制';
    setTimeout(() => { control.textContent = previous; }, 1800);
  } catch { toast('无法自动复制，请选择文字后手动复制。'); }
}
function renderMessage(message) {
  const theme = themes[state.provider];
  const article = el('article', `message message-${message.role}`);
  const head = el('div', 'message-header');
  head.append(el('span', 'message-avatar', message.role === 'user' ? state.session.user.username.slice(0, 1).toUpperCase() : theme.symbol), el('strong', '', message.role === 'user' ? '你' : theme.name));
  if (message.createdAt) {
    const date = new Date(message.createdAt);
    if (!Number.isNaN(date.getTime())) head.append(el('time', '', new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)));
  }
  const body = el('div', 'message-body');
  for (const part of splitContent(message.content)) {
    if (part.type === 'text') body.append(el('div', 'text-part', part.content));
    else {
      const block = el('div', 'code-block');
      const toolbar = el('div', 'code-toolbar');
      const copy = button('复制代码', 'copy-button', () => copyText(part.content, copy));
      toolbar.append(el('span', '', part.language || 'code'), copy);
      const pre = el('pre');
      pre.append(el('code', '', part.content));
      block.append(toolbar, pre);
      body.append(block);
    }
  }
  article.append(head, body);
  if (message.role === 'assistant') {
    const actions = el('div', 'message-actions');
    const copy = button('⧉  复制回答', 'copy-button', () => copyText(message.content, copy));
    actions.append(copy);
    article.append(actions);
  }
  return article;
}
function renderMessages() {
  $('welcome').hidden = state.messages.length > 0;
  if (!$('welcome').hidden) renderWelcome();
  $('messages').hidden = !state.messages.length;
  $('messages').replaceChildren(...state.messages.map(renderMessage));
  $('context-count').textContent = state.messages.length;
  $('context-name').textContent = state.conversations.find(item => item.id === state.activeId)?.title || (state.messages.length ? '正在交流' : '准备开始');
}
function scrollToBottom() { requestAnimationFrame(() => { $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight; }); }
function updateControls() {
  const provider = selectedProvider();
  const unavailable = !provider?.enabled || !provider?.configured;
  $('send-button').disabled = state.busy || state.loading || unavailable || !$('prompt').value.trim();
  $('prompt').disabled = state.busy || state.loading;
  $('new-chat').disabled = state.busy || state.loading;
  $('waiting').hidden = !state.busy;
  $('send-button').textContent = state.busy ? '·' : '↑';
  for (const node of document.querySelectorAll('.history-title,.history-delete,.prompt-card')) node.disabled = state.busy;
  for (const node of document.querySelectorAll('.provider-link')) node.setAttribute('aria-disabled', String(state.busy));
}
function reportChatError(error) { if (state.session) showError($('chat-error'), error.message); }
async function sendChat(event) {
  event.preventDefault();
  const message = $('prompt').value.trim();
  const provider = selectedProvider();
  if (state.busy || state.loading || !message || !provider?.enabled || !provider?.configured) return;
  const generation = state.generation;
  state.busy = true;
  showError($('chat-error'));
  updateControls();
  try {
    if (!state.activeId) {
      const result = await api('/api/conversations', { method: 'POST', body: { provider: state.provider } });
      if (generation !== state.generation || !state.session) return;
      state.activeId = result.conversation.id;
      state.selections[state.provider] = state.activeId;
      state.conversations.unshift(result.conversation);
    }
    state.messages.push({ role: 'user', content: message, createdAt: new Date().toISOString() });
    $('prompt').value = '';
    renderMessages();
    renderHistory();
    scrollToBottom();
    const result = await api('/api/chat', { method: 'POST', body: { conversationId: state.activeId, message } });
    if (generation !== state.generation || !state.session) return;
    state.messages = result.messages;
    state.session.usage = result.usage;
    state.conversations = [result.conversation, ...state.conversations.filter(item => item.id !== result.conversation.id)];
    renderMessages();
    renderHistory();
    updateQuota();
    scrollToBottom();
  } catch (error) {
    if (generation !== state.generation || !state.session) return;
    $('prompt').value = message;
    reportChatError(error);
    if (state.activeId) {
      try {
        const result = await api(`/api/conversations/${encodeURIComponent(state.activeId)}`);
        if (generation !== state.generation || !state.session) return;
        state.messages = result.messages;
        renderMessages();
      } catch { /* Keep the visible error when reconciliation is unavailable. */ }
    }
    if (generation === state.generation && state.session) {
      try { const session = await api('/api/session'); if (generation === state.generation && state.session) { state.session = session; updateQuota(); } } catch { /* The original request error stays visible. */ }
    }
  } finally {
    if (generation === state.generation) state.busy = false;
    if (generation === state.generation && state.session) { updateControls(); renderHistory(); $('prompt').focus(); }
  }
}

function field(labelText, name, { value = '', type = 'text', placeholder = '', required = false, min, max, options, hint, wide = false, autocomplete = 'off' } = {}) {
  const wrap = el('div', `field${wide ? ' wide' : ''}`);
  const label = el('label', '', labelText);
  const input = el(options ? 'select' : 'input');
  input.name = name;
  input.id = `field-${crypto.randomUUID()}`;
  label.htmlFor = input.id;
  if (options) for (const [optionValue, optionLabel] of options) { const option = el('option', '', optionLabel); option.value = optionValue; input.append(option); }
  else { input.type = type; input.placeholder = placeholder; input.autocomplete = autocomplete; }
  input.value = value;
  input.required = required;
  if (min !== undefined) { if (type === 'password') input.minLength = min; else input.min = min; }
  if (max !== undefined) { if (type === 'password') input.maxLength = max; else input.max = max; }
  wrap.append(label, input);
  if (hint) wrap.append(el('p', 'field-hint', hint));
  return wrap;
}
function toggle(labelText, name, checked, disabled = false) {
  const label = el('label', 'switch-label');
  const input = el('input');
  input.type = 'checkbox'; input.name = name; input.checked = checked; input.disabled = disabled;
  label.append(input, document.createTextNode(labelText));
  return label;
}
function formStatus(form, message, isError = false) {
  const result = form.querySelector('.inline-result');
  result.textContent = message;
  result.classList.toggle('error', isError);
}
async function formRequest(form, action) {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  formStatus(form, '正在保存…');
  try { await action(); formStatus(form, '已保存'); }
  catch (error) { if (state.session) formStatus(form, error.message, true); }
  finally { submit.disabled = false; }
}
function formFooter(label = '保存设置') {
  const footer = el('div', 'form-footer');
  const submit = el('button', 'primary-button', label);
  submit.type = 'submit';
  const status = el('span', 'inline-result');
  status.setAttribute('role', 'status');
  footer.append(submit, status);
  return footer;
}
async function openSettings(tab = state.settingsTab) {
  if (state.session?.user.role !== 'admin') return;
  state.settingsTab = tab;
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  $('tab-providers').classList.toggle('active', tab === 'providers');
  $('tab-users').classList.toggle('active', tab === 'users');
  $('settings-content').replaceChildren(el('p', 'loading-state', '正在加载设置…'));
  try {
    const result = await api(`/api/admin/${tab}`);
    if (!state.session || state.settingsTab !== tab || !$('settings-dialog').open) return;
    if (tab === 'providers') renderProviderSettings(result.providers);
    else renderUsers(result.users);
  } catch (error) {
    if (state.session) $('settings-content').replaceChildren(el('p', 'error-state', error.message), button('重试', 'secondary-button', () => openSettings(tab)));
  }
}
function renderProviderSettings(providers) {
  $('settings-content').replaceChildren(el('p', 'settings-intro', '连接自己的模型服务。API Key 保存后不会回显；留空保留已有密钥。请填写服务商提供的 HTTPS API 基础地址与模型名称。'));
  for (const provider of providers) {
    const form = el('form', 'provider-settings-card');
    const heading = el('div', 'provider-settings-heading');
    const title = el('h3', '', `${themes[provider.id].symbol}  ${themes[provider.id].name}`);
    title.append(el('span', 'key-status', provider.hasKey ? '密钥已保存' : '尚无密钥'));
    heading.append(title, toggle('启用连接', 'enabled', provider.enabled));
    const grid = el('div', 'fields-grid');
    const protocols = provider.id === 'openai' ? [['openai-responses', 'OpenAI Responses'], ['openai-chat', 'OpenAI Chat Completions']] : [[provider.id, provider.id === 'anthropic' ? 'Anthropic Messages' : 'Gemini Generate Content']];
    grid.append(field('API 基础地址', 'baseUrl', { value: provider.baseUrl, type: 'url', placeholder: 'https://api.example.com/v1', wide: true }), field('模型名称', 'model', { value: provider.model, placeholder: '填写服务商提供的模型 ID' }), field('接口协议', 'protocol', { value: provider.protocol, options: protocols }), field('API Key', 'apiKey', { type: 'password', placeholder: provider.hasKey ? '已保存 · 留空保留' : '输入 API Key', autocomplete: 'new-password' }), field('最大输出 Token', 'maxOutputTokens', { value: String(provider.maxOutputTokens), type: 'number', min: 128, max: 4096, required: true }));
    form.append(heading, grid, formFooter());
    form.addEventListener('submit', event => {
      event.preventDefault();
      formRequest(form, async () => {
        const data = new FormData(form);
        const payload = { baseUrl: data.get('baseUrl').trim(), model: data.get('model').trim(), protocol: data.get('protocol'), maxOutputTokens: Number(data.get('maxOutputTokens')), enabled: data.has('enabled') };
        if (data.get('apiKey').trim()) payload.apiKey = data.get('apiKey').trim();
        const result = await api(`/api/admin/providers/${provider.id}`, { method: 'PUT', body: payload });
        form.elements.apiKey.value = '';
        form.elements.apiKey.placeholder = result.provider.hasKey ? '已保存 · 留空保留' : '输入 API Key';
        title.querySelector('.key-status').textContent = result.provider.hasKey ? '密钥已保存' : '尚无密钥';
        state.session = await api('/api/session');
        updateHeader();
      });
    });
    $('settings-content').append(form);
  }
}
function renderUsers(users) {
  const intro = el('p', 'settings-intro', '只有管理员可以创建账号。每日额度按调用尝试次数计算（包括上游失败）；暂停账号后，该成员将无法继续访问。');
  const create = el('form', 'user-create');
  const grid = el('div', 'fields-grid');
  grid.append(field('用户名', 'username', { required: true, placeholder: '如 team-member', autocomplete: 'off', hint: '2–64 位字母、数字或 . _ @ -' }), field('初始密码', 'password', { type: 'password', required: true, min: 14, max: 128, placeholder: '14–128 个字符', autocomplete: 'new-password' }), field('每日请求额度', 'dailyLimit', { type: 'number', min: 1, max: 10000, value: '100', required: true }));
  create.append(el('h3', '', '邀请新成员'), grid, formFooter('创建成员账号'));
  create.addEventListener('submit', event => {
    event.preventDefault();
    formRequest(create, async () => {
      const data = new FormData(create);
      await api('/api/admin/users', { method: 'POST', body: { username: data.get('username').trim(), password: data.get('password'), dailyLimit: Number(data.get('dailyLimit')) } });
      create.reset();
      toast('成员账号已创建');
      await openSettings('users');
    });
  });
  const header = el('div', 'users-heading');
  header.append(el('h3', '', `工作空间成员 · ${users.length}`));
  const list = el('div', 'user-list');
  for (const user of users) {
    const form = el('form', 'user-row');
    const heading = el('div', 'user-row-head');
    const isSelf = user.id === state.session.user.id;
    heading.append(el('strong', '', user.username), el('span', 'role-tag', user.role === 'admin' ? '管理员' : '成员'), toggle(isSelf ? '当前账号' : '启用账号', 'enabled', user.enabled, isSelf));
    const grid = el('div', 'fields-grid');
    grid.append(field('每日请求额度', 'dailyLimit', { type: 'number', value: String(user.dailyLimit), min: 1, max: 10000, required: true }), field('重置密码', 'password', { type: 'password', min: 14, max: 128, placeholder: '留空保持当前密码', autocomplete: 'new-password' }));
    const footer = formFooter('保存成员');
    footer.append(el('span', 'usage-note', `今日已用 ${user.used} 次`));
    form.append(heading, grid, footer);
    form.addEventListener('submit', event => {
      event.preventDefault();
      formRequest(form, async () => {
        const data = new FormData(form);
        const payload = { dailyLimit: Number(data.get('dailyLimit')) };
        if (!isSelf) payload.enabled = data.has('enabled');
        if (data.get('password')) payload.password = data.get('password');
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: payload });
        form.elements.password.value = '';
        if (isSelf && payload.password) { showLogin('密码已更新，请重新登录。', true); return; }
        if (isSelf) { state.session = await api('/api/session'); updateQuota(); }
      });
    });
    list.append(form);
  }
  $('settings-content').replaceChildren(intro, create, header, list);
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('login-form').querySelector('button');
  submit.disabled = true;
  showError($('login-error'));
  try {
    const session = await api('/api/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
    $('password').value = '';
    await enterWorkspace(session);
  } catch (error) { showError($('login-error'), error.message); }
  finally { submit.disabled = false; }
});
$('chat-form').addEventListener('submit', sendChat);
$('prompt').addEventListener('input', updateControls);
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send-button').disabled) $('chat-form').requestSubmit(); } });
$('new-chat').addEventListener('click', newConversation);
$('brand-home').addEventListener('click', event => { event.preventDefault(); if (!state.busy) selectProvider('openai').catch(reportChatError); });
$('mobile-menu').addEventListener('click', () => { $('sidebar').classList.add('open'); $('sidebar-backdrop').hidden = false; });
$('sidebar-backdrop').addEventListener('click', closeSidebar);
$('settings-button').addEventListener('click', () => openSettings());
$('top-settings').addEventListener('click', () => openSettings('providers'));
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('tab-providers').addEventListener('click', () => openSettings('providers'));
$('tab-users').addEventListener('click', () => openSettings('users'));
$('account-button').addEventListener('click', () => { $('password-form').reset(); showError($('password-error')); $('account-dialog').showModal(); });
$('close-account').addEventListener('click', () => $('account-dialog').close());
$('logout-button').addEventListener('click', async () => {
  $('logout-button').disabled = true;
  try { await api('/api/logout', { method: 'POST', body: {} }); showLogin(); }
  catch (error) { if (state.session) showError($('password-error'), error.message); }
  finally { $('logout-button').disabled = false; }
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('password-form').querySelector('[type="submit"]');
  submit.disabled = true;
  showError($('password-error'));
  try { await api('/api/password', { method: 'POST', body: { currentPassword: $('current-password').value, newPassword: $('new-password').value } }); $('password-form').reset(); showLogin('密码已更新，请重新登录。', true); }
  catch (error) { if (state.session) showError($('password-error'), error.message); }
  finally { submit.disabled = false; }
});
window.addEventListener('popstate', () => {
  if (!state.session) return;
  if (state.busy) { history.pushState({}, '', themes[state.provider].route); return; }
  selectProvider(routeProvider(), false).catch(reportChatError);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });

try { await enterWorkspace(await api('/api/session')); }
catch (error) { showLogin(error.status === 401 ? '' : error.message); }
