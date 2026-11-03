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
