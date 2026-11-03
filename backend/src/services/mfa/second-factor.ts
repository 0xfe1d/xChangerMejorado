import { AppError } from '../../middleware/errorHandler';
import { logAction } from '../log.service';
import { createNotification } from '../notification.service';
import { getMfaGateway } from './mfa.http-client';
import { MfaPurpose } from './mfa.gateway';

export const XOTP_CODE_RE = /^\d{6}$|^\d{8}$/;
export const RECOVERY_CODE_RE = /^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$/;

export interface SecondFactorInput {
  userId: string;
  code?: string;
  recoveryCode?: string;
  purpose: MfaPurpose;
  correlationId: string;
  clientIp?: string;
  /** Intentos que quedan en el reto del core, para devolver el mínimo de ambos límites. */
  challengeRemaining?: number;
}

export interface SecondFactorResult {
  method: 'xotp' | 'recovery_code';
  driftWarning: boolean;
  recoveryCodesRemaining?: number;
}

/** Normaliza el código: se toleran espacios intermedios (§7.2.5, regla 1). */
export function normalizeXotp(code: string): string {
  return code.replace(/\s+/g, '');
}

/** Exactamente uno de code / recoveryCode, con formato válido. */
export function assertOneFactor(code?: string, recoveryCode?: string): void {
  if ((code ? 1 : 0) + (recoveryCode ? 1 : 0) !== 1) {
    throw new AppError(400, 'Indica un código de la app o un código de recuperación (solo uno)', 'VALIDATION_ERROR');
  }
  if (code && !XOTP_CODE_RE.test(normalizeXotp(code))) throw new AppError(400, 'El código debe tener 6 dígitos', 'VALIDATION_ERROR');
  if (recoveryCode && !RECOVERY_CODE_RE.test(recoveryCode.trim())) {
    throw new AppError(400, 'El código de recuperación tiene el formato XXXXX-XXXXX', 'VALIDATION_ERROR');
  }
}

/**
 * Verifica el segundo factor contra el mfa-service. Lanza 401 MFA_INVALID_CODE
 * (con remainingAttempts y, si aplica, reason=REPLAYED), 423 MFA_LOCKED o
 * 503 MFA_SERVICE_UNAVAILABLE. Nunca degrada a "aceptar sin factor".
 */
export async function verifySecondFactor(input: SecondFactorInput): Promise<SecondFactorResult> {
  assertOneFactor(input.code, input.recoveryCode);
  const gw = getMfaGateway();

  if (input.code) {
    const r = await gw.verify({
      subjectId: input.userId,
      code: normalizeXotp(input.code),
      purpose: input.purpose,
      correlationId: input.correlationId,
      clientIp: input.clientIp,
    });
    if (!r.valid) throw invalidCode(r.reason, r.remainingAttempts, input.challengeRemaining);
    return { method: 'xotp', driftWarning: r.driftWarning };
  }

  const r = await gw.verifyRecovery({
    subjectId: input.userId,
    recoveryCode: input.recoveryCode!.trim().toUpperCase(),
    purpose: input.purpose,
    correlationId: input.correlationId,
  });
  if (!r.valid) throw invalidCode(r.reason ?? 'INVALID_CODE', r.remainingAttempts, input.challengeRemaining);

  // RF-MFA-10 y §7.2.6: usar un código de recuperación se registra y se notifica
  logAction({ userId: input.userId, action: 'MFA_RECOVERY_USED', payload: { purpose: input.purpose, remaining: r.remaining } }).catch(console.error);
  await createNotification({
    userId: input.userId,
    asunto: 'Se ha usado un código de recuperación',
    contenido:
      `Se ha usado uno de tus códigos de recuperación de la verificación en dos pasos. Te quedan ${r.remaining}.` +
      (r.remaining <= 2 ? '\nTe recomendamos regenerarlos desde Ajustes.' : '') +
      '\nSi no has sido tú, cambia tu contraseña y contacta con tu embajador.',
    kind: 'SECURITY',
  });
  return { method: 'recovery_code', driftWarning: false, recoveryCodesRemaining: r.remaining };
}

function invalidCode(reason: string, mfaRemaining?: number, challengeRemaining?: number): AppError {
  const candidates = [mfaRemaining, challengeRemaining].filter((n): n is number => typeof n === 'number');
  const remainingAttempts = candidates.length ? Math.max(0, Math.min(...candidates)) : undefined;
  return new AppError(401, 'Código incorrecto', 'MFA_INVALID_CODE', {
    reason,
    ...(remainingAttempts !== undefined ? { remainingAttempts } : {}),
  });
}
