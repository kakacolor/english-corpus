const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { JWT_SECRET } = require('../middleware/auth');
const { adminRequired } = require('../middleware/adminAuth');

/**
 * 后台管理接口（挂在 /api/admin）
 *  - 登录：POST /login（必须是 is_admin=1 的账号）
 *  - 之后所有接口都需要管理员 token（adminRequired 每次回库校验）
 *  - 用户数据：列表 / 详情 / 新增 / 批量新增 / 重置密码 / 删除 / 批量删除 / 管理员授权
 * 密码一律 bcrypt(cost=12) 哈希后入库，绝不明文保存。
 */
const BCRYPT_COST = 12;
const MIN_USERNAME = 3;
const MAX_USERNAME = 64;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 100;
const MAX_BATCH = 200;

/** 生成随机密码：剔除 0/O/o/1/l/I 等易混淆字符 */
function genPassword(len = 10) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function validateUsername(username) {
  const u = String(username == null ? '' : username).trim();
  if (!u) return '用户名必填';
  if (u.length < MIN_USERNAME) return `用户名至少 ${MIN_USERNAME} 个字符`;
  if (u.length > MAX_USERNAME) return `用户名最长 ${MAX_USERNAME} 个字符`;
  if (/\s/.test(u)) return '用户名不能包含空格';
  return null;
}

