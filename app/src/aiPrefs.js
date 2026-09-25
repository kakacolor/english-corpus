import storage from './storage';

/**
 * 文本 AI 调用偏好（设置 → 文本AI 中配置，补全 / 词形归并共用）：
 *  - batch    每轮单词数：每次 AI 请求处理的单词个数（补全默认 10；调小更不容易超时）
 *  - timeoutS 单次超时秒数：单次 AI 请求最多等待多少秒（默认 120）
 *  - noThink  关闭深度思考：请求里附带各家接口的「关思考」参数，思考型模型可快数倍（默认开）
 * 存本机 AsyncStorage，不占数据库。
 */
const KEY = 'english_corpus_ai_prefs';

const DEFAULTS = { batch: 10, timeoutS: 120, noThink: true };

function clampInt(v, min, max, dflt) {
  const n = parseInt(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function getAiPrefs() {
  try {
    const raw = await storage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const o = JSON.parse(raw);
    return {
      batch: clampInt(o.batch, 1, 50, DEFAULTS.batch),
      timeoutS: clampInt(o.timeoutS, 10, 600, DEFAULTS.timeoutS),
      noThink: o.noThink === undefined ? DEFAULTS.noThink : !!o.noThink,
    };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

export async function saveAiPrefs(prefs) {
  const merged = {
    batch: clampInt(prefs.batch, 1, 50, DEFAULTS.batch),
    timeoutS: clampInt(prefs.timeoutS, 10, 600, DEFAULTS.timeoutS),
    noThink: !!prefs.noThink,
  };
  try {
    await storage.setItem(KEY, JSON.stringify(merged));
  } catch (e) { /* ignore */ }
  return merged;
}

/**
 * 前端 fetch 超时：给足「按每轮词数分批、每批都等到超时上限」的余量，
 * 按最多 50 批 + 30 秒缓冲封顶（30 分钟）。
 */
export function enrichFetchTimeoutMs(totalLimit, prefs) {
  const batches = Math.ceil(totalLimit / prefs.batch);
  return Math.min(30 * 60000, prefs.timeoutS * 1000 * Math.min(batches, 50) + 30000);
}
