const text = new TextEncoder()
const SESSION_SECONDS = 8 * 60 * 60
const ITERATIONS = 100_000

function b64url(bytes: Uint8Array) {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function b64urlDecode(value: string) {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4))
  const bin = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function pbkdf2(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", text.encode(password), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2(password, salt)
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, rounds, salt, hash] = stored.split("$")
  if (algo !== "pbkdf2" || Number(rounds) !== ITERATIONS || !salt || !hash) return false
  const actual = await pbkdf2(password, b64urlDecode(salt))
  const expected = b64urlDecode(hash)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])
}

export async function signToken(secret: string, sub: string, realm: "staff" | "portal") {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(text.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const payload = b64url(text.encode(JSON.stringify({ sub, realm, iat: now, exp: now + SESSION_SECONDS })))
  const data = `${header}.${payload}`
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), text.encode(data))
  return { accessToken: `${data}.${b64url(new Uint8Array(sig))}`, expiresIn: SESSION_SECONDS }
}

export async function readToken(secret: string, token: string | undefined) {
  if (!token) return null
  const [h, p, s] = token.split(".")
  if (!h || !p || !s) return null
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(s), text.encode(`${h}.${p}`))
  if (!ok) return null
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as {
    sub: string
    realm: "staff" | "portal"
    exp: number
  }
  if (!payload.sub || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
  return payload
}

const FILE_LINK_SECONDS = 60 * 60

/**
 * 附件链接直接放进 <a href>，带不了 Authorization 头，所以改用短时签名：
 * 只有调用过有权限的接口才能拿到链接，链接泄露后最多一小时内有效。
 * 签名原文带 "file:" 前缀，与 JWT 的 "header.payload" 不会撞上。
 */
export async function signFileLink(secret: string, fileId: string) {
  const exp = Math.floor(Date.now() / 1000) + FILE_LINK_SECONDS
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), text.encode(`file:${fileId}:${exp}`))
  return `exp=${exp}&sig=${b64url(new Uint8Array(sig))}`
}

export async function verifyFileLink(secret: string, fileId: string, exp: string | undefined, sig: string | undefined) {
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig), text.encode(`file:${fileId}:${exp}`))
  } catch {
    return false
  }
}

export function bearer(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return undefined
  return header.slice(7).trim()
}

export function id(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `${prefix}-${b64url(bytes).slice(0, 12)}`
}

export const nowIso = () => new Date().toISOString()
export const today = () => new Date().toISOString().slice(0, 10)

export function addDays(days: number) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
