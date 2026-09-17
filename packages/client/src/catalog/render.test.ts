// Tests for the catalog lookup and placeholder substitution (SPEC §9.6, §9.7).

import assert from "node:assert/strict";
import {test} from "node:test";

import {CatalogRenderError, catalogEntryFor, hasCatalogEntry, renderMessage} from "./render.ts";
import {stateCatalog} from "./states.ts";

test("renderMessage substitutes every declared placeholder with the string it is given", () => {
  const rendered = renderMessage(catalogEntryFor("BelowMinimum"), {min: "0.00142", symbol: "BNB"});
  assert.equal(rendered, "The minimum entry is now 0.00142 BNB (USD 1 at the current reference price).");
});

test("renderMessage substitutes repeated and multiple placeholders", () => {
  const rendered = renderMessage(catalogEntryFor("InsufficientBalance"), {
    available: "1.5",
    symbol: "BNB",
    gross: "2.0 BNB",
  });
  assert.equal(rendered, "Your LuckyDraw balance is 1.5 BNB; this entry needs 2.0 BNB.");
});

test("renderMessage leaves a message without placeholders untouched, with or without params", () => {
  const entry = catalogEntryFor("AlreadyClaimed");
  assert.equal(renderMessage(entry), entry.message);
  assert.equal(renderMessage(entry, {gas: "0.002"}), entry.message);
});

test("renderMessage reports every missing declared parameter instead of printing a brace next to money", () => {
  const entry = catalogEntryFor("InsufficientBalance");
  assert.throws(
    () => renderMessage(entry, {available: "1.5"}),
    (error: unknown) => {
      if (!(error instanceof CatalogRenderError)) return false;
      assert.deepEqual(error.missing, ["symbol", "gross"]);
      assert.match(error.message, /symbol, gross/);
      return true;
    },
  );
  assert.throws(() => renderMessage(entry), CatalogRenderError);
});

test("an empty string is a value, not a missing parameter", () => {
  assert.equal(
    renderMessage(catalogEntryFor("InsufficientGas"), {gas: ""}),
    "You need about  BNB for network fees.",
  );
});

test("renderMessage leaves an undeclared placeholder untouched", () => {
  assert.equal(
    renderMessage({message: "Waiting for {thing}."}, {other: "x"}),
    "Waiting for {thing}.",
    "text the catalog never declared must survive rendering unchanged",
  );
  assert.equal(renderMessage({message: "A brace {  } stays."}), "A brace {  } stays.");
});

test("renderMessage renders state rows too", () => {
  assert.equal(
    renderMessage(stateCatalog.Drawing, {requestedAt: "2026-10-01 00:04 UTC", requestAge: "6 minutes"}),
    "Waiting for verified randomness. Requested at 2026-10-01 00:04 UTC, 6 minutes ago; usually about ten minutes after cutoff.",
  );
  assert.throws(() => renderMessage(stateCatalog.DrawingDelayed), CatalogRenderError);
});

test("hasCatalogEntry narrows a decoded name to a catalog key", () => {
  const decoded = "SeedNotAuthorized";
  assert.ok(hasCatalogEntry(decoded));
  if (hasCatalogEntry(decoded)) {
    assert.equal(catalogEntryFor(decoded).funds, "Nothing debited");
  }
  assert.ok(!hasCatalogEntry("toString"), "an inherited property name is not a catalog key");
  assert.ok(!hasCatalogEntry("Panic:0x99"));
  assert.ok(hasCatalogEntry("Panic:0x11"));
});
