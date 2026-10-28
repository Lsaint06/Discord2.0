import { describe, expect, it } from 'vitest'
import { NetErrorLog, netErrorCode, originOf } from './netErrorLog'

describe('network error log', () => {
  it('normalizes request URLs to a server origin (ws -> http, wss -> https)', () => {
    expect(originOf('https://landhoev3.duckdns.org/api/meta')).toBe('https://landhoev3.duckdns.org')
    expect(originOf('wss://landhoev3.duckdns.org/gateway')).toBe('https://landhoev3.duckdns.org')
    expect(originOf('ws://192.168.68.65:3001/gateway')).toBe('http://192.168.68.65:3001')
    expect(originOf('app://discord2/index.html')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })

  it('keeps Chromium error codes, ignoring cancellations', () => {
    expect(netErrorCode('net::ERR_CERT_DATE_INVALID')).toBe('ERR_CERT_DATE_INVALID')
    expect(netErrorCode('net::ERR_NAME_NOT_RESOLVED')).toBe('ERR_NAME_NOT_RESOLVED')
    expect(netErrorCode('net::ERR_ABORTED')).toBeNull()
    expect(netErrorCode('something else')).toBeNull()
  })

  it('remembers the last error per origin, forgets it on success and after two minutes', () => {
    const log = new NetErrorLog()
    log.record('https://landhoev3.duckdns.org/api/meta', 'net::ERR_CERT_AUTHORITY_INVALID', 1000)
    expect(log.lookup('https://landhoev3.duckdns.org', 2000)).toBe('ERR_CERT_AUTHORITY_INVALID')
    expect(log.lookup('https://landhoev3.duckdns.org/', 2000)).toBe('ERR_CERT_AUTHORITY_INVALID')
    expect(log.lookup('http://192.168.68.65:3001', 2000)).toBeNull()
    expect(log.lookup('https://landhoev3.duckdns.org', 1000 + 2 * 60_000 + 1)).toBeNull()
    log.clear('https://landhoev3.duckdns.org/api/meta')
    expect(log.lookup('https://landhoev3.duckdns.org', 2000)).toBeNull()
  })

  it('stays small', () => {
    const log = new NetErrorLog(3)
    for (let i = 0; i < 10; i++) log.record(`https://host${i}.example/x`, 'net::ERR_TIMED_OUT', i)
    expect(log.lookup('https://host0.example', 10)).toBeNull()
    expect(log.lookup('https://host9.example', 10)).toBe('ERR_TIMED_OUT')
  })
})
