// Which tokens need `approve(0)` before a new approval (SPEC §9.5).
//
// SPEC §9.5: "if it is positive but short, offer approve(amount), or approve(0) then approve(amount) for
// tokens flagged requiresZeroReset in the asset manifest". That flag is now a real field: it is in
// `config/schema/asset.schema.json` (optional, boolean, checked by the validator's A9 rule) and the client's
// `parseManifest` turns it into a typed `boolean` on `ManifestAsset`, false when the document omits it. So the
// flag is sourced here in two steps, in this order:
//
//   1. the manifest's own asset record, which is the pinned, validated statement for this deployment;
//   2. otherwise this constant map, keyed by chain id and lowercase token address, which stays as the
//      fallback for a deployment whose manifest predates the field or whose operator has not recorded it yet.
//
// The map is deliberately empty for the local mock deployment: `MockERC20` is a plain OpenZeppelin ERC-20,
// whose `approve` accepts any new value. The canonical member of this list on BSC is Binance-Peg USDT
// (0x55d398326f99059ff775485246999027b3197955), whose `approve` follows the USDT pattern and refuses a
// nonzero-to-nonzero change; it is listed here so the behaviour is decided before that asset is ever admitted
// rather than during an incident.
//
// Getting this wrong in the safe direction costs one extra transaction; getting it wrong in the other
// direction costs a reverted approval with the user's gas spent, so an unknown token is NOT reset by default
// (an unnecessary approve(0) would also leave a window in which the deposit cannot proceed).

import type {ManifestAsset} from "@luckydraw/client";

/** Chain id to the lowercase token addresses whose `approve` refuses a nonzero-to-nonzero change. */
export const ZERO_RESET_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // BNB Smart Chain mainnet. Binance-Peg USDT.
  "56": ["0x55d398326f99059ff775485246999027b3197955"],
  // BSC testnet: no admitted token needs it today.
  "97": [],
  // Local anvil mocks: MockERC20 is a plain OpenZeppelin ERC-20.
  "31337": [],
};

/**
 * Whether this asset's `approve` must be reset to zero first.
 *
 * The manifest is read first and settles it when it says true, because it is the pinned, validated record for
 * this deployment. A false or absent flag then falls through to the map rather than overriding it: the field
 * defaults to false, so an operator who simply never recorded it would otherwise be indistinguishable from one
 * who checked and found no reset needed, and on a token like Binance-Peg USDT that mistake costs the user a
 * reverted approval. A deployment that really wants the map ignored removes the address from it.
 */
export function requiresZeroReset(asset: ManifestAsset, chainId: bigint): boolean {
  if (asset.native) return false;
  if (asset.requiresZeroReset) return true;
  const listed = ZERO_RESET_TOKENS[chainId.toString()] ?? [];
  return listed.includes(asset.asset.toLowerCase());
}
