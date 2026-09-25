-- ============================================================
-- 002-user-token-version.sql
-- 为 users 增加 token_version 字段：
--   重置密码时自增该值，并把它写进新签发的 JWT（payload.ver）。
--   认证中间件比对 token 里的 ver 与数据库当前值，不一致即 401，
--   从而让所有已签发的旧 token 立即失效 —— 实现「重置密码后退出所有设备登录」。
-- ============================================================
ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0;
