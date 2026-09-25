const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

router.use(authRequired);

/**
 * 多端增量同步
 * 客户端用一个自增/时间戳游标，只拉取上次同步之后变化的记录。
 * 这里采用「updated_at > 游标」的时间戳增量方案。
 */

// 拉取自 lastSync 以来的变更（单词本）
// GET /api/sync/pull?last_sync=<ISO>&device_id=xxx
router.get('/pull', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const lastSync = req.query.last_sync ? new Date(req.query.last_sync) : new Date('2000-01-01');
    const deviceId = String(req.query.device_id || 'default');

    const [entries] = await req.db.query(
      `SELECT id, word, user_meaning, dict_meaning, phonetic, example, source,
              pos, third_person, past_tense, past_participle, ing_form, plural, comparative, superlative,
              created_at, updated_at
       FROM vocab_entries
       WHERE user_id=? AND updated_at > ?
       ORDER BY updated_at ASC`,
      [userId, lastSync]
    );

    const [reviews] = await req.db.query(
      `SELECT r.entry_id, r.stage, r.next_review_at, r.last_review_at, r.review_count, r.strength, r.status, r.updated_at
       FROM review_schedule r JOIN vocab_entries v ON v.id=r.entry_id
       WHERE r.user_id=? AND r.updated_at > ?`,
      [userId, lastSync]
    );

    // 记录该设备的同步游标
    await req.db.query(
      `INSERT INTO sync_cursors (user_id, device_id, last_synced_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE last_synced_at=CURRENT_TIMESTAMP`,
      [userId, deviceId]
    );

    const serverNow = new Date().toISOString();
    res.json({
      server_time: serverNow,
      entries,
      reviews,
      has_more: false,
    });
  } catch (err) { next(err); }
});

// 全量拉取（首次同步 / 简单客户端可调用）
router.get('/full', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [entries] = await req.db.query(
      `SELECT id, word, user_meaning, dict_meaning, phonetic, example, source,
              pos, third_person, past_tense, past_participle, ing_form, plural, comparative, superlative,
              created_at, updated_at
       FROM vocab_entries WHERE user_id=? ORDER BY updated_at ASC`,
      [userId]
    );
    const [reviews] = await req.db.query(
      `SELECT r.entry_id, r.stage, r.next_review_at, r.last_review_at, r.review_count, r.strength, r.status
       FROM review_schedule r WHERE r.user_id=?`,
      [userId]
    );
    res.json({ entries, reviews, server_time: new Date().toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;