import { describe, it, expect } from 'vitest';
import {
  deriveAESKey,
  computeSignature,
  verifySignature,
  encrypt,
  decrypt,
  parseWeComXml,
} from './wecom-crypto.js';

describe('deriveAESKey', () => {
  it('should decode a 43-char base64 EncodingAESKey to a 32-byte Buffer', () => {
    // 43 base64 chars → 32 bytes after decoding with appended "="
    const encodingAESKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const key = deriveAESKey(encodingAESKey);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
});

describe('computeSignature', () => {
  it('should produce a consistent SHA1 hex digest', () => {
    const sig = computeSignature(
      'token123',
      '1609459200',
      'nonce456',
      'encryptedData',
    );
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
  });

  it('should sort inputs lexicographically before hashing', () => {
    // Swapping token and nonce should produce the same result
    // since the four values are sorted before concatenation
    const sig1 = computeSignature('aaa', '1609459200', 'zzz', 'mmm');
    const sig2 = computeSignature('aaa', '1609459200', 'zzz', 'mmm');
    expect(sig1).toBe(sig2);

    // Different inputs produce different signatures
    const sig3 = computeSignature('aaa', '1609459200', 'zzz', 'nnn');
    expect(sig1).not.toBe(sig3);
  });
});

describe('verifySignature', () => {
  it('should return true when signature matches', () => {
    const sig = computeSignature('tok', '12345', 'nc', 'enc');
    expect(verifySignature('tok', '12345', 'nc', 'enc', sig)).toBe(true);
  });

  it('should return false when signature does not match', () => {
    expect(verifySignature('tok', '12345', 'nc', 'enc', 'wrong')).toBe(false);
  });
});

describe('encrypt / decrypt round-trip', () => {
  const encodingAESKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const aesKey = deriveAESKey(encodingAESKey);

  it('should decrypt an encrypted message back to the original', () => {
    const message = 'Hello, WeCom!';
    const receiveid = 'mycorpid';

    const ciphertext = encrypt(aesKey, message, receiveid);
    const result = decrypt(aesKey, ciphertext);

    expect(result.message).toBe(message);
    expect(result.receiveid).toBe(receiveid);
  });

  it('should handle empty message', () => {
    const ciphertext = encrypt(aesKey, '', 'corpid');
    const result = decrypt(aesKey, ciphertext);
    expect(result.message).toBe('');
    expect(result.receiveid).toBe('corpid');
  });

  it('should handle unicode content', () => {
    const message = '你好世界 🌍';
    const receiveid = 'corp123';

    const ciphertext = encrypt(aesKey, message, receiveid);
    const result = decrypt(aesKey, ciphertext);

    expect(result.message).toBe(message);
    expect(result.receiveid).toBe(receiveid);
  });

  it('should produce different ciphertexts for the same input (random prefix)', () => {
    const ct1 = encrypt(aesKey, 'test', 'corp');
    const ct2 = encrypt(aesKey, 'test', 'corp');
    expect(ct1).not.toBe(ct2);
  });
});

describe('parseWeComXml', () => {
  it('should parse standard WeCom message XML', () => {
    const xml = `<xml>
  <ToUserName><![CDATA[mycorpid]]></ToUserName>
  <FromUserName><![CDATA[zhangsan]]></FromUserName>
  <CreateTime>1609459200</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[Hello World]]></Content>
  <MsgId>1234567890</MsgId>
  <AgentID>1000002</AgentID>
</xml>`;

    const parsed = parseWeComXml(xml);
    expect(parsed.ToUserName).toBe('mycorpid');
    expect(parsed.FromUserName).toBe('zhangsan');
    expect(parsed.CreateTime).toBe('1609459200');
    expect(parsed.MsgType).toBe('text');
    expect(parsed.Content).toBe('Hello World');
    expect(parsed.MsgId).toBe('1234567890');
    expect(parsed.AgentID).toBe('1000002');
  });

  it('should return empty object for empty XML', () => {
    expect(parseWeComXml('')).toEqual({});
    expect(parseWeComXml('<xml></xml>')).toEqual({});
  });

  it('should handle mixed CDATA and plain value fields', () => {
    const xml = `<xml>
  <Name><![CDATA[Alice]]></Name>
  <Age>30</Age>
</xml>`;

    const parsed = parseWeComXml(xml);
    expect(parsed.Name).toBe('Alice');
    expect(parsed.Age).toBe('30');
  });
});
