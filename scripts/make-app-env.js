/**
 * 从项目根目录 .env 生成 app/.env
 *
 * 为什么需要：EAS 云端构建只会上传 app/ 目录，根目录的 .env 到不了构建机，
 * 会导致打出来的 APK 不知道后端地址。构建 APK 前先执行本脚本把地址同步过去。
 *
 * 你手改配置时仍然只需要改**根目录 .env**，本文件是自动生成的产物。
 *
 * 用法：node scripts/make-app-env.js
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const rootEnvPath = path.join(rootDir, '.env');
const appEnvPath = path.join(rootDir, 'app', '.env');

if (!fs.existsSync(rootEnvPath)) {
  console.error('找不到根目录 .env，请先执行：cp .env.example .env 并填写配置');
  process.exit(1);
}

/** 极简 .env 解析 */
const env = {};
for (const rawLine of fs.readFileSync(rootEnvPath, 'utf8').split(/\r?\n/)) {
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
  env[key] = val;
}

function deriveApiUrl() {
  const scheme = String(env.SERVER_SCHEME || 'http').trim() || 'http';
  const host = String(env.SERVER_HOST || '').trim();
  const port = String(env.SERVER_PORT || '').trim();
  if (!host) return '';
  const isDefaultPort =
    (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const portPart = port && !isDefaultPort ? `:${port}` : '';
  return `${scheme}://${host}${portPart}`;
}

const explicit = String(env.EXPO_PUBLIC_API_URL || '').trim();
const apiUrl = explicit || deriveApiUrl();

if (!apiUrl) {
  console.error('无法确定后端地址：请检查根目录 .env 里的 SERVER_HOST / SERVER_PORT / SERVER_SCHEME');
  process.exit(1);
}

const content =
  [
    '# 本文件由 scripts/make-app-env.js 从项目根目录 .env 自动生成，请勿手改。',
    `# 生成时间：${new Date().toISOString()}`,
    `EXPO_PUBLIC_API_URL=${apiUrl}`,
    '',
  ].join('\n');

fs.writeFileSync(appEnvPath, content, 'utf8');
console.log(`已生成 app/.env  ->  EXPO_PUBLIC_API_URL=${apiUrl}`);
