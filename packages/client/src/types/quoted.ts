// A quote together with what it was read for (SPEC §9.5: "A new amount requires a fresh preview").
//
// `ILuckyDraw.Quote` carries no round id, no buyer and no asset: those are the arguments of `quoteBuy`, and
// the struct only answers for them. A quote handed to the write builders on its own would bind calldata to
// nothing but the amount, and the two events SPEC §9.5 anticipates between a preview and a prompt (a purchase
// reaching the target so the successor opens, and the wallet switching accounts) would turn an old quote into
// disclosures for another round or another buyer. The read adapters stamp every quote with the context it was
// read for, and `writes/entry.ts` refuses a request that names anything else.

import type {Address} from "./common.ts";
import type {Quote} from "./generated.ts";

/** The `quoteBuy` arguments plus the round facts the disclosures depend on, all from the quoted block. */
export type QuoteContext = {
  /** The round the quote was read for. */
  roundId: bigint;
  /** The buyer the quote was read for: `quoteBuy`'s `user`, whose balance and share it answers for. */
  user: Address;
  /** `round.asset` at the quoted block, named in the decoded summary before the prompt (SPEC §9.6). */
  asset: Address;
  /** `round.seeded` at the quoted block. A seeded round cannot quote a fallback seed. */
  seeded: boolean;
};

/** A quote and the context it was read for. The read adapters produce one from a live node. */
export type QuotedBuy = {
  quote: Quote;
  quotedFor: QuoteContext;
};
