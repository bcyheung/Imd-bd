import { id, nowIso } from "./crypto"

export async function audit(
  db: D1Database,
  actor: { type: "staff" | "portal" | "system"; id: string | null; name: string },
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail: string,
) {
  await db
    .prepare(
      `INSERT INTO audit_logs (id, actor_type, actor_id, actor_name, action, resource_type, resource_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id("log"), actor.type, actor.id, actor.name, action, resourceType, resourceId, detail, nowIso())
    .run()
}

export async function notify(
  db: D1Database,
  recipientType: "staff" | "portal",
  recipientId: string,
  title: string,
  body: string,
) {
  await db
    .prepare(
      `INSERT INTO notifications (id, recipient_type, recipient_id, title, body, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(id("nt"), recipientType, recipientId, title, body, nowIso())
    .run()
}

export async function notifyOfficers(db: D1Database, title: string, body: string) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT u.id AS id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.status = 'active' AND r.permissions LIKE '%"application.review"%'`,
    )
    .all<{ id: string }>()
  for (const row of rows.results) await notify(db, "staff", row.id, title, body)
}
