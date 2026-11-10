// 按申請類型的材料清單與提交校驗。用法：先 npm run dev，再 npm run check:requirements
const base = (process.env.API_BASE ?? "http://127.0.0.1:8787") + "/api/v1"

async function call(path, options = {}) {
  const response = await fetch(base + path, options)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

function expect(condition, message, detail) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`)
  console.log(`ok - ${message}`)
}

const email = `requirements.${Date.now()}@example.test`
const account = await call("/portal/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fullName: "Requirement Check", email, phone: "+1 512 555 0100", password: "Requirement2026" }),
})
expect(account.status === 201 || account.status === 200, "register portal account", account)
const auth = { Authorization: `Bearer ${account.body.accessToken}` }
const json = { ...auth, "Content-Type": "application/json" }

const nextYear = new Date().getUTCFullYear() + 1
const draft = {
  type: "visa",
  purpose: "Invited to attend an industry trade fair and discuss business partnerships.",
  intendedArrivalDate: `${nextYear}-01-10`,
  intendedStayDays: 14,
  surname: "DOE",
  givenNames: "JANE",
  sex: "F",
  dateOfBirth: "1990-01-01",
  placeOfBirth: "Austin",
  nationality: "USA",
  maritalStatus: "single",
  phone: "+1 512 555 0100",
  email,
  passportNumber: "X1234567",
  passportIssuingCountry: "USA",
  passportIssuingAuthority: "DOS",
  passportIssueDate: "2020-01-01",
  passportExpiryDate: `${nextYear + 5}-01-01`,
}

async function createDraft() {
  const created = await call("/portal/applications", { method: "POST", headers: json, body: JSON.stringify(draft) })
  return created.body.id
}

async function upload(applicationId, name, requirement) {
  const form = new FormData()
  form.append("files", new File(["%PDF-1.4\n% check\n"], name, { type: "application/pdf" }))
  if (requirement) form.append("requirement", requirement)
  return call(`/portal/applications/${applicationId}/attachments`, { method: "POST", headers: auth, body: form })
}

const submit = (applicationId) => call(`/portal/applications/${applicationId}/submit`, { method: "POST", headers: auth })
const update = (applicationId, patch) =>
  call(`/portal/applications/${applicationId}`, { method: "PUT", headers: json, body: JSON.stringify(patch) })

const visa = await createDraft()

const first = await upload(visa, "passport.pdf", "passport_bio")
expect(first.status === 201 && first.body[0].requirement === "passport_bio", "upload returns requirement", first)

const wrong = await upload(visa, "health.pdf", "health_check")
expect(wrong.status === 400 && wrong.body.fieldErrors?.requirement, "reject requirement outside the type", wrong)

const missing = await submit(visa)
expect(missing.status === 400 && missing.body.fieldErrors?.attachments?.includes("资金证明"), "list missing documents", missing)

for (const key of ["photo", "itinerary", "accommodation", "financial_proof"]) await upload(visa, `${key}.pdf`, key)

await update(visa, { intendedStayDays: 400, intendedArrivalDate: "2020-01-01" })
const invalid = await submit(visa)
expect(
  invalid.status === 400 && invalid.body.fieldErrors?.intendedStayDays && invalid.body.fieldErrors?.intendedArrivalDate,
  "validate stay range and date by type",
  invalid,
)

await update(visa, { intendedStayDays: 14, intendedArrivalDate: draft.intendedArrivalDate })
const detail = await call(`/portal/applications/${visa}`, { headers: auth })
expect(detail.body.attachments.every((a) => a.requirement), "detail returns requirement for every file", detail.body.attachments)

const submitted = await submit(visa)
expect(submitted.status === 200 && submitted.body.applicationNo, "submit once checklist is complete", submitted)

// 舊版前端不傳 requirement：只要有一份材料就能提交
const legacy = await createDraft()
await upload(legacy, "legacy.pdf")
const legacySubmitted = await submit(legacy)
expect(legacySubmitted.status === 200, "legacy upload without requirement still submits", legacySubmitted)

console.log("requirements check passed")
