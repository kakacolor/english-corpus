const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

router.use(authRequired);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024 },
});

/**
 * AI 密钥的加密存储
 * 使用服务器端密钥 (AI_KEY_ENC_SECRET) 对 api_key 做 AES-256-GCM 加密，数据库中不存明文 Key。
 * .env 需配置 AI_KEY_ENC_SECRET，可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成。
 */
const encSecret = () => {
  const s = process.env.AI_KEY_ENC_SECRET;
  if (!s) throw Object.assign(new Error('服务器未配置 AI_KEY_ENC_SECRET，无法安全保存 AI Key'), { status: 500 });
  return Buffer.from(s, 'hex');
};
function encryptKey(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encSecret(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}
function decryptKey(packed) {
  const [ivB, tagB, encB] = packed.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encSecret(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

// 保存/更新用户的 AI 配置（OpenAI 兼容接口）
router.post('/config', async (req, res, next) => {
  try {
    const { base_url, api_key, model } = req.body || {};
    if (!base_url || !api_key) return res.status(400).json({ error: 'base_url 和 api_key 必填' });
    const encrypted = encryptKey(String(api_key));
    // 注意：这里刻意不更新 system_prompt（它由 POST /api/ai/prompt 单独维护），
    // 否则保存 API 配置时会把用户已保存的自定义提示词一起清空。
    await req.db.query(
      `INSERT INTO user_ai_config (user_id, base_url, api_key_enc, model) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE base_url=VALUES(base_url), api_key_enc=VALUES(api_key_enc), model=VALUES(model)`,
      [req.user.id, String(base_url), encrypted, String(model || 'gpt-4o')]
    );
    res.json({ ok: true, message: 'AI 配置已保存（Key 已加密存储）' });
  } catch (err) { next(err); }
});

// ——————————————— 文本 AI（属性补全用，与拍照识别的视觉 AI 分开配置） ———————————————

/**
 * 保存/更新文本 AI 配置（只写入 text_* 列，绝不触碰视觉 AI 的 base_url/api_key/model，
 * 反之视觉 AI 的 /config 也不会动 text_*，两边互不覆盖）。
 * api_key 省略或留空时保留已保存的旧 Key；首次配置则必填。
 */
router.post('/text-config', async (req, res, next) => {
  try {
    const { base_url, api_key, model } = req.body || {};
    const [[cur]] = await req.db.query(
      'SELECT id, text_base_url, text_api_key_enc FROM user_ai_config WHERE user_id = ?',
      [req.user.id]
    );

    let enc = cur ? cur.text_api_key_enc : null;
    if (api_key && String(api_key).trim()) enc = encryptKey(String(api_key).trim());
    if (!enc) return res.status(400).json({ error: '请填写文本 AI 的 API Key' });

    const bu = base_url && String(base_url).trim()
      ? String(base_url).trim()
      : (cur ? cur.text_base_url : null);
    if (!bu) return res.status(400).json({ error: '请填写文本 AI 接口地址' });

    // 首次写入时若整行还不存在，先建一行；视觉 AI 三列以空串占位（NOT NULL），
    // 之后视觉 AI 保存自己的 /config 时会用 ON DUPLICATE UPDATE 填上真实值。
    await req.db.query(
      `INSERT INTO user_ai_config (user_id, base_url, api_key_enc, model, text_base_url, text_api_key_enc, text_model)
       VALUES (?, '', '', '', ?, ?, ?)
       ON DUPLICATE KEY UPDATE text_base_url=VALUES(text_base_url), text_api_key_enc=VALUES(text_api_key_enc), text_model=VALUES(text_model)`,
      [req.user.id, bu, enc, String(model || 'gpt-4o-mini')]
    );
    res.json({ ok: true, message: '文本 AI 配置已保存（Key 已加密存储）' });
  } catch (err) { next(err); }
});

// 读取用户 AI 配置（视觉 + 文本，均不回传 Key）
router.get('/config', async (req, res, next) => {
  try {
    const [rows] = await req.db.query(
      'SELECT base_url, model, system_prompt, updated_at, text_base_url, text_model FROM user_ai_config WHERE user_id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.json({ configured: false, text_configured: false });
    const r = rows[0];
    res.json({
      configured: Boolean(r.base_url),
      base_url: r.base_url,
      model: r.model,
      system_prompt: r.system_prompt,
      updated_at: r.updated_at,
      text_configured: Boolean(r.text_base_url),
      text_base_url: r.text_base_url || '',
      text_model: r.text_model || '',
    });
  } catch (err) { next(err); }
});

/**
 * 拍照识别：
 *  - 上传图片（base64 或原始文件）
 *  - 调用 OpenAI 兼容接口 (multimodal)，识别图中被红笔圈出的单词，
 *    返回该单词的「本次积累的中文意思（图上标注的）」和「词典中文意思」
 *  - 逐词 upsert 进单词本，返回生成数据（可直接用于生成 Excel）
 */
router.post('/recognize', upload.single('image'), async (req, res, next) => {
  try {
    // 从上传文件或 body.base64 取图
    let imageData = null;
    if (req.file) {
      imageData = req.file.buffer.toString('base64');
    } else if (req.body && req.body.base64) {
      imageData = String(req.body.base64).replace(/^data:image\/\w+;base64,/, '');
    } else {
      return res.status(400).json({ error: '请上传要识别的照片' });
    }

    const [cfgRows] = await req.db.query('SELECT base_url, api_key_enc, model, system_prompt FROM user_ai_config WHERE user_id = ?', [req.user.id]);
    const cfg = cfgRows[0];
    // 注意：只配置了「文本 AI」时这一行也存在但视觉三列是空占位，必须单独判空
    if (!cfg || !cfg.base_url || !cfg.api_key_enc || !cfg.model) {
      return res.status(400).json({ error: '请先在 设置 → 视觉AI 中配置拍照识词的接口地址、API Key 和模型' });
    }

    // 优先使用用户在设置页自定义的识别提示词；未填写时回退到内置默认提示词
    const defaultSystemPrompt =
      '你是英语语料识别助手。我会给你一张照片，图中用户用红色笔/红框圈出需要积累的英语单词，' +
      '并在单词上方用手写标注了"本次积累的中文意思"。请识别所有被圈出的单词。' +
      '只输出 JSON 数组，不要多余文字，格式：' +
      '[{"word":"单词","annotated_meaning":"用户手写标注的本次积累中文意思（若没有标注则填空字符串）","dict_meaning":"这个词标准词典的中文释义"}]。';
    const basePrompt = (cfg.system_prompt && String(cfg.system_prompt).trim())
      ? String(cfg.system_prompt).trim()
      : defaultSystemPrompt;

    // 词形变化附加说明：默认提示词和用户自定义提示词都追加，让识别顺带补全词性与词形变化，
    // 供背单词点击显示答案后额外展示。用户自定义提示词里没写这些字段时也能拿到数据。
    const formsInstruction =
      ' 此外，请为每个单词补充以下字段：pos(词性，如 n./v./adj./adv.)、third_person(动词第三人称单数)、' +
      'past_tense(过去式)、past_participle(过去分词)、ing_form(现在分词)、plural(名词复数)、' +
      'comparative(比较级)、superlative(最高级)。' +
      '该词不适用的字段填空字符串，不要编造；不规则变化必须给出正确形式。';
    const systemPrompt = `${basePrompt}${formsInstruction}`;

    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请识别图片中被红笔圈出的所有单词。' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageData}` } },
          ],
        },
      ],
    };

    const key = decryptKey(cfg.api_key_enc);
    const base = String(cfg.base_url).replace(/\/$/, '');
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: `AI 接口调用失败(${resp.status}): ${text.slice(0, 300)}` });
    }

    const data = await resp.json();
    const content = String(data.choices?.[0]?.message?.content || '');
    // 从 AI 返回内容中抽取 JSON 数组（兼容被 ```json ``` 代码围栏包裹的情况）
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\[[\s\S]*\]/);
    if (!match) throw Object.assign(new Error('AI 未返回有效 JSON'), { status: 502 });
    let items;
    try {
      items = JSON.parse(match[1] ?? match[0]);
    } catch (e) {
      throw Object.assign(new Error(`AI 返回的 JSON 无法解析: ${match[0].slice(0, 200)}`), { status: 502 });
    }
    if (!Array.isArray(items)) throw Object.assign(new Error('AI 未返回 JSON 数组'), { status: 502 });

    // 逐词写入单词本（重复则覆盖）
    let inserted = 0;
    let skippedEmpty = 0;
    const { ensureReviewSchedule } = require('./review');

    // 词形变化字段：AI 没给或给了空串一律存 null，
    // 配合下面 COALESCE(VALUES(col), col) 保证「AI 没识别出来」时不会清掉用户手工填过的值。
    const FORM_COLS = ['pos', 'third_person', 'past_tense', 'past_participle', 'ing_form', 'plural', 'comparative', 'superlative'];
    const formVal = (it, key) => {
      const raw = it && it[key];
      const v = raw == null ? '' : String(raw).trim();
      return v || null;
    };

    for (const it of items) {
      const word = String((it && it.word) || '').trim();
      if (!word) { skippedEmpty++; continue; }
      const forms = FORM_COLS.map((k) => formVal(it, k));

      const cols = ['user_id', 'word', 'user_meaning', 'dict_meaning', 'source'].concat(FORM_COLS);
      const placeholders = cols.map(() => '?').join(', ');
      // source 位于第 5 位，词形字段追加其后
      const params = [req.user.id, word, String((it && it.annotated_meaning) || '').trim(), String((it && it.dict_meaning) || '').trim(), 'camera'].concat(forms);
      const updates = FORM_COLS.map((c) => `${c}=COALESCE(VALUES(${c}), ${c})`).join(', ');

      const [result] = await req.db.query(
        `INSERT INTO vocab_entries (${cols.join(', ')})
         VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE user_meaning=VALUES(user_meaning), dict_meaning=VALUES(dict_meaning),
           ${updates}, updated_at=CURRENT_TIMESTAMP`,
        params
      );
      // 让识别出的单词立即进入复习队列
      let entryId = result.insertId;
      if (!entryId) {
        const [[v]] = await req.db.query(
          'SELECT id FROM vocab_entries WHERE user_id=? AND word=?',
          [req.user.id, word]
        );
        entryId = v ? v.id : null;
      }
      if (entryId) await ensureReviewSchedule(req.db, req.user.id, entryId);
      inserted++;
    }

    res.json({ items, inserted, skipped_empty: skippedEmpty });
  } catch (err) { next(err); }
});

