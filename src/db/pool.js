require('../loadEnv');

const mysql = require('mysql2/promise');

module.exports = {
  async createPool() {
    // 使用 mysql2 连接池，生产环境请使用独立 MySQL/MariaDB 服务器
    return mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'english_user',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'english_corpus',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: '+00:00',
    });
  },
};