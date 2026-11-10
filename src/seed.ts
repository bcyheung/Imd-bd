import { hashPassword, nowIso } from "./crypto"
import { ALL_PERMISSIONS } from "./permissions"

let seeding: Promise<void> | null = null

export function ensureSeeded(db: D1Database) {
  seeding ??= seedIfEmpty(db).catch((error) => {
    seeding = null
    throw error
  })
  return seeding
}

async function seedIfEmpty(db: D1Database) {
  const existing = await db.prepare("SELECT value FROM meta WHERE key = 'seeded'").first()
  if (existing) return

  const adminHash = await hashPassword("Admin@2026")
  const at = nowIso()
  const roles: [string, string, string, string, string[], number][] = [
    ["r-admin", "SYS_ADMIN", "System Administrator", "Full access to all features; manages accounts, roles and system settings.", ALL_PERMISSIONS, 1],
    [
      "r-visa",
      "VISA_OFFICER",
      "Visa Officer",
      "Processes visa applications, maintains applicant records and verifies documents.",
      [
        "applicant.read",
        "applicant.create",
        "applicant.update",
        "document.read",
        "document.create",
        "document.update",
        "document.verify",
        "application.review",
        "application.approve",
      ],
      0,
    ],
    [
      "r-archive",
      "ARCHIVIST",
      "Records Officer",
      "Creates and archives applicant records and manages document scans.",
      [
        "applicant.read",
        "applicant.create",
        "applicant.update",
        "applicant.delete",
        "document.read",
        "document.create",
        "document.update",
        "document.delete",
      ],
      0,
    ],
    [
      "r-border",
      "BORDER_OFFICER",
      "Border Control Officer",
      "Looks up applicant records and verifies documents at border checkpoints.",
      ["applicant.read", "document.read", "document.verify"],
      0,
    ],
    [
      "r-audit",
      "AUDITOR",
      "Compliance Auditor",
      "Read-only access to case data and account settings for compliance audits.",
      ["applicant.read", "document.read", "user.read", "role.read"],
      0,
    ],
  ]

  await db.batch([
    ...roles.map((role) =>
      db
        .prepare(
          `INSERT INTO roles (id, code, name, description, permissions, built_in, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(role[0], role[1], role[2], role[3], JSON.stringify(role[4]), role[5], at),
    ),
    db
      .prepare(
        `INSERT INTO users (
          id, username, password_hash, full_name, employee_id, department, email, phone, status, last_login_at, created_at
        ) VALUES ('u-001', 'admin', ?, 'Lam Shu Yuen', 'E10231', 'Information Technology Division', 'admin@nia.gov.example', '+000 102 0231 01', 'active', NULL, ?)`,
      )
      .bind(adminHash, at),
    db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES ('u-001', 'r-admin')"),
    db.prepare("INSERT INTO counters (name, value) VALUES ('file', 4817), ('application', 100)"),
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', ?)").bind(at),
  ])
}
