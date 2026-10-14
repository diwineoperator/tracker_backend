import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, createMember, login, loginAdmin, setupAlice, TEST_ADMIN } from './helpers/test-app';

describe('POST /api/auth/login — admin', () => {
  it('returns a JWT for the configured admin', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/login').send(TEST_ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ role: 'super_admin', username: TEST_ADMIN.username, departmentIds: [] });
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts the admin username case-insensitively', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username.toUpperCase(), password: TEST_ADMIN.password });
    expect(res.status).toBe(200);
  });

  it.each([
    ['wrong password', { username: TEST_ADMIN.username, password: 'nope' }],
    ['unknown username', { username: 'someone-else', password: TEST_ADMIN.password }],
  ])('rejects %s with the same generic error', async (_label, body) => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/login').send(body);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password.',
    });
  });

  it('validates the body', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/login').send({ username: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/login — member', () => {
  it('returns a JWT with the member role and their display name', async () => {
    const t = buildTestApp();
    await setupAlice(t);

    const res = await request(t.app).post('/api/auth/login').send({ username: 'ALICE@EXAMPLE.COM', password: 'alice-pass' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual({ role: 'member', username: 'alice@example.com', fullName: 'Alice A', departmentIds: [expect.any(String)] });
  });

  it('never stores a plaintext password: the stored value is a bcrypt hash', async () => {
    const t = buildTestApp();
    await setupAlice(t);
    const stored = t.repos.members.rows[0]!.passwordHash;
    expect(stored).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(stored).not.toContain('alice-pass');
  });

  it('rejects a wrong password / unknown member with the same generic error', async () => {
    const t = buildTestApp();
    await setupAlice(t);
    for (const body of [
      { username: 'alice@example.com', password: 'wrong' },
      { username: 'nobody', password: 'alice-pass' },
    ]) {
      const res = await request(t.app).post('/api/auth/login').send(body);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('a disabled member cannot log in (revealed only with the correct password)', async () => {
    const t = buildTestApp();
    const { adminAuth, alice } = await setupAlice(t);
    await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ isActive: false });

    const right = await request(t.app).post('/api/auth/login').send({ username: 'alice@example.com', password: 'alice-pass' });
    expect(right.status).toBe(403);
    expect(right.body.code).toBe('ACCOUNT_DISABLED');

    const wrong = await request(t.app).post('/api/auth/login').send({ username: 'alice@example.com', password: 'wrong' });
    expect(wrong.status).toBe(401); // does not confirm the account exists
  });

  it('disabling a member cuts off their EXISTING token immediately', async () => {
    const t = buildTestApp();
    const { adminAuth, alice, aliceAuth } = await setupAlice(t);
    expect((await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth)).status).toBe(200);

    await request(t.app).patch(`/api/members/${alice.id}`).set('Authorization', adminAuth).send({ isActive: false });

    const res = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('route protection & role separation', () => {
  it('rejects protected routes without a token', async () => {
    const { app } = buildTestApp();
    for (const path of ['/api/time-tracker/today', '/api/members']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    }
  });

  it('rejects a tampered token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/time-tracker/today').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('exposes only login — there is no registration endpoint', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/register').send(TEST_ADMIN);
    expect(res.status).toBe(404);
  });

  it('a MEMBER token is forbidden on every admin API', async () => {
    const t = buildTestApp();
    const { alice, aliceAuth } = await setupAlice(t);
    const calls = [
      request(t.app).get('/api/members'),
      request(t.app).post('/api/members').send({ username: 'mallory@example.com', fullName: 'M', password: 'secret123' }),
      request(t.app).patch(`/api/members/${alice.id}`).send({ fullName: 'Hacked' }),
    ];
    for (const call of calls) {
      const res = await call.set('Authorization', aliceAuth);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    // …and nothing was changed by those attempts.
    expect(t.repos.members.rows.filter((m) => m.role === 'MEMBER')).toHaveLength(1); // no Mallory
    expect(t.repos.members.rows.find((m) => m.username === 'alice@example.com')!.fullName).toBe('Alice A');
  });

  it('the ADMIN token is forbidden on member APIs (admin has no time ledger of their own)', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const res = await request(t.app).get('/api/time-tracker/today').set('Authorization', adminAuth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');

    const create = await request(t.app).post('/api/time-tracker').set('Authorization', adminAuth).send({ category: 'WORK', durationMinutes: 10 });
    expect(create.status).toBe(403);
  });

  it('a token for a deleted/unknown member is rejected', async () => {
    const t = buildTestApp();
    const { aliceAuth } = await setupAlice(t);
    t.repos.members.rows.length = 0; // account vanished
    const res = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(res.status).toBe(401);
  });

  it('two members never see each other\'s ledger', async () => {
    const t = buildTestApp();
    const adminAuth = await loginAdmin(t);
    const bob = await createMember(t, adminAuth, { username: 'bob@example.com', password: 'bob-pass' });
    const bobAuth = await login(t, 'bob@example.com', 'bob-pass');
    await request(t.app).post('/api/time-tracker').set('Authorization', bobAuth).send({ category: 'WORK', durationMinutes: 10 });

    const bobToday = await request(t.app).get('/api/time-tracker/today').set('Authorization', bobAuth);
    expect(bobToday.body.data.entries.length).toBeGreaterThan(0); // his TRACKER row, plus its GAP/BASE row if the window left one

    const { aliceAuth } = await setupAlice(t);
    const aliceToday = await request(t.app).get('/api/time-tracker/today').set('Authorization', aliceAuth);
    expect(aliceToday.body.data.entries).toHaveLength(0);
  });
});
