import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

// Protocol references, checked 2026-10-14. API roots include their version prefix.
// https://developers.openai.com/api/docs/guides/text
// https://developers.openai.com/api/docs/guides/conversation-state
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// https://platform.claude.com/docs/en/api/messages/create
// https://ai.google.dev/api/generate-content
// Third-party "OpenAI-compatible" services must select the actual supported protocol.
export const PROVIDER_DEFAULTS = Object.freeze([
  Object.freeze({ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' }),
  Object.freeze({ id: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic' }),
  Object.freeze({ id: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' }),
]);

const OFFICIAL_HOSTS = PROVIDER_DEFAULTS.map((provider) => new URL(provider.baseUrl).hostname);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const ERRORS = Object.freeze({
  INVALID_PROVIDER_CONFIG: [400, '模型配置无效，请检查地址、协议、模型名和输出上限。'],
  INVALID_CHAT_MESSAGES: [400, '对话内容无效或过长。'],
  PROVIDER_NOT_CONFIGURED: [503, '此模型尚未启用或配置完整，请联系管理员。'],
  PROVIDER_UNAVAILABLE: [502, '模型服务暂时不可用，请稍后重试或联系管理员检查配置。'],
  PROVIDER_INVALID_RESPONSE: [502, '模型未返回完整有效的文本，请调整输出上限或稍后重试。'],
  PROVIDER_TIMEOUT: [504, '模型响应超时，请稍后重试。'],
  PROVIDER_CANCELLED: [499, '本次模型请求已取消。'],
});

class ProviderError extends Error {
  constructor(code) {
    super(ERRORS[code][1]);
    this.name = 'ProviderError';
    this.code = code;
    this.status = ERRORS[code][0];
  }
}

const error = (code) => new ProviderError(code);

function validDnsName(hostname) {
  return typeof hostname === 'string' && hostname.length <= 253 && hostname.includes('.')
    && hostname.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
    && !isIP(hostname);
}

function safeBaseUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\?#]/.test(value)) throw error('INVALID_PROVIDER_CONFIG');
  const authority = value.match(/^https:\/\/([^/]+)(?:\/|$)/i)?.[1];
  if (!authority || authority.includes('@')) throw error('INVALID_PROVIDER_CONFIG');
  let url;
  try { url = new URL(value); } catch { throw error('INVALID_PROVIDER_CONFIG'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password
    || url.search || url.hash || !validDnsName(url.hostname)) throw error('INVALID_PROVIDER_CONFIG');
  const hosts = new Set(OFFICIAL_HOSTS);
  if (allowedHosts instanceof Set) {
    for (const host of allowedHosts) {
      if (typeof host === 'string' && validDnsName(host.toLowerCase())) hosts.add(host.toLowerCase());
    }
  }
  if (!hosts.has(url.hostname)) throw error('INVALID_PROVIDER_CONFIG');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function validateProviderConfig(id, data, allowedHosts) {
  const defaults = PROVIDER_DEFAULTS.find((provider) => provider.id === id);
  if (!defaults || !data || typeof data !== 'object' || Array.isArray(data)) throw error('INVALID_PROVIDER_CONFIG');
  const protocol = data.protocol === undefined ? defaults.protocol : data.protocol;
  if (!(id === 'openai' ? ['openai-responses', 'openai-chat'] : [id]).includes(protocol)) throw error('INVALID_PROVIDER_CONFIG');
  const enabled = data.enabled === undefined ? false : data.enabled;
  if (typeof enabled !== 'boolean') throw error('INVALID_PROVIDER_CONFIG');
  const model = data.model === undefined ? '' : data.model;
  if (typeof model !== 'string' || model.length > 160 || (model === '' ? enabled : !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/.test(model))) throw error('INVALID_PROVIDER_CONFIG');
  const maxOutputTokens = data.maxOutputTokens === undefined ? 2048 : data.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 4096) throw error('INVALID_PROVIDER_CONFIG');
  return { baseUrl: safeBaseUrl(data.baseUrl === undefined ? defaults.baseUrl : data.baseUrl, allowedHosts), model, protocol, enabled, maxOutputTokens };
}

function inV4Range(value, base, bits) {
  const number = base.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
  const width = 2 ** (32 - bits);
  return Math.floor(value / width) === Math.floor(number / width);
}

function ipv6Number(address) {
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const pieces = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return pieces.reduce((acc, piece) => (acc << 16n) | BigInt(`0x${piece}`), 0n);
}

function inV6Range(value, base, bits) {
  const shift = BigInt(128 - bits);
  return value >> shift === ipv6Number(base) >> shift;
}

// Conservative global-unicast policy based on IANA special-purpose registries.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(value, base, bits));
  }
  if (family !== 6 || address.includes('.')) return false;
  const value = ipv6Number(address);
  return inV6Range(value, '2000::', 3) && ![
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ].some(([base, bits]) => inV6Range(value, base, bits));
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 200) throw error('INVALID_CHAT_MESSAGES');
  let total = 0;
  const clean = messages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'
      || !message.content.trim() || message.content.length > 100_000) throw error('INVALID_CHAT_MESSAGES');
    total += Buffer.byteLength(message.content);
    return { role: message.role, content: message.content };
  });
  if (total > 512 * 1024 || clean.at(-1).role !== 'user') throw error('INVALID_CHAT_MESSAGES');
  return clean;
}

