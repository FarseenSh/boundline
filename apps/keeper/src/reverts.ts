// Revert decoding for the keeper's pre-flight simulations: a 4-byte selector lookup, nothing computed at runtime.
// Generated 8 Oct 2026 from the forge artifacts of every contract on the protection path (Protector, the vendored
// PreLiquidation, DeskProtectionVault, CreditDesk and CreditDeskLib, SessionGate, SessionGuard, ShadowGuard,
// MockSwapPool, MockCLPool) and OpenZeppelin's errors, with `cast sig`; Morpho Blue reverts with strings.
// Regenerate the same way when a contract's errors change; test/reverts.test.ts checks entries against viem.
import type { Hex } from "viem";

export const ERRORS: Readonly<Record<string, string>> = {
  "0x9996b315": "AddressEmptyCode(address)",
  "0x2e174d17": "AdvanceCapExceeded(uint256,uint256,uint256)",
  "0x3d91b05f": "AuthorizationExpired(uint256)",
  "0xb9738588": "BadAuthorization()",
  "0x56c283d4": "BadDrawBounds(uint128,uint128)",
  "0x2794014b": "BadFeedDecimals(uint8)",
  "0x099ced2a": "BadLtv(uint64)",
  "0x8045cecd": "BadWindow(uint32)",
  "0xe5715567": "BadWindow(uint32,uint32)",
  "0x54dc9389": "DebtOutstanding(uint256)",
  "0x5e996b38": "DeviationOutOfRange(uint16)",
  "0xfb8f41b2": "ERC20InsufficientAllowance(address,uint256,uint256)",
  "0xe450d38c": "ERC20InsufficientBalance(address,uint256,uint256)",
  "0xe602df05": "ERC20InvalidApprover(address)",
  "0xec442f05": "ERC20InvalidReceiver(address)",
  "0x96c6fd1e": "ERC20InvalidSender(address)",
  "0x94280d62": "ERC20InvalidSpender(address)",
  "0xf80dbaea": "Expired(uint256)",
  "0xd6bda275": "FailedCall()",
  "0xd848aaa4": "FeedAlreadyLocked(address)",
  "0xc757e06f": "FeedInvalid(address,int256,uint256)",
  "0x0dcaf86b": "FeedNotSet(address)",
  "0x569605e3": "FeedPaused(address)",
  "0x604190ac": "FeedStale(address,uint256,uint256)",
  "0x8ea70c07": "FeeTooHigh(uint16)",
  "0x10709c02": "FullCloseNotAllowed()",
  "0x7499a1b0": "HaircutTooLarge(uint16)",
  "0xf0732dd7": "InconsistentInput()",
  "0xcf479181": "InsufficientBalance(uint256,uint256)",
  "0x2c19b8b8": "InsufficientOutput(uint256,uint256)",
  "0xb3512b0c": "InvalidShortString()",
  "0x0f12adf1": "LineExists(uint256)",
  "0x63bd1f7e": "LineNotOpen(uint256)",
  "0xf78266a2": "LiquidatablePosition()",
  "0x97d841f8": "LoanTokenMismatch(address)",
  "0xac78bd29": "MarketAlreadyRegistered(bytes32)",
  "0x3e363de9": "MarketClosed(uint8)",
  "0x8ef399f7": "MissingObservation(uint32)",
  "0x337e52b5": "NoAdvanceOutstanding(uint256)",
  "0x766f4d98": "NonexistentMarket()",
  "0xc149905d": "NoPrice()",
  "0xcf3c8b74": "NoRoute(address)",
  "0xa598aebe": "NotFunder()",
  "0x797dba54": "NothingOwed()",
  "0x86f97250": "NothingToProtect(uint256)",
  "0xd32e7fc6": "NothingToRepay()",
  "0x47e6c92d": "NotInBand(uint8)",
  "0xf512b278": "NotKeeper()",
  "0x5ef1f646": "NotLineOwner()",
  "0xe51b5123": "NotMorpho()",
  "0x76c6c93a": "NotOperator(address)",
  "0x6f52921e": "NotPartnerAdmin()",
  "0x0bb9a651": "NotPreLiquidatablePosition()",
  "0x35dfe765": "NotProtectionVault()",
  "0x2cf6c46f": "NotTheDeskVault(address)",
  "0x27e8e875": "OLD()",
  "0xffb8506c": "OnlyFullClose(uint256,uint256)",
  "0x979655e1": "OracleNotSessionGuard(address)",
  "0x1e4fbdf7": "OwnableInvalidOwner(address)",
  "0x118cdaa7": "OwnableUnauthorizedAccount(address)",
  "0x1c4e1e52": "PartialAvailable(uint256)",
  "0xc7a8e630": "PartnerExists(bytes32)",
  "0x9e87fac8": "Paused()",
  "0x5b083d28": "PolicyForbids(bytes32,address)",
  "0x9327de16": "PoolMismatch(address,address)",
  "0x6afcba9c": "PoolMismatch(address,address,address)",
  "0x1bc4f823": "PreLCFDecreasing()",
  "0x143ff1d8": "PreLCFTooHigh()",
  "0x507692f4": "PreLIFDecreasing()",
  "0x31aff753": "PreLIFTooHigh()",
  "0x26c48f60": "PreLIFTooLow()",
  "0x44bb1e75": "PreLiquidationTooLarge(uint256,uint256)",
  "0xf0586c23": "PreLltvTooHigh()",
  "0x3ee5aeb5": "ReentrancyGuardReentrantCall()",
  "0xbd5adfec": "Refused(uint8)",
  "0x327269a7": "SafeCastOverflowedIntDowncast(uint8,int256)",
  "0xa8ce4432": "SafeCastOverflowedIntToUint(int256)",
  "0x6dfcc650": "SafeCastOverflowedUintDowncast(uint8,uint256)",
  "0x24775e06": "SafeCastOverflowedUintToInt(uint256)",
  "0xe570110f": "SafeERC20FailedDecreaseAllowance(address,uint256,uint256)",
  "0x5274afe7": "SafeERC20FailedOperation(address)",
  "0x70d18dcc": "ScaleUnderflow()",
  "0x317e8275": "SeizeTooLarge(uint256,uint256)",
  "0xafd46ce0": "ShadowDeviation(uint256,uint256,uint16)",
  "0xf671b7ea": "ShadowUnavailable(uint8,bool,bool)",
  "0x71c4efed": "SlippageExceeded(uint256,uint256)",
  "0x305a27a9": "StringTooLong(string)",
  "0x2bc80f3a": "T()",
  "0x483d42b2": "TransferPaused(address)",
  "0xc2221189": "UnexpectedCallback(address)",
  "0x1179e183": "UnknownLine(uint256)",
  "0x64d7c3f1": "UnknownMarket(bytes32)",
  "0x1f97232d": "UnknownPartner(bytes32)",
  "0x81a3b1be": "UnknownToken(address)",
  "0x0ff42e2c": "Unpaid(address,uint256,uint256)",
  "0xfb1912d6": "WrongMorpho(address)",
  "0xd92e233d": "ZeroAddress()",
  "0x1f2a2005": "ZeroAmount()",
};

const ERROR_STRING = "0x08c379a0";
const PANIC = "0x4e487b71";

/** A readable reason for revert data: the custom error's signature, Error(string)'s message, Panic's code, or the raw selector. */
export function decodeRevert(data: unknown): string {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return "reverted without data";
  const sel = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);
  if (sel === ERROR_STRING) {
    try {
      const len = Number(BigInt(`0x${body.slice(64, 128)}`));
      const hex = body.slice(128, 128 + len * 2);
      let text = "";
      for (let i = 0; i < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return `Error("${text}")`;
    } catch {
      return "Error(string)";
    }
  }
  if (sel === PANIC) return `Panic(0x${BigInt(`0x${body.slice(0, 64) || "0"}`).toString(16)})`;
  return ERRORS[sel] ?? `unknown error ${sel}`;
}

/** The revert data carried by an RPC error (`data` as a hex string, or nested in `data.data` on some nodes). */
export function revertDataOf(err: unknown): Hex | null {
  const d = (err as { data?: unknown } | null)?.data;
  if (typeof d === "string" && d.startsWith("0x")) return d as Hex;
  const inner = (d as { data?: unknown } | null)?.data;
  return typeof inner === "string" && inner.startsWith("0x") ? (inner as Hex) : null;
}
