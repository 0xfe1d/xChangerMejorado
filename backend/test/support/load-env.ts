// Carga .env.test antes de importar cualquier módulo del core (config/env valida al importar).
import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(__dirname, '../../.env.test'), override: true, quiet: true });
