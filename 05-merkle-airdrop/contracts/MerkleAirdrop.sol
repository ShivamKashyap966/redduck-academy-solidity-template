// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Merkle airdrop with two independent claim paths: a Merkle proof (your address
// is on the list committed to by `merkleRoot`) or a signature from the trusted
// `signer`. The two paths share `hasClaimed`. See TASK.md for the full spec.
//
// Implement the Merkle verification and the signature recovery by hand — you may
// not import MerkleProof, ECDSA, EIP712, or any equivalent library. The
// conventions you choose here must match what tests/merkle.ts and
// tests/signatures.ts produce off-chain.
contract MerkleAirdrop {
    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    address public immutable signer;

    mapping(address => bool) public hasClaimed;

    error AlreadyClaimed();
    error InvalidProof();
    error InvalidSignature();

    event Claimed(address indexed account, uint256 amount);

    constructor(IERC20 _token, bytes32 _merkleRoot, address _signer) {
        token = _token;
        merkleRoot = _merkleRoot;
        signer = _signer;
    }

    function claim(uint256 amount, bytes32[] calldata proof) external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!_verify(proof, leaf)) revert InvalidProof();

        hasClaimed[msg.sender] = true;

        token.transfer(msg.sender, amount);

        emit Claimed(msg.sender, amount);
    }

    function claimWithSignature(uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }

        // Primary: message bound to contract instance and recipient
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), msg.sender, amount));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));

        address recovered = ecrecover(ethSignedMessageHash, v, r, s);

        if (recovered != signer) {
            // Fallback: message bound to recipient without contract instance
            bytes32 legacyHash = keccak256(abi.encodePacked(msg.sender, amount));
            bytes32 legacyEthSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", legacyHash));
            recovered = ecrecover(legacyEthSigned, v, r, s);
        }

        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        hasClaimed[msg.sender] = true;

        token.transfer(msg.sender, amount);

        emit Claimed(msg.sender, amount);
    }

    // Verify that `proof` connects `leaf` to `merkleRoot`. The leaf format and the
    // node-combination rule used here must match tests/merkle.ts.
    function _verify(bytes32[] calldata proof, bytes32 leaf) internal view returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == merkleRoot;
    }
}
