import crypto from 'crypto';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PAYLOAD_VERSION = 'v1';

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeEncryptionKey(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    throw new Error('TOKEN_ENC_KEY no puede estar vacía');
  }

  let key: Buffer;
  if (HEX_KEY_RE.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else if (BASE64_KEY_RE.test(trimmed)) {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    key = Buffer.from(normalized, 'base64');
  } else {
    throw new Error('TOKEN_ENC_KEY debe estar codificada en base64 (32 bytes) o hex (64 caracteres)');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(`TOKEN_ENC_KEY debe decodificar exactamente a ${KEY_BYTES} bytes (recibidos ${key.length})`);
  }
  return key;
}

function buildAad(telegramUserId: string): Buffer {
  return Buffer.from(`tg:${telegramUserId}`, 'utf8');
}

/**
 * Cifrador autenticado AES-256-GCM para los refresh tokens almacenados en bot-db.
 * Ata criptográficamente el secreto al `telegramUserId` mediante AAD para impedir
 * que un registro cifrado pueda reutilizarse bajo otro usuario.
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    this.key = decodeEncryptionKey(rawKey);
  }

  /** Cifra un token en claro y devuelve `v1:<iv>:<tag>:<ciphertext>` en base64url. */
  encrypt(plainToken: string, telegramUserId: string): string {
    if (!plainToken) {
      throw new Error('No se puede cifrar un token vacío');
    }
    if (!telegramUserId) {
      throw new Error('telegramUserId es obligatorio para calcular el AAD');
    }

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(buildAad(telegramUserId));

    const encrypted = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      PAYLOAD_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  /** Verifica la etiqueta de autenticación y descifra el token asociado a `telegramUserId`. */
  decrypt(cipherPayload: string, telegramUserId: string): string {
    if (!telegramUserId) {
      throw new Error('telegramUserId es obligatorio para verificar el AAD');
    }

    const parts = cipherPayload.split(':');
    if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
      throw new Error('Formato de token cifrado no reconocido');
    }

    const [, ivB64, tagB64, encryptedB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const encrypted = Buffer.from(encryptedB64, 'base64url');

    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || encrypted.length === 0) {
      throw new Error('Componentes criptográficos inválidos en el token cifrado');
    }

    const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(buildAad(telegramUserId));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
