import { Hono, type Context } from "hono"

import { audit } from "./audit"
import { hashPassword, id, nowIso, signToken, verifyPassword } from "./crypto"
import { conflict, fail, forbidden, like, noContent, notFound, originOf, pageQuery } from "./http"
import { permit, portalOf, requirePortal, requireStaff, staffOf } from "./middleware"
import { notify, notifyStaffWith, toNotification, type RecipientType } from "./notifications"
import { PERMISSIONS } from "./permissions"
import {
  countUnverifiedDocuments,
  DOCUMENT_CATEGORIES,
  draftAssignments,
  getApplication,
  getApplicationDocument,
  listApplicationDocuments,
  listAttachments,
  readApplication,
  storeFiles,
  type DocumentCategory,
} from "./records"
import { findStaffByUsername, loadStaff, nextCounter, publicPortal, publicStaff } from "./session"
import type { AppEnv } from "./types"

export const api = new Hono<AppEnv>()

api.post("/auth/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>()
  const user = await findStaffByUsername(c.env.DB, body.username ?? "")
  if (!user || !(await verifyPassword(body.password ?? "", user.passwordHash))) {
    fail(401, "INVALID_CREDENTIALS", "用户名或密码错误。")
  }
  if (user.status === "pending") fail(403, "ACCOUNT_PENDING", "账号正在审核中，审核通过后即可登录。")
  if (user.status === "disabled") fail(403, "ACCOUNT_DISABLED", "账号已停用，请联系系统管理员。")
  if (user.status === "rejected") fail(403, "ACCOUNT_REJECTED", "注册申请未通过审核，请联系所在部门。")
  const at = nowIso()
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(at, user.id).run()
  const token = await signToken(c.env.JWT_SECRET, user.id, "staff")
  await audit(c.env.DB, { type: "staff", id: user.id, name: user.fullName }, "auth.login", "user", user.id, "工作人员登录")
  return c.json({ ...token, user: { ...publicStaff({ ...user, lastLoginAt: at }), permissions: user.permissions } })
})

api.post("/auth/register", async (c) => {
  const body = await c.req.json<Record<string, string>>()
  const errors: Record<string, string> = {}
  if (!/^E\d{5}$/.test(body.employeeId ?? "")) errors.employeeId = "工号格式为 E + 5 位数字，例如 E20417"
  if (!/^[a-z][a-z0-9._]{3,31}$/.test(body.username ?? "")) errors.username = "4–32 位，小写字母开头，可含数字、点和下划线"
  if ((body.password ?? "").length < 10) errors.password = "密码至少 10 位"
  const taken = await c.env.DB
    .prepare("SELECT username, employee_id FROM users WHERE username = ? COLLATE NOCASE OR employee_id = ?")
    .bind(body.username ?? "", body.employeeId ?? "")
    .all<{ username: string; employee_id: string }>()
  for (const row of taken.results) {
    if (row.username.toLowerCase() === (body.username ?? "").toLowerCase()) errors.username = "该用户名已被使用"
    if (row.employee_id === body.employeeId) errors.employeeId = "该工号已注册"
  }
  if (Object.keys(errors).length) conflict("账号信息与现有记录冲突。", errors)
  const userId = id("u")
  const createdAt = nowIso()
  await c.env.DB
    .prepare(
      `INSERT INTO users (id, username, password_hash, full_name, employee_id, department, email, phone, status, last_login_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
    )
    .bind(userId, body.username, await hashPassword(body.password), body.fullName, body.employeeId, body.department, body.email, body.phone, createdAt)
    .run()
  await audit(c.env.DB, { type: "system", id: null, name: body.fullName }, "auth.register", "user", userId, "提交账号申请")
  await notifyStaffWith(c.env.DB, "user.manage", {
    title: "有新的账号申请待审核",
    body: `${body.fullName}（${body.employeeId}，${body.department}）申请开通账号。`,
    category: "account",
    link: "/admin/users?status=pending",
  })
  const user = await loadStaff(c.env.DB, userId)
  return c.json(publicStaff(user!), 201)
})

api.post("/auth/logout", (c) => noContent(c))
api.get("/auth/me", requireStaff, (c) => c.json(c.get("staff")))

api.get("/users", requireStaff, permit("user.read", "user.manage"), async (c) => {
  const { page, pageSize, offset } = pageQuery(c)
  const keyword = (c.req.query("keyword") ?? "").trim()
  const status = c.req.query("status") ?? ""
  const where = ["(? = '' OR status = ?)", "(? = '' OR full_name LIKE ? OR username LIKE ? OR employee_id LIKE ? OR email LIKE ? OR department LIKE ?)"]
  const kw = like(keyword)
  const binds = [status, status, keyword, kw, kw, kw, kw, kw]
  const total = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where.join(" AND ")}`)
    .bind(...binds)
    .first<{ n: number }>()
  const rows = await c.env.DB
    .prepare(`SELECT id FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all<{ id: string }>()
  const items = []
  for (const row of rows.results) {
    const user = await loadStaff(c.env.DB, row.id)
    if (user) items.push(publicStaff(user))
  }
  return c.json({ items, total: total?.n ?? 0, page, pageSize })
})

api.post("/users", requireStaff, permit("user.manage"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  const username = String(body.username ?? "")
  const employeeId = String(body.employeeId ?? "")
  const errors: Record<string, string> = {}
  const taken = await c.env.DB
    .prepare("SELECT username, employee_id FROM users WHERE username = ? COLLATE NOCASE OR employee_id = ?")
    .bind(username, employeeId)
    .all<{ username: string; employee_id: string }>()
  for (const row of taken.results) {
    if (row.username.toLowerCase() === username.toLowerCase()) errors.username = "该用户名已被使用"
    if (row.employee_id === employeeId) errors.employeeId = "该工号已注册"
  }
  if (Object.keys(errors).length) conflict("账号信息与现有记录冲突。", errors)
  const userId = id("u")
  await c.env.DB
    .prepare(
      `INSERT INTO users (id, username, password_hash, full_name, employee_id, department, email, phone, status, last_login_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
    )
    .bind(userId, username, await hashPassword(String(body.password ?? "")), body.fullName, employeeId, body.department, body.email, body.phone, nowIso())
    .run()
  await replaceRoles(c.env.DB, userId, (body.roleIds as string[]) ?? [])
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "user.create", "user", userId, `新建账号 ${username}`)
  return c.json(publicStaff((await loadStaff(c.env.DB, userId))!), 201)
})

api.get("/users/:id", requireStaff, permit("user.read", "user.manage"), async (c) => {
  const user = await loadStaff(c.env.DB, c.req.param("id"))
  if (!user) notFound("用户")
  return c.json(publicStaff(user))
})

api.patch("/users/:id", requireStaff, permit("user.manage"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  const user = await loadStaff(c.env.DB, c.req.param("id"))
  if (!user) notFound("用户")
  await c.env.DB
    .prepare(
      `UPDATE users SET full_name = ?, department = ?, email = ?, phone = ? WHERE id = ?`,
    )
    .bind(body.fullName ?? user.fullName, body.department ?? user.department, body.email ?? user.email, body.phone ?? user.phone, user.id)
    .run()
  if (Array.isArray(body.roleIds)) await replaceRoles(c.env.DB, user.id, body.roleIds as string[])
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "user.update", "user", user.id, `更新账号 ${user.username}`)
  return c.json(publicStaff((await loadStaff(c.env.DB, user.id))!))
})

