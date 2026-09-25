import React, { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native';
import { apiFetch } from '../api';
import { notify } from '../utils/dialog';

/**
 * 根据词形字段组装展示列表：动词→三单/过去式/过去分词/ing；名词→复数；形/副→比较级/最高级。
 * 只展示非空字段；词性未知时按字段有什么展示什么，兼容历史数据。
 */
function buildForms(item) {
  const groups = [];
  const verb = [
    ['三单', item.third_person],
    ['过去式', item.past_tense],
    ['过去分词', item.past_participle],
    ['ing', item.ing_form],
  ].filter(([, v]) => v);
  if (verb.length) groups.push({ title: '动词变化', rows: verb });

  const noun = [['复数', item.plural]].filter(([, v]) => v);
  if (noun.length) groups.push({ title: '名词变化', rows: noun });

  const adj = [
    ['比较级', item.comparative],
    ['最高级', item.superlative],
  ].filter(([, v]) => v);
  if (adj.length) groups.push({ title: '词形变化', rows: adj });

  return groups;
}

export default function ReviewScreen() {
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({ passed: 0, missed: 0 });
  const [today, setToday] = useState(null);

  const loadStats = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/review/stats');
      const data = await resp.json();
      if (resp.ok) setToday(data);
    } catch (err) { /* 统计加载失败不影响主流程 */ }
  }, []);

  const loadToday = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch('/api/review/today');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      setQueue(data.list);
      setIndex(0);
      setShowAnswer(false);
      setStats({ passed: 0, missed: 0 });
    } catch (err) {
      notify('出错了', err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次 tab 获得焦点都重新拉取今日待复习 + 统计，避免切回时数据陈旧
  useFocusEffect(useCallback(() => { loadToday(); loadStats(); }, [loadToday, loadStats]));

  async function submit(remembered) {
    const item = queue[index];
    try {
      await apiFetch('/api/review/submit', {
        method: 'POST',
        body: { entry_id: item.id, remembered },
      });
      setStats((s) => ({ passed: s.passed + (remembered ? 1 : 0), missed: s.missed + (remembered ? 0 : 1) }));
      if (index + 1 < queue.length) {
        setIndex(index + 1);
        setShowAnswer(false);
      } else {
        // 本轮复习结束
        notify('本轮完成', `记住 ${stats.passed + (remembered ? 1 : 0)} 个，忘记 ${stats.missed + (remembered ? 0 : 1)} 个`);
        loadToday();
        loadStats();
      }
    } catch (err) {
      notify('提交失败', err.message);
    }
  }

  if (loading) return <ActivityIndicator style={{ marginTop: 60 }} />;

  const statsPanel = today ? (
    <View style={styles.statsPanel}>
      <View style={styles.statCell}>
        <Text style={styles.statNum}>{today.learned_today}</Text>
        <Text style={styles.statLabel}>今日已背</Text>
      </View>
      <View style={styles.statCell}>
        <Text style={styles.statNum}>{today.due_now}</Text>
        <Text style={styles.statLabel}>待复习</Text>
      </View>
      <View style={styles.statCell}>
        <Text style={styles.statNum}>{today.mastered}</Text>
        <Text style={styles.statLabel}>已掌握</Text>
      </View>
      <View style={styles.statCell}>
        <Text style={styles.statNum}>{today.words_total}</Text>
        <Text style={styles.statLabel}>总单词</Text>
      </View>
    </View>
  ) : null;

  if (queue.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.center}>
        {statsPanel}
        <Text style={styles.emptyTitle}>今日已没有待复习的单词 🎉</Text>
        <Text style={styles.emptySub}>新加入的单词会立即进入复习队列。</Text>
        <TouchableOpacity style={styles.btn} onPress={() => { loadToday(); loadStats(); }}>
          <Text style={styles.btnText}>刷新</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  const item = queue[index];

  return (
    <View style={styles.container}>
      {statsPanel}
      <View style={styles.topBar}>
        <Text style={styles.progress}>第 {index + 1} / {queue.length} 个</Text>
        <Text style={styles.stat}>✓{stats.passed} ✗{stats.missed}</Text>
      </View>

      <ScrollView style={styles.card} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <View style={styles.wordRow}>
          <Text style={styles.major}>{item.word}</Text>
          {item.pos ? <Text style={styles.posTag}>{item.pos}</Text> : null}
        </View>
        {item.phonetic ? <Text style={styles.phonetic}>{item.phonetic}</Text> : null}

        {showAnswer && (
          <View style={styles.answerBox}>
            <Text style={styles.answerLine}>本次积累：{item.user_meaning}</Text>
            {item.dict_meaning ? <Text style={styles.answerLine}>词典：{item.dict_meaning}</Text> : null}
            {item.example ? <Text style={styles.example}>{item.example}</Text> : null}

            {(() => {
              const groups = buildForms(item);
              if (!groups.length) return null;
              return groups.map((g) => (
                <View key={g.title} style={styles.formGroup}>
                  <Text style={styles.formTitle}>{g.title}</Text>
                  <View style={styles.formRows}>
                    {g.rows.map(([label, value]) => (
                      <View key={label} style={styles.formCell}>
                        <Text style={styles.formLabel}>{label}</Text>
                        <Text style={styles.formValue}>{value}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ));
            })()}
          </View>
        )}
      </ScrollView>

      {!showAnswer ? (
        <TouchableOpacity style={styles.revealBtn} onPress={() => setShowAnswer(true)}>
          <Text style={styles.btnText}>显示答案</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.btnRow}>
          <TouchableOpacity style={[styles.btn, styles.missBtn]} onPress={() => submit(false)}>
            <Text style={styles.btnText}>忘了</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.hitBtn]} onPress={() => submit(true)}>
            <Text style={styles.btnText}>记住了</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f7fb', padding: 16 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#f5f7fb' },
  statsPanel: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 14, paddingVertical: 14, marginBottom: 14, borderWidth: 1, borderColor: '#eef2f7' },
  statCell: { flex: 1, alignItems: 'center' },
  statNum: { fontSize: 18, fontWeight: '800', color: '#2563eb' },
  statLabel: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#16a34a' },
  emptySub: { color: '#64748b', textAlign: 'center', marginTop: 8, marginBottom: 20 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  progress: { color: '#475569', fontWeight: '600' },
  stat: { color: '#2563eb', fontWeight: '600' },
  card: {
    flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 24, marginBottom: 16,
    borderWidth: 1, borderColor: '#eef2f7',
  },
  wordRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' },
  major: { fontSize: 40, fontWeight: '800', color: '#1e293b' },
  word: { fontSize: 40, fontWeight: '800', color: '#1e293b', textAlign: 'center' },
  posTag: { fontSize: 13, fontWeight: '700', color: '#7c3aed', backgroundColor: '#f3e8ff', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginLeft: 10, marginTop: 6 },
  phonetic: { fontSize: 15, color: '#94a3b8', textAlign: 'center', marginTop: 4 },
  answerBox: { marginTop: 32, borderTopWidth: 1, borderColor: '#eef2f7', paddingTop: 20 },
  answerLine: { fontSize: 17, color: '#334155', marginBottom: 8, textAlign: 'center' },
  example: { fontSize: 14, color: '#94a3b8', textAlign: 'center', fontStyle: 'italic', marginTop: 6 },
  formGroup: { marginTop: 14, backgroundColor: '#f8fafc', borderRadius: 12, padding: 14 },
  formTitle: { fontSize: 12, color: '#94a3b8', fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  formRows: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  formCell: { minWidth: 90, alignItems: 'center', marginHorizontal: 6, marginVertical: 4 },
  formLabel: { fontSize: 11, color: '#94a3b8' },
  formValue: { fontSize: 16, color: '#1e293b', fontWeight: '700', marginTop: 2 },
  revealBtn: { backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  btnRow: { flexDirection: 'row', justifyContent: 'space-between' },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginHorizontal: 6 },
  missBtn: { backgroundColor: '#dc2626' },
  hitBtn: { backgroundColor: '#16a34a' },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});