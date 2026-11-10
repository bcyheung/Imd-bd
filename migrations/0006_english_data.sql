-- Rewrite system-generated Chinese text already stored in the database into English.
-- Only rows that still hold the original generated text are touched; anything staff or
-- applicants typed themselves (review notes, rejection reasons, custom roles) is left as is.

-- Built-in roles (skip any that were renamed after seeding)
UPDATE roles SET name = 'System Administrator', description = 'Full access to all features; manages accounts, roles and system settings.'
WHERE id = 'r-admin' AND name = '系统管理员';
UPDATE roles SET name = 'Visa Officer', description = 'Processes visa applications, maintains applicant records and verifies documents.'
WHERE id = 'r-visa' AND name = '签证审核官';
UPDATE roles SET name = 'Records Officer', description = 'Creates and archives applicant records and manages document scans.'
WHERE id = 'r-archive' AND name = '档案管理员';
UPDATE roles SET name = 'Border Control Officer', description = 'Looks up applicant records and verifies documents at border checkpoints.'
WHERE id = 'r-border' AND name = '边检官员';
UPDATE roles SET name = 'Compliance Auditor', description = 'Read-only access to case data and account settings for compliance audits.'
WHERE id = 'r-audit' AND name = '督察审计员';

-- Seeded administrator
UPDATE users SET full_name = 'Lam Shu Yuen' WHERE id = 'u-001' AND full_name = '林书远';
UPDATE users SET department = 'Information Technology Division' WHERE id = 'u-001' AND department = '信息技术处';

-- Names of the seeded administrator copied into other tables
UPDATE application_timeline SET actor = 'Lam Shu Yuen' WHERE actor = '林书远';
UPDATE application_approvals SET actor_name = 'Lam Shu Yuen' WHERE actor_name = '林书远';
UPDATE audit_logs SET actor_name = 'Lam Shu Yuen' WHERE actor_name = '林书远';
UPDATE documents SET verified_by = 'Lam Shu Yuen' WHERE verified_by = '林书远';
UPDATE attachments SET verified_by = 'Lam Shu Yuen' WHERE verified_by = '林书远';

-- Application timeline notes
UPDATE application_timeline SET note = 'Application created as a draft.' WHERE note = '申请已创建为草稿。';
UPDATE application_timeline SET note = 'Application submitted by the applicant and awaiting review.' WHERE note = '申请人提交申请，等待受理。';
UPDATE application_timeline SET note = 'Application withdrawn by the applicant.' WHERE note = '申请人主动撤回申请。';
UPDATE application_timeline SET note = 'Application accepted and under review.' WHERE note = '已受理，进入审核。';
UPDATE application_timeline SET note = 'Application approved.' WHERE note = '审核通过。';
UPDATE application_timeline SET note = 'Application approved. An applicant record has been created.' WHERE note = '审核通过，已建立申请人档案。';

-- Applicant records created from an approved application
UPDATE applicants SET remarks = 'Created from application ' || substr(remarks, 5, length(remarks) - 7)
WHERE remarks LIKE '由申请 % 建档';

-- Notifications (and their queued emails)
UPDATE notifications SET title = 'Your account has been approved', body = 'You can now sign in to the Immigration Management System.'
WHERE title = '账号已通过审核';
UPDATE notifications SET title = 'New account request awaiting approval',
  body = replace(replace(replace(replace(body, '（', ' ('), '，', ', '), '）申请开通账号。', ') has requested a staff account.'), '申请开通账号。', 'has requested a staff account.')
WHERE title = '有新的账号申请待审核';
UPDATE notifications SET title = 'A document did not pass verification',
  body = replace(replace(replace(body, '你的申请', 'Your application'), ' 未通过核验。原因：', ' did not pass verification. Reason: '), '：', ': ')
WHERE title = '申请材料未通过核验';
UPDATE notifications SET title = 'Application status updated',
  body = replace(replace(replace(replace(replace(body,
    '你的申请', 'Your application'),
    '：已受理，进入审核。', ': Application accepted and under review.'),
    '：审核通过，已建立申请人档案。', ': Application approved. An applicant record has been created.'),
    '：审核通过。', ': Application approved.'),
    '：', ': ')
