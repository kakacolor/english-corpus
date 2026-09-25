/**
 * 统一加载**项目根目录**的 .env（本项目的唯一全局配置文件）。
 *
 * 后端的入口脚本都先 require 本文件，因此无论从哪个工作目录启动
 * （systemd 的 WorkingDirectory、还是手动 node src/server.js），
 * 都会读取项目根目录的 .env，不会因为 cwd 不同而漏读配置。
 *
 * 说明：dotenv 默认不覆盖已存在的环境变量，
 * 因此外部显式传入的环境变量优先级仍高于 .env 文件。
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
