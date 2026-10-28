/**
 * Outgoing email (verification and password-reset codes). Transports:
 *   - smtp:   any standard SMTP relay / transactional provider (STARTTLS or implicit TLS).
 *   - file:   development sink: each message is written as a JSON file (never in production).
 *   - memory: automated tests (BuildOptions.mailer).
 *   - none:   email features are unavailable (registration stays invite-only).
 *
 * Messages are queued and sent in the background (MailOutbox), so an HTTP response never waits
 * for — or reveals by its timing — whether an email was actually sent to an address.
 * Message bodies contain one-time codes: they are never logged.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import nodemailer, { type Transporter } from 'nodemailer'
import type { MailConfig } from '../config.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  readonly kind: 'smtp' | 'file' | 'memory' | 'none'
  send(message: MailMessage): Promise<void>
}

export class NoMailer implements Mailer {
  readonly kind = 'none' as const
  async send(): Promise<void> {
    throw new Error('Email is not configured on this server')
  }
}

/** Collects messages for tests. */
export class MemoryMailer implements Mailer {
  readonly kind = 'memory' as const
  readonly sent: MailMessage[] = []
  /** When set, send() fails (delivery-failure tests). */
  failWith: Error | null = null

  async send(message: MailMessage): Promise<void> {
    if (this.failWith) throw this.failWith
    this.sent.push(message)
  }

  /** Messages to one address (oldest first). */
  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address)
  }

  clear(): void {
    this.sent.length = 0
  }
}

/** Development mail sink: one JSON file per message in `dir`. */
export class FileMailer implements Mailer {
  readonly kind = 'file' as const
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  async send(message: MailMessage): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${stamp}-${randomBytes(4).toString('hex')}.json`
    writeFileSync(join(this.dir, name), JSON.stringify(message, null, 2), { mode: 0o600 })
  }
}

export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const
  private readonly transport: Transporter

  constructor(private readonly config: Extract<MailConfig, { transport: 'smtp' }>) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // Implicit TLS (usually port 465); otherwise STARTTLS, which is required unless the relay
      // is explicitly allowed to be plain text (only for a local test relay).
      secure: config.secure,
      requireTLS: !config.secure && !config.allowInsecure,
      auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      tls: { minVersion: 'TLSv1.2' }
    })
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {})
    })
  }
}

export function createMailer(config: MailConfig): Mailer {
  switch (config.transport) {
    case 'smtp':
      return new SmtpMailer(config)
    case 'file':
      return new FileMailer(config.dir)
    default:
      return new NoMailer()
  }
}

/** Masks an address for logs: "al***@example.com". */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 1) return '***'
  return `${address.slice(0, Math.min(2, at))}***${address.slice(at)}`
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? `${err.name}:${code}` : err.name
  }
  return 'unknown'
}

/**
 * Background delivery with one retry. Failures are logged with a masked address and the error
 * class only (never the message, which contains a one-time code).
 */
export class MailOutbox {
  private queue: Promise<void> = Promise.resolve()
  private inFlight = 0

  constructor(
    readonly mailer: Mailer,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>,
    private readonly retryDelayMs = 5_000
  ) {}

  get available(): boolean {
    return this.mailer.kind !== 'none'
  }

  enqueue(message: MailMessage, purpose: string): void {
    if (!this.available) return
    this.inFlight++
    this.queue = this.queue
      .then(async () => {
        try {
          await this.mailer.send(message)
        } catch (first) {
          this.log.warn(
            { purpose, to: maskEmail(message.to), err: describeError(first) },
            'email delivery failed; retrying once'
          )
          await new Promise((r) => setTimeout(r, this.retryDelayMs))
          await this.mailer.send(message)
        }
      })
      .catch((err: unknown) => {
        this.log.error(
          { purpose, to: maskEmail(message.to), err: describeError(err) },
          'email delivery failed'
        )
      })
      .finally(() => {
        this.inFlight--
      })
  }

  /** Resolves when everything queued so far has been attempted (tests). */
  async drain(): Promise<void> {
    while (this.inFlight > 0) await this.queue
  }
}
