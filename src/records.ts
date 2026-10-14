import { id, nowIso } from "./crypto"
import { fail } from "./http"

const MAX_BYTES = 10 * 1024 * 1024
const MAX_COUNT = 10

/** 允许的扩展名、对应的 MIME 和文件头（magic number），与前端 src/lib/upload.ts 保持一致。 */
const SIGNATURES: Record<string, { mime: string; bytes: number[] }> = {
  pdf: { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  jpg: { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  jpeg: { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  png: { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
}

export const DOCUMENT_CATEGORIES = ["passport_scan", "photo", "supporting", "other"] as const
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

export function fileUrl(origin: string, attachment: { id: string; r2_key: string | null }) {
  return attachment.r2_key ? `${origin}/api/v1/files/${attachment.id}` : "#"
}

export async function listAttachments(db: D1Database, ownerType: string, ownerId: string, origin: string) {
  const rows = await db
    .prepare(
      `SELECT id, file_name, mime_type, size, r2_key, uploaded_at
       FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY uploaded_at`,
    )
    .bind(ownerType, ownerId)
    .all<{ id: string; file_name: string; mime_type: string; size: number; r2_key: string | null; uploaded_at: string }>()
  return rows.results.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size,
    url: fileUrl(origin, row),
    uploadedAt: row.uploaded_at,
  }))
}

interface DocumentRow {
  id: string
  owner_id: string
  file_name: string
  mime_type: string
  size: number
  r2_key: string | null
  uploaded_at: string
  category: string
  source: string
  verification: string
  verification_note: string
  verified_by: string | null
  verified_at: string | null
}

function toApplicationDocument(row: DocumentRow, origin: string) {
  return {
    id: row.id,
    applicationId: row.owner_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size,
    url: fileUrl(origin, row),
    uploadedAt: row.uploaded_at,
    category: row.category,
    source: row.source,
    verification: row.verification,
    verificationNote: row.verification_note,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
  }
}

/** 工作人员视角的申请材料：申请人上传和窗口代传的都在这里，带核验状态。 */
export async function listApplicationDocuments(db: D1Database, applicationId: string, origin: string) {
  const rows = await db
    .prepare("SELECT * FROM attachments WHERE owner_type = 'application' AND owner_id = ? ORDER BY uploaded_at, id")
    .bind(applicationId)
    .all<DocumentRow>()
  return rows.results.map((row) => toApplicationDocument(row, origin))
}

export async function getApplicationDocument(db: D1Database, applicationId: string, documentId: string, origin: string) {
  const row = await db
    .prepare("SELECT * FROM attachments WHERE owner_type = 'application' AND owner_id = ? AND id = ?")
    .bind(applicationId, documentId)
    .first<DocumentRow>()
  return row ? toApplicationDocument(row, origin) : null
}

/** 还没有核验通过的申请材料份数；初审通过和终审通过前必须为 0。 */
export async function countUnverifiedDocuments(db: D1Database, applicationId: string) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM attachments WHERE owner_type = 'application' AND owner_id = ? AND verification != 'verified'")
    .bind(applicationId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

function extension(name: string) {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
}

function invalidFile(message: string): never {
  fail(400, "VALIDATION_FAILED", message, { files: message })
}

/**
 * 重复前端的上传校验：扩展名、空文件、10 MB、同名、文件头，最后看份数。
 * 全部通过才开始写入，避免一批文件只存了一半。
 */
async function checkFiles(db: D1Database, ownerType: string, ownerId: string, files: File[]) {
  const existing = await db
    .prepare("SELECT file_name FROM attachments WHERE owner_type = ? AND owner_id = ?")
    .bind(ownerType, ownerId)
    .all<{ file_name: string }>()
  const seen = new Set(existing.results.map((row) => row.file_name.toLowerCase()))
  const checked: { file: File; mime: string }[] = []
  for (const file of files) {
    const signature = SIGNATURES[extension(file.name)]
    if (!signature) invalidFile(`${file.name}：格式不支持，仅支持 PDF、JPG、PNG`)
    if (file.size === 0) invalidFile(`${file.name}：文件为空`)
    if (file.size > MAX_BYTES) invalidFile(`${file.name}：超过 10 MB`)
    if (seen.has(file.name.toLowerCase())) invalidFile(`${file.name}：已有同名文件`)
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
    if (!signature.bytes.every((byte, index) => head[index] === byte)) invalidFile(`${file.name}：文件内容与扩展名不符`)
    seen.add(file.name.toLowerCase())
    checked.push({ file, mime: signature.mime })
  }
  if (existing.results.length + checked.length > MAX_COUNT) invalidFile(`最多上传 ${MAX_COUNT} 份材料`)
  return checked
}

export async function storeFiles(
  db: D1Database,
  bucket: R2Bucket,
  ownerType: string,
  ownerId: string,
  files: File[],
  origin: string,
  meta: { category?: DocumentCategory; source?: "applicant" | "staff" } = {},
) {
  const checked = await checkFiles(db, ownerType, ownerId, files)
  const added = []
  for (const { file, mime } of checked) {
    const attachmentId = id("f")
    const key = `${ownerType}/${ownerId}/${attachmentId}`
    await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mime } })
    const uploadedAt = nowIso()
    await db
      .prepare(
        `INSERT INTO attachments (id, owner_type, owner_id, file_name, mime_type, size, r2_key, uploaded_at, category, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(attachmentId, ownerType, ownerId, file.name, mime, file.size, key, uploadedAt, meta.category ?? "other", meta.source ?? "applicant")
      .run()
    added.push({ id: attachmentId, fileName: file.name, mimeType: mime, size: file.size, url: `${origin}/api/v1/files/${attachmentId}`, uploadedAt })
  }
  return added
}

interface AppRow {
  id: string
  application_no: string | null
  account_id: string
  type: string
  status: string
  purpose: string
  intended_arrival_date: string
  intended_stay_days: number
  surname: string
  given_names: string
  native_name: string
  sex: string
  date_of_birth: string
  place_of_birth: string
  nationality: string
  marital_status: string
  occupation: string
  address: string
  phone: string
  email: string
  passport_number: string
  passport_issuing_country: string
  passport_issuing_authority: string
  passport_issue_date: string
  passport_expiry_date: string
  review_note: string
  approval_level: string | null
  file_no: string | null
  submitted_at: string | null
  created_at: string
  updated_at: string
}

export async function readApplication(db: D1Database, row: AppRow, origin: string) {
  const timeline = await db
    .prepare("SELECT status, note, actor, at FROM application_timeline WHERE application_id = ? ORDER BY id")
    .bind(row.id)
    .all<{ status: string; note: string; actor: string | null; at: string }>()
  const approvals = await db
    .prepare("SELECT * FROM application_approvals WHERE application_id = ? ORDER BY at, rowid")
    .bind(row.id)
    .all<{ id: string; level: string | null; action: string; note: string; actor_id: string; actor_name: string; at: string }>()
  return {
    id: row.id,
    applicationNo: row.application_no,
    accountId: row.account_id,
    type: row.type,
    status: row.status,
    purpose: row.purpose,
    intendedArrivalDate: row.intended_arrival_date,
    intendedStayDays: row.intended_stay_days,
    surname: row.surname,
    givenNames: row.given_names,
    nativeName: row.native_name,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    placeOfBirth: row.place_of_birth,
    nationality: row.nationality,
    maritalStatus: row.marital_status,
    occupation: row.occupation,
    address: row.address,
    phone: row.phone,
    email: row.email,
    passportNumber: row.passport_number,
    passportIssuingCountry: row.passport_issuing_country,
    passportIssuingAuthority: row.passport_issuing_authority,
    passportIssueDate: row.passport_issue_date,
    passportExpiryDate: row.passport_expiry_date,
    attachments: await listAttachments(db, "application", row.id, origin),
    reviewNote: row.review_note,
    approvalLevel: row.status === "under_review" ? (row.approval_level ?? "first_review") : null,
    approvals: approvals.results.map((a) => ({
      id: a.id,
      level: a.level,
      action: a.action,
      note: a.note,
      actorId: a.actor_id,
      actorName: a.actor_name,
      at: a.at,
    })),
    fileNo: row.file_no,
    timeline: timeline.results.map((t) => ({ status: t.status, note: t.note, actor: t.actor, at: t.at })),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getApplication(db: D1Database, id: string, origin: string) {
  const row = await db.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<AppRow>()
  return row ? readApplication(db, row, origin) : null
}

const DRAFT_COLUMNS: Record<string, string> = {
  type: "type",
  purpose: "purpose",
  intendedArrivalDate: "intended_arrival_date",
  intendedStayDays: "intended_stay_days",
  surname: "surname",
  givenNames: "given_names",
  nativeName: "native_name",
  sex: "sex",
  dateOfBirth: "date_of_birth",
  placeOfBirth: "place_of_birth",
  nationality: "nationality",
  maritalStatus: "marital_status",
  occupation: "occupation",
  address: "address",
  phone: "phone",
  email: "email",
  passportNumber: "passport_number",
  passportIssuingCountry: "passport_issuing_country",
  passportIssuingAuthority: "passport_issuing_authority",
  passportIssueDate: "passport_issue_date",
  passportExpiryDate: "passport_expiry_date",
}

export function draftAssignments(body: Record<string, unknown>) {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(DRAFT_COLUMNS)) {
    if (body[key] !== undefined && body[key] !== null) {
      sets.push(`${column} = ?`)
      values.push(body[key])
    }
  }
  return { sets, values }
}
