// Write surfaces of the Sepolia simulators (contracts/src/test). Reads use @boundline/chain's aggregatorV3Abi and
// oracleRegistryAbi, which the simulators implement.
export const testPriceFeedAbi = [
  {
    type: "function",
    name: "setRoundData",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    outputs: [],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const mirrorOracleRegistryAbi = [
  {
    type: "function",
    name: "setOracleParams",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "multiplier", type: "uint256" },
      { name: "paused", type: "bool" },
    ],
    outputs: [],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
