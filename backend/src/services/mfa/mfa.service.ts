import crypto from 'crypto';
import { Role } from '@prisma/client';

import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { AppError } from '../../middleware/errorHandler';
import { maskEmail } from '../../utils/mask';
import { verifyPassword } from '../../utils/password';
import { logAction } from '../log.service';
import { createNotification } from '../notification.service';
import { publish } from '../../events/event-publisher';
import { issueWebSession } from '../auth.service';
import { assertUserInScope } from '../admin.service';
import { revokeAllChannelSessionsForUser } from '../channel-session.service';
import { getMfaGateway } from './mfa.http-client';
import { verifySecondFactor, assertOneFactor } from './second-factor';

async function loadUser(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw new AppError(404, 'Usuario no encontrado');
  return user;
}

// ── EP-C-20: estado ───────────────────────────────────────────

export async function getStatus(userId: string) {
  const user = await loadUser(userId);
  try {
    const s = await getMfaGateway().getFactors(userId);
    const active = s.factors.find((f) => f.status === 'ACTIVE');
    return {
      enabled: user.mfaEnabled,
      method: user.mfaEnabled ? ('xotp' as const) : null,
      enabledAt: user.mfaEnabledAt,
      recoveryCodesRemaining: user.mfaEnabled ? s.recoveryCodesRemaining : 0,
      pendingEnrollment: s.pendingEnrollment,
      ...(active?.lastUsedAt ? { lastUsedAt: active.lastUsedAt } : {}),
    };
  } catch (err) {
    // Sin MFA no hay nada que ocultar: se responde con el estado del core (ADR-28)
    if (!user.mfaEnabled && err instanceof AppError && err.code === 'MFA_SERVICE_UNAVAILABLE') {
      return { enabled: false, method: null, enabledAt: null, recoveryCodesRemaining: 0, pendingEnrollment: null, degraded: true };
    }
    throw err;
  }
}

// ── EP-C-21: iniciar enrolamiento ─────────────────────────────

export async function startEnrollment(userId: string, opts: { secureTransport: boolean }) {
  // AR-01: el QR contiene el secreto; nunca se emite por HTTP en producción
  if (env.NODE_ENV === 'production' && env.MFA_REQUIRE_HTTPS && !opts.secureTransport) {
    throw new AppError(403, 'La activación de MFA requiere una conexión segura (HTTPS)', 'HTTPS_REQUIRED');
  }
  const user = await loadUser(userId);
  if (user.mfaEnabled) throw new AppError(409, 'La verificación en dos pasos ya está activada', 'MFA_ALREADY_ENABLED');

  const e = await getMfaGateway().createEnrollment({
    subjectId: userId,
    accountLabel: maskEmail(user.email),
    confirmUrl: `${env.FRONTEND_URL.replace(/\/$/, '')}/ajustes/mfa`,
  });
  // Agrupación en bloques de 4 para la introducción manual
  const groupedSecret = e.manualEntry.secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
  return {
    enrollmentId: e.enrollmentId,
    provisioningUri: e.provisioningUri,
    manualEntry: { ...e.manualEntry, secret: groupedSecret },
    expiresAt: e.expiresAt,
  };
}

// ── EP-C-22: confirmar ────────────────────────────────────────

export async function confirmEnrollment(userId: string, enrollmentId: string, code: string, remember = false) {
  const user = await loadUser(userId);
  if (user.mfaEnabled) throw new AppError(409, 'La verificación en dos pasos ya está activada', 'MFA_ALREADY_ENABLED');

  const r = await getMfaGateway().confirmEnrollment(enrollmentId, { subjectId: userId, code: code.replace(/\s+/g, '') });
  if (!r.valid) {
    throw new AppError(401, 'Código incorrecto', 'MFA_INVALID_CODE', {
      reason: r.reason,
      ...(r.remainingAttempts !== undefined ? { remainingAttempts: r.remainingAttempts } : {}),
    });
  }

  // Solo tras la confirmación el core marca el MFA como activo (ADR-28)
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: userId }, data: { mfaEnabled: true, mfaEnabledAt: new Date(r.activatedAt ?? Date.now()) } });
    await publish('mfa.enabled', { userId, actorId: userId }, { audience: [userId], tx });
    return u;
  });
  logAction({ userId, action: 'MFA_ENABLED', payload: { factorId: r.factorId } }).catch(console.error);
  await createNotification({
    userId,
    asunto: 'Verificación en dos pasos activada',
    contenido: 'Has activado la verificación en dos pasos. Guarda tus códigos de recuperación en un lugar seguro.',
    kind: 'SECURITY',
  });

  // §7.2.4: se rota la sesión actual
  const tokens = await issueWebSession(updated, undefined, remember);
  return { recoveryCodes: r.recoveryCodes, tokens };
}