export function buildProviderRequest(config, messages) {
  const history = validateMessages(messages);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' };
  const body = { model: config.model };
  let path;
  switch (config.protocol) {
    case 'openai-responses':
      path = '/responses';
      headers.Authorization = `Bearer ${config.apiKey}`;
      Object.assign(body, { input: history, max_output_tokens: config.maxOutputTokens, stream: false, store: false });
      break;
    case 'openai-chat':
      path = '/chat/completions';
      headers.Authorization = `Bearer ${config.apiKey}`;
      Object.assign(body, { messages: history, stream: false });
      // Official reasoning models require max_completion_tokens; legacy gateways
      // commonly implement max_tokens. Select by the exact configured API host.
      body[new URL(config.baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens'] = config.maxOutputTokens;
      break;
    case 'anthropic':
      path = '/messages';
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      Object.assign(body, { messages: history, max_tokens: config.maxOutputTokens, stream: false });
      break;
    case 'gemini':
      path = `/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:generateContent`;
      headers['x-goog-api-key'] = config.apiKey;
      delete body.model;
      body.contents = history.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] }));
      body.generationConfig = { maxOutputTokens: config.maxOutputTokens };
      break;
    default: throw error('INVALID_PROVIDER_CONFIG');
  }
  return { url: config.baseUrl + path, headers, body };
}

const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const textBlocks = (blocks, type) => Array.isArray(blocks)
  ? blocks.filter((block) => block?.type === type && typeof block.text === 'string').map((block) => block.text).join('') : '';

