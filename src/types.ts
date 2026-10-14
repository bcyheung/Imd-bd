export type ID = string

export type PermissionCode =
  | "applicant.read"
  | "applicant.create"
  | "applicant.update"
  | "applicant.delete"
  | "document.read"
  | "document.create"
  | "document.update"
  | "document.delete"
  | "document.verify"
  | "user.read"
  | "user.manage"
  | "role.read"
  | "role.manage"
  | "application.review"
  | "application.approve"

export interface Env {
  DB: D1Database
  FILES: R2Bucket
  JWT_SECRET: string
}

export interface StaffUser {
  id: ID
  username: string
  fullName: string
  employeeId: string
  department: string
  email: string
  phone: string
  status: "pending" | "active" | "disabled" | "rejected"
  roles: { id: ID; code: string; name: string }[]
  permissions: PermissionCode[]
  lastLoginAt: string | null
  createdAt: string
}

export interface PortalAccount {
  id: ID
  email: string
  fullName: string
  phone: string
  status: "active" | "disabled"
  lastLoginAt: string | null
  createdAt: string
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    staff: StaffUser
    portal: PortalAccount
  }
}
