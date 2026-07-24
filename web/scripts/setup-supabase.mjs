import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const bucket = process.env.SUPABASE_STORAGE_BUCKET || "notebook-uploads";
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const secretKey = process.env.SUPABASE_SECRET_KEY;
const databaseUrl = process.env.DATABASE_URL;

function fail(message) {
  console.error(`Supabase setup failed: ${message}`);
  process.exitCode = 1;
}

if (!supabaseUrl || !secretKey) {
  fail("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
} else {
  const headers = {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
  };

  async function ensureBucket() {
    const list = await fetch(`${supabaseUrl}/storage/v1/bucket`, { headers });
    if (!list.ok) throw new Error(`Storage API returned ${list.status}`);
    const buckets = await list.json();
    if (buckets.some((item) => item.id === bucket || item.name === bucket)) {
      console.log(`Storage bucket ready: ${bucket}`);
      return;
    }

    const created = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    if (!created.ok && created.status !== 409) {
      throw new Error(`Could not create bucket (${created.status})`);
    }
    console.log(`Storage bucket ready: ${bucket}`);
  }

  async function ensureMigration() {
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required to apply migrations. Use the Supabase PostgreSQL connection string, not the local 127.0.0.1 URL.",
      );
    }
    const db = new URL(databaseUrl);
    if (["localhost", "127.0.0.1", "::1"].includes(db.hostname)) {
      throw new Error(
        `DATABASE_URL points to ${db.hostname}; replace it with the Supabase PostgreSQL connection string.`,
      );
    }

    const sql = postgres(databaseUrl, {
      ssl: process.env.DB_SSL === "disable" ? undefined : "require",
      max: 1,
      connect_timeout: 15,
    });
    try {
      for (const name of [
        "0006_notebook_uploads.sql",
        "0007_source_char_count.sql",
        "0008_chunk_search_vector.sql",
      ]) {
        const migration = await fs.readFile(
          path.resolve(process.cwd(), "drizzle", name),
          "utf8",
        );
        await sql.unsafe(migration);
        console.log(`Migration ready: ${name}`);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async function verifyTable() {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/notebook_uploads?select=id&limit=1`,
      { headers: { ...headers, Accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`notebook_uploads is not exposed/available (${response.status})`);
    }
    console.log("Verification passed: notebook_uploads is reachable");
  }

  try {
    await ensureBucket();
    await ensureMigration();
    await verifyTable();
    console.log("Supabase upload setup complete.");
  } catch (error) {
    fail(error instanceof Error ? error.message : "Unknown setup error");
  }
}
