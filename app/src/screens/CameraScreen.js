import React, { useRef, useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image, ActivityIndicator, ScrollView, Platform,
} from 'react-native';
// 注意：必须从 expo-camera/next 导入 CameraView 与 useCameraPermissions。
// 顶层 'expo-camera'（build/index.js）只导出旧版 Camera，其 CameraView 为 undefined，
// 原生端授权后渲染 <CameraView/> 会因类型无效而崩溃/白屏（web 因不渲染 CameraView 未暴露）。
import { CameraView, useCameraPermissions } from 'expo-camera/next';
import * as ImagePicker from 'expo-image-picker';
import { apiFetch } from '../api';
import { notify } from '../utils/dialog';

export default function CameraScreen() {
  const cameraRef = useRef(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);

  async function handleShoot() {
    if (!cameraRef.current) { notify('提示', '相机尚未就绪，请稍候'); return; }
    if (!cameraReady) { notify('提示', '相机预览尚未就绪，请稍候'); return; }
    try {
      const pic = await cameraRef.current.takePictureAsync({ quality: 0.7, base64: true });
      setPhoto(pic.uri);
      setResult(null);
    } catch (err) {
      notify('拍照失败', err.message);
    }
  }

  async function pickFromLibrary() {
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true });
    if (res.canceled || !res.assets?.length) return;
    setPhoto(res.assets[0].uri);
    setResult(null);
  }

  async function recognize() {
    if (!photo) { notify('提示', '请先拍照或选择照片'); return; }
    setProcessing(true);
    setResult(null);
    try {
      const form = new FormData();
      if (Platform.OS === 'web') {
        // Web 端：将照片转成 Blob 直接追加，浏览器才能正确 multipart 上传
        const file = await fetch(photo);
        const blob = await file.blob();
        form.append('image', blob, 'photo.jpg');
      } else {
        // 原生端：使用 { uri, name, type } 对象（React Native 网络层会读取 uri 上传）
        form.append('image', { uri: photo, name: 'photo.jpg', type: 'image/jpeg' });
      }

      const resp = await apiFetch('/api/ai/recognize', { method: 'POST', body: form });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '识别失败');
      setResult(data);
    } catch (err) {
      notify('识别失败', err.message);
    } finally {
      setProcessing(false);
    }
  }

  function reset() {
    setPhoto(null);
    setResult(null);
  }

  // Web 端走"相册"选图流程，不需要相机权限；原生端才需要相机权限
  const webNoCamera = Platform.OS === 'web';

  if (!webNoCamera && !permission?.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>需要相机权限才能拍照识词</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>授予相机权限</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {!photo ? (
        <View style={styles.cameraWrap}>
          {Platform.OS === 'web' ? (
            <View style={styles.webPlaceholder}>
              <Text style={styles.webPlaceholderTitle}>拍照识词</Text>
              <Text style={styles.hint}>浏览器里无法直接调用摄像头，请从「相册」选择一张圈出单词的照片。</Text>
            </View>
          ) : cameraError ? (
            <View style={styles.cameraErrorWrap}>
              <Text style={styles.cameraErrorText}>相机启动失败：{cameraError}</Text>
              <TouchableOpacity style={styles.btn} onPress={() => setCameraError(null)}>
                <Text style={styles.btnText}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="back"
              onCameraReady={() => setCameraReady(true)}
              onMountError={(e) => setCameraError(e?.message || '相机不可用')}
            />
          )}
          <Text style={styles.hint}>对准照片，确保用红笔圈出的单词清晰可辨</Text>
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.btn} onPress={pickFromLibrary}>
              <Text style={styles.btnText}>相册</Text>
            </TouchableOpacity>
            {Platform.OS !== 'web' && (
              <TouchableOpacity style={[styles.btn, styles.shootBtn]} onPress={handleShoot}>
                <Text style={styles.btnText}>拍照</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ) : (
        <ScrollView>
          <Image source={{ uri: photo }} style={styles.preview} />
          {!processing && !result && (
            <View style={styles.btnRow}>
              <TouchableOpacity style={styles.btn} onPress={reset}>
                <Text style={styles.btnText}>重拍</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.shootBtn]} onPress={recognize}>
                <Text style={styles.btnText}>开始识别</Text>
              </TouchableOpacity>
            </View>
          )}

          {processing && <ActivityIndicator size="large" style={{ marginTop: 24 }} />}

          {result && (
            <View style={styles.resultBox}>
              <Text style={styles.resultTitle}>识别到 {result.items?.length || 0} 个单词，已加入单词本</Text>
              {(result.items || []).map((it, idx) => (
                <View key={idx} style={styles.resultItem}>
                  <Text style={styles.resultWord}>{it.word}</Text>
                  <Text style={styles.resultLine}>本次积累：{it.annotated_meaning}</Text>
                  <Text style={styles.resultLine}>词典释义：{it.dict_meaning}</Text>
                </View>
              ))}
              <TouchableOpacity style={styles.doneBtn} onPress={reset}>
                <Text style={styles.btnText}>再拍一张</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a', padding: 24 },
  centerText: { color: '#cbd5e1', marginBottom: 16, fontSize: 15 },
  cameraWrap: { flex: 1 },
  camera: { flex: 1 },
  cameraErrorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111827', paddingHorizontal: 24 },
  cameraErrorText: { color: '#fecaca', fontSize: 15, textAlign: 'center', marginBottom: 16 },
  webPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111827', paddingHorizontal: 24 },
  webPlaceholderTitle: { fontSize: 22, fontWeight: '700', color: '#f1f5f9', marginBottom: 12 },
  hint: { color: '#e2e8f0', textAlign: 'center', paddingVertical: 10, backgroundColor: 'rgba(15,23,42,0.7)' },
  btnRow: { flexDirection: 'row', justifyContent: 'space-around', padding: 16, backgroundColor: '#0f172a' },
  btn: { backgroundColor: '#334155', borderRadius: 10, paddingHorizontal: 28, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  shootBtn: { backgroundColor: '#2563eb' },
  doneBtn: { backgroundColor: '#2563eb', borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  preview: { width: '100%', height: 320, backgroundColor: '#000' },
  resultBox: { backgroundColor: '#fff', borderRadius: 14, padding: 16, margin: 12 },
  resultTitle: { fontSize: 16, fontWeight: '700', color: '#16a34a', marginBottom: 12 },
  resultItem: { borderTopWidth: 1, borderColor: '#eef2f7', paddingVertical: 10 },
  resultWord: { fontSize: 18, fontWeight: '700', color: '#1e293b' },
  resultLine: { fontSize: 14, color: '#475569', marginTop: 2 },
});