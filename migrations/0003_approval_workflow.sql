-- 多级审批：审核中的申请停在初审或终审，每次决定留一条审批意见。
ALTER TABLE applications ADD COLUMN approval_level TEXT;

-- 升级前已在审核中的申请从初审继续。
UPDATE applications SET approval_level = 'first_review' WHERE status = 'under_review';

CREATE TABLE application_approvals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  level TEXT,
  action TEXT NOT NULL,
  note TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX idx_approvals_application ON application_approvals(application_id, at);

-- 已经写入演示数据的库：给系统管理员和签证审核官补上新权限。
UPDATE roles
SET permissions = json_insert(json_insert(permissions, '$[#]', 'application.review'), '$[#]', 'application.approve')
WHERE id IN ('r-admin', 'r-visa') AND permissions NOT LIKE '%"application.review"%';
