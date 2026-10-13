import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI es obligatorio");
const dbName = process.env.MONGODB_DB || "medio_under";
const dataDir = process.env.DATA_DIR || "./data";
const readJson = async (name, fallback) => { try { return JSON.parse(await readFile(`${dataDir}/${name}`, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const content = await readJson("content.json", { contents: [] });
  const press = await readJson("press.json", { events: [], contacts: [], accreditations: [], coverages: [], mediaKit: {} });
  const collections = { contents: content.contents || [], press_events: press.events || [], press_contacts: press.contacts || [], press_accreditations: press.accreditations || [], press_coverages: press.coverages || [] };
  for (const [name, documents] of Object.entries(collections)) {
    if (!documents.length) continue;
    await db.collection(name).bulkWrite(documents.map((document) => ({ updateOne: { filter: { _id: document.id }, update: { $setOnInsert: { _id: document.id, ...document } }, upsert: true } })));
    console.log(`${name}: ${documents.length} documentos procesados`);
  }
  if (press.mediaKit && Object.keys(press.mediaKit).length) await db.collection("press_settings").updateOne({ _id: "mediaKit" }, { $set: { ...press.mediaKit } }, { upsert: true });
} finally { await client.close(); }
