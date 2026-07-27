CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'influencer',
  gender TEXT NOT NULL DEFAULT 'female',
  environment TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  aspect_ratio TEXT NOT NULL DEFAULT '2:3',
  image_type TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
