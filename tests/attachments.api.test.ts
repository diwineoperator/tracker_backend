import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createDepartment, createMember, login, loginAdmin, loginLeader, type TestApp } from './helpers/test-app';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 3)]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Fintech (leader, alice, bob) and Studio (leader, carol); requests are sent to Studio. */
async function setup() {
  const t = buildTestApp();
  const superAuth = await loginAdmin(t);
  const fintech = await createDepartment(t, superAuth, 'Fintech');
  const studio = await createDepartment(t, superAuth, 'Studio');
  const mk = (n: string, departmentId: string) => createMember(t, superAuth, { username: `${n}@example.com`, fullName: n, password: `${n}-pass`, departmentId });
  await mk('alice', fintech.id);
  await mk('bob', fintech.id);
  await mk('carol', studio.id);
  const auth = {
    super: superAuth,
    studioLead: await loginLeader(t, 'Studio'),
    fintechLead: await loginLeader(t, 'Fintech'),
    alice: await login(t, 'alice@example.com', 'alice-pass'),
    bob: await login(t, 'bob@example.com', 'bob-pass'),
    carol: await login(t, 'carol@example.com', 'carol-pass'),
  };
  const sent = await request(t.app).post('/api/requests').set('Authorization', auth.alice).send({ toDepartmentId: studio.id, subject: 'Need a mockup', message: 'See the attached screenshot.' });
  return { t, auth, studio, fintech, requestId: sent.body.data.request.id as string };
}

const upload = (t: TestApp, base: string, auth: string, id: string, file: { name: string; type: string; body: Buffer }) =>
  request(t.app).post(`${base}/${id}/attachments`).set('Authorization', auth).set('Content-Type', file.type).set('X-File-Name', encodeURIComponent(file.name)).send(file.body);
const asMember = (t: TestApp, auth: string, id: string, file: { name: string; type: string; body: Buffer }) => upload(t, '/api/requests', auth, id, file);
const asStaff = (t: TestApp, auth: string, id: string, file: { name: string; type: string; body: Buffer }) => upload(t, '/api/admin/requests', auth, id, file);
const shot = { name: 'screenshot.png', type: 'image/png', body: PNG };

describe('attachments: upload', () => {
  it('a member attaches files to their own request; they show up on it (member and inbox views) without any storage detail', async () => {
    const { t, auth, requestId } = await setup();
    const a = await asMember(t, auth.alice, requestId, shot);
    expect(a.status).toBe(201);
    expect(a.body.data.attachment).toMatchObject({ kind: 'REQUEST', fileName: 'screenshot.png', contentType: 'image/png', sizeBytes: PNG.length, uploadedBy: 'alice@example.com' });
    expect(a.body.data.attachment.storageKey).toBeUndefined();
    await asMember(t, auth.alice, requestId, { name: 'spec.pdf', type: 'application/pdf', body: PDF });

    const mine = (await request(t.app).get('/api/requests').set('Authorization', auth.alice)).body.data.requests[0];
    expect(mine.attachments.map((x: { fileName: string }) => x.fileName)).toEqual(['screenshot.png', 'spec.pdf']);
    const inbox = (await request(t.app).get('/api/admin/requests').set('Authorization', auth.studioLead)).body.data.requests[0];
    expect(inbox.attachments).toHaveLength(2);
    expect(JSON.stringify(inbox)).not.toContain('storageKey');
  });

  it('the receiving leader and the super admin attach files to their reply', async () => {
    const { t, auth, requestId } = await setup();
    const a = await asStaff(t, auth.studioLead, requestId, { name: 'answer.pdf', type: 'application/pdf', body: PDF });
    expect(a.status).toBe(201);
    expect(a.body.data.attachment).toMatchObject({ kind: 'REPLY', uploadedBy: 'studio.leader@example.com' });
    const b = await asStaff(t, auth.super, requestId, { name: 'notes.docx', type: DOCX_TYPE, body: DOCX });
    expect(b.status).toBe(201);
    const mine = (await request(t.app).get('/api/requests').set('Authorization', auth.alice)).body.data.requests[0];
    expect(mine.attachments.map((x: { kind: string }) => x.kind)).toEqual(['REPLY', 'REPLY']);
  });

  it('keeps existing request fields and creation working without any attachment', async () => {
    const { t, auth, requestId } = await setup();
    const mine = (await request(t.app).get('/api/requests').set('Authorization', auth.alice)).body.data.requests[0];
    expect(mine).toMatchObject({ id: requestId, subject: 'Need a mockup', status: 'OPEN', attachments: [] });
  });
});

