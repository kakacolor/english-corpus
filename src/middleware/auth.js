const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

/**
 * JWT 认证中间件
 * 验证 Authorization: Bearer <token>，并把 userId / username 挂到 req.user
 *
 * 除验签外，还比对 token 内的 ver 与数据库 users.token_version：
 * 用户重置密码时 token_version 自增，旧 token 的 ver 不再匹配 → 401，
 * 由此让该账号在所有设备上立即退出登录。
 */
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  try {
    const [rows] = await req.db.query(
      'SELECT id, username, token_version FROM users WHERE id = ? LIMIT 1',
      [decoded.sub]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: '用户不存在，请重新登录' });
    }
    const user = rows[0];
    // 兼容升级前签发的旧 token（无 ver 字段）：按 0 处理，
    // 因此旧 token 在用户重置密码之前仍然有效，重置后立即失效。
    const tokenVer = Number(decoded.ver || 0);
    const currentVer = Number(user.token_version || 0);
    if (tokenVer !== currentVer) {
      return res.status(401).json({ error: '密码已重置，请重新登录' });
    }
    req.user = { id: user.id, username: user.username, token_version: currentVer };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authRequired, JWT_SECRET };
