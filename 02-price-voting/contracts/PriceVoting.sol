// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// PriceVoting — token holders lock tokens behind a price to vote on it. While
// voting is open, anyone can vote(price, amount); the contract pulls the tokens
// via transferFrom. After votingEnd, anyone can finalize() once to set the
// winning price, and voters claim() their locked tokens back.
//
// SECURITY NOTE: there is intentionally no way to withdraw locked tokens before
// `votingEnd`. If withdrawals were allowed mid-voting, `priceWeight` (what
// `weightOf` reports) would diverge from `lockedBalance` (what `lockedOf`
// reports): a voter could vote, withdraw, and re-vote with the same tokens,
// inflating several prices at once with one balance, and the leader/finalized
// price would then reflect weight that the contract does not actually hold.
// See SECURITY-NOTE.md in this folder for the full explanation.
contract PriceVoting {
    // Storage. Internal names differ from the constructor parameters `_token`
    // and `_votingEnd` so nothing is shadowed inside the constructor.
    IERC20 private tokenContract;
    uint256 private votingEndTimestamp;
    mapping(uint256 => uint256) private priceWeight; // price => accumulated weight
    mapping(address => uint256) private lockedBalance; // voter => tokens locked
    uint256 private leadingPrice; // current leader; (0, 0) until first vote
    uint256 private leadingWeight; // weight of the current leader
    bool private weightTie; // true when >= 2 prices share the top weight
    uint256 private winningPrice; // set by finalize(); 0 until then
    bool private isFinalized;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 indexed price, uint256 weight);
    event Claimed(address indexed voter, uint256 amount);

    constructor(IERC20 _token, uint256 _votingEnd) {
        tokenContract = _token;
        votingEndTimestamp = _votingEnd;
    }

    // ----- write -----

    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= votingEndTimestamp) revert VotingEnded();
        if (amount == 0) revert ZeroAmount();

        // Effects: record the vote before interacting with the token. If the
        // transfer below reverts, this whole transaction (including these
        // writes) is rolled back, so state stays consistent.
        uint256 newWeight = priceWeight[price] + amount;
        priceWeight[price] = newWeight;
        lockedBalance[msg.sender] += amount;

        if (newWeight > leadingWeight) {
            // Strictly greater: this price takes the lead outright.
            leadingPrice = price;
            leadingWeight = newWeight;
            weightTie = false;
        } else if (newWeight == leadingWeight) {
            // Equal weight from a *different* price (the same price would have
            // grown past this). The leader does not change on a tie, but
            // finalize() must know the top is shared, so flag it.
            weightTie = true;
        }

        // Interaction: pull the locked tokens from the voter. The token is
        // treated as a generic ERC-20: a revert from the token, or a legacy
        // false return, both surface as TransferFailed.
        try tokenContract.transferFrom(msg.sender, address(this), amount) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            revert TransferFailed();
        }

        emit Voted(msg.sender, price, amount);
    }

    function finalize() external {
        if (block.timestamp < votingEndTimestamp) revert VotingActive();
        if (isFinalized) revert AlreadyFinalized();
        isFinalized = true;

        if (!weightTie && leadingWeight > 0) {
            // Unique leader: store the winner and announce it.
            winningPrice = leadingPrice;
            emit PriceFinalized(leadingPrice, leadingWeight);
        } else {
            // No votes cast, or a tie for the top: the price is not changed
            // (winningPrice stays 0) and the event reports "no winner".
            emit PriceFinalized(0, 0);
        }
    }

    function claim() external {
        if (block.timestamp < votingEndTimestamp) revert VotingActive();

        uint256 amount = lockedBalance[msg.sender];
        if (amount == 0) revert NothingToClaim();

        // Zero the balance before the token transfer so a re-entrant claim
        // would see NothingToClaim (checks-effects-interactions).
        lockedBalance[msg.sender] = 0;

        try tokenContract.transfer(msg.sender, amount) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            revert TransferFailed();
        }

        emit Claimed(msg.sender, amount);
    }

    // ----- read -----

    function token() external view returns (IERC20) {
        return tokenContract;
    }

    function votingEnd() external view returns (uint256) {
        return votingEndTimestamp;
    }

    function weightOf(uint256 price) external view returns (uint256) {
        return priceWeight[price];
    }

    function lockedOf(address voter) external view returns (uint256) {
        return lockedBalance[voter];
    }

    function leader() external view returns (uint256 price, uint256 weight) {
        return (leadingPrice, leadingWeight);
    }

    function currentTokenPrice() external view returns (uint256) {
        return winningPrice;
    }

    function finalized() external view returns (bool) {
        return isFinalized;
    }
}