api.put("/users/:id/status", requireStaff, permit("user.manage"), async (c) => {
  const body = await c.req.json<{ status: string; roleIds?: string[]; reason?: string }>()
  const user = await loadStaff(c.env.DB, c.req.param("id"))
  if (!user) notFound("用户")
  const me = staffOf(c)
  if (user.id === me.id && body.status !== "active") fail(400, "SELF_LOCKOUT", "不能停用当前登录的账号。")
  await c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(body.status, user.id).run()
  if (body.roleIds) await replaceRoles(c.env.DB, user.id, body.roleIds)
  if (body.status === "active" && user.status === "pending") {
    await notify(c.env.DB, "staff", user.id, {
      title: "账号已通过审核",
      body: "你可以登录移民管理系统。",
      category: "account",
      link: "/dashboard",
    })
  }
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "user.status", "user", user.id, `将 ${user.username} 设为 ${body.status}`)
  return c.json(publicStaff((await loadStaff(c.env.DB, user.id))!))
})

api.get("/permissions", requireStaff, (c) => c.json(PERMISSIONS))

api.get("/roles", requireStaff, async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
       FROM roles r ORDER BY r.built_in DESC, r.name`,
    )
    .all<Record<string, string | number>>()
  return c.json(rows.results.map(toRole))
})

api.post("/roles", requireStaff, permit("role.manage"), async (c) => {
  const body = await c.req.json<{ code: string; name: string; description: string; permissions: string[] }>()
  const dup = await c.env.DB.prepare("SELECT id FROM roles WHERE code = ?").bind(body.code).first()
  if (dup) conflict("角色编码已存在。", { code: "角色编码已存在" })
  const roleId = id("r")
  const updatedAt = nowIso()
  await c.env.DB
    .prepare("INSERT INTO roles (id, code, name, description, permissions, built_in, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(roleId, body.code, body.name, body.description, JSON.stringify(body.permissions), updatedAt)
    .run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "role.create", "role", roleId, `新建角色 ${body.code}`)
  return c.json({ id: roleId, ...body, builtIn: false, userCount: 0, updatedAt }, 201)
})

api.put("/roles/:id", requireStaff, permit("role.manage"), async (c) => {
  const body = await c.req.json<{ code: string; name: string; description: string; permissions: string[] }>()
  const role = await c.env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(c.req.param("id")).first<{ id: string; built_in: number }>()
  if (!role) notFound("角色")
  if (role.built_in) fail(400, "BUILT_IN_ROLE", "系统内置角色不可修改。")
  const dup = await c.env.DB.prepare("SELECT id FROM roles WHERE code = ? AND id != ?").bind(body.code, role.id).first()
  if (dup) conflict("角色编码已存在。", { code: "角色编码已存在" })
  const updatedAt = nowIso()
  await c.env.DB
    .prepare("UPDATE roles SET code = ?, name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?")
    .bind(body.code, body.name, body.description, JSON.stringify(body.permissions), updatedAt, role.id)
    .run()
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?").bind(role.id).first<{ n: number }>()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "role.update", "role", role.id, `更新角色 ${body.code}`)
  return c.json({ id: role.id, ...body, builtIn: false, userCount: count?.n ?? 0, updatedAt })
})

api.delete("/roles/:id", requireStaff, permit("role.manage"), async (c) => {
  const role = await c.env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(c.req.param("id")).first<{ id: string; built_in: number; code: string }>()
  if (!role) notFound("角色")
  if (role.built_in) fail(400, "BUILT_IN_ROLE", "系统内置角色不可删除。")
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?").bind(role.id).first<{ n: number }>()
  if ((count?.n ?? 0) > 0) conflict("仍有用户持有该角色，请先调整这些用户的角色。")
  await c.env.DB.prepare("DELETE FROM roles WHERE id = ?").bind(role.id).run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "role.delete", "role", role.id, `删除角色 ${role.code}`)
  return noContent(c)
})

api.get("/applicants", requireStaff, permit("applicant.read"), async (c) => {
  const { page, pageSize, offset } = pageQuery(c)
  const keyword = (c.req.query("keyword") ?? "").trim()
  const status = c.req.query("status") ?? ""
  const nationality = c.req.query("nationality") ?? ""
  const kw = like(keyword)
  const where = `
    (? = '' OR a.status = ?)
    AND (? = '' OR a.nationality = ?)
    AND (? = '' OR a.file_no LIKE ? OR a.surname LIKE ? OR a.given_names LIKE ? OR a.native_name LIKE ?
      OR (a.surname || ' ' || a.given_names) LIKE ?
      OR EXISTS (SELECT 1 FROM documents d WHERE d.applicant_id = a.id AND d.number LIKE ?))`
  const binds = [status, status, nationality, nationality, keyword, kw, kw, kw, kw, kw, kw]
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM applicants a WHERE ${where}`).bind(...binds).first<{ n: number }>()
  const rows = await c.env.DB
    .prepare(`SELECT a.* FROM applicants a WHERE ${where} ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all<Record<string, string>>()
  const items = []
  for (const row of rows.results) items.push(await toApplicant(c.env.DB, row))
  return c.json({ items, total: total?.n ?? 0, page, pageSize })
})

api.post("/applicants", requireStaff, permit("applicant.create"), async (c) => {
  const body = await c.req.json<Record<string, string>>()
  const applicantId = id("a")
  const serial = await nextCounter(c.env.DB, "file", 173)
  const fileNo = `A-${new Date().getFullYear()}-${String(serial).padStart(6, "0")}`
  const at = nowIso()
  await c.env.DB
    .prepare(
      `INSERT INTO applicants (
        id, file_no, surname, given_names, native_name, sex, date_of_birth, place_of_birth, nationality,
        marital_status, occupation, phone, email, address, remarks, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(applicantId, fileNo, body.surname, body.givenNames, body.nativeName ?? "", body.sex, body.dateOfBirth, body.placeOfBirth, body.nationality, body.maritalStatus, body.occupation ?? "", body.phone ?? "", body.email ?? "", body.address ?? "", body.remarks ?? "", body.status ?? "active", at, at)
    .run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "applicant.create", "applicant", applicantId, `建立档案 ${fileNo}`)
  const row = await c.env.DB.prepare("SELECT * FROM applicants WHERE id = ?").bind(applicantId).first<Record<string, string>>()
  return c.json(await toApplicant(c.env.DB, row!), 201)
})

api.get("/applicants/:id", requireStaff, permit("applicant.read"), async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM applicants WHERE id = ?").bind(c.req.param("id")).first<Record<string, string>>()
  if (!row) notFound("档案")
  return c.json(await toApplicant(c.env.DB, row))
})

api.put("/applicants/:id", requireStaff, permit("applicant.update"), async (c) => {
  const body = await c.req.json<Record<string, string>>()
  const current = await c.env.DB.prepare("SELECT id, file_no FROM applicants WHERE id = ?").bind(c.req.param("id")).first<{ id: string; file_no: string }>()
  if (!current) notFound("档案")
  const at = nowIso()
  await c.env.DB
    .prepare(
      `UPDATE applicants SET surname=?, given_names=?, native_name=?, sex=?, date_of_birth=?, place_of_birth=?, nationality=?,
       marital_status=?, occupation=?, phone=?, email=?, address=?, remarks=?, status=?, updated_at=? WHERE id=?`,
    )
    .bind(body.surname, body.givenNames, body.nativeName ?? "", body.sex, body.dateOfBirth, body.placeOfBirth, body.nationality, body.maritalStatus, body.occupation ?? "", body.phone ?? "", body.email ?? "", body.address ?? "", body.remarks ?? "", body.status, at, current.id)
    .run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "applicant.update", "applicant", current.id, `更新档案 ${current.file_no}`)
  const row = await c.env.DB.prepare("SELECT * FROM applicants WHERE id = ?").bind(current.id).first<Record<string, string>>()
  return c.json(await toApplicant(c.env.DB, row!))
})