/**
 * 单独保存「拍照识别提示词」：只更新 system_prompt，不触碰 base_url / api_key / model。
 * （避免前端在未回填 API Key 时误覆盖已加密保存的真实 Key。）
 * 传空 / 纯空白 = 清空自定义，识别时回退内置默认提示词。
 */
router.post('/prompt', async (req, res, next) => {
  try {
    const sp = req.body && req.body.system_prompt;
    const prompt = (sp == null ? null : String(sp).trim()) || null;
    // 先确认配置行存在：MySQL 在「值未变化」时 affectedRows 也是 0，不能拿它判断是否存在
    const [rows] = await req.db.query('SELECT id FROM user_ai_config WHERE user_id = ?', [req.user.id]);
    if (!rows.length) {
      return res.status(400).json({ error: '请先在「API 设置」中保存 AI 接口地址和 Key，再设置识别提示词' });
    }
    await req.db.query('UPDATE user_ai_config SET system_prompt = ? WHERE user_id = ?', [prompt, req.user.id]);
    res.json({ ok: true, message: prompt ? '识别提示词已保存' : '已清空自定义提示词，将使用内置默认' });
  } catch (err) { next(err); }
});

// ——————————————— 属性补全（用文本 AI 批量补例句 / 词性 / 词形变化） ———————————————