describe('attachments: validation', () => {
  it('rejects unsupported types (by declared type, by extension, and by content)', async () => {
    const { t, auth, requestId } = await setup();
    const exe = await asMember(t, auth.alice, requestId, { name: 'run.exe', type: 'application/x-msdownload', body: Buffer.from('MZ....') });
    expect(exe.status).toBe(415);
    expect(exe.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect(exe.body.message).toMatch(/Allowed: PNG/);
    expect((await asMember(t, auth.alice, requestId, { name: 'logo.svg', type: 'image/svg+xml', body: Buffer.from('<svg onload="x()"/>') })).status).toBe(415);
    // declared as PNG but named .exe
    expect((await asMember(t, auth.alice, requestId, { name: 'evil.exe', type: 'image/png', body: PNG })).status).toBe(415);
    // named .png, declared PNG, but the bytes are a script
    const fake = await asMember(t, auth.alice, requestId, { name: 'fake.png', type: 'image/png', body: Buffer.from('<script>alert(1)</script>') });
    expect(fake.status).toBe(415);
    expect(fake.body.code).toBe('FILE_CONTENT_MISMATCH');
    expect((await request(t.app).get('/api/requests').set('Authorization', auth.alice)).body.data.requests[0].attachments).toEqual([]);
  });

  it('rejects oversized and empty files with a clear message', async () => {
    const { t, auth, requestId } = await setup();
    const big = await asMember(t, auth.alice, requestId, { name: 'big.pdf', type: 'application/pdf', body: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 1)]) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('FILE_TOO_LARGE');
    expect(big.body.message).toMatch(/5 MB/);
    const empty = await asMember(t, auth.alice, requestId, { name: 'empty.pdf', type: 'application/pdf', body: Buffer.alloc(0) });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('FILE_EMPTY');
  });

  it('a file just under the limit is accepted', async () => {
    const { t, auth, requestId } = await setup();
    const ok = await asMember(t, auth.alice, requestId, { name: 'ok.pdf', type: 'application/pdf', body: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 - PDF.length)]) });
    expect(ok.status).toBe(201);
  });

  it('caps the number of files per side, and a path in the name is stripped', async () => {
    const { t, auth, requestId } = await setup();
    for (let i = 0; i < 5; i++) expect((await asMember(t, auth.alice, requestId, { ...shot, name: `p${i}.png` })).status).toBe(201);
    const sixth = await asMember(t, auth.alice, requestId, { ...shot, name: 'p6.png' });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('TOO_MANY_ATTACHMENTS');
    // the leader's reply side is counted separately
    const named = await asStaff(t, auth.studioLead, requestId, { name: '../../etc/passwd.png', type: 'image/png', body: PNG });
    expect(named.status).toBe(201);
    expect(named.body.data.attachment.fileName).toBe('passwd.png');
  });

  it('rejects a bad request id', async () => {
    const { t, auth } = await setup();
    expect((await asMember(t, auth.alice, 'not-a-uuid', shot)).status).toBe(400);
  });
});

describe('attachments: permissions', () => {
  it("nobody else can add to, read or delete a member's request files: another member, another department's leader", async () => {
    const { t, auth, requestId } = await setup();
    const a = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;

    // another member (same department as the sender) and another department's member: 404, never confirmed to exist
    for (const who of [auth.bob, auth.carol]) {
      expect((await asMember(t, who, requestId, shot)).status).toBe(404);
      expect((await request(t.app).get(`/api/requests/${requestId}/attachments/${a}`).set('Authorization', who)).status).toBe(404);
      expect((await request(t.app).delete(`/api/requests/${requestId}/attachments/${a}`).set('Authorization', who)).status).toBe(404);
    }
    // a leader of a department the request was NOT sent to
    expect((await asStaff(t, auth.fintechLead, requestId, shot)).status).toBe(404);
    expect((await request(t.app).get(`/api/admin/requests/${requestId}/attachments/${a}`).set('Authorization', auth.fintechLead)).status).toBe(404);
    expect((await request(t.app).delete(`/api/admin/requests/${requestId}/attachments/${a}`).set('Authorization', auth.fintechLead)).status).toBe(404);
  });

  it('roles stay apart: members cannot use the admin routes, staff cannot use the member routes, and nothing works signed out', async () => {
    const { t, auth, requestId } = await setup();
    const a = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    expect((await asStaff(t, auth.alice, requestId, shot)).status).toBe(403);
    expect((await request(t.app).get(`/api/admin/requests/${requestId}/attachments/${a}`).set('Authorization', auth.alice)).status).toBe(403);
    expect((await asMember(t, auth.studioLead, requestId, shot)).status).toBe(403);
    expect((await request(t.app).get(`/api/requests/${requestId}/attachments/${a}`)).status).toBe(401);
    expect((await request(t.app).post(`/api/requests/${requestId}/attachments`).set('Content-Type', 'image/png').send(PNG)).status).toBe(401);
  });

  it('a file cannot be reached through a different request id', async () => {
    const { t, auth, studio, requestId } = await setup();
    const a = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    const other = (await request(t.app).post('/api/requests').set('Authorization', auth.alice).send({ toDepartmentId: studio.id, subject: 'Other', message: 'm' })).body.data.request.id as string;
    expect((await request(t.app).get(`/api/requests/${other}/attachments/${a}`).set('Authorization', auth.alice)).status).toBe(404);
  });

  it('the super admin can open any request’s files; the receiving leader can open the sender’s', async () => {
    const { t, auth, requestId } = await setup();
    const a = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    expect((await request(t.app).get(`/api/admin/requests/${requestId}/attachments/${a}`).set('Authorization', auth.super)).status).toBe(200);
    expect((await request(t.app).get(`/api/admin/requests/${requestId}/attachments/${a}`).set('Authorization', auth.studioLead)).status).toBe(200);
  });

  it('a closed request can no longer take or lose the sender’s files, but the leader can still attach a reply', async () => {
    const { t, auth, requestId } = await setup();
    const a = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    await request(t.app).patch(`/api/admin/requests/${requestId}`).set('Authorization', auth.studioLead).send({ status: 'DONE', response: 'Done.' });
    const late = await asMember(t, auth.alice, requestId, shot);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('REQUEST_CLOSED');
    expect((await request(t.app).delete(`/api/requests/${requestId}/attachments/${a}`).set('Authorization', auth.alice)).status).toBe(409);
    expect((await asStaff(t, auth.studioLead, requestId, { name: 'final.pdf', type: 'application/pdf', body: PDF })).status).toBe(201);
  });
});

