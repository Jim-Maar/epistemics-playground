/** Prints the env line for a new app password:  bun run scripts/hash-password.ts <password> */
const password = process.argv[2];
if (!password) throw new Error("Usage: bun run scripts/hash-password.ts <password>");
const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
console.log(`PLAYGROUND_PASSWORD_HASH_B64=${Buffer.from(hash).toString("base64")}`);

export {};
