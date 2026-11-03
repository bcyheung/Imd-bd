import type { DocumentCategory } from "./records"

/**
 * 各申請類型的辦理規則，與前端 src/features/portal/requirements.ts 保持一致：
 * 申請事項的日期與天數怎麼解釋、護照要求，以及要交哪些材料。
 */

export const APPLICATION_TYPES = [
  "visa",
  "residence_permit",
  "residence_extension",
  "permanent_residence",
  "travel_document",
] as const
export type ApplicationType = (typeof APPLICATION_TYPES)[number]

interface Requirement {
  key: string
  label: string
  required: boolean
  category: DocumentCategory
}

interface Flow {
  /** future：不能早於今天；past：不能晚於今天 */
  date: { when: "future" | "past"; message: string }
  /** null 表示不填（永久居留不限期），提交時記為 0 */
  stay: { min: number; max: number; message: string } | null
  passport: { allowExpired: boolean; afterDateMessage: string | null }
  documents: Requirement[]
}

const req = (key: string, label: string, required: boolean, category: DocumentCategory): Requirement => ({
  key,
  label,
  required,
  category,
})

const PASSPORT_BIO = req("passport_bio", "护照资料页", true, "passport_scan")
const PHOTO = req("photo", "证件照片", true, "photo")
const ADDRESS_PROOF = req("address_proof", "境内住址证明", true, "supporting")
const HEALTH_CHECK = req("health_check", "体检证明", true, "supporting")
const OTHER = req("other", "其他补充材料", false, "other")

export const APPLICATION_FLOWS: Record<ApplicationType, Flow> = {
  visa: {
    date: { when: "future", message: "计划入境日期不能早于今天" },
    stay: { min: 1, max: 180, message: "签证停留天数需在 1–180 之间" },
    passport: { allowExpired: false, afterDateMessage: "护照有效期需晚于计划入境日期" },
    documents: [
      PASSPORT_BIO,
      PHOTO,
      req("itinerary", "行程单或往返机票预订", true, "supporting"),
      req("accommodation", "住宿证明", true, "supporting"),
      req("financial_proof", "资金证明", true, "supporting"),
      req("invitation", "邀请函", false, "supporting"),
      req("insurance", "旅行医疗保险", false, "supporting"),
      OTHER,
    ],
  },
  residence_permit: {
    date: { when: "past", message: "入境日期不能晚于今天" },
    stay: { min: 91, max: 1825, message: "居留天数需在 91–1825 之间" },
    passport: { allowExpired: false, afterDateMessage: null },
    documents: [
      PASSPORT_BIO,
      PHOTO,
      req("entry_record", "签证及入境记录页", true, "passport_scan"),
      req("purpose_proof", "居留事由证明", true, "supporting"),
      ADDRESS_PROOF,
      HEALTH_CHECK,
      req("criminal_record", "无犯罪记录证明", false, "supporting"),
      OTHER,
    ],
  },
  residence_extension: {
    date: { when: "future", message: "延期起始日期不能早于今天" },
    stay: { min: 1, max: 1825, message: "延期天数需在 1–1825 之间" },
    passport: { allowExpired: false, afterDateMessage: "护照有效期需晚于延期起始日期" },
    documents: [
      PASSPORT_BIO,
      PHOTO,
      req("current_permit", "现持居留许可", true, "passport_scan"),
      req("continuation_proof", "居留事由持续证明", true, "supporting"),
      ADDRESS_PROOF,
      req("tax_record", "纳税或社保缴纳记录", false, "supporting"),
      OTHER,
    ],
  },
  permanent_residence: {
    date: { when: "past", message: "首次入境日期不能晚于今天" },
    stay: null,
    passport: { allowExpired: false, afterDateMessage: null },
    documents: [
      PASSPORT_BIO,
      PHOTO,
      req("residence_history", "历年居留许可", true, "passport_scan"),
      req("income_proof", "收入及纳税证明", true, "supporting"),
      req("criminal_record", "无犯罪记录证明", true, "supporting"),
      HEALTH_CHECK,
      ADDRESS_PROOF,
      req("family_proof", "亲属关系证明", false, "supporting"),
      OTHER,
    ],
  },
  travel_document: {
    date: { when: "future", message: "计划出行日期不能早于今天" },
    stay: { min: 1, max: 90, message: "行程天数需在 1–90 之间" },
    passport: { allowExpired: true, afterDateMessage: null },
    documents: [
      req("loss_report", "遗失报案或损毁证明", true, "supporting"),
      req("identity_proof", "国籍身份证明", true, "supporting"),
      PHOTO,
      req("passport_copy", "原护照资料页", false, "passport_scan"),
      req("itinerary", "行程安排", false, "supporting"),
      OTHER,
    ],
  },
}

export function flowOf(type: string): Flow | null {
  return APPLICATION_FLOWS[type as ApplicationType] ?? null
}

/** 找出該類型清單裡的一項；不在清單裡回 null */
export function findRequirement(type: string, key: string) {
  return flowOf(type)?.documents.find((doc) => doc.key === key) ?? null
}

interface SubmitCheck {
  type: string
  intendedArrivalDate: string
  intendedStayDays: number
  passportExpiryDate: string
  attachments: { requirement?: string | null }[]
}

/**
 * 提交時按申請類型校驗日期、天數、護照有效期和必交材料，回傳逐欄位錯誤。
 * 材料都沒有 requirement 時（舊版前端上傳）只要求至少一份，不按清單核對。
 */
export function checkByType(application: SubmitCheck, today: string): Record<string, string> {
  const flow = flowOf(application.type)
  const errors: Record<string, string> = {}
  if (!flow) return errors

  const date = application.intendedArrivalDate
  if (date && (flow.date.when === "future" ? date < today : date > today)) {
    errors.intendedArrivalDate = flow.date.message
  }

  const days = application.intendedStayDays
  if (flow.stay && (!Number.isInteger(days) || days < flow.stay.min || days > flow.stay.max)) {
    errors.intendedStayDays = flow.stay.message
  }

  const expiry = application.passportExpiryDate
  if (expiry && !flow.passport.allowExpired) {
    if (expiry <= today) errors.passportExpiryDate = "护照已过期，请先换发后再提交申请"
    else if (flow.passport.afterDateMessage && date && expiry <= date) {
      errors.passportExpiryDate = flow.passport.afterDateMessage
    }
  }

  const keys = new Set(application.attachments.map((a) => a.requirement).filter(Boolean))
  if (keys.size) {
    const missing = flow.documents.filter((doc) => doc.required && !keys.has(doc.key))
    if (missing.length) errors.attachments = `缺少必交材料：${missing.map((doc) => doc.label).join("、")}`
  }
  return errors
}
