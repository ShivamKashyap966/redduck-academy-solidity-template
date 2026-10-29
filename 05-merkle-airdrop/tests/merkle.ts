// Merkle tree utilities for the airdrop. Implement these so the roots and proofs
// you produce verify against your contract's claim() / _verify(). You choose the
// leaf hash format, the node-combination rule, and the odd-layer convention —
// whatever you pick must match what the contract recomputes.

import { keccak256, encodePacked, concat, getAddress, type Address, type Hex } from "viem";

export interface AirdropEntry {
  account: Address;
  amount: bigint;
}

// Hash one airdrop entry into a leaf.
export function hashLeaf(entry: AirdropEntry): Hex {
  return keccak256(encodePacked(["address", "uint256"], [getAddress(entry.account), entry.amount]));
}

function combineNodes(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export class MerkleTree {
  layers: Hex[][];

  constructor(entries: AirdropEntry[]) {
    if (entries.length === 0) {
      this.layers = [[]];
      return;
    }

    let current = entries.map(hashLeaf);
    this.layers = [current];

    while (current.length > 1) {
      const next: Hex[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(combineNodes(current[i], current[i + 1]));
        } else {
          next.push(current[i]);
        }
      }
      current = next;
      this.layers.push(current);
    }
  }

  get root(): Hex {
    if (this.layers.length === 0 || this.layers[this.layers.length - 1].length === 0) {
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }
    return this.layers[this.layers.length - 1][0];
  }

  // The sibling hashes from the leaf at `index` up to the root.
  getProof(index: number): Hex[] {
    const proof: Hex[] = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;
      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }
}
