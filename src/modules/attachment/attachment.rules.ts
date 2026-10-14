import { AppError } from '../../utils/errors';
import { MAX_ATTACHMENT_BYTES } from './attachment.types';

/**
 * What may be attached. Deliberately a short allow-list: images (no SVG — it can carry script), PDF, plain
 * text / CSV and Office documents. The extension, the declared type AND the file's first bytes must all agree.
 */
export const ALLOWED_FILE_TYPES = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
} as const satisfies Record<string, readonly string[]>;

export type AllowedContentType = keyof typeof ALLOWED_FILE_TYPES;

/** Types a browser may render inline (everything else is always a download). */
export const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const isAllowed = (type: string): type is AllowedContentType => Object.prototype.hasOwnProperty.call(ALLOWED_FILE_TYPES, type);

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/** Does the content really look like what it claims to be? (Text formats: no NUL bytes.) */
function matchesSignature(type: AllowedContentType, buf: Buffer): boolean {
  switch (type) {
    case 'image/png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(buf, [0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8);
    case 'application/pdf':
      return startsWith(buf, [0x25, 0x50, 0x44, 0x46]);
    case 'text/plain':
    case 'text/csv':
      return !buf.subarray(0, 8192).includes(0);
    default: // the three Office formats are ZIP containers
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
  }
}

const fail = (status: number, code: string, message: string) => new AppError(status, code, message);
const allowedList = 'PNG, JPG, WEBP, GIF, PDF, TXT, CSV, DOCX, XLSX, PPTX';

/** A file name safe to store and to put in a header: no path, no control characters, bounded. */
export function sanitizeFileName(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* keep it as sent */
  }
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001F\u007F]/g, '').split(/[\\/]/).pop()!.replace(/^\.+/, '').trim();
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

export interface CheckedUpload {
  fileName: string;
  contentType: AllowedContentType;
  sizeBytes: number;
}

/** Throws a clear, user-facing error for anything that must not be stored. */
export function checkUpload(input: { fileName: string | undefined; contentType: string | undefined; body: unknown }): CheckedUpload {
  const { body } = input;
  if (!Buffer.isBuffer(body) || body.length === 0) throw fail(400, 'FILE_EMPTY', 'The file is empty.');
  if (body.length > MAX_ATTACHMENT_BYTES) throw fail(413, 'FILE_TOO_LARGE', `That file is too large. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per file.`);

  const fileName = sanitizeFileName(input.fileName ?? '');
  if (!fileName) throw fail(400, 'FILE_NAME_REQUIRED', 'The file needs a name.');

  const contentType = (input.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!isAllowed(contentType)) throw fail(415, 'FILE_TYPE_NOT_ALLOWED', `That file type isn't supported. Allowed: ${allowedList}.`);
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  if (!(ALLOWED_FILE_TYPES[contentType] as readonly string[]).includes(ext)) {
    throw fail(415, 'FILE_TYPE_NOT_ALLOWED', `“${fileName}” doesn't match its file type. Allowed: ${allowedList}.`);
  }
  if (!matchesSignature(contentType, body)) throw fail(415, 'FILE_CONTENT_MISMATCH', `“${fileName}” isn't a valid ${ext.toUpperCase()} file.`);
  return { fileName, contentType, sizeBytes: body.length };
}
