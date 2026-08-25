import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

// Singleton del transporter; se crea una sola vez al arrancar
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
}

async function sendMail(options: SendMailOptions): Promise<void> {
  await getTransporter().sendMail({
    from: `"xChanger" <${env.SMTP_FROM}>`,
    ...options,
  });
}

export async function sendOtpEmail(to: string, otpCode: string): Promise<void> {
  await sendMail({
    to,
    subject: 'Tu código de verificación — xChanger',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Verifica tu cuenta en xChanger</h2>
        <p>Usa el siguiente código para completar tu registro. Caduca en <strong>30 minutos</strong>.</p>
        <div style="font-size:2.5rem;font-weight:bold;letter-spacing:0.3em;text-align:center;
                    padding:1rem;background:#f4f4f5;border-radius:8px;margin:1.5rem 0">
          ${otpCode}
        </div>
        <p style="color:#6b7280;font-size:0.875rem">
          Si no has solicitado este código, ignora este correo.<br/>
          Este mensaje ha sido generado automáticamente; no respondas a él.
        </p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0"/>
        <p style="color:#9ca3af;font-size:0.75rem;text-align:center">
          xChanger — Universidad de Cantabria · No es un sistema oficial.
        </p>
      </div>
    `,
  });
}

export async function sendNotificationEmail(
  to: string,
  subject: string,
  htmlContent: string,
): Promise<void> {
  await sendMail({ to, subject, html: htmlContent });
}