const ENRICH_FORM_COLS = ['pos', 'third_person', 'past_tense', 'past_participle', 'ing_form', 'plural', 'comparative', 'superlative'];

/**
 * 「关闭深度思考」的多种请求体写法（各家 OpenAI 兼容接口写法不同），按顺序尝试：
 * 某写法被接口 400 拒绝时自动降级下一种，并记住该接口可用的写法（进程内）。
 * 全部被拒则退化为普通请求（仍然可用，只是慢）。
 */
const THINK_OFF_STYLES = [
  { thinking: { type: 'disabled' }, enable_thinking: false }, // DeepSeek / Kimi / 智谱 / 火山方舟
  { reasoning_effort: 'minimal' },                            // OpenAI o 系 / 部分网关（reasoning.effort 族）
  { enable_thinking: false },                                 // 通义千问 Qwen / DashScope 简写
];

/** 记住每个接口（base|model）已验证可用的关思考写法下标；-1 = 全部被拒，直接用普通请求 */
const thinkStyleState = new Map();

function wrapFetchError(err, timeoutMs) {
  const isTimeout = /timeout|abort/i.test(String((err && err.message) || ''));
  return Object.assign(
    new Error(`文本 AI 请求失败: ${isTimeout
      ? `单次请求超过 ${Math.round(timeoutMs / 1000)} 秒已中断（可在 设置→文本AI 调小「每轮单词数」或调大「单次超时」）`
      : err.message}`),
    { status: 502, timeout: isTimeout }
  );
}

