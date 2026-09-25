const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

router.use(authRequired);

/**
 * 艾宾浩斯遗忘曲线复习间隔（分钟）：
 * 经典记忆点：20分钟, 1小时, 9小时, 1天, 2天, 6天, 15天, 30天
 * stage 0 = 初次学习；每正确复习一次 stage+1，进入下一档间隔。
 */
const EB_SPACING_MIN = [20, 60, 9 * 60, 24 * 60, 2 * 24 * 60, 6 * 24 * 60, 15 * 24 * 60, 30 * 24 * 60];
const MAX_STAGE = EB_SPACING_MIN.length;

// 新学一个词时初始化复习计划：立即加入复习队列（无需等待 20 分钟）
async function ensureReviewSchedule(db, userId, entryId) {
  await db.query(
    `INSERT INTO review_schedule (user_id, entry_id, stage, next_review_at)
     VALUES (?, ?, 0, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE next_review_at=next_review_at`,
    [userId, entryId]
  );
}

// 拉取今日待复习单词（到达 next_review_at 的）
router.get('/today', async (req, res, next) => {
  try {
    const [rows] = await req.db.query(
      `SELECT v.id, v.word, v.pos, v.third_person, v.past_tense, v.past_participle, v.ing_form,
              v.plural, v.comparative, v.superlative,
              v.user_meaning, v.dict_meaning, v.phonetic, v.example,
              r.stage, r.strength, r.next_review_at
       FROM review_schedule r JOIN vocab_entries v ON v.id = r.entry_id
       WHERE r.user_id = ? AND r.next_review_at <= UTC_TIMESTAMP()
       ORDER BY r.next_review_at ASC LIMIT 50`,
      [req.user.id]
    );
    res.json({ list: rows, eb_spacing_min: EB_SPACING_MIN });
  } catch (err) { next(err); }
});

// 提交一次复习结果
router.post('/submit', async (req, res, next) => {
  try {
    const { entry_id, remembered } = req.body || {};
    const userId = req.user.id;
    if (!entry_id) return res.status(400).json({ error: '缺少 entry_id' });
    const isRemembered = Boolean(remembered);

    const [rows] = await req.db.query(
      'SELECT stage, review_count, strength FROM review_schedule WHERE user_id = ? AND entry_id = ?',
      [userId, entry_id]
    );
    if (!rows.length) return res.status(404).json({ error: '该单词不在复习计划中' });

    let stage = rows[0].stage;
    // 从当前记忆强度出发调整，而不是每次从 0.5 开始
    let strength = Number(rows[0].strength) || 0.5;

    if (isRemembered) {
      // 记住：进入下一间隔档位
      stage = Math.min(stage + 1, MAX_STAGE);
      // 越到后面的档位每次加得越少，逼近上限 1
      strength = Math.min(1, strength + 0.08 + 0.02 * (stage / MAX_STAGE));
    } else {
      // 忘记：回到第 1 档（20 分钟后）重新记忆
      stage = 0;
      strength = Math.max(0, strength - 0.2);
    }
    const nextMinutes = EB_SPACING_MIN[stage] || 20;
    const status = stage >= MAX_STAGE ? 1 : 0;

    await req.db.query(
      `UPDATE review_schedule
       SET stage=?, next_review_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE),
           last_review_at=UTC_TIMESTAMP(), review_count=review_count+1, strength=?, status=?
       WHERE user_id=? AND entry_id=?`,
      [stage, nextMinutes, strength, status, userId, entry_id]
    );

    res.json({ ok: true, just_passed: status === 1, next_in_minutes: nextMinutes, stage });
  } catch (err) { next(err); }
});

// 注册新词到复习计划（在单词新增时由 app 调用，或前端显式调用）
router.post('/register', async (req, res, next) => {
  try {
    const { entry_id } = req.body || {};
    if (!entry_id) return res.status(400).json({ error: '缺少 entry_id' });
    const [v] = await req.db.query('SELECT id FROM vocab_entries WHERE id=? AND user_id=?', [entry_id, req.user.id]);
    if (!v.length) return res.status(404).json({ error: '单词不存在' });
    await ensureReviewSchedule(req.db, req.user.id, entry_id);
    res.json({ ok: true, next_in_minutes: 0 });
  } catch (err) { next(err); }
});

// 备份/查看所有 word 并确保各自都在复习计划中（导入后批量调用）
router.post('/ensure-all', async (req, res, next) => {
  try {
    const [entries] = await req.db.query('SELECT id FROM vocab_entries WHERE user_id=?', [req.user.id]);
    for (const e of entries) {
      await ensureReviewSchedule(req.db, req.user.id, e.id);
    }
    res.json({ ok: true, total: entries.length });
  } catch (err) { next(err); }
});

// 复习统计：今日/累计/掌握情况（背单词页展示）
router.get('/stats', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [[today]] = await req.db.query(
      `SELECT COUNT(*) AS learned_today
       FROM review_schedule
       WHERE user_id = ? AND DATE(last_review_at) = DATE(UTC_TIMESTAMP())`,
      [userId]
    );
    const [[words]] = await req.db.query(
      'SELECT COUNT(*) AS total FROM vocab_entries WHERE user_id = ?',
      [userId]
    );
    const [[inPlan]] = await req.db.query(
      'SELECT COUNT(*) AS in_plan FROM review_schedule WHERE user_id = ?',
      [userId]
    );
    const [[mastered]] = await req.db.query(
      'SELECT COUNT(*) AS mastered FROM review_schedule WHERE user_id = ? AND status = 1',
      [userId]
    );
    const [[dueNow]] = await req.db.query(
      'SELECT COUNT(*) AS due_now FROM review_schedule WHERE user_id = ? AND status = 0 AND next_review_at <= UTC_TIMESTAMP()',
      [userId]
    );
    const [[avgStrength]] = await req.db.query(
      'SELECT COALESCE(AVG(strength), 0) AS avg_strength FROM review_schedule WHERE user_id = ? AND status = 0',
      [userId]
    );

    res.json({
      words_total: words.total,
      in_plan: inPlan.in_plan,
      learned_today: today.learned_today,
      mastered: mastered.mastered,
      due_now: dueNow.due_now,
      avg_strength: Math.round(Number(avgStrength.avg_strength) * 100) / 100,
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.ensureReviewSchedule = ensureReviewSchedule;