api.delete("/applicants/:id", requireStaff, permit("applicant.delete"), async (c) => {
  const current = await c.env.DB.prepare("SELECT id, file_no FROM applicants WHERE id = ?").bind(c.req.param("id")).first<{ id: string; file_no: string }>()
  if (!current) notFound("档案")
  const docs = await c.env.DB.prepare("SELECT id FROM documents WHERE applicant_id = ?").bind(current.id).all<{ id: string }>()
  for (const doc of docs.results) await deleteStored(c.env, "document", doc.id)
  await c.env.DB.prepare("DELETE FROM documents WHERE applicant_id = ?").bind(current.id).run()
  await c.env.DB.prepare("DELETE FROM applicants WHERE id = ?").bind(current.id).run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "applicant.delete", "applicant", current.id, `删除档案 ${current.file_no}`)
  return noContent(c)
})

api.get("/applicants/:id/documents", requireStaff, permit("document.read"), async (c) => {
  const applicant = await c.env.DB.prepare("SELECT id FROM applicants WHERE id = ?").bind(c.req.param("id")).first()
  if (!applicant) notFound("档案")
  const rows = await c.env.DB
    .prepare("SELECT * FROM documents WHERE applicant_id = ? ORDER BY created_at")
    .bind(c.req.param("id"))
    .all<Record<string, string | null>>()
  const items = []
  for (const row of rows.results) items.push(await toDocument(c.env.DB, row, originOf(c)))
  return c.json(items)
})

api.post("/applicants/:id/documents", requireStaff, permit("document.create"), async (c) => {
  const applicant = await c.env.DB.prepare("SELECT id FROM applicants WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>()
  if (!applicant) notFound("档案")
  const body = await c.req.json<Record<string, string | null>>()
  await assertUniqueDocument(c.env.DB, body)
  const docId = id("d")
  const at = nowIso()
  await c.env.DB
    .prepare(
      `INSERT INTO documents (
        id, applicant_id, type, number, issuing_country, issuing_authority, issue_date, expiry_date,
        verification, verification_note, verified_by, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL, NULL, ?, ?)`,
    )
    .bind(docId, applicant.id, body.type, body.number, body.issuingCountry, body.issuingAuthority, body.issueDate, body.expiryDate || null, at, at)
    .run()
  await c.env.DB.prepare("UPDATE applicants SET updated_at = ? WHERE id = ?").bind(at, applicant.id).run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "document.create", "document", docId, `登记证件 ${body.number}`)
  const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(docId).first<Record<string, string | null>>()
  return c.json(await toDocument(c.env.DB, row!, originOf(c)), 201)
})

api.put("/documents/:id", requireStaff, permit("document.update"), async (c) => {
  const body = await c.req.json<Record<string, string | null>>()
  const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>()
  if (!doc) notFound("证件")
  await assertUniqueDocument(c.env.DB, body, doc.id)
  const at = nowIso()
  await c.env.DB
    .prepare(
      `UPDATE documents SET type=?, number=?, issuing_country=?, issuing_authority=?, issue_date=?, expiry_date=?,
       verification='pending', verification_note='', verified_by=NULL, verified_at=NULL, updated_at=? WHERE id=?`,
    )
    .bind(body.type, body.number, body.issuingCountry, body.issuingAuthority, body.issueDate, body.expiryDate || null, at, doc.id)
    .run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "document.update", "document", doc.id, `修改证件 ${body.number}`)
  const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(doc.id).first<Record<string, string | null>>()
  return c.json(await toDocument(c.env.DB, row!, originOf(c)))
})

api.delete("/documents/:id", requireStaff, permit("document.delete"), async (c) => {
  const doc = await c.env.DB.prepare("SELECT id, number FROM documents WHERE id = ?").bind(c.req.param("id")).first<{ id: string; number: string }>()
  if (!doc) notFound("证件")
  await deleteStored(c.env, "document", doc.id)
  await c.env.DB.prepare("DELETE FROM attachments WHERE owner_type = 'document' AND owner_id = ?").bind(doc.id).run()
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(doc.id).run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "document.delete", "document", doc.id, `删除证件 ${doc.number}`)
  return noContent(c)
})

api.put("/documents/:id/verification", requireStaff, permit("document.verify"), async (c) => {
  const body = await c.req.json<{ verification: string; note?: string }>()
  const doc = await c.env.DB.prepare("SELECT id, number FROM documents WHERE id = ?").bind(c.req.param("id")).first<{ id: string; number: string }>()
  if (!doc) notFound("证件")
  const me = staffOf(c)
  const at = nowIso()
  await c.env.DB
    .prepare("UPDATE documents SET verification=?, verification_note=?, verified_by=?, verified_at=?, updated_at=? WHERE id=?")
    .bind(body.verification, body.note ?? "", me.fullName, at, at, doc.id)
    .run()
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "document.verify", "document", doc.id, `核验证件 ${doc.number}：${body.verification}`)
  const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(doc.id).first<Record<string, string | null>>()
  return c.json(await toDocument(c.env.DB, row!, originOf(c)))
})

api.post("/documents/:id/attachments", requireStaff, permit("document.create", "document.update"), async (c) => {
  const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE id = ?").bind(c.req.param("id")).first<{ id: string }>()
  if (!doc) notFound("证件")
  const form = await c.req.formData()
  const files = form.getAll("files").filter((file): file is File => file instanceof File)
  const added = await storeFiles(c.env.DB, c.env.FILES, "document", doc.id, files, originOf(c))
  await c.env.DB.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").bind(nowIso(), doc.id).run()
  return c.json(added, 201)
})

api.delete("/documents/:id/attachments/:attachmentId", requireStaff, permit("document.update"), async (c) => {
  const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE id = ?").bind(c.req.param("id")).first()
  if (!doc) notFound("证件")
  await removeAttachment(c.env, c.req.param("attachmentId"))
  return noContent(c)
})

api.get("/dashboard/summary", requireStaff, async (c) => {
  const db = c.env.DB
  const horizon = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const [applicantTotal, underReview, pendingVerification, pendingAccounts, expiring] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE status != 'archived'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM applicants WHERE status = 'under_review'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE verification = 'pending'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first<{ n: number }>(),
    db
      .prepare(
        `SELECT d.id AS document_id, d.applicant_id, d.type, d.number, d.expiry_date, a.surname, a.given_names, a.file_no
         FROM documents d JOIN applicants a ON a.id = d.applicant_id
         WHERE d.expiry_date IS NOT NULL AND d.expiry_date <= ?
         ORDER BY d.expiry_date ASC`,
      )
      .bind(horizon)
      .all<Record<string, string>>(),
  ])
  const docs = expiring.results.filter((d) => d.expiry_date <= horizon)
  return c.json({
    applicantTotal: applicantTotal?.n ?? 0,
    underReview: underReview?.n ?? 0,
    pendingVerification: pendingVerification?.n ?? 0,
    expiringSoon: docs.length,
    pendingAccounts: pendingAccounts?.n ?? 0,
    expiringDocuments: docs.slice(0, 6).map((d) => ({
      documentId: d.document_id,
      applicantId: d.applicant_id,
      applicantName: `${d.surname} ${d.given_names}`,
      fileNo: d.file_no,
      type: d.type,
      number: d.number,
      expiryDate: d.expiry_date,
    })),
    asOf: today,
  })
})

