import type { Context } from "hono"

import type { AppEnv } from "./types"

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message)
  }
}

export function fail(status: number, code: string, message: string, fieldErrors?: Record<string, string>): never {
  throw new ApiError(status, code, message, fieldErrors)
}

export function notFound(what = "资源"): never {
  fail(404, "NOT_FOUND", `${what}不存在或已被删除。`)
}
export function conflict(message: string, fieldErrors?: Record<string, string>): never {
  fail(409, "CONFLICT", message, fieldErrors)
}
export function unauthenticated(): never {
  fail(401, "UNAUTHENTICATED", "登录已失效，请重新登录。")
}
export function forbidden(message = "当前账号没有执行此操作的权限。"): never {
  fail(403, "FORBIDDEN", message)
}

export function onError(err: Error, c: Context<AppEnv>) {
  if (err instanceof ApiError) {
    return c.json(
      { code: err.code, message: err.message, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) },
      err.status as 400,
    )
  }
  console.error(err)
  return c.json({ code: "INTERNAL", message: "服务器暂时无法处理该请求。" }, 500)
}

export function noContent(c: Context) {
  return c.body(null, 204)
}

/** 生成附件签名链接所需的上下文。 */
export interface FileLinks {
  origin: string
  secret: string
}

export function fileLinksOf(c: Context<AppEnv>): FileLinks {
  return { origin: new URL(c.req.url).origin, secret: c.env.JWT_SECRET }
}

export function pageQuery(c: Context) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") ?? 10) || 10))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function like(value: string) {
  return `%${value.replace(/[%_]/g, "")}%`
}
