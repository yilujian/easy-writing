-- 与前端 calcLocalBookStatsWithDrafts 一致：正文计数优先，未知的不含标点计数保留 NULL。
-- $1 = bookId；$2 = 更新时间，NULL 表示只修正统计，不改变作品最近编辑时间。
WITH counts AS (
  SELECT
    CASE WHEN d.storageKey IS NOT NULL THEN COALESCE(d.wordCount, 0)
      ELSE COALESCE(json_extract(c.payload, '$.wordCount'), 0) END AS words,
    CASE WHEN d.storageKey IS NOT NULL THEN d.textWordCount
      ELSE COALESCE(json_extract(c.payload, '$.textWordCount'),
        CASE WHEN COALESCE(json_extract(c.payload, '$.wordCount'), 0) = 0 THEN 0 ELSE NULL END)
      END AS text_words
  FROM local_chapters c
  JOIN local_books b ON CAST(b.id AS TEXT)=c.bookId
  LEFT JOIN chapter_contents d ON d.storageKey=(
    SELECT MIN(s.storageKey) FROM chapter_contents s
    WHERE s.bookId=c.bookId AND s.chapterId=c.id
      AND s.userId IN ('guest',CAST(json_extract(b.payload,'$.ownerUserId') AS TEXT))
    HAVING COUNT(*)=1
  )
  WHERE c.bookId = $1 AND c.deletedAt IS NULL
), totals AS (
  SELECT COUNT(*) AS chapters, COALESCE(SUM(words), 0) AS words,
    CASE WHEN COUNT(text_words) = COUNT(*) THEN COALESCE(SUM(text_words), 0) ELSE NULL END AS text_words
  FROM counts
)
UPDATE local_books SET
  payload = json_set(payload,
    '$.wordCount', (SELECT words FROM totals),
    '$.textWordCount', (SELECT text_words FROM totals),
    '$.chapterCount', (SELECT chapters FROM totals),
    '$.updateTime', COALESCE($2, json_extract(payload, '$.updateTime'))),
  updateTime = COALESCE($2, updateTime)
WHERE CAST(id AS TEXT) = $1 AND deletedAt IS NULL