api.get("/applications", requireStaff, permit("applicant.read"), async (c) => {
  const { page, pageSize, offset } = pageQuery(c)
  const status = c.req.query("status") ?? ""
  const keyword = (c.req.query("keyword") ?? "").trim()
  const kw = like(keyword)
  const where = `(? = '' OR status = ?) AND (? = '' OR application_no LIKE ? OR surname LIKE ? OR given_names LIKE ? OR passport_number LIKE ?)`
  const binds = [status, status, keyword, kw, kw, kw, kw]
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM applications WHERE ${where}`).bind(...binds).first<{ n: number }>()
  const rows = await c.env.DB
    .prepare(`SELECT * FROM applications WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all<Parameters<typeof readApplication>[1]>()
  const items = []
  for (const row of rows.results) items.push(await readApplication(c.env.DB, row, originOf(c)))
  return c.json({ items, total: total?.n ?? 0, page, pageSize })
})

api.get("/applications/:id", requireStaff, permit("applicant.read"), async (c) => {
  const application = await getApplication(c.env.DB, c.req.param("id"), originOf(c))
  if (!application) notFound("申请")
  return c.json(application)
})

/** 只有受理流程中的申请可以代传和核验材料；通过、驳回、撤回后材料只读。 */
const DOCUMENT_EDITABLE_STATUSES = ["submitted", "under_review", "supplement_required"]

async function editableApplication(db: D1Database, applicationId: string) {
  const application = await db
    .prepare("SELECT id, application_no, status, account_id FROM applications WHERE id = ?")
    .bind(applicationId)
    .first<{ id: string; application_no: string | null; status: string; account_id: string }>()
  if (!application) notFound("申请")
  if (!DOCUMENT_EDITABLE_STATUSES.includes(application.status)) conflict("申请已办结或尚未提交，材料不能修改。")
  return application
}

api.get("/applications/:id/documents", requireStaff, permit("applicant.read"), async (c) => {
  const application = await c.env.DB.prepare("SELECT id FROM applications WHERE id = ?").bind(c.req.param("id")).first()
  if (!application) notFound("申请")
  return c.json(await listApplicationDocuments(c.env.DB, c.req.param("id"), originOf(c)))
})

api.post("/applications/:id/documents", requireStaff, permit("document.create"), async (c) => {
  const application = await editableApplication(c.env.DB, c.req.param("id"))
  const form = await c.req.formData()
  const category = String(form.get("category") ?? "other")
  if (!DOCUMENT_CATEGORIES.includes(category as DocumentCategory)) {
    fail(400, "VALIDATION_FAILED", "材料分类不正确。", { category: "材料分类不正确" })
  }
  const files = form.getAll("files").filter((file): file is File => file instanceof File)
  if (!files.length) fail(400, "VALIDATION_FAILED", "请选择要上传的文件。", { files: "请选择要上传的文件" })
  const added = await storeFiles(c.env.DB, c.env.FILES, "application", application.id, files, originOf(c), {
    category: category as DocumentCategory,
    source: "staff",
  })
  await c.env.DB.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").bind(nowIso(), application.id).run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "application.document.upload", "application", application.id, `代传材料 ${added.length} 份 ${application.application_no}`)
  const ids = new Set(added.map((file) => file.id))
  const documents = await listApplicationDocuments(c.env.DB, application.id, originOf(c))
  return c.json(documents.filter((doc) => ids.has(doc.id)), 201)
})

api.delete("/applications/:id/documents/:documentId", requireStaff, permit("document.create"), async (c) => {
  const application = await editableApplication(c.env.DB, c.req.param("id"))
  const doc = await getApplicationDocument(c.env.DB, application.id, c.req.param("documentId"), originOf(c))
  if (!doc) notFound("材料")
  if (doc.source !== "staff") conflict("申请人上传的材料不能由工作人员删除。")
  if (doc.verification !== "pending") conflict("材料已核验，不能删除。")
  await removeAttachment(c.env, doc.id)
  await c.env.DB.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").bind(nowIso(), application.id).run()
  const me = staffOf(c)
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "application.document.delete", "application", application.id, `删除代传材料 ${doc.fileName}`)
  return noContent(c)
})

api.put("/applications/:id/documents/:documentId/verification", requireStaff, permit("document.verify"), async (c) => {
  const body = await c.req.json<{ verification?: string; note?: string }>()
  const application = await editableApplication(c.env.DB, c.req.param("id"))
  const doc = await getApplicationDocument(c.env.DB, application.id, c.req.param("documentId"), originOf(c))
  if (!doc) notFound("材料")
  if (body.verification !== "verified" && body.verification !== "rejected") {
    fail(400, "VALIDATION_FAILED", "核验结论只能是通过或驳回。", { verification: "请选择核验结论" })
  }
  const note = (body.note ?? "").trim()
  if (body.verification === "rejected" && !note) fail(400, "VALIDATION_FAILED", "请填写驳回原因。", { note: "请填写驳回原因" })
  const me = staffOf(c)
  const at = nowIso()
  await c.env.DB
    .prepare("UPDATE attachments SET verification = ?, verification_note = ?, verified_by = ?, verified_at = ? WHERE id = ?")
    .bind(body.verification, note, me.fullName, at, doc.id)
    .run()
  await c.env.DB.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").bind(at, application.id).run()
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "application.document.verify", "application", application.id, `核验材料 ${doc.fileName}：${body.verification}`)
  if (body.verification === "rejected") {
    await notify(c.env.DB, "portal", application.account_id, {
      title: "申请材料未通过核验",
      body: `${application.application_no ?? "你的申请"}：${doc.fileName} 未通过核验。原因：${note}`,
      category: "document",
      link: `/portal/applications/${application.id}`,
    })
  }
  return c.json(await getApplicationDocument(c.env.DB, application.id, doc.id, originOf(c)))
})

type DecisionAction =
  | "start_review"
  | "pass_first_review"
  | "return_to_first_review"
  | "request_supplement"
  | "approve"
  | "reject"

/** 各状态与层级下可做的决定和所需权限，与前端 src/features/applications/workflow.ts 一致。 */
function decisionStep(status: string, level: string | null) {
  if (status === "submitted" || status === "supplement_required") {
    return { level: null, actions: ["start_review"] as DecisionAction[], permission: "application.review" as const }
  }
  if (status !== "under_review") return null
  return level === "final_review"
    ? {
        level: "final_review" as const,
        actions: ["approve", "return_to_first_review", "request_supplement", "reject"] as DecisionAction[],
        permission: "application.approve" as const,
      }
    : {
        level: "first_review" as const,
        actions: ["pass_first_review", "request_supplement", "reject"] as DecisionAction[],
        permission: "application.review" as const,
      }
}

/** 必须填写意见的决定：申请人或下一级审批人要看到理由。 */
const NOTE_REQUIRED: Partial<Record<DecisionAction, string>> = {
  request_supplement: "请填写补件说明",
  reject: "请填写驳回理由",
  return_to_first_review: "请填写退回理由",
}

/** 这几种决定的意见写入 reviewNote，申请人在门户能看到；其余只在内部审批记录里。 */
const PUBLIC_NOTE_ACTIONS: DecisionAction[] = ["request_supplement", "reject", "approve"]

