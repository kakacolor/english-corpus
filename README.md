# 英语语料积累 · English Corpus

一个可自托管的英语语料积累应用：**拍照 AI 识词 + 单词本（Excel 导入）+ 艾宾浩斯遗忘曲线背单词 + 多端数据同步**。

一套代码同时提供 **Web 版**（浏览器直接用）和 **Android / iOS App**（React Native + Expo），后端是 Node.js + Express + MySQL，所有数据存在你自己的服务器上。

---

## 功能特性

| 模块 | 说明 |
|------|------|
| 账号体系 | 注册 / 登录，JWT 认证，**每个账号数据完全隔离**；密码 bcrypt(12) 加盐哈希 |
| 单词本 | Excel 批量导入、手动增删改、导出 Excel；同一单词自动去重并归并词形 |
| 拍照识词 | 拍照或选相册图片（红笔圈词 + 手写中文意思），调用多模态 AI 识别并自动入库、加入复习计划 |
| 背单词 | 艾宾浩斯遗忘曲线：20分钟 → 1小时 → 9小时 → 1天 → 2天 → 6天 → 15天 → 30天 |
| 多端同步 | 同一账号多端登录，基于时间戳游标的增量同步，重复同步安全 |
| AI 配置 | 用户自己在「设置」里填 API 地址与 Key（OpenAI 兼容），Key 在服务端 AES-256-GCM 加密存储 |
| 安全设置 | 修改密码、重置密码（重置后**所有设备登录态立即失效**） |
| 管理后台 | 独立的单文件后台 `/admin`：用户管理、数据统计、批量删除、授予管理员等 |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js 18+ / Express 4（REST API） |
| 数据库 | MySQL 8.0+（或 MariaDB 10.6+） |
| 前端 / App | React Native 0.73 + Expo 50（一套代码跑 Web / Android / iOS） |
| AI 识词 | 任意 OpenAI 兼容的多模态 `POST {base_url}/chat/completions` 接口 |
| 部署 | 可直接 `node` 运行，或用 `systemd` 守护；提供一键安装脚本 |

---

## 目录结构

```
english-corpus/
├─ src/                        后端（Node.js）
│  ├─ server.js                服务入口：API + 静态站点 + 后台页
│  ├─ loadEnv.js               固定从项目根目录加载 .env
│  ├─ db/
│  │  ├─ pool.js               连接池
│  │  ├─ migrate.js            建表迁移入口（npm run migrate）
│  │  ├─ make-admin.js         授予/撤销管理员
│  │  └─ migrations/*.sql      各版本建表脚本（001~007）
│  ├─ middleware/
│  │  ├─ auth.js               JWT 认证 + 每账号数据隔离
│  │  └─ adminAuth.js          管理员鉴权（每次回库校验）
│  └─ routes/                  auth / vocab / ai / review / sync / admin
├─ app/                        移动端 & Web 前端（Expo）
│  ├─ app.config.js            读取根目录 .env，注入后端地址
│  ├─ App.js
│  └─ src/                     api 客户端 / 登录 / 各功能页面
├─ public/index.html           后台管理页（单文件，访问 /admin）
├─ db/setup-db.sh              按 .env 建库建账号（幂等）
├─ deploy/
│  ├─ install-service.sh       按 .env 生成并安装 systemd 服务
│  ├─ english-corpus.service.template
│  └─ migrate-from-server.sh   从旧服务器拉取数据/配置（可选）
├─ scripts/make-app-env.js     打包 APK 前把根 .env 的后端地址同步到 app/.env
├─ docker-compose.yml          用 Docker 起一个 MySQL（可选）
├─ .env.example                配置模板 ← 所有配置都在这里
├─ sample_导入模板.xlsx         Excel 导入示例
└─ password-reset-test.js      离线回归测试（23 项断言）
```

> **配置只有一处**：项目根目录的 `.env`。后端、前端、部署脚本、docker-compose 全部读它。

---

## 快速开始

### 0. 环境要求

- **Node.js 18+**（推荐 20 / 22 LTS）
- **MySQL 8.0+**（本机或独立数据库服务器均可）
- 可选：Docker（用来快速起数据库）、Nginx（配 HTTPS）

### 1. 获取代码并安装依赖

