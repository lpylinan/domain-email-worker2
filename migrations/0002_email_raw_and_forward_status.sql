ALTER TABLE emails ADD COLUMN forward_status TEXT;
ALTER TABLE emails ADD COLUMN forward_error TEXT;
ALTER TABLE emails ADD COLUMN forwarded_at INTEGER;