/**
 * 发一次 chat/completions 请求（noThink 时按 THINK_OFF_STYLES 自适应降级），返回解析后的 JSON。
 * 错误统一为带 .status=502 的 Error，超时信息带引导文案。
 */
async function callTextChat(cfg, key, { messages, temperature = 0.2, timeoutMs = 90000, noThink = false }) {
  const base = String(cfg.base_url || cfg.text_base_url).replace(/\/+$/, '');
  const model = cfg.model || cfg.text_model;
  const skey = `${base}|${model}`;
  // 候选写法：按顺序尝试，最后追加 null（不带任何关思考参数的普通请求）兜底
  let styles = THINK_OFF_STYLES.slice().concat([null]);
  if (noThink) {
    const st = thinkStyleState.get(skey);
    if (st === -1) styles = [null];
    else if (st > 0) styles = THINK_OFF_STYLES.slice(st).concat([null]);
  } else {
    styles = [null];
  }
  let lastErr;
  for (let i = 0; i < styles.length; i++) {
    const body = { model, messages, temperature, stream: false };
    if (styles[i]) Object.assign(body, styles[i]);
    let resp;
    try {
      resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw wrapFetchError(err, timeoutMs); // 网络/超时错误与参数写法无关，直接抛
    }
    if (resp.ok) {
      if (noThink) {
        const chosen = styles[i] ? THINK_OFF_STYLES.indexOf(styles[i]) : -1;
        if (thinkStyleState.get(skey) !== chosen) thinkStyleState.set(skey, chosen);
      }
      return await resp.json().catch(() => ({}));
    }
    const text = await resp.text().catch(() => '');
    lastErr = Object.assign(new Error(`文本 AI 接口返回 ${resp.status}: ${text.slice(0, 220)}`), { status: 502 });
    // 仅当开着「关思考」且接口以 4xx 拒绝时才降级重试（多半是不认识该参数）
    if (!noThink || resp.status < 400 || resp.status >= 500) break;
    thinkStyleState.set(skey, styles[i + 1] ? THINK_OFF_STYLES.indexOf(styles[i + 1]) : -1);
  }
  throw lastErr || Object.assign(new Error('文本 AI 请求失败'), { status: 502 });
}

/** 读取并校验文本 AI 配置；未配置时抛出带引导信息的 400 */
/** 读取文本 AI 配置；未配置时返回 null（供想软检查的调用方，如去重扫描） */
async function getTextConfig(db, userId) {
  const [rows] = await db.query(
    'SELECT text_base_url, text_api_key_enc, text_model FROM user_ai_config WHERE user_id = ?',
    [userId]
  );
  const c = rows[0];
  if (!c || !c.text_base_url || !c.text_api_key_enc || !c.text_model) return null;
  return c;
}

/** 读取并校验文本 AI 配置；未配置时抛出带引导信息的 400 */
async function requireTextConfig(db, userId) {
  const c = await getTextConfig(db, userId);
  if (!c) {
    throw Object.assign(new Error('请先在 设置 → 文本AI 中配置接口地址、API Key 和模型'), { status: 400 });
  }
  return c;
}

/**
 * 用用户已配置的文本 AI 发一次对话并解析出 JSON（其它路由复用的唯一出口，
 * 密钥解密等细节都留在本文件内）。返回解析结果（数组或对象）。
 * 未配置文本 AI 时抛 400（带引导信息）。
 */
async function textJson(db, userId, { system, user, temperature = 0.1, timeoutMs = 90000, noThink = false }) {
  const cfg = await requireTextConfig(db, userId);
  const key = decryptKey(cfg.text_api_key_enc);
  const data = await callTextChat(cfg, key, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    timeoutMs,
    noThink,
  });
  const content = String(data.choices?.[0]?.message?.content || '');
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : (content.match(/[[{][\s\S]*[\]}]/) || [''])[0];
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`文本 AI 返回的 JSON 无法解析: ${content.slice(0, 160)}`), { status: 502 });
  }
}

