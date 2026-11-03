import { execSync } from 'child_process';
import path from 'path';
import { config } from 'dotenv';

/** Aplica las migraciones a la BD de test (docker-compose.test.yml). */
export default async function globalSetup(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  config({ path: path.join(root, '.env.test'), override: true, quiet: true });
  execSync('npx prisma migrate deploy', { cwd: root, stdio: 'pipe', env: process.env });
}
