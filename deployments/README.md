# Deployments

One JSON record per network, additive: new contracts are appended, nothing is redeployed unless a contract changes.
Each record is built from the Foundry broadcast files under `contracts/broadcast/` (committed; `dry-run/` is not)
and lists addresses, blocks, transaction hashes and the live proofs that were run after the deploy.

| Network | File | State |
| --- | --- | --- |
| Base Sepolia (84532) | `base-sepolia.json` | 3 Oct 2026: calendar, mirror registry, gate, AAPLt/NVDAt/TSLAt B20 test stocks with feeds and SessionGuards, AAPLt/USDC Morpho market (seeded 10 USDC), weekend borrow refusal proven on the live venue |
| Base (8453) | not yet | waits on the mainnet deployer key |

Test-only keys live outside the repo. Never commit a key; never point the Sepolia keys at chain 8453.
