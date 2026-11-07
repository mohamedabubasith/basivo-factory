import { describe, expect, it } from 'vitest'
import { decrypt, deriveKey, encrypt, hmacHex, signValue, verifyHubSignature, verifyValue } from '../src/lib/crypto.ts'

const master = 'x'.repeat(40)

describe('crypto helpers', () => {
  it('encrypts and decrypts, with a fresh nonce each time', () => {
    const key = deriveKey(master, 'secrets')
    const a = encrypt(key, 'token-123')
    expect(a).not.toBe(encrypt(key, 'token-123'))
    expect(decrypt(key, a)).toBe('token-123')
  })
  it('refuses tampered ciphertext and the wrong key', () => {
    const key = deriveKey(master, 'secrets')
    const sealed = encrypt(key, 'token-123')
    const raw = Buffer.from(sealed.slice(3), 'base64url')
    raw[raw.length - 1]! ^= 1
    expect(() => decrypt(key, `v1.${raw.toString('base64url')}`)).toThrow()
    expect(() => decrypt(deriveKey(master, 'session'), sealed)).toThrow()
  })
  it('keeps purposes apart', () => {
    expect(deriveKey(master, 'secrets').equals(deriveKey(master, 'session'))).toBe(false)
  })
  it('signs session values and rejects any change', () => {
    const key = deriveKey(master, 'session')
    const s = signValue(key, { login: 'abu', exp: 1 })
    expect(verifyValue(key, s)).toEqual({ login: 'abu', exp: 1 })
    const forged = signValue(key, { login: 'abu', exp: 1 }).replace(/^[^.]+/, Buffer.from('{"login":"evil","exp":1}').toString('base64url'))
    expect(verifyValue(key, forged)).toBeNull()
    expect(verifyValue(key, undefined)).toBeNull()
  })
  it('checks webhook signatures', () => {
    const body = '{"a":1}'
    expect(verifyHubSignature('s3cret', body, `sha256=${hmacHex('s3cret', body)}`)).toBe(true)
    expect(verifyHubSignature('s3cret', body, `sha256=${hmacHex('other', body)}`)).toBe(false)
    expect(verifyHubSignature('s3cret', body, null)).toBe(false)
  })
})
