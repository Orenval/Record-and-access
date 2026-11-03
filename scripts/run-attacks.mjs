import fs from 'fs';
import { execSync } from 'child_process';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;
const LOG_FILE = 'evidence/attack-log.txt';
fs.writeFileSync(LOG_FILE, `=== ACCESS CONTROL ATTACK LOG ===\nDate: ${new Date().toISOString()}\nTarget: http://localhost:3000\nALICE_ID: 4QNxK5vfsj4K\n\n`, 'utf8');

function log(text) {
  process.stdout.write(text);
  fs.appendFileSync(LOG_FILE, text, 'utf8');
}

function runCmd(cmd) {
  log(`$ ${cmd}\n`);
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    log(out + '\n');
    return out;
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    log(out + '\n');
    return out;
  }
}

const BOB_CSRF = '6615fedcbd25162d0464333c81101cbf5bae5651adad90a833d8a28265144dbc';
const ALICE_ID = '4QNxK5vfsj4K';

async function main() {
  log('--- ATTACK 1 ---\n');
  const a1 = runCmd('curl.exe -i http://localhost:3000/api/bookmarks');

  log('--- ATTACK 2 ---\n');
  const a2 = runCmd('curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks');

  log('--- ATTACK 3 ---\n');
  const a3 = runCmd(`curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks/${ALICE_ID}`);

  log('--- ATTACK 4 ---\n');
  const a4 = runCmd('curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks/nonexistent99');

  log('--- ATTACK 5 ---\n');
  const a5 = runCmd(`curl.exe -i http://localhost:3000/api/bookmarks/${ALICE_ID}`);

  log('--- ATTACK 6 ---\n');
  const a6 = runCmd(`curl.exe -i -b evidence/bob-cookies.txt -H "x-csrf-token: ${BOB_CSRF}" -X DELETE http://localhost:3000/api/bookmarks/${ALICE_ID}`);
  log('--- VERIFICATION AFTER ATTACK 6 (Alice check) ---\n');
  const v6 = runCmd(`curl.exe -i -b evidence/alice-cookies.txt http://localhost:3000/api/bookmarks/${ALICE_ID}`);

  log('--- ATTACK 7 ---\n');
  const a7 = runCmd(`curl.exe -i -b evidence/bob-cookies.txt -X DELETE http://localhost:3000/api/bookmarks/${ALICE_ID}`);
  log('--- VERIFICATION AFTER ATTACK 7 (Alice check) ---\n');
  const v7 = runCmd(`curl.exe -i -b evidence/alice-cookies.txt http://localhost:3000/api/bookmarks/${ALICE_ID}`);

  log('--- ATTACK 8 ---\n');
  const a8 = runCmd(`curl.exe -i -X DELETE http://localhost:3000/api/bookmarks/${ALICE_ID}`);
  log('--- VERIFICATION AFTER ATTACK 8 (Alice check) ---\n');
  const v8 = runCmd(`curl.exe -i -b evidence/alice-cookies.txt http://localhost:3000/api/bookmarks/${ALICE_ID}`);

  log('--- ATTACK 9 ---\n');
  const a9 = runCmd('curl.exe -i -H "Content-Type: application/json" -d @evidence/generic-bm.json -X POST http://localhost:3000/api/bookmarks');

  log('--- ATTACK 10 ---\n');
  const a10 = runCmd('curl.exe -i -b evidence/bob-cookies.txt -H "Content-Type: application/json" -d @evidence/bob-bm1.json -X POST http://localhost:3000/api/bookmarks');

  log('--- ATTACK 11 ---\n');
  const a11 = runCmd(`curl.exe -i -b evidence/bob-cookies.txt -H "Content-Type: application/json" -H "x-csrf-token: ${BOB_CSRF}" -d @evidence/attack11-forged.json -X POST http://localhost:3000/api/bookmarks`);

  // Check DB ownership for Attack 11
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const dbRes = await client.query('SELECT b."publicId", b.label, b."userId", u.email FROM "Bookmark" b JOIN "User" u ON b."userId" = u.id WHERE b.label = $1', ['Bob Forged Bookmark']);
  log('\n--- ATTACK 11 DATABASE OWNERSHIP VERIFICATION ---\n' + JSON.stringify(dbRes.rows, null, 2) + '\n\n');
  await client.end();

  log('--- ATTACK 12 ---\n');
  const a12 = runCmd(`curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/bookmarks/${ALICE_ID}`);

  log('--- ATTACK 13 ---\n');
  const a13 = runCmd('curl.exe -i http://localhost:3000/bookmarks');

  log('\n=== ALL ATTACKS EXECUTED ===\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