api.post("/applications/:id/decision", requireStaff, async (c) => {
  const body = await c.req.json<{ action: DecisionAction; note?: string }>()
  const application = await getApplication(c.env.DB, c.req.param("id"), originOf(c))
  if (!application) notFound("申请")
  const me = staffOf(c)
  const note = (body.note ?? "").trim()

  const step = decisionStep(application.status, application.approvalLevel)
  if (!step || !step.actions.includes(body.action)) conflict("当前状态不能执行该审批操作。")
  if (!me.permissions.includes(step.permission)) {
    forbidden(step.level === "final_review" ? "当前账号没有终审权限。" : "当前账号没有初审权限。")
  }
  const noteMessage = NOTE_REQUIRED[body.action]
  if (noteMessage && !note) fail(400, "VALIDATION_FAILED", `${noteMessage}。`, { note: noteMessage })
  if (step.level === "final_review") {
    // 双人复核：以最近一次初审通过的人为准，退回初审后换人重新初审则以新的初审人为准。
    const firstReview = [...application.approvals].reverse().find((record) => record.action === "pass_first_review")
    if (firstReview?.actorId === me.id) forbidden("同一份申请的初审人不能再做终审。")
  }
  if (body.action === "pass_first_review" || body.action === "approve") {
    const unverified = await countUnverifiedDocuments(c.env.DB, application.id)
    if (unverified) conflict(`还有 ${unverified} 份申请材料未核验通过。`)
  }

  let next = application.status
  let nextLevel: string | null = step.level
  let timelineNote: string | null = null
  switch (body.action) {
    case "start_review":
      next = "under_review"
      nextLevel = "first_review"
      timelineNote = "已受理，进入审核。"
      break
    case "pass_first_review":
      nextLevel = "final_review"
      break
    case "return_to_first_review":
      nextLevel = "first_review"
      break
    case "request_supplement":
      next = "supplement_required"
      nextLevel = null
      timelineNote = note
      break
    case "reject":
      next = "rejected"
      nextLevel = null
      timelineNote = note
      break
    case "approve":
      next = "approved"
      nextLevel = null
      timelineNote = note || "审核通过。"
      break
  }

  const at = nowIso()
  let fileNo = application.fileNo
  if (next === "approved" && !fileNo) {
    const serial = await nextCounter(c.env.DB, "file", 173)
    fileNo = `A-${new Date().getFullYear()}-${String(serial).padStart(6, "0")}`
    const applicantId = id("a")
    await c.env.DB
      .prepare(
        `INSERT INTO applicants (
          id, file_no, surname, given_names, native_name, sex, date_of_birth, place_of_birth, nationality,
          marital_status, occupation, phone, email, address, remarks, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(applicantId, fileNo, application.surname, application.givenNames, application.nativeName, application.sex, application.dateOfBirth, application.placeOfBirth, application.nationality, application.maritalStatus, application.occupation, application.phone, application.email, application.address, `由申请 ${application.applicationNo} 建档`, at, at)
      .run()
    if (application.passportNumber) {
      await c.env.DB
        .prepare(
          `INSERT INTO documents (
            id, applicant_id, type, number, issuing_country, issuing_authority, issue_date, expiry_date,
            verification, verification_note, verified_by, verified_at, created_at, updated_at
          ) VALUES (?, ?, 'passport', ?, ?, ?, ?, ?, 'verified', '', ?, ?, ?, ?)`,
        )
        .bind(id("d"), applicantId, application.passportNumber, application.passportIssuingCountry, application.passportIssuingAuthority, application.passportIssueDate, application.passportExpiryDate, me.fullName, at, at, at)
        .run()
    }
    timelineNote = note || "审核通过，已建立申请人档案。"
  }
  const reviewNote = PUBLIC_NOTE_ACTIONS.includes(body.action) ? note || application.reviewNote : application.reviewNote
  await c.env.DB
    .prepare("UPDATE applications SET status = ?, approval_level = ?, review_note = ?, file_no = ?, decided_at = ?, updated_at = ? WHERE id = ?")
    .bind(next, nextLevel, reviewNote, fileNo, next === "approved" || next === "rejected" ? at : null, at, application.id)
    .run()
  await c.env.DB
    .prepare(
      `INSERT INTO application_approvals (id, application_id, level, action, note, actor_id, actor_name, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id("apv"), application.id, step.level, body.action, note, me.id, me.fullName, at)
    .run()
  if (timelineNote !== null) {
    await c.env.DB
      .prepare("INSERT INTO application_timeline (application_id, status, note, actor, at) VALUES (?, ?, ?, ?, ?)")
      .bind(application.id, next, timelineNote, me.fullName, at)
      .run()
    await notify(c.env.DB, "portal", application.accountId, {
      title: "申请状态已更新",
      body: `${application.applicationNo ?? "你的申请"}：${timelineNote}`,
      category: "application",
      link: `/portal/applications/${application.id}`,
    })
  }
  const staffLink = `/applications/${application.id}`
  if (body.action === "pass_first_review") {
    // 初审人不能终审，不必通知自己
    await notifyStaffWith(c.env.DB, "application.approve", {
      title: "有申请待终审",
      body: `${application.applicationNo} 已由 ${me.fullName} 初审通过。`,
      category: "application",
      link: staffLink,
    }, me.id)
  }
  if (body.action === "return_to_first_review") {
    const firstReview = [...application.approvals].reverse().find((record) => record.action === "pass_first_review")
    if (firstReview && firstReview.actorId !== me.id) {
      await notify(c.env.DB, "staff", firstReview.actorId, {
        title: "申请被退回初审",
        body: `${application.applicationNo}：${note}`,
        category: "application",
        link: staffLink,
      })
    }
  }
  await audit(c.env.DB, { type: "staff", id: me.id, name: me.fullName }, "application.decision", "application", application.id, `${body.action} ${application.applicationNo}`)
  return c.json(await getApplication(c.env.DB, application.id, originOf(c)))
})

const PENDING_STATUSES = ["submitted", "under_review", "supplement_required"]
/** 待受理、审核中超过该天数视为超期；待补件在等申请人，不计入。 */
const SLA_DAYS = 15
const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDay(value: string | undefined, field: string) {
  if (!value) return null
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(400, "VALIDATION_FAILED", "日期格式应为 yyyy-MM-dd。", { [field]: "日期格式应为 yyyy-MM-dd" })
  }
  return value
}

/** 按日或按月列出 from..to 之间的所有区间键，保证趋势图没有缺口。 */
function periodKeys(from: string, to: string, granularity: "day" | "month") {
  const keys: string[] = []
  if (granularity === "day") {
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
      keys.push(new Date(t).toISOString().slice(0, 10))
    }
    return keys
  }
  let [year, month] = from.slice(0, 7).split("-").map(Number)
  const end = to.slice(0, 7)
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`
    keys.push(key)
    if (key >= end) return keys
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}

api.get("/reports", requireStaff, permit("applicant.read"), async (c) => {
  const fromParam = parseDay(c.req.query("from"), "from")
  const toParam = parseDay(c.req.query("to"), "to")
  if (fromParam && toParam && fromParam > toParam) {
    fail(400, "VALIDATION_FAILED", "开始日期不能晚于结束日期。", { from: "开始日期不能晚于结束日期" })
  }
  const rows = await c.env.DB
    .prepare("SELECT type, status, submitted_at, created_at, decided_at, updated_at FROM applications")
    .all<{ type: string; status: string; submitted_at: string | null; created_at: string; decided_at: string | null; updated_at: string }>()
  const today = new Date().toISOString().slice(0, 10)
  // 申请日期：已提交的取提交时间，草稿取创建时间
  const dayOf = (row: { submitted_at: string | null; created_at: string }) => (row.submitted_at ?? row.created_at).slice(0, 10)
  const decidedOf = (row: { status: string; decided_at: string | null; updated_at: string }) =>
    row.status === "approved" || row.status === "rejected" ? (row.decided_at ?? row.updated_at) : null

  const earliest = rows.results.reduce<string | null>((min, row) => (!min || dayOf(row) < min ? dayOf(row) : min), null)
  const from = fromParam ?? earliest ?? new Date(Date.now() - 180 * DAY_MS).toISOString().slice(0, 10)
  const to = toParam ?? today
  const inRange = (day: string) => day >= from && day <= to
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1
  const granularity = spanDays <= 62 ? "day" : "month"
  const periodOf = (iso: string) => (granularity === "day" ? iso.slice(0, 10) : iso.slice(0, 7))

  const trend = new Map(periodKeys(from, to, granularity).map((period) => [period, { period, submitted: 0, approved: 0, rejected: 0 }]))
  const byStatus: Record<string, number> = {}
  const byType: Record<string, number> = {}
  const types = new Map<string, { type: string; total: number; approved: number; rejected: number; days: number; finished: number }>()
  let total = 0
  let submitted = 0
  let approved = 0
  let rejected = 0
  let days = 0
  let finished = 0
  let backlog = 0
  let overdue = 0
  const now = Date.now()

  for (const row of rows.results) {
    // 积压是当前快照，不受统计范围影响
    if (PENDING_STATUSES.includes(row.status)) {
      backlog += 1
      if (row.status !== "supplement_required" && row.submitted_at && now - Date.parse(row.submitted_at) > SLA_DAYS * DAY_MS) overdue += 1
    }
    const decidedAt = decidedOf(row)
    if (decidedAt && inRange(decidedAt.slice(0, 10))) {
      const point = trend.get(periodOf(decidedAt))
      if (point) point[row.status as "approved" | "rejected"] += 1
    }
    if (row.submitted_at && inRange(row.submitted_at.slice(0, 10))) {
      const point = trend.get(periodOf(row.submitted_at))
      if (point) point.submitted += 1
    }

    if (!inRange(dayOf(row))) continue
    total += 1
    if (row.submitted_at) submitted += 1
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    byType[row.type] = (byType[row.type] ?? 0) + 1
    const type = types.get(row.type) ?? { type: row.type, total: 0, approved: 0, rejected: 0, days: 0, finished: 0 }
    types.set(row.type, type)
    type.total += 1
    if (row.status === "approved") {
      approved += 1
      type.approved += 1
    }
    if (row.status === "rejected") {
      rejected += 1
      type.rejected += 1
    }
    if (decidedAt && row.submitted_at) {
      const spent = (Date.parse(decidedAt) - Date.parse(row.submitted_at)) / DAY_MS
      days += spent
      finished += 1
      type.days += spent
      type.finished += 1
    }
  }

  const reviewers = await c.env.DB
    .prepare(
      `SELECT actor_id, actor_name, COUNT(*) AS decisions,
         SUM(CASE WHEN action = 'approve' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN action = 'reject' THEN 1 ELSE 0 END) AS rejected
       FROM application_approvals
       WHERE substr(at, 1, 10) BETWEEN ? AND ?
       GROUP BY actor_id, actor_name
       ORDER BY decisions DESC, actor_name
       LIMIT 20`,
    )
    .bind(from, to)
    .all<{ actor_id: string; actor_name: string; decisions: number; approved: number; rejected: number }>()

  const decided = approved + rejected
  return c.json({
    range: { from, to },
    granularity,
    applicationTotal: total,
    submittedTotal: submitted,
    approvedTotal: approved,
    rejectedTotal: rejected,
    approvalRate: decided ? approved / decided : null,
    averageProcessingDays: finished ? round1(days / finished) : null,
    byStatus,
    byType,
    types: [...types.values()]
      .sort((a, b) => b.total - a.total)
      .map((type) => ({
        type: type.type,
        total: type.total,
        approved: type.approved,
        rejected: type.rejected,
        approvalRate: type.approved + type.rejected ? type.approved / (type.approved + type.rejected) : null,
        averageProcessingDays: type.finished ? round1(type.days / type.finished) : null,
      })),
    trend: [...trend.values()],
    reviewers: reviewers.results.map((row) => ({
      actorId: row.actor_id,
      actorName: row.actor_name,
      decisions: row.decisions,
      approved: row.approved,
      rejected: row.rejected,
    })),
    backlog: { total: backlog, overdue, slaDays: SLA_DAYS },
    generatedAt: nowIso(),
  })
})

/* ---------- 通知：工作人员与门户共用，按登录域区分收件人 ---------- */

type NotificationContext = Context<AppEnv>

function recipientOf(c: NotificationContext, realm: RecipientType) {
  return realm === "staff" ? staffOf(c).id : portalOf(c).id
}

function notificationRoutes(prefix: string, realm: RecipientType, guard: typeof requireStaff) {
  const table = realm === "staff" ? "users" : "applicant_accounts"

  api.get(`${prefix}/notifications`, guard, async (c) => {
    const unreadOnly = c.req.query("unread") === "true"
    const rows = await c.env.DB
      .prepare(
        `SELECT * FROM notifications
         WHERE recipient_type = ? AND recipient_id = ? AND (? = 0 OR read_at IS NULL)
         ORDER BY created_at DESC LIMIT 50`,
      )
      .bind(realm, recipientOf(c, realm), unreadOnly ? 1 : 0)
      .all()
    return c.json(rows.results.map(toNotification))
  })

  api.post(`${prefix}/notifications/read-all`, guard, async (c) => {
    await c.env.DB
      .prepare("UPDATE notifications SET read_at = ? WHERE recipient_type = ? AND recipient_id = ? AND read_at IS NULL")
      .bind(nowIso(), realm, recipientOf(c, realm))
      .run()
    return noContent(c)
  })

  api.post(`${prefix}/notifications/:id/read`, guard, async (c) => {
    await c.env.DB
      .prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient_type = ? AND recipient_id = ?")
      .bind(nowIso(), c.req.param("id"), realm, recipientOf(c, realm))
      .run()
    return noContent(c)
  })

  api.get(`${prefix}/notifications/preferences`, guard, async (c) => {
    return c.json(await readPreferences(c.env.DB, table, recipientOf(c, realm)))
  })

  api.put(`${prefix}/notifications/preferences`, guard, async (c) => {
    const body = await c.req.json<{ emailEnabled?: unknown }>()
    if (typeof body.emailEnabled !== "boolean") {
      fail(400, "VALIDATION_FAILED", "请选择是否开启邮件提醒。", { emailEnabled: "请选择是否开启邮件提醒" })
    }
    const recipientId = recipientOf(c, realm)
    await c.env.DB.prepare(`UPDATE ${table} SET email_notifications = ? WHERE id = ?`).bind(body.emailEnabled ? 1 : 0, recipientId).run()
    return c.json(await readPreferences(c.env.DB, table, recipientId))
  })
}

async function readPreferences(db: D1Database, table: string, recipientId: string) {
  const row = await db.prepare(`SELECT email, email_notifications FROM ${table} WHERE id = ?`).bind(recipientId).first<{ email: string; email_notifications: number }>()
  return { emailEnabled: Boolean(row?.email_notifications), email: row?.email ?? "" }
}

notificationRoutes("", "staff", requireStaff)

api.get("/audit-logs", requireStaff, permit("user.read", "role.read"), async (c) => {
  const { page, pageSize, offset } = pageQuery(c)
  const keyword = (c.req.query("keyword") ?? "").trim()
  const kw = like(keyword)
  const where = "? = '' OR actor_name LIKE ? OR action LIKE ? OR detail LIKE ? OR resource_type LIKE ?"
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where}`).bind(keyword, kw, kw, kw, kw).first<{ n: number }>()
  const rows = await c.env.DB
    .prepare(`SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(keyword, kw, kw, kw, kw, pageSize, offset)
    .all<Record<string, string | null>>()
  return c.json({
    items: rows.results.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      detail: row.detail,
      createdAt: row.created_at,
    })),
    total: total?.n ?? 0,
    page,
    pageSize,
  })
})

api.get("/files/:id", async (c) => {
  const row = await c.env.DB
    .prepare("SELECT file_name, mime_type, r2_key FROM attachments WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ file_name: string; mime_type: string; r2_key: string | null }>()
  if (!row?.r2_key) notFound("文件")
  const object = await c.env.FILES.get(row.r2_key)
  if (!object) notFound("文件")
  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Disposition": `inline; filename="${encodeURIComponent(row.file_name)}"`,
    },
  })
})

api.post("/portal/auth/register", async (c) => {
  const body = await c.req.json<{ fullName: string; email: string; phone: string; password: string }>()
  const email = body.email.trim().toLowerCase()
  const dup = await c.env.DB.prepare("SELECT id FROM applicant_accounts WHERE email = ? COLLATE NOCASE").bind(email).first()
  if (dup) conflict("该邮箱已注册，请直接登录或使用其他邮箱。", { email: "该邮箱已注册" })
  const accountId = id("pa")
  const at = nowIso()
  await c.env.DB
    .prepare(
      `INSERT INTO applicant_accounts (id, email, password_hash, full_name, phone, status, last_login_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(accountId, email, await hashPassword(body.password), body.fullName.trim(), body.phone.trim(), at, at)
    .run()
  const token = await signToken(c.env.JWT_SECRET, accountId, "portal")
  return c.json({ ...token, account: { id: accountId, email, fullName: body.fullName.trim(), phone: body.phone.trim(), status: "active", lastLoginAt: at, createdAt: at } }, 201)
})

