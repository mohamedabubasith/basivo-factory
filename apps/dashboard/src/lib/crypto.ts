// Small crypto helpers on node:crypto only. One master secret (FACTORY_SECRET) is stretched into separate keys
// per purpose, so the encryption key and the session-signing key are never the same bytes.

import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto'

export const deriveKey = (master: string, purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), `basivo-factory:${purpose}`, 32))

// AES-256-GCM. Output "v1.<base64url(iv | tag | ciphertext)>"; the version lets the format change later.
export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`
}

export function decrypt(key: Buffer, sealed: string): string {
  if (!sealed.startsWith('v1.')) throw new Error('unknown encryption format')
  const raw = Buffer.from(sealed.slice(3), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
export const hmacHex = (secret: string | Buffer, body: string): string => createHmac('sha256', secret).update(body).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// "<base64url(json)>.<hmac>": a value the browser can hold but not change.
export function signValue(key: Buffer, value: unknown): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${body}.${hmacHex(key, body)}`
}

export function verifyValue<T>(key: Buffer, signed: string | undefined): T | null {
  if (!signed) return null
  const dot = signed.lastIndexOf('.')
  if (dot < 1) return null
  const body = signed.slice(0, dot)
  if (!safeEqual(signed.slice(dot + 1), hmacHex(key, body))) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

// GitHub: "sha256=<hex>" over the raw body. Jira sends the same header format when a webhook has a secret.
export const verifyHubSignature = (secret: string, body: string, header: string | null): boolean =>
  Boolean(header) && safeEqual(header!, `sha256=${hmacHex(secret, body)}`)
