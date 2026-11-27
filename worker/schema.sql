-- 課程評價資料表（Cloudflare D1）
-- 不存信箱或姓名：user_hash = SHA-256(REVIEW_SALT + Google 帳號 ID)，只用來確保一人一課一評。
CREATE TABLE IF NOT EXISTS reviews (
  user_hash   TEXT    NOT NULL,
  course_code TEXT    NOT NULL,
  teacher     TEXT    NOT NULL DEFAULT '',
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  workload    TEXT    NOT NULL CHECK (workload   IN ('light', 'medium', 'heavy')),
  grading     TEXT    NOT NULL CHECK (grading    IN ('lenient', 'normal', 'strict')),
  attendance  TEXT    NOT NULL CHECK (attendance IN ('none', 'sometimes', 'always')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_hash, course_code, teacher)
);
CREATE INDEX IF NOT EXISTS idx_reviews_course ON reviews (course_code, teacher);