WHERE title = '申请状态已更新';
UPDATE notifications SET title = 'Application awaiting final review',
  body = replace(replace(body, ' 已由 ', ' passed first review by '), ' 初审通过。', '.')
WHERE title = '有申请待终审';
UPDATE notifications SET title = 'Application returned to first review', body = replace(body, '：', ': ')
WHERE title = '申请被退回初审';
UPDATE notifications SET title = 'New application awaiting review', body = replace(body, ' 已提交。', ' has been submitted.')
WHERE title = '有新的申请待受理';
UPDATE notifications SET title = 'Application withdrawn', body = replace(body, ' 在审核中被申请人撤回。', ' was withdrawn by the applicant during review.')
WHERE title = '申请已被撤回';

UPDATE notifications SET body = replace(body, '林书远', 'Lam Shu Yuen') WHERE body LIKE '%林书远%';

UPDATE email_outbox SET subject = (SELECT title FROM notifications n WHERE n.id = email_outbox.notification_id),
  body = (SELECT body FROM notifications n WHERE n.id = email_outbox.notification_id)
WHERE status IN ('pending', 'failed') AND notification_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = email_outbox.notification_id);

-- Audit log details
UPDATE audit_logs SET detail = 'Staff signed in' WHERE detail = '工作人员登录';
UPDATE audit_logs SET detail = 'Submitted an account request' WHERE detail = '提交账号申请';
UPDATE audit_logs SET detail = 'Created account ' || substr(detail, 6) WHERE detail LIKE '新建账号 %';
UPDATE audit_logs SET detail = 'Updated account ' || substr(detail, 6) WHERE detail LIKE '更新账号 %';
UPDATE audit_logs SET detail = 'Set ' || replace(substr(detail, 3), ' 设为 ', ' to ') WHERE detail LIKE '将 % 设为 %';
UPDATE audit_logs SET detail = 'Created role ' || substr(detail, 6) WHERE detail LIKE '新建角色 %';
UPDATE audit_logs SET detail = 'Updated role ' || substr(detail, 6) WHERE detail LIKE '更新角色 %';
UPDATE audit_logs SET detail = 'Deleted role ' || substr(detail, 6) WHERE detail LIKE '删除角色 %';
UPDATE audit_logs SET detail = 'Created record ' || substr(detail, 6) WHERE detail LIKE '建立档案 %';
UPDATE audit_logs SET detail = 'Updated record ' || substr(detail, 6) WHERE detail LIKE '更新档案 %';
UPDATE audit_logs SET detail = 'Deleted record ' || substr(detail, 6) WHERE detail LIKE '删除档案 %';
UPDATE audit_logs SET detail = 'Registered document ' || substr(detail, 6) WHERE detail LIKE '登记证件 %';
UPDATE audit_logs SET detail = 'Updated document ' || substr(detail, 6) WHERE detail LIKE '修改证件 %';
UPDATE audit_logs SET detail = 'Deleted document ' || substr(detail, 6) WHERE detail LIKE '删除证件 %';
UPDATE audit_logs SET detail = 'Verified document ' || replace(substr(detail, 6), '：', ': ') WHERE detail LIKE '核验证件 %';
UPDATE audit_logs SET detail = 'Verified document ' || replace(substr(detail, 6), '：', ': ') WHERE detail LIKE '核验材料 %';
UPDATE audit_logs SET detail = 'Deleted staff-uploaded document ' || substr(detail, 8) WHERE detail LIKE '删除代传材料 %';
UPDATE audit_logs SET detail = 'Uploaded ' || replace(substr(detail, 6), ' 份 ', ' document(s) for ') WHERE detail LIKE '代传材料 % 份 %';
UPDATE audit_logs SET detail = 'Submitted ' || substr(detail, 4) WHERE detail LIKE '提交 %';
