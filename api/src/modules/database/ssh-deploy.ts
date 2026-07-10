import { Client } from 'ssh2';

/**
 * Deploy-grade SSH helpers (separate from agent.service's 20s sshExec). These power the HA-cluster
 * auto-deploy: a full app-stack clone takes several minutes to build, so the exec timeout is
 * configurable, and we add SFTP write/put for transferring the .env and the DB snapshot.
 */

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

function withConn<T>(
  host: string,
  port: number,
  username: string,
  password: string,
  fn: (conn: Client) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => {
        fn(conn).then(
          (v) => { conn.end(); resolve(v); },
          (e) => { conn.end(); reject(e); },
        );
      })
      .on('error', (e) => reject(e))
      .connect({ host, port: port || 22, username, password, readyTimeout: 20_000, keepaliveInterval: 15_000 });
  });
}

/** Run a command; resolves with exit code + captured stdout/stderr. `timeoutMs` guards the whole exec. */
export function sshRun(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  timeoutMs = 60_000,
): Promise<SshResult> {
  return withConn(host, port, username, password, (conn) =>
    new Promise<SshResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ssh command timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err); }
        let stdout = '';
        let stderr = '';
        stream
          .on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000); })
          .on('close', (code: number) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
      });
    }),
  );
}

/** Write string content to a remote file via SFTP (creates/overwrites). */
export function sshWriteFile(
  host: string,
  port: number,
  username: string,
  password: string,
  remotePath: string,
  content: string,
): Promise<void> {
  return withConn(host, port, username, password, (conn) =>
    new Promise<void>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const ws = sftp.createWriteStream(remotePath);
        ws.on('close', () => resolve());
        ws.on('error', reject);
        ws.end(Buffer.from(content, 'utf8'));
      });
    }),
  );
}

/** Upload a local file to a remote path via SFTP (used for the DB snapshot). */
export function sshPutFile(
  host: string,
  port: number,
  username: string,
  password: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return withConn(host, port, username, password, (conn) =>
    new Promise<void>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
      });
    }),
  );
}

/** Shell-single-quote a value safely for embedding in a remote `sh -c '...'`. */
export function shq(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}
