const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

/**
 * 管理员鉴权中间件（后台管理页 /admin 用）
 *  - 复用普通登录的 JWT（Authorization: Bearer <token>）
 *  - 但每次都回库检查 is_admin，撤销管理员权限后立即失效（token 未过期也进不去）
 *  - 通过后把管理员信息挂到 req.admin
 */
async function adminRequired(req, res, next) {
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
      'SELECT id, username, email, is_admin FROM users WHERE id = ? LIMIT 1',
      [decoded.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ error: '账号不存在或已被删除' });
    }
    if (!Number(rows[0].is_admin)) {
      return res.status(403).json({ error: '该账号没有后台管理权限' });
    }
    req.admin = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { adminRequired };
