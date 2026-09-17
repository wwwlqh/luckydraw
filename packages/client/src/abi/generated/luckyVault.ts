// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: contracts/out/LuckyVault.sol/LuckyVault.json
// Written by packages/client/scripts/generate.ts. Regenerate with `node scripts/generate.ts` after
// `forge build`; `node scripts/generate.ts --check` fails when this file is stale.

export const luckyVaultAbi = [
  {
    "type": "constructor",
    "inputs": [
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
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "authorizeSeed",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "maxPerRound",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "balanceOf",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "closeEscrow",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
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
    "name": "depositNative",
    "inputs": [],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "depositsPaused",
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
    "name": "draw",
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
    "name": "getAsset",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct ILuckyVault.AssetRecord",
        "components": [
          {
            "name": "listed",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "tokenDecimals",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "depositsEnabled",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getEscrow",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct ILuckyVault.Escrow",
        "components": [
          {
            "name": "asset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "closesAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "registered",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "closed",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "released",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "listAsset",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "tokenDecimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "lock",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "buyer",
        "type": "address",
        "internalType": "address"
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
    "name": "lockSeed",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
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
    "name": "lockedBy",
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
    "name": "refundedTo",
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
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registerRound",
    "inputs": [
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
        "name": "closesAt",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "release",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "enum ReleaseReason"
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
    "name": "seedLocked",
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
    "outputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seedMaxPerRound",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "maxPerRound",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setDepositsEnabled",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
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
    "name": "setDepositsPaused",
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
    "name": "setDraw",
    "inputs": [
      {
        "name": "draw_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "totalAvailable",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalEscrow",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "total",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
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
    "type": "function",
    "name": "withdraw",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
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
    "type": "event",
    "name": "AssetListed",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "tokenDecimals",
        "type": "uint8",
        "internalType": "uint8",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DepositsEnabledSet",
    "inputs": [
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
    "name": "DepositsPausedSet",
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
    "name": "DrawBound",
    "inputs": [
      {
        "name": "draw",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "actor",
        "type": "address",
        "internalType": "address",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FundsLocked",
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
        "name": "asset",
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
    "name": "FundsReleased",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "reason",
        "type": "uint8",
        "internalType": "enum ReleaseReason",
        "indexed": false
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
    "name": "RoundEscrowClosed",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundRegistered",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeedAuthorized",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "oldMaxPerRound",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      },
      {
        "name": "newMaxPerRound",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "internalType": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyBound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyListed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DepositsDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DepositsPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EntryWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EscrowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientBalance",
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
    "name": "InvalidRecipient",
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
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RefundExceedsLocked",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SeedAccountCannotBuy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeedAlreadyLocked",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeedCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeedNotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferMismatch",
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
