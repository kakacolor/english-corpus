import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 跨平台本地存储：
 *  - 原生端使用 AsyncStorage（原生 SQLite/文件存储）
 *  - Web 端使用 window.localStorage（@react-native-async-storage 在浏览器里不工作）
 */
async function getItem(key) {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key);
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }
  return AsyncStorage.getItem(key);
}

async function setItem(key, value) {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch (_) {
      /* ignore */
    }
    return;
  }
  await AsyncStorage.setItem(key, value);
}

async function removeItem(key) {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key);
      }
    } catch (_) {
      /* ignore */
    }
    return;
  }
  await AsyncStorage.removeItem(key);
}

export default { getItem, setItem, removeItem };