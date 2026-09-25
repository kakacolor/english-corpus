/**
 * 离线功能验证：密码重置 & 「退出所有设备登录」
 *
 * 不依赖 MySQL：用一个内存假 users 表 + 真实路由/中间件代码，
 * 通过真实 HTTP 请求验证完整流程。
 *
 * 运行： node password-reset-test.js
 */
process.env.JWT_SECRET = 'test-secret-for-verification';
process.env.JWT_EXPIRES_IN = '7d';

const express = require('express');
const jwt = require('jsonwebtoken');

// ———————— 内存假 users 表 ————————
const users = [];
let nextId = 1;

async function fakeQuery(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  // 中间件：取 token_version
  if (/^SELECT id, username, token_version FROM users WHERE id = \? LIMIT 1$/i.test(s)) {
    const u = users.find((x) => x.id === Number(params[0]));
    return [u ? [{ id: u.id, username: u.username, token_version: u.token_version }] : []];
  }
  // 注册
  if (/^INSERT INTO users \(username, email, password_hash\) VALUES \(\?, \?, \?\)$/i.test(s)) {
    const [username, email, password_hash] = params;
    if (users.some((u) => u.username === username)) {
      const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e;
    }
    const u = { id: nextId++, username, email, password_hash, token_version: 0 };
    users.push(u);
    return [{ insertId: u.id, affectedRows: 1 }];
  }
  // 登录查询
  if (/^SELECT id, username, email, password_hash, token_version FROM users WHERE username = \? OR email = \? LIMIT 1$/i.test(s)) {
    const u = users.find((x) => x.username === params[0] || (params[1] && x.email === params[1]));
    return [u ? [{ id: u.id, username: u.username, email: u.email, password_hash: u.password_hash, token_version: u.token_version }] : []];
  }
  // 登录时间
  if (/^UPDATE users SET last_login_at = NOW\(\) WHERE id = \?$/i.test(s)) {
    return [{ affectedRows: 1 }];
  }
  // /me
  if (/^SELECT id, username, email, created_at FROM users WHERE id = \?$/i.test(s)) {
    const u = users.find((x) => x.id === Number(params[0]));
    return [u ? [{ id: u.id, username: u.username, email: u.email, created_at: new Date().toISOString() }] : []];
  }
  // 改密码：读
  if (/^SELECT id, password_hash FROM users WHERE id = \? LIMIT 1$/i.test(s)) {
    const u = users.find((x) => x.id === Number(params[0]));
    return [u ? [{ id: u.id, password_hash: u.password_hash }] : []];
  }
  // 改密码：写（token_version + 1）
  if (/^UPDATE users SET password_hash = \?, token_version = token_version \+ 1 WHERE id = \?$/i.test(s)) {
    const u = users.find((x) => x.id === Number(params[1]));
    if (!u) return [{ affectedRows: 0 }];
    u.password_hash = params[0];
    u.token_version += 1;
    return [{ affectedRows: 1 }];
  }

  throw new Error('未预期的 SQL: ' + s);
}

const app = express();
app.use(express.json());
// 模拟 server.js 的 req.db 注入
app.use((req, res, next) => {
  req.db = { query: (sql, p) => fakeQuery(sql, p) };
  next();
});
app.use('/api/auth', require('./src/routes/auth'));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} ${extra}`); }
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, data };
  };
  const get = async (path, token) => {
    const res = await fetch(base + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, data };
  };

  console.log('\n[1] 注册并登录');
  const reg = await post('/api/auth/register', { username: 'alice', password: 'OldPass123!' });
  check('注册成功 201', reg.status === 201, JSON.stringify(reg));
  const oldToken = reg.data && reg.data.token;
  check('注册返回 token', !!oldToken);
  const decodedOld = jwt.verify(oldToken, process.env.JWT_SECRET);
  check('token 内含 ver=0', decodedOld.ver === 0, `ver=${decodedOld.ver}`);
  check('GET /me 旧 token 可用', (await get('/api/auth/me', oldToken)).status === 200);

  console.log('\n[2] 重置密码的参数校验');
  check('缺字段 → 400', (await post('/api/auth/change-password', { current_password: 'OldPass123!' }, oldToken)).status === 400);
  check('新密码过短 → 400', (await post('/api/auth/change-password', { current_password: 'OldPass123!', new_password: 'short' }, oldToken)).status === 400);
  check('新旧相同 → 400', (await post('/api/auth/change-password', { current_password: 'OldPass123!', new_password: 'OldPass123!' }, oldToken)).status === 400);
  check('当前密码错误 → 401', (await post('/api/auth/change-password', { current_password: 'WrongPass123!', new_password: 'NewPass456!' }, oldToken)).status === 401);
  check('未登录调用 → 401', (await post('/api/auth/change-password', { current_password: 'OldPass123!', new_password: 'NewPass456!' })).status === 401);

  console.log('\n[3] 正常重置密码');
  const reset = await post('/api/auth/change-password', { current_password: 'OldPass123!', new_password: 'NewPass456!' }, oldToken);
  check('重置成功 200', reset.status === 200, JSON.stringify(reset));
  check('返回 ok:true', reset.data && reset.data.ok === true);
  check('数据库 token_version 自增为 1', users[0].token_version === 1, `got ${users[0].token_version}`);

  console.log('\n[4] 重置后：所有设备的旧 token 立即失效');
  const meOld = await get('/api/auth/me', oldToken);
  check('旧 token 访问 /me → 401', meOld.status === 401, JSON.stringify(meOld));
  check('错误信息提示已重置', /重置/.test((meOld.data && meOld.data.error) || ''), JSON.stringify(meOld.data));

  console.log('\n[5] 重置后：密码生效');
  check('旧密码登录 → 401', (await post('/api/auth/login', { account: 'alice', password: 'OldPass123!' })).status === 401);
  const login = await post('/api/auth/login', { account: 'alice', password: 'NewPass456!' });
  check('新密码登录 → 200', login.status === 200, JSON.stringify(login));
  const newToken = login.data && login.data.token;
  const decodedNew = jwt.verify(newToken, process.env.JWT_SECRET);
  check('新 token ver=1', decodedNew.ver === 1, `ver=${decodedNew.ver}`);
  check('新 token 可访问 /me', (await get('/api/auth/me', newToken)).status === 200);

  console.log('\n[6] 向下兼容：升级前签发的旧 token（无 ver 字段）');
  users.push({ id: 999, username: 'bob', email: null, password_hash: 'x', token_version: 0 });
  const legacy = jwt.sign({ sub: 999, username: 'bob' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  check('token_version=0 时旧 token 仍可用', (await get('/api/auth/me', legacy)).status === 200);
  users.find((u) => u.id === 999).token_version = 1;
  check('token_version 变为 1 后旧 token 失效', (await get('/api/auth/me', legacy)).status === 401);

  console.log('\n[7] 伪造 / 无效 token');
  check('乱码 token → 401', (await get('/api/auth/me', 'not-a-jwt')).status === 401);
  const forged = jwt.sign({ sub: 1, username: 'alice', ver: 1 }, 'wrong-secret');
  check('错误密钥签名 → 401', (await get('/api/auth/me', forged)).status === 401);
  const noUser = jwt.sign({ sub: 4242, username: 'ghost', ver: 0 }, process.env.JWT_SECRET);
  check('用户不存在 → 401', (await get('/api/auth/me', noUser)).status === 401);

  server.close();
  console.log(`\n================ 结果：${passed} 通过 / ${failed} 失败 ================`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('验证脚本异常:', err); process.exit(1); });
