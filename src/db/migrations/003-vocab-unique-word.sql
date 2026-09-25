-- 单词本：为 (user_id, word) 建立唯一约束
-- 背景：原表只有普通索引 idx_user_word，代码里的 ON DUPLICATE KEY UPDATE 对 word 从不生效，
-- 同一用户重复导入/识别同一个词会不断产生新行；「编辑单词」和「添加时跳过已积累」都必须依赖唯一键。
-- 先按 (user_id, word) 去重（保留 id 最大即最后写入的一条，review_schedule 由外键级联清理），再加唯一键。
-- 注意：列排序规则为 utf8mb4_unicode_ci（大小写不敏感），因此 Add / add 视为同一个词。
DELETE v FROM vocab_entries v
JOIN (
  SELECT user_id, word, MAX(id) AS keep_id
  FROM vocab_entries
  GROUP BY user_id, word
  HAVING COUNT(*) > 1
) d ON v.user_id = d.user_id AND v.word = d.word AND v.id <> d.keep_id;
ALTER TABLE vocab_entries ADD UNIQUE KEY uk_user_word (user_id, word);
