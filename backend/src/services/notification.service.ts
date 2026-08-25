import { prisma } from '../config/prisma';
import { sendNotificationEmail } from './email.service';

export interface CreateNotificationInput {
  userId: string;
  asunto: string;
  contenido: string;
  /** Email del destinatario para el envío paralelo por correo */
  email: string;
}

/**
 * Persiste la notificación en BD y envía el email de forma no bloqueante.
 * Si el envío de email falla, se registra el error pero no se lanza excepción
 * (la notificación en sistema ya quedó guardada).
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      asunto: input.asunto,
      contenido: input.contenido,
    },
  });

  sendNotificationEmail(input.email, input.asunto, buildEmailHtml(input.asunto, input.contenido))
    .catch((err) => console.error('[notification] error enviando email:', err));
}

/** Envía la misma notificación a múltiples usuarios en paralelo */
export async function notifyMany(
  recipients: Array<{ userId: string; email: string }>,
  asunto: string,
  contenido: string,
): Promise<void> {
  await Promise.all(
    recipients.map((r) =>
      createNotification({ userId: r.userId, email: r.email, asunto, contenido }),
    ),
  );
}

function buildEmailHtml(subject: string, body: string): string {
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:auto">
      <h2>${subject}</h2>
      <p>${body}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0"/>
      <p style="color:#9ca3af;font-size:0.75rem;text-align:center">
        xChanger — Universidad de Cantabria · No es un sistema oficial.
      </p>
    </div>
  `;
}
