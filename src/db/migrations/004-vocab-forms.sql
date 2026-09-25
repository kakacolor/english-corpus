-- 单词本：为每个单词补充词性与词形变化属性
-- 背单词时点击显示答案后，会按词性额外展示：
--   动词 -> 三单 / 过去式 / 过去分词 / 现在分词
--   名词 -> 复数
--   形容词、副词等 -> 比较级 / 最高级
-- 全部为可空字段，历史数据不受影响，可逐步补录。
ALTER TABLE vocab_entries
  ADD COLUMN pos VARCHAR(32) NULL COMMENT '词性，如 n. / v. / adj. / adv.' AFTER word,
  ADD COLUMN third_person VARCHAR(100) NULL COMMENT '动词第三人称单数' AFTER phonetic,
  ADD COLUMN past_tense VARCHAR(100) NULL COMMENT '动词过去式' AFTER third_person,
  ADD COLUMN past_participle VARCHAR(100) NULL COMMENT '动词过去分词' AFTER past_tense,
  ADD COLUMN ing_form VARCHAR(100) NULL COMMENT '动词现在分词(ing 形式)' AFTER past_participle,
  ADD COLUMN plural VARCHAR(100) NULL COMMENT '名词复数' AFTER ing_form,
  ADD COLUMN comparative VARCHAR(100) NULL COMMENT '形容词/副词比较级' AFTER plural,
  ADD COLUMN superlative VARCHAR(100) NULL COMMENT '形容词/副词最高级' AFTER comparative;