function validatePassword(password) {
  const p = String(password == null ? '' : password);
  if (p.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (p.length > MAX_PASSWORD) return `密码最长 ${MAX_PASSWORD} 位`;
  return null;
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 排序字段白名单（防 SQL 注入：只允许这些列名拼进 ORDER BY） */
const ORDER_COLS = {
  id: 'u.id',
  username: 'u.username',
  created_at: 'u.created_at',
  last_login_at: 'u.last_login_at',
  word_count: 'word_count',
  review_count: 'review_count',
};

// ————————————————— 登录 —————————————————

router.post('/login', async (req, res, next) => {
  try {
    const { account, password } = req.body || {};
    if (!account || !password) {
      return res.status(400).json({ error: '账号和密码必填' });
    }
    const [rows] = await req.db.query(
      'SELECT id, username, email, password_hash, is_admin FROM users WHERE username = ? OR email = ? LIMIT 1',
      [String(account), String(account)]
    );
    if (!rows.length) {
      return res.status(401).json({ error: '账号或密码错误' });
    }
    const u = rows[0];
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) {
      return res.status(401).json({ error: '账号或密码错误' });
    }
    if (!Number(u.is_admin)) {
      return res.status(403).json({ error: '该账号没有后台管理权限' });
    }

    // 记录最后登录时间（尽力而为，失败不影响登录）
    try {
      await req.db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
    } catch (e) { /* ignore */ }

    const token = jwt.sign({ sub: u.id, username: u.username, adm: true }, JWT_SECRET, {
      expiresIn: '12h',
    });
    res.json({ token, user: { id: u.id, username: u.username, email: u.email } });
  } catch (err) {
    next(err);
  }
});

router.get('/me', adminRequired, (req, res) => {
  res.json({
    user: {
      id: req.admin.id,
      username: req.admin.username,
      email: req.admin.email,
      is_admin: true,
    },
  });
});

// ————————————————— 统计 —————————————————

router.get('/stats', adminRequired, async (req, res, next) => {
  try {
    const [[u]] = await req.db.query('SELECT COUNT(*) AS users, SUM(is_admin = 1) AS admins FROM users');
    const [[v]] = await req.db.query('SELECT COUNT(*) AS words FROM vocab_entries');
    const [[r]] = await req.db.query(
      'SELECT COUNT(*) AS reviews, SUM(next_review_at <= NOW()) AS due FROM review_schedule'
    );
    res.json({
      users: Number(u.users || 0),
      admins: Number(u.admins || 0),
      words: Number(v.words || 0),
      reviews: Number(r.reviews || 0),
      due: Number(r.due || 0),
    });
  } catch (err) {
    next(err);
  }
});

// ————————————————— 用户列表 —————————————————

router.get('/users', adminRequired, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const sort = ORDER_COLS[String(req.query.sort || 'id')] || 'u.id';
    const dir = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const where = q ? 'WHERE u.username LIKE ? OR u.email LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`] : [];

    const [[cnt]] = await req.db.query(`SELECT COUNT(*) AS total FROM users u ${where}`, params);

    const [rows] = await req.db.query(
      `SELECT u.id, u.username, u.email, u.created_at, u.last_login_at, u.is_admin,
              COALESCE(v.cnt, 0) AS word_count,
              COALESCE(r.cnt, 0) AS review_count,
              COALESCE(r.due, 0) AS due_count
         FROM users u
         LEFT JOIN (SELECT user_id, COUNT(*) AS cnt FROM vocab_entries GROUP BY user_id) v ON v.user_id = u.id
         LEFT JOIN (SELECT user_id, COUNT(*) AS cnt, SUM(next_review_at <= NOW()) AS due
                      FROM review_schedule GROUP BY user_id) r ON r.user_id = u.id
         ${where}
        ORDER BY ${sort} ${dir}
        LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    res.json({
      total: Number(cnt.total || 0),
      page,
      pageSize,
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        email: r.email,
        created_at: r.created_at,
        last_login_at: r.last_login_at,
        is_admin: Number(r.is_admin) === 1,
        word_count: Number(r.word_count || 0),
        review_count: Number(r.review_count || 0),
        due_count: Number(r.due_count || 0),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** 单个用户详情（含最近 20 个单词，方便核对数据） */
router.get('/users/:id', adminRequired, async (req, res, next) => {
  try {
    const id = toPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: '用户 ID 无效' });

    const [rows] = await req.db.query(
      'SELECT id, username, email, created_at, updated_at, last_login_at, is_admin FROM users WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    const u = rows[0];

    const [[v]] = await req.db.query('SELECT COUNT(*) AS words FROM vocab_entries WHERE user_id = ?', [id]);
    const [[r]] = await req.db.query(
      `SELECT COUNT(*) AS reviews, SUM(status = 1) AS mastered, SUM(next_review_at <= NOW()) AS due
         FROM review_schedule WHERE user_id = ?`,
      [id]
    );
    const [words] = await req.db.query(
      'SELECT id, word, user_meaning, created_at FROM vocab_entries WHERE user_id = ? ORDER BY id DESC LIMIT 20',
      [id]
    );

    res.json({
      user: { ...u, is_admin: Number(u.is_admin) === 1 },
      stats: {
        words: Number(v.words || 0),
        reviews: Number(r.reviews || 0),
        mastered: Number(r.mastered || 0),
        due: Number(r.due || 0),
      },
      words,
    });
  } catch (err) {
    next(err);
  }
});

// ————————————————— 新增用户 —————————————————

router.post('/users', adminRequired, async (req, res, next) => {
  try {
    const { username, password, email } = req.body || {};
    const errU = validateUsername(username);
    if (errU) return res.status(400).json({ error: errU });

    const given = password ? String(password) : '';
    const pw = given || genPassword();
    const errP = validatePassword(pw);
    if (errP) return res.status(400).json({ error: errP });

    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    const [result] = await req.db.query(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [String(username).trim(), email ? String(email).trim() : null, hash]
    );

    res.status(201).json({
      user: { id: result.insertId, username: String(username).trim(), email: email || null },
      password: pw,
      generated: !given,
    });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '用户名或邮箱已被占用' });
    }
    next(err);
  }
});

/** 批量新增：items = [{ username, password?, email? }]，密码留空则自动生成 */
router.post('/users/batch', adminRequired, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '没有要创建的用户' });
    if (items.length > MAX_BATCH) {
      return res.status(400).json({ error: `一次最多创建 ${MAX_BATCH} 个用户` });
    }

    const created = [];
    const failed = [];
    const seen = new Set();

    for (const raw of items) {
      const username = String((raw && raw.username) || '').trim();
      const email = raw && raw.email ? String(raw.email).trim() : null;
      const given = raw && raw.password ? String(raw.password) : '';

      if (!username) {
        failed.push({ username: '', error: '用户名为空' });
        continue;
      }
      if (seen.has(username.toLowerCase())) {
        failed.push({ username, error: '本批次内用户名重复' });
        continue;
      }
      seen.add(username.toLowerCase());

      const errU = validateUsername(username);
      if (errU) {
        failed.push({ username, error: errU });
        continue;
      }
      const pw = given || genPassword();
      const errP = validatePassword(pw);
      if (errP) {
        failed.push({ username, error: errP });
        continue;
      }

      try {
        const hash = await bcrypt.hash(pw, BCRYPT_COST);
        const [result] = await req.db.query(
          'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
          [username, email, hash]
        );
        created.push({
          id: result.insertId,
          username,
          email,
          password: pw,
          generated: !given,
        });
      } catch (err) {
        failed.push({
          username,
          error: err.code === 'ER_DUP_ENTRY' ? '用户名或邮箱已存在' : (err.message || '创建失败'),
        });
      }
    }

    res.json({ total: items.length, created, failed });
  } catch (err) {
    next(err);
  }
});

// ————————————————— 修改密码 —————————————————

/** 重置某用户密码（body.password 留空则随机生成） */
router.put('/users/:id/password', adminRequired, async (req, res, next) => {
  try {
    const id = toPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: '用户 ID 无效' });

    const given = req.body && req.body.password ? String(req.body.password) : '';
    const pw = given || genPassword();
    const errP = validatePassword(pw);
    if (errP) return res.status(400).json({ error: errP });

    const hash = await bcrypt.hash(pw, BCRYPT_COST);
    // 与用户自助重置密码一致：token_version 自增，让该用户在所有设备上立即退出登录
    const [result] = await req.db.query(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      [hash, id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: '用户不存在' });

    res.json({ ok: true, id, password: pw, generated: !given });
  } catch (err) {
    next(err);
  }
});

// ————————————————— 管理员授权 —————————————————

router.put('/users/:id/admin', adminRequired, async (req, res, next) => {
  try {
    const id = toPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: '用户 ID 无效' });

    const v = req.body && req.body.is_admin;
    const makeAdmin = v === 1 || v === true || v === '1';

    if (!makeAdmin) {
      if (id === Number(req.admin.id)) {
        return res.status(400).json({ error: '不能撤销自己的管理员权限' });
      }
      const [[c]] = await req.db.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
      if (Number(c.n) <= 1) {
        return res.status(400).json({ error: '至少要保留一个管理员' });
      }
    }

    const [result] = await req.db.query('UPDATE users SET is_admin = ? WHERE id = ?', [makeAdmin ? 1 : 0, id]);
    if (!result.affectedRows) return res.status(404).json({ error: '用户不存在' });

    res.json({ ok: true, id, is_admin: makeAdmin });
  } catch (err) {
    next(err);
  }
});

// ————————————————— 删除用户 —————————————————

/**
 * 删除一批用户（返回 { deleted, skipped }）。
 * 安全规则：不能删自己；不能删掉最后一个管理员。
 * 清理顺序：先子表后主表（显式删除，任何库结构下都不会留孤儿数据），整体在一个事务里。
 */
async function deleteUsers(db, ids, selfId) {
  const conn = await db.getConnection();
  const deleted = [];
  const skipped = [];
  try {
    await conn.beginTransaction();
    for (const raw of ids) {
      const id = toPositiveInt(raw);
      if (!id) {
        skipped.push({ id: raw, reason: 'ID 无效' });
        continue;
      }
      if (id === Number(selfId)) {
        skipped.push({ id, reason: '不能删除当前登录的管理员自己' });
        continue;
      }

      const [rows] = await conn.query('SELECT id, username, is_admin FROM users WHERE id = ? LIMIT 1', [id]);
      if (!rows.length) {
        skipped.push({ id, reason: '用户不存在' });
        continue;
      }
      const u = rows[0];

      if (Number(u.is_admin)) {
        const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
        if (Number(c.n) <= 1) {
          skipped.push({ id, username: u.username, reason: '至少要保留一个管理员' });
          continue;
        }
      }

      await conn.query('DELETE FROM review_schedule WHERE user_id = ?', [id]);
      await conn.query('DELETE FROM vocab_entries WHERE user_id = ?', [id]);
      await conn.query('DELETE FROM user_ai_config WHERE user_id = ?', [id]);
      await conn.query('DELETE FROM sync_cursors WHERE user_id = ?', [id]);
      await conn.query('DELETE FROM users WHERE id = ?', [id]);

      deleted.push({ id, username: u.username });
    }
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
  return { deleted, skipped };
}

router.delete('/users/:id', adminRequired, async (req, res, next) => {
  try {
    const id = toPositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: '用户 ID 无效' });
    const r = await deleteUsers(req.db, [id], req.admin.id);
    res.json({ ok: true, ...r });
  } catch (err) {
    next(err);
  }
});

router.post('/users/batch-delete', adminRequired, async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const ids = raw.map(toPositiveInt).filter((x) => x);
    if (!ids.length) return res.status(400).json({ error: '没有选择要删除的用户' });
    if (ids.length > MAX_BATCH) {
      return res.status(400).json({ error: `一次最多删除 ${MAX_BATCH} 个用户` });
    }
    const r = await deleteUsers(req.db, ids, req.admin.id);
    res.json({ ok: true, ...r });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.genPassword = genPassword;
module.exports.validateUsername = validateUsername;
module.exports.validatePassword = validatePassword;
module.exports.deleteUsers = deleteUsers;
module.exports.ORDER_COLS = ORDER_COLS;
