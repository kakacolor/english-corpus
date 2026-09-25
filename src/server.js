require('./loadEnv');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createPool } = require('./db/pool');

const app = express();

// helmet：默认 CSP 含 upgrade-insecure-requests，会把 http 子资源强制升级为 https。
// 当前后端只有明文 HTTP（:3000），一旦升级 bundle 就加载失败导致白屏，故禁用 CSP 相关指令。
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    strictTransportSecurity: false,
  })
);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// 登录接口限流，防止暴力破解
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// 后台管理登录：更严格限流（管理接口权限更大）
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
});
app.use('/api/admin/login', adminLimiter);

// 拍照识别会消耗 AI 接口额度/费用，做更严格的限流防滥用
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 小时
  max: Number(process.env.AI_RECOGNIZE_RATE_LIMIT) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ? `u${req.user.id}` : req.ip,
  message: { error: '识别请求过于频繁，请稍后再试' },
});
app.use('/api/ai/recognize', aiLimiter);

// 简单请求日志（生产环境便于排查；关闭日志可设 LOG_LEVEL=none）
if (process.env.LOG_LEVEL !== 'none') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });
}

// 全局注入 db 连接池
const poolPromise = createPool();

app.use(async (req, res, next) => {
  try {
    req.db = await poolPromise;
    next();
  } catch (err) {
    next(err);
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vocab', require('./routes/vocab'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/review', require('./routes/review'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/admin', require('./routes/admin'));

// 后台管理页（纯静态单文件，访问 http://<服务器>:3000/admin/）
const adminRoot = path.join(__dirname, '..', 'public');
app.use('/admin', express.static(adminRoot));

// Web 前端静态资源（Expo web 构建产物，位于 web/ 目录）
const webRoot = path.join(__dirname, '..', 'web');
app.use(express.static(webRoot));
// SPA 回退：非 /api 的 GET 请求都返回 index.html，交给前端路由处理
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(webRoot, 'index.html'), (err) => {
    if (err) next();
  });
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

// 监听端口：优先 SERVER_PORT（根目录 .env 的「本服务器地址」段），
// 兼容旧的 PORT；都没有时用 3000。
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);

app.listen(PORT, () => {
  // 打印对外访问地址，便于确认 .env 里的 SERVER_HOST/PORT/SCHEME 是否配对
  const scheme = process.env.SERVER_SCHEME || 'http';
  const host = process.env.SERVER_HOST || 'localhost';
  const shownPort = (scheme === 'http' && PORT === 80) || (scheme === 'https' && PORT === 443) ? '' : `:${PORT}`;
  console.log(`英语语料积累后端已启动`);
  console.log(`  监听：0.0.0.0:${PORT}`);
  console.log(`  对外地址：${scheme}://${host}${shownPort}`);
});