```bash
git clone https://github.com/colorkaka/english-corpus
cd english-corpus
npm install
```

### 2. 生成配置

```bash
cp .env.example .env
```

生成两个密钥并填入 `.env`：

```bash
node -e "console.log('JWT_SECRET=', require('crypto').randomBytes(64).toString('hex'))"
node -e "console.log('AI_KEY_ENC_SECRET=', require('crypto').randomBytes(32).toString('hex'))"
```

然后编辑 `.env`，至少要改这几项：

```ini
SERVER_HOST=你的服务器IP或域名     # 前端要访问的后端地址由它推导
SERVER_PORT=3000
DB_NAME=english_corpus
DB_USER=english_user
DB_PASSWORD=你设置的强密码
DB_ROOT_PASSWORD=MySQL的root密码   # 仅建库时用得到
JWT_SECRET=刚生成的第一个密钥
AI_KEY_ENC_SECRET=刚生成的第二个密钥
```

> ⚠️ `JWT_SECRET` 改动会让所有已登录用户重新登录；`AI_KEY_ENC_SECRET` 改动会让用户已保存的 AI Key 无法解密。**确定后不要再改**。

### 3. 准备数据库

**方式 A：用 Docker 起一个 MySQL（最省事）**

先在 `.env` 里设置 `DB_ROOT_PASSWORD`，然后：

```bash
docker compose up -d
```

**方式 B：使用已有 MySQL**

在 `.env` 里填好 `DB_HOST` / `DB_PORT` / `DB_ROOT_PASSWORD`，然后执行建库脚本（幂等，可重复运行）：

```bash
sudo bash db/setup-db.sh
```

它会按 `.env` 创建数据库 `DB_NAME` 与账号 `DB_USER`，并授予最小必要权限。

### 4. 建表并启动后端

```bash
npm run migrate     # 建表（可重复执行，已应用的迁移会跳过）
npm start           # 默认监听 SERVER_PORT（3000）
```

验证：

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,...}
```

此时直接访问 `http://服务器IP:3000` 可以看到 Web 前端（需先完成第 5 步构建）。

### 5. 构建 Web 前端

后端会托管 `<项目根目录>/web/` 里的静态文件，所以构建产物要放到那里：

```bash
cd app
npm install
npm run build:web            # 已带 --clear，避免缓存旧地址
cd ..
cp -r app/dist/* web/        # Windows: xcopy app\dist web\ /E /I /Y
```

然后浏览器打开 `http://服务器IP:3000` 即可注册使用。

> 改了 `.env` 里的 `SERVER_HOST` / `SERVER_PORT` 后，**必须重新执行 `npm run build:web`** —— 后端地址是构建时写进前端的。

### 6. 手机 App（可选）

**手机安装包（APK）用 EAS 云端构建**：

```bash
npm install -g eas-cli
eas login                 # 登录你的 Expo 账号
cd ..                     # 回到项目根目录
npm run build:apk         # 自动同步地址并触发云端构建，产出可安装 APK 的下载链接
```

> EAS 只会上传 `app/` 目录，根目录 `.env` 到不了构建机，因此 `build:apk` 会先执行
> `scripts/make-app-env.js`，把根 `.env` 里推导出的后端地址写入 `app/.env`。
> `app/.easignore` 已配置为保留该文件，同时排除 `node_modules` 等大目录。
> 若项目不在 git 仓库中，EAS 会要求初始化仓库；可改用无版本控制模式：
> `EAS_NO_VCS=1 npm run build:apk`。

**本地调试（不用打包）**：

```bash
cd app
npm install
npx expo start        # 手机装 Expo Go 扫码即可用
```

App 登录页内置「服务器设置」，可随时切换后端地址（仅原生 App 显示，Web 版同源访问无需切换）。

### 7. 创建管理员（可选）

注册一个账号后，把它设为管理员：

```bash
node src/db/make-admin.js 你的用户名          # 授予管理员
node src/db/make-admin.js --list             # 查看全部管理员
node src/db/make-admin.js 你的用户名 --revoke # 撤销（至少保留一个）
```

之后访问 `http://服务器IP:3000/admin`，用该账号登录后台。

---

