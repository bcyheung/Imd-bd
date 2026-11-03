-- 通知：分类与跳转链接，点击通知可直达相关页面。
ALTER TABLE notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'system';
ALTER TABLE notifications ADD COLUMN link TEXT;

CREATE INDEX idx_notifications_unread ON notifications(recipient_type, recipient_id, read_at);

-- 邮件提醒开关，工作人员和申请人各自设置，默认开启。
ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;
ALTER TABLE applicant_accounts ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;

-- 待发邮件（pending → sending → sent / failed）。配置 MAIL_WEBHOOK_URL 后由请求结束时和定时任务投递，未配置时留在 pending。
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX idx_email_outbox_status ON email_outbox(status, created_at);

-- 报表：办结时间单独记录，避免办结后的其他更新改动 updated_at 影响平均处理时长。
ALTER TABLE applications ADD COLUMN decided_at TEXT;

UPDATE applications SET decided_at = updated_at WHERE status IN ('approved', 'rejected') AND decided_at IS NULL;

CREATE INDEX idx_applications_submitted ON applications(submitted_at);
