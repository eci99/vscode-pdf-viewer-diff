import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The content of an LFS file is usually in the local LFS store of the repository already,
// e.g. because the file is checked out. Reading it from there does not need Git LFS, which
// may be missing, e.g. in WSL when the repository was cloned with Git for Windows.
export async function readLfsObject(cwd: string, pointer: string): Promise<Uint8Array | undefined> {
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(pointer)?.[1];
  if (!oid) {
    return undefined;
  }
  try {
    const gitDir = await new Promise<string>((resolve, reject) =>
      execFile('git', ['rev-parse', '--git-common-dir'], { cwd }, (err, stdout) =>
        err ? reject(err) : resolve(path.resolve(cwd, stdout.trim())),
      ),
    );
    const data = await fs.promises.readFile(
      path.join(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid),
    );
    return crypto.createHash('sha256').update(data).digest('hex') === oid ? data : undefined;
  } catch {
    return undefined;
  }
}
