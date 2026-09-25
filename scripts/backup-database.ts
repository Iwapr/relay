import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || !isAbsolute(source) || !isAbsolute(destination) || source === destination)
  throw new Error('Usage: backup-database.ts /absolute/source.sqlite /absolute/new-backup.sqlite');
try {
  await lstat(destination);
  throw new Error('Backup destination already exists; choose a new path.');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
process.umask(0o077);
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  await chmod(destination, 0o600);
  console.log('Consistent SQLite backup completed. Store it privately with the original service owner.');
} finally {
  db.close();
}