## 配置说明（`.env`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_HOST` | — | **服务器 IP 或域名**。前端要访问的后端地址由它推导 |
| `SERVER_PORT` | `3000` | 后端监听端口，同时作为对外端口 |
| `SERVER_SCHEME` | `http` | `http` 或 `https`（配了证书就改 `https`） |
| `EXPO_PUBLIC_API_URL` | 空 | 留空即用上面三项自动拼成 `<协议>://<主机>:<端口>`；仅当前端地址与推导结果不同（如 Nginx 反代带前缀）时才填 |
| `APP_DIR` | `/opt/english-corpus` | 项目在服务器上的绝对路径（systemd 安装脚本用） |
| `SERVICE_NAME` | `english-corpus` | systemd 服务名 |
| `RUN_USER` | `root` | 后端运行身份（建议普通用户） |
| `NODE_BIN` | 自动探测 | node 可执行文件绝对路径 |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | 数据库地址与端口 |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | — | 数据库名、专用账号、密码 |
| `DB_ROOT_PASSWORD` | 空 | MySQL root 密码，仅建库脚本 / docker-compose 用 |
| `DB_CONTAINER_NAME` | 空 | 数据库跑在 Docker 里时填容器名，`db/setup-db.sh` 会走 `docker exec` |
| `JWT_SECRET` | — | 登录令牌密钥，**必须改** |
| `JWT_EXPIRES_IN` | `7d` | 登录有效期 |
| `AI_KEY_ENC_SECRET` | — | AI Key 加密密钥（64 位十六进制），**必须改** |
| `NODE_ENV` | `production` | 运行环境 |
| `MAX_UPLOAD_MB` | `10` | 单文件上传上限（MB） |
| `AI_RECOGNIZE_RATE_LIMIT` | `50` | 每账号每小时拍照识别次数上限（防刷） |
| `LOG_LEVEL` | `info` | 设为 `none` 关闭请求日志 |
| `OLD_SERVER_*` | 空 | 仅 `deploy/migrate-from-server.sh` 从旧服务器拉数据时使用 |

---

## 生产部署

### 用 systemd 守护（推荐）

`deploy/install-service.sh` 会读取 `.env` 生成 systemd 单元并启动，**不需要手改服务文件**：

```bash
# 先把项目放到 .env 里 APP_DIR 指定的目录，并配好 .env
sudo bash deploy/install-service.sh

systemctl status english-corpus     # 查看状态
journalctl -u english-corpus -f     # 实时日志
```

脚本会打印实际使用的路径、运行用户、node 路径，并做一次健康检查。

### 换服务器 / 迁移

因为配置集中在根目录 `.env`，迁移时**通常只需要改 `.env`**：

1. 把整个项目目录拷到新服务器；
2. 修改 `.env` 的 `SERVER_HOST`（必要时 `APP_DIR`、`RUN_USER`、`DB_*`）；
3. `sudo bash db/setup-db.sh` 建库 → 导入数据 → `npm install && npm run migrate`；
4. `cd app && npm run build:web`，把 `app/dist/*` 放到 `web/`；
5. `sudo bash deploy/install-service.sh`。

> 从旧服务器拉取数据与旧 `.env`：填好 `.env` 里的 `OLD_SERVER_*` 后执行 `bash deploy/migrate-from-server.sh`。

### 启用 HTTPS

建议用 Nginx 反向代理 + Let's Encrypt 证书，然后把 `.env` 改成：

```ini
SERVER_SCHEME=https
SERVER_HOST=你的域名
SERVER_PORT=443
```

改完重新构建前端（`cd app && npm run build:web`）并重启服务。

---

## 使用说明

### 账号
打开站点注册即可（无内置默认账号）。每个账号的单词、复习进度、AI 配置互相隔离。

### 单词本与 Excel 导入
Excel 需要三列（列名兼容中英文）：

| 单词 | 本次积累的中文意思 | 词典中的中文意思 |
|------|------------------|----------------|
| abandon | 放弃 | 抛弃，遗弃 |

可选列：**音标**、**例句**。示例见根目录 `sample_导入模板.xlsx`。
在 App / Web 的「单词本 → 导入 Excel」上传即可，也会自动加入复习计划。

