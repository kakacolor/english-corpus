/**
 * 管理员授权工具（决定谁能登录后台管理页 /admin）
 *
 * 用法（在服务器项目根目录执行）：
 *   node src/db/make-admin.js <用户名>          # 授予管理员
 *   node src/db/make-admin.js <用户名> --revoke # 撤销管理员
 *   node src/db/make-admin.js --list            # 列出所有管理员
 *
 * 需要先执行迁移：node src/db/migrate.js（006-admin.sql 会增加 is_admin / last_login_at 两列）
 */
require('../loadEnv');
const mysql = require('mysql2/promise');

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const list = args.includes('--list');
  const username = args.filter((a) => !a.startsWith('--'))[0];

  if (!list && !username) {
    console.log('用法: node src/db/make-admin.js <用户名> [--revoke]');
    console.log('      node src/db/make-admin.js --list');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'english_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'english_corpus',
    charset: 'utf8mb4',
    timezone: '+00:00',
  });

  try {
    if (list) {
      const [rows] = await conn.query(
        'SELECT id, username, email, is_admin, last_login_at FROM users WHERE is_admin = 1 ORDER BY id'
      );
      console.log(`管理员共 ${rows.length} 个：`);
      for (const r of rows) {
        console.log(`  #${r.id} ${r.username}${r.email ? ' <' + r.email + '>' : ''} 最后登录: ${r.last_login_at || '从未'}`);
      }
      return;
    }

    const [rows] = await conn.query('SELECT id, username, is_admin FROM users WHERE username = ? LIMIT 1', [username]);
    if (!rows.length) {
      console.error(`用户不存在: ${username}`);
      process.exit(1);
    }
    const u = rows[0];
    const target = revoke ? 0 : 1;

    if (revoke) {
      // 安全兜底：不能把最后一个管理员撤销掉，否则没人能进后台
      const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
      if (Number(c.n) <= 1) {
        console.error('拒绝执行：至少要保留一个管理员（当前只有 1 个）。');
        process.exit(1);
      }
    }

    await conn.query('UPDATE users SET is_admin = ? WHERE id = ?', [target, u.id]);
    console.log(`${revoke ? '已撤销' : '已授予'}管理员: #${u.id} ${u.username}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  console.error('若提示 is_admin 字段不存在，请先执行: node src/db/migrate.js');
  process.exit(1);
});