api.post("/portal/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>()
  const email = (body.email ?? "").trim().toLowerCase()
  const row = await c.env.DB.prepare("SELECT id, password_hash, status FROM applicant_accounts WHERE email = ? COLLATE NOCASE").bind(email).first<{ id: string; password_hash: string; status: string }>()
  if (!row || !(await verifyPassword(body.password ?? "", row.password_hash))) fail(401, "INVALID_CREDENTIALS", "邮箱或密码错误。")
  if (row.status === "disabled") fail(403, "FORBIDDEN", "账号已停用，请联系受理机关。")
  const at = nowIso()
  await c.env.DB.prepare("UPDATE applicant_accounts SET last_login_at = ? WHERE id = ?").bind(at, row.id).run()
  const account = await import("./session").then((m) => m.loadPortal(c.env.DB, row.id))
  const token = await signToken(c.env.JWT_SECRET, row.id, "portal")
  return c.json({ ...token, account: publicPortal({ ...account!, lastLoginAt: at }) })
})

api.post("/portal/auth/logout", (c) => noContent(c))
api.get("/portal/auth/me", requirePortal, (c) => c.json(publicPortal(portalOf(c))))

api.get("/portal/applications", requirePortal, async (c) => {
  const account = portalOf(c)
  const status = c.req.query("status") ?? ""
  const rows = await c.env.DB
    .prepare("SELECT * FROM applications WHERE account_id = ? AND (? = '' OR status = ?) ORDER BY updated_at DESC")
    .bind(account.id, status, status)
    .all<Parameters<typeof readApplication>[1]>()
  const items = []
  for (const row of rows.results) items.push(await readApplication(c.env.DB, row, originOf(c)))
  return c.json(items)
})

