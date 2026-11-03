import { id, nowIso } from "./crypto"
import type { Env, PermissionCode } from "./types"

export type RecipientType = "staff" | "portal"

/** application：申请状态与审批流转；document：材料核验；account：账号审核；system：其他 */
export type NotificationCategory = "application" | "document" | "account" | "system"

export interface NotificationInput {
  title: string
  body: string
  category?: NotificationCategory
  /** 前端站内路径，例如 /applications/ap-001 */
  link?: string | null
}

const RECIPIENT_TABLE: Record<RecipientType, string> = {
  staff: "users",
  portal: "applicant_accounts",
}

/** 写入站内通知；对方开启了邮件提醒且有邮箱时，同时排入待发邮件。 */
export async function notify(db: D1Database, recipientType: RecipientType, recipientId: string, input: NotificationInput) {
  const notificationId = id("nt")
  const at = nowIso()
  await db
    .prepare(
      `INSERT INTO notifications (id, recipient_type, recipient_id, title, body, category, link, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(notificationId, recipientType, recipientId, input.title, input.body, input.category ?? "system", input.link ?? null, at)
    .run()
  const recipient = await db
    .prepare(`SELECT email, email_notifications FROM ${RECIPIENT_TABLE[recipientType]} WHERE id = ?`)
    .bind(recipientId)
    .first<{ email: string; email_notifications: number }>()
  if (recipient?.email && recipient.email_notifications) {
    await db
      .prepare(
        `INSERT INTO email_outbox (id, notification_id, to_address, subject, body, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .bind(id("em"), notificationId, recipient.email, input.title, input.body, at)
      .run()
  }
}

/** 通知所有持有某项权限的在职工作人员，可排除操作人自己。 */
export async function notifyStaffWith(
  db: D1Database,
  permission: PermissionCode,
  input: NotificationInput,
  excludeId?: string,
) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT u.id AS id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.status = 'active' AND r.permissions LIKE ?`,
    )
    .bind(`%"${permission}"%`)
    .all<{ id: string }>()
  for (const row of rows.results) {
    if (row.id !== excludeId) await notify(db, "staff", row.id, input)
  }
}

export function toNotification(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category ?? "system",
    link: row.link ?? null,
    readAt: row.read_at,
    createdAt: row.created_at,
  }
}

const MAX_ATTEMPTS = 5

/**
 * 投递待发邮件。邮件服务通过 MAIL_WEBHOOK_URL 对接（POST JSON { to, subject, text, from? }），
 * 可接自建 SMTP 网关或任意事务邮件服务；未配置时什么也不做，邮件留在队列里。
 */
export async function deliverEmails(env: Env, limit = 20) {
  if (!env.MAIL_WEBHOOK_URL) return { sent: 0, failed: 0 }
  // 投递中途崩溃的邮件，10 分钟后放回队列重试
  await env.DB
    .prepare("UPDATE email_outbox SET status = 'pending' WHERE status = 'sending' AND claimed_at < ?")
    .bind(new Date(Date.now() - 10 * 60_000).toISOString())
    .run()
  const rows = await env.DB
    .prepare("SELECT id, to_address, subject, body, attempts FROM email_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?")
    .bind(limit)
    .all<{ id: string; to_address: string; subject: string; body: string; attempts: number }>()
  let sent = 0
  let failed = 0
  for (const row of rows.results) {
    // 先认领再发送：多个请求同时投递时，同一封邮件只会被一个请求发出
    const claim = await env.DB
      .prepare("UPDATE email_outbox SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'pending'")
      .bind(nowIso(), row.id)
      .run()
    if (!claim.meta.changes) continue
    try {
      const response = await fetch(env.MAIL_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.MAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.MAIL_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          to: row.to_address,
          subject: row.subject,
          text: row.body,
          ...(env.MAIL_FROM ? { from: env.MAIL_FROM } : {}),
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await env.DB.prepare("UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = ? WHERE id = ?").bind(nowIso(), row.id).run()
      sent += 1
    } catch (error) {
      const attempts = row.attempts + 1
      await env.DB
        .prepare("UPDATE email_outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?")
        .bind(attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts, String(error).slice(0, 500), row.id)
        .run()
      failed += 1
    }
  }
  return { sent, failed }
}
