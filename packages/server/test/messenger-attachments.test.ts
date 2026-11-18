import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { MAX_ATTACHMENT_BYTES, parseMultipartAttachment, validateAttachment } from '../src/messenger-attachments.js'

describe('messenger attachment validation', () => {
  it.each(['payload.exe', 'a.pdf.exe', 'document.docm', '../safe.txt', '..\\safe.txt', '/safe.txt', 'a%2ftxt.txt'])('rejects unsafe name %s', name => {
    expect(() => validateAttachment(name, Buffer.from('hello'))).toThrow()
  })
  it('rejects size above 25 MB', () => {
    expect(() => validateAttachment('big.txt', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).toThrow('25 MB')
  })
  it('rejects extension and magic mismatch', () => {
    expect(() => validateAttachment('fake.png', Buffer.from('%PDF-1.7'))).toThrow('does not match')
    expect(() => validateAttachment('fake.txt', Buffer.from('MZexecutable'))).toThrow('does not match')
    expect(() => validateAttachment('fake.json', Buffer.from('not json'))).toThrow('does not match')
  })
  it.each([
    ['sample.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'],
    ['sample.jpg', Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
    ['sample.webp', Buffer.from('RIFF0000WEBP'), 'image/webp'],
    ['sample.gif', Buffer.from('GIF89a'), 'image/gif'],
    ['sample.pdf', Buffer.from('%PDF-1.7'), 'application/pdf'],
    ['sample.txt', Buffer.from('한글 text'), 'text/plain'],
    ['sample.md', Buffer.from('# title'), 'text/markdown'],
    ['sample.csv', Buffer.from('a,b\n1,2'), 'text/csv'],
    ['sample.json', Buffer.from('{"ok":true}'), 'application/json'],
    ['sample.zip', Buffer.from([80, 75, 5, 6]), 'application/zip'],
  ] as const)('accepts allowlisted %s and hashes bytes', (name, data, mime) => {
    expect(validateAttachment(name, data)).toEqual({ mime, sha256: createHash('sha256').update(data).digest('hex') })
  })
  it('accepts the exact size boundary', () => {
    expect(validateAttachment('limit.txt', Buffer.alloc(MAX_ATTACHMENT_BYTES, 65)).mime).toBe('text/plain')
  })
  it('parses a binary-preserving multipart file', () => {
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255])
    const payload = Buffer.concat([Buffer.from('--abc\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n'), data, Buffer.from('\r\n--abc--\r\n')])
    expect(parseMultipartAttachment('multipart/form-data; boundary=abc', payload)).toEqual({ name: 'image.png', data })
  })
  it('rejects truncated multipart and multiple files', () => {
    const part = '--abc\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello'
    expect(() => parseMultipartAttachment('multipart/form-data; boundary=abc', Buffer.from(part))).toThrow('Incomplete')
    expect(() => parseMultipartAttachment('multipart/form-data; boundary=abc', Buffer.from(`${part}\r\n${part}\r\n--abc--\r\n`))).toThrow('Exactly one')
  })
})
