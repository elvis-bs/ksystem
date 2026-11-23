import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaffAccounts, StaffAuthenticationError } from "../local/staff-accounts.mjs";

const password = "test-staff-password";

test("staff accounts persist with distinct credentials and are isolated by business", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-staff-"));
  const path = join(directory, "staff.sqlite");
  let accounts = new StaffAccounts(path);
  t.after(() => {
    accounts.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const one = await accounts.create("one", { username: "Ana", name: "Ana" }, password);
  const two = await accounts.create("two", { username: "ana", name: "Outra Ana" }, "other-password");
  assert.notEqual(one.id, two.id);
  assert.deepEqual(accounts.list("one"), [one]);
  assert.deepEqual(accounts.list("two"), [two]);
  await assert.rejects(accounts.create("one", { username: "ANA", name: "Ana" }, password), /UNIQUE/);
  await assert.rejects(accounts.authenticate("one", "ana", "other-password"), StaffAuthenticationError);
  accounts.close();
  assert.equal(readFileSync(path).includes(Buffer.from(password)), false);
  accounts = new StaffAccounts(path);
  const identity = await accounts.authenticate("one", "ANA", password);
  assert.equal(identity.id, one.id);
  assert.equal(accounts.isCurrent(identity), true);
  assert.equal(accounts.isCurrent({ ...identity, businessId: "two" }), false);
  await assert.rejects(accounts.authenticate("unknown", "ana", password), /Invalid credentials/);
});

test("deactivation and password changes invalidate prior identities without affecting another store", async t => {
  const accounts = new StaffAccounts(":memory:");
  t.after(() => accounts.close());
  const first = await accounts.create("one", { username: "ana", name: "Ana" }, password);
  const other = await accounts.create("two", { username: "ana", name: "Ana" }, password);
  const identity = await accounts.authenticate("one", "ana", password);
  const otherIdentity = await accounts.authenticate("two", "ana", password);
  assert.throws(() => accounts.setActive("one", other.id, false), /not found/);
  accounts.setActive("one", first.id, false);
  assert.equal(accounts.isCurrent(identity), false);
  assert.equal(accounts.isCurrent(otherIdentity), true);
  await assert.rejects(accounts.authenticate("one", "ana", password), /inactive/);
  accounts.setActive("one", first.id, true);
  assert.equal(accounts.isCurrent(identity), false);
  const renewed = await accounts.authenticate("one", "ana", password);
  await accounts.resetPassword("one", first.id, "new-password");
  assert.equal(accounts.isCurrent(renewed), false);
  await assert.rejects(accounts.authenticate("one", "ana", password), /Invalid credentials/);
  assert.equal((await accounts.authenticate("one", "ana", "new-password")).id, first.id);
  assert.equal(accounts.isCurrent(otherIdentity), true);
});

test("failed attempts persist and concurrent connections enforce the same lockout", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-staff-lock-"));
  const path = join(directory, "staff.sqlite");
  let first = new StaffAccounts(path);
  const second = new StaffAccounts(path);
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
    t.mock.restoreAll();
  });
  await first.create("one", { username: "ana", name: "Ana" }, password);
  let now = 1700000000000;
  t.mock.method(Date, "now", () => now);
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
    (i % 2 ? first : second).authenticate("one", "ana", "wrong")));
  assert.ok(results.every(result => result.status === "rejected"));
  first.close();
  first = new StaffAccounts(path);
  await assert.rejects(first.authenticate("one", "ana", password), /temporarily locked/);
  now += 5 * 60 * 1000;
  assert.equal((await first.authenticate("one", "ana", password)).username, "ana");
});

test("disabling a staff member during password verification rejects the in-flight login", async t => {
  const accounts = new StaffAccounts(":memory:");
  t.after(() => accounts.close());
  const account = await accounts.create("one", { username: "ana", name: "Ana" }, password);
  const pending = accounts.authenticate("one", "ana", password);
  accounts.setActive("one", account.id, false);
  accounts.setActive("one", account.id, true);
  await assert.rejects(pending, /Credentials changed/);
});

test("resetting a password clears a lockout and replaces the previous password", async t => {
  const accounts = new StaffAccounts(":memory:");
  t.after(() => accounts.close());
  const account = await accounts.create("one", { username: "ana", name: "Ana" }, password);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(accounts.authenticate("one", "ana", "wrong"), /Invalid credentials/);
  }
  await assert.rejects(accounts.authenticate("one", "ana", password), /temporarily locked/);
  await accounts.resetPassword("one", account.id, "new-password");
  assert.equal((await accounts.authenticate("one", "ana", "new-password")).id, account.id);
  const reset = accounts.resetPassword("one", account.id, "third-password");
  await reset;
  await assert.rejects(accounts.authenticate("one", "ana", "new-password"), /Invalid credentials/);
  assert.equal((await accounts.authenticate("one", "ana", "third-password")).id, account.id);
});

test("validates inputs and does not expose credentials in listing", async t => {
  const accounts = new StaffAccounts(":memory:");
  t.after(() => accounts.close());
  await assert.rejects(accounts.create("one", { username: "x", name: "Ana" }, password), /username/);
  await assert.rejects(accounts.create("one", { username: "ana", name: "Ana" }, "short"), /password/);
  const account = await accounts.create("one", { username: "ana", name: "Ana" }, password);
  assert.deepEqual(Object.keys(accounts.list("one")[0]).sort(), ["active", "id", "name", "username"]);
  await assert.rejects(accounts.resetPassword("two", account.id, "new-password"), /not found/);
  assert.throws(() => accounts.isCurrent({ businessId: "one", id: account.id }), /identity/);
});
