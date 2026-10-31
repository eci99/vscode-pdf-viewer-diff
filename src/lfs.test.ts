import * as assert from 'assert';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { readLfsObject } from './lfs';

test('reads an LFS object from the local store and checks its hash', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const sub = path.join(repo, 'docs');
    fs.mkdirSync(sub);
    const data = Buffer.from('%PDF-1.7 content');
    const oid = crypto.createHash('sha256').update(data).digest('hex');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${data.length}\n`;
    const dir = path.join(repo, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));

    assert.strictEqual(await readLfsObject(sub, pointer), undefined, 'missing object');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, oid), data);
    assert.deepStrictEqual(Buffer.from((await readLfsObject(sub, pointer))!), data);

    fs.writeFileSync(path.join(dir, oid), 'corrupt');
    assert.strictEqual(await readLfsObject(sub, pointer), undefined, 'hash mismatch');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
