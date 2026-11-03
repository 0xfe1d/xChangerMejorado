// Buzón en memoria que sustituye al envío SMTP en los tests de integración.
export interface SentMail {
  to: string;
  subject: string;
  otp?: string;
  html?: string;
}

export const mailbox: SentMail[] = [];

export function lastOtpFor(email: string): string {
  const m = [...mailbox].reverse().find((x) => x.to === email.toLowerCase() && x.otp);
  if (!m?.otp) throw new Error(`No hay OTP enviado a ${email}`);
  return m.otp;
}
