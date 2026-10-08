// Generated 8 Oct 2026 by apps/indexer/scripts/seize-history.py (full-history eth_getLogs scan of the ten priced Coinbase
// stocks, from just before their creation to the head, 1,000-block windows on Tenderly's public gateway; live hasRole and
// policyId reads at the head through Alchemy). The indexer's own mainnet sources start at block 52,198,000; this baseline
// covers everything before and including that, so the seize watch answers for the tokens' whole life.
export const SEIZE_BASELINE = {
  "scannedFrom": 49145000,
  "scannedTo": 52327100,
  "scannedToTime": 1791443547,
  "windows": 3183,
  "governanceLogs": 187,
  "tokens": [
    {
      "symbol": "AAPLc",
      "token": "0xb200000000000000000000C2e324d24d7eEcd1fb",
      "createdAtBlock": 49145246,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216682,
          "time": 1791222711,
          "tx": "0xc826f2327c4bbf7d75964fcbfbd07eed1df866d0cf4f4ea342dc63869ce4f53b"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "AMZNc",
      "token": "0xb200000000000000000000d9192b6B456483C2E8",
      "createdAtBlock": 49145336,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216526,
          "time": 1791222399,
          "tx": "0x6ba4723458f526612fa98e46ceb5b6dbf9c3e3dcf4806dff09cac925cffbfa3a"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "GOOGLc",
      "token": "0xb2000000000000000000002D0BA3164cc74f58B7",
      "createdAtBlock": 49145218,
      "roleAccounts": 6,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216791,
          "time": 1791222929,
          "tx": "0x4cedc1356f20a578a607f87780e26f50823a4d146cda98abda20a11e05ec3fa3"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "METAc",
      "token": "0xb2000000000000000000008bC8786B856E61707C",
      "createdAtBlock": 49145181,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216294,
          "time": 1791221935,
          "tx": "0x8100e2a6968723cf75cebd31055c1acaa2aac81fbd953835215be09f935c98ed"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "MSFTc",
      "token": "0xB200000000000000000000Ab99cFa739E253872B",
      "createdAtBlock": 49145298,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216588,
          "time": 1791222523,
          "tx": "0x285818e213f471703d697cc5a7cd559fe759cc2696504b85f967deff4d0be32e"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "MSTRc",
      "token": "0xb2000000000000000000004884b426556b92883d",
      "createdAtBlock": 49145205,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216700,
          "time": 1791222747,
          "tx": "0x7742cbf78b140e1aeda8db4343bcf5ce84ad234973211a45bc205b6337545c10"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "NVDAc",
      "token": "0xb20000000000000000000078ee7ce2fE4908108C",
      "createdAtBlock": 49145311,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216578,
          "time": 1791222503,
          "tx": "0xd003a8b9414bfb265cec1a11eb3e0db1e75fff8480cd2a317184befcfa13da86"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "SNDKc",
      "token": "0xb200000000000000000000397293Cb8cda9a10c5",
      "createdAtBlock": 49145192,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216942,
          "time": 1791223231,
          "tx": "0xec8e0a2fb3b994ec57e26eab81b46e64a093c699e83cf2c573b442cb3d7e1815"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "SPCXc",
      "token": "0xb2000000000000000000007b9fcbd005511aCBd5",
      "createdAtBlock": 49145277,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216656,
          "time": 1791222659,
          "tx": "0x046a8c0284d86e5306bdad34df5b3979c6799e7f28bc40b4b1b9f6d3f3ee85e6"
        }
      ],
      "seizeReceiverUpdates": []
    },
    {
      "symbol": "TSLAc",
      "token": "0xb2000000000000000000001e800a7f5189430cD0",
      "createdAtBlock": 49145287,
      "roleAccounts": 5,
      "seizeRoleGrants": 0,
      "seized": 0,
      "seizeExemptUpdates": [
        {
          "old": 0,
          "new": 129,
          "block": 52216375,
          "time": 1791222097,
          "tx": "0x5394c116c9f97e2cec78cb98dbe4086f4b673371b5ef79fced061adf7607d29d"
        }
      ],
      "seizeReceiverUpdates": []
    }
  ],
  "policy129Blocklist": [
    {
      "blocked": true,
      "block": 52216975,
      "time": 1791223297,
      "accounts": [
        "0x3f81c5d9378eaeb5051ea0d6cace7e146daef098",
        "0x35b9ba29c272e9dfd56c8eaa6244e3e7df690564"
      ],
      "tx": "0x22b3fd7a6e73310c98b5393406ee33dadbb2c62f593d0c7248c11d0c7e669a89"
    },
    {
      "blocked": false,
      "block": 52217211,
      "time": 1791223769,
      "accounts": [
        "0x3f81c5d9378eaeb5051ea0d6cace7e146daef098",
        "0x35b9ba29c272e9dfd56c8eaa6244e3e7df690564"
      ],
      "tx": "0x4bdbcd3eae4cf79cba73023d2c584e9bbc9f009edfd14c5597bc35a1aa3ebd87"
    }
  ]
} as const;
