# Task: Merkle airdrop with signature-based claims

Implement an ERC-20 airdrop with two independent claim paths. You decide the cryptographic conventions. The contract and the off-chain code must agree.

## Architecture

`contracts/MerkleAirdrop.sol` is the on-chain contract. It exposes two claim functions and tracks which addresses have already claimed.

`tests/merkle.ts` builds Merkle trees and produces proofs that verify against the contract.

`tests/signatures.ts` produces signatures that the contract accepts.

`contracts/Token.sol` is a generic ERC-20 used as the airdrop token.

The starter files contain function and method stubs. Implement them.

## On-chain behavior

### `claim(uint256 amount, bytes32[] proof)`

The caller is claiming their own allocation. The contract verifies that `(msg.sender, amount)` is included in the Merkle tree committed to by `merkleRoot`, using `proof` as the path from leaf to root.

- If `hasClaimed[msg.sender]` is true, revert `AlreadyClaimed`.
- If the proof does not verify against `merkleRoot`, revert `InvalidProof`.
- On success, set `hasClaimed[msg.sender] = true`, transfer `amount` of `token` to `msg.sender`, and emit `Claimed(msg.sender, amount)`.

### `claimWithSignature(uint256 amount, uint8 v, bytes32 r, bytes32 s)`

The caller presents a signature produced by the trusted `signer` authorizing them to claim `amount`. There is no Merkle proof on this path. The signature is the authorization. This path covers eligibility decided server-side without a fixed list.

- If `hasClaimed[msg.sender]` is true, revert `AlreadyClaimed`.
- If the recovered signer does not equal the stored `signer` address, or is the zero address, revert `InvalidSignature`.
- On success, set `hasClaimed[msg.sender] = true`, transfer `amount` of `token` to `msg.sender`, and emit `Claimed(msg.sender, amount)`.

A signature must authorize a specific recipient. Another caller must not be able to use a signature that was produced for someone else.

A signature must authorize a claim against this specific contract instance. The same signature must not be valid against another deployment of the same contract.

### Shared invariant

`hasClaimed` is shared across both paths. An address that has claimed via either path cannot claim again via either path.

## Off-chain behavior

`tests/merkle.ts` must produce trees, roots, and proofs that verify against `claim`. You choose the leaf hash format, the internal node combination rule, and the odd-layer convention. Whatever you choose must match what the contract recomputes.

`tests/signatures.ts` must produce signatures that `claimWithSignature` accepts when the signing wallet's address equals the `signer` passed to the contract's constructor. You choose the signing scheme.

## Constraints

The contract must not import `MerkleProof`, `ECDSA`, `EIP712`, or any other library that performs Merkle proof verification or signature recovery. Implement these by hand. The contract may import `IERC20` for the token interface.

## Tests

A starter test file is provided with two failing happy-path tests:

- A successful claim via `claim` for an address in the Merkle list.
- A successful claim via `claimWithSignature` for an address authorized by the signer.

Both fail until the contract and the matching off-chain code are implemented. Add tests to that file covering the failure modes.
