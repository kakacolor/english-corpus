/**
 * 数据库迁移脚本
 * 语法表 (migration_log) + 按序号执行 src/db/migrations/*.sql
 * 用法: node src/db/migrate.js
 */
require('../loadEnv');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// 迁移需要一次性执行多语句 .sql，因此用独立的支持 multipleStatements 的连接，
// 与普通应用连接池分开，不影响应用的 SQL 注入防护。
async function createMigrationConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'english_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'english_corpus',
    charset: 'utf8mb4',
    timezone: '+00:00',
    multipleStatements: true,
  });
}

// 去掉 SQL 中的注释行，并按分号拆分成多条语句（避免注释干扰）
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function run() {
  const conn = await createMigrationConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS migration_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const [applied] = await conn.query('SELECT name FROM migration_log');
    const appliedSet = new Set(applied.map((r) => r.name));

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`跳过(已应用): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`应用迁移: ${file}`);
      // 逐条执行每个语句
      for (const stmt of splitStatements(sql)) {
        await conn.query(stmt);
      }
      await conn.query('INSERT INTO migration_log (name) VALUES (?)', [file]);
      count++;
    }

    console.log(`\n迁移完成，共应用 ${count} 个文件。`);
  } finally {
    await conn.end();
  }
}

run().catch((err) => {
  console.error('迁移失败:', err.message);
  console.error('请检查 .env 中的数据库配置是否与服务器一致。');
  process.exit(1);
});