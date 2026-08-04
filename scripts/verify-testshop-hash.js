// Verify the Test Shop password hash used in migration-combined.sql
const b = require("bcryptjs");

const hash = "$2a$12$fZkKrivuI3ER/ZcAc77uX.Jo85x0ajOCZt9Xb60NMjgWqOM0tmb22";
const ok = b.compareSync("TestShop2024!", hash);

console.log("hash:", hash);
console.log("matches 'TestShop2024!':", ok);

if (!ok) {
  // Generate a fresh correct hash so it can be pasted into the migration
  const fresh = b.hashSync("TestShop2024!", 12);
  console.log("fresh hash (use this):", fresh);
  console.log("fresh verifies:", b.compareSync("TestShop2024!", fresh));
}
process.exit(ok ? 0 : 1);
