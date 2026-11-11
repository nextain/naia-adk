import { createHash } from 'node:crypto'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export class AttachmentError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message)
    this.name = 'AttachmentError'
  }
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', zip: 'application/zip',
}

function starts(data: Buffer, signature: string | number[]): boolean {
  const bytes = typeof signature === 'string' ? Buffer.from(signature, 'ascii') : Buffer.from(signature)
  return data.subarray(0, bytes.length).equals(bytes)
}

/** Validate before writing bytes; client MIME headers never establish the file type. */
export function validateAttachment(name: string, data: Buffer): { mime: string; sha256: string } {
  if (data.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError('Attachment exceeds 25 MB', 413)
  if (!name || name.length > 255 || /[/\\\x00-\x1f\x7f]/u.test(name) || name !== name.trim()
    || !/^[^.]+\.[a-zA-Z0-9]+$/u.test(name) || /[:%]/u.test(name)) {
    throw new AttachmentError('Invalid attachment filename')
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const mime = MIME[extension]
  if (!mime) throw new AttachmentError('Attachment extension is not allowed')
  let valid = false
  switch (extension) {
    case 'png': valid = starts(data, [137, 80, 78, 71, 13, 10, 26, 10]); break
    case 'jpg': valid = starts(data, [255, 216, 255]); break
    case 'gif': valid = starts(data, 'GIF87a') || starts(data, 'GIF89a'); break
    case 'webp': valid = starts(data, 'RIFF') && data.subarray(8, 12).toString('ascii') === 'WEBP'; break
    case 'pdf': valid = starts(data, '%PDF-'); break
    case 'zip': valid = starts(data, [80, 75, 3, 4]) || starts(data, [80, 75, 5, 6]) || starts(data, [80, 75, 7, 8]); break
    default: {
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(data)
        valid = !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)
          && !starts(data, 'MZ') && !starts(data, [127, 69, 76, 70])
          && !starts(data, '%PDF-') && !starts(data, 'GIF87a') && !starts(data, 'GIF89a')
          && !(starts(data, 'RIFF') && data.subarray(8, 12).toString('ascii') === 'WEBP')
          && !starts(data, [80, 75, 3, 4]) && !starts(data, [80, 75, 5, 6]) && !starts(data, [80, 75, 7, 8])
        if (extension === 'json') JSON.parse(value)
      } catch { valid = false }
    }
  }
  if (!valid) throw new AttachmentError('Attachment content does not match its extension')
  return { mime, sha256: createHash('sha256').update(data).digest('hex') }
}

/** Parse one file from an already body-limited multipart request without new dependencies. */
export function parseMultipartAttachment(contentType: string, payload: Buffer): { name: string; data: Buffer } {
  const boundaryMatch = /^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))\s*$/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary || boundary.length > 70) throw new AttachmentError('Invalid multipart boundary')
  if (payload.length > MAX_ATTACHMENT_BYTES + 65536) throw new AttachmentError('Attachment exceeds 25 MB', 413)
  const first = Buffer.from(`--${boundary}\r\n`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  if (!payload.subarray(0, first.length).equals(first)) throw new AttachmentError('Invalid multipart body')
  let offset = first.length
  let file: { name: string; data: Buffer } | undefined
  while (offset < payload.length) {
    const headerEnd = payload.indexOf('\r\n\r\n', offset)
    if (headerEnd < offset || headerEnd - offset > 16384) throw new AttachmentError('Invalid multipart headers')
    const headers = payload.subarray(offset, headerEnd).toString('utf8')
    const contentEnd = payload.indexOf(delimiter, headerEnd + 4)
    if (contentEnd < 0) throw new AttachmentError('Incomplete multipart body')
    const disposition = headers.split('\r\n').find(line => /^content-disposition:/i.test(line))
    const filename = disposition && /;\s*filename="([^"\r\n]*)"/i.exec(disposition)
    if (filename) {
      if (file) throw new AttachmentError('Exactly one attachment is required')
      file = { name: filename[1], data: payload.subarray(headerEnd + 4, contentEnd) }
    }
    offset = contentEnd + delimiter.length
    if (payload.subarray(offset, offset + 2).toString() === '--') {
      const tail = payload.subarray(offset + 2).toString()
      if (tail !== '' && tail !== '\r\n') throw new AttachmentError('Invalid multipart ending')
      if (!file) throw new AttachmentError('Attachment is required')
      validateAttachment(file.name, file.data)
      return file
    }
    if (payload.subarray(offset, offset + 2).toString() !== '\r\n') throw new AttachmentError('Invalid multipart delimiter')
    offset += 2
  }
  throw new AttachmentError('Incomplete multipart body')
}
