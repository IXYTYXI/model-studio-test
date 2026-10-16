import {randomBytes} from 'node:crypto';
import {link, lstat, open, unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createInterface, emitKeypressEvents} from 'node:readline';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, '.env');

function askUsername() {
  const terminal = createInterface({input: process.stdin, output: process.stdout});
  return new Promise((resolve, reject) => {
    let answered = false;
    terminal.once('close', () => { if (!answered) reject(new Error('Setup cancelled.')); });
    terminal.question('Administrator username [admin]: ', answer => {
      answered = true;
      terminal.close();
      resolve(answer.trim().toLowerCase() || 'admin');
    });
  });
}

function askPassword(label) {
  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;
    const previousRaw = input.isRaw;
    const cleanup = () => {
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.setRawMode(previousRaw);
      input.pause();
      process.stdout.write('\n');
    };
    const onEnd = () => { cleanup(); reject(new Error('Setup cancelled.')); };
    const onKey = (characters, key = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return onEnd();
      if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); return; }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl || key.meta || !characters || /[\u0000-\u001f\u007f]/u.test(characters)) return;
      if (value.length + characters.length <= 4096) value += characters;
    };
    process.stdout.write(label);
    input.setRawMode(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.resume();
  });
}

async function createEnv(contents) {
  const temporary = join(root, `.env.${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A hard link publishes the completed file atomically and never replaces .env.
    await link(temporary, destination);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  process.umask(0o077);
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 to run setup.');
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run setup in an interactive terminal; passwords are never accepted through command arguments or echoed.');
  }
  try {
    await lstat(destination);
    throw new Error('.env already exists. Setup will not overwrite it or rotate your master key.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const username = await askUsername();
  if (!/^[a-z0-9][a-z0-9_.@-]{1,63}$/.test(username)) {
    throw new Error('Username must be 2–64 characters: letters, numbers, underscores, periods, @ or hyphens; start with a letter or number.');
  }
  emitKeypressEvents(process.stdin);
  const password = await askPassword('Administrator password (14–128 characters; hidden): ');
  if (password.length < 14 || password.length > 128) throw new Error('Password must be 14–128 characters.');
  if (password.includes("'") || /[\r\n\u0000]/u.test(password)) {
    throw new Error('For portable .env storage, setup passwords cannot contain a single quote or line break. Other symbols, including $, are supported.');
  }
  const confirmation = await askPassword('Repeat password (hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match. No configuration was written.');
  const contents = [
    '# Generated locally by npm run setup. Keep private and out of source control.',
    '# Remove BOOTSTRAP_PASSWORD after your first successful login; preserve MASTER_KEY.',
    `MASTER_KEY=${randomBytes(32).toString('hex')}`,
    `BOOTSTRAP_USERNAME=${username}`,
    `BOOTSTRAP_PASSWORD='${password}'`,
    'PUBLIC_ORIGIN=http://localhost:8080',
    'DATA_DIR=./data',
    'HOST=127.0.0.1',
    'PORT=8080',
    'DEFAULT_DAILY_LIMIT=50',
    'GLOBAL_DAILY_LIMIT=500',
    'ALLOW_CUSTOM_API_HOSTS=true',
    'ALLOWED_API_HOSTS=',
    ''
  ].join('\n');
  await createEnv(contents);
  process.stdout.write('Created .env with permissions 0600. No secrets were printed.\nStart locally with npm start, then open http://localhost:8080.\nAfter the first successful login, remove BOOTSTRAP_PASSWORD from .env and restart. Keep MASTER_KEY and back it up securely with your database.\n');
}

main().catch(error => {
  process.stderr.write(`Setup failed: ${error.code === 'EEXIST' ? '.env already exists; no existing file was overwritten.' : error.message}\n`);
  process.exitCode = 1;
});
