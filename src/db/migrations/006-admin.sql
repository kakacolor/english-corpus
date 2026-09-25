-- 后台管理（/admin）所需的两个字段
-- is_admin=1 的账号才能登录后台管理页；用 node src/db/make-admin.js <用户名> 授权。
-- last_login_at：登录时记录（登录接口里尽力更新，失败不影响登录），后台列表里展示。
ALTER TABLE users
  ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否管理员：1=可登录后台管理页' AFTER password_hash,
  ADD COLUMN last_login_at DATETIME NULL COMMENT '最后登录时间（UTC）' AFTER is_admin;
