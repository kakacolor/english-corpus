import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Switch,
} from 'react-native';
import {
  apiFetch, getServerUrlConfig, saveServerUrl, resetServerUrl, pingServer, CAN_CHANGE_SERVER_URL,
} from '../api';
import storage from '../storage';
import { getAiPrefs, saveAiPrefs, enrichFetchTimeoutMs } from '../aiPrefs';
import { useAuth } from '../auth/AuthContext';
import { confirmDialog, notify } from '../utils/dialog';

/** 内置默认识别提示词（与后端 ai.js 中的默认 system prompt 保持一致） */
const defaultPromptText =
  '你是英语语料识别助手。我会给你一张照片，图中用户用红色笔/红框圈出需要积累的英语单词，' +
  '并在单词上方用手写标注了"本次积累的中文意思"。请识别所有被圈出的单词。' +
  '只输出 JSON 数组，不要多余文字，格式：' +
  '[{"word":"单词","annotated_meaning":"用户手写标注的本次积累中文意思（若没有标注则填空字符串）","dict_meaning":"这个词标准词典的中文释义"}]。';

const DEVICE_KEY = 'english_corpus_device_id';
const CURSOR_KEY = 'english_corpus_sync_cursor';
const DEDUPE_LLM_KEY = 'english_corpus_dedupe_use_llm';

