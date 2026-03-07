import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

/**
 * Derive a 32-byte AES key from WeCom's EncodingAESKey.
 * EncodingAESKey is 43 chars of base64; append "=" and decode.
 */
export function deriveAESKey(encodingAESKey: string): Buffer {
  return Buffer.from(encodingAESKey + '=', 'base64');
}

/**
 * Compute WeCom callback signature.
 * Sort [token, timestamp, nonce, encrypt] lexicographically,
 * concatenate, and SHA1 hash to hex.
 */
export function computeSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): string {
  const parts = [token, timestamp, nonce, encrypt].sort();
  return createHash('sha1').update(parts.join('')).digest('hex');
}

/**
 * Verify that a WeCom callback signature matches the expected value.
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  expected: string,
): boolean {
  return computeSignature(token, timestamp, nonce, encrypt) === expected;
}

/**
 * Decrypt a WeCom encrypted message.
 *
 * Layout after AES-256-CBC decryption and PKCS7 unpadding:
 *   [16 random bytes][4-byte BE msg length][message bytes][receiveid bytes]
 */
export function decrypt(
  aesKey: Buffer,
  ciphertext: string,
): { message: string; receiveid: string } {
  const iv = aesKey.subarray(0, 16);
  const encrypted = Buffer.from(ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  // Remove PKCS7 padding
  const padLen = decrypted[decrypted.length - 1];
  const unpadded = decrypted.subarray(0, decrypted.length - padLen);

  // Parse: skip 16 random bytes, read 4-byte BE uint32 message length
  const msgLen = unpadded.readUInt32BE(16);
  const message = unpadded.subarray(20, 20 + msgLen).toString('utf-8');
  const receiveid = unpadded.subarray(20 + msgLen).toString('utf-8');

  return { message, receiveid };
}

/**
 * Encrypt a message for WeCom.
 *
 * Plaintext layout:
 *   [16 random bytes][4-byte BE msg byte length][msg bytes][receiveid bytes]
 * Then PKCS7-pad to 16-byte blocks and AES-256-CBC encrypt.
 */
export function encrypt(
  aesKey: Buffer,
  message: string,
  receiveid: string,
): string {
  const iv = aesKey.subarray(0, 16);
  const msgBuf = Buffer.from(message, 'utf-8');
  const ridBuf = Buffer.from(receiveid, 'utf-8');

  // Build plaintext
  const random = randomBytes(16);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const plaintext = Buffer.concat([random, lenBuf, msgBuf, ridBuf]);

  // PKCS7 pad to 16-byte boundary
  const blockSize = 16;
  const padLen = blockSize - (plaintext.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  const padded = Buffer.concat([plaintext, padding]);

  const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  return encrypted.toString('base64');
}

/**
 * Parse flat WeCom XML into a key-value record.
 * Handles both CDATA-wrapped and plain-text values.
 */
export function parseWeComXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Match CDATA fields: <Tag><![CDATA[value]]></Tag>
  const cdataRe = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = cdataRe.exec(xml)) !== null) {
    result[m[1]] = m[2];
  }

  // Match plain value fields: <Tag>value</Tag>
  const plainRe = /<(\w+)>([^<]+)<\/\1>/g;
  while ((m = plainRe.exec(xml)) !== null) {
    if (!(m[1] in result)) {
      result[m[1]] = m[2];
    }
  }

  return result;
}