describe('attachments: retrieval', () => {
  it('serves the exact bytes; images inline, other files as downloads, always locked down', async () => {
    const { t, auth, requestId } = await setup();
    const img = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    const pdf = (await asMember(t, auth.alice, requestId, { name: 'Q3 report (final).pdf', type: 'application/pdf', body: PDF })).body.data.attachment.id as string;

    const i = await request(t.app).get(`/api/requests/${requestId}/attachments/${img}`).set('Authorization', auth.alice).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(i.status).toBe(200);
    expect(i.headers['content-type']).toMatch(/^image\/png/);
    expect(i.headers['content-disposition']).toMatch(/^inline/);
    expect(i.headers['x-content-type-options']).toBe('nosniff');
    expect(i.headers['content-security-policy']).toContain('sandbox');
    expect(i.headers['cache-control']).toContain('no-store');
    expect(Buffer.compare(i.body as Buffer, PNG)).toBe(0);

    const p = await request(t.app).get(`/api/requests/${requestId}/attachments/${pdf}`).set('Authorization', auth.alice);
    expect(p.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''Q3%20report%20%28final%29\.pdf$/);
    // an image can also be forced to download
    const d = await request(t.app).get(`/api/requests/${requestId}/attachments/${img}?download=1`).set('Authorization', auth.alice);
    expect(d.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('404 for an unknown attachment', async () => {
    const { t, auth, requestId } = await setup();
    expect((await request(t.app).get(`/api/requests/${requestId}/attachments/019e0000-0000-7000-8000-000000000000`).set('Authorization', auth.alice)).status).toBe(404);
  });
});

describe('attachments: deletion', () => {
  it('a member removes their own file (row and stored bytes go), but not the leader’s reply file', async () => {
    const { t, auth, requestId } = await setup();
    const mine = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    const reply = (await asStaff(t, auth.studioLead, requestId, { name: 'answer.pdf', type: 'application/pdf', body: PDF })).body.data.attachment.id as string;
    expect(t.files.files.size).toBe(2);

    expect((await request(t.app).delete(`/api/requests/${requestId}/attachments/${reply}`).set('Authorization', auth.alice)).status).toBe(403);
    expect((await request(t.app).delete(`/api/requests/${requestId}/attachments/${mine}`).set('Authorization', auth.alice)).status).toBe(200);
    expect(t.files.files.size).toBe(1);
    expect((await request(t.app).get(`/api/requests/${requestId}/attachments/${mine}`).set('Authorization', auth.alice)).status).toBe(404);
    expect((await request(t.app).delete(`/api/requests/${requestId}/attachments/${mine}`).set('Authorization', auth.alice)).status).toBe(404); // already gone
  });

  it('a leader removes the reply files they attached, but not the member’s', async () => {
    const { t, auth, requestId } = await setup();
    const mine = (await asMember(t, auth.alice, requestId, shot)).body.data.attachment.id as string;
    const reply = (await asStaff(t, auth.studioLead, requestId, { name: 'answer.pdf', type: 'application/pdf', body: PDF })).body.data.attachment.id as string;
    expect((await request(t.app).delete(`/api/admin/requests/${requestId}/attachments/${mine}`).set('Authorization', auth.studioLead)).status).toBe(403);
    expect((await request(t.app).delete(`/api/admin/requests/${requestId}/attachments/${reply}`).set('Authorization', auth.studioLead)).status).toBe(200);
    const list = (await request(t.app).get('/api/requests').set('Authorization', auth.alice)).body.data.requests[0].attachments;
    expect(list.map((x: { id: string }) => x.id)).toEqual([mine]);
  });
});
