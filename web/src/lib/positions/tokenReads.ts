// The three reads the Wallet page needs that no client adapter covers: an ERC-20 `balanceOf`, the ERC-20
// allowance to the Vault, and the native balance of the connected address.
//
// They live here rather than in `@luckydraw/client` because the client deliberately carries no token ABI
// beyond the two calls a deposit needs, and `encodeAllowanceCall` is the one it does export. Everything
// below goes through the same snapshot machinery as every other read (SPEC §10.1: "Related direct reads use
// one blockTag; return chainId, blockNumber, blockHash, timestamp and confidence with the snapshot"), so a
// wallet column and a LuckyDraw column always describe the same block.
//
// Nothing here decodes with a hand-rolled parser: the single uint256 an ERC-20 view returns is read with
// `BigInt(hex)` after a length check, which is the whole of ERC-20's return ABI for these two calls.

import {
  type Address,
  type AssetRecord,
  asHex,
  encodeAllowanceCall,
  type Hex,
  luckyVaultAbi,
  type ReadContext,
  readAssetRecord,
  readBalances,
  readBatch,
  resolveSnapshotBlock,
  type Snapshot,
  type SnapshotBlock,
  snapshotOf,
} from "@luckydraw/client";
import {Interface} from "ethers";

/** `balanceOf(address)` — the four-byte selector plus a left-padded address. */
const BALANCE_OF_SELECTOR = "70a08231";

export function encodeBalanceOfCall(owner: Address): Hex {
  return asHex(`0x${BALANCE_OF_SELECTOR}${owner.slice(2).padStart(64, "0")}`);
}

// `depositsPaused()` is encoded from the generated Vault ABI rather than from a hand-written selector, so a
// rename in the contract becomes a build error here instead of a call that quietly returns nothing.
const vaultInterface = new Interface(luckyVaultAbi);

export function encodeDepositsPausedCall(): Hex {
  return asHex(vaultInterface.encodeFunctionData("depositsPaused", []));
}

/**
 * The Vault's global deposit switch (`LuckyVault.depositsPaused`).
 *
 * SPEC §4.2 gives the Vault a global pause on top of the per-asset `depositsEnabled` flag, and
 * `LuckyVault.deposit` reverts `DepositsPaused()` when it is set. Reading it is what lets a deposit be refused
 * with the catalog's own sentence before any calldata exists, instead of at the wallet prompt.
 *
 * A call that fails (an unreachable node, a transport error) reads as **not paused**: the contract re-validates
 * the switch on every deposit, so a read failure must not be allowed to block the page, and the worst case is
 * the refusal arriving from the revert decoder instead of from here.
 *
 * This belongs in `@luckydraw/client` beside `readBuysPaused`; it lives here only because that package was not
 * this change's to edit.
 */
export async function readDepositsPaused(ctx: ReadContext): Promise<Snapshot<boolean>> {
  const block = await blockFor(ctx);
  const outcomes = await readBatch(
    ctx.provider,
    block,
    [{to: ctx.deployment.vault, data: encodeDepositsPausedCall()}],
    {multicall3: ctx.multicall3},
  );
  const outcome = outcomes[0];
  return snapshotOf(ctx.deployment, block, outcome?.ok === true && decodeUint256(outcome.data) !== 0n);
}

/**
 * One uint256 of ERC-20 return data.
 *
 * A token that answers with no data at all (a non-token address, or a call the node executed against empty
 * code) is reported as zero rather than throwing: the column then reads "0", which is the truth about what
 * the Vault can take, and one odd token never costs the page its other assets.
 */
function decodeUint256(data: string): bigint {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (body.length < 64) return 0n;
  return BigInt(`0x${body.slice(0, 64)}`);
}

/** What one ERC-20 asset looks like from the connected address, at one block. */
export type TokenAccountState = {
  /** The account's own token balance, the "In your wallet" column of SPEC §9.4. */
  walletBalance: bigint;
  /** The allowance from the account to the manifest Vault; the deposit stepper's only input. */
  allowance: bigint;
};

/**
 * The account's token balance and its Vault allowance, from one block.
 *
 * SPEC §9.5: "Before each ERC-20 deposit the app reads the current allowance to the Vault". This is that
 * read, and it is also what the Revoke control and the "outstanding allowance" line show.
 */
export async function readTokenAccountState(
  ctx: ReadContext,
  token: Address,
  owner: Address,
): Promise<Snapshot<TokenAccountState>> {
  const block = await blockFor(ctx);
  const outcomes = await readBatch(
    ctx.provider,
    block,
    [
      {to: token, data: encodeBalanceOfCall(owner)},
      {to: token, data: encodeAllowanceCall(owner, ctx.deployment.vault)},
    ],
    {multicall3: ctx.multicall3},
  );
  const walletOutcome = outcomes[0];
  const allowanceOutcome = outcomes[1];
  return snapshotOf(ctx.deployment, block, {
    walletBalance: walletOutcome?.ok === true ? decodeUint256(walletOutcome.data) : 0n,
    allowance: allowanceOutcome?.ok === true ? decodeUint256(allowanceOutcome.data) : 0n,
  });
}