// 缺属性的单词统计（只读，供设置页/单词本页展示「可补全 N 个」）
router.get('/enrich/missing', async (req, res, next) => {
  try {
    const [[row]] = await req.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(example IS NULL OR example = '') AS no_example,
         SUM(pos IS NULL AND third_person IS NULL AND past_tense IS NULL
             AND past_participle IS NULL AND ing_form IS NULL AND plural IS NULL
             AND comparative IS NULL AND superlative IS NULL) AS no_forms
       FROM vocab_entries WHERE user_id = ?`,
      [req.user.id]
    );
    res.json({
      total: Number(row.total) || 0,
      no_example: Number(row.no_example) || 0,
      no_forms: Number(row.no_forms) || 0,
    });
  } catch (err) { next(err); }
});

/**
 * 用文本 AI 批量补全单词属性。
 * body: {
 *   limit?: 本次最多处理多少个单词(默认50,上限500),
 *   batch?: 每轮(每次AI调用)处理多少个单词(默认10,上限50),
 *   timeout_s?: 单次AI请求超时秒数(默认120,范围10-600),
 *   no_think?: 1=请求关闭深度思考(更快,兼容各家写法)
 * }
 * 规则：只写入 AI 返回且数据库里为空的字段（COALESCE），绝不覆盖已有内容；
 *      分批调用，任何一批失败即停止并返回已完成的数量。
 */
router.post('/enrich', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const body = req.body || {};
    const cfg = await requireTextConfig(req.db, userId);
    const limit = Math.min(500, Math.max(1, parseInt(body.limit) || 50));
    const BATCH = Math.min(50, Math.max(1, parseInt(body.batch) || 10));
    const timeoutMs = Math.min(600000, Math.max(10000, (parseInt(body.timeout_s) || 120) * 1000));
    const noThink = ['1', 'true', 'yes', 'on'].includes(String(body.no_think || ''));

    // 只挑「缺例句 或 完全没有任何词形变化」的单词
    const [rows] = await req.db.query(
      `SELECT id, word, user_meaning, dict_meaning, example, pos
       FROM vocab_entries
       WHERE user_id = ?
         AND (example IS NULL OR example = ''
              OR (pos IS NULL AND third_person IS NULL AND past_tense IS NULL
                  AND past_participle IS NULL AND ing_form IS NULL AND plural IS NULL
                  AND comparative IS NULL AND superlative IS NULL))
       ORDER BY updated_at ASC
       LIMIT ?`,
      [userId, limit]
    );
    if (!rows.length) {
      return res.json({ checked: 0, updated: 0, message: '所有单词都已有例句和词形变化，无需补全' });
    }

    const key = decryptKey(cfg.text_api_key_enc);
    const base = String(cfg.text_base_url).replace(/\/+$/, '');
    const systemPrompt =
      '你是英语词典数据助手。给定若干单词及其汉语意思，为每个单词补全学习属性。' +
      '只输出 JSON 数组，不要任何其他文字，每个元素格式：' +
      '{"word":"原单词","pos":"词性(n./v./adj./adv.等)","example":"地道英文例句(含该词,12-25词)",' +
      '"example_cn":"例句的中文翻译","third_person":"三单","past_tense":"过去式","past_participle":"过去分词",' +
      '"ing_form":"ing形式","plural":"复数","comparative":"比较级","superlative":"最高级"}。' +
      '规则：不适用的字段填空字符串；不规则变化必须正确；拿不准的字段留空，不要编造；word 必须原样返回。';

    let updated = 0;
    let checked = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const wordList = chunk.map((r) => ({
        word: r.word,
        meaning: r.user_meaning || r.dict_meaning || '',
      }));
      let data;
      try {
        data = await callTextChat({ base_url: base, model: cfg.text_model }, key, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `请补全这些单词（JSON）：${JSON.stringify(wordList)}` },
          ],
          temperature: 0.2,
          timeoutMs,
          noThink,
        });
      } catch (err) {
        // 保留进度上下文：补全失败信息里带上已完成数量
        err.message = `${err.message}（已补全 ${updated} 个）`;
        throw err;
      }
      const content = String(data.choices?.[0]?.message?.content || '');
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\[[\s\S]*\]/);
      if (!match) {
        throw Object.assign(new Error(`文本 AI 未返回有效 JSON（已补全 ${updated} 个）`), { status: 502 });
      }
      let items;
      try {
        items = JSON.parse(match[1] ?? match[0]);
      } catch (e) {
        throw Object.assign(new Error(`文本 AI JSON 无法解析（已补全 ${updated} 个）`), { status: 502 });
      }
      if (!Array.isArray(items)) continue;
      checked += chunk.length;

      const byWord = new Map(items.map((it) => [String((it && it.word) || '').trim().toLowerCase(), it]));
      for (const r of chunk) {
        const it = byWord.get(r.word.toLowerCase());
        if (!it) continue;
        const val = (k) => {
          const v = it[k] == null ? '' : String(it[k]).trim();
          return v || null;
        };
        const example = val('example') ? `${val('example')}${val('example_cn') ? `  —  ${val('example_cn')}` : ''}` : null;
        const sets = [];
        const params = [];
        if (!r.example && example) { sets.push('example=?'); params.push(example); }
        for (const c of ENRICH_FORM_COLS) {
          const v = val(c);
          if (v) { sets.push(`${c}=?`); params.push(v); }
        }
        if (!sets.length) continue;
        params.push(r.id, userId);
        await req.db.query(
          `UPDATE vocab_entries SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`,
          params
        );
        updated++;
      }
    }

    res.json({
      checked,
      updated,
      message: `已检查 ${checked} 个单词，补全了 ${updated} 个的属性`,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * 测试 AI 配置：用已保存的 base_url + api_key + model 发一个最小请求，
 * 验证接口地址、密钥和模型是否可用（不需要图片）。
 * 请求体可选覆盖 { base_url, api_key, model }；不传则用已保存的配置。
 * target: 'vision'（默认，视觉 AI）| 'text'（文本 AI），两套配置互不影响。
 */
router.post('/test', async (req, res, next) => {
  try {
    const body = req.body || {};
    const target = body.target === 'text' ? 'text' : 'vision';
    let baseUrl = String(body.base_url || '').trim();
    let key = body.api_key ? String(body.api_key).trim() : null;
    let model = String(body.model || '').trim();

    // 未传则读已保存的配置（不回传明文 Key）
    if (!baseUrl || !key || !model) {
      const [cfgRows] = await req.db.query(
        target === 'text'
          ? 'SELECT text_base_url AS base_url, text_api_key_enc AS api_key_enc, text_model AS model FROM user_ai_config WHERE user_id = ?'
          : 'SELECT base_url, api_key_enc, model FROM user_ai_config WHERE user_id = ?',
        [req.user.id]
      );
      if (cfgRows.length) {
        const cfg = cfgRows[0];
        baseUrl = baseUrl || cfg.base_url;
        if (!key && cfg.api_key_enc) {
          try { key = decryptKey(cfg.api_key_enc); } catch (e) { /* 密文损坏则当作未配置 */ }
        }
        model = model || cfg.model;
      }
    }

    if (!baseUrl || !key || !model) {
      return res.status(400).json({ ok: false, error: '未配置 AI 接口地址/Key/模型，请先在设置中保存' });
    }

    const base = baseUrl.replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    const startedAt = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1, // 最小请求，避免消耗太多费用
        stream: false,
      }),
    });
    const elapsedMs = Date.now() - startedAt;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return res.status(502).json({
        ok: false,
        error: `接口返回 HTTP ${resp.status}`,
        detail: text.slice(0, 300),
        latency_ms: elapsedMs,
      });
    }

    const data = await resp.json().catch(() => null);
    if (!data || !Array.isArray(data.choices) || !data.choices.length) {
      return res.status(502).json({ ok: false, error: '接口响应格式异常，未包含 choices', latency_ms: elapsedMs });
    }

    res.json({
      ok: true,
      message: '连接成功，API 配置可用',
      model: data.model || model,
      latency_ms: elapsedMs,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `请求失败: ${err.message}`,
    });
  }
});

module.exports = router;
// 供其它路由（vocab 去重/归并）复用的文本 AI 工具
module.exports.getTextConfig = getTextConfig;
module.exports.textJson = textJson;