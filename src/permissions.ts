import type { PermissionCode } from "./types"

export const PERMISSIONS: {
  code: PermissionCode
  name: string
  description: string
  module: "applicant" | "document" | "application" | "user" | "role"
}[] = [
  { code: "applicant.read", module: "applicant", name: "查看档案", description: "检索和查看申请人个人信息" },
  { code: "applicant.create", module: "applicant", name: "新建档案", description: "为新申请人建立档案" },
  { code: "applicant.update", module: "applicant", name: "编辑档案", description: "修改个人信息与档案状态" },
  { code: "applicant.delete", module: "applicant", name: "删除档案", description: "永久删除档案，操作不可撤销" },
  { code: "document.read", module: "document", name: "查看证件", description: "查看证件信息与附件" },
  { code: "document.create", module: "document", name: "登记证件", description: "登记新证件并上传扫描件" },
  { code: "document.update", module: "document", name: "编辑证件", description: "修改证件信息与附件" },
  { code: "document.delete", module: "document", name: "删除证件", description: "删除证件记录" },
  { code: "document.verify", module: "document", name: "核验证件", description: "标记证件核验通过或驳回" },
  { code: "application.review", module: "application", name: "初审申请", description: "受理申请并作出初审意见" },
  { code: "application.approve", module: "application", name: "终审申请", description: "对初审通过的申请作出最终决定" },
  { code: "user.read", module: "user", name: "查看用户", description: "查看工作人员账号列表" },
  { code: "user.manage", module: "user", name: "管理用户", description: "新建、审批、停用账号及分配角色" },
  { code: "role.read", module: "role", name: "查看角色", description: "查看角色及其权限" },
  { code: "role.manage", module: "role", name: "管理角色", description: "新建、编辑和删除角色" },
]

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.code)
