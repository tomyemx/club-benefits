import { connect, migrate, reset } from '../db/client.js';

const url = process.env.DATABASE_URL ?? 'postgres://clubs:clubs@localhost:5432/clubs';
const cmd = process.argv[2];
const sql = connect(url);
try {
  if (cmd === 'migrate') {
    const applied = await migrate(sql);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  } else if (cmd === 'reset') {
    await reset(sql, url);
    console.log('database reset and migrated');
  } else {
    console.error('usage: db.ts migrate|reset');
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
