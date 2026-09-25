-- ============================================================
-- 001-init.sql  英语语料积累软件 初始表结构
-- 独立 MySQL / MariaDB，不使用 SQLite
-- 每个账号通过 user_id 外键严格隔离数据
-- ============================================================

-- 用户表：密码使用 bcrypt 哈希保存（绝不明文）
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NULL UNIQUE,
  -- bcrypt 哈希字符串（形如 $2b$10$...），长度 60
  password_hash VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 单词本条目
CREATE TABLE IF NOT EXISTS vocab_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  word VARCHAR(255) NOT NULL,
  -- 本次积累的中文意思
  user_meaning TEXT NOT NULL,
  -- 词典中的中文意思
  dict_meaning TEXT NULL,
  -- 可选：来源图片/批次说明、音标、例句
  note TEXT NULL,
  phonetic TEXT NULL,
  example TEXT NULL,
  source VARCHAR(64) DEFAULT 'excel',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_word (user_id, word),
  INDEX idx_user_updated (user_id, updated_at),
  CONSTRAINT fk_vocab_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 艾宾浩斯复习调度记录
CREATE TABLE IF NOT EXISTS review_schedule (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  entry_id BIGINT UNSIGNED NOT NULL,
  -- 当前所处复习阶段(interval 档位)
  stage INT NOT NULL DEFAULT 0,
  -- 下一次复习时间（UTC）
  next_review_at DATETIME NOT NULL,
  -- 上次复习时间
  last_review_at DATETIME NULL,
  -- 已累计复习次数
  review_count INT NOT NULL DEFAULT 0,
  -- 记忆强度 0~1，用于推送难度/热词排行
  strength DECIMAL(3,2) NOT NULL DEFAULT 0.50,
  -- 0=学习中 1=已掌握
  status TINYINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_entry (user_id, entry_id),
  INDEX idx_user_next (user_id, next_review_at),
  CONSTRAINT fk_review_entry FOREIGN KEY (entry_id) REFERENCES vocab_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用户自定义 AI 配置（保存时 AI 密钥可加密存储；这里给出明文列位，生产可按需加应用层加密）
CREATE TABLE IF NOT EXISTS user_ai_config (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL UNIQUE,
  -- 例如 openai-compatible 的 base_url，如 https://api.openai.com/v1
  base_url VARCHAR(500) NOT NULL,
  api_key_enc VARCHAR(1000) NOT NULL,
  model VARCHAR(100) NOT NULL DEFAULT 'gpt-4o',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 数据同步：客户端增量同步游标（每用户每设备）
CREATE TABLE IF NOT EXISTS sync_cursors (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  last_synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_device (user_id, device_id),
  CONSTRAINT fk_sync_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;