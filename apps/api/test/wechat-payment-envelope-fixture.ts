import { createCipheriv, randomUUID, sign, type KeyObject } from "node:crypto";

export function signedPaymentHeaders(
  body: string,
  platformKeyId: string,
  platformPrivateKey: KeyObject,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  return {
    "Wechatpay-Timestamp": timestamp,
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": platformKeyId,
    "Wechatpay-Signature": sign(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
      platformPrivateKey,
    ).toString("base64"),
  };
}

export function encryptedPaymentNotification(
  value: Record<string, unknown>,
  apiV3Key: string,
  id: string,
  originalType: string,
  eventType: string,
) {
  const nonce = "abcdefghijkl";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), nonce);
  cipher.setAAD(Buffer.from(originalType));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  return JSON.stringify({
    id,
    event_type: eventType,
    resource_type: "encrypt-resource",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      original_type: originalType,
      nonce,
      associated_data: originalType,
      ciphertext,
    },
  });
}
