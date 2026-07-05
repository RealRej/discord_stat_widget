// Encrypts/decrypts sensitive strings (Discord bot tokens) before they touch
// the database, using AES-256-GCM with a server-only secret (MASTER_KEY).
// Even if the database were ever leaked, the tokens inside it would be
// useless without this key, which lives only in Render's environment vars.

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

// For local runs with no .env file at all, generate a throwaway key for this
// process only, so the app doesn't hard-fail on first launch. Once you
// deploy for real, set MASTER_KEY in the environment — without it, every
// restart forgets any previously saved Discord tokens.
let devKeyWarned = false;
function getKey() {
  let raw = process.env.MASTER_KEY;
  if (!raw || raw.length < 32) {
    if (!devKeyWarned) {
      process.env.MASTER_KEY = crypto.randomBytes(32).toString("hex");
      console.log("[crypto] No MASTER_KEY set — generated a temporary one for this run only.");
      console.log("[crypto] Saved Discord tokens will need to be re-entered after a restart unless you set MASTER_KEY yourself (see .env.example).");
      devKeyWarned = true;
    }
    raw = process.env.MASTER_KEY;
  }
  // Accepts either a 64-char hex string or any long passphrase; either way,
  // we hash it down to a proper 32-byte key.
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together as one base64 blob for simplicity.
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(blob) {
  if (!blob) return null;
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
