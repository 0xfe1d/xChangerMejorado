import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as mfaService from '../services/mfa/mfa.service';
import { setAuthCookies } from './auth.controller';

const codeSchema = z.string().trim().min(6).max(20);
const enrollmentIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** Los secretos y códigos de recuperación nunca se cachean (§7.2.8). */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function enrollmentId(req: Request): string {
  const r = enrollmentIdSchema.safeParse(req.params.enrollmentId);
  if (!r.success) throw new AppError(400, 'Identificador de enrolamiento inválido');
  return r.data;
}

// GET /auth/mfa (EP-C-20)
export async function status(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await mfaService.getStatus(req.user!.sub));
  } catch (err) { next(err); }
}

// POST /auth/mfa/enrollments (EP-C-21)
export async function startEnrollment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await mfaService.startEnrollment(req.user!.sub, { secureTransport: req.secure });
    noStore(res);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

// POST /auth/mfa/enrollments/:enrollmentId/confirm (EP-C-22)
export async function confirmEnrollment(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = z.object({ code: codeSchema }).safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const { recoveryCodes, tokens } = await mfaService.confirmEnrollment(req.user!.sub, enrollmentId(req), parsed.data.code);
    setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);
    noStore(res);
    res.json({ enabled: true, recoveryCodes });
  } catch (err) { next(err); }
}

// DELETE /auth/mfa/enrollments/:enrollmentId (EP-C-23)
export async function cancelEnrollment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await mfaService.cancelEnrollment(req.user!.sub, enrollmentId(req));
    res.status(204).send();
  } catch (err) { next(err); }
}

// POST /auth/mfa/disable (EP-C-25)
const disableSchema = z.object({
  password: z.string().min(1).optional(),
  code: codeSchema.optional(),
  recoveryCode: z.string().trim().max(20).optional(),
});

export async function disable(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = disableSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await mfaService.disable(req.user!.sub, parsed.data);
    res.status(204).send();
  } catch (err) { next(err); }
}

// POST /auth/mfa/recovery-codes (EP-C-26)
export async function regenerateRecoveryCodes(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = z.object({ code: codeSchema }).safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const result = await mfaService.regenerateRecoveryCodes(req.user!.sub, parsed.data.code);
    noStore(res);
    res.json(result);
  } catch (err) { next(err); }
}

// POST /admin/users/:id/mfa/reset (EP-C-28)
export async function adminReset(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = z.object({ reason: z.string().trim().min(10).max(500) }).safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, 'El motivo debe tener entre 10 y 500 caracteres'));
  if (!z.string().cuid().safeParse(req.params.id).success) return next(new AppError(400, 'Identificador inválido'));
  try {
    await mfaService.adminReset(req.params.id, parsed.data.reason, req.user!.sub, req.user!.role);
    res.status(204).send();
  } catch (err) { next(err); }
}
