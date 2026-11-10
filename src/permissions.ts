import type { PermissionCode } from "./types"

export const PERMISSIONS: {
  code: PermissionCode
  name: string
  description: string
  module: "applicant" | "document" | "application" | "user" | "role"
}[] = [
  { code: "applicant.read", module: "applicant", name: "View records", description: "Search and view applicant personal details" },
  { code: "applicant.create", module: "applicant", name: "Create records", description: "Open a record for a new applicant" },
  { code: "applicant.update", module: "applicant", name: "Edit records", description: "Change personal details and record status" },
  { code: "applicant.delete", module: "applicant", name: "Delete records", description: "Permanently delete records; this cannot be undone" },
  { code: "document.read", module: "document", name: "View documents", description: "View document details and attachments" },
  { code: "document.create", module: "document", name: "Register documents", description: "Register new documents and upload scans" },
  { code: "document.update", module: "document", name: "Edit documents", description: "Change document details and attachments" },
  { code: "document.delete", module: "document", name: "Delete documents", description: "Delete document records" },
  { code: "document.verify", module: "document", name: "Verify documents", description: "Mark documents as verified or rejected" },
  { code: "application.review", module: "application", name: "First review", description: "Accept applications and give a first-review decision" },
  { code: "application.approve", module: "application", name: "Final review", description: "Make the final decision on applications that passed first review" },
  { code: "user.read", module: "user", name: "View users", description: "View the list of staff accounts" },
  { code: "user.manage", module: "user", name: "Manage users", description: "Create, approve and disable accounts and assign roles" },
  { code: "role.read", module: "role", name: "View roles", description: "View roles and their permissions" },
  { code: "role.manage", module: "role", name: "Manage roles", description: "Create, edit and delete roles" },
]

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.code)
