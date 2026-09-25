import { API_URL, apiFetch, setAuthToken, clearAuthToken, loadAuthToken } from '../api';

/**
 * 认证接口：持有 JWT 与用户信息，并持久化到 AsyncStorage（多端登录，每端各自保存 token）。
 */

/**
 * 从响应里取出可读的错误文案。
 * 兼容三种情况：后端返回 { error }、返回非 JSON（如 404 的 HTML 页）、5xx。
 */
async function readError(resp, fallback) {
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    data = null;
  }
  if (data && data.error) return data.error;
  if (resp.status === 404) return '接口不存在（404），请确认服务器地址与后端版本是否匹配';
  if (resp.status >= 500) return `服务器错误（${resp.status}），请稍后重试`;
  return `${fallback}（HTTP ${resp.status}）`;
}

export async function login(account, password) {
  const resp = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: { account, password }, // apiFetch 内部会 JSON.stringify，这里传对象即可
  });
  if (!resp.ok) throw new Error(await readError(resp, '登录失败'));
  const data = await resp.json();
  setAuthToken(data.token);
  return data;
}

export async function register(username, email, password) {
  const resp = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: { username, email, password }, // apiFetch 内部会 JSON.stringify
  });
  if (!resp.ok) throw new Error(await readError(resp, '注册失败'));
  const data = await resp.json();
  setAuthToken(data.token);
  return data;
}

export async function fetchMe() {
  const resp = await apiFetch('/api/auth/me');
  if (!resp.ok) throw new Error(await readError(resp, '获取用户信息失败'));
  const data = await resp.json();
  return data.user;
}

export { API_URL, setAuthToken, loadAuthToken };
export function logout() {
  clearAuthToken();
}
