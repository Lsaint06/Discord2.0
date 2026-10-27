/**
 * Password hashing with Argon2id from Node's built-in crypto (OpenSSL 3.2+; Node ≥ 24.7).
 * No native add-on, so the same code runs on Windows x64 and the Jetson (Linux ARM64).
 *
 * Stored format: the standard PHC string
 *   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt b64>$<hash b64>
 * Only the encoding below is ours; the hashing itself is OpenSSL's Argon2 implementation.
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'
import * as nodeCrypto from 'node:crypto'

/** Fails fast with a clear message on a Node.js without built-in Argon2 (needs ≥ 24.7). */
export function assertArgon2Available(): void {
  if (typeof (nodeCrypto as { argon2?: unknown }).argon2 !== 'function') {
    throw new Error(
      `This Node.js (${process.version}) has no built-in Argon2. Use Node.js 24.7 or newer (the Docker image uses node:24).`
    )
  }
}

export interface Argon2Params {
  /** Memory cost in KiB. */
  memoryKiB: number
  /** Iterations (t). */
  passes: number
  /** Lanes (p). */
  parallelism: number
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id (m=19 MiB, t=2, p=1). */
export const OWASP_MINIMUM: Argon2Params = { memoryKiB: 19_456, passes: 2, parallelism: 1 }

/**
 * Default: RFC 9106's second recommended option (m=64 MiB, t=3, p=4). Well above the OWASP
 * minimum; ~60 ms on a desktop CPU. Benchmark on the Jetson with `npm run bench:argon2`.
 */
export const DEFAULT_ARGON2: Argon2Params = { memoryKiB: 65_536, passes: 3, parallelism: 4 }

const SALT_BYTES = 16
const TAG_BYTES = 32

function argon2id(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength: TAG_BYTES,
        memory: params.memoryKiB,
        passes: params.passes
      },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '')

interface ParsedHash {
  params: Argon2Params
  salt: Buffer
  hash: Buffer
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{16,128})$/

export function parsePasswordHash(phc: string): ParsedHash | null {
  const m = PHC.exec(phc)
  if (!m) return null
  return {
    params: { memoryKiB: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) },
    salt: Buffer.from(m[4]!, 'base64'),
    hash: Buffer.from(m[5]!, 'base64')
  }
}

export class HashBusyError extends Error {
  constructor() {
    super('Password hashing is busy')
  }
}

/**
 * Limits concurrent hashing so a burst of logins can't exhaust the Jetson's memory
 * (each hash holds `memoryKiB` of RAM). Excess requests wait; beyond `maxQueue` they fail fast.
 */
export class HashGate {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) throw new HashBusyError()
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export function validateArgon2Params(params: Argon2Params): void {
  const ok =
    Number.isInteger(params.memoryKiB) &&
    Number.isInteger(params.passes) &&
    Number.isInteger(params.parallelism) &&
    params.memoryKiB >= OWASP_MINIMUM.memoryKiB &&
    params.memoryKiB <= 1_048_576 &&
    params.passes >= 1 &&
    params.passes <= 16 &&
    params.parallelism >= 1 &&
    params.parallelism <= 8 &&
    // t=1 is only acceptable with proportionally more memory (OWASP: m=46 MiB, t=1).
    params.memoryKiB * params.passes >= OWASP_MINIMUM.memoryKiB * OWASP_MINIMUM.passes
  if (!ok) {
    throw new Error(
      'Argon2 parameters must meet the OWASP minimum (m ≥ 19456 KiB with t ≥ 2, or equivalent) and stay within sane bounds.'
    )
  }
}

export class PasswordHasher {
  private dummy: Promise<string> | null = null

  constructor(
    readonly params: Argon2Params = DEFAULT_ARGON2,
    private readonly gate = new HashGate(2, 32)
  ) {
    validateArgon2Params(params)
  }

  /** Hashes with a fresh random salt. */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES)
    const p = this.params
    const tag = await this.gate.run(() => argon2id(password, salt, p))
    return `$argon2id$v=19$m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(tag)}`
  }

  /** Constant-time comparison; false for malformed or unknown formats. */
  async verify(phc: string, password: string): Promise<boolean> {
    const parsed = parsePasswordHash(phc)
    if (!parsed) return false
    // Refuse absurd stored parameters (a tampered row must not be able to exhaust memory).
    const p = parsed.params
    if (p.memoryKiB > 1_048_576 || p.passes > 16 || p.parallelism > 8 || p.memoryKiB < 8) {
      return false
    }
    const tag = await this.gate.run(() => argon2id(password, parsed.salt, p))
    return tag.length === parsed.hash.length && timingSafeEqual(tag, parsed.hash)
  }

  /** True when the stored hash uses different (e.g. older, weaker) parameters. Rehash on login. */
  needsRehash(phc: string): boolean {
    const parsed = parsePasswordHash(phc)
    if (!parsed) return true
    const p = parsed.params
    return (
      p.memoryKiB !== this.params.memoryKiB ||
      p.passes !== this.params.passes ||
      p.parallelism !== this.params.parallelism
    )
  }

  /**
   * Takes as long as a real verification. Used when the account doesn't exist or has no
   * password, so response timing doesn't reveal which usernames exist.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash(randomBytes(16).toString('hex'))
    await this.verify(await this.dummy, password)
  }
}