api.post("/portal/applications", requirePortal, async (c) => {
  const account = portalOf(c)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const applicationId = id("ap")
  const at = nowIso()
  await c.env.DB
    .prepare(
      `INSERT INTO applications (
        id, application_no, account_id, type, status, purpose, intended_arrival_date, intended_stay_days,
        surname, given_names, native_name, sex, date_of_birth, place_of_birth, nationality, marital_status,
        occupation, address, phone, email, passport_number, passport_issuing_country, passport_issuing_authority,
        passport_issue_date, passport_expiry_date, review_note, file_no, submitted_at, created_at, updated_at
      ) VALUES (?, NULL, ?, 'visa', 'draft', '', '', 30, '', '', '', 'X', '', '', '', 'single', '', '', '', '', '', '', '', '', '', '', NULL, NULL, ?, ?)`,
    )
    .bind(applicationId, account.id, at, at)
    .run()
  const { sets, values } = draftAssignments(body)
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE applications SET ${sets.join(", ")} WHERE id = ?`).bind(...values, applicationId).run()
  }
  await c.env.DB
    .prepare("INSERT INTO application_timeline (application_id, status, note, actor, at) VALUES (?, 'draft', '申请已创建为草稿。', NULL, ?)")
    .bind(applicationId, at)
    .run()
  return c.json(await getApplication(c.env.DB, applicationId, originOf(c)), 201)
})

api.get("/portal/applications/:id", requirePortal, async (c) => {
  return c.json(await ownApplication(c))
})

api.put("/portal/applications/:id", requirePortal, async (c) => {
  const application = await ownApplication(c)
  if (application.status !== "draft") conflict("申请已提交，不能再修改。如需变更请先撤回申请或联系受理机关。")
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const { sets, values } = draftAssignments(body)
  const at = nowIso()
  await c.env.DB
    .prepare(`UPDATE applications SET ${sets.length ? `${sets.join(", ")}, ` : ""}updated_at = ? WHERE id = ?`)
    .bind(...values, at, application.id)
    .run()
  return c.json(await getApplication(c.env.DB, application.id, originOf(c)))
})

api.post("/portal/applications/:id/submit", requirePortal, async (c) => {
  const application = await ownApplication(c)
  if (application.status !== "draft") conflict("申请已提交，不能再修改。如需变更请先撤回申请或联系受理机关。")
  const required: [keyof typeof application, string][] = [
    ["type", "请选择申请类型"],
    ["purpose", "请填写申请事由"],
    ["intendedArrivalDate", "请选择计划入境日期"],
    ["surname", "请填写姓"],
    ["givenNames", "请填写名"],
    ["sex", "请选择性别"],
    ["dateOfBirth", "请选择出生日期"],
    ["placeOfBirth", "请填写出生地"],
    ["nationality", "请选择国籍"],
    ["maritalStatus", "请选择婚姻状况"],
    ["passportNumber", "请填写护照号码"],
    ["passportIssuingCountry", "请选择护照签发国家"],
    ["passportIssueDate", "请选择护照签发日期"],
    ["passportExpiryDate", "请选择护照有效期至"],
  ]
  const fieldErrors: Record<string, string> = {}
  for (const [field, message] of required) {
    if (!application[field]) fieldErrors[field] = message
  }
  if (!application.attachments.length) fieldErrors.attachments = "请至少上传一份申请材料"
  if (Object.keys(fieldErrors).length) fail(400, "VALIDATION_FAILED", "申请信息不完整，请补全后再提交。", fieldErrors)
  const year = new Date().getFullYear()
  let serial = await nextCounter(c.env.DB, "application", 1)
  let applicationNo = `APP-${year}-${String(serial).padStart(6, "0")}`
  while (await c.env.DB.prepare("SELECT id FROM applications WHERE application_no = ?").bind(applicationNo).first()) {
    serial = await nextCounter(c.env.DB, "application", 1)
    applicationNo = `APP-${year}-${String(serial).padStart(6, "0")}`
  }
  const at = nowIso()
  await c.env.DB
    .prepare("UPDATE applications SET application_no = ?, status = 'submitted', submitted_at = ?, review_note = '', updated_at = ? WHERE id = ?")
    .bind(applicationNo, at, at, application.id)
    .run()
  await c.env.DB
    .prepare("INSERT INTO application_timeline (application_id, status, note, actor, at) VALUES (?, 'submitted', '申请人提交申请，等待受理。', NULL, ?)")
    .bind(application.id, at)
    .run()
  const account = portalOf(c)
  await notifyStaffWith(c.env.DB, "application.review", {
    title: "有新的申请待受理",
    body: `${applicationNo} 已提交。`,
    category: "application",
    link: `/applications/${application.id}`,
  })
  await audit(c.env.DB, { type: "portal", id: account.id, name: account.fullName }, "application.submit", "application", application.id, `提交 ${applicationNo}`)
  return c.json(await getApplication(c.env.DB, application.id, originOf(c)))
})

api.post("/portal/applications/:id/withdraw", requirePortal, async (c) => {
  const application = await ownApplication(c)
  if (application.status === "draft") conflict("草稿无需撤回，可直接删除。")
  if (!["submitted", "under_review", "supplement_required"].includes(application.status)) conflict("该申请已进入终态，无法撤回。")
  const at = nowIso()
  await c.env.DB.prepare("UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ?").bind(at, application.id).run()
  await c.env.DB
    .prepare("INSERT INTO application_timeline (application_id, status, note, actor, at) VALUES (?, 'withdrawn', '申请人主动撤回申请。', NULL, ?)")
    .bind(application.id, at)
    .run()
  if (application.status === "under_review") {
    await notifyStaffWith(c.env.DB, "application.review", {
      title: "申请已被撤回",
      body: `${application.applicationNo} 在审核中被申请人撤回。`,
      category: "application",
      link: `/applications/${application.id}`,
    })
  }
  return c.json(await getApplication(c.env.DB, application.id, originOf(c)))
})

api.delete("/portal/applications/:id", requirePortal, async (c) => {
  const application = await ownApplication(c)
  if (application.status !== "draft") conflict("申请已提交，不能再修改。如需变更请先撤回申请或联系受理机关。")
  await deleteStored(c.env, "application", application.id)
  await c.env.DB.prepare("DELETE FROM attachments WHERE owner_type = 'application' AND owner_id = ?").bind(application.id).run()
  await c.env.DB.prepare("DELETE FROM application_timeline WHERE application_id = ?").bind(application.id).run()
  await c.env.DB.prepare("DELETE FROM applications WHERE id = ?").bind(application.id).run()
  return noContent(c)
})

api.post("/portal/applications/:id/attachments", requirePortal, async (c) => {
  const application = await ownApplication(c)
  if (application.status !== "draft") conflict("申请已提交，不能再修改。如需变更请先撤回申请或联系受理机关。")
  const form = await c.req.formData()
  const files = form.getAll("files").filter((file): file is File => file instanceof File)
  const added = await storeFiles(c.env.DB, c.env.FILES, "application", application.id, files, originOf(c))
  await c.env.DB.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").bind(nowIso(), application.id).run()
  return c.json(added, 201)
})

api.delete("/portal/applications/:id/attachments/:attachmentId", requirePortal, async (c) => {
  const application = await ownApplication(c)
  if (application.status !== "draft") conflict("申请已提交，不能再修改。如需变更请先撤回申请或联系受理机关。")
  await removeAttachment(c.env, c.req.param("attachmentId"))
  await c.env.DB.prepare("UPDATE applications SET updated_at = ? WHERE id = ?").bind(nowIso(), application.id).run()
  return noContent(c)
})

notificationRoutes("/portal", "portal", requirePortal)

async function ownApplication(c: Parameters<typeof portalOf>[0]) {
  const account = portalOf(c)
  const application = await getApplication(c.env.DB, c.req.param("id") ?? "", originOf(c))
  if (!application || application.accountId !== account.id) notFound("申请")
  return application
}

async function replaceRoles(db: D1Database, userId: string, roleIds: string[]) {
  if (roleIds.length) {
    const found = await db
      .prepare(`SELECT id FROM roles WHERE id IN (${roleIds.map(() => "?").join(",")})`)
      .bind(...roleIds)
      .all<{ id: string }>()
    if (found.results.length !== roleIds.length) fail(400, "VALIDATION_FAILED", "包含不存在的角色。", { roleIds: "包含不存在的角色" })
  }
  await db.prepare("DELETE FROM user_roles WHERE user_id = ?").bind(userId).run()
  for (const roleId of roleIds) {
    await db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)").bind(userId, roleId).run()
  }
}

async function assertUniqueDocument(db: D1Database, body: Record<string, string | null>, exceptId?: string) {
  const dup = await db
    .prepare(
      `SELECT id FROM documents
       WHERE id != ? AND type = ? AND issuing_country = ? AND upper(number) = upper(?)`,
    )
    .bind(exceptId ?? "", body.type, body.issuingCountry, body.number)
    .first()
  if (dup) conflict("同一签发国家下已登记相同号码的证件。", { number: "证件号码重复" })
}

async function toApplicant(db: D1Database, row: Record<string, string>) {
  const docs = await db
    .prepare("SELECT expiry_date FROM documents WHERE applicant_id = ?")
    .bind(row.id)
    .all<{ expiry_date: string | null }>()
  const horizon = Date.now() + 180 * 86_400_000
  const attentionCount = docs.results.filter((doc) => doc.expiry_date && Date.parse(doc.expiry_date) <= horizon).length
  return {
    id: row.id,
    fileNo: row.file_no,
    surname: row.surname,
    givenNames: row.given_names,
    nativeName: row.native_name,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    placeOfBirth: row.place_of_birth,
    nationality: row.nationality,
    maritalStatus: row.marital_status,
    occupation: row.occupation,
    phone: row.phone,
    email: row.email,
    address: row.address,
    remarks: row.remarks,
    status: row.status,
    documentCount: docs.results.length,
    attentionCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function toDocument(db: D1Database, row: Record<string, string | null>, origin: string) {
  return {
    id: row.id,
    applicantId: row.applicant_id,
    type: row.type,
    number: row.number,
    issuingCountry: row.issuing_country,
    issuingAuthority: row.issuing_authority,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    verification: row.verification,
    verificationNote: row.verification_note,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    attachments: await listAttachments(db, "document", String(row.id), origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRole(row: Record<string, string | number>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    permissions: JSON.parse(String(row.permissions)),
    builtIn: Boolean(row.built_in),
    userCount: Number(row.user_count),
    updatedAt: row.updated_at,
  }
}

async function deleteStored(env: AppEnv["Bindings"], ownerType: string, ownerId: string) {
  const rows = await env.DB
    .prepare("SELECT r2_key FROM attachments WHERE owner_type = ? AND owner_id = ? AND r2_key IS NOT NULL")
    .bind(ownerType, ownerId)
    .all<{ r2_key: string }>()
  for (const row of rows.results) await env.FILES.delete(row.r2_key)
}

async function removeAttachment(env: AppEnv["Bindings"], attachmentId: string) {
  const row = await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(attachmentId).first<{ r2_key: string | null }>()
  if (row?.r2_key) await env.FILES.delete(row.r2_key)
  await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachmentId).run()
}
