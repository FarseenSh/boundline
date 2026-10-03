// Minimal `as const` ABIs: only the read surface and events Boundline consumes.
// Shapes copied from the verified sources named in each block.

/** Chainlink AggregatorV3 read surface (the Coinbase feed proxies). */
export const aggregatorV3Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
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

/** Coinbase OracleRegistry (0x3f3E…5CaD): getOracleParams(token) -> (multiplier, paused). */
export const oracleRegistryAbi = [
  {
    type: "function",
    name: "getOracleParams",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "multiplier", type: "uint256" },
      { name: "paused", type: "bool" },
    ],
  },
] as const;

/**
 * B20 asset read subset plus the events the Observatory indexes. Signatures and
 * selectors from base-std v1.1.0 (primitives brief §2.4, §2.10); topic0 hashes
 * re-verified with `cast keccak` on 3 Oct 2026.
 */
export const b20AssetAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "isPaused",
    stateMutability: "view",
    inputs: [{ name: "feature", type: "uint8" }],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "pausedFeatures", stateMutability: "view", inputs: [], outputs: [{ type: "uint8[]" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "policyId",
    stateMutability: "view",
    inputs: [{ name: "policyScope", type: "bytes32" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  // events (topic0 in comments)
  {
    type: "event",
    name: "Transfer", // 0xddf252ad…b3ef
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PolicyUpdated", // 0x8b4790f7…6626
    inputs: [
      { name: "policyScope", type: "bytes32", indexed: true },
      { name: "oldPolicyId", type: "uint64", indexed: false },
      { name: "newPolicyId", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Paused", // 0x3e849708…7146
    inputs: [
      { name: "updater", type: "address", indexed: true },
      { name: "features", type: "uint8[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unpaused", // 0x086a815e…3c57
    inputs: [
      { name: "updater", type: "address", indexed: true },
      { name: "features", type: "uint8[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UIMultiplierUpdated", // 0x2205df45…b055 (Cobalt, scheduled corporate actions)
    inputs: [
      { name: "oldMultiplier", type: "uint256", indexed: false },
      { name: "newMultiplier", type: "uint256", indexed: false },
      { name: "effectiveAtTimestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UIMultiplierUpdateCancelled", // 0x88385633…1cad
    inputs: [
      { name: "cancelledMultiplier", type: "uint256", indexed: false },
      { name: "cancelledEffectiveAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MultiplierUpdated", // 0x4dbe4840…5a3d (legacy Beryl, instant)
    inputs: [{ name: "multiplier", type: "uint256", indexed: false }],
  },
  {
    type: "event",
    name: "Announcement", // 0xccebf821…13f7
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "id", type: "string", indexed: false },
      { name: "description", type: "string", indexed: false },
      { name: "uri", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EndAnnouncement", // 0x96d64daf…0037
    inputs: [{ name: "id", type: "string", indexed: false }],
  },
  {
    type: "event",
    name: "Seized", // 0xa9aec5d8…887c
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoleGranted", // 0x2f878811…6f0d
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "RoleRevoked", // 0xf6391f5c…171b
    inputs: [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "SupplyCapUpdated", // 0x6d14f448…c23a
    inputs: [
      { name: "updater", type: "address", indexed: true },
      { name: "oldSupplyCap", type: "uint256", indexed: false },
      { name: "newSupplyCap", type: "uint256", indexed: false },
    ],
  },
] as const;

/** B20 factory precompile (0xB20f…0000). */
export const b20FactoryAbi = [
  {
    type: "function",
    name: "isB20",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "B20Created", // 0xfd9bf273…ba0d
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "variant", type: "uint8", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "decimals", type: "uint8", indexed: false },
      { name: "variantEventParams", type: "bytes", indexed: false },
    ],
  },
] as const;

/** PolicyRegistry precompile (0x8453…0002) read surface. */
export const policyRegistryAbi = [
  {
    type: "function",
    name: "isAuthorized",
    stateMutability: "view",
    inputs: [
      { name: "policyId", type: "uint64" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "policyExists",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint64" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "compositePolicyChildIds",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "uint64" }],
    outputs: [{ type: "uint64[]" }],
  },
  {
    type: "event",
    name: "PolicyUpdated", // registry-level composite update is CompositePolicyUpdated; token-level is above
    inputs: [
      { name: "policyScope", type: "bytes32", indexed: true },
      { name: "oldPolicyId", type: "uint64", indexed: false },
      { name: "newPolicyId", type: "uint64", indexed: false },
    ],
  },
] as const;

/** Well-known B20 policy scopes and roles (keccak values from base-std B20Constants). */
export const B20_SCOPES = {
  TRANSFER_SENDER_POLICY: "0xd116fc21",
  TRANSFER_RECEIVER_POLICY: "0x210f521b",
  TRANSFER_EXECUTOR_POLICY: "0x724e9c53",
  MINT_RECEIVER_POLICY: "0x6e5b013d",
  SEIZE_EXEMPT_POLICY: "0xfeb346ec",
  SEIZE_RECEIVER_POLICY: "0xb31da27f",
} as const; // getter selectors; the bytes32 values are read through the token's constant getters

/** Morpho Blue v1.0.0 (IMorpho.sol, EventsLib.sol). */
export const morphoAbi = [
  {
    type: "function",
    name: "market",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "supplyShares", type: "uint256" },
          { name: "borrowShares", type: "uint128" },
          { name: "collateral", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "idToMarketParams",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
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
    type: "function",
    name: "isAuthorized",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "authorized", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
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
    name: "Borrow", // 0x57095454…2a43
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
    name: "SetAuthorization",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "authorizer", type: "address", indexed: true },
      { name: "authorized", type: "address", indexed: true },
      { name: "newIsAuthorized", type: "bool", indexed: false },
    ],
  },
] as const;

/** Morpho IOracle: price() scaled by 1e36 (raw loan per raw collateral). */
export const morphoOracleAbi = [
  { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const premiumDelta = {
  type: "tuple",
  components: [
    { name: "sharesDelta", type: "int256" },
    { name: "offsetRayDelta", type: "int256" },
    { name: "restoredPremiumRay", type: "uint256" },
  ],
} as const;

/** Aave V4 v0.5.11 spoke read subset (ISpoke.sol). `flags` is the ReserveFlags user type (uint8). */
export const aaveSpokeAbi = [
  { type: "function", name: "getReserveCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getReserve",
    stateMutability: "view",
    inputs: [{ name: "reserveId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "underlying", type: "address" },
          { name: "hub", type: "address" },
          { name: "assetId", type: "uint16" },
          { name: "decimals", type: "uint8" },
          { name: "collateralRisk", type: "uint24" },
          { name: "flags", type: "uint8" },
          { name: "dynamicConfigKey", type: "uint32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getReserveConfig",
    stateMutability: "view",
    inputs: [{ name: "reserveId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "collateralRisk", type: "uint24" },
          { name: "paused", type: "bool" },
          { name: "frozen", type: "bool" },
          { name: "borrowable", type: "bool" },
          { name: "receiveSharesEnabled", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getReserveTotalDebt",
    stateMutability: "view",
    inputs: [{ name: "reserveId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getReserveSuppliedAssets",
    stateMutability: "view",
    inputs: [{ name: "reserveId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getUserPosition",
    stateMutability: "view",
    inputs: [
      { name: "reserveId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "drawnShares", type: "uint120" },
          { name: "premiumShares", type: "uint120" },
          { name: "premiumOffsetRay", type: "int200" },
          { name: "suppliedShares", type: "uint120" },
          { name: "dynamicConfigKey", type: "uint32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "riskPremium", type: "uint256" },
          { name: "avgCollateralFactor", type: "uint256" },
          { name: "healthFactor", type: "uint256" },
          { name: "totalCollateralValue", type: "uint256" },
          { name: "totalDebtValueRay", type: "uint256" },
          { name: "activeCollateralCount", type: "uint256" },
          { name: "borrowCount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isPositionManager",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "positionManager", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isPositionManagerActive",
    stateMutability: "view",
    inputs: [{ name: "positionManager", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Supply",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "suppliedShares", type: "uint256", indexed: false },
      { name: "suppliedAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "withdrawnShares", type: "uint256", indexed: false },
      { name: "withdrawnAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Borrow",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "drawnShares", type: "uint256", indexed: false },
      { name: "drawnAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Repay",
    inputs: [
      { name: "reserveId", type: "uint256", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "drawnShares", type: "uint256", indexed: false },
      { name: "totalAmountRepaid", type: "uint256", indexed: false },
      { ...premiumDelta, name: "premiumDelta", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LiquidationCall",
    inputs: [
      { name: "collateralReserveId", type: "uint256", indexed: true },
      { name: "debtReserveId", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "liquidator", type: "address", indexed: false },
      { name: "receiveShares", type: "bool", indexed: false },
      { name: "debtAmountRestored", type: "uint256", indexed: false },
      { name: "drawnSharesLiquidated", type: "uint256", indexed: false },
      { ...premiumDelta, name: "premiumDelta", indexed: false },
      { name: "collateralAmountRemoved", type: "uint256", indexed: false },
      { name: "collateralSharesLiquidated", type: "uint256", indexed: false },
      { name: "collateralSharesToLiquidator", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SetUserPositionManager",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "positionManager", type: "address", indexed: true },
      { name: "approve", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UpdatePositionManager",
    inputs: [
      { name: "positionManager", type: "address", indexed: true },
      { name: "active", type: "bool", indexed: false },
    ],
  },
] as const;

/** Aerodrome Slipstream CLPool read surface (six-field slot0, verified live 3 Oct 2026). */
export const clPoolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
] as const;

/** ERC-20 read subset. */
export const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Event topic0 hashes the indexer filters on (verified with `cast keccak`). */
export const TOPICS = {
  b20Created: "0xfd9bf2730513a1709722ff379a0844dfd8f997d600693c2bcc659e188bbdba0d",
  uiMultiplierUpdated: "0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055",
  uiMultiplierUpdateCancelled: "0x883856335ba5f60c18b9817c4505d3c7d3f6223dcf39516b30c508c46a5e1cad",
  multiplierUpdated: "0x4dbe4840d7465bd162f67814cea0b519567a2e0e578bcde61e7f4ced361e5a3d",
  paused: "0x3e849708b13f20dd0b87a503523c305e7604cd7e8f855e7a5ebe21397dfd7146",
  unpaused: "0x086a815e5123cf1af5cb7a82f8b052bf96c622204c98b2f4f9782bf77f753c57",
  policyUpdated: "0x8b4790f7ff717fc8f60f07ae099e47ef318dc04b37ae98056b50a22b79056626",
  announcement: "0xccebf8218a62875909564adef86a6f4df81503cb617221e793357d62f8e813f7",
  seized: "0xa9aec5d8b86e2fa2fd6ac3af62f2622e3dfdab1967d4cbbb56a5df7d74cb887c",
  roleGranted: "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d",
  morphoBorrow: "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",
} as const;
