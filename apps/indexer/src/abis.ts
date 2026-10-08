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
// ---------------------------------------------------------------- Sepolia protection stack (8 Oct 2026)

/** Events of the Protector, DeskProtectionVault, BoundlineReserve and LocalPayoutRouter, generated from the forge
 *  artifacts (contracts/out) on 8 Oct 2026. Signatures shared by several of them (KeeperSet, Ownership*) appear once;
 *  `Protected` appears twice with different signatures (Protector vs DeskProtectionVault), so the emitter address
 *  tells them apart. */
export const sepoliaProtectionAbi = [
  // Protector/DeskProtectionVault: KeeperSet(address)
  {
    type: "event",
    name: "KeeperSet",
    inputs: [
      { name: "keeper", type: "address", indexed: true },
    ],
  },
  // Protector/DeskProtectionVault/BoundlineReserve: OwnershipTransferStarted(address,address)
  {
    type: "event",
    name: "OwnershipTransferStarted",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  // Protector/DeskProtectionVault/BoundlineReserve: OwnershipTransferred(address,address)
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  // Protector: Protected(uint256,address,address,uint256,uint256,uint256,uint256,uint256,bytes32)
  {
    type: "event",
    name: "Protected",
    inputs: [
      { name: "decision", type: "uint256", indexed: true },
      { name: "preLiquidation", type: "address", indexed: true },
      { name: "borrower", type: "address", indexed: true },
      { name: "seizedAssets", type: "uint256", indexed: false },
      { name: "repaidAssets", type: "uint256", indexed: false },
      { name: "collateralSold", type: "uint256", indexed: false },
      { name: "venuePrice36", type: "uint256", indexed: false },
      { name: "shadowPrice36", type: "uint256", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  // Protector: RouteSet(address,address,bool)
  {
    type: "event",
    name: "RouteSet",
    inputs: [
      { name: "collateral", type: "address", indexed: true },
      { name: "pool", type: "address", indexed: true },
      { name: "collateralIsToken0", type: "bool", indexed: false },
    ],
  },
  // Protector: Swept(address,address,uint256)
  {
    type: "event",
    name: "Swept",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: AdvanceSettled(uint256,address,uint256,uint256,uint256,bytes32)
  {
    type: "event",
    name: "AdvanceSettled",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "principal", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "outstandingAfter", type: "uint256", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  // DeskProtectionVault: AdvanceTermsSet(uint256,uint16)
  {
    type: "event",
    name: "AdvanceTermsSet",
    inputs: [
      { name: "capPerLine", type: "uint256", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false },
    ],
  },
  // DeskProtectionVault: AdvancesDefunded(address,uint256)
  {
    type: "event",
    name: "AdvancesDefunded",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: AdvancesFunded(address,uint256)
  {
    type: "event",
    name: "AdvancesFunded",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: CollateralRecovered(uint256,address,address,uint256,uint256,bytes32)
  {
    type: "event",
    name: "CollateralRecovered",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "price8", type: "uint256", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  // DeskProtectionVault: CollateralReturned(uint256,address,address,uint256,bytes32)
  {
    type: "event",
    name: "CollateralReturned",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  // DeskProtectionVault: Decision(uint256,bytes32,bytes32,uint256)
  {
    type: "event",
    name: "Decision",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "action", type: "bytes32", indexed: true },
      { name: "decisionHash", type: "bytes32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: FeesCollected(address,uint256)
  {
    type: "event",
    name: "FeesCollected",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: FunderSet(address)
  {
    type: "event",
    name: "FunderSet",
    inputs: [
      { name: "funder", type: "address", indexed: true },
    ],
  },
  // DeskProtectionVault: PartnerAdminSet(bytes32,address)
  {
    type: "event",
    name: "PartnerAdminSet",
    inputs: [
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "admin", type: "address", indexed: true },
    ],
  },
  // DeskProtectionVault: PartnerDeposited(bytes32,address,uint256)
  {
    type: "event",
    name: "PartnerDeposited",
    inputs: [
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: PartnerWithdrawn(bytes32,address,uint256)
  {
    type: "event",
    name: "PartnerWithdrawn",
    inputs: [
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: PausedSet(bool)
  {
    type: "event",
    name: "PausedSet",
    inputs: [
      { name: "paused", type: "bool", indexed: false },
    ],
  },
  // DeskProtectionVault: Protected(uint256,address,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,bytes32)
  {
    type: "event",
    name: "Protected",
    inputs: [
      { name: "lineId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "partnerId", type: "bytes32", indexed: true },
      { name: "repaid", type: "uint256", indexed: false },
      { name: "fromUser", type: "uint256", indexed: false },
      { name: "fromPartner", type: "uint256", indexed: false },
      { name: "fromAdvance", type: "uint256", indexed: false },
      { name: "debtBefore", type: "uint256", indexed: false },
      { name: "debtAfter", type: "uint256", indexed: false },
      { name: "decisionHash", type: "bytes32", indexed: false },
    ],
  },
  // DeskProtectionVault: UserDeposited(address,address,uint256)
  {
    type: "event",
    name: "UserDeposited",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // DeskProtectionVault: UserWithdrawn(address,uint256)
  {
    type: "event",
    name: "UserWithdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: Allocated(address,uint256,uint256)
  {
    type: "event",
    name: "Allocated",
    inputs: [
      { name: "sink", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "allocatedAfter", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: Approval(address,address,uint256)
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: CooldownSet(uint64)
  {
    type: "event",
    name: "CooldownSet",
    inputs: [
      { name: "cooldownSeconds", type: "uint64", indexed: false },
    ],
  },
  // BoundlineReserve: Deposit(address,address,uint256,uint256)
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: Harvested(address,uint256)
  {
    type: "event",
    name: "Harvested",
    inputs: [
      { name: "sink", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: ManagerSet(address)
  {
    type: "event",
    name: "ManagerSet",
    inputs: [
      { name: "manager", type: "address", indexed: true },
    ],
  },
  // BoundlineReserve: Recalled(address,uint256,uint256)
  {
    type: "event",
    name: "Recalled",
    inputs: [
      { name: "sink", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "allocatedAfter", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: RedeemRequestCancelled(address,uint256)
  {
    type: "event",
    name: "RedeemRequestCancelled",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: RedeemRequested(address,uint256,uint64)
  {
    type: "event",
    name: "RedeemRequested",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
      { name: "requestedAt", type: "uint64", indexed: false },
    ],
  },
  // BoundlineReserve: SinkAdded(address)
  {
    type: "event",
    name: "SinkAdded",
    inputs: [
      { name: "sink", type: "address", indexed: true },
    ],
  },
  // BoundlineReserve: SinkRemoved(address)
  {
    type: "event",
    name: "SinkRemoved",
    inputs: [
      { name: "sink", type: "address", indexed: true },
    ],
  },
  // BoundlineReserve: Transfer(address,address,uint256)
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: UtilisationCapSet(uint16)
  {
    type: "event",
    name: "UtilisationCapSet",
    inputs: [
      { name: "utilisationCapBps", type: "uint16", indexed: false },
    ],
  },
  // BoundlineReserve: Withdraw(address,address,address,uint256,uint256)
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  // BoundlineReserve: WrittenDown(address,uint256,uint256)
  {
    type: "event",
    name: "WrittenDown",
    inputs: [
      { name: "sink", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "allocatedAfter", type: "uint256", indexed: false },
    ],
  },
  // LocalPayoutRouter: Payout(address,address,address,address,uint256,uint256,address)
  {
    type: "event",
    name: "Payout",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "pool", type: "address", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------- Base PolicyRegistry precompile (8 Oct 2026)

/** The B20 PolicyRegistry precompile at 0x8453…0002 (base-std v1.1.0 IPolicyRegistry). Whole-chain volume is tiny (two
 *  events between blocks 52,198,000 and 52,327,328: policy 129's blocklist add and remove of 5 Oct 2026), so the seize
 *  watch follows every policy's membership changes. */
export const policyRegistryEventsAbi = [
  {
    type: "event",
    name: "PolicyCreated",
    inputs: [
      { name: "policyId", type: "uint64", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "policyType", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PolicyAdminStaged",
    inputs: [
      { name: "policyId", type: "uint64", indexed: true },
      { name: "currentAdmin", type: "address", indexed: true },
      { name: "pendingAdmin", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "PolicyAdminUpdated",
    inputs: [
      { name: "policyId", type: "uint64", indexed: true },
      { name: "previousAdmin", type: "address", indexed: true },
      { name: "newAdmin", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AllowlistUpdated",
    inputs: [
      { name: "policyId", type: "uint64", indexed: true },
      { name: "updater", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false },
      { name: "accounts", type: "address[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BlocklistUpdated",
    inputs: [
      { name: "policyId", type: "uint64", indexed: true },
      { name: "updater", type: "address", indexed: true },
      { name: "blocked", type: "bool", indexed: false },
      { name: "accounts", type: "address[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CompositePolicyUpdated",
    inputs: [
      { name: "policyId", type: "uint64", indexed: true },
      { name: "updater", type: "address", indexed: true },
      { name: "childPolicyIds", type: "uint64[]", indexed: false },
    ],
  },
] as const;