/** The provider surface the native balance and the contract-code check need, beyond `ReadProvider`. */
export type AccountProbeProvider = {
  getBalance(address: string, blockTag?: string | number): Promise<bigint>;
  getCode(address: string, blockTag?: string | number): Promise<string>;
};

/**
 * The connected address's native balance, for the "In your wallet" column of the native asset and for the
 * gas-needs line (SPEC §9.4: "asset and network details and gas needs").
 */
export async function readNativeBalance(
  ctx: ReadContext,
  probe: AccountProbeProvider,
  owner: Address,
): Promise<Snapshot<bigint>> {
  const block = await blockFor(ctx);
  const balance = await probe.getBalance(owner, `0x${block.blockNumber.toString(16)}`);
  return snapshotOf(ctx.deployment, block, balance);
}

/**
 * Whether the connected address holds code.
 *
 * SPEC §9.4: "When the connected address has code and the asset is BNB, warn before signing that the wallet
 * must accept plain BNB transfers or the transaction reverts and the balance stays in place." A smart-contract
 * wallet is an ordinary, supported user of this app; the warning is a disclosure, never a refusal.
 */
export async function readAccountHasCode(
  ctx: ReadContext,
  probe: AccountProbeProvider,
  owner: Address,
): Promise<Snapshot<boolean>> {
  const block = await blockFor(ctx);
  const code = await probe.getCode(owner, `0x${block.blockNumber.toString(16)}`);
  return snapshotOf(ctx.deployment, block, code !== "0x" && code !== "" && code !== "0X");
}

/** Everything `/wallet` shows about one asset, all of it from the same block. */
export type WalletAssetState = {
  asset: Address;
  /** `Vault.balanceOf`: available only. Escrow is never counted here (SPEC §4.3). */
  vaultBalance: bigint;
  /** The account's own balance of the asset. */
  walletBalance: bigint;
  /** Allowance to the Vault; always zero for the native asset, which has none. */
  allowance: bigint;
  /** `Vault.getAsset`: the live listed flag and deposit switch (SPEC §4.2). */
  record: AssetRecord;
};

export type WalletOverview = {
  assets: readonly WalletAssetState[];
  /** The connected address's native balance, for the gas-needs line. */
  nativeBalance: bigint;
  /** True when the connected address holds code (SPEC §9.4 native-withdrawal warning). */
  accountHasCode: boolean;
};

/**
 * Every balance, allowance and switch the Wallet page needs, from one block.
 *
 * The adapters are composed on a pinned block rather than re-resolved per call, so the two columns of one
 * card and the two columns of the next always describe the same state (SPEC §10.1: "Related direct reads use
 * one blockTag").
 */
export async function readWalletOverview(
  ctx: ReadContext,
  probe: AccountProbeProvider,
  account: Address,
  assets: readonly {asset: Address; native: boolean}[],
): Promise<Snapshot<WalletOverview>> {
  const block = await blockFor(ctx);
  const pinned: ReadContext = {...ctx, block};
  const addresses = assets.map((entry) => entry.asset);
  const [balances, records, tokens, nativeBalance, hasCode] = await Promise.all([
    readBalances(pinned, account, addresses),
    Promise.all(addresses.map((asset) => readAssetRecord(pinned, asset))),
    Promise.all(
      assets.map((entry) => (entry.native ? null : readTokenAccountState(pinned, entry.asset, account))),
    ),
    readNativeBalance(pinned, probe, account),
    readAccountHasCode(pinned, probe, account),
  ]);

  const rows = assets.map((entry, index): WalletAssetState => {
    const token = tokens[index];
    return {
      asset: entry.asset,
      vaultBalance: balances.value[index] ?? 0n,
      walletBalance: entry.native ? nativeBalance.value : (token?.value.walletBalance ?? 0n),
      allowance: token?.value.allowance ?? 0n,
      record: records[index]?.value ?? {listed: false, tokenDecimals: 0n, depositsEnabled: false},
    };
  });

  return snapshotOf(ctx.deployment, block, {
    assets: rows,
    nativeBalance: nativeBalance.value,
    accountHasCode: hasCode.value,
  });
}

/** The context's pinned block, or the SPEC §10.1 walk. Mirrors the client's own private `blockOf`. */
export async function blockFor(ctx: ReadContext): Promise<SnapshotBlock> {
  if (ctx.block !== undefined) return ctx.block;
  return resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag});
}
