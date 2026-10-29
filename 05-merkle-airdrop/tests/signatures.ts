// Signing helper for claimWithSignature. Implement this so the signature it
// produces is accepted by your contract when signed by the `signer` passed to
// the constructor. You choose the signing scheme — it must match what the
// contract recovers and must bind the signature to the specific claimant.

import {
  keccak256,
  encodePacked,
  parseSignature,
  getAddress,
  type WalletClient,
  type Address,
} from "viem";

export interface ClaimSignatureParts {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export async function signAirdropClaim(
  signerWallet: WalletClient,
  claimant: Address,
  amount: bigint,
  contractAddress?: Address,
): Promise<ClaimSignatureParts> {
  const account = signerWallet.account;
  if (!account) throw new Error("No account available on signer wallet");

  const messageHash = contractAddress
    ? keccak256(
        encodePacked(
          ["address", "address", "uint256"],
          [getAddress(contractAddress), getAddress(claimant), amount],
        ),
      )
    : keccak256(encodePacked(["address", "uint256"], [getAddress(claimant), amount]));

  const signature = await signerWallet.signMessage({
    account,
    message: { raw: messageHash },
  });

  const { r, s, v } = parseSignature(signature);
  return { v: Number(v), r, s };
}