// ── EP-C-23: cancelar enrolamiento ────────────────────────────

export async function cancelEnrollment(userId: string, enrollmentId: string) {
  await getMfaGateway().deleteEnrollment(enrollmentId, userId);
}

// ── EP-C-25: desactivar ───────────────────────────────────────

export async function disable(userId: string, input: { password?: string; code?: string; recoveryCode?: string }) {
  const user = await loadUser(userId);
  if (!user.mfaEnabled) throw new AppError(409, 'La verificación en dos pasos no está activada', 'MFA_NOT_ENABLED');
  assertOneFactor(input.code, input.recoveryCode);

  // RF-MFA-07: contraseña (si la cuenta la tiene) y un código válido
  if (user.passwordHash) {
    if (!input.password || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError(401, 'Credenciales incorrectas', 'INVALID_CREDENTIALS');
    }
  }
  await verifySecondFactor({ userId, code: input.code, recoveryCode: input.recoveryCode, purpose: 'disable', correlationId: crypto.randomUUID() });

  await getMfaGateway().deleteFactors(userId, { reason: 'USER_DISABLED', actorId: userId });
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaEnabledAt: null } });
    await publish('mfa.disabled', { userId, actorId: userId }, { audience: [userId], tx });
  });
  logAction({ userId, action: 'MFA_DISABLED', payload: {} }).catch(console.error);
  await createNotification({
    userId,
    asunto: 'Verificación en dos pasos desactivada',
    contenido: 'Se ha desactivado la verificación en dos pasos de tu cuenta. Si no has sido tú, cambia tu contraseña y contacta con tu embajador.',
    kind: 'SECURITY',
  });
}

// ── EP-C-26: regenerar códigos de recuperación ────────────────

export async function regenerateRecoveryCodes(userId: string, code: string) {
  const user = await loadUser(userId);
  if (!user.mfaEnabled) throw new AppError(409, 'La verificación en dos pasos no está activada', 'MFA_NOT_ENABLED');
  await verifySecondFactor({ userId, code, purpose: 'regenerate_recovery', correlationId: crypto.randomUUID() });
  const r = await getMfaGateway().regenerateRecoveryCodes(userId);
  logAction({ userId, action: 'MFA_RECOVERY_REGENERATED', payload: { generatedAt: r.generatedAt } }).catch(console.error);
  return { recoveryCodes: r.recoveryCodes };
}

// ── EP-C-28: restablecimiento por administrador ───────────────

export async function adminReset(targetId: string, reason: string, requesterId: string, requesterRole: Role) {
  if (targetId === requesterId) throw new AppError(403, 'No puedes restablecer tu propio segundo factor', 'FORBIDDEN');
  const target = await loadUser(targetId);
  if (target.role === Role.PROPIETARIO) throw new AppError(403, 'No se puede restablecer el MFA de un Propietario', 'FORBIDDEN');
  if (requesterRole === Role.EMBAJADOR && target.role !== Role.ESTUDIANTE) {
    throw new AppError(403, 'Un embajador solo puede actuar sobre estudiantes', 'FORBIDDEN');
  }
  await assertUserInScope(targetId, requesterId, requesterRole);
  if (!target.mfaEnabled) throw new AppError(409, 'El usuario no tiene la verificación en dos pasos activada', 'MFA_NOT_ENABLED');

  await getMfaGateway().deleteFactors(targetId, { reason: 'ADMIN_RESET', actorId: requesterId });
  await prisma.$transaction(async (tx) => {
    // Revoca también la sesión web (refresh) del usuario
    await tx.user.update({ where: { id: targetId }, data: { mfaEnabled: false, mfaEnabledAt: null, refreshTokenHash: null } });
    await publish('mfa.disabled', { userId: targetId, actorId: requesterId }, { audience: [targetId], tx });
  });
  await revokeAllChannelSessionsForUser(targetId, 'MFA_RESET');

  logAction({ userId: requesterId, action: 'MFA_RESET', payload: { targetId, reason } }).catch(console.error);
  await createNotification({
    userId: targetId,
    asunto: 'Tu verificación en dos pasos ha sido restablecida',
    contenido: 'Un administrador ha restablecido la verificación en dos pasos de tu cuenta y se han cerrado tus sesiones. Puedes volver a activarla desde Ajustes.',
    kind: 'SECURITY',
  });
}
