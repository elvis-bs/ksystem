import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineAuth, OfflineAuthenticationError } from "../local/offline-auth.mjs";

const userId = "11111111-1111-1111-1111-111111111111";
const password = "test-password-not-real";
const email = "shop@example.test";
const client = {
  auth: {
    async signInWithPassword(request) {
      assert.deepEqual(request, { email, password });
      return { data: { user: { id: userId, email }, session: { user: { id: userId } } }, error: null };
    }
  }
};

test("online provisioning enables offline login after restart without storing the password", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-auth-"));
  const path = join(directory, "auth.sqlite");
  let auth = new OfflineAuth(path);
  t.after(() => {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await auth.provision(" Shop@Example.Test ", password, client), { email, businessId: userId });
  auth.close();
  assert.equal(readFileSync(path).includes(Buffer.from(password)), false);
  auth = new OfflineAuth(path);
  assert.deepEqual(await auth.authenticate("SHOP@example.test", password), { email, businessId: userId });
  await assert.rejects(auth.authenticate(email, "wrong"), OfflineAuthenticationError);
});

test("online verification must succeed and cannot replace an existing verifier", async t => {
  const auth = new OfflineAuth(":memory:");
  t.after(() => auth.close());
  const invalid = { auth: { signInWithPassword: async () => ({ data: null, error: { message: "invalid" } }) } };
  await assert.rejects(auth.provision(email, password, invalid), /Online authentication failed/);
  await assert.rejects(auth.authenticate(email, password), /Invalid credentials/);
  const mismatched = { auth: { signInWithPassword: async () => ({
    data: { user: { id: userId, email: "other@example.test" }, session: { user: { id: userId } } }, error: null
  }) } };
  await assert.rejects(auth.provision(email, password, mismatched), /invalid account/);
  const mismatchedSession = { auth: { signInWithPassword: async () => ({
    data: { user: { id: userId, email }, session: { user: { id: "another-user" } } }, error: null
  }) } };
  await assert.rejects(auth.provision(email, password, mismatchedSession), /invalid account/);
  await auth.provision(email, password, client);
  await assert.rejects(auth.provision(email, password, client), /UNIQUE constraint failed/);
  assert.equal((await auth.authenticate(email, password)).businessId, userId);
});

test("failed attempts persist, lock the account, and expire without accepting correct password early", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-auth-lock-"));
  const path = join(directory, "auth.sqlite");
  let auth = new OfflineAuth(path);
  t.after(() => {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
    t.mock.restoreAll();
  });
  await auth.provision(email, password, client);
  let time = 1700000000000;
  t.mock.method(Date, "now", () => time);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(auth.authenticate(email, "wrong"), /Invalid credentials/);
  }
  auth.close();
  auth = new OfflineAuth(path);
  await assert.rejects(auth.authenticate(email, password), /temporarily locked/);
  time += 5 * 60 * 1000;
  assert.deepEqual(await auth.authenticate(email, password), { email, businessId: userId });
  await assert.rejects(auth.authenticate(email, "wrong"), /Invalid credentials/);
  assert.equal((await auth.authenticate(email, password)).businessId, userId);
});

test("concurrent failed logins cannot bypass lockout", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-auth-concurrency-"));
  const path = join(directory, "auth.sqlite");
  const auth = new OfflineAuth(path);
  const second = new OfflineAuth(path);
  t.after(() => {
    auth.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await auth.provision(email, password, client);
  const failures = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
    (i % 2 ? auth : second).authenticate(email, "wrong")));
  assert.ok(failures.every(result => result.status === "rejected"));
  await assert.rejects(second.authenticate(email, password), /temporarily locked/);
});
