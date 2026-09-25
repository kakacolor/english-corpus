import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CAN_CHANGE_SERVER_URL, getServerUrlConfig, saveServerUrl, resetServerUrl, pingServer,
} from '../api';
import { notify } from '../utils/dialog';

export default function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('login'); // login | register
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /** 用户重新输入时清掉上一次的错误提示 */
  function edit(setter) {
    return (v) => {
      setter(v);
      if (error) setError('');
    };
  }

  // —— 服务器切换（仅手机 App 可用；Web 端地址在构建时写死，不可改） ——
  const [showServer, setShowServer] = useState(false);
  const [serverInfo, setServerInfo] = useState(() => getServerUrlConfig());
  const [serverUrl, setServerUrl] = useState(() => getServerUrlConfig().effective);
  const [savingServer, setSavingServer] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState(null);

  /** 保存并切换到输入的服务器地址 */
  async function applyServer() {
    if (savingServer) return;
    setSavingServer(true);
    try {
      const r = await saveServerUrl(serverUrl);
      if (!r.ok) throw new Error(r.error);
      setServerUrl(r.url);
      setServerInfo(getServerUrlConfig());
      setPingResult(null);
      notify(
        '服务器已切换',
        r.changed
          ? `已切换为：\n${r.url}\n\n请使用该服务器上的账号登录。`
          : `当前已在使用：\n${r.url}`
      );
    } catch (err) {
      notify('保存失败', err.message);
    } finally {
      setSavingServer(false);
    }
  }

  /** 测试输入的地址是否能连通（不改变当前设置） */
  async function testServer() {
    if (pinging) return;
    setPinging(true);
    setPingResult(null);
    setPingResult(await pingServer(serverUrl));
    setPinging(false);
  }

  /** 清除自定义地址，恢复配置文件/内置默认 */
  async function restoreDefaultServer() {
    const r = await resetServerUrl();
    setServerUrl(r.url);
    setServerInfo(getServerUrlConfig());
    setPingResult(null);
    notify('已恢复默认', `已恢复为：\n${r.url}`);
  }

  async function handleSubmit() {
    if (loading) return;
    setError('');

    // —— 提交前先做本地校验，避免空提交和明显错误 ——
    const acc = account.trim();
    const name = username.trim();
    const mail = email.trim();

    if (mode === 'login') {
      if (!acc) return setError('请输入账号（用户名或邮箱）');
      if (!password) return setError('请输入密码');
    } else {
      if (name.length < 3) return setError('用户名至少需要 3 个字符');
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return setError('邮箱格式不正确，请检查');
      if (!password) return setError('请输入密码');
      if (password.length < 8) return setError('密码至少需要 8 位');
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        await signIn(acc, password);
      } else {
        await signUp(name, mail, password);
      }
      // 成功后由上层自动切换到主界面，无需额外提示
    } catch (err) {
      setError((err && err.message) || '操作失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>英语语料积累</Text>
        <Text style={styles.subtitle}>拍照识词 · 单词本 · 艾宾浩斯背单词</Text>

        {mode === 'register' && (
          <TextInput
            style={styles.input}
            placeholder="用户名（至少3字符）"
            value={username}
            onChangeText={edit(setUsername)}
          />
        )}
        {mode === 'register' && (
          <TextInput
            style={styles.input}
            placeholder="邮箱（可选）"
            value={email}
            onChangeText={edit(setEmail)}
            autoCapitalize="none"
          />
        )}
        <TextInput
          style={styles.input}
          placeholder={mode === 'login' ? '账号（用户名或邮箱）' : '账号（以此登录）'}
          value={account}
          onChangeText={edit(setAccount)}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="密码（至少8位）"
          value={password}
          onChangeText={edit(setPassword)}
          secureTextEntry
        />

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity style={styles.primaryBtn} onPress={handleSubmit} disabled={loading}>
          <Text style={styles.primaryBtnText}>{loading ? '请稍候…' : mode === 'login' ? '登录' : '注册'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError('');
          }}
          style={{ marginTop: 12 }}
        >
          <Text style={styles.switchText}>
            {mode === 'login' ? '还没有账号？去注册' : '已有账号？去登录'}
          </Text>
        </TouchableOpacity>

        {/* ————— 服务器切换（仅手机 App 显示） ————— */}
        {CAN_CHANGE_SERVER_URL && (
          <View style={styles.serverBox}>
            <TouchableOpacity
              style={styles.serverToggle}
              onPress={() => setShowServer((v) => !v)}
              activeOpacity={0.7}
            >
              <Text style={styles.serverToggleText}>
                {showServer ? '▾' : '▸'} 服务器设置
              </Text>
              <Text style={styles.serverToggleAddr} numberOfLines={1}>
                {serverInfo.effective}
              </Text>
            </TouchableOpacity>

            {showServer && (
              <View style={styles.serverPanel}>
                <Text style={styles.serverHint}>
                  默认连接官方服务器。若要使用自建/局域网服务器，请填写完整地址
                  （含 http:// 与端口），保存后本机所有请求都发往新地址。
                </Text>

                <TextInput
                  style={[styles.input, styles.serverInput]}
                  placeholder="例如 http://192.168.1.10:3000"
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />

                <Text style={styles.serverMeta}>
                  当前生效：{serverInfo.effective}
                  {'\n'}来源：{serverInfo.source}
                </Text>

                <View style={styles.serverBtnRow}>
                  <TouchableOpacity
                    style={[styles.serverBtn, savingServer && styles.serverBtnDisabled]}
                    onPress={applyServer}
                    disabled={savingServer}
                  >
                    <Text style={styles.serverBtnText}>
                      {savingServer ? '保存中…' : '保存并切换'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.serverBtnGhost, pinging && styles.serverBtnDisabled]}
                    onPress={testServer}
                    disabled={pinging}
                  >
                    <Text style={styles.serverBtnGhostText}>
                      {pinging ? '测试中…' : '测试连接'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {pingResult && (
                  <View style={[styles.pingBox, pingResult.ok ? styles.pingOk : styles.pingBad]}>
                    <Text style={[styles.pingText, pingResult.ok ? styles.pingOkText : styles.pingBadText]}>
                      {pingResult.ok
                        ? `✅ 可连接（${pingResult.latency_ms} ms）`
                        : `❌ ${pingResult.error || '连接失败'}`}
                    </Text>
                  </View>
                )}

                <TouchableOpacity onPress={restoreDefaultServer} style={styles.serverReset}>
                  <Text style={styles.serverResetText}>恢复默认服务器</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        <Text style={styles.securityNote}>
          密码经 bcrypt 加密后存储，服务器不保存明文，请放心。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f7fb' },
  container: { padding: 24, justifyContent: 'center', flexGrow: 1 },
  title: { fontSize: 30, fontWeight: '700', textAlign: 'center', color: '#1e293b' },
  subtitle: { fontSize: 14, textAlign: 'center', color: '#64748b', marginTop: 6, marginBottom: 32 },
  input: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  primaryBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 6,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginTop: 2,
    marginBottom: 4,
  },
  errorText: { color: '#b91c1c', fontSize: 14, lineHeight: 20 },
  primaryBtnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  switchText: { textAlign: 'center', color: '#2563eb', fontSize: 15 },
  // —— 服务器设置 ——
  serverBox: {
    marginTop: 22,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  serverToggle: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  serverToggleText: { fontSize: 14, fontWeight: '600', color: '#475569' },
  serverToggleAddr: { flex: 1, textAlign: 'right', fontSize: 12, color: '#94a3b8' },
  serverPanel: { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  serverHint: { fontSize: 12, color: '#94a3b8', lineHeight: 18, marginTop: 12 },
  serverInput: { marginTop: 10, marginBottom: 8, fontSize: 14, paddingVertical: 11 },
  serverMeta: { fontSize: 12, color: '#64748b', lineHeight: 18 },
  serverBtnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  serverBtn: { flex: 1, backgroundColor: '#2563eb', borderRadius: 9, paddingVertical: 12, alignItems: 'center' },
  serverBtnGhost: {
    flex: 1, backgroundColor: '#fff', borderRadius: 9, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1, borderColor: '#bfdbfe',
  },
  serverBtnDisabled: { backgroundColor: '#cbd5e1', borderColor: '#cbd5e1' },
  serverBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  serverBtnGhostText: { color: '#2563eb', fontSize: 15, fontWeight: '600' },
  pingBox: { borderRadius: 8, padding: 10, marginTop: 10, borderWidth: 1 },
  pingOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  pingBad: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  pingText: { fontSize: 12, lineHeight: 18 },
  pingOkText: { color: '#166534' },
  pingBadText: { color: '#b91c1c' },
  serverReset: { alignSelf: 'center', marginTop: 12, paddingVertical: 4 },
  serverResetText: { color: '#dc2626', fontSize: 13, fontWeight: '600' },
  securityNote: { textAlign: 'center', color: '#94a3b8', fontSize: 12, marginTop: 24 },
});