import type { Log } from "viem";

// Simulating confirmed logs (pending = false)
const confirmedLog: Log<bigint, number, false> = {
  address: "0x1234" as any,
  blockHash: "0x5678" as any,
  blockNumber: 100n, // Should be bigint, NOT null | bigint
  data: "0xabcd" as any,
  logIndex: 5, // Should be number, NOT null | number
  transactionHash: "0x9999" as any, // Should be Hex, NOT null | Hex
  transactionIndex: 10,
  removed: false,
};

// Try to assign undefined - should this be a type error?
const withUndefined: Log<bigint, number, false> = {
  address: "0x1234" as any,
  blockHash: "0x5678" as any,
  blockNumber: undefined as any, // intentional type error to check
  data: "0xabcd" as any,
  logIndex: undefined as any,
  transactionHash: undefined as any,
  transactionIndex: 10,
  removed: false,
};
