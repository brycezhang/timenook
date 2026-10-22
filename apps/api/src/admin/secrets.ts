import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
// OWASP equivalent scrypt profile: 32 MiB, three passes. Limit peak memory
// on the shared ECS; encode parameters so existing hashes remain upgradeable.
const N = 32768,
  r = 8,
  p = 3;
function derive(password: string, salt: string, cost = { N, r, p }) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { ...cost, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt:${N}:${r}:${p}:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [algorithm, n, rValue, pValue, salt, expected] = hash.split(":");
  if (
    algorithm !== "scrypt" ||
    Number(n) !== N ||
    Number(rValue) !== r ||
    Number(pValue) !== p
  )
    return false;
  const key = await derive(password, salt, {
    N: Number(n),
    r: Number(rValue),
    p: Number(pValue),
  });
  return timingSafeEqual(key, Buffer.from(expected, "hex"));
}
export function encryptSecret(secret: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decryptSecret(value: string, key: string) {
  const [iv, tag, data] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