function makeDeviceId() {
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 多级菜单结构：设置首页（分组） → 分组内的条目 → 具体设置页 */
const MENU = [
  {
    id: 'ai',
    icon: '🤖',
    title: 'AI 接口',
    desc: '拍照识词、属性补全、识别提示词',
    items: [
      { id: 'api', title: '拍照识词（视觉 AI）', desc: '图片识别用的多模态接口' },
      { id: 'text', title: '文本 AI（属性补全）', desc: '补例句、词性、词形变化' },
      { id: 'prompt', title: '识别提示词', desc: '自定义拍照识别的提示词' },
    ],
  },
  {
    id: 'data',
    icon: '📚',
    title: '单词数据',
    desc: '数据同步、去重与词形归并',
    items: [
      { id: 'sync', title: '数据同步', desc: '与服务器对齐单词和复习进度' },
      { id: 'dedupe', title: '去重与词形归并', desc: '合并重复词与同词根的词形变化' },
    ],
  },
  {
    id: 'app',
    icon: '⚙️',
    title: '应用与账号',
    desc: '服务器地址、密码与当前账号',
    items: [
      { id: 'server', title: '服务器地址', desc: '切换后端地址（手机 App 可改）' },
      { id: 'password', title: '重置密码', desc: '重置后该账号在所有设备退出登录' },
      { id: 'account', title: '账号', desc: '当前账号与退出登录' },
    ],
  },
];

/** 各设置页的标题（显示在返回栏与面包屑上） */
const PAGE_TITLES = {
  api: '拍照识词（视觉 AI）',
  text: '文本 AI（属性补全）',
  prompt: '识别提示词',
  sync: '数据同步',
  dedupe: '去重与词形归并',
  server: '服务器地址',
  password: '重置密码',
  account: '账号',
};

/**
 * 设置页（多级菜单）：
 *  首页分三组：AI 接口 / 单词数据 / 应用与账号；
 *  进入分组后选择具体项，再进入设置页（顶部有「‹ 返回」与面包屑）。
 *  - 拍照识词（视觉 AI）：多模态接口（base_url / Key / 模型），Key 在服务器端加密存储。
 *  - 文本 AI：补全单词属性（例句、词性、词形变化）用的纯文本接口，可与视觉 AI 不同服务商。
 *  - 识别提示词：自定义拍照识别提示词，留空则用内置默认。
 *  - 数据同步：把本机与服务器对齐。
 *  - 去重与词形归并：完全重复合并 + 同词根词形归并。
 *  - 服务器地址：手机 App 可直接切换；Web 端只能在项目根目录 .env 指定。
 *  - 账号：当前账号与退出登录。
 */
export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  // 导航栈：[] = 首页；['ai'] = 分组页；['ai', 'text'] = 具体设置页
  const [nav, setNav] = useState([]);
  const page = nav.length ? nav[nav.length - 1] : null;      // 当前设置页 id（首页/分组页为 null）
  const group = nav.length === 1 ? (MENU.find((g) => g.id === nav[0]) || null) : null;

  // —— AI 接口配置（视觉 / 拍照识词） ——
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // —— 文本 AI 配置（属性补全：例句 / 词形变化） ——
  const [textBaseUrl, setTextBaseUrl] = useState('');
  const [textApiKey, setTextApiKey] = useState('');
  const [textModel, setTextModel] = useState('');
  const [textConfigured, setTextConfigured] = useState(false);
  const [savingText, setSavingText] = useState(false);
  const [testingText, setTestingText] = useState(false);
  const [textTestResult, setTextTestResult] = useState(null);
  // 属性补全状态
  const [missing, setMissing] = useState(null); // { total, no_example, no_forms }
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);
  // 文本AI 调用参数（存本机，补全/词形归并共用）
  const [aiBatchText, setAiBatchText] = useState('10');      // 每轮单词数
  const [aiTimeoutText, setAiTimeoutText] = useState('120'); // 单次超时秒数
  const [aiNoThink, setAiNoThink] = useState(true);          // 关闭深度思考

  // —— 识别提示词 ——
  const [prompt, setPrompt] = useState('');
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // —— 服务器地址 ——
  const [serverUrl, setServerUrl] = useState('');
  const [serverInfo, setServerInfo] = useState(getServerUrlConfig());
  const [savingServer, setSavingServer] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState(null);

  // —— 数据同步 ——
  const [syncing, setSyncing] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [lastInfo, setLastInfo] = useState(null);

  // —— 去除重复（含词形归并） ——
  const [dupInfo, setDupInfo] = useState(null); // /dedupe-scan 的返回
  const [dupLoading, setDupLoading] = useState(false);
  const [deduping, setDeduping] = useState(false);
  const [dedupeUseLlm, setDedupeUseLlm] = useState(false); // 去重时是否用大模型判定词根

  // —— 重置密码 ——
  const [curPassword, setCurPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resettingPwd, setResettingPwd] = useState(false);

  useEffect(() => {
    const info = getServerUrlConfig();
    setServerInfo(info);
    setServerUrl(info.effective);
  }, [nav.length]);

  useEffect(() => {
    (async () => {
      try {
        const resp = await apiFetch('/api/ai/config');
        const data = await resp.json();
        if (data.configured) {
          setBaseUrl(data.base_url);
          setModel(data.model);
          setPrompt(data.system_prompt || '');
          setConfigured(true);
        }
        if (data.text_configured) {
          setTextBaseUrl(data.text_base_url || '');
          setTextModel(data.text_model || '');
          setTextConfigured(true);
        }
      } catch (err) { /* ignore */ } finally {
        setPromptLoaded(true);
      }
    })();
  }, []);

  // 切到「文本AI」页时刷新缺属性统计（只读、很轻量）
  const loadMissing = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/ai/enrich/missing');
      const data = await resp.json();
      if (resp.ok) setMissing(data);
    } catch (err) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (page === 'text') loadMissing();
  }, [page, loadMissing]);

  useEffect(() => {
    (async () => {
      let dev = await storage.getItem(DEVICE_KEY);
      if (!dev) {
        dev = makeDeviceId();
        await storage.setItem(DEVICE_KEY, dev);
      }
      setDeviceId(dev);
      setCursor(await storage.getItem(CURSOR_KEY));
      const prefs = await getAiPrefs();
      setAiBatchText(String(prefs.batch));
      setAiTimeoutText(String(prefs.timeoutS));
      setAiNoThink(prefs.noThink);
      const llmFlag = await storage.getItem(DEDUPE_LLM_KEY);
      // 默认开启「用大模型判定词根」（可在数据页关闭）；仅当明确存过 '0' 才关
      setDedupeUseLlm(llmFlag !== '0');
    })();
  }, []);

  async function toggleDedupeLlm(value) {
    setDedupeUseLlm(value);
    try {
      await storage.setItem(DEDUPE_LLM_KEY, value ? '1' : '0');
    } catch (err) { /* ignore */ }
  }

  // ———— AI 接口 ————

  async function save() {
    if (!baseUrl.trim() || !apiKey.trim()) {
      notify('提示', '请填写接口地址和 API Key');
      return;
    }
    setSaving(true);
    try {
      const resp = await apiFetch('/api/ai/config', {
        method: 'POST',
        body: {
          base_url: baseUrl.trim(),
          api_key: apiKey.trim(),
          model: model.trim() || 'gpt-4o',
        },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      setConfigured(true);
      notify('已保存', 'AI 配置已保存，API Key 已加密存储');
    } catch (err) {
      notify('保存失败', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const body = {};
      if (baseUrl.trim()) body.base_url = baseUrl.trim();
      if (apiKey.trim()) body.api_key = apiKey.trim();
      if (model.trim()) body.model = model.trim();

      const resp = await apiFetch('/api/ai/test', { method: 'POST', body });
      const data = await resp.json();
      setTestResult({ ok: resp.ok && data.ok, data });
    } catch (err) {
      setTestResult({ ok: false, data: { error: err.message } });
    } finally {
      setTesting(false);
    }
  }

  // ———— 文本 AI（属性补全） ————

  async function saveText() {
    if (!textBaseUrl.trim() || !textApiKey.trim()) {
      notify('提示', '请填写文本 AI 的接口地址和 API Key');
      return;
    }
    setSavingText(true);
    try {
      const resp = await apiFetch('/api/ai/text-config', {
        method: 'POST',
        body: {
          base_url: textBaseUrl.trim(),
          api_key: textApiKey.trim(),
          model: textModel.trim() || 'gpt-4o-mini',
        },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      setTextConfigured(true);
      setTextApiKey('');
      notify('已保存', '文本 AI 配置已保存，API Key 已加密存储');
    } catch (err) {
      notify('保存失败', err.message);
    } finally {
      setSavingText(false);
    }
  }

  async function testTextConnection() {
    setTestingText(true);
    setTextTestResult(null);
    try {
      const body = { target: 'text' };
      if (textBaseUrl.trim()) body.base_url = textBaseUrl.trim();
      if (textApiKey.trim()) body.api_key = textApiKey.trim();
      if (textModel.trim()) body.model = textModel.trim();

      const resp = await apiFetch('/api/ai/test', { method: 'POST', body });
      const data = await resp.json();
      setTextTestResult({ ok: resp.ok && data.ok, data });
    } catch (err) {
      setTextTestResult({ ok: false, data: { error: err.message } });
    } finally {
      setTestingText(false);
    }
  }

  // 参数改动即时持久化（补全按钮也会再存一次，双保险）
  function persistAiPrefs(next) {
    saveAiPrefs(next).catch(() => {});
  }

  // 用文本 AI 批量补全缺失的例句与词形变化（服务端分批处理；超时按每轮词数与单次超时动态计算）
  async function runEnrich() {
    if (!textConfigured && !textApiKey.trim()) {
      notify('提示', '请先保存文本 AI 配置（接口地址 / Key / 模型）');
      return;
    }
    setEnriching(true);
    setEnrichResult(null);
    try {
      const prefs = await saveAiPrefs({ batch: aiBatchText, timeoutS: aiTimeoutText, noThink: aiNoThink });
      const resp = await apiFetch('/api/ai/enrich', {
        method: 'POST',
        body: { limit: 200, batch: prefs.batch, timeout_s: prefs.timeoutS, no_think: prefs.noThink ? 1 : 0 },
        timeoutMs: enrichFetchTimeoutMs(Math.min(200, (missing ? missing.no_example + missing.no_forms : 200)), prefs),
      });
      const data = await resp.json();
      setEnrichResult({ ok: resp.ok, data });
      loadMissing();
    } catch (err) {
      setEnrichResult({ ok: false, data: { error: err.message } });
    } finally {
      setEnriching(false);
    }
  }

  // ———— 识别提示词 ————

  async function savePrompt() {
    if (!configured) {
      notify('提示', '请先在「视觉AI」页签中保存接口地址和 API Key，再保存提示词');
      return;
    }
    setSavingPrompt(true);
    try {
      // 只提交提示词本身：后端 /api/ai/prompt 不会改动 base_url / api_key / model
      const resp = await apiFetch('/api/ai/prompt', {
        method: 'POST',
        body: { system_prompt: prompt },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      notify('已保存', data.message || '识别提示词已保存');
    } catch (err) {
      notify('保存失败', err.message);
    } finally {
      setSavingPrompt(false);
    }
  }

  // ———— 服务器地址 ————

  async function saveServer() {
    setSavingServer(true);
    try {
      const r = await saveServerUrl(serverUrl);
      if (!r.ok) throw new Error(r.error);
      setServerUrl(r.url);
      setServerInfo(getServerUrlConfig());
      setPingResult(null);
      notify(
        '已保存',
        r.changed
          ? '服务器地址已切换为：' + r.url + '\n\n为保证登录状态正确，需要重新登录。'
          : '服务器地址已保存：' + r.url
      );
    } catch (err) {
      notify('保存失败', err.message);
    } finally {
      setSavingServer(false);
    }
  }

  async function restoreDefaultServer() {
    const r = await resetServerUrl();
    setServerUrl(r.url);
    setServerInfo(getServerUrlConfig());
    setPingResult(null);
    notify('已恢复', '已恢复为配置文件地址：' + r.url + '\n\n如曾登录，可能需要重新登录。');
  }

  async function testServer() {
    setPinging(true);
    setPingResult(null);
    setPingResult(await pingServer(serverUrl));
    setPinging(false);
  }

  // ———— 数据同步 ————

  async function doSync() {
    if (!deviceId) { notify('提示', '设备初始化中，请稍候'); return; }
    setSyncing(true);
    try {
      const lastSync = cursor || '2000-01-01T00:00:00Z';
      const resp = await apiFetch(
        `/api/sync/pull?last_sync=${encodeURIComponent(lastSync)}&device_id=${encodeURIComponent(deviceId)}`
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);

      const nextCursor = data.server_time;
      await storage.setItem(CURSOR_KEY, nextCursor);
      setCursor(nextCursor);
      setLastInfo({
        entries: data.entries.length,
        reviews: data.reviews.length,
        time: data.server_time,
        isFull: !cursor,
      });
      notify(
        '同步完成',
        cursor
          ? `本次增量 ${data.entries.length} 条单词（上次同步之后）`
          : `已全量拉取 ${data.entries.length} 条单词到本机`
      );
    } catch (err) {
      notify('同步失败', err.message);
    } finally {
      setSyncing(false);
    }
  }

  // ———— 去除重复（完全重复 + 相同词根不同词形） ————

  async function checkDuplicates() {
    setDupLoading(true);
    setDupInfo(null);
    try {
      const prefs = await getAiPrefs();
      const resp = await apiFetch('/api/vocab/dedupe-scan', {
        method: 'POST',
        body: { use_llm: dedupeUseLlm ? 1 : 0, batch: prefs.batch, timeout_s: prefs.timeoutS, no_think: prefs.noThink ? 1 : 0 },
        timeoutMs: dedupeUseLlm ? Math.min(30 * 60000, prefs.timeoutS * 1000 * Math.ceil(Math.max((dupInfo ? dupInfo.scanned : 0) || 400, 120) / prefs.batch) + 30000) : 30000,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      setDupInfo(data);
      if (!data.exact_redundant && !data.lemma_groups) {
        notify('检测完成', '没有发现重复单词，也没有可归并的词形变化，单词本很干净。');
      }
    } catch (err) {
      notify('检测失败', err.message);
    } finally {
      setDupLoading(false);
    }
  }

  function confirmDedupe() {
    const info = dupInfo;
    if (!info || (!info.exact_redundant && !info.lemma_groups)) {
      notify('无需清理', '先点「检测重复与词形变化」查看结果。');
      return;
    }
    const lines = [];
    if (info.exact_redundant) lines.push(`删除完全重复 ${info.exact_redundant} 条（各保留最新一条）`);
    if (info.lemma_groups) {
      lines.push(`词形归并 ${info.lemma_groups} 组：变化形式（如 children）并入原型（如 child），被并的词写入原型对应词形字段后删除`);
    }
    confirmDialog({
      title: '去重并归并词形',
      message: `${lines.join('；')}。\n\n词形字段只填空缺，不会覆盖已有内容。此操作不可撤销，确定继续吗？`,
      confirmText: '确定处理',
      destructive: true,
      onConfirm: async () => {
        setDeduping(true);
        try {
          const prefs = await getAiPrefs();
          const resp = await apiFetch('/api/vocab/dedupe', {
            method: 'POST',
            body: { use_llm: dedupeUseLlm ? 1 : 0, batch: prefs.batch, timeout_s: prefs.timeoutS, no_think: prefs.noThink ? 1 : 0 },
            timeoutMs: dedupeUseLlm ? Math.min(30 * 60000, prefs.timeoutS * 1000 * Math.ceil(Math.max(dupInfo && dupInfo.scanned ? dupInfo.scanned : 400, 120) / prefs.batch) + 30000) : 60000,
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error);
          setDupInfo(null);
          notify('处理完成', data.message);
        } catch (err) {
          notify('处理失败', err.message);
        } finally {
          setDeduping(false);
        }
      },
    });
  }

  function confirmSignOut() {
    confirmDialog({
      title: '退出登录',
      message: '确定要退出当前账号吗？',
      confirmText: '退出',
      destructive: true,
      onConfirm: () => signOut(),
    });
  }

  // ———— 重置密码 ————

  /** 前端校验 + 二次确认；确认后调用后端重置 */
  function confirmPasswordReset() {
    if (!curPassword || !newPassword || !confirmPassword) {
      notify('提示', '请填写当前密码、新密码和确认新密码');
      return;
    }
    if (newPassword.length < 8) {
      notify('提示', '新密码至少 8 位，建议包含字母数字和符号');
      return;
    }
    if (newPassword !== confirmPassword) {
      notify('提示', '两次输入的新密码不一致');
      return;
    }
    if (newPassword === curPassword) {
      notify('提示', '新密码不能与当前密码相同');
      return;
    }
    confirmDialog({
      title: '确认重置密码',
      message: '重置后，该账号在所有设备（包括本机）上的登录都会失效，需要重新登录。确定继续吗？',
      confirmText: '确定重置',
      destructive: true,
      onConfirm: doResetPassword,
    });
  }

  async function doResetPassword() {
    setResettingPwd(true);
    try {
      const resp = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: curPassword, new_password: newPassword },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '重置失败');

      setCurPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // 后端已自增 token_version：该账号所有设备（含本机）的旧 token 立即失效。
      // 本机同步清除本地登录态，回到登录页用新密码重新登录。
      signOut();
      notify('密码已重置', data.message || '所有设备已退出登录，请用新密码重新登录');
    } catch (err) {
      notify('重置失败', err.message);
    } finally {
      setResettingPwd(false);
    }
  }

  // ———— 多级菜单导航 ————

  const openGroup = (id) => setNav([id]);
  const openPage = (groupId, pageId) => setNav([groupId, pageId]);
  const goBack = () => setNav((n) => n.slice(0, -1));

  /** 顶部：首页显示「设置」，子页显示返回按钮 + 标题 + 面包屑 */
  function renderHeader() {
    if (nav.length === 0) {
      return (
        <View>
          <Text style={styles.title}>设置</Text>
          <Text style={styles.menuHint}>
            账号、单词与复习进度都存在服务器上；换设备登录同一账号即可继续。
          </Text>
        </View>
      );
    }
    const g = MENU.find((x) => x.id === nav[0]) || null;
    const title = nav.length === 2 ? (PAGE_TITLES[page] || '设置') : (g ? g.title : '设置');
    return (
      <View>
        <TouchableOpacity style={styles.backBtn} onPress={goBack}>
          <Text style={styles.backText}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.pageTitle}>{title}</Text>
        <Text style={styles.breadcrumb}>
          {nav.length === 2 && g ? `设置 › ${g.title} › ${title}` : `设置 › ${title}`}
        </Text>
      </View>
    );
  }

  /** 首页：分组入口卡片 */
  function renderMenuHome() {
    return (
      <View style={{ marginTop: 18 }}>
        {MENU.map((g) => (
          <TouchableOpacity
            key={g.id}
            style={styles.menuCard}
            onPress={() => openGroup(g.id)}
            activeOpacity={0.7}
          >
            <Text style={styles.menuIcon}>{g.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.menuTitle}>{g.title}</Text>
              <Text style={styles.menuDesc}>{g.desc}</Text>
            </View>
            <Text style={styles.menuArrow}>›</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  /** 分组页：该分组下的设置项 */
  function renderGroupPage(g) {
    return (
      <View style={{ marginTop: 16 }}>
        {g.items.map((it) => (
          <TouchableOpacity
            key={it.id}
            style={styles.menuRow}
            onPress={() => openPage(g.id, it.id)}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.menuRowTitle}>{it.title}</Text>
              <Text style={styles.menuDesc}>{it.desc}</Text>
            </View>
            <Text style={styles.menuArrow}>›</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {renderHeader()}
      {nav.length === 0 && renderMenuHome()}
      {group && renderGroupPage(group)}

      {/* ————————————— API 设置 ————————————— */}
      {page === 'api' && (
        <View>
          <Text style={styles.subtitle}>
            拍照识词需要一个 OpenAI 兼容的多模态接口。请填写你购买的服务的 base_url（含 /v1）与 API Key。
            支持：OpenAI、通义千问、智谱、DeepSeek、Kimi 等多模态版本等（需支持图片输入）。
          </Text>

          <Text style={styles.label}>接口地址 base_url</Text>
          <TextInput
            style={styles.input}
            placeholder="例如 https://api.openai.com/v1"
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            placeholder={configured ? '已保存，留空则保持不变' : '输入你的 API Key'}
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
          />

          <Text style={styles.label}>模型名称</Text>
          <TextInput
            style={styles.input}
            placeholder="例如 gpt-4o / qwen-vl-max"
            value={model}
            onChangeText={setModel}
            autoCapitalize="none"
          />
          <Text style={styles.tip}>注意：所选模型必须支持图片(视觉)输入，否则识别会失败。</Text>

          <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}>
            <Text style={styles.btnText}>{saving ? '保存中…' : '保存 AI 配置'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.testBtn} onPress={testConnection} disabled={testing}>
            {testing ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>测试连接</Text>}
          </TouchableOpacity>

          {testResult && (
            <View style={[styles.resultBox, testResult.ok ? styles.resultOk : styles.resultBad]}>
              <Text style={styles.resultTitle}>
                {testResult.ok ? '✅ 连接成功' : '❌ 连接失败'}
              </Text>
              {testResult.data.model ? (
                <Text style={styles.resultLine}>模型：{testResult.data.model}</Text>
              ) : null}
              {testResult.data.latency_ms ? (
                <Text style={styles.resultLine}>延迟：{testResult.data.latency_ms} ms</Text>
              ) : null}
              <Text style={styles.resultLine}>
                {testResult.ok ? testResult.data.message : (testResult.data.error || '测试失败')}
              </Text>
              {testResult.data.detail ? (
                <Text style={styles.resultDetail} numberOfLines={6}>{testResult.data.detail}</Text>
              ) : null}
            </View>
          )}

          <View style={styles.securityBox}>
            <Text style={styles.securityTitle}>🔒 安全说明</Text>
            <Text style={styles.securityText}>
              您的 API Key 不会被明文存进数据库，而是用服务器端密钥 AES-256 加密后保存；登录密码使用 bcrypt 不可逆哈希，任何人都无法还原。
            </Text>
          </View>
        </View>
      )}

      {/* ————————————— 文本 AI（属性补全） ————————————— */}
      {page === 'text' && (
        <View>
          <Text style={styles.subtitle}>
            文本 AI 用于给单词补全「更多属性」：例句、词性、词形变化（三单/过去式/过去分词/ing/复数/比较级/最高级）。
            它与拍照识词的视觉 AI 分开配置，可以填不同的服务商——文本模型通常更便宜、更快，任何 OpenAI 兼容文本接口都可以（DeepSeek、通义、Kimi、gpt-4o-mini 等），无需支持图片。
          </Text>

          <Text style={styles.label}>接口地址 base_url</Text>
          <TextInput
            style={styles.input}
            placeholder="例如 https://api.deepseek.com/v1"
            value={textBaseUrl}
            onChangeText={setTextBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            placeholder={textConfigured ? '已保存，留空则保持不变' : '输入文本接口的 API Key'}
            value={textApiKey}
            onChangeText={setTextApiKey}
            secureTextEntry
          />

          <Text style={styles.label}>模型名称</Text>
          <TextInput
            style={styles.input}
            placeholder="例如 deepseek-chat / gpt-4o-mini / qwen-plus"
            value={textModel}
            onChangeText={setTextModel}
            autoCapitalize="none"
          />

          <TouchableOpacity style={styles.saveBtn} onPress={saveText} disabled={savingText}>
            <Text style={styles.btnText}>{savingText ? '保存中…' : '保存文本 AI 配置'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.testBtn} onPress={testTextConnection} disabled={testingText}>
            {testingText ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>测试连接</Text>}
          </TouchableOpacity>

          {textTestResult && (
            <View style={[styles.resultBox, textTestResult.ok ? styles.resultOk : styles.resultBad]}>
              <Text style={styles.resultTitle}>
                {textTestResult.ok ? '✅ 连接成功' : '❌ 连接失败'}
              </Text>
              {textTestResult.data.model ? (
                <Text style={styles.resultLine}>模型：{textTestResult.data.model}</Text>
              ) : null}
              {textTestResult.data.latency_ms ? (
                <Text style={styles.resultLine}>延迟：{textTestResult.data.latency_ms} ms</Text>
              ) : null}
              <Text style={styles.resultLine}>
                {textTestResult.ok ? textTestResult.data.message : (textTestResult.data.error || '测试失败')}
              </Text>
              {textTestResult.data.detail ? (
                <Text style={styles.resultDetail} numberOfLines={6}>{textTestResult.data.detail}</Text>
              ) : null}
            </View>
          )}

          <Text style={styles.sectionTitle}>✨ 一键补全单词属性</Text>
          <Text style={styles.tip}>
            只处理「缺例句」或「完全没有词形变化」的单词，每次最多 200 个。已有内容不会被覆盖，只填空缺。
            总是超时的话：保持「关闭深度思考」开启，并把「每轮单词数」调小（如 5）或把「单次超时」调大。
          </Text>

          {/* 文本AI 调用参数：每轮单词数 / 单次超时 / 关闭深度思考 */}
          <View style={styles.paramRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>每轮单词数</Text>
              <TextInput
                style={styles.input}
                placeholder="10"
                keyboardType="number-pad"
                value={aiBatchText}
                onChangeText={(v) => { setAiBatchText(v); persistAiPrefs({ batch: v, timeoutS: aiTimeoutText, noThink: aiNoThink }); }}
              />
              <Text style={styles.tip}>每次 AI 请求处理几个单词（1-50，默认 10）。调小不易超时，调大更省调用次数。</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.label}>单次超时（秒）</Text>
              <TextInput
                style={styles.input}
                placeholder="120"
                keyboardType="number-pad"
                value={aiTimeoutText}
                onChangeText={(v) => { setAiTimeoutText(v); persistAiPrefs({ batch: aiBatchText, timeoutS: v, noThink: aiNoThink }); }}
              />
              <Text style={styles.tip}>单次 AI 请求最长等待秒数（10-600，默认 120）。</Text>
            </View>
          </View>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>关闭深度思考</Text>
              <Text style={styles.switchHint}>
                对会「深度思考」的模型（DeepSeek-R1、Qwen3、Kimi 等）可大幅提速、避免超时。
                若你的接口因不认识的参数报错（400），请关闭本开关。
              </Text>
            </View>
            <Switch
              value={aiNoThink}
              onValueChange={setAiNoThink}
              trackColor={{ false: '#cbd5e1', true: '#93c5fd' }}
              thumbColor={aiNoThink ? '#2563eb' : '#f8fafc'}
            />
          </View>
          {missing && (
            <Text style={styles.infoText}>
              单词本共 {missing.total} 个：缺例句 {missing.no_example} 个，缺词形变化 {missing.no_forms} 个
            </Text>
          )}
          <TouchableOpacity
            style={[styles.saveBtn, (!textConfigured && !textApiKey.trim()) || enriching ? styles.btnDisabled : null]}
            onPress={runEnrich}
            disabled={enriching || (!textConfigured && !textApiKey.trim())}
          >
            {enriching
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>开始补全属性</Text>}
          </TouchableOpacity>

          {enrichResult && (
            <View style={[styles.resultBox, enrichResult.ok ? styles.resultOk : styles.resultBad]}>
              <Text style={styles.resultTitle}>
                {enrichResult.ok ? '✅ 补全完成' : '❌ 补全失败'}
              </Text>
              <Text style={styles.resultLine}>
                {enrichResult.ok
                  ? enrichResult.data.message
                  : (enrichResult.data.error || '补全失败')}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ————————————— 识别提示词 ————————————— */}
      {page === 'prompt' && (
        <View>
          <Text style={styles.subtitle}>
            拍照识词时，会把这句提示词发给 AI，用来告诉它如何识别并返回结果。
            留空则使用内置默认提示词。提示词只在当前账号生效，不会影响他人。
          </Text>

          <Text style={styles.label}>自定义识别提示词</Text>
          <TextInput
            style={styles.promptInput}
            placeholder="例如：你是英语语料识别助手……（建议要求 AI 只输出指定格式的 JSON 数组）"
            value={prompt}
            onChangeText={setPrompt}
            multiline
            textAlignVertical="top"
          />

          <TouchableOpacity
            style={[styles.saveBtn, (!promptLoaded || !configured) && styles.saveBtnDisabled]}
            onPress={savePrompt}
            disabled={savingPrompt || !promptLoaded || !configured}
          >
            {savingPrompt
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>保存提示词</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.resetBtn}
            onPress={() => { setPrompt(''); notify('已清空输入框', '点击「保存提示词」后将使用内置默认提示词'); }}
          >
            <Text style={styles.resetText}>清空并恢复默认</Text>
          </TouchableOpacity>

          <View style={styles.infoBox}>
            <Text style={styles.infoTitle}>ℹ️ 说明</Text>
            <Text style={styles.infoText}>
              为保证识别结果能正确写入单词本，提示词最好保留原有的 JSON 输出格式要求
              （word / annotated_meaning / dict_meaning 三个字段）。
            </Text>
          </View>

          <View style={styles.defaultPromptBox}>
            <Text style={styles.securityTitle}>📄 内置默认提示词</Text>
            <Text style={styles.securityText}>{defaultPromptText}</Text>
          </View>
        </View>
      )}

      {/* ————————————— 服务器地址 ————————————— */}
      {page === 'server' && (
        <View>
          {CAN_CHANGE_SERVER_URL ? (
            <View>
              <Text style={styles.subtitle}>
                在这里指定本 App 连接的后端服务器地址。改好后点「保存并切换」，之后所有请求都会发往新地址。
                地址需包含协议与端口，例如 http://192.168.1.10:3000
              </Text>

              <Text style={styles.label}>服务器地址</Text>
              <TextInput
                style={styles.input}
                placeholder="http://192.168.1.10:3000"
                value={serverUrl}
                onChangeText={setServerUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>📍 当前生效地址</Text>
                <Text style={styles.infoText}>{serverInfo.effective}</Text>
                <Text style={styles.infoText}>来源：{serverInfo.source}</Text>
                <Text style={styles.infoText}>配置文件默认值：{serverInfo.defaultUrl}</Text>
              </View>

              <TouchableOpacity style={styles.saveBtn} onPress={saveServer} disabled={savingServer}>
                {savingServer ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>保存并切换</Text>}
              </TouchableOpacity>

              <TouchableOpacity style={styles.testBtn} onPress={testServer} disabled={pinging}>
                {pinging ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>测试该地址连通性</Text>}
              </TouchableOpacity>

              {pingResult && (
                <View style={[styles.resultBox, pingResult.ok ? styles.resultOk : styles.resultBad]}>
                  <Text style={styles.resultTitle}>
                    {pingResult.ok ? '✅ 服务器可访问' : '❌ 无法访问'}
                  </Text>
                  {pingResult.latency_ms ? (
                    <Text style={styles.resultLine}>延迟：{pingResult.latency_ms} ms</Text>
                  ) : null}
                  {pingResult.server_time ? (
                    <Text style={styles.resultLine}>服务器时间：{pingResult.server_time}</Text>
                  ) : null}
                  <Text style={styles.resultLine}>
                    {pingResult.ok ? '后端 /api/health 正常返回' : (pingResult.error || '连接失败')}
                  </Text>
                </View>
              )}

              <TouchableOpacity style={styles.resetBtn} onPress={restoreDefaultServer}>
                <Text style={styles.resetText}>清除自定义地址，恢复配置文件默认</Text>
              </TouchableOpacity>

              <View style={styles.securityBox}>
                <Text style={styles.securityTitle}>💡 提示</Text>
                <Text style={styles.securityText}>
                  切换服务器后需要重新登录（不同服务器上的账号与数据互不相通）。
                  若填写的是局域网地址，手机必须和服务器处于同一网络。
                  Web 端不支持在此修改，请改项目根目录 .env 的 EXPO_PUBLIC_API_URL 后重新构建。
                </Text>
              </View>
            </View>
          ) : (
            <View>
              <Text style={styles.subtitle}>
                Web 端的服务器地址在构建时的配置文件里指定，不支持在页面中修改。
              </Text>

              <View style={styles.infoBox}>
                <Text style={styles.infoTitle}>📍 当前生效地址</Text>
                <Text style={styles.infoText}>{serverInfo.effective}</Text>
              </View>

              <View style={styles.securityBox}>
                <Text style={styles.securityTitle}>⚙️ 如何修改（Web 端）</Text>
                <Text style={styles.securityText}>
                  编辑【项目根目录 .env】里的 EXPO_PUBLIC_API_URL，然后在 app/ 目录执行
                  npm run build:web（已内置清缓存），把生成的 dist/ 部署到后端 web/ 即可生效。
                  （手机 App 则可以直接在本页改。）
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ————————————— 数据同步 ————————————— */}
      {page === 'sync' && (
        <View>
          <Text style={styles.subtitle}>
            把本机与服务器对齐。首次为全量拉取，之后只拉上次同步之后的增量。
          </Text>

          {lastInfo && (
            <View style={styles.infoBox}>
              <Text style={styles.infoText}>最近同步：{lastInfo.time}</Text>
              <Text style={styles.infoText}>本次拉取：{lastInfo.entries} 条单词 / {lastInfo.reviews} 条复习记录</Text>
              <Text style={styles.infoText}>模式：{lastInfo.isFull ? '首次全量同步' : '增量同步'}</Text>
            </View>
          )}

          <TouchableOpacity style={styles.saveBtn} onPress={doSync} disabled={syncing || !deviceId}>
            {syncing ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>立即同步</Text>}
          </TouchableOpacity>

          {cursor ? <Text style={styles.metaText}>本地同步游标：{cursor}</Text> : null}
          {deviceId ? <Text style={styles.metaText}>设备标识：{deviceId}</Text> : null}
        </View>
      )}

      {/* ————————————— 去重与词形归并 ————————————— */}
      {page === 'dedupe' && (
        <View>
          <Text style={styles.subtitle}>
            两层清理：① 完全重复的单词只保留最近保存的一条；② 相同词根不同词形（如 child / childs / children、
            go / went / goes）自动合并为原型，被合并的词写入原型的词形变化字段（背单词显示答案时可见），然后删除。
            词形字段只填空缺，绝不覆盖已有内容。
          </Text>

          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>用大模型判定词根</Text>
              <Text style={styles.switchHint}>
                开：用「文本AI」精确识别不规则变化（went→go、children→child 等），更准，但需要已配置文本AI并消耗少量额度。
                关：用内置规则（免费、快速），只合并有把握的规则词形与常见不规则词。
              </Text>
            </View>
            <Switch
              value={dedupeUseLlm}
              onValueChange={toggleDedupeLlm}
              trackColor={{ false: '#cbd5e1', true: '#93c5fd' }}
              thumbColor={dedupeUseLlm ? '#2563eb' : '#f8fafc'}
            />
          </View>
          {dedupeUseLlm && !textConfigured ? (
            <Text style={styles.warnText}>
              ⚠️ 尚未配置文本AI：请先到「设置 › AI 接口 › 文本 AI」配置，否则点击检测会提示先去配置。
            </Text>
          ) : null}

          <TouchableOpacity style={styles.testBtn} onPress={checkDuplicates} disabled={dupLoading}>
            {dupLoading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>检测重复与词形变化</Text>}
          </TouchableOpacity>

          {dupInfo && (
            <View style={[styles.resultBox, (dupInfo.exact_redundant || dupInfo.lemma_groups) ? styles.resultWarn : styles.resultOk]}>
              <Text style={styles.resultTitle}>
                {(dupInfo.exact_redundant || dupInfo.lemma_groups)
                  ? `完全重复 ${dupInfo.exact_redundant} 条可删；词形归并 ${dupInfo.lemma_groups} 组（涉及 ${dupInfo.lemma_rows} 个词）`
                  : '✅ 没有发现重复，也没有可归并的词形变化'}
              </Text>
              {dupInfo.groups && dupInfo.groups.length ? (
                <Text style={styles.resultLine}>
                  归并示例：{dupInfo.groups.slice(0, 6).map((g) => `${g.members.map((m) => m.word).join('/')}→${g.keep_word}`).join('、')}
                  {dupInfo.more ? ` …共${dupInfo.lemma_groups}组` : ''}
                </Text>
              ) : null}
            </View>
          )}

          <TouchableOpacity
            style={[styles.dangerBtn, (!dupInfo || (!dupInfo.exact_redundant && !dupInfo.lemma_groups) || deduping) && styles.dangerBtnDisabled]}
            onPress={confirmDedupe}
            disabled={!dupInfo || (!dupInfo.exact_redundant && !dupInfo.lemma_groups) || deduping}
          >
            {deduping ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>执行去重与词形归并</Text>}
          </TouchableOpacity>
          <Text style={styles.metaText}>
            为避免误删，需先点「检测重复与词形变化」预览结果，按钮可用后再执行。
            大模型模式下会扫描整个单词本，可能要等十几秒到一分钟。
          </Text>
        </View>
      )}

      {/* ————————————— 重置密码 ————————————— */}
      {page === 'password' && (
        <View>
          <Text style={styles.subtitle}>
            修改当前账号的登录密码。为防止他人冒用，需要先输入当前密码；
            重置成功后，该账号在所有设备上的登录都会立即失效，需要用新密码重新登录。
          </Text>

          <Text style={styles.label}>当前密码</Text>
          <TextInput
            style={styles.input}
            placeholder="请输入当前登录密码"
            value={curPassword}
            onChangeText={setCurPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>新密码</Text>
          <TextInput
            style={styles.input}
            placeholder="至少 8 位，建议字母数字和符号组合"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>确认新密码</Text>
          <TextInput
            style={styles.input}
            placeholder="再次输入新密码"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          <TouchableOpacity
            style={[styles.dangerBtn, resettingPwd && styles.dangerBtnDisabled]}
            onPress={confirmPasswordReset}
            disabled={resettingPwd}
          >
            {resettingPwd
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>重置密码</Text>}
          </TouchableOpacity>

          <View style={styles.warnBox}>
            <Text style={styles.warnTitle}>⚠️ 重置后将退出所有设备</Text>
            <Text style={styles.warnBody}>
              密码修改成功后，该账号此前签发的登录凭证会全部作废：包括本机在内的所有设备
              都需要用新密码重新登录。请务必先记好新密码。
            </Text>
          </View>
        </View>
      )}

      {/* ————————————— 账号 ————————————— */}
      {page === 'account' && (
        <View>
          <View style={styles.infoBox}>
            <Text style={styles.infoTitle}>👤 当前账号</Text>
            <Text style={styles.infoText}>{user ? user.username : '未登录'}</Text>
            <Text style={styles.infoText}>
              不同设备登录同一账号即可访问同一份数据；单词与复习进度都保存在服务器上。
            </Text>
          </View>

          <TouchableOpacity style={styles.outBtn} onPress={confirmSignOut}>
            <Text style={styles.outText}>退出登录</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#f5f7fb', padding: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#1e293b' },
  // —— 多级菜单 ——
  menuHint: { fontSize: 12, color: '#94a3b8', marginTop: 8, lineHeight: 18 },
  menuCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 14,
    borderWidth: 1, borderColor: '#e2e8f0', padding: 16, marginBottom: 12, gap: 14,
  },
  menuIcon: { fontSize: 24 },
  menuTitle: { fontSize: 16, fontWeight: '700', color: '#1e293b' },
  menuRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12,
    borderWidth: 1, borderColor: '#e2e8f0', padding: 16, marginBottom: 10,
  },
  menuRowTitle: { fontSize: 15, fontWeight: '600', color: '#1e293b' },
  menuDesc: { fontSize: 12, color: '#94a3b8', marginTop: 4, lineHeight: 17 },
  menuArrow: { fontSize: 22, color: '#cbd5e1', marginLeft: 10 },
  backBtn: { alignSelf: 'flex-start', paddingVertical: 4, paddingRight: 12, marginBottom: 2 },
  backText: { fontSize: 15, color: '#2563eb', fontWeight: '600' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: '#1e293b' },
  breadcrumb: { fontSize: 12, color: '#94a3b8', marginTop: 6 },
  btnDisabled: { backgroundColor: '#94a3b8' },
  paramRow: { flexDirection: 'row', marginTop: 6 },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12,
    borderWidth: 1, borderColor: '#e2e8f0', padding: 14, marginTop: 12, gap: 12,
  },
  switchLabel: { fontSize: 14, fontWeight: '700', color: '#1e293b', marginBottom: 4 },
  switchHint: { fontSize: 12, color: '#94a3b8', lineHeight: 18 },
  warnText: { fontSize: 12, color: '#b45309', marginTop: 8, lineHeight: 18 },
  warnBox: { backgroundColor: '#fffbeb', borderRadius: 12, padding: 16, marginTop: 20, borderWidth: 1, borderColor: '#fde68a' },
  warnTitle: { fontSize: 15, fontWeight: '700', color: '#b45309' },
  warnBody: { fontSize: 13, color: '#92400e', marginTop: 6, lineHeight: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#1e293b', marginTop: 22, marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 10, marginBottom: 4, lineHeight: 20 },
  label: { fontSize: 14, color: '#475569', marginTop: 14, marginBottom: 6, fontWeight: '600' },
  input: {
    backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, borderWidth: 1, borderColor: '#e2e8f0',
  },
  promptInput: {
    backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 14, borderWidth: 1, borderColor: '#e2e8f0', minHeight: 160, lineHeight: 21,
  },
  tip: { fontSize: 12, color: '#94a3b8', marginTop: 10 },
  metaText: { fontSize: 12, color: '#94a3b8', marginTop: 10, lineHeight: 18 },
  saveBtn: { backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 20 },
  saveBtnDisabled: { backgroundColor: '#93c5fd' },
  testBtn: { backgroundColor: '#0891b2', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 12 },
  dangerBtn: { backgroundColor: '#dc2626', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 14 },
  dangerBtnDisabled: { backgroundColor: '#fca5a5' },
  resetBtn: { marginTop: 14, alignItems: 'center', paddingVertical: 6 },
  resetText: { color: '#dc2626', fontSize: 14, fontWeight: '600' },
  outBtn: { marginTop: 8, alignItems: 'center', paddingVertical: 8 },
  outText: { color: '#dc2626', fontSize: 15, fontWeight: '600' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  resultBox: { borderRadius: 12, padding: 16, marginTop: 16, borderWidth: 1 },
  resultOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  resultWarn: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  resultBad: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  resultTitle: { fontSize: 15, fontWeight: '700', color: '#1e293b', marginBottom: 6 },
  resultLine: { fontSize: 13, color: '#334155', marginTop: 2, lineHeight: 19 },
  resultDetail: { fontSize: 12, color: '#64748b', marginTop: 8, backgroundColor: '#fff', borderRadius: 8, padding: 8 },
  infoBox: { backgroundColor: '#eff6ff', borderRadius: 12, padding: 16, marginTop: 20, borderWidth: 1, borderColor: '#bfdbfe' },
  infoTitle: { fontSize: 15, fontWeight: '700', color: '#1d4ed8' },
  infoText: { fontSize: 13, color: '#1e40af', marginTop: 6, lineHeight: 20 },
  securityBox: { backgroundColor: '#f0fdf4', borderRadius: 12, padding: 16, marginTop: 24, borderWidth: 1, borderColor: '#bbf7d0' },
  defaultPromptBox: { backgroundColor: '#f0fdf4', borderRadius: 12, padding: 16, marginTop: 24, borderWidth: 1, borderColor: '#bbf7d0' },
  securityTitle: { fontSize: 15, fontWeight: '700', color: '#166534' },
  securityText: { fontSize: 13, color: '#166534', marginTop: 6, lineHeight: 20 },
});
