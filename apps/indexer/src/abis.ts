// Event ABIs the indexer decodes. Morpho shapes are morpho-blue v1.0.0 (EventsLib); Boundline shapes are
// copied from contracts/src; Chainlink AnswerUpdated is the aggregator event (TestPriceFeed emits the same).

export const morphoEventsAbi = [
  {
    type: "event",
    name: "CreateMarket",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      {
        name: "marketParams",
        type: "tuple",
        indexed: false,
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Supply",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: false },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SupplyCollateral",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawCollateral",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: false },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Borrow",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: false },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Repay",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "onBehalf", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Liquidate",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "repaidAssets", type: "uint256", indexed: false },
      { name: "repaidShares", type: "uint256", indexed: false },
      { name: "seizedAssets", type: "uint256", indexed: false },
      { name: "badDebtAssets", type: "uint256", indexed: false },
      { name: "badDebtShares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AccrueInterest",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "prevBorrowRate", type: "uint256", indexed: false },
      { name: "interest", type: "uint256", indexed: false },
      { name: "feeShares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetAuthorization",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "authorizer", type: "address", indexed: true },
      { name: "authorized", type: "address", indexed: true },
      { name: "newIsAuthorized", type: "bool", indexed: false },
    ],
  },
] as const;

/** The market-scoped Morpho events (every one carries the market id as topic1). */
export const MORPHO_MARKET_EVENTS = [
  "CreateMarket",
  "Supply",
  "Withdraw",
  "SupplyCollateral",
  "WithdrawCollateral",
  "Borrow",
  "Repay",
  "Liquidate",
  "AccrueInterest",
] as const;

export const ownableEventsAbi = [
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferStarted",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
] as const;

export const sessionGateEventsAbi = [
  {
    type: "event",
    name: "FeedSet",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "feed", type: "address", indexed: true },
      { name: "feedDecimals", type: "uint8", indexed: false },
      { name: "heartbeat", type: "uint32", indexed: false },
      { name: "tolerance", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeedLocked",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "feed", type: "address", indexed: true },
    ],
  },
] as const;

export const marketCalendarEventsAbi = [
  {
    type: "event",
    name: "YearLoaded",
    inputs: [
      { name: "year", type: "uint256", indexed: true },
      { name: "holidays", type: "uint256", indexed: false },
      { name: "earlyCloses", type: "uint256", indexed: false },
      { name: "source", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ClosureAdded",
    inputs: [
      { name: "dateKey", type: "uint256", indexed: true },
      { name: "reason", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EarlyCloseAdded",
    inputs: [
      { name: "dateKey", type: "uint256", indexed: true },
      { name: "reason", type: "string", indexed: false },
    ],
  },
] as const;

/** Chainlink aggregator / TestPriceFeed. */
export const answerUpdatedAbi = [
  {
    type: "event",
    name: "AnswerUpdated",
    inputs: [
      { name: "current", type: "int256", indexed: true },
      { name: "roundId", type: "uint256", indexed: true },
      { name: "updatedAt", type: "uint256", indexed: false },
    ],
  },
] as const;

export const mirrorRegistryEventsAbi = [
  {
    type: "event",
    name: "OraclePausedSet",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "paused", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MultiplierSet",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "multiplier", type: "uint256", indexed: false },
    ],
  },
] as const;

export const creditDeskEventsAbi = [
  { type: "event", name: "KeeperSet", inputs: [{ name: "keeper", type: "address", indexed: true }] },
  { type: "event", name: "PausedSet", inputs: [{ name: "paused", type: "bool", indexed: false }] },
  {
    type: "event",
    name: "MarketRegistered",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "collateral", type: "address", indexed: true },
      { name: "loanToken", type: "address", indexed: true },
      { name: "lltv", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarketEnabled",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "enabled", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PartnerCreated",
    inputs: [
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "admin", type: "address", indexed: true },
      { name: "signer", type: "address", indexed: false },
      { name: "exposureCap", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PartnerUpdated",
    inputs: [
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "policyVersion", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TickerPolicySet",
    inputs: [
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "collateral", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false },
      { name: "maxLtvWad", type: "uint64", indexed: false },
      { name: "minDraw", type: "uint128", indexed: false },
      { name: "maxDraw", type: "uint128", indexed: false },
      { name: "exposureCap", type: "uint128", indexed: false },
      { name: "policyVersion", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LineOpened",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "marketId", type: "bytes32", indexed: false },
      { name: "policyVersion", type: "uint32", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CollateralAdded",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Drawn",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "price8", type: "uint256", indexed: false },
      { name: "session", type: "uint8", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Repaid",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "full", type: "bool", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CollateralWithdrawn",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "price8", type: "uint256", indexed: false },
      { name: "session", type: "uint8", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LineClosed",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LineHeld",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "reason", type: "bytes32", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LineReleased",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Decision",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "action", type: "bytes32", indexed: true },
      { name: "decisionHash", type: "bytes32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "price8", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Everything a Boundline oracle-stack contract or simulator can emit (calendar, gate, feeds, registry, ownership). */
export const boundlineStackAbi = [
  ...sessionGateEventsAbi,
  ...marketCalendarEventsAbi,
  ...answerUpdatedAbi,
  ...mirrorRegistryEventsAbi,
  ...ownableEventsAbi,
] as const;

export const creditDeskAbi = [...creditDeskEventsAbi, ...ownableEventsAbi] as const;

// ---------------------------------------------------------------- phase 2 (Base mainnet)

/** Coinbase's OracleRegistry on Base mainnet: the verified ABI (basescan, 6 Oct 2026) emits the pause flag and
 *  AccessControl role events; multipliers are read from the tokens (`MultiplierUpdated` / `UIMultiplierUpdated`). */
export const mainnetOracleRegistryEventsAbi = [
  {
    type: "event",
    name: "OraclePausedSet",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "paused", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoleGranted",
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "RoleRevoked",
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "RoleAdminChanged",
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "previousAdminRole", type: "bytes32", indexed: true },
      { name: "newAdminRole", type: "bytes32", indexed: true },
    ],
  },
] as const;

/** Governance and corporate-action events of a B20 asset (base-std v1.1.0 IB20); Transfer and Approval are left out on purpose. */
export const B20_TOKEN_EVENT_NAMES = [
  "Paused",
  "Unpaused",
  "UIMultiplierUpdated",
  "UIMultiplierUpdateCancelled",
  "MultiplierUpdated",
  "Announcement",
  "EndAnnouncement",
  "PolicyUpdated",
  "RoleGranted",
  "RoleRevoked",
  "Seized",
  "SupplyCapUpdated",
] as const;

/** Aave V4 spoke events the indexer follows (ISpoke v0.5.11). */
export const AAVE_SPOKE_EVENT_NAMES = [
  "Supply",
  "Withdraw",
  "Borrow",
  "Repay",
  "LiquidationCall",
  "SetUserPositionManager",
  "UpdatePositionManager",
] as const;
