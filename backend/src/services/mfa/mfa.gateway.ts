// Contrato del mfa-service tal como lo consume el core (EP-M-01..10).
// El core depende de esta interfaz, no del transporte: en tests se sustituye.

export type MfaPurpose = 'login' | 'channel_login' | 'reauth' | 'disable' | 'regenerate_recovery' | 'step_up';

export interface ManualEntry {
  issuer: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
}

export interface EnrollmentCreated {
  enrollmentId: string;
  factorId: string;
  provisioningUri: string;
  manualEntry: ManualEntry;
  expiresAt: string;
}

export type CodeCheck<T> = ({ valid: true } & T) | { valid: false; reason: string; remainingAttempts?: number };

export type ConfirmResult = CodeCheck<{ factorId: string; activatedAt: string; recoveryCodes: string[] }>;
export type VerifyResult = CodeCheck<{ factorId: string; matchedStep: number; driftSteps: number; driftWarning: boolean }>;
export type RecoveryResult = CodeCheck<{ remaining: number }>;

export interface FactorsStatus {
  enabled: boolean;
  factors: Array<{ factorId: string; type: 'XOTP'; status: string; activatedAt: string | null; lastUsedAt: string | null }>;
  recoveryCodesRemaining: number;
  pendingEnrollment: { enrollmentId: string; expiresAt: string } | null;
}

export interface MfaGateway {
  createEnrollment(input: { subjectId: string; accountLabel: string; confirmUrl?: string; digits?: 6 | 8 }): Promise<EnrollmentCreated>;
  confirmEnrollment(enrollmentId: string, input: { subjectId: string; code: string }): Promise<ConfirmResult>;
  deleteEnrollment(enrollmentId: string, subjectId: string): Promise<void>;
  verify(input: { subjectId: string; code: string; purpose: MfaPurpose; correlationId: string; clientIp?: string }): Promise<VerifyResult>;
  verifyRecovery(input: { subjectId: string; recoveryCode: string; purpose: MfaPurpose; correlationId: string }): Promise<RecoveryResult>;
  regenerateRecoveryCodes(subjectId: string): Promise<{ recoveryCodes: string[]; generatedAt: string }>;
  getFactors(subjectId: string): Promise<FactorsStatus>;
  deleteFactors(subjectId: string, input: { reason: 'USER_DISABLED' | 'ADMIN_RESET' | 'ACCOUNT_DELETED'; actorId: string }): Promise<void>;
  health(): Promise<'up' | 'down' | 'degraded'>;
}
