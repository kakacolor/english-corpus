const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { authRequired, JWT_SECRET } = require('../middleware/auth');

/**
 * 密码安全策略：
 *  - 使用 bcryptjs，加盐成本因子 cost=12（强度高，抗暴力破解）
 *  - 数据库只存哈希 (password_hash)，绝不明文
 *  - bcrypt 自带盐，相同密码生成不同哈希
 */
const BCRYPT_COST = 12;

/** 签发 JWT：带上 token_version，便于重置密码后统一失效旧 token */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, ver: Number(user.token_version || 0) },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码必填' });
    }
    if (String(username).length < 3) {
      return res.status(400).json({ error: '用户名至少 3 个字符' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: '密码至少 8 位，建议包含字母数字和符号' });
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_COST);

    const [result] = await req.db.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [String(username), email || null, passwordHash]
    );

    const userId = result.insertId;
    // 新用户 token_version 默认 0
    const token = signToken({ id: userId, username: String(username), token_version: 0 });

    res.status(201).json({ token, user: { id: userId, username: String(username), email: email || null } });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '用户名或邮箱已被占用' });
    }
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { account, password } = req.body || {};
    if (!account || !password) {
      return res.status(400).json({ error: '账号和密码必填' });
    }

    // 支持用用户名或邮箱登录
    const [rows] = await req.db.query(
      'SELECT id, username, email, password_hash, token_version FROM users WHERE username = ? OR email = ? LIMIT 1',
      [String(account), String(account)]
    );

    if (rows.length === 0) {
      // 统一错误信息，避免泄露账号是否存在
      return res.status(401).json({ error: '账号或密码错误' });
    }
    const user = rows[0];

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: '账号或密码错误' });
    }

    // 记录最后登录时间（后台管理页会展示；字段缺失或写入失败都不影响登录）
    try {
      await req.db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    } catch (e) { /* ignore */ }

    const token = signToken(user);

    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    next(err);
  }
});

// 获取当前登录用户信息
router.get('/me', authRequired, async (req, res, next) => {
  try {
    const [rows] = await req.db.query(
      'SELECT id, username, email, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * 重置密码（需登录，校验当前密码）
 * 成功后 token_version 自增 → 该账号所有设备上已签发的 token 立即失效，
 * 包括发起本次重置的设备本身，需用新密码重新登录。
 */
router.post('/change-password', authRequired, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: '请填写当前密码和新密码' });
    }
    if (String(new_password).length < 8) {
      return res.status(400).json({ error: '新密码至少 8 位，建议包含字母数字和符号' });
    }
    if (String(new_password) === String(current_password)) {
      return res.status(400).json({ error: '新密码不能与当前密码相同' });
    }

    const [rows] = await req.db.query(
      'SELECT id, password_hash FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });

    const ok = await bcrypt.compare(String(current_password), rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: '当前密码不正确' });

    const passwordHash = await bcrypt.hash(String(new_password), BCRYPT_COST);
    // token_version + 1：让所有旧 token（含当前设备）立即失效
    await req.db.query(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      [passwordHash, req.user.id]
    );

    res.json({
      ok: true,
      message: '密码已重置，所有设备已退出登录，请用新密码重新登录',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