export function parseProviderResponse(protocol, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error) throw error('PROVIDER_INVALID_RESPONSE');
  let text;
  let inputTokens = 0;
  let outputTokens = 0;
  switch (protocol) {
    case 'openai-responses':
      if (response.status && response.status !== 'completed') throw error('PROVIDER_INVALID_RESPONSE');
      text = Array.isArray(response.output) ? response.output.filter((item) => item?.type === 'message').map((item) => textBlocks(item.content, 'output_text')).join('') : '';
      inputTokens = tokenCount(response.usage?.input_tokens);
      outputTokens = tokenCount(response.usage?.output_tokens);
      break;
    case 'openai-chat': {
      const choice = response.choices?.[0];
      if (choice?.finish_reason && choice.finish_reason !== 'stop') throw error('PROVIDER_INVALID_RESPONSE');
      text = choice?.message?.content;
      inputTokens = tokenCount(response.usage?.prompt_tokens);
      outputTokens = tokenCount(response.usage?.completion_tokens);
      break;
    }
    case 'anthropic':
      if (response.stop_reason && !['end_turn', 'stop_sequence'].includes(response.stop_reason)) throw error('PROVIDER_INVALID_RESPONSE');
      text = textBlocks(response.content, 'text');
      inputTokens = tokenCount(response.usage?.input_tokens) + tokenCount(response.usage?.cache_creation_input_tokens) + tokenCount(response.usage?.cache_read_input_tokens);
      outputTokens = tokenCount(response.usage?.output_tokens);
      break;
    case 'gemini': {
      const candidate = response.candidates?.[0];
      if (response.promptFeedback?.blockReason || (candidate?.finishReason && candidate.finishReason !== 'STOP')) throw error('PROVIDER_INVALID_RESPONSE');
      const parts = candidate?.content?.parts;
      text = Array.isArray(parts) ? parts.filter((part) => part?.thought !== true && typeof part?.text === 'string').map((part) => part.text).join('') : '';
      inputTokens = tokenCount(response.usageMetadata?.promptTokenCount);
      outputTokens = tokenCount(response.usageMetadata?.candidatesTokenCount) + tokenCount(response.usageMetadata?.thoughtsTokenCount);
      break;
    }
    default: throw error('PROVIDER_INVALID_RESPONSE');
  }
  if (typeof text !== 'string' || !text.trim()) throw error('PROVIDER_INVALID_RESPONSE');
  return { text, usage: { inputTokens, outputTokens } };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolveAddress(hostname, signal) {
  const answers = await abortable(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  if (signal.aborted) throw signal.reason;
  if (!Array.isArray(answers) || !answers.length || answers.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) throw error('PROVIDER_UNAVAILABLE');
  const answer = answers.find((item) => item.family === 4) ?? answers[0];
  return { address: answer.address, family: answer.family };
}

function sendRequest(request, address, signal) {
  return new Promise((resolve, reject) => {
    let req;
    let res;
    let settled = false;
    let ended = false;
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (failure) {
        res?.destroy();
        req?.destroy();
        reject(failure);
      } else resolve(value);
    };
    const abort = () => finish(signal.reason);
    if (signal.aborted) { finish(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    const url = new URL(request.url);
    const body = JSON.stringify(request.body);
    try {
      req = https.request(url, {
        method: 'POST', headers: { ...request.headers, 'Content-Length': Buffer.byteLength(body) },
        agent: false, rejectUnauthorized: true, servername: url.hostname, autoSelectFamily: false,
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, (response) => {
        res = response;
        // Error listeners remain installed through destroy() to absorb late socket errors.
        res.on('error', () => finish(error('PROVIDER_UNAVAILABLE')));
        if (settled) { res.destroy(); return; }
        if (res.statusCode < 200 || res.statusCode >= 300 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          finish(error('PROVIDER_UNAVAILABLE')); return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { finish(error('PROVIDER_INVALID_RESPONSE')); return; }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(error('PROVIDER_UNAVAILABLE')));
        res.on('close', () => { if (!ended) finish(error('PROVIDER_UNAVAILABLE')); });
        res.on('end', () => {
          ended = true;
          if (settled) return;
          try { finish(null, JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
          catch { finish(error('PROVIDER_INVALID_RESPONSE')); }
        });
      });
      req.on('error', () => finish(error('PROVIDER_UNAVAILABLE')));
      req.on('close', () => { if (!res) finish(error('PROVIDER_UNAVAILABLE')); });
      req.on('upgrade', (_response, socket) => {
        socket.destroy();
        finish(error('PROVIDER_UNAVAILABLE'));
      });
      req.end(body);
    } catch { finish(error('PROVIDER_UNAVAILABLE')); }
  });
}

export async function callProvider(config, messages, { allowedHosts, signal } = {}) {
  const normalized = validateProviderConfig(config?.id, config, allowedHosts);
  if (!normalized.enabled || !normalized.model || typeof config.apiKey !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(config.apiKey)) throw error('PROVIDER_NOT_CONFIGURED');
  const request = buildProviderRequest({ ...normalized, apiKey: config.apiKey }, messages);
  const controller = new AbortController();
  const abort = () => controller.abort(error('PROVIDER_CANCELLED'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  // This is one total deadline, including lookup, TLS, headers and the complete body.
  const timer = setTimeout(() => controller.abort(error('PROVIDER_TIMEOUT')), TIMEOUT_MS);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const address = await resolveAddress(new URL(request.url).hostname, controller.signal);
    const response = await sendRequest(request, address, controller.signal);
    return parseProviderResponse(normalized.protocol, response);
  } catch (failure) {
    if (failure instanceof ProviderError) throw failure;
    throw error('PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
