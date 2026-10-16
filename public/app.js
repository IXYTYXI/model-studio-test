import { createApi, splitContent, googleAuthorizationUrl, googleLoginError, modelOutputLimit } from './ui-lib.js';
import { createChatRequests } from './chat-requests.js';
import { modelControl, disposeModelControls } from './model-control.js';
import { selectControl, closeSelect } from './select-control.js';

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
const state = { session: null, provider: routeProvider(), activeId: null, conversations: [], messages: [], drafts: new Map(), failures: new Map(), loading: false, generation: 0, selections: {}, settingsTab: 'personal', googleEnabled: false, loginPending: false };
let toastTimer, settingsRequest = 0;
const api = createApi({ getToken: () => state.session?.csrfToken || '', onUnauthorized: () => showLogin('登录已过期，请重新登录。') });
const chatRequests = createChatRequests({ api, onChange: chatChanged });

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
function confirmAction(title, message, confirmLabel) {
  closeSelect();
  return new Promise(resolve => {
    const dialog = el('dialog', 'confirm-dialog');
    const id = `confirm-${crypto.randomUUID()}`;
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-message`);
    const heading = el('h2', '', title); heading.id = `${id}-title`;
    const description = el('p', '', message); description.id = `${id}-message`;
    const actions = el('div', 'confirm-actions');
    const cancel = button('取消', 'secondary-button', () => dialog.close());
    cancel.autofocus = true;
    actions.append(cancel, button(confirmLabel, 'danger-button confirm-button', () => dialog.close('confirm')));
    dialog.append(heading, description, actions);
    dialog.addEventListener('close', () => { const confirmed = dialog.returnValue === 'confirm'; dialog.remove(); resolve(confirmed); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
function showError(node, message = '') { node.textContent = message; node.hidden = !message; }
function accountName(user) { return user.email || user.username; }
function setLoginBusy(busy, google = false) {
  state.loginPending = busy;
  $('login-form').querySelector('button').disabled = busy;
  $('google-login-button').disabled = busy;
  $('google-login-label').textContent = busy && google ? '正在前往 Google…' : '使用 Google 账号登录';
}
async function loadAuthConfig() {
  try {
    const config = await api('/api/auth/config');
    state.googleEnabled = config.google?.enabled === true;
  } catch { state.googleEnabled = false; }
  $('google-login-section').hidden = !state.googleEnabled;
  $('login-description').textContent = state.googleEnabled ? '使用 Google 账号或已有的用户名和密码登录。' : '使用管理员为你创建的账号登录。';
}
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
  chatRequests.clear();
  state.drafts.clear();
  state.failures.clear();
  state.loading = false;
  $('boot').hidden = true;
  $('workspace').hidden = true;
  $('login-view').hidden = false;
  $('settings-dialog').close();
  $('settings-content').replaceChildren();
  $('account-dialog').close();
  document.querySelectorAll('.confirm-dialog[open]').forEach(dialog => dialog.close());
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
  $('account-name').textContent = accountName(session.user);
  $('account-name').title = accountName(session.user);
  $('account-avatar').textContent = accountName(session.user).slice(0, 1).toUpperCase();
  $('account-role').textContent = session.user.role === 'admin' ? '工作空间管理员' : '工作空间成员';
  $('settings-button').hidden = session.user.role !== 'admin';
  $('top-settings').hidden = false;
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
  $('model-label').textContent = provider?.model ? `${provider.model} · ${provider.credentialSource === 'personal' ? '个人' : '平台'}` : '未配置模型';
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
    $('provider-notice').append(button('设置个人 API Key', '', () => openSettings('personal')));
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
    link.addEventListener('click', event => { event.preventDefault(); selectProvider(id).catch(reportChatError); });
    return link;
  }));
}
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-backdrop').hidden = true; }
async function selectProvider(provider, push = true) {
  saveDraft();
  state.provider = provider;
  state.activeId = state.selections[provider] || null;
  state.messages = [];
  state.conversations = [];
  state.loading = true;
  const generation = ++state.generation;
  const pendingAtLoad = chatRequests.pending;
  if (push && location.pathname !== themes[provider].route) history.pushState({}, '', themes[provider].route);
  else if (!Object.values(themes).some(theme => theme.route === location.pathname)) history.replaceState({}, '', themes[provider].route);
  closeSidebar();
  restoreDraft();
  updateHeader();
  renderMessages();
  $('history').replaceChildren(el('p', 'history-empty', '正在加载对话…'));
  try {
    const data = await api(`/api/conversations?provider=${encodeURIComponent(provider)}`);
    if (generation !== state.generation || !state.session) return false;
    state.conversations = data.conversations;
    const task = chatRequests.pending || pendingAtLoad;
    if (task?.provider === provider && task.conversation) mergeConversation(task.conversation);
    state.loading = false;
    renderHistory();
    if (state.activeId && state.conversations.some(item => item.id === state.activeId)) return await openConversation(state.activeId);
    else { state.activeId = null; state.selections[provider] = null; restoreDraft(); renderMessages(); return true; }
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
    if (chatRequests.pending?.id === conversation.id) { title.append(el('span', 'history-pending', '生成中')); title.setAttribute('aria-label', `${conversation.title || '新对话'} · 正在生成`); }
    if (conversation.id === state.activeId) title.setAttribute('aria-current', 'true');
    const remove = button('×', 'history-delete', () => deleteConversation(conversation).catch(reportChatError));
    remove.setAttribute('aria-label', `删除对话：${conversation.title || '新对话'}`);
    remove.disabled = Boolean(chatRequests.pending);
    if (remove.disabled) remove.title = '当前回复完成后可删除对话';
    row.append(title, remove);
    return row;
  }));
}
async function openConversation(id) {
  saveDraft();
  const pendingAtLoad = chatRequests.pending;
  const generation = ++state.generation;
  state.loading = true;
  updateControls();
  showError($('chat-error'));
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (generation !== state.generation || !state.session) return false;
    state.activeId = id;
    state.selections[state.provider] = id;
    if (chatRequests.current?.id === id && !chatRequests.pending) chatRequests.current.noticeSeen = true;
    state.messages = pendingAtLoad?.id === id && pendingAtLoad.status !== 'pending' ? pendingAtLoad.messages : data.messages;
    restoreDraft();
    renderHistory();
    renderMessages();
    closeSidebar();
    scrollToBottom();
    return true;
  } finally { if (generation === state.generation && state.session) { state.loading = false; updateControls(); } }
}
async function deleteConversation(conversation) {
  if (chatRequests.pending || !await confirmAction('删除对话', `确定删除「${conversation.title || '新对话'}」？此操作无法撤销。`, '确认删除')) return;
  if (chatRequests.pending || !state.session) return;
  const provider = state.provider, session = state.session;
  await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
  if (state.session !== session) return;
  state.drafts.delete(draftKey(provider, conversation.id));
  state.failures.delete(draftKey(provider, conversation.id));
  if (chatRequests.current?.id === conversation.id) chatRequests.current.noticeSeen = true;
  if (state.selections[provider] === conversation.id) state.selections[provider] = null;
  if (provider !== state.provider) return;
  state.conversations = state.conversations.filter(item => item.id !== conversation.id);
  if (state.activeId === conversation.id) { state.activeId = null; state.messages = []; restoreDraft(); renderMessages(); updateControls(); }
  renderHistory();
  toast('对话已删除');
}
function newConversation() {
  saveDraft();
  ++state.generation;
  state.loading = false;
  state.activeId = null;
  state.selections[state.provider] = null;
  state.messages = [];
  restoreDraft();
  renderHistory();
  renderMessages();
  updateControls();
  closeSidebar();
  $('prompt').focus();
}
function renderWelcome() {
  const theme = themes[state.provider];
  const heading = state.provider === 'gemini' ? `你好，${state.session ? accountName(state.session.user) : '朋友'}。` : theme.title;
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
  head.append(el('span', 'message-avatar', message.role === 'user' ? accountName(state.session.user).slice(0, 1).toUpperCase() : theme.symbol), el('strong', '', message.role === 'user' ? '你' : theme.name));
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
  const task = chatRequests.pending;
  const messages = taskVisible(task) ? [...task.messages, { role: 'user', content: task.message, createdAt: task.createdAt }] : state.messages;
  $('welcome').hidden = messages.length > 0;
  if (!$('welcome').hidden) renderWelcome();
  $('messages').hidden = !messages.length;
  $('messages').replaceChildren(...messages.map(renderMessage));
  $('context-count').textContent = messages.length;
  $('context-name').textContent = state.conversations.find(item => item.id === state.activeId)?.title || (state.messages.length ? '正在交流' : '准备开始');
}
function scrollToBottom() { requestAnimationFrame(() => { $('conversation-scroll').scrollTop = $('conversation-scroll').scrollHeight; }); }
function draftKey(provider = state.provider, id = state.activeId) { return `${provider}:${id || 'new'}`; }
function saveDraft() { if (state.session && !state.loading) state.drafts.set(draftKey(), $('prompt').value); }
function restoreDraft() {
  $('prompt').value = state.drafts.get(draftKey()) || '';
  const failure = state.failures.get(draftKey());
  showError($('chat-error'), failure?.error || '');
  $('failed-message').hidden = !failure;
  $('failed-message-text').textContent = failure?.message || '';
  $('failed-message').open = false;
}
function taskVisible(task) {
  return Boolean(task && task.provider === state.provider && (task.id ? task.id === state.activeId : state.activeId === null && task.originGeneration === state.generation));
}
function mergeConversation(conversation) {
  state.conversations = [conversation, ...state.conversations.filter(item => item.id !== conversation.id)];
}
function updateControls() {
  const pending = chatRequests.pending, current = chatRequests.current;
  const provider = selectedProvider();
  const unavailable = !provider?.enabled || !provider?.configured;
  $('send-button').disabled = Boolean(pending) || state.loading || unavailable || !$('prompt').value.trim();
  $('send-button').title = pending ? '当前回复完成后可继续发送；可以先编辑草稿' : '发送消息';
  $('prompt').disabled = state.loading;
  $('new-chat').disabled = false;
  $('waiting').hidden = !taskVisible(pending);
  $('send-button').textContent = taskVisible(pending) ? '·' : '↑';
  for (const node of document.querySelectorAll('.history-delete')) node.disabled = Boolean(pending);
  const showTask = current && !taskVisible(current) && (pending || !current.noticeSeen);
  $('background-task').hidden = !showTask;
  if (showTask) {
    $('background-task-text').textContent = `${themes[current.provider].name} ${pending ? '正在回复，可浏览其他页面或编辑草稿；完成后可继续发送。' : current.status === 'error' ? '回复失败，原消息已保留。' : '回复已完成。'}`;
    $('view-background-task').textContent = pending ? '查看对话' : current.status === 'error' ? '查看详情' : '查看回复';
  }
}
function chatChanged(task, phase) {
  if (!state.session) return;
  if (phase === 'created') {
    if (task.provider === state.provider && task.originGeneration === state.generation && state.activeId === null) {
      saveDraft();
      const draft = state.drafts.get(draftKey()); state.drafts.delete(draftKey());
      state.activeId = task.id; state.selections[task.provider] = task.id;
      state.drafts.set(draftKey(), draft || '');
    }
  }
  if (task.conversation && task.provider === state.provider) mergeConversation(task.conversation);
  if (phase === 'settled') {
    if (task.usage) { state.session.usage = task.usage; updateQuota(); }
    const key = draftKey(task.provider, task.id);
    if (task.status === 'error') {
      state.failures.set(key, { error: task.error, message: task.message });
      if (taskVisible(task)) saveDraft();
      if (!state.drafts.get(key)) state.drafts.set(key, task.message);
    }
    if (taskVisible(task)) {
      state.messages = task.messages;
      if (task.status === 'error') restoreDraft();
      task.noticeSeen = true;
      renderMessages();
      scrollToBottom();
    }
  } else if (taskVisible(task)) { renderMessages(); scrollToBottom(); }
  renderHistory(); updateControls();
}
function reportChatError(error) { if (state.session) showError($('chat-error'), error.message); }
function sendChat(event) {
  event.preventDefault();
  const message = $('prompt').value.trim();
  const provider = selectedProvider();
  if (chatRequests.pending || state.loading || !message || !provider?.enabled || !provider?.configured) return;
  state.failures.delete(draftKey());
  state.drafts.set(draftKey(), '');
  restoreDraft();
  chatRequests.start({ provider: state.provider, conversationId: state.activeId, message, messages: state.messages, originGeneration: state.generation });
}

function field(labelText, name, { value = '', type = 'text', placeholder = '', required = false, min, max, options, hint, wide = false, autocomplete = 'off' } = {}) {
  const wrap = el('div', `field${wide ? ' wide' : ''}`);
  const label = el('label', '', labelText);
  const id = `field-${crypto.randomUUID()}`;
  label.htmlFor = id; label.id = `${id}-label`;
  if (options) {
    wrap.append(label, selectControl({ id, name, value, options, labelId: label.id }));
    return wrap;
  }
  const input = el('input');
  input.name = name;
  input.id = id;
  input.type = type; input.placeholder = placeholder; input.autocomplete = autocomplete;
  input.value = value;
  input.required = required;
  if (min !== undefined) { if (type === 'password') input.minLength = min; else input.min = min; }
  if (max !== undefined) { if (type === 'password') input.maxLength = max; else input.max = max; }
  wrap.append(label, input);
  if (hint) { const note = el('p', 'field-hint', hint); note.id = `${id}-hint`; input.setAttribute('aria-describedby', note.id); wrap.append(note); }
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
async function formRequest(form, action, { trigger = form.querySelector('[type="submit"]'), pending = '正在保存…', success = '已保存' } = {}) {
  if (form.getAttribute('aria-busy') === 'true') return;
  closeSelect();
  const buttons = [...form.querySelectorAll('button')].map(button => [button, button.disabled]);
  const fields = [...form.querySelectorAll('input, textarea, select')].map(input => [input, input.disabled]);
  const label = trigger.textContent;
  form.setAttribute('aria-busy', 'true');
  buttons.forEach(([button]) => { button.disabled = true; });
  trigger.textContent = pending;
  formStatus(form, pending);
  try {
    // Handlers capture FormData synchronously before their first request.
    const request = action();
    fields.forEach(([input]) => { input.disabled = true; });
    await request; formStatus(form, success);
  }
  catch (error) { if (state.session) formStatus(form, error.message, true); }
  finally {
    form.removeAttribute('aria-busy'); trigger.textContent = label;
    fields.forEach(([input, disabled]) => { input.disabled = disabled; });
    buttons.forEach(([button, disabled]) => { button.disabled = button.dataset.unavailable === undefined ? disabled : button.dataset.unavailable === 'true'; });
    if (trigger.isConnected && !trigger.disabled && document.activeElement === document.body) trigger.focus({ preventScroll: true });
  }
}
function setUnavailable(button, unavailable) {
  if (!button) return;
  button.dataset.unavailable = String(unavailable);
  button.disabled = unavailable || button.closest('form')?.getAttribute('aria-busy') === 'true';
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
  if (!state.session) return;
  disposeModelControls();
  closeSelect();
  const request = ++settingsRequest;
  const admin = state.session.user.role === 'admin';
  if (!admin) tab = 'personal';
  state.settingsTab = tab;
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  $('settings-title').textContent = tab === 'personal' ? '个人模型设置' : '管理工作空间';
  $('tab-personal').classList.toggle('active', tab === 'personal');
  $('tab-providers').hidden = !admin;
  $('tab-users').hidden = !admin;
  $('tab-providers').classList.toggle('active', tab === 'providers');
  $('tab-users').classList.toggle('active', tab === 'users');
  for (const name of ['personal', 'providers', 'users']) {
    $(`tab-${name}`).setAttribute('aria-selected', String(tab === name));
    $(`tab-${name}`).tabIndex = tab === name ? 0 : -1;
  }
  $('settings-content').setAttribute('aria-labelledby', `tab-${tab}`);
  $('settings-content').scrollTop = 0;
  $('settings-content').replaceChildren(el('p', 'loading-state', '正在加载设置…'));
  try {
    const result = await api(tab === 'personal' ? '/api/account/providers' : `/api/admin/${tab}`);
    if (!state.session || request !== settingsRequest || !$('settings-dialog').open) return;
    if (tab === 'personal') renderProviderSettings(result.providers, true, result.allowSharedKeys);
    else if (tab === 'providers') renderProviderSettings(result.providers);
    else renderUsers(result.users);
  } catch (error) {
    if (state.session && request === settingsRequest && $('settings-dialog').open) $('settings-content').replaceChildren(el('p', 'error-state', error.message), button('重试', 'secondary-button', () => openSettings(tab)));
  }
}
function renderProviderSettings(providers, personal = false, allowShared = false) {
  $('settings-content').replaceChildren(el('p', 'settings-intro', personal
    ? `这里的 API Key 和模型设置仅供你的账号使用。密钥加密保存，保存后不会回显，留空保留已有值；更改 API 地址须重新填写 Key。调用失败或删除密钥都不会自动切换到平台 Key。${allowShared ? '你已获授权，可主动选择平台连接，使用平台额度。' : '需要使用平台连接时，请联系管理员单独授权。'} 自有 Key 同样受本站请求额度限制。`
    : '配置平台提供的模型连接。仅管理员和已获授权的成员可使用。由平台管理的 API Key 需通过平台秘密配置更新；API 地址、模型和启用状态仍可在此修改。其他 API Key 保存后不会回显，留空保留已有密钥。'));
  for (const provider of providers) {
    const form = el('form', 'provider-settings-card');
    const heading = el('div', 'provider-settings-heading');
    const title = el('h3', '', `${themes[provider.id].symbol}  ${themes[provider.id].name}`);
    title.append(el('span', 'key-status'));
    heading.append(title, toggle('启用连接', 'enabled', provider.enabled));
    const grid = el('div', 'fields-grid');
    const protocols = [...(provider.id === 'openai' ? [] : [[provider.id, provider.id === 'anthropic' ? 'Anthropic Messages' : 'Gemini Generate Content']]), ['openai-responses', 'OpenAI Responses'], ['openai-chat', 'OpenAI 兼容 · Chat Completions']];
    const keyField = field('API Key', 'apiKey', { type: 'password', autocomplete: 'new-password' });
    const keyInput = keyField.querySelector('input');
    const keyHint = el('p', 'field-hint', '通过平台秘密配置更新');
    keyField.append(keyHint);
    let keySource;
    const sourceNote = el('p', 'connection-source');
    let remove, shared;
    function updateKeyState(config) {
      keySource = config.keySource || (config.hasKey ? 'stored' : 'none');
      const managed = keySource === 'environment';
      keyInput.value = '';
      keyInput.disabled = managed || form.getAttribute('aria-busy') === 'true';
      keyInput.placeholder = managed ? '由平台管理' : config.hasKey ? '已保存 · 留空保留' : '输入 API Key';
      keyHint.hidden = !managed;
      title.querySelector('.key-status').textContent = managed ? '由平台管理' : config.hasKey ? '密钥已保存' : '尚无密钥';
      setUnavailable(remove, !config.hasKey);
      setUnavailable(shared, config.source === 'shared');
      if (shared) shared.textContent = config.source === 'shared' ? '已使用平台连接' : '使用平台连接';
      if (personal) sourceNote.textContent = config.source === 'shared'
        ? (allowShared ? '当前使用：平台连接。保存以下设置将切换为个人连接。' : '平台连接未获授权，请填写并保存个人连接。')
        : `当前使用：个人连接${config.enabled ? '' : '（尚未启用）'}`;
    }
    const baseField = field('API 基础地址', 'baseUrl', { value: provider.baseUrl, type: 'url', placeholder: 'https://api.example.com/v1', wide: true });
    const baseInput = baseField.querySelector('input');
    const protocolField = field('接口协议', 'protocol', { value: provider.protocol, options: protocols });
    const protocolInput = protocolField.querySelector('input');
    const modelField = field('模型名称', 'model', { value: provider.model, wide: true });
    const modelInput = modelField.querySelector('input');
    const outputField = field('最大输出 Token', 'maxOutputTokens', { value: String(provider.maxOutputTokens), type: 'number', min: 1, required: true, wide: true, hint: '可手动填写，例如 32768、65536。实际可用上限由服务商和模型决定；这是输出预算，不是上下文长度。' });
    const outputInput = outputField.querySelector('input'), outputHint = outputField.querySelector('.field-hint');
    let listedModels = [];
    function updateOutputLimit() {
      const limit = modelOutputLimit(listedModels, modelInput.value.trim());
      if (limit === null) outputInput.removeAttribute('max'); else outputInput.max = String(limit);
      const exceeded = limit !== null && Number(outputInput.value) > limit;
      outputInput.setCustomValidity(exceeded ? `此模型返回的最大输出为 ${limit.toLocaleString()} Token，请调整数值。` : '');
      outputHint.classList.toggle('error', exceeded);
      outputHint.textContent = limit === null
        ? '可手动填写，例如 32768、65536。实际可用上限由服务商和模型决定；这是输出预算，不是上下文长度。'
        : `服务商返回的最大输出：${limit.toLocaleString()} Token。${exceeded ? '当前填写值超过上限，请调整后保存。' : '可在此范围内自行设置；最终以接口响应为准。'}`;
    }
    modelInput.addEventListener('input', updateOutputLimit);
    modelInput.addEventListener('change', updateOutputLimit);
    outputInput.addEventListener('input', updateOutputLimit);
    const picker = modelControl({ input: modelField.querySelector('input'), load: signal => {
      const payload = { baseUrl: baseInput.value.trim(), protocol: protocolInput.value };
      if (keySource !== 'environment' && keyInput.value.trim()) payload.apiKey = keyInput.value.trim();
      return api(`/api/${personal ? 'account' : 'admin'}/providers/${provider.id}/models`, { method: 'POST', body: payload, signal });
    }, onLoaded: result => { if (result.baseUrl) baseInput.value = result.baseUrl; listedModels = result.models; updateOutputLimit(); },
    onReset: () => { listedModels = []; updateOutputLimit(); } });
    modelField.append(picker.root);
    baseInput.addEventListener('input', picker.reset);
    keyInput.addEventListener('input', picker.reset);
    protocolInput.addEventListener('change', picker.reset);
    let protocolHost = new URL(provider.baseUrl).hostname;
    baseInput.addEventListener('input', () => {
      try {
        const host = new URL(baseInput.value.trim()).hostname;
        if (host === protocolHost || !host.includes('.')) return;
        protocolHost = host;
        const suggested = host === 'api.openai.com' ? 'openai-responses' : host === 'api.anthropic.com' ? 'anthropic' : host === 'generativelanguage.googleapis.com' ? 'gemini' : 'openai-chat';
        protocolField.querySelector('.select-control').setValue(suggested);
      } catch { /* URL validation is shown on query/save. */ }
    });
    grid.append(baseField, keyField, protocolField, modelField, outputField);
    const footer = formFooter(personal ? '保存并使用个人连接' : '保存设置');
    if (personal) {
      remove = button('删除个人密钥', 'danger-button', async () => {
        if (!await confirmAction(`删除 ${themes[provider.id].name} 个人密钥`, '删除后将停用此个人连接，需要重新填写 API Key 才能恢复。不会自动切换到平台连接。', '删除并停用')) return;
        if (!state.session || !form.isConnected) return;
        formRequest(form, async () => {
          await api(`/api/account/providers/${provider.id}`, {method: 'DELETE'});
          state.session = await api('/api/session'); updateHeader(); await openSettings('personal');
          toast('个人密钥已删除，个人连接已停用');
        }, { trigger: remove, pending: '正在删除…', success: '已删除' });
      });
      footer.append(remove);
      if (allowShared) {
        shared = button('使用平台连接', 'secondary-button', () => formRequest(form, async () => {
        await api(`/api/account/providers/${provider.id}`, {method: 'PUT', body: {source: 'shared'}});
        state.session = await api('/api/session'); updateHeader(); await openSettings('personal'); toast('已切换为平台连接');
        }, { trigger: shared, pending: '正在切换…', success: '已切换' }));
        footer.append(shared);
      }
    }
    updateKeyState(provider);
    form.append(heading);
    if (personal) form.append(sourceNote);
    form.append(grid, footer);
    form.addEventListener('submit', event => {
      event.preventDefault();
      picker.cancel();
      formRequest(form, async () => {
        const data = new FormData(form);
        const payload = { baseUrl: data.get('baseUrl').trim(), model: data.get('model').trim(), protocol: data.get('protocol'), maxOutputTokens: Number(data.get('maxOutputTokens')), enabled: data.has('enabled') };
        const apiKey = data.get('apiKey');
        if (keySource !== 'environment' && typeof apiKey === 'string' && apiKey.trim()) payload.apiKey = apiKey.trim();
        const result = await api(`/api/${personal ? 'account' : 'admin'}/providers/${provider.id}`, { method: 'PUT', body: payload });
        updateKeyState(result.provider);
        baseInput.value = result.provider.baseUrl;
        picker.saved();
        state.session = await api('/api/session');
        updateHeader();
      });
    });
    $('settings-content').append(form);
  }
}
function renderUsers(users) {
  const intro = el('p', 'settings-intro', '新成员默认使用个人 API Key。仅对你同意承担模型费用的成员开启「允许使用平台连接」。启用 Google 登录时，首次登录自动创建普通成员。个人与平台调用均受每日额度限制（包括上游失败）；暂停账号后无法继续访问。');
  const create = el('form', 'user-create');
  const grid = el('div', 'fields-grid');
  grid.append(field('用户名', 'username', { required: true, placeholder: '如 team-member', autocomplete: 'off', hint: '2–64 位字母、数字或 . _ @ -' }), field('初始密码', 'password', { type: 'password', required: true, min: 14, max: 128, placeholder: '14–128 个字符', autocomplete: 'new-password' }), field('每日请求额度', 'dailyLimit', { type: 'number', min: 1, max: 10000, value: '50', required: true }));
  create.append(el('h3', '', '邀请新成员'), grid, toggle('允许使用平台连接（消耗平台 Key）', 'allowSharedKeys', false), formFooter('创建成员账号'));
  create.addEventListener('submit', event => {
    event.preventDefault();
    formRequest(create, async () => {
      const data = new FormData(create);
      await api('/api/admin/users', { method: 'POST', body: { username: data.get('username').trim(), password: data.get('password'), dailyLimit: Number(data.get('dailyLimit')), allowSharedKeys: data.has('allowSharedKeys') } });
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
    const identity = el('div', 'user-identity');
    identity.append(el('strong', '', accountName(user)));
    if (user.email) identity.append(el('small', '', `用户名：${user.username}`));
    heading.append(identity, el('span', 'role-tag', user.role === 'admin' ? '管理员' : '成员'), toggle(isSelf ? '当前账号' : '启用账号', 'enabled', user.enabled, isSelf));
    const grid = el('div', 'fields-grid');
    const passwordField = field(user.passwordEnabled === false ? '设置本地密码（可选）' : '重置密码', 'password', { type: 'password', min: 14, max: 128, placeholder: user.passwordEnabled === false ? '留空继续仅使用 Google 登录' : '留空保持当前密码', autocomplete: 'new-password' });
    grid.append(field('每日请求额度', 'dailyLimit', { type: 'number', value: String(user.dailyLimit), min: 1, max: 10000, required: true }), passwordField);
    const footer = formFooter('保存成员');
    footer.append(el('span', 'usage-note', `今日已用 ${user.used} 次`));
    form.append(heading, grid, toggle('允许使用平台连接（消耗平台 Key）', 'allowSharedKeys', user.allowSharedKeys, user.role === 'admin'), footer);
    form.addEventListener('submit', event => {
      event.preventDefault();
      formRequest(form, async () => {
        const data = new FormData(form);
        const payload = { dailyLimit: Number(data.get('dailyLimit')) };
        if (user.role !== 'admin') payload.allowSharedKeys = data.has('allowSharedKeys');
        if (!isSelf) payload.enabled = data.has('enabled');
        if (data.get('password')) payload.password = data.get('password');
        const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: payload });
        form.elements.password.value = '';
        if (result.user.passwordEnabled !== false) {
          passwordField.querySelector('label').textContent = '重置密码';
          form.elements.password.placeholder = '留空保持当前密码';
        }
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
  if (state.loginPending) return;
  setLoginBusy(true);
  $('login-error').classList.remove('login-success');
  showError($('login-error'));
  try {
    const session = await api('/api/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
    $('password').value = '';
    await enterWorkspace(session);
  } catch (error) { showError($('login-error'), error.message); }
  finally { setLoginBusy(false); }
});
$('google-login-button').addEventListener('click', async () => {
  if (!state.googleEnabled || state.loginPending) return;
  setLoginBusy(true, true);
  $('login-error').classList.remove('login-success');
  showError($('login-error'));
  try {
    const result = await api('/api/auth/google/start', { method: 'POST', body: {} });
    location.assign(googleAuthorizationUrl(result.url));
  } catch (error) { showError($('login-error'), error.message); }
  finally { setLoginBusy(false); }
});
$('chat-form').addEventListener('submit', sendChat);
$('prompt').addEventListener('input', () => { saveDraft(); updateControls(); });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send-button').disabled) $('chat-form').requestSubmit(); } });
$('new-chat').addEventListener('click', newConversation);
$('view-background-task').addEventListener('click', async () => {
  const task = chatRequests.current;
  if (!task) return;
  try {
    if (state.provider !== task.provider && !await selectProvider(task.provider)) return;
    if (!state.session || state.provider !== task.provider) return;
    if (task.id) { if (!await openConversation(task.id)) return; } else newConversation();
    task.noticeSeen = true; updateControls();
  } catch (error) { reportChatError(error); }
});
$('brand-home').addEventListener('click', event => { event.preventDefault(); selectProvider('openai').catch(reportChatError); });
$('mobile-menu').addEventListener('click', () => { $('sidebar').classList.add('open'); $('sidebar-backdrop').hidden = false; });
$('sidebar-backdrop').addEventListener('click', closeSidebar);
$('settings-button').addEventListener('click', () => openSettings('providers'));
$('personal-settings-button').addEventListener('click', () => openSettings('personal'));
$('top-settings').addEventListener('click', () => openSettings('personal'));
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { closeSelect(); disposeModelControls(); ++settingsRequest; });
$('settings-dialog').querySelector('.settings-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('.settings-tabs .tab')].filter(tab => !tab.hidden);
  const current = tabs.indexOf(event.target);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
});
$('tab-providers').addEventListener('click', () => openSettings('providers'));
$('tab-personal').addEventListener('click', () => openSettings('personal'));
$('tab-users').addEventListener('click', () => openSettings('users'));
$('account-button').addEventListener('click', () => {
  const user = state.session.user;
  const passwordEnabled = user.passwordEnabled !== false;
  $('password-form').reset();
  $('password-form').hidden = !passwordEnabled;
  $('google-account-note').hidden = passwordEnabled;
  $('account-display-name').textContent = accountName(user);
  $('account-login-name').textContent = `${passwordEnabled ? '本地登录用户名' : '账号标识'}：${user.username}`;
  showError($('password-error'));
  showError($('account-error'));
  $('account-dialog').showModal();
});
$('close-account').addEventListener('click', () => $('account-dialog').close());
$('logout-button').addEventListener('click', async () => {
  $('logout-button').disabled = true;
  try { await api('/api/logout', { method: 'POST', body: {} }); showLogin(); }
  catch (error) { if (state.session) showError($('account-error'), error.message); }
  finally { $('logout-button').disabled = false; }
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.session?.user.passwordEnabled === false) return;
  const submit = $('password-form').querySelector('[type="submit"]');
  submit.disabled = true;
  showError($('password-error'));
  try { await api('/api/password', { method: 'POST', body: { currentPassword: $('current-password').value, newPassword: $('new-password').value } }); $('password-form').reset(); showLogin('密码已更新，请重新登录。', true); }
  catch (error) { if (state.session) showError($('password-error'), error.message); }
  finally { submit.disabled = false; }
});
window.addEventListener('popstate', () => {
  if (!state.session) return;
  selectProvider(routeProvider(), false).catch(reportChatError);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });

const loginQuery = new URLSearchParams(location.search);
const callbackError = googleLoginError(loginQuery.get('google_error'));
if (loginQuery.has('google_error')) history.replaceState({}, '', location.pathname);
const authConfigReady = loadAuthConfig();
try { await enterWorkspace(await api('/api/session')); }
catch (error) { showLogin(callbackError || (error.status === 401 ? '' : error.message)); }
await authConfigReady;
