-- 文本 AI 配置：与拍照识别用的「视觉 AI」分开配置
-- 用途：给单词补全属性（例句、词形变化、词性等），只需纯文本模型，通常更便宜、更快。
-- 视觉 AI（base_url / api_key_enc / model）继续专用于拍照识词。
-- 允许为空：未配置时相关功能明确提示去「设置 → 文本AI」填写，不会误用视觉 AI 的配置。
ALTER TABLE user_ai_config
  ADD COLUMN text_base_url VARCHAR(500) NULL COMMENT '文本 AI 接口地址' AFTER model,
  ADD COLUMN text_api_key_enc VARCHAR(1000) NULL COMMENT '文本 AI 密钥（AES-256-GCM 加密）' AFTER text_base_url,
  ADD COLUMN text_model VARCHAR(100) NULL COMMENT '文本 AI 模型名' AFTER text_api_key_enc;
