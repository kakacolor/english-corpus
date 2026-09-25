import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native';
import { apiFetch, getAuthToken } from '../api';
import storage from '../storage';
import { useAuth } from '../auth/AuthContext';
import { notify } from '../utils/dialog';

const DEVICE_KEY = 'english_corpus_device_id';
const CURSOR_KEY = 'english_corpus_sync_cursor';

function makeDeviceId() {
  // 生成并持久化一个稳定的设备标识（跨启动保持一致）
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 数据同步页：
 * 拉取远端增量并记录游标，下次只拉新增内容，实现真正的多端增量同步。
 * 写入集中在服务器，故这里做「拉取远端到本机」为主。
 */
export default function SyncScreen() {
  const { user, signOut } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [lastInfo, setLastInfo] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [init, setInit] = useState(false);

  useEffect(() => {
    (async () => {
      let dev = await storage.getItem(DEVICE_KEY);
      if (!dev) {
        dev = makeDeviceId();
        await storage.setItem(DEVICE_KEY, dev);
      }
      const cur = await storage.getItem(CURSOR_KEY);
      setDeviceId(dev);
      setCursor(cur || null);
      setInit(true);
    })();
  }, []);

  async function doSync() {
    if (!deviceId) { notify('提示', '设备初始化中，请稍候'); return; }
    setSyncing(true);
    try {
      const token = getAuthToken();
      const lastSync = cursor || '2000-01-01T00:00:00Z';
      const resp = await apiFetch(`/api/sync/pull?last_sync=${encodeURIComponent(lastSync)}&device_id=${encodeURIComponent(deviceId)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);

      // 用服务器时间作为下一次游标，只拉更新的内容
      const nextCursor = data.server_time;
      await storage.setItem(CURSOR_KEY, nextCursor);
      setCursor(nextCursor);

      const delta = data.entries.length;
      setLastInfo({
        entries: data.entries.length,
        reviews: data.reviews.length,
        time: data.server_time,
        isFull: !cursor,
      });
      notify(
        '同步完成',
        cursor
          ? `本次增量 ${delta} 条单词（上次同步之后）`
          : `已全量拉取 ${delta} 条单词到本机`
      );
    } catch (err) {
      notify('同步失败', err.message);
    } finally {
      setSyncing(false);
    }
  }

  if (!init) return <ActivityIndicator style={{ marginTop: 60 }} />;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>数据同步</Text>
      <Text style={styles.subtitle}>
        登录账号：{user?.username}\n不同设备登录同一账号即可访问同一条数据，此处将本机与服务器对齐。
      </Text>

      {lastInfo && (
        <View style={styles.infoBox}>
          <Text style={styles.infoLine}>最近同步：{lastInfo.time}</Text>
          <Text style={styles.infoLine}>本次拉取：{lastInfo.entries} 条单词 / {lastInfo.reviews} 条复习</Text>
          <Text style={styles.infoLine}>模式：{lastInfo.isFull ? '首次全量同步' : '增量同步'}</Text>
        </View>
      )}

      {cursor && (
        <Text style={styles.cursorText}>本地游标：{cursor}</Text>
      )}

      <TouchableOpacity style={styles.syncBtn} onPress={doSync} disabled={syncing || !deviceId}>
        {syncing ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>立即同步</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.outBtn} onPress={() => signOut()}>
        <Text style={styles.outText}>退出登录</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#f5f7fb', padding: 24, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: '#1e293b', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 10, marginBottom: 24, lineHeight: 22 },
  infoBox: { backgroundColor: '#eef2ff', borderRadius: 12, padding: 16, marginBottom: 16 },
  infoLine: { fontSize: 14, color: '#3730a3', marginVertical: 2 },
  cursorText: { fontSize: 12, color: '#94a3b8', textAlign: 'center', marginBottom: 16 },
  syncBtn: { backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 15, alignItems: 'center', height: 52 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  outBtn: { marginTop: 16, alignItems: 'center' },
  outText: { color: '#dc2626', fontSize: 15 },
});