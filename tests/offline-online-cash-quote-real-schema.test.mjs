import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";

const enabled = process.env.OFFLINE_TEST_REAL_SCHEMA === "1";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program}: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

test("online cash quote and close use the production business and UUID order schemas",
  { skip: !enabled, timeout: 120000 }, async () => {
    const schema = read("../supabase-schema.sql");
    const table = name => {
      const match = schema.match(new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`));
      assert.ok(match, `Missing production table ${name}`);
      return match[0];
    };
    const container = command("docker", ["run", "-d", "--rm", "--pull", "never", "--network", "none",
      "-e", "POSTGRES_PASSWORD=isolated-test-only", "postgres:16-alpine"]);
    try {
      let ready = false;
      for (let i = 0; i < 30; i++) {
        const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
        if (probe.error) throw probe.error;
        if (probe.status === 0) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.ok(ready, "Isolated PostgreSQL did not become ready");
      const setup = `
        create role anon;
        create role authenticated;
        create role service_role;
        create schema auth;
        create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
      `;
      const sql = [setup, table("business_data"), table("online_orders"),
        read("../local/experimental-sync.sql"), read("../local/experimental-presence.sql"),
        read("../local/experimental-payment-events.sql"), read("../local/experimental-online-cash-quote.sql"),
        read("../local/experimental-cash-adjustments.sql"), read("../local/experimental-online-cash-close.sql"),
        read("./offline-online-cash-quote-db.test.sql"), read("./offline-online-cash-close-db.test.sql")].join("\n");
      command("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
        "-U", "postgres"], { input: sql });
      assert.equal(command("docker", ["exec", "-i", container, "psql", "-X", "-qAt",
        "-v", "ON_ERROR_STOP=1", "-U", "postgres"],
      { input: "select pg_typeof(id) from public.online_orders limit 1;" }), "uuid");
      const readJson = query => JSON.parse(command("docker", ["exec", "-i", container, "psql", "-X", "-qAt",
        "-v", "ON_ERROR_STOP=1", "-U", "postgres"], { input: query }));
      const id = "44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const quote = readJson(`select result from public.experimental_online_cash_quotes where operation_id = '${id}'`);
      const close = readJson(`select result from public.experimental_online_cash_closes where operation_id = '${id}'`);
      const store = new OfflineStore(":memory:");
      try {
        store.initialize("store", quote.snapshot, 0);
        store.prepareOnlineCashClose("store", id, { sessionId: "cash", counted: 100, notes: "Conferido" }, 0);
        store.markOnlineCashCloseDispatched("store", id);
        assert.deepEqual(store.completeOnlineCashClose("store", id, close), close);
        assert.equal(store.read("store").remoteRevision, 1);
        assert.equal(store.pendingOnlineCashClose("store"), null);
      } finally {
        store.close();
      }
      command(process.execPath, ["--test", "tests\\offline-online-cash-quote-concurrency.test.mjs",
        "tests\\offline-online-cash-close-concurrency.test.mjs"],
        { env: { ...process.env, OFFLINE_TEST_PG_CONTAINER: container } });
    } finally {
      command("docker", ["stop", container]);
    }
  });
