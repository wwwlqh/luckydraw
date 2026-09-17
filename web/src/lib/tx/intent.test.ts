// The persisted intent is untrusted input (SPEC §9.6).
//
// Session storage is writable by anything running in this origin and by the user's own devtools. The intent
// is read back on every mount and handed straight to the state machine and to `TxStepper`, which formats
// `startedAt` with `Intl.DateTimeFormat` — a throw there reaches the error boundary on every reload for as
// long as the value stays stored. So: strict shape checks, and anything malformed is removed rather than kept.

import {beforeEach, describe, expect, it} from "vitest";
import {
  clearIntentFor,
  INTENT_STORAGE_KEY,
  intentTargetsDeployment,
  loadIntent,
  type PendingIntent,
} from "./intent.ts";

const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const VAULT = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const HASH = `0x${"ab".repeat(32)}`;

function valid(): PendingIntent {
  return {
    action: "deposit",
    contract: "vault",
    function: "depositNative",
    label: "Deposit",
    account: ACCOUNT,
    chainId: "31337",
    to: VAULT,
    data: "0x1234",
    value: "1000",
    nonce: 7,
    hash: HASH,
    startedAt: 1_700_000_000_000,
  };
}

function store(intent: Record<string, unknown>): void {
  window.sessionStorage.setItem(INTENT_STORAGE_KEY, JSON.stringify(intent));
}

describe("loadIntent", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("accepts a well-formed intent", () => {
    store(valid());
    expect(loadIntent(window.sessionStorage, 31_337n, ACCOUNT)).toMatchObject({hash: HASH});
  });

  const malformed: Readonly<Record<string, unknown>> = {
    // The one that actually crashed the page: no timestamp, so `new Date(undefined)` reaches the formatter.
    startedAt: undefined,
    label: 7,
    account: "not-an-address",
    chainId: "0x7a69",
    to: "0x610178da211fef7d417bc0e6fed39f05609ad78",
    data: "0x123",
    value: "1e18",
    nonce: 1.5,
    hash: "0xabcd",
    action: "",
    contract: 3,
    function: null,
  };

  for (const [field, badValue] of Object.entries(malformed)) {
    it(`refuses and clears an intent whose ${field} is malformed`, () => {
      const intent: Record<string, unknown> = {...valid()};
      if (badValue === undefined) delete intent[field];
      else intent[field] = badValue;
      store(intent);

      expect(loadIntent(window.sessionStorage, 31_337n, ACCOUNT)).toBeNull();
      expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
    });
  }

  it("refuses and clears a value that is not even JSON", () => {
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, "{not json");
    expect(loadIntent(window.sessionStorage, 31_337n, ACCOUNT)).toBeNull();
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("keeps an intent that is simply another chain's or another account's", () => {
    store({...valid(), chainId: "56"});
    expect(loadIntent(window.sessionStorage, 31_337n, ACCOUNT)).toBeNull();
    // Well-formed, just not ours to read or to delete: another tab on another chain owns it.
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).not.toBeNull();
  });
});

describe("intentTargetsDeployment", () => {
  it("accepts the Vault, the Draw and a manifest asset, and nothing else", () => {
    const asset = "0x0000000000000000000000000000000000000abc";
    const allowed = [VAULT, "0x5fbdb2315678afecb367f032d93f642f64180aa3", asset];
    expect(intentTargetsDeployment(valid(), allowed)).toBe(true);
    expect(intentTargetsDeployment({...valid(), to: asset.toUpperCase()}, allowed)).toBe(true);
    expect(
      intentTargetsDeployment({...valid(), to: "0x000000000000000000000000000000000000dead"}, allowed),
    ).toBe(false);
  });
});

describe("clearIntentFor", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("leaves another run's intent alone", () => {
    store(valid());
    clearIntentFor(window.sessionStorage, `0x${"cd".repeat(32)}`);
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).not.toBeNull();
  });

  it("clears its own", () => {
    store(valid());
    clearIntentFor(window.sessionStorage, HASH);
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });

  it("clears a malformed value, which can never be reattached to anyway", () => {
    window.sessionStorage.setItem(INTENT_STORAGE_KEY, "{not json");
    clearIntentFor(window.sessionStorage, HASH);
    expect(window.sessionStorage.getItem(INTENT_STORAGE_KEY)).toBeNull();
  });
});
