import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";

const scrypt = promisify(scryptCallback);
const [id, rolesCsv, email = "", active = "true", permissionsCsv = ""] = process.argv.slice(2);
const roles = [...new Set((rolesCsv ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
const permissions = [...new Set(permissionsCsv.split(",").map((value) => value.trim()).filter(Boolean))];
const password = process.env.USER_PASSWORD;
const uri = process.env.MONGODB_URI;
if (
  !uri ||
  !id ||
  !rolesCsv ||
  !password ||
  password.length < 12 ||
  roles.some((value) => !["admin", "editor", "press", "directory", "community", "auditor", "social"].includes(value)) ||
  permissions.some((value) => !["instagram:read", "instagram:metrics", "instagram:publish"].includes(value))
) {
  console.error(
    "Uso: MONGODB_URI=... USER_PASSWORD='...' node scripts/upsert-user.mjs <id> <roles-csv> [email] [true|false] [permissions-csv]",
  );
  process.exit(1);
}
const salt = randomBytes(16).toString("base64url");
const derived = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 + 2 * 1024 * 1024 });
const passwordHash = `scrypt$16384$8$1$${salt}$${Buffer.from(derived).toString("base64url")}`;
const client = new MongoClient(uri);
try {
  await client.connect();
  const collection = client.db(process.env.MONGODB_DB ?? "medio_under").collection("users");
  await collection.updateOne(
    { _id: id },
    {
      $set: {
        roles,
        permissions,
        ...(email ? { email: email.toLowerCase() } : {}),
        username: id.toLowerCase(),
        passwordHash,
        active: active !== "false",
        updatedAt: new Date().toISOString(),
      },
      $setOnInsert: { createdAt: new Date().toISOString() },
    },
    { upsert: true },
  );
  console.log(JSON.stringify({ id, roles, permissions, email: email || null, active: active !== "false" }));
} finally {
  await client.close();
}
