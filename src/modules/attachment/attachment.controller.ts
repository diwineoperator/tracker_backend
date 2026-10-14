import express, { type Request, type RequestHandler, type Response } from 'express';
import { currentMemberId, staffScope } from '../../middleware/auth.middleware';
import { ok } from '../../utils/api-response';
import { AppError } from '../../utils/errors';
import type { AuthClaims } from '../auth/token.service';
import type { AttachmentService, OpenedFile } from './attachment.service';
import { MAX_ATTACHMENT_BYTES } from './attachment.types';
import { z } from 'zod';

const params = z.object({ id: z.uuid('Invalid request id.'), attachmentId: z.uuid('Invalid attachment id.').optional() });
const parse = (req: Request) => params.parse(req.params);

const rawBody = express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES });

/**
 * The file arrives as the raw request body — one file per request, its name in `X-File-Name` (URL-encoded) and its
 * type in `Content-Type` — so each file can report its own upload progress and fail on its own. Oversized bodies
 * are refused before they are read into memory.
 */
export const readFileBody: RequestHandler = (req, res, next) => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    return next(new AppError(413, 'FILE_TOO_LARGE', `That file is too large. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per file.`));
  }
  rawBody(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === 'entity.too.large') return next(new AppError(413, 'FILE_TOO_LARGE', `That file is too large. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per file.`));
    next(err);
  });
};

const uploadInput = (req: Request) => ({ fileName: req.header('x-file-name'), contentType: req.header('content-type'), body: req.body as unknown });

function send(res: Response, file: OpenedFile) {
  const encoded = encodeURIComponent(file.fileName).replace(/['()]/g, escape);
  res
    .status(200)
    .type(file.contentType)
    .set({
      'Content-Length': String(file.data.length),
      'Content-Disposition': `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
      // A stored file is never a page: no script, no framing, no sniffing, no caching of someone's attachment.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
    .end(file.data);
}

export class AttachmentController {
  constructor(private readonly service: AttachmentService) {}

  // ── member ──
  memberUpload = async (req: Request, res: Response) => {
    const auth = res.locals['auth'] as AuthClaims;
    res.status(201).json(ok({ attachment: await this.service.uploadForMember(currentMemberId(res), auth.username, parse(req).id, uploadInput(req)) }));
  };
  memberRemove = async (req: Request, res: Response) => {
    const p = parse(req);
    await this.service.removeForMember(currentMemberId(res), p.id, p.attachmentId ?? '');
    res.json(ok({ deleted: true }));
  };
  memberOpen = async (req: Request, res: Response) => {
    const p = parse(req);
    send(res, await this.service.openForMember(currentMemberId(res), p.id, p.attachmentId ?? '', req.query['download'] === '1'));
  };

  // ── staff ──
  staffUpload = async (req: Request, res: Response) => {
    const auth = res.locals['auth'] as AuthClaims;
    const role = auth.role === 'super_admin' ? 'super_admin' : 'admin';
    res.status(201).json(ok({ attachment: await this.service.uploadForStaff(staffScope(res), role, auth.username, parse(req).id, uploadInput(req)) }));
  };
  staffRemove = async (req: Request, res: Response) => {
    const p = parse(req);
    await this.service.removeForStaff(staffScope(res), p.id, p.attachmentId ?? '');
    res.json(ok({ deleted: true }));
  };
  staffOpen = async (req: Request, res: Response) => {
    const p = parse(req);
    send(res, await this.service.openForStaff(staffScope(res), p.id, p.attachmentId ?? '', req.query['download'] === '1'));
  };
}

