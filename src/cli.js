// Usage: npm run create-user -- email "Name" password [admin|operator]
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { hashPassword } from './crypto.js';
import { validateEmail, validateName, validatePassword } from './validate.js';

const [cmd, emailArg, nameArg, passArg, roleArg] = process.argv.slice(2);
if (cmd !== 'create-user') {
  console.error('Usage: node src/cli.js create-user <email> <name> <password> [admin|operator]');
  process.exit(1);
}
const cfg = loadConfig();
const store = openDb(cfg.dataDir);
const email = validateEmail(emailArg);
const name = validateName(nameArg);
const pw = validatePassword(passArg);
for (const v of [email, name, pw]) {
  if (!v.ok) { console.error(v.error); process.exit(1); }
}
if (store.getUserByEmail(email.value)) { console.error('Email already exists'); process.exit(1); }
store.createUser({
  email: email.value, name: name.value, passwordHash: hashPassword(pw.value),
  role: roleArg === 'admin' ? 'admin' : 'operator',
});
console.log(`Created ${roleArg === 'admin' ? 'admin' : 'operator'} ${email.value}`);
store.close();