### 拍照识词
1. 在图片上用红笔圈出单词，并在单词上方手写本次的中文意思；
2. App 内拍照或选图上传；
3. 后端调用你配置的多模态 AI，识别出「单词 + 本次意思 + 词典释义」，自动入库。

使用前请在「设置」里填好 AI 的接口地址与 Key：

| 服务 | base_url 示例 | 模型示例 |
|------|--------------|---------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v` |
| Kimi | `https://api.moonshot.cn/v1` | 多模态模型 |

### 背单词
「背单词」页拉取今日待复习单词，先显示单词、点击显示答案，再选「记住了 / 忘了」：
记住进入下一档间隔，忘记退回第一档重新记忆。

### 多端同步
同一账号在手机和网页同时使用，数据通过增量同步保持一致；重复同步不会产生重复数据。

---

## 测试

```bash
node password-reset-test.js                    # 密码重置 / 全端登出回归测试（离线，23 项断言）

# 浏览器端 UI 验证（需本机已装 puppeteer，且服务已启动）
node deploy/verify-login-web.js http://127.0.0.1:3000/
# 校验：空提交提示、错误密码提示、提示样式、页面无 JS 报错
```

> 提示：react-native-web 的 `Alert` 是空实现，页面里请一律使用 `app/src/utils/dialog.js`
> 的 `notify` / `confirmDialog` / `chooseDialog`，否则 Web 端会静默无任何反应。

---

## 安全说明

1. `.env` 含密钥与数据库密码，**已在 `.gitignore` 中忽略，切勿提交到仓库**；仓库里只保留 `.env.example`。
2. `JWT_SECRET`、`AI_KEY_ENC_SECRET` 必须使用随机长字符串，不要用示例值。
3. 生产环境不要用 root 运行应用（`RUN_USER` 改成普通用户），数据库账号只授予该库权限。
4. 密码以 bcrypt 不可逆哈希存储；用户的 AI Key 以 AES-256-GCM 加密存储，均不落明文。
5. 登录、后台登录、拍照识别均有频率限制；对外建议启用 HTTPS。
6. 重置密码后所有设备登录态立即失效（服务端 `token_version` 校验）。

---

## 常见问题

**Q：页面打开是空白 / 提示连不上后端？**
先确认后端在跑（`curl http://127.0.0.1:3000/api/health`），再确认 `web/` 目录里有构建产物，且 `.env` 的 `SERVER_HOST` 是浏览器能访问到的地址。

**Q：改了服务器地址，前端还连旧地址？**
前端地址在构建时写入，必须重新 `cd app && npm run build:web`（已含 `--clear`），再把 `app/dist/*` 放到 `web/`。

**Q：`npm run migrate` 报 `is_admin` 字段不存在？**
迁移没跑完，重新执行 `npm run migrate`（会自动按序应用 `src/db/migrations/` 下未执行的脚本）。

**Q：登录后过一段时间提示「密码已重置，请重新登录」？**
该账号在其他设备重置过密码，所有旧令牌已被作废，重新登录即可。

**Q：上传 Excel 报错？**
检查是否包含「单词 / 本次积累的中文意思 / 词典中的中文意思」三列，可对照 `sample_导入模板.xlsx`。

---

## 许可（License）

本项目采用 **PolyForm Noncommercial License 1.0.0**，完整条款见 [LICENSE](LICENSE)。

**免费使用范围**：个人学习、研究、实验、私人娱乐、业余爱好、宗教活动；以及慈善机构、教育机构、公共研究机构、公共安全与卫生机构、环保组织、政府机构的使用（不论经费来源）。

**需要另行取得授权**：任何具有商业目的或私人金钱回报的使用，包括但不限于——

- 将本软件或其修改版作为商品或服务出售；
- 用于公司内部的生产性业务；
- 打包进商业产品分发；
- 提供商业化的托管服务。

> 商业授权请联系作者（可在本仓库开 Issue 说明用途）。

**请注意**：本协议**不是** OSI 认可的开源协议。OSI 开源定义第 6 条禁止协议限制使用领域，因此「禁止商用」的协议只能称为 **源码公开（source-available）**。本仓库源码公开、可自由阅读学习与个人使用，商业使用需获得授权。

`Required Notice: Copyright (c) 2026 colorkaka`
