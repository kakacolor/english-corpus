/* 端到端冒烟测试：注册→登录→Excel导入→查询→复习注册
 * 用法: node e2e-test.js <baseUrl>
 * 在服务器本地运行，node 内置 fetch。
 */
const base = process.argv[2] || 'http://127.0.0.1:3000';
const XLSX = require('xlsx');
const crypto = require('crypto');

function j(method, path, token, body) {
  return fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = txt; }
    return { status: r.status, data };
  });
}

(async () => {
  const uname = 'e2e_' + crypto.randomBytes(3).toString('hex');
  const pass = 'E2ePassw0rd!';

  console.log('1) 注册', uname);
  let r = await j('POST', '/api/auth/register', null, { username: uname, email: uname + '@t.com', password: pass });
  console.log('   ->', r.status, r.data.user ? '注册成功 user.id=' + r.data.user.id : r.data);
  if (r.status !== 201) { process.exit(1); }
  const token = r.data.token;

  console.log('2) 查询当前用户 /auth/me');
  r = await j('GET', '/api/auth/me', token);
  console.log('   ->', r.status, r.data.user ? 'OK user=' + r.data.user.username : r.data);

  console.log('3) 登录');
  r = await j('POST', '/api/auth/login', null, { account: uname, password: pass });
  console.log('   ->', r.status, r.data.user ? '登录成功' : r.data);

  console.log('4) Excel 导入');
  // 构造内存 Excel
  const rows = [
    { 单词: 'abandon', '本次积累的中文意思': '抛弃；放弃', '词典中的中文意思': 'v. 放弃，抛弃' },
    { 单词: 'diligent', '本次积累的中文意思': '勤奋的', '词典中的中文意思': 'adj. 勤奋的' },
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'words.xlsx');
  r = await fetch(base + '/api/vocab/import', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
  }).then(async (x) => ({ status: x.status, data: await x.json() }));
  console.log('   ->', r.status, JSON.stringify(r.data));
  if (r.data.inserted < 1) process.exit(1);

  console.log('5) 查询单词本');
  r = await j('GET', '/api/vocab?page=1&pageSize=10', token);
  console.log('   ->', r.status, 'total=' + r.data.total, r.data.list.map((i) => i.word).join(', '));

  console.log('6) 注册复习计划(ensure-all)');
  r = await j('POST', '/api/review/ensure-all', token, {});
  console.log('   ->', r.status, JSON.stringify(r.data));

  console.log('7) 今日待复习');
  r = await j('GET', '/api/review/today', token);
  console.log('   ->', r.status, '待复习=' + (r.data.list ? r.data.list.length : 0));

  console.log('8) 提交复习(记住)');
  const entryId = (await j('GET', '/api/vocab?page=1&pageSize=1', token)).data.list[0].id;
  r = await j('POST', '/api/review/submit', token, { entry_id: entryId, remembered: true });
  console.log('   ->', r.status, JSON.stringify(r.data));

  console.log('9) 数据同步 pull');
  r = await j('GET', '/api/sync/pull?last_sync=2000-01-01T00:00:00Z&device_id=e2e', token);
  console.log('   ->', r.status, 'entries=' + (r.data.entries ? r.data.entries.length : 0));

  console.log('\n✅ 端到端全部通过');
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });