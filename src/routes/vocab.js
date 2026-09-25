const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

router.use(authRequired);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024 },
});

/** 判断错误是否为唯一键冲突（(user_id, word) 已存在） */
function isDuplicateEntry(err) {
  return !!err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);
}

/**
 * 词性与词形变化字段（全部可空）。
 * 背单词显示答案时按词性展示：动词→三单/过去式/过去分词/ing；名词→复数；形容词副词→比较级/最高级。
 * 集中定义，避免在新增/编辑/导入/导出/列表里各处手写列名导致不一致。
 */
const FORM_FIELDS = [
  'pos',               // 词性：n. / v. / adj. / adv. ...
  'third_person',      // 动词第三人称单数
  'past_tense',        // 动词过去式
  'past_participle',   // 动词过去分词
  'ing_form',          // 动词现在分词
  'plural',            // 名词复数
  'comparative',       // 比较级
  'superlative',       // 最高级
];

/** 从请求体取词形字段：字符串去空白，空串归一为 null；未提供该键则保留 fallback */
function pickForms(body, fallback) {
  const out = {};
  for (const f of FORM_FIELDS) {
    if (body && body[f] !== undefined) {
      const v = String(body[f] == null ? '' : body[f]).trim();
      out[f] = v || null;
    } else {
      out[f] = fallback ? (fallback[f] ?? null) : null;
    }
  }
  return out;
}

/** 词形字段列表（用于 SELECT） */
const FORM_SELECT = FORM_FIELDS.join(', ');

/**
 * Excel 导入单词本
 * Excel 包含列（列名需包含这些关键字即可，不区分大小写）：
 *   - 单词 / word
 *   - 本次积累的中文意思 / user_meaning / my_meaning
 *   - 词典中的中文意思 / dict_meaning / dictionary
 * 可选：音标/phonetic、例句/example、备注/note、词性/pos、
 *       三单/过去式/过去分词/ing、复数、比较级、最高级 等词形变化列
 */
router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未上传文件' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const headers = rows.length ? Object.keys(rows[0]) : [];
    const pick = (keys) => {
      const lower = headers.map((h) => String(h).toLowerCase());
      for (const k of keys) {
        const idx = lower.indexOf(k.toLowerCase());
        if (idx >= 0) return headers[idx];
      }
      return null;
    };
    const colWord = pick(['word', '单词']);
    const colUser = pick(['user_meaning', 'my_meaning', '本次积累', '本次积累的中文意思']);
    const colDict = pick(['dict_meaning', 'dictionary', '词典', '词典的中文意思', '词典中的中文意思', '字典']);
    const colPhonetic = pick(['phonetic', '音标']);
    const colExample = pick(['example', '例句']);
    const colNote = pick(['note', '备注', '批注']);
    // 词性 / 词形变化列（可选，缺列就留空）
    const formCols = {
      pos: pick(['pos', 'pos.', '词性', 'part of speech']),
      third_person: pick(['third_person', 'third person', '三单', '第三人称单数']),
      past_tense: pick(['past_tense', 'past tense', 'v-ed', '过去式']),
      past_participle: pick(['past_participle', 'past participle', 'v-en', '过去分词']),
      ing_form: pick(['ing_form', 'ing form', 'present participle', '现在分词', 'ing形式', 'ing 形式']),
      plural: pick(['plural', '复数', '复数形式']),
      comparative: pick(['comparative', '比较级']),
      superlative: pick(['superlative', '最高级']),
    };

    if (!colWord || !colUser) {
      return res.status(400).json({
        error: 'Excel 必须包含「单词」和「本次积累的中文意思」两列',
      });
    }

    let skipped = 0; // 因缺单词或缺意思而被跳过的行数
    let emptyRows = 0; // 整行为空的无效行
    const userId = req.user.id;

    const valueCols = ['user_id', 'word', 'user_meaning', 'dict_meaning', 'phonetic', 'example', 'note']
      .concat(FORM_FIELDS)
      .concat(['source']);

    const values = [];
    for (const r of rows) {
      const word = String(r[colWord] || '').trim();
      const userMeaning = String(r[colUser] || '').trim();
      // 整行基本为空（可能是多余空行）——直接忽略，不计入 skipped
      if (!word && !userMeaning && (!colDict || !String(r[colDict] || '').trim())) {
        emptyRows++;
        continue;
      }
      if (!word || !userMeaning) { skipped++; continue; }
      const cell = (col) => (col ? String(r[col] || '').trim() || null : null);
      const forms = {};
      for (const f of FORM_FIELDS) forms[f] = cell(formCols[f]);

      values.push([
        userId, word, userMeaning, cell(colDict), cell(colPhonetic), cell(colExample), cell(colNote),
        ...FORM_FIELDS.map((f) => forms[f]),
        'excel',
      ]);
    }

    // 可选：跳过已积累的单词（表单 skip_existing=1/true），默认仍为覆盖更新
    const skipExisting = ['1', 'true', 'yes', 'on'].includes(
      String((req.body && req.body.skip_existing) || '').toLowerCase()
    );

    let insertedCount = 0;
    let existingCount = 0;
    if (values.length) {
      const colsSql = valueCols.join(', ');
      // 普通字段直接覆盖；词形字段用 COALESCE：Excel 没有该列/单元格为空时不清掉已有值
      const updateSql = ['user_meaning', 'dict_meaning', 'phonetic', 'example', 'note']
        .map((c) => `${c}=VALUES(${c})`)
        .concat(FORM_FIELDS.map((c) => `${c}=COALESCE(VALUES(${c}), ${c})`))
        .concat(['updated_at=CURRENT_TIMESTAMP'])
        .join(', ');

      if (skipExisting) {
        // INSERT IGNORE：命中 uk_user_word 的行被忽略，affectedRows 只统计真正插入的行
        const [r] = await req.db.query(
          `INSERT IGNORE INTO vocab_entries (${colsSql}) VALUES ?`,
          [values]
        );
        insertedCount = r.affectedRows;
        existingCount = values.length - insertedCount;
      } else {
        // 用 ON DUPLICATE KEY UPDATE 保证同用户同单词只保留一条并覆盖
        await req.db.query(
          `INSERT INTO vocab_entries (${colsSql}) VALUES ? ON DUPLICATE KEY UPDATE ${updateSql}`,
          [values]
        );
        insertedCount = values.length;
      }

      // 让每个新/更新的单词立即进入复习队列（艾宾浩斯调度，无需等待 20 分钟）
      const { ensureReviewSchedule } = require('./review');
      for (const row of values) {
        const [[v]] = await req.db.query(
          'SELECT id FROM vocab_entries WHERE user_id=? AND word=?',
          [row[0], row[1]]
        );
        if (v) await ensureReviewSchedule(req.db, row[0], v.id);
      }
    }

    // inserted = 真正入库的行数；existing_skipped = 因已积累而跳过的行数
    res.json({
      inserted: insertedCount,
      skipped,
      existing_skipped: existingCount,
      empty_rows: emptyRows,
      total_rows: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

// 列出单词本（分页）
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, parseInt(req.query.pageSize) || 20);
    const search = req.query.search ? `%${req.query.search}%` : null;
    const userId = req.user.id;

    let where = 'user_id = ?';
    const params = [userId];
    if (search) { where += ' AND word LIKE ?'; params.push(search); }

    const [rows] = await req.db.query(
      `SELECT id, word, ${FORM_SELECT}, user_meaning, dict_meaning, phonetic, example, note, source, created_at, updated_at
       FROM vocab_entries WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const [[{ total }]] = await req.db.query(
      `SELECT COUNT(*) total FROM vocab_entries WHERE ${where}`, params
    );

    res.json({ list: rows, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// 新增单条
// body.if_exists: 'overwrite'（默认，覆盖已有记录，保持旧行为）| 'skip'（已积累则自动跳过，不改原记录）
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { word, user_meaning, dict_meaning, phonetic, example, note } = body;
    const ifExists = String(body.if_exists || 'overwrite').toLowerCase();
    if (!word || !user_meaning) return res.status(400).json({ error: '单词和本次意思必填' });
    if (ifExists !== 'overwrite' && ifExists !== 'skip') {
      return res.status(400).json({ error: 'if_exists 只能是 overwrite 或 skip' });
    }

    const w = String(word).trim();
    const forms = pickForms(body, null);
    const cols = ['user_id', 'word', 'user_meaning', 'dict_meaning', 'phonetic', 'example', 'note']
      .concat(FORM_FIELDS)
      .concat(["source"]);
    const params = [req.user.id, String(word).trim(), user_meaning, dict_meaning || null, phonetic || null, example || null, note || null]
      .concat(FORM_FIELDS.map((f) => forms[f]))
      .concat(['manual']);
    const placeholders = cols.map(() => '?').join(', ');
    const insertSql = `INSERT${ifExists === 'skip' ? ' IGNORE' : ''} INTO vocab_entries (${cols.join(', ')}) VALUES (${placeholders})`;

    let v = null;
    if (ifExists === 'skip') {
      // 纯 INSERT IGNORE：命中唯一键说明已积累，直接跳过且不改动原记录
      const [r] = await req.db.query(insertSql, params);
      if (r.affectedRows === 0) {
        const [[cur]] = await req.db.query(
          'SELECT id FROM vocab_entries WHERE user_id=? AND word=?',
          [req.user.id, w]
        );
        return res.json({ skipped: true, id: cur ? cur.id : null, word: w, message: '该单词已积累，已自动跳过' });
      }
      v = { id: r.insertId };
    } else {
      // 新增表单默认空白，词形字段用 COALESCE：本次没填就保留原有值，
      // 要主动清空请到「编辑」里把该字段删掉再保存。
      const updateSql = ['user_meaning', 'dict_meaning', 'phonetic', 'example', 'note']
        .map((c) => `${c}=VALUES(${c})`)
        .concat(FORM_FIELDS.map((c) => `${c}=COALESCE(VALUES(${c}), ${c})`))
        .concat(['updated_at=CURRENT_TIMESTAMP'])
        .join(', ');
      await req.db.query(
        `INSERT INTO vocab_entries (${cols.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateSql}`,
        params
      );
      const [[f]] = await req.db.query(
        'SELECT id FROM vocab_entries WHERE user_id=? AND word=?',
        [req.user.id, w]
      );
      v = f;
    }

    // 让新单词进入复习队列（ensureReviewSchedule 对已存在的不重置进度）
    if (v) {
      const { ensureReviewSchedule } = require('./review');
      await ensureReviewSchedule(req.db, req.user.id, v.id);
    }
    res.json({ id: v ? v.id : null, word: w, skipped: false });
  } catch (err) { next(err); }
});

// 编辑单词（可改单词本身与各字段；不允许改成该用户已积累的其它单词）
router.put('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const { word, user_meaning, dict_meaning, phonetic, example, note } = body;

    const [[cur]] = await req.db.query(
      `SELECT id, word, user_meaning, ${FORM_SELECT} FROM vocab_entries WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    if (!cur) return res.status(404).json({ error: '记录不存在' });

    const nextWord = word == null ? cur.word : String(word).trim();
    const nextMeaning = user_meaning == null ? cur.user_meaning : String(user_meaning).trim();
    if (!nextWord) return res.status(400).json({ error: '单词不能为空' });
    if (!nextMeaning) return res.status(400).json({ error: '本次积累的中文意思不能为空' });

    const sets = [];
    const params = [];
    const wordChanged = nextWord !== cur.word;
    if (wordChanged) { sets.push('word=?'); params.push(nextWord); }
    if (user_meaning != null) { sets.push('user_meaning=?'); params.push(nextMeaning); }
    if (dict_meaning != null) { sets.push('dict_meaning=?'); params.push(dict_meaning || null); }
    if (phonetic != null) { sets.push('phonetic=?'); params.push(phonetic || null); }
    if (example != null) { sets.push('example=?'); params.push(example || null); }
    if (note != null) { sets.push('note=?'); params.push(note || null); }
    // 词形字段：传了才改（空串=清空该变化形式），不传则保持原值
    for (const f of FORM_FIELDS) {
      if (body[f] !== undefined) {
        const val = String(body[f] == null ? '' : body[f]).trim();
        sets.push(`${f}=?`);
        params.push(val || null);
      }
    }
    if (!sets.length) return res.json({ ok: true, id: Number(id), word: cur.word, message: '没有需要更新的字段' });

    params.push(id, req.user.id);
    try {
      await req.db.query(
        `UPDATE vocab_entries SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`,
        params
      );
    } catch (err) {
      if (isDuplicateEntry(err)) {
        return res.status(409).json({ error: `单词「${nextWord}」已经在单词本中，不能重复` });
      }
      throw err;
    }
    res.json({ ok: true, id: Number(id), word: nextWord, word_changed: wordChanged });
  } catch (err) { next(err); }
});

// 重复单词检测（只读预览，供设置页「去除重复」按钮先展示数量）
router.get('/duplicates', async (req, res, next) => {
  try {
    const [rows] = await req.db.query(
      `SELECT word, COUNT(*) AS copies
       FROM vocab_entries
       WHERE user_id = ?
       GROUP BY word
       HAVING copies > 1
       ORDER BY copies DESC, word ASC`,
      [req.user.id]
    );
    const redundant = rows.reduce((sum, r) => sum + (Number(r.copies) - 1), 0);
    res.json({
      duplicate_words: rows.length,      // 有多少个单词存在重复
      redundant_rows: redundant,         // 可以安全删除的多余记录条数
      samples: rows.slice(0, 20).map((r) => ({ word: r.word, copies: Number(r.copies) })),
    });
  } catch (err) { next(err); }
});

// ==================== 去重与词形归并 ====================
// 两层去重：
//  1) 完全重复：同一 (user_id, word) 多条 → 保留最新（原有逻辑）
//  2) 词形重复：childs/children 与 child 属同一词根 → 合并为原型 child，
//     被合并的词写进原型记录的对应词形字段（背单词显示答案时会展示）。
// 词根识别两种模式：规则模式（免费、快速、只认把握大的形态）；
// 大模型模式（用「文本AI」精确判定每个单词的原型与变化类型，更准，需配置文本AI、有少量费用）。

/** 常见不规则词形 → { lemma, form }（规则模式内置表，宁缺勿误） */
const IRREGULAR = (() => {
  const m = {};
  const add = (inf, lemma, form) => { m[inf] = { lemma, form }; };
  // be 动词
  ['am', 'is', 'are'].forEach((w) => add(w, 'be', 's'));
  ['was', 'were'].forEach((w) => add(w, 'be', 'past_tense'));
  add('been', 'be', 'past_participle'); add('being', 'be', 'ing_form');
  // 不规则名词复数
  const nouns = [['children', 'child'], ['men', 'man'], ['women', 'woman'], ['teeth', 'tooth'],
    ['feet', 'foot'], ['geese', 'goose'], ['mice', 'mouse'], ['people', 'person'], ['oxen', 'ox'],
    ['leaves', 'leaf'], ['knives', 'knife'], ['wives', 'wife'], ['wolves', 'wolf'], ['lives', 'life'],
    ['shelves', 'shelf'], ['calves', 'calf'], ['halves', 'half'], ['thieves', 'thief'], ['pianos', 'piano']];
  nouns.forEach(([i, l]) => add(i, l, 'plural'));
  // 常用不规则动词（inf, lemma, 过去式, 过去分词）
  const verbs = [
    ['went', 'go', 'past_tense'], ['gone', 'go', 'past_participle'], ['goes', 'go', 'third_person'], ['going', 'go', 'ing_form'],
    ['took', 'take', 'past_tense'], ['taken', 'take', 'past_participle'],
    ['saw', 'see', 'past_tense'], ['seen', 'see', 'past_participle'],
    ['came', 'come', 'past_tense'], ['comes', 'come', 'third_person'], ['coming', 'come', 'ing_form'],
    ['did', 'do', 'past_tense'], ['done', 'do', 'past_participle'], ['does', 'do', 'third_person'], ['doing', 'do', 'ing_form'],
    ['said', 'say', 'past_tense'], ['says', 'say', 'third_person'],
    ['got', 'get', 'past_tense'], ['gotten', 'get', 'past_participle'], ['gets', 'get', 'third_person'], ['getting', 'get', 'ing_form'],
    ['made', 'make', 'past_tense'], ['makes', 'make', 'third_person'], ['making', 'make', 'ing_form'],
    ['knew', 'know', 'past_tense'], ['known', 'know', 'past_participle'],
    ['thought', 'think', 'past_tense'], ['gave', 'give', 'past_tense'], ['given', 'give', 'past_participle'],
    ['found', 'find', 'past_tense'], ['told', 'tell', 'past_tense'], ['became', 'become', 'past_tense'],
    ['began', 'begin', 'past_tense'], ['begun', 'begin', 'past_participle'],
    ['drank', 'drink', 'past_tense'], ['drunk', 'drink', 'past_participle'],
    ['swam', 'swim', 'past_tense'], ['swum', 'swim', 'past_participle'], ['ran', 'run', 'past_tense'],
    ['sang', 'sing', 'past_tense'], ['sung', 'sing', 'past_participle'],
    ['bought', 'buy', 'past_tense'], ['brought', 'bring', 'past_tense'], ['taught', 'teach', 'past_tense'],
    ['caught', 'catch', 'past_tense'], ['built', 'build', 'past_tense'], ['felt', 'feel', 'past_tense'],
    ['left', 'leave', 'past_tense'], ['kept', 'keep', 'past_tense'], ['slept', 'sleep', 'past_tense'],
    ['meant', 'mean', 'past_tense'], ['met', 'meet', 'past_tense'], ['paid', 'pay', 'past_tense'],
    ['wore', 'wear', 'past_tense'], ['worn', 'wear', 'past_participle'],
    ['wrote', 'write', 'past_tense'], ['written', 'write', 'past_participle'],
    ['drove', 'drive', 'past_tense'], ['driven', 'drive', 'past_participle'],
    ['chose', 'choose', 'past_tense'], ['chosen', 'choose', 'past_participle'],
    ['spoke', 'speak', 'past_tense'], ['spoken', 'speak', 'past_participle'],
    ['broke', 'break', 'past_tense'], ['broken', 'break', 'past_participle'],
    ['woke', 'wake', 'past_tense'], ['woken', 'wake', 'past_participle'],
    ['fell', 'fall', 'past_tense'], ['fallen', 'fall', 'past_participle'],
    ['ate', 'eat', 'past_tense'], ['eaten', 'eat', 'past_participle'],
    ['forgot', 'forget', 'past_tense'], ['forgiven', 'forgive', 'past_participle'],
    ['hid', 'hide', 'past_tense'], ['hidden', 'hide', 'past_participle'],
    ['rode', 'ride', 'past_tense'], ['ridden', 'ride', 'past_participle'],
    ['won', 'win', 'past_tense'], ['held', 'hold', 'past_tense'], ['sent', 'send', 'past_tense'],
    ['spent', 'spend', 'past_tense'], ['lost', 'lose', 'past_tense'], ['sat', 'sit', 'past_tense'],
    ['stood', 'stand', 'past_tense'], ['understood', 'understand', 'past_tense'],
    ['sold', 'sell', 'past_tense'], ['swept', 'sweep', 'past_tense'],
    ['flew', 'fly', 'past_tense'], ['flown', 'fly', 'past_participle'], ['flying', 'fly', 'ing_form'],
    ['grew', 'grow', 'past_tense'], ['grown', 'grow', 'past_participle'],
    ['threw', 'throw', 'past_tense'], ['thrown', 'throw', 'past_participle'],
    ['drew', 'draw', 'past_tense'], ['drawn', 'draw', 'past_participle'],
    ['blew', 'blow', 'past_tense'], ['blown', 'blow', 'past_participle'],
    ['stole', 'steal', 'past_tense'], ['stolen', 'steal', 'past_participle'],
    ['bit', 'bite', 'past_tense'], ['bitten', 'bite', 'past_participle'],
    ['froze', 'freeze', 'past_tense'], ['frozen', 'freeze', 'past_participle'],
    ['shook', 'shake', 'past_tense'], ['shaken', 'shake', 'past_participle'],
    // 比较级/最高级不规则
    ['better', 'good', 'comparative'], ['best', 'good', 'superlative'],
    ['worse', 'bad', 'comparative'], ['worst', 'bad', 'superlative'],
    ['more', 'much', 'comparative'], ['most', 'much', 'superlative'],
    ['less', 'little', 'comparative'], ['least', 'little', 'superlative'],
    ['further', 'far', 'comparative'], ['furthest', 'far', 'superlative'],
  ];
  verbs.forEach(([i, l, f]) => add(i, l, f));
  return m;
})();

/**
 * 规则模式：生成某单词的「可能原型」候选列表（按可能性排序）+ 各候选的变化类型。
 * 调用方按顺序取「第一个在单词本中存在的候选」做合并；都不存在就不合并（宁缺勿误）。
 * 例：shoes→[sho, shoe]（去掉s还原e的变体也覆盖）；packed→[packe, pack]（去双写变体）。
 */
function ruleLemmaCandidates(w0) {
  const w = String(w0).toLowerCase();
  const ir = IRREGULAR[w];
  if (ir) return [{ lemma: ir.lemma, form: ir.form }];
  if (!/^[a-z]+$/.test(w)) return []; // 带连字符/空格/符号的复合词不做规则推断
  const V = 'aeiou';
  const isV = (ch) => V.includes(ch);
  const out = [];
  const push = (list, form) => {
    for (const c of (Array.isArray(list) ? list : [list])) {
      if (c && c !== w) out.push({ lemma: c, form });
    }
  };
  if (w.length > 4 && w.endsWith('ies')) push([w.slice(0, -3) + 'y', w.slice(0, -3)], 's');
  else if (w.length > 4 && w.endsWith('ves')) push([w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe'], 'plural');
  else if (w.length > 4 && /(ch|sh|ss|x|z)es$/.test(w)) push(w.slice(0, -2), 's');
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) push([w.slice(0, -1), w.slice(0, -2)], 's');
  else if (w.length > 4 && w.endsWith('ied')) push(w.slice(0, -3) + 'y', 'ed');
  else if (w.length > 5 && w.endsWith('ed')) {
    const outs = [w.slice(0, -2), w.slice(0, -1)];
    if (safeIdx(w, -3) === safeIdx(w, -4) && !isV(safeIdx(w, -3))) outs.push(w.slice(0, -3));
    push(outs, 'ed');
  } else if (w.length >= 6 && w.endsWith('ing')) {
    const outs = [w.slice(0, -3), w.slice(0, -3) + 'e'];
    if (safeIdx(w, -4) === safeIdx(w, -5) && !isV(safeIdx(w, -4))) outs.push(w.slice(0, -4));
    push(outs, 'ing_form');
  } else if (w.length > 6 && w.endsWith('ier')) {
    // happi+er→happy；仅当 -ier 前是双写辅音（happ|ier）才接受裸候选，防 frontier→front 误合
    const outs = [w.slice(0, -3) + 'y', w.slice(0, -3) + 'e'];
    if (safeIdx(w, -4) === safeIdx(w, -5) && !isV(safeIdx(w, -4))) outs.push(w.slice(0, -3));
    push(outs, 'comparative');
  } else if (w.length > 6 && w.endsWith('iest')) {
    const outs = [w.slice(0, -4) + 'y', w.slice(0, -4) + 'e'];
    if (safeIdx(w, -4) === safeIdx(w, -5) && !isV(safeIdx(w, -4))) outs.push(w.slice(0, -4));
    push(outs, 'superlative');
  } else if (w.length > 5 && w.endsWith('er') && isV(safeIdx(w, -5))
      && safeIdx(w, -3) === safeIdx(w, -4) && !isV(safeIdx(w, -3))) {
    // bigger→big、hotter→hot（辅音双写 + er，去掉「双写辅音+er」共3字符）；不做泛 -er 还原，防 mother→moth 误合
    push(w.slice(0, -3), 'comparative');
  }
  return out;
}
function safeIdx(s, i) { return s[s.length + i] || ''; }

/** form → 词形字段；ed 同时可作过去式/过去分词；s 需按原型词性判断（执行时处理）；base/other 不写字段 */
const FORM_TO_FIELD = {
  third_person: ['third_person'], past_tense: ['past_tense'], past_participle: ['past_participle'],
  ing_form: ['ing_form'], plural: ['plural'], comparative: ['comparative'], superlative: ['superlative'],
  ed: ['past_tense', 'past_participle'], s: ['_by_pos'], base: [], other: [],
};

/**
 * 词形归并扫描（供 /dedupe-scan 与 /dedupe 共用）。
 * useLlm=true 用文本AI判定词根（需已配置文本AI，未配置抛 400）；false 用内置规则。
 * 返回 { exact_groups, exact_redundant, scanned, groups:[{lemma, keep_id, keep_word, members:[{id,word,form}]}] }
 */
/** 从请求体解析大模型调用选项：关闭思考 + 单次超时秒数（与 设置→文本AI 的参数一致） */
function parseLlmOpts(body) {
  const b = body || {};
  return {
    noThink: ['1', 'true', 'yes', 'on'].includes(String(b.no_think || '')),
    timeoutMs: Math.min(600000, Math.max(10000, (parseInt(b.timeout_s) || 120) * 1000)),
  };
}

async function scanLemmaGroups(db, userId, useLlm, opts) {
  const o = opts || {};
  // 1) 完全重复统计
  const [dupRows] = await db.query(
    `SELECT word, COUNT(*) AS copies FROM vocab_entries WHERE user_id = ?
     GROUP BY word HAVING copies > 1`,
    [userId]
  );
  const exactRedundant = dupRows.reduce((s, r) => s + (Number(r.copies) - 1), 0);

  // 2) 取每个 word 的一条代表记录；建 小写词 → 记录 索引
  const [rows] = await db.query(
    `SELECT id, word, pos FROM vocab_entries WHERE user_id = ?
     ORDER BY id DESC LIMIT 2000`,
    [userId]
  );
  const byLower = new Map();
  for (const r of rows) {
    const k = r.word.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, r);
  }

  // 逐词解析：规则模式给候选列表并挑「在单词本里存在」的那个；大模型模式给唯一判定
  const groups = new Map(); // lemma -> { base, members[] }
  const addMember = (lemma, base, rec, form) => {
    if (!groups.has(lemma)) groups.set(lemma, { base, members: [] });
    groups.get(lemma).members.push({ id: rec.id, word: rec.word, form });
  };

  if (useLlm) {
    const { textJson } = require('./ai');
    const words = [...byLower.keys()];
    const lemmaMap = new Map();
    // 词根判定是轻量分类任务，默认每块 120 词；用户在设置里调小了「每轮单词数」则跟随调小
    const CHUNK = parseInt(o.batch) > 0
      ? Math.min(120, Math.max(1, parseInt(o.batch)))
      : 120;
    const system =
      '你是英语形态学专家。给定一组英语单词，判断每个单词的词典原型(lemma)和它相对原形的变化形式。' +
      '只输出 JSON 数组，格式 [{"w":"原单词小写","lemma":"原形小写","form":"base|third_person|past_tense|past_participle|ing_form|plural|comparative|superlative|other"}]。' +
      '规则：单词本身就是原形时 form=base；不规则变化（went→go、children→child 等）必须给出正确原形；' +
      '无法确定原形时 form=other 且 lemma 填该单词本身；每个输入单词都要有一条输出。';
    for (let i = 0; i < words.length; i += CHUNK) {
      const chunk = words.slice(i, i + CHUNK);
      const items = await textJson(db, userId, {
        system,
        user: `单词列表：${JSON.stringify(chunk)}`,
        timeoutMs: o.timeoutMs || 120000,
        noThink: !!o.noThink,
      });
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || !it.w) continue;
        const w = String(it.w).trim().toLowerCase();
        const lemma = String(it.lemma || w).trim().toLowerCase();
        let form = String(it.form || 'other').trim().toLowerCase();
        if (!(form in FORM_TO_FIELD)) form = 'other';
        if (w && lemma) lemmaMap.set(w, { lemma, form });
      }
    }
    for (const [k, rec] of byLower) {
      const info = lemmaMap.get(k);
      if (!info || info.lemma === k) continue;
      const base = byLower.get(info.lemma);
      if (!base) continue; // 原形不在单词本，不合并（避免误删）
      addMember(info.lemma, base, rec, info.form);
    }
  } else {
    for (const [k, rec] of byLower) {
      const cands = ruleLemmaCandidates(k);
      // 按候选顺序取第一个「确实存在于单词本」的原形
      for (const c of cands) {
        if (c.lemma === k) continue;
        const base = byLower.get(c.lemma);
        if (!base) continue;
        addMember(c.lemma, base, rec, c.form);
        break;
      }
    }
  }

  const out = [...groups.entries()].map(([lemma, g]) => ({
    lemma,
    keep_id: g.base.id,
    keep_word: g.base.word,
    members: g.members,
  }));

  return {
    scanned: byLower.size,
    exact_groups: dupRows.length,
    exact_redundant: exactRedundant,
    groups: out,
  };
}

/**
 * 词形归并分组扫描（只读预览）。
 * body: { use_llm?: 0|1 }  use_llm=1 用文本AI判定词根；0/缺省用内置规则。
 * 返回 exact_*（完全重复统计）与 groups（词形归并候选组，含保留目标与每条的变化类型）。
 */
router.post('/dedupe-scan', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const useLlm = ['1', 'true', 'yes', 'on'].includes(String((req.body || {}).use_llm || ''));
    const scan = await scanLemmaGroups(req.db, userId, useLlm, parseLlmOpts(req.body));
    res.json({
      use_llm: useLlm,
      scanned: scan.scanned,
      exact_groups: scan.exact_groups,
      exact_redundant: scan.exact_redundant,
      lemma_groups: scan.groups.length,
      lemma_rows: scan.groups.reduce((s, g) => s + g.members.length, 0),
      groups: scan.groups.slice(0, 50),
      more: scan.groups.length > 50 ? scan.groups.length - 50 : 0,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * 执行去重 + 词形归并。
 * body: { use_llm?: 0|1 }（默认 0 规则模式；1 需已配置文本AI）
 * 步骤：先合并完全重复（保留最新）→ 再按词形分组执行：
 *   保留原型记录，把每个被并单词写入其空缺的词形字段（不覆盖已有内容），然后删除被并记录。
 *   每组内任何失败只跳过该组，不丢数据（先写字段、后删除）。
 */
router.post('/dedupe', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const useLlm = ['1', 'true', 'yes', 'on'].includes(String((req.body || {}).use_llm || ''));
    const scan = await scanLemmaGroups(req.db, userId, useLlm, parseLlmOpts(req.body));

    // 1) 完全重复：每个 word 保留 id 最大
    let exactRemoved = 0;
    if (scan.exact_groups > 0) {
      const [result] = await req.db.query(
        `DELETE v FROM vocab_entries v
         JOIN (
           SELECT word, MAX(id) AS keep_id
           FROM vocab_entries WHERE user_id = ?
           GROUP BY word HAVING COUNT(*) > 1
         ) d ON v.word = d.word AND v.id <> d.keep_id
         WHERE v.user_id = ?`,
        [userId, userId]
      );
      exactRemoved = result.affectedRows;
    }

    // 2) 词形归并
    let mergedGroups = 0;
    let formsWritten = 0;
    let removedRows = 0;
    const unplaced = [];
    const { ensureReviewSchedule } = require('./review');

    for (const g of scan.groups) {
      try {
        // 完全重复刚清过，这里重新取该组最新状态
        const ids = g.members.map((m) => m.id);
        const placeholders = ids.map(() => '?').join(',');
        const [[keep]] = await req.db.query(
          `SELECT id, word, ${FORM_SELECT} FROM vocab_entries
           WHERE user_id = ? AND LOWER(word) = ? ORDER BY id DESC LIMIT 1`,
          [userId, g.lemma]
        );
        if (!keep) continue;
        const [members] = await req.db.query(
          `SELECT id, word FROM vocab_entries WHERE user_id = ? AND id IN (${placeholders}) AND id <> ?`,
          [userId, ...ids, keep.id]
        );
        if (!members.length) continue;

        // 先写词形字段（仅写空缺字段），再删除；无法安全归位的词保留不动
        const sets = [];
        const params = [];
        const toDelete = [];
        for (const m of members) {
          const info = g.members.find((x) => x.id === m.id) || { form: 'other' };
          let fields = FORM_TO_FIELD[info.form] || [];
          if (fields.includes('_by_pos')) {
            // 规则模式只知道是 -s 变化：按原型词性判断是三单还是复数；判不出就不动这条记录
            const p = (keep.pos || '').toLowerCase();
            fields = p.includes('v') ? ['third_person'] : p.includes('n') ? ['plural'] : [];
          }
          if (!fields.length) continue; // other/base/判不出词性 → 不合并也不删（保数据优先）
          for (const f of fields) {
            if (!f || f === '_by_pos' || keep[f]) continue; // 已有值不覆盖
            keep[f] = m.word; // 防止同组两个成员抢同一字段
            sets.push(`${f}=?`);
            params.push(m.word);
            formsWritten++;
          }
          toDelete.push(m.id); // 词形信息已入库（或该字段本就有值）才删除
        }
        if (!toDelete.length) continue;
        if (sets.length) {
          params.push(keep.id, userId);
          await req.db.query(
            `UPDATE vocab_entries SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`,
            params
          );
        }
        const delPh = toDelete.map(() => '?').join(',');
        const [del] = await req.db.query(
          `DELETE FROM vocab_entries WHERE user_id = ? AND id IN (${delPh})`,
          [userId, ...toDelete]
        );
        removedRows += del.affectedRows;
        await ensureReviewSchedule(req.db, userId, keep.id);
        mergedGroups++;
      } catch (e) {
        unplaced.push({ lemma: g.lemma, error: e.message });
      }
    }

    const msg = [];
    if (exactRemoved) msg.push(`删除完全重复 ${exactRemoved} 条`);
    if (mergedGroups) msg.push(`词形归并 ${mergedGroups} 组（写入词形 ${formsWritten} 处，删除被并词 ${removedRows} 条）`);
    res.json({
      ok: true,
      exact_removed: exactRemoved,
      merged_groups: mergedGroups,
      forms_written: formsWritten,
      removed: removedRows,
      failed: unplaced,
      message: msg.length ? `已处理：${msg.join('；')}` : '没有发现需要去重或归并的单词',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// 删除
router.delete('/:id', async (req, res, next) => {
  try {
    const [result] = await req.db.query(
      'DELETE FROM vocab_entries WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: '记录不存在' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 导出当前用户单词本为 Excel
router.get('/export', async (req, res, next) => {
  try {
    const [rows] = await req.db.query(
      `SELECT word, ${FORM_SELECT}, user_meaning, dict_meaning, phonetic, example, note
       FROM vocab_entries WHERE user_id = ?`,
      [req.user.id]
    );
    const data = rows.map((r) => ({
      单词: r.word,
      词性: r.pos || '',
      '本次积累的中文意思': r.user_meaning,
      '词典中的中文意思': r.dict_meaning || '',
      音标: r.phonetic || '',
      三单: r.third_person || '',
      过去式: r.past_tense || '',
      过去分词: r.past_participle || '',
      'ing形式': r.ing_form || '',
      复数: r.plural || '',
      比较级: r.comparative || '',
      最高级: r.superlative || '',
      例句: r.example || '',
      备注: r.note || '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '单词本');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="vocabulary.xlsx"');
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = router;
