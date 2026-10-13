# Deployments

One JSON record per network, additive: new contracts are appended, nothing is redeployed unless a contract changes.
Each record is built from the Foundry broadcast files under `contracts/broadcast/` (committed; `dry-run/` is not)
and lists addresses, blocks, transaction hashes and the live proofs that were run after the deploy.

| Network | File | State |
| --- | --- | --- |
| Base Sepolia (84532) | `base-sepolia.json` | 3 Oct 2026: calendar, mirror registry, gate, AAPLt/NVDAt/TSLAt B20 test stocks with feeds and SessionGuards, AAPLt/USDC Morpho market (seeded 10 USDC), weekend borrow refusal proven on the live venue |
| Base (8453) | `base-mainnet.json` | 13 Oct 2026 (blocks 52,530,874–52,530,925, 50 transactions, 0.00031127 ETH): `contracts/script/deploy-mainnet.sh broadcast` from a fresh deployer; calendar, gate, SessionGuards and ShadowGuards on AAPLc and NVDAc, the session-safe AAPLc/USDC Morpho market (unseeded), the desk, the Protector, pre-liquidations on the Steakhouse AAPLc and NVDAc markets and the session-safe one, the Aave desk, both protection vaults, the Reserve, the payout router and the harvester; 16 contracts verified on Basescan; `deploy-mainnet.sh check` 33 of 33 against mainnet. The deployer owns everything (no `FINAL_OWNER`); the keeper address holds the keeper role and no ETH |

Test-only keys live outside the repo. Never commit a key; never point the Sepolia keys at chain 8453.
