-- 设置页「拍照识别提示词设置」：为 AI 配置增加可自定义的识别提示词列
-- 空值 / NULL 时，后端在 /recognize 中回退到内置默认提示词。
ALTER TABLE user_ai_config ADD COLUMN system_prompt TEXT NULL COMMENT '拍照识词自定义 system prompt，空则用默认' AFTER model;