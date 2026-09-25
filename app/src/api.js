import { Platform } from 'react-native';
import Constants from 'expo-constants';
import storage from './storage';

/**
 * 统一 API 客户端
 *  - 服务器地址来源（优先级从高到低）：
 *      1) 手机 App 内「设置 → 服务器地址设置」保存的地址（仅原生端，存 AsyncStorage）
 *      2) 项目根目录 .env 的 EXPO_PUBLIC_API_URL（Web 端只用这个；经 app/app.config.js 注入）
 *      3) 代码内置默认值
 *  - 自动携带 JWT token
 *  - token 存 AsyncStorage
 */
/**
 * 读取项目根目录 .env 里配置的后端地址。
 * app/app.config.js 会把根 .env 的 EXPO_PUBLIC_API_URL 放进 expo.extra.apiUrl，
 * 这里通过 expo-constants 取出（构建期与运行期都可用，Web/手机端一致）。
 */
function readApiUrlFromAppConfig() {
  try {
    const cfg = Constants.expoConfig || Constants.manifest2 || Constants.manifest;
    const extra = (cfg && cfg.extra) || {};
    return typeof extra.apiUrl === 'string' ? extra.apiUrl : '';
  } catch (_) {
    return '';
  }
}

/**
 * 后端地址来源（优先级从高到低）：
 *   1) 项目根目录 .env 的 EXPO_PUBLIC_API_URL（经 app.config.js → extra.apiUrl）
 *   2) 构建时内联的 process.env.EXPO_PUBLIC_API_URL（兜底）
 *   3) 代码内置默认值
 */
export const DEFAULT_API_URL =
  readApiUrlFromAppConfig() || process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3000';
const URL_KEY = '***';

/** 当前生效的服务器地址（原生端可能被 App 内设置覆盖） */
export let API_URL = DEFAULT_API_URL;

const TOKEN_KEY = 'english_corpus_token';

let authToken = null;

/** 是否为原生端（只有手机 App 允许在设置里改服务器地址） */
export const CAN_CHANGE_SERVER_URL = Platform.OS !== 'web';

/** 归一化地址：去空白、去结尾斜杠，返回 { ok, url, error } */
export function normalizeServerUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '请填写服务器地址' };
  let url = raw.replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url)) {
    return { ok: false, error: '地址需以 http:// 或 https:// 开头，例如 http://192.168.1.10:3000' };
  }
  if (!/^https?:\/\/[^\s/]+(:\d+)?(\/.*)?$/.test(url)) {
    return { ok: false, error: '地址格式不正确' };
  }
  return { ok: true, url };
}

/** 读取当前服务器地址配置（供设置页展示） */
export function getServerUrlConfig() {
  return {
    canChange: CAN_CHANGE_SERVER_URL,
    effective: API_URL,
    configured: CAN_CHANGE_SERVER_URL ? API_URL !== DEFAULT_API_URL : true,
    defaultUrl: DEFAULT_API_URL,
    source: API_URL === DEFAULT_API_URL ? '配置文件/内置默认' : 'App 内自定义',
  };
}

/** 启动时调用：加载 App 内保存的服务器地址（仅原生端） */
export async function loadServerUrl() {
  if (!CAN_CHANGE_SERVER_URL) return API_URL;
  try {
    const saved = await storage.getItem(URL_KEY);
    const n = normalizeServerUrl(saved);
    if (saved && n.ok) API_URL = n.url;
  } catch (_) { /* ignore */ }
  return API_URL;
}

/** 保存自定义服务器地址（仅原生端；Web 端请改项目根目录 .env） */
export async function saveServerUrl(input) {
  if (!CAN_CHANGE_SERVER_URL) return { ok: false, error: 'Web 端请在项目根目录 .env 中指定服务器地址' };
  const n = normalizeServerUrl(input);
  if (!n.ok) return n;
  const changed = n.url !== API_URL;
  await storage.setItem(URL_KEY, n.url);
  API_URL = n.url;
  // 换了服务器，旧服务器上签发的 token 不再有效，清掉以免卡在失效登录态
  if (changed) clearAuthToken();
  return { ok: true, url: n.url, changed };
}

/** 清除自定义地址，恢复配置文件/默认地址 */
export async function resetServerUrl() {
  if (!CAN_CHANGE_SERVER_URL) return { ok: true, url: DEFAULT_API_URL };
  const changed = API_URL !== DEFAULT_API_URL;
  try { await storage.removeItem(URL_KEY); } catch (_) { /* ignore */ }
  API_URL = DEFAULT_API_URL;
  if (changed) clearAuthToken();
  return { ok: true, url: DEFAULT_API_URL, changed };
}

/** 直连测试某个服务器地址是否可用（不依赖当前生效地址） */
export async function pingServer(baseUrl) {
  const n = normalizeServerUrl(baseUrl);
  if (!n.ok) return n;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`${n.url}/api/health`, { signal: controller.signal });
    let body = null;
    try { body = await resp.json(); } catch (_) { /* ignore */ }
    return {
      ok: resp.ok && !!(body && body.ok),
      status: resp.status,
      latency_ms: Date.now() - startedAt,
      server_time: body && body.time,
      error: resp.ok ? '' : `HTTP ${resp.status}`,
    };
  } catch (err) {
    return { ok: false, error: `连接失败：${err.message}`, latency_ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export function setAuthToken(token) {
  authToken = token;
  storage.setItem(TOKEN_KEY, token).catch(() => {});
}

export function clearAuthToken() {
  authToken = null;
  storage.removeItem(TOKEN_KEY).catch(() => {});
}

export async function loadAuthToken() {
  authToken = await storage.getItem(TOKEN_KEY);
  return authToken;
}

export function getAuthToken() {
  return authToken;
}

/**
 * 把 fetch 的底层报错转成用户能看懂的中文提示。
 * 浏览器抛的是 "Failed to fetch"、RN 抛的是 "Network request failed"，
 * 直接显示给用户没有任何意义。
 */
export function networkErrorMessage(err) {
  const raw = String((err && err.message) || err || '');
  if (err && err.name === 'AbortError') {
    return `请求超时，服务器没有响应（${API_URL}）`;
  }
  if (/failed to fetch|network request failed|load failed|networkerror|fetch failed/i.test(raw)) {
    return `无法连接服务器（${API_URL}），请检查网络或服务器地址`;
  }
  return raw || '请求失败，请重试';
}

/**
 * fetch 封装：自动加 JSON 头、Authorization、超时
 */
export async function apiFetch(path, { method = 'GET', body, headers = {}, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const opts = {
    method,
    signal: controller.signal,
    headers: { ...headers },
  };
  if (authToken) opts.headers.Authorization = `Bearer ${authToken}`;
  if (body && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }

  try {
    const resp = await fetch(`${API_URL}${path}`, opts);
    if (resp.status === 401) {
      // token 失效，通知上层重新登录
      clearAuthToken();
    }
    return resp;
  } catch (err) {
    // 网络层失败（服务器不可达 / 超时 / 被浏览器拦截）：转成可读提示
    throw new Error(networkErrorMessage(err));
  } finally {
    clearTimeout(timer);
  }
}
