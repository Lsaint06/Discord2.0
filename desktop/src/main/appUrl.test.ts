import { join, resolve, sep } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppUrl, resolveAppFile } from './appUrl'

describe('isAppUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('trusts only the packaged app origin', () => {
    expect(isAppUrl('app://discord2/index.html')).toBe(true)
    expect(isAppUrl('app://discord2/')).toBe(true)
    expect(isAppUrl('app://discord2')).toBe(true)
    for (const url of [
      'file:///C:/Users/x/Downloads/evil.html',
      'file://',
      'app://discord2.evil/index.html',
      'app://evil/index.html',
      'app://discord2:8080/index.html',
      'https://discord2/',
      'http://localhost:5173/',
      '',
      undefined
    ]) {
      expect(isAppUrl(url), String(url)).toBe(false)
    }
  })

  it('trusts the dev server origin only while running the dev server', () => {
    expect(isAppUrl('http://localhost:5173/index.html')).toBe(false)
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    expect(isAppUrl('http://localhost:5173/index.html')).toBe(true)
    expect(isAppUrl('http://localhost:5174/index.html')).toBe(false)
  })
})

describe('resolveAppFile', () => {
  const root = resolve('/srv/app/renderer')

  it('maps app URLs to files inside the renderer folder', () => {
    expect(resolveAppFile(root, 'app://discord2/')).toBe(join(root, 'index.html'))
    expect(resolveAppFile(root, 'app://discord2/index.html')).toBe(join(root, 'index.html'))
    expect(resolveAppFile(root, 'app://discord2/assets/index-abc.js')).toBe(
      join(root, 'assets', 'index-abc.js')
    )
    expect(resolveAppFile(root, 'app://discord2/assets/a%20b.png')).toBe(
      join(root, 'assets', 'a b.png')
    )
  })

  const inside = (file: string | null): boolean => file === null || file.startsWith(root + sep)

  it('never resolves outside the folder, whatever the URL', () => {
    for (const url of [
      'app://discord2/../../secret.txt',
      'app://discord2/a/../../../b.txt',
      'app://discord2/%2e%2e/%2e%2e/secret.txt',
      'app://discord2/..%2f..%2fsecret.txt',
      'app://discord2/..%5c..%5csecret.txt',
      'app://discord2/%2e%2e%5c%2e%2e%5cwindows%5cwin.ini',
      'app://discord2/C:%5cWindows%5cwin.ini'
    ]) {
      expect(inside(resolveAppFile(root, url)), url).toBe(true)
    }
  })

  it('refuses other hosts, encoded separators that would escape, NUL bytes and bad encodings', () => {
    for (const url of [
      'app://other/index.html',
      'file:///etc/passwd',
      'app://discord2/..%2f..%2fsecret.txt',
      'app://discord2/..%5c..%5csecret.txt',
      'app://discord2/%00index.html',
      'app://discord2/%E0%A4%A',
      'not a url'
    ]) {
      expect(resolveAppFile(root, url), url).toBeNull()
    }
  })
})
