/* 验证 AI 配置接口：保存(加密存储)->读取 是否正常 */
const base = process.argv[2] || 'http://127.0.0.1:3000';
async function j(method, path, token, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
(async () => {
  // 用既有测试用户登录
  const users = await j('POST', '/api/auth/register', null, { username: 'aicfg_' + Date.now(), email: 'a@t.com', password: 'AiCfgPass123!' });
  const token = users.data.token;
  console.log('注册:', users.status, users.data.user ? 'OK' : users.data);
  // 保存 AI 配置（假 key）
  let r = await j('POST', '/api/ai/config', token, { base_url: 'https://api.openai.com/v1', api_key: 'sk-test-123456', model: 'gpt-4o' });
  console.log('保存AI配置:', r.status, r.data.message || r.data.error);
  // 读取（应不返回 key，但 configured=true）
  r = await j('GET', '/api/ai/config', token);
  console.log('读取AI配置:', r.status, 'configured=' + r.data.configured, 'base_url=' + r.data.base_url, 'model=' + r.data.model);
  console.log('Key 未回显(只显示是否为脱敏隐藏):', r.data.api_key === undefined);
})().catch((e) => { console.error('失败', e); process.exit(1); });