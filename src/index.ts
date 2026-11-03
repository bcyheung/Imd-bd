import { Hono } from "hono"
import { cors } from "hono/cors"

import { onError } from "./http"
import { deliverEmails } from "./notifications"
import { api } from "./routes"
import { ensureSeeded } from "./seed"
import type { AppEnv } from "./types"

const app = new Hono<AppEnv>()

app.onError(onError)

app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Accept"],
    credentials: true,
    maxAge: 86400,
  }),
)

app.use("*", async (c, next) => {
  await ensureSeeded(c.env.DB)
  await next()
  // 写操作可能产生了待发邮件，响应返回后再投递，不拖慢接口。
  if (c.req.method !== "GET" && c.env.MAIL_WEBHOOK_URL) {
    c.executionCtx.waitUntil(deliverEmails(c.env).catch((error) => console.error("deliverEmails", error)))
  }
})

app.get("/", (c) =>
  c.json({
    name: "IMS API",
    version: "0.1.0",
    base: "/api/v1",
  }),
)

app.route("/api/v1", api)

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(deliverEmails(env, 100))
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>
