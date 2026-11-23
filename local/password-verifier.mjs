import { scrypt } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function checkPassword(password, minimumLength = 1) {
  if (typeof password !== "string" || password.length < minimumLength
    || Buffer.byteLength(password, "utf8") > 1024) {
    throw new TypeError("Invalid password");
  }
}

export async function passwordHash(password, salt) {
  return derive(password, salt, 32, SCRYPT_OPTIONS);
}
