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
    ["r-admin", "SYS_ADMIN", "系统管理员", "拥有全部权限，负责账号、角色与系统配置。", ALL_PERMISSIONS, 1],
    [
      "r-visa",
      "VISA_OFFICER",
      "签证审核官",
      "受理签证申请，维护申请人档案并核验证件。",
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
      "档案管理员",
      "负责档案建立、归档与证件扫描件管理。",
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
      "边检官员",
      "口岸查验时调阅档案并核验证件。",
      ["applicant.read", "document.read", "document.verify"],
      0,
    ],
    [
      "r-audit",
      "AUDITOR",
      "督察审计员",
      "只读访问业务数据与账号配置，用于合规审计。",
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
        ) VALUES ('u-001', 'admin', ?, '林书远', 'E10231', '信息技术处', 'admin@nia.gov.example', '+000 102 0231 01', 'active', NULL, ?)`,
      )
      .bind(adminHash, at),
    db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES ('u-001', 'r-admin')"),
    db.prepare("INSERT INTO counters (name, value) VALUES ('file', 4817), ('application', 100)"),
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', ?)").bind(at),
  ])
}
