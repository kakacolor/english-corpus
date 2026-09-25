import React, { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  Platform, Modal, ScrollView, Switch,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { apiFetch, API_URL } from '../api';
import { notify, confirmDialog, chooseDialog } from '../utils/dialog';

const EMPTY_FORM = {
  word: '', meaning: '', dict: '', phonetic: '', example: '', note: '',
  pos: '', third_person: '', past_tense: '', past_participle: '', ing_form: '',
  plural: '', comparative: '', superlative: '',
};

// 「更多属性」里的输入行：[字段名, 占位提示]
const MORE_ROWS = [
  ['pos', '词性（如 n. / v. / adj. / adv.）'],
  ['third_person', '三单（动词第三人称单数）'],
  ['past_tense', '过去式（动词）'],
  ['past_participle', '过去分词（动词）'],
  ['ing_form', 'ing 形式（动词现在分词）'],
  ['plural', '复数（名词）'],
  ['comparative', '比较级（形容词/副词）'],
  ['superlative', '最高级（形容词/副词）'],
];

export default function WordbookScreen() {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 新增/编辑弹窗：editId 为 null 表示新增，否则为编辑该条记录
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [skipExisting, setSkipExisting] = useState(true);
  const [saving, setSaving] = useState(false);
  // 词性 / 词形变化等「更多属性」是否展开；编辑已有单词时默认展开
  const [moreOpen, setMoreOpen] = useState(false);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiFetch(`/api/vocab?page=1&pageSize=100&search=${encodeURIComponent(search)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      setList(data.list);
      setTotal(data.total);
    } catch (err) {
      notify('出错了', err.message);
    } finally {
      setLoading(false);
    }
  }, [search]);

  // 每次 tab 获得焦点都重新拉取单词本，避免「拍照识别/手动新增」后切回不刷新。
  // 之前的 useEffect 只在首次挂载时执行一次，tab 保持挂载导致返回时数据陈旧（手机+网页皆受影响）。
  useFocusEffect(useCallback(() => { load(); }, [load]));

  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setMoreOpen(false);
    setShowForm(true);
  }

  function openEdit(item) {
    setEditId(item.id);
    // 编辑时若已有任一词形属性则默认展开，否则收起不打扰
    setMoreOpen(
      Boolean(
        item.pos || item.third_person || item.past_tense || item.past_participle
        || item.ing_form || item.plural || item.comparative || item.superlative
      )
    );
    setForm({
      word: item.word || '',
      meaning: item.user_meaning || '',
      dict: item.dict_meaning || '',
      phonetic: item.phonetic || '',
      example: item.example || '',
      note: item.note || '',
      pos: item.pos || '',
      third_person: item.third_person || '',
      past_tense: item.past_tense || '',
      past_participle: item.past_participle || '',
      ing_form: item.ing_form || '',
      plural: item.plural || '',
      comparative: item.comparative || '',
      superlative: item.superlative || '',
    });
    setShowForm(true);
  }

  async function submitForm() {
    const word = form.word.trim();
    const meaning = form.meaning.trim();
    if (!word || !meaning) { notify('提示', '请填写单词和本次积累的中文意思'); return; }

    setSaving(true);
    try {
      const payload = {
        word,
        user_meaning: meaning,
        dict_meaning: form.dict.trim(),
        phonetic: form.phonetic.trim(),
        example: form.example.trim(),
        note: form.note.trim(),
        pos: form.pos.trim(),
        third_person: form.third_person.trim(),
        past_tense: form.past_tense.trim(),
        past_participle: form.past_participle.trim(),
        ing_form: form.ing_form.trim(),
        plural: form.plural.trim(),
        comparative: form.comparative.trim(),
        superlative: form.superlative.trim(),
      };

      let resp;
      if (editId) {
        resp = await apiFetch(`/api/vocab/${editId}`, { method: 'PUT', body: payload });
      } else {
        // 新增时可选择「已积累则跳过」，避免覆盖之前积累的意思
        payload.if_exists = skipExisting ? 'skip' : 'overwrite';
        resp = await apiFetch('/api/vocab', { method: 'POST', body: payload });
      }

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '保存失败');

      setShowForm(false);
      if (!editId && data.skipped) {
        notify('已跳过', `单词「${word}」已经在单词本里了，已自动跳过，未改动原记录。`);
      } else {
        notify('已保存', editId ? `单词「${word}」已更新` : `单词「${word}」已加入单词本并进入复习队列`);
      }
      load();
    } catch (err) {
      notify('保存失败', err.message);
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(item) {
    confirmDialog({
      title: '删除单词',
      message: `确定删除「${item.word}」吗？此操作不可恢复。`,
      confirmText: '删除',
      destructive: true,
      onConfirm: async () => {
        try {
          const resp = await apiFetch(`/api/vocab/${item.id}`, { method: 'DELETE' });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || '删除失败');
          load();
        } catch (err) {
          notify('删除失败', err.message);
        }
      },
    });
  }

  // 用文本 AI 补全缺失的例句与词形变化的功能已移到 设置 → AI 接口 → 文本AI，
  // 单词本页不再保留入口（避免误点造成长时间等待）

  async function uploadExcel(skipExistingRows) {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.ms-excel'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.length) return;

      setImporting(true);
      const file = res.assets[0];
      const form2 = new FormData();
      if (Platform.OS === 'web') {
        form2.append('file', file.file, file.name);
      } else {
        form2.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (skipExistingRows) form2.append('skip_existing', '1');

      const resp = await apiFetch('/api/vocab/import', { method: 'POST', body: form2 });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      const parts = [`新增 ${data.inserted} 条`];
      if (data.existing_skipped) parts.push(`跳过已积累 ${data.existing_skipped} 条`);
      if (data.skipped) parts.push(`跳过无效 ${data.skipped} 条`);
      if (data.empty_rows) parts.push(`忽略空行 ${data.empty_rows} 行`);
      notify('导入完成', parts.join('，'));
      load();
    } catch (err) {
      notify('导入失败', err.message);
    } finally {
      setImporting(false);
    }
  }

  // 先选导入方式，再选文件
  function pickExcel() {
    chooseDialog({
      title: '导入 Excel',
      message: '如果 Excel 里的单词已经在单词本中，要怎么处理？',
      options: [
        { text: '跳过已积累', onPress: () => uploadExcel(true) },
        { text: '覆盖更新', onPress: () => uploadExcel(false) },
      ],
    });
  }

  async function exportExcel() {
    setExporting(true);
    try {
      const resp = await apiFetch('/api/vocab/export');
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || '导出失败');
      }
      if (Platform.OS === 'web') {
        // Web 端把 Blob 下载到本地
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'vocabulary.xlsx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        notify('导出成功', '已下载 vocabulary.xlsx');
      } else {
        // 原生端：把 base64 数据写入缓存目录，再用系统分享保存到本地
        const b64 = await resp.blob().then((b) => {
          return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(',')[1]);
            fr.onerror = reject;
            fr.readAsDataURL(b);
          });
        });
        const FileSystem = require('expo-file-system');
        const Sharing = require('expo-sharing');
        const fileUri = `${FileSystem.cacheDirectory}vocabulary.xlsx`;
        await FileSystem.writeAsStringAsync(fileUri, b64, { encoding: FileSystem.EncodingType.Base64 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        } else {
          notify('导出成功', '文件已保存到缓存目录');
        }
      }
    } catch (err) {
      notify('导出失败', err.message);
    } finally {
      setExporting(false);
    }
  }

  // 单词卡片上的一行词形变化摘要（只列已填写的）
  const formsSummary = (item) => {
    const parts = [
      item.third_person && `三单 ${item.third_person}`,
      item.past_tense && `过去式 ${item.past_tense}`,
      item.past_participle && `过去分词 ${item.past_participle}`,
      item.ing_form && `ing ${item.ing_form}`,
      item.plural && `复数 ${item.plural}`,
      item.comparative && `比较级 ${item.comparative}`,
      item.superlative && `最高级 ${item.superlative}`,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : '';
  };

  const renderItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.word}>{item.word}</Text>
        {item.pos ? <Text style={styles.posTag}>{item.pos}</Text> : null}
        {item.phonetic ? <Text style={styles.phonetic}>{item.phonetic}</Text> : null}
        <View style={styles.cardActions}>
          <TouchableOpacity style={styles.editBtn} onPress={() => openEdit(item)}>
            <Text style={styles.editText}>编辑</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.deleteBtn} onPress={() => confirmDelete(item)}>
            <Text style={styles.deleteText}>删除</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.userMeaning}>本次积累：{item.user_meaning}</Text>
      {item.dict_meaning ? <Text style={styles.dict}>词典：{item.dict_meaning}</Text> : null}
      {formsSummary(item) ? <Text style={styles.formsLine}>{formsSummary(item)}</Text> : null}
      {item.example ? <Text style={styles.example}>例句：{item.example}</Text> : null}
      {item.note ? <Text style={styles.note}>备注：{item.note}</Text> : null}
      <Text style={styles.time}>记录于 {new Date(item.created_at).toLocaleDateString()}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.count}>共 {total} 个单词</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd}>
          <Text style={styles.addBtnText}>＋ 新增</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.row}>
        <TextInput
          style={styles.search}
          placeholder="搜索单词"
          value={search}
          onChangeText={setSearch}
        />
        <TouchableOpacity style={styles.importBtn} onPress={pickExcel} disabled={importing}>
          <Text style={styles.importBtnText}>{importing ? '导入中…' : '导入Excel'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.exportBtn} onPress={exportExcel} disabled={exporting}>
          <Text style={styles.importBtnText}>{exporting ? '导出中…' : '导出'}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(i) => String(i.id)}
          renderItem={renderItem}
          ListEmptyComponent={<Text style={styles.empty}>还没有单词，去「拍照识词」或导入 Excel 吧</Text>}
        />
      )}

      {/* 新增 / 编辑单词弹窗 */}
      <Modal visible={showForm} animationType="slide" transparent onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalMask}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editId ? `编辑单词` : '手动新增单词'}</Text>
            <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
              <TextInput style={styles.input} placeholder="单词 *" value={form.word} onChangeText={(v) => setField('word', v)} autoCapitalize="none" autoCorrect={false} />
              <TextInput style={styles.input} placeholder="本次积累的中文意思 *" value={form.meaning} onChangeText={(v) => setField('meaning', v)} />
              <TextInput style={styles.input} placeholder="词典中的中文意思（可选）" value={form.dict} onChangeText={(v) => setField('dict', v)} />
              <TextInput style={styles.input} placeholder="音标（可选）" value={form.phonetic} onChangeText={(v) => setField('phonetic', v)} autoCapitalize="none" />
              <TextInput style={styles.input} placeholder="例句（可选）" value={form.example} onChangeText={(v) => setField('example', v)} />
              <TextInput style={styles.input} placeholder="备注（可选）" value={form.note} onChangeText={(v) => setField('note', v)} />

              {/* 更多属性：词性 + 词形变化（背单词显示答案时按这些字段额外展示） */}
              <TouchableOpacity style={styles.moreToggle} onPress={() => setMoreOpen((o) => !o)}>
                <Text style={styles.moreToggleText}>
                  {moreOpen ? '▾' : '▸'} 更多属性：词性 / 词形变化（可选）
                </Text>
              </TouchableOpacity>
              {moreOpen && (
                <View style={styles.moreBox}>
                  {MORE_ROWS.map(([key, placeholder]) => (
                    <TextInput
                      key={key}
                      style={styles.input}
                      placeholder={placeholder}
                      value={form[key]}
                      onChangeText={(v) => setField(key, v)}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  ))}
                  <Text style={styles.moreHint}>
                    动词填三单/过去式/过去分词/ing；名词填复数；形容词、副词填比较级/最高级。
                    背单词点击显示答案时会按词性额外展示这些变化。
                  </Text>
                </View>
              )}

              {!editId && (
                <View style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.switchLabel}>自动跳过已积累的单词</Text>
                    <Text style={styles.switchHint}>
                      开启后：单词已存在时不改动原记录；关闭则会用本次填写的内容覆盖。
                    </Text>
                  </View>
                  <Switch
                    value={skipExisting}
                    onValueChange={setSkipExisting}
                    trackColor={{ true: '#2563eb', false: '#cbd5e1' }}
                  />
                </View>
              )}
            </ScrollView>
            <View style={styles.modalBtns}>
              <TouchableOpacity style={[styles.modalBtn, styles.cancelBtn]} onPress={() => setShowForm(false)}>
                <Text style={styles.btnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.saveBtn]} onPress={submitForm} disabled={saving}>
                <Text style={styles.btnText}>{saving ? '保存中…' : '保存'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f5f7fb' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  count: { color: '#64748b' },
  addBtn: { backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  addBtnText: { color: '#fff', fontWeight: '700' },
  row: { flexDirection: 'row', marginBottom: 14 },
  search: { flex: 1, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#e2e8f0', marginRight: 10 },
  importBtn: { backgroundColor: '#16a34a', borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center', marginRight: 8 },
  exportBtn: { backgroundColor: '#0891b2', borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center' },
  importBtnText: { color: '#fff', fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#eef2f7' },
  cardHeader: { flexDirection: 'row', alignItems: 'baseline' },
  word: { fontSize: 18, fontWeight: '700', color: '#1e293b' },
  phonetic: { fontSize: 13, color: '#94a3b8', marginLeft: 8 },
  cardActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' },
  editBtn: { backgroundColor: '#dbeafe', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 },
  editText: { color: '#1d4ed8', fontSize: 12, fontWeight: '600' },
  deleteBtn: { backgroundColor: '#fee2e2', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  deleteText: { color: '#dc2626', fontSize: 12, fontWeight: '600' },
  userMeaning: { fontSize: 15, color: '#334155', marginTop: 6 },
  dict: { fontSize: 13, color: '#64748b', marginTop: 4 },
  example: { fontSize: 13, color: '#64748b', marginTop: 4, fontStyle: 'italic' },
  note: { fontSize: 13, color: '#b45309', marginTop: 4 },
  time: { fontSize: 11, color: '#94a3b8', marginTop: 8 },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 40 },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b', marginBottom: 16 },
  input: { backgroundColor: '#f8fafc', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 10, fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, marginBottom: 4 },
  switchLabel: { fontSize: 14, fontWeight: '600', color: '#334155' },
  switchHint: { fontSize: 12, color: '#94a3b8', marginTop: 2, lineHeight: 17 },
  moreToggle: { paddingVertical: 10, marginBottom: 4 },
  moreToggleText: { fontSize: 14, fontWeight: '600', color: '#2563eb' },
  moreBox: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#eef2f7' },
  moreHint: { fontSize: 12, color: '#94a3b8', lineHeight: 18, marginTop: 2 },
  posTag: { fontSize: 12, fontWeight: '700', color: '#7c3aed', backgroundColor: '#f3e8ff', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginRight: 8 },
  formsLine: { fontSize: 13, color: '#0f766e', marginTop: 6, lineHeight: 19 },
  modalBtns: { flexDirection: 'row', marginTop: 8 },
  modalBtn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginHorizontal: 5 },
  cancelBtn: { backgroundColor: '#e2e8f0' },
  saveBtn: { backgroundColor: '#2563eb' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
