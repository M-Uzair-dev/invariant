import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { AddressInfo, createServer } from 'node:net';
import path from 'node:path';
import { Client } from 'pg';

const ROOT = path.resolve(__dirname, '../..');
const DATABASE_URL = process.env.DATABASE_URL!;

export async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  everyMs = 100,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
}

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as AddressInfo;
  srv.close();
  await once(srv, 'close');
  return port;
}

// The real app (dist/main.js) in its own process, so it can be SIGKILLed:
// no shutdown hooks, no finally blocks, open transactions just vanish.
export class AppProcess {
  static logs: string[] = [];
  private proc!: ChildProcess;
  private exited!: Promise<unknown>;
  url!: string;

  static async start(env: Record<string, string> = {}): Promise<AppProcess> {
    if (!DATABASE_URL.includes('invariant_test')) {
      throw new Error('Refusing to crash-test anything but the test database');
    }
    const app = new AppProcess();
    const port = await freePort();
    app.url = `http://127.0.0.1:${port}`;
    app.proc = spawn(
      process.execPath,
      ['-r', path.join(__dirname, 'fast-timers.cjs'), 'dist/src/main.js'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          WEBHOOK_WORKER_INTERVAL_MS: '200',
          WEBHOOK_ALERT_INTERVAL_MS: '0',
          RATE_LIMIT_GLOBAL_MAX: '1000000',
          RATE_LIMIT_AUTH_MAX: '1000000',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    app.exited = once(app.proc, 'exit');
    const collect = (b: Buffer) => AppProcess.logs.push(b.toString());
    app.proc.stdout!.on('data', collect);
    app.proc.stderr!.on('data', collect);

    await waitFor('the app to answer', async () => {
      if (app.proc.exitCode !== null) {
        throw new Error(`app exited early:\n${AppProcess.logs.join('')}`);
      }
      try {
        return (await fetch(`${app.url}/`)).ok;
      } catch {
        return false;
      }
    });
    return app;
  }

  async kill() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.kill('SIGKILL');
    await this.exited;
  }
}

// One Postgres connection holding a row lock, to freeze an app transaction at
// the statement that needs that row.
export async function holdRowLock(table: string, id: string) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
  const pid = (
    await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  ).rows[0].pid;
  return {
    pid,
    release: async () => {
      await client.query('ROLLBACK');
      await client.end();
    },
  };
}

async function dbQuery<T>(sql: string): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

export function waitForBlockedOnLock() {
  return waitFor('an app transaction to block on the row lock', async () => {
    const rows = await dbQuery(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows.length > 0;
  });
}

// After a kill, Postgres only notices the dead client when it next reads from
// the socket. Wait until no transaction from the dead process is left open.
export function waitForNoOpenTransactions() {
  return waitFor('open transactions to be rolled back', async () => {
    const rows = await dbQuery(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND (state LIKE 'idle in transaction%' OR wait_event_type = 'Lock')`,
    );
    return rows.length === 0;
  });
}

// A store's webhook endpoint that records every event id it receives.
export class Receiver {
  received: string[] = [];
  handler: (eventId: string) => Promise<number> | number = () => 200;
  url!: string;
  private server!: http.Server;

  static async start(): Promise<Receiver> {
    const r = new Receiver();
    r.server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const id = String(req.headers['invariant-event-id']);
        r.received.push(id);
        void Promise.resolve(r.handler(id)).then(
          (status) => res.writeHead(status).end(),
          () => res.writeHead(500).end(),
        );
      });
    });
    r.server.listen(0, '127.0.0.1');
    await once(r.server, 'listening');
    r.url = `http://127.0.0.1:${(r.server.address() as AddressInfo).port}/hooks`;
    return r;
  }

  reset() {
    this.received = [];
    this.handler = () => 200;
  }

  close() {
    this.server.closeAllConnections();
    this.server.close();
  }
}
