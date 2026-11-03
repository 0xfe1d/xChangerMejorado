import { AppError } from '../middleware/errorHandler';
import * as repo from '../repositories/expediente.repository';

export const list = (userId: string) => repo.listForUser(userId);

/** RF-PER-03: hace falta al menos una asignatura para operar con ofertas. */
export async function assertHasExpediente(userId: string): Promise<void> {
  if ((await repo.countForUser(userId)) === 0) {
    throw new AppError(409, 'Selecciona al menos una asignatura en tu expediente antes de operar con ofertas', 'EXPEDIENTE_REQUIRED');
  }
}

export async function hasExpediente(userId: string): Promise<boolean> {
  return (await repo.countForUser(userId)) > 0;
}

/** Devuelve created=false si ya estaba (EP-R-06: 201 al añadir, 200 sin cambios). */
export async function add(userId: string, asignaturaId: string): Promise<{ created: boolean; asignaturaId: string }> {
  const asignatura = await repo.findActiveAsignatura(asignaturaId);
  if (!asignatura) throw new AppError(404, 'Asignatura no encontrada', 'NOT_FOUND');
  if (await repo.findEntry(userId, asignaturaId)) return { created: false, asignaturaId };
  await repo.addEntry(userId, asignaturaId);
  return { created: true, asignaturaId };
}

export async function remove(userId: string, asignaturaId: string): Promise<void> {
  await repo.removeEntry(userId, asignaturaId);
}
