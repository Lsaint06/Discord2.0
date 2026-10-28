/**
 * Email texts. Plain language, no links (codes are typed into the app), no tracking. Every
 * message says what to do if you didn't ask for it.
 */
import type { MailMessage } from './mailer.js'

const APP = 'Discord 2.0'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function html(paragraphs: string[], code?: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${escapeHtml(p)}</p>`)
  if (code) {
    body.splice(
      1,
      0,
      `<p style="margin:0 0 14px;font-size:26px;font-weight:700;letter-spacing:4px;font-family:Consolas,monospace">${escapeHtml(code)}</p>`
    )
  }
  return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222;max-width:520px">${body.join('')}</body></html>`
}

function message(to: string, subject: string, lines: string[], code?: string): MailMessage {
  const text = code ? [lines[0], '', `    ${code}`, '', ...lines.slice(1)].join('\n') : lines.join('\n\n')
  return { to, subject, text, html: html(lines, code) }
}

export function verificationEmail(to: string, username: string, code: string, minutes: number): MailMessage {
  return message(
    to,
    `${code} is your ${APP} verification code`,
    [
      `Hi ${username}, enter this code in ${APP} to confirm your email address:`,
      `The code expires in ${minutes} minutes and works once.`,
      `If you didn't create a ${APP} account, you can ignore this email — the account won't be activated.`
    ],
    code
  )
}

export function emailChangeEmail(to: string, username: string, code: string, minutes: number): MailMessage {
  return message(
    to,
    `${code} is your ${APP} email confirmation code`,
    [
      `Hi ${username}, enter this code in ${APP} to add this email address to your account:`,
      `The code expires in ${minutes} minutes and works once.`,
      `If you didn't ask for this, ignore this email — nothing changes.`
    ],
    code
  )
}

export function passwordResetEmail(to: string, username: string, code: string, minutes: number): MailMessage {
  return message(
    to,
    `Reset your ${APP} password`,
    [
      `Hi ${username}, someone (hopefully you) asked to reset the password of your ${APP} account. Enter this code in the app:`,
      `The code expires in ${minutes} minutes and works once. Resetting signs you out on every device.`,
      `If you didn't ask for this, ignore this email — your password stays the same.`
    ],
    code
  )
}

/** Sent instead of a code when someone tries to register with an address that already has an account. */
export function accountExistsEmail(to: string): MailMessage {
  return message(to, `You already have a ${APP} account`, [
    `Someone tried to create a new ${APP} account with this email address, but it already belongs to an account.`,
    `If that was you, sign in instead — or use "Forgot your password?" on the sign-in screen.`,
    `If it wasn't you, no action is needed: no new account was created.`
  ])
}
