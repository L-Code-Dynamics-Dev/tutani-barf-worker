/**
 * D1 nad skutečným SQLite (`node:sqlite`) — pro testy, které MUSÍ pustit
 * reálné SQL.
 *
 * PROČ (nález 2026-09-24): `upsertMany` měl natvrdo 18 placeholderů na 21
 * sloupců. Všechny testy jely proti falešnému storu, který SQL nikdy
 * nespustil, takže chyba prošla 228 zelenými testy. Tady se SQL spouští
 * doopravdy, nad schématem ze skutečných migrací.
 *
 * Implementuje jen podmnožinu D1 API, kterou `D1ProductStore` používá:
 * `prepare().bind().all()/first()/run()` a `batch()` jako transakci.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * `node:sqlite` přes `require`: Vite 5 (vitest 2) neumí nové vestavěné
 * moduly, které existují JEN s prefixem `node:` — statický import
 * přepíše na `sqlite` a spadne. Typy zůstávají statické.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: typeof DatabaseSyncType;
};
type DatabaseSync = DatabaseSyncType;

type Bindable = string | number | null;

class Stmt {
    constructor(
        private readonly db: DatabaseSync,
        readonly sql: string,
        private readonly params: Bindable[] = []
    ) {}

    bind(...params: Bindable[]): Stmt {
        return new Stmt(this.db, this.sql, params);
    }

    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
    }

    async first<T = Record<string, unknown>>(): Promise<T | null> {
        return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
    }

    async run(): Promise<{ meta: { changes: number } }> {
        return this.runSync();
    }

    runSync(): { meta: { changes: number } } {
        const r = this.db.prepare(this.sql).run(...this.params);
        return { meta: { changes: Number(r.changes) } };
    }
}

export class SqliteD1 {
    readonly raw: DatabaseSync;

    constructor() {
        this.raw = new DatabaseSync(':memory:');
    }

    /** Aplikuje všechny migrace v pořadí — stejně jako `wrangler d1 migrations apply`. */
    applyMigrations(dir = join(process.cwd(), 'migrations')): this {
        for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
            this.raw.exec(readFileSync(join(dir, f), 'utf8'));
        }
        return this;
    }

    prepare(sql: string): Stmt {
        return new Stmt(this.raw, sql);
    }

    /** D1 `batch` = jedna transakce: buď projde celá, nebo nic. */
    async batch(statements: Stmt[]): Promise<{ meta: { changes: number } }[]> {
        this.raw.exec('BEGIN');
        try {
            const out = statements.map((s) => s.runSync());
            this.raw.exec('COMMIT');
            return out;
        } catch (e) {
            this.raw.exec('ROLLBACK');
            throw e;
        }
    }

    /** Pro testy — přetypování na D1Database, které store očekává. */
    asD1(): D1Database {
        return this as unknown as D1Database;
    }
}
