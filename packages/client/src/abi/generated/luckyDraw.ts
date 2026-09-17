// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: contracts/out/LuckyDraw.sol/LuckyDraw.json
// Written by packages/client/scripts/generate.ts. Regenerate with `node scripts/generate.ts` after
// `forge build`; `node scripts/generate.ts --check` fails when this file is stale.

export const luckyDrawAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "vault_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "coordinator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "subscriptionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "keyHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "requestConfirmations",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "callbackGasLimit",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "maxRequestCostNative",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "initialFeeAccount",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "CALLBACK_GAS_LIMIT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "KEY_HASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_PAGE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_REQUEST_COST_NATIVE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_TARGET_USD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "NUM_WORDS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "REQUEST_CONFIRMATIONS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SUBSCRIPTION_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "VAULT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ILuckyVault"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "VRF_COORDINATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IVRFCoordinatorV2_5Views"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addPool",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pricing",
        "type": "tuple",
        "internalType": "struct PricingConfig",
        "components": [
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxPriceAge",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "referenceKind",
            "type": "uint8",
            "internalType": "enum ReferenceKind"
          },
          {
            "name": "minAnswer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "maxAnswer",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buy",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "grossAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minNetContribution",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buysPaused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "claimRefund",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "closeRound",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ensureCurrent",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Kind"
      }
    ],
    "outputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "expireUnrequested",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "feeAccount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getCurrent",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Kind"
      }
    ],
    "outputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPool",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "pool",
        "type": "tuple",
        "internalType": "struct ILuckyDraw.PoolView",
        "components": [
          {
            "name": "id",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "asset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "buysPaused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "nextPricing",
            "type": "tuple",
            "internalType": "struct PricingConfig",
            "components": [
              {
                "name": "feed",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "feedDecimals",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "maxPriceAge",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "referenceKind",
                "type": "uint8",
                "internalType": "enum ReferenceKind"
              },
              {
                "name": "minAnswer",
                "type": "int256",
                "internalType": "int256"
              },
              {
                "name": "maxAnswer",
                "type": "int256",
                "internalType": "int256"
              }
            ]
          },
          {
            "name": "seedAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "targetUsd",
            "type": "uint32[7]",
            "internalType": "uint32[7]"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPools",
    "inputs": [
      {
        "name": "cursor",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "limit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "page",
        "type": "tuple[]",
        "internalType": "struct ILuckyDraw.PoolView[]",
        "components": [
          {
            "name": "id",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "asset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "enabled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "buysPaused",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "nextPricing",
            "type": "tuple",
            "internalType": "struct PricingConfig",
            "components": [
              {
                "name": "feed",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "feedDecimals",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "maxPriceAge",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "referenceKind",
                "type": "uint8",
                "internalType": "enum ReferenceKind"
              },
              {
                "name": "minAnswer",
                "type": "int256",
                "internalType": "int256"
              },
              {
                "name": "maxAnswer",
                "type": "int256",
                "internalType": "int256"
              }
            ]
          },
          {
            "name": "seedAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "targetUsd",
            "type": "uint32[7]",
            "internalType": "uint32[7]"
          }
        ]
      },
      {
        "name": "nextCursor",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPosition",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "gross",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refunded",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "shareNumerator",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "shareDenominator",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRanges",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "cursor",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "limit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "page",
        "type": "tuple[]",
        "internalType": "struct Range[]",
        "components": [
          {
            "name": "buyer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "cumulativeGross",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "nextCursor",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRequest",
    "inputs": [
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRound",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "round",
        "type": "tuple",
        "internalType": "struct ILuckyDraw.RoundView",
        "components": [
          {
            "name": "id",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "poolId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "enum Kind"
          },
          {
            "name": "sequence",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "asset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "pricing",
            "type": "tuple",
            "internalType": "struct PricingConfig",
            "components": [
              {
                "name": "feed",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "feedDecimals",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "maxPriceAge",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "referenceKind",
                "type": "uint8",
                "internalType": "enum ReferenceKind"
              },
              {
                "name": "minAnswer",
                "type": "int256",
                "internalType": "int256"
              },
              {
                "name": "maxAnswer",
                "type": "int256",
                "internalType": "int256"
              }
            ]
          },
          {
            "name": "feeAccount",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "opensAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "closesAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "targetUsd",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "state",
            "type": "uint8",
            "internalType": "enum State"
          },
          {
            "name": "grossTotal",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "feeReserved",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "prizePot",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "playerCount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "seeded",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "seedAccount",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "seedGross",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "closedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "closeReason",
            "type": "uint8",
            "internalType": "enum CloseReason"
          },
          {
            "name": "requestDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "requestId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "requestedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "word0",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "word1",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "winningIndex",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "winner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "settledAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "refundedGross",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refundReason",
            "type": "uint8",
            "internalType": "enum RefundReason"
          },
          {
            "name": "rangeCount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getSeedAccount",
    "inputs": [],
    "outputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingRequests",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteBuy",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "grossAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "quote",
        "type": "tuple",
        "internalType": "struct ILuckyDraw.Quote",
        "components": [
          {
            "name": "reason",
            "type": "uint8",
            "internalType": "enum QuoteReason"
          },
          {
            "name": "observation",
            "type": "tuple",
            "internalType": "struct PriceReader.Observation",
            "components": [
              {
                "name": "roundId",
                "type": "uint80",
                "internalType": "uint80"
              },
              {
                "name": "answer",
                "type": "int256",
                "internalType": "int256"
              },
              {
                "name": "updatedAt",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "minGross",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "feeDelta",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "netDelta",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shareNumeratorBefore",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shareDenominatorBefore",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shareNumeratorAfter",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shareDenominatorAfter",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "usdValueBefore",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "usdValueAfter",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reachesTarget",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "closesAt",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rawFulfillRandomWords",
    "inputs": [
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "randomWords",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "requestDraw",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "roundCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seedRound",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setBuysPaused",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFeeAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setNextPricing",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "pricing",
        "type": "tuple",
        "internalType": "struct PricingConfig",
        "components": [
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxPriceAge",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "referenceKind",
            "type": "uint8",
            "internalType": "enum ReferenceKind"
          },
          {
            "name": "minAnswer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "maxAnswer",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPoolBuysPaused",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPoolEnabled",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "enabled",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSeedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setSeedAmount",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setTargetUsd",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Kind"
      },
      {
        "name": "targetUsd",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settle",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "BuysPausedSet",
    "inputs": [
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "bool",
        "internalType": "bool",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "bool",
        "internalType": "bool",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CallbackIgnored",
    "inputs": [
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "enum CallbackIgnoreReason",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DrawRequested",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "requestedAt",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EntryBought",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "buyer",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "gross",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "feeDelta",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "netDelta",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "cumulativeGross",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "oracleRoundId",
        "type": "uint80",
        "internalType": "uint80",
        "indexed": false
      },
      {
        "name": "priceAnswer",
        "type": "int256",
        "internalType": "int256",
        "indexed": false
      },
      {
        "name": "priceUpdatedAt",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeAccountSet",
    "inputs": [
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "address",
        "internalType": "address",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "NextPricingSet",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "tuple",
        "internalType": "struct PricingConfig",
        "indexed": false,
        "components": [
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxPriceAge",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "referenceKind",
            "type": "uint8",
            "internalType": "enum ReferenceKind"
          },
          {
            "name": "minAnswer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "maxAnswer",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      },
      {
        "name": "newValue",
        "type": "tuple",
        "internalType": "struct PricingConfig",
        "indexed": false,
        "components": [
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxPriceAge",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "referenceKind",
            "type": "uint8",
            "internalType": "enum ReferenceKind"
          },
          {
            "name": "minAnswer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "maxAnswer",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PoolAdded",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "tokenDecimals",
        "type": "uint8",
        "internalType": "uint8",
        "indexed": false
      },
      {
        "name": "pricing",
        "type": "tuple",
        "internalType": "struct PricingConfig",
        "indexed": false,
        "components": [
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxPriceAge",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "referenceKind",
            "type": "uint8",
            "internalType": "enum ReferenceKind"
          },
          {
            "name": "minAnswer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "maxAnswer",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      },
      {
        "name": "seedAmount",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "targetUsd",
        "type": "uint32[7]",
        "internalType": "uint32[7]",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PoolBuysPausedSet",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "bool",
        "internalType": "bool",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "bool",
        "internalType": "bool",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PoolEnabledSet",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "bool",
        "internalType": "bool",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "bool",
        "internalType": "bool",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RandomnessReceived",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "word0",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "word1",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Refunded",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "gross",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundClosed",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "state",
        "type": "uint8",
        "internalType": "enum State",
        "indexed": false
      },
      {
        "name": "closeReason",
        "type": "uint8",
        "internalType": "enum CloseReason",
        "indexed": false
      },
      {
        "name": "closedAt",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      },
      {
        "name": "requestDeadline",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      },
      {
        "name": "grossTotal",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "prizePot",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "feeReserved",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "playerCount",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundOpened",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Kind",
        "indexed": false
      },
      {
        "name": "sequence",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "tokenDecimals",
        "type": "uint8",
        "internalType": "uint8",
        "indexed": false
      },
      {
        "name": "opensAt",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      },
      {
        "name": "closesAt",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      },
      {
        "name": "targetUsd",
        "type": "uint32",
        "internalType": "uint32",
        "indexed": false
      },
      {
        "name": "feeAccount",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "pricing",
        "type": "tuple",
        "internalType": "struct PricingConfig",
        "indexed": false,
        "components": [
          {
            "name": "feed",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "feedDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "maxPriceAge",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "referenceKind",
            "type": "uint8",
            "internalType": "enum ReferenceKind"
          },
          {
            "name": "minAnswer",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "maxAnswer",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundRefunding",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "enum RefundReason",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundSettled",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "winner",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "winningIndex",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "prize",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "fee",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "feeAccount",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "settledAt",
        "type": "uint64",
        "internalType": "uint64",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeedAccountSet",
    "inputs": [
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "address",
        "internalType": "address",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeedAmountSet",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeedEntered",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "seedAccount",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "gross",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "feeDelta",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "netDelta",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "cumulativeGross",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeedSkipped",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "enum SeedSkipReason",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TargetUsdSet",
    "inputs": [
      {
        "name": "poolId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "enum Kind",
        "indexed": false
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      },
      {
        "name": "oldValue",
        "type": "uint32",
        "internalType": "uint32",
        "indexed": false
      },
      {
        "name": "newValue",
        "type": "uint32",
        "internalType": "uint32",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyClaimed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyListed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadySeeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMinimum",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BuysPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DeadlineExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EntryWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientSeedBalance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidAsset",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidId",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidKind",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRecipient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRequestId",
    "inputs": []
  },
  {
    "type": "error",
    "name": "KeyHashUnsupported",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NetContributionTooLow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "PoolDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceDecimalsChanged",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceInvalid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceStale",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PriceUnavailable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RequestWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RequestWindowStillOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundNotClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeedAccountCannotBuy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeedNotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeedNotConfigured",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SubscriptionUnderfunded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongState",
    "inputs": []
  }
] as const;
