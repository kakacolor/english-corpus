/**
 * Expo 应用配置（会覆盖 app.json）
 *
 * 全局配置统一放在**项目根目录**的 .env 里（见根目录 .env / .env.example）。
 * 读取顺序：
 *   1) ../.env          —— 项目根目录 .env（本地开发 / Web 构建的唯一权威来源）
 *   2) ./.env           —— app 目录内的 .env（由 scripts/make-app-env.js 生成，
 *                          供 EAS 云端构建使用：EAS 只上传 app/ 目录，根 .env 到不了构建机）
 *
 * 前端要访问的后端地址来源（优先级从高到低）：
 *   1) EXPO_PUBLIC_API_URL（显式指定，一般留空）
 *   2) 由 SERVER_SCHEME + SERVER_HOST + SERVER_PORT 自动拼出
 * 因此迁移服务器时只改根目录 .env 的 SERVER_HOST 即可，无需动前端代码。
 */
const path = require('path');
const fs = require('fs');

/** 极简 .env 解析（不依赖 dotenv，避免构建机上依赖缺失）；已存在的同名变量会被覆盖 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  return true;
}

const rootEnvPath = path.join(__dirname, '..', '.env');
const appEnvPath = path.join(__dirname, '.env');

let envSource;
if (loadEnvFile(rootEnvPath)) {
  envSource = '根目录 .env';
} else if (loadEnvFile(appEnvPath)) {
  envSource = 'app/.env（由根目录 .env 生成）';
} else {
  envSource = '未找到 .env';
}

/** 由 SERVER_SCHEME / SERVER_HOST / SERVER_PORT 拼出后端地址 */
function deriveApiUrl() {
  const scheme = String(process.env.SERVER_SCHEME || 'http').trim() || 'http';
  const host = String(process.env.SERVER_HOST || '').trim();
  const port = String(process.env.SERVER_PORT || '').trim();
  if (!host) return '';
  // 80/443 是协议默认端口，不写出来更干净
  const isDefaultPort =
    (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const portPart = port && !isDefaultPort ? `:${port}` : '';
  return `${scheme}://${host}${portPart}`;
}

const explicitApiUrl = String(process.env.EXPO_PUBLIC_API_URL || '').trim();
const apiUrl = explicitApiUrl || deriveApiUrl();

const configSource = explicitApiUrl
  ? `${envSource}（EXPO_PUBLIC_API_URL 显式指定）`
  : `${envSource}（由 SERVER_HOST / SERVER_PORT / SERVER_SCHEME 自动推导）`;

// 回填到 process.env，供 Metro 打包时内联（process.env.EXPO_PUBLIC_API_URL）
if (apiUrl) {
  process.env.EXPO_PUBLIC_API_URL = apiUrl;
}

const appJson = require('./app.json');

module.exports = {
  ...appJson,
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra || {}),
      // 运行时可通过 expo-constants 读取：Constants.expoConfig?.extra?.apiUrl
      apiUrl,
      configSource,
      serverHost: String(process.env.SERVER_HOST || ''),
      serverPort: String(process.env.SERVER_PORT || ''),
      serverScheme: String(process.env.SERVER_SCHEME || ''),
    },
  },
};
