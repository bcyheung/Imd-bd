-- 申请材料核验：沿用 attachments 表，只有 owner_type = 'application' 的行会用到这些列。
ALTER TABLE attachments ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE attachments ADD COLUMN source TEXT NOT NULL DEFAULT 'applicant';
ALTER TABLE attachments ADD COLUMN verification TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE attachments ADD COLUMN verification_note TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN verified_by TEXT;
ALTER TABLE attachments ADD COLUMN verified_at TEXT;
