import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { checkUpload, sanitizeFileName } from '../src/modules/attachment/attachment.rules';
import { LocalFileStorage } from '../src/modules/attachment/file-storage';

describe('LocalFileStorage', () => {
  const dirs: string[] = [];
  const fresh = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tt-files-'));
    dirs.push(dir);
    return { dir, storage: new LocalFileStorage(dir) };
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const key = () => `${randomUUID()}/${randomUUID()}`;

  it('stores, reads back and deletes a file; deleting or reading a missing one is fine', async () => {
    const { storage } = await fresh();
    const k = key();
    await storage.put(k, Buffer.from('hello'));
    expect((await storage.get(k))?.toString()).toBe('hello');
    await storage.remove(k);
    expect(await storage.get(k)).toBeNull();
    await expect(storage.remove(k)).resolves.toBeUndefined();
  });

  it('never writes outside its folder: only server-generated keys are accepted', async () => {
    const { dir, storage } = await fresh();
    for (const bad of ['../evil', '../../etc/passwd', '/etc/passwd', 'a/b', `${randomUUID()}/../../x`, '']) {
      await expect(storage.put(bad, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
      await expect(storage.get(bad)).rejects.toThrow('Invalid storage key');
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not overwrite an existing file', async () => {
    const { storage } = await fresh();
    const k = key();
    await storage.put(k, Buffer.from('one'));
    await expect(storage.put(k, Buffer.from('two'))).rejects.toThrow();
    expect((await storage.get(k))?.toString()).toBe('one');
  });
});

describe('upload rules', () => {
  it('sanitises names: no path, no control characters, no leading dots, bounded length', () => {
    expect(sanitizeFileName('..\\..\\win\\evil.png')).toBe('evil.png');
    expect(sanitizeFileName('a/b/c.pdf')).toBe('c.pdf');
    expect(sanitizeFileName('.hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFileName('we\u0000ird\u001f.txt')).toBe('weird.txt');
    expect(sanitizeFileName('%E2%9C%93%20done.pdf')).toBe('✓ done.pdf');
    const long = sanitizeFileName(`${'x'.repeat(400)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('accepts a matching text/csv and refuses one with binary content', () => {
    expect(checkUpload({ fileName: 'data.csv', contentType: 'text/csv; charset=utf-8', body: Buffer.from('a,b\n1,2\n') }).contentType).toBe('text/csv');
    expect(() => checkUpload({ fileName: 'data.csv', contentType: 'text/csv', body: Buffer.from([0x61, 0x00, 0x62]) })).toThrow(/valid CSV/);
  });
});
