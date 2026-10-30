// Reproduction: PluginAuthority.revoke() deletes nothing and reports success.
//
// Run: ORG_AEOR_KIKX_DATABASE_URL=postgres://... node repro-core-revoke.mjs
// Exits 0 when the bug is ABSENT (delete worked), 1 when the bug is PRESENT.
import pg from 'pg';
import { PluginAuthority } from '../../../src/core/plugins/plugin-authority.mjs';

const A = '__core_revoke_repro__';
const URL = process.env.ORG_AEOR_KIKX_DATABASE_URL;
if (!URL) { console.error('ORG_AEOR_KIKX_DATABASE_URL is required'); process.exit(2); }

const pool = new pg.Pool({ connectionString: URL, max: 2 });
const db = {
  async query(sql, params = []) { return await pool.query(sql, params); },
  async one(sql, params = []) { const r = await pool.query(sql, params); return r.rows[0] ?? null; },
  async many(sql, params = []) { const r = await pool.query(sql, params); return r.rows; },
};

await db.query('DELETE FROM miri_capability WHERE actor = $1', [A]);
const auth = new PluginAuthority({ pluginId: 'miri', db, logger: console });

const out = [];
const line = (k, v) => { out.push(`${k.padEnd(46)} ${v}`); };

// Case 1: scoped grant — the realistic transport case ({channel:'probe'}).
await auth.grant({ actor: A, action: 'discord.send', scope: { channel: 'probe' }, grantedBy: 'repro' });
let before = await db.one('SELECT count(*)::int n FROM miri_capability WHERE actor=$1', [A]);
const rev = await auth.revoke({ actor: A, action: 'discord.send', scope: { channel: 'probe' } });
let after = await db.one('SELECT count(*)::int n FROM miri_capability WHERE actor=$1', [A]);
line('scoped: rows before revoke', before.n);
line('scoped: revoke() returned', JSON.stringify(rev));
line('scoped: rows after revoke', after.n);
const scopedBug = after.n !== 0;

// Case 2: unscoped grant — what the predicate does when scope is NULL.
await db.query('DELETE FROM miri_capability WHERE actor=$1', [A]);
await auth.grant({ actor: A, action: 'system.run', scope: null, grantedBy: 'repro' });
const rev2 = await auth.revoke({ actor: A, action: 'system.run', scope: null });
let after2 = await db.one('SELECT count(*)::int n FROM miri_capability WHERE actor=$1', [A]);
line('unscoped: revoke() returned', JSON.stringify(rev2));
line('unscoped: rows after revoke', after2.n);
const unscopedBug = after2.n !== 0;

// Case 3: does revoke tell the caller whether it removed anything?
await db.query('DELETE FROM miri_capability WHERE actor=$1 AND action=$2', [A, 'discord.send']);
const rev3 = await auth.revoke({ actor: A, action: 'no.such.action' });
line('no-op revoke returned', JSON.stringify(rev3));
const reportsNothing = rev3 === true || (rev3 && !('deleted' in rev3));
line('no-op revoke is indistinguishable', reportsNothing);

await db.query('DELETE FROM miri_capability WHERE actor=$1', [A]);
const residue = await db.one('SELECT count(*)::int n FROM miri_capability WHERE actor=$1', [A]);
line('cleanup residue', residue.n);

console.log(out.join('\n'));
const bugPresent = scopedBug || unscopedBug || reportsNothing;
console.log('\nRESULT:', bugPresent ? 'BUG PRESENT' : 'BUG ABSENT');
console.log('  scoped revoke deleted nothing:', scopedBug);
console.log('  unscoped revoke deleted nothing:', unscopedBug);
console.log('  revoke cannot report what it did:', reportsNothing);
await pool.end();
process.exit(bugPresent ? 1 : 0);
