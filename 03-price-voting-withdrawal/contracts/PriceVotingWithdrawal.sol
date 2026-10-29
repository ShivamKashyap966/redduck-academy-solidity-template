// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title PriceVotingWithdrawal
/// @notice A token price governance contract allowing voters to lock ERC-20
///         tokens behind candidate prices, with the ability to withdraw their
///         locked tokens at any time (including during the voting period).
///
/// DESIGN & LEADER RESOLUTION STRATEGY:
/// In 02-price-voting, votes were monotonic (weights only increased), so tracking
/// only `leadingPrice` and `leadingWeight` in storage was sufficient. With
/// withdrawals, a leader's weight can decrease, requiring the contract to know
/// which other candidate price takes the lead (or whether a tie was created).
///
/// Our strategy stores an enumerable list of candidate prices (`candidatePrices`)
/// and maps active weights in `priceWeight`. During the voting period, withdrawals
/// decrement `priceWeight[price]`, and `_calculateLeader()` dynamically determines
/// the highest-weighted price and tie status. After `votingEnd`, the election
/// tally is locked: voters can still withdraw their principal tokens, but the
/// vote tally remains preserved for finalization.
contract PriceVotingWithdrawal {
    IERC20 private immutable tokenContract;
    uint256 private immutable votingEndTimestamp;

    // Accounting
    mapping(uint256 => uint256) private priceWeight;
    mapping(address => mapping(uint256 => uint256)) private voterPriceStake;
    mapping(address => uint256) private voterTotalLocked;
    mapping(address => uint256) private voterTotalWithdrawn;

    // Candidate prices tracking
    uint256[] private candidatePrices;
    mapping(uint256 => bool) private priceSeen;

    // Per-voter prices tracking for batch operations
    mapping(address => uint256[]) private voterPricesList;
    mapping(address => mapping(uint256 => bool)) private voterPriceSeen;

    // Settlement state
    uint256 private finalWinningPrice;
    bool private isFinalized;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error InsufficientLockedBalance();
    error NothingToWithdraw();
    error NothingToClaim();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event Withdrawn(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 indexed price, uint256 weight);
    event Claimed(address indexed voter, uint256 amount);

    constructor(IERC20 _token, uint256 _votingEnd) {
        tokenContract = _token;
        votingEndTimestamp = _votingEnd;
    }

    // ----- write -----

    /// @notice Cast a vote for `price` by locking `amount` tokens.
    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= votingEndTimestamp) revert VotingEnded();
        if (amount == 0) revert ZeroAmount();

        // Effects
        priceWeight[price] += amount;
        voterPriceStake[msg.sender][price] += amount;
        voterTotalLocked[msg.sender] += amount;

        if (!priceSeen[price]) {
            priceSeen[price] = true;
            candidatePrices.push(price);
        }
        if (!voterPriceSeen[msg.sender][price]) {
            voterPriceSeen[msg.sender][price] = true;
            voterPricesList[msg.sender].push(price);
        }

        // Interaction
        try tokenContract.transferFrom(msg.sender, address(this), amount) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            revert TransferFailed();
        }

        emit Voted(msg.sender, price, amount);
    }

    /// @notice Withdraw `amount` tokens previously locked behind `price`.
    function withdraw(uint256 price, uint256 amount) public {
        if (amount == 0) revert ZeroAmount();

        uint256 userStake = voterPriceStake[msg.sender][price];
        if (amount > userStake) revert InsufficientLockedBalance();

        // Effects
        voterPriceStake[msg.sender][price] = userStake - amount;
        voterTotalLocked[msg.sender] -= amount;
        voterTotalWithdrawn[msg.sender] += amount;

        // If withdrawn during active voting, remove the vote weight.
        // If withdrawn after voting ended, the election tally is already frozen.
        if (block.timestamp < votingEndTimestamp) {
            priceWeight[price] -= amount;
        }

        // Interaction
        try tokenContract.transfer(msg.sender, amount) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            revert TransferFailed();
        }

        emit Withdrawn(msg.sender, price, amount);
    }

    /// @notice Withdraw all tokens locked by the caller behind a specific `price`.
    function withdraw(uint256 price) external {
        uint256 userStake = voterPriceStake[msg.sender][price];
        if (userStake == 0) revert InsufficientLockedBalance();
        withdraw(price, userStake);
    }

    /// @notice Withdraw all tokens locked by the caller across all prices.
    function withdrawAll() public {
        uint256 total = voterTotalLocked[msg.sender];
        if (total == 0) revert NothingToWithdraw();

        uint256[] storage prices = voterPricesList[msg.sender];
        for (uint256 i = 0; i < prices.length; i++) {
            uint256 p = prices[i];
            uint256 stake = voterPriceStake[msg.sender][p];
            if (stake > 0) {
                voterPriceStake[msg.sender][p] = 0;
                if (block.timestamp < votingEndTimestamp) {
                    priceWeight[p] -= stake;
                }
                emit Withdrawn(msg.sender, p, stake);
            }
        }
        voterTotalLocked[msg.sender] = 0;
        voterTotalWithdrawn[msg.sender] += total;

        try tokenContract.transfer(msg.sender, total) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            revert TransferFailed();
        }

        emit Claimed(msg.sender, total);
    }

    /// @notice Alias for `withdrawAll()` to maintain interface symmetry.
    function claim() external {
        if (voterTotalLocked[msg.sender] == 0) revert NothingToClaim();
        withdrawAll();
    }

    /// @notice Finalize the election after voting ends and set the winning price.
    function finalize() external {
        if (block.timestamp < votingEndTimestamp) revert VotingActive();
        if (isFinalized) revert AlreadyFinalized();
        isFinalized = true;

        (uint256 bestPrice, uint256 maxWeight, bool tie) = _calculateLeader();
        if (!tie && maxWeight > 0) {
            finalWinningPrice = bestPrice;
            emit PriceFinalized(bestPrice, maxWeight);
        } else {
            finalWinningPrice = 0;
            emit PriceFinalized(0, 0);
        }
    }

    // ----- read / view -----

    /// @dev Internal helper to determine the leading price, weight, and tie status.
    function _calculateLeader() internal view returns (uint256 bestPrice, uint256 maxWeight, bool tie) {
        uint256 len = candidatePrices.length;
        if (len == 0) {
            return (0, 0, false);
        }

        for (uint256 i = 0; i < len; i++) {
            uint256 p = candidatePrices[i];
            uint256 w = priceWeight[p];
            if (w > maxWeight) {
                maxWeight = w;
                bestPrice = p;
                tie = false;
            } else if (w == maxWeight && w > 0) {
                tie = true;
            }
        }
        return (bestPrice, maxWeight, tie);
    }

    function leader() public view returns (uint256 price, uint256 weight) {
        (uint256 bestPrice, uint256 maxWeight, bool tie) = _calculateLeader();
        if (tie) {
            return (0, maxWeight);
        }
        return (bestPrice, maxWeight);
    }

    function isTie() public view returns (bool) {
        (, , bool tie) = _calculateLeader();
        return tie;
    }

    function currentTokenPrice() external view returns (uint256) {
        return finalWinningPrice;
    }

    function winningPrice() external view returns (uint256) {
        return finalWinningPrice;
    }

    function finalized() external view returns (bool) {
        return isFinalized;
    }

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
        return voterTotalLocked[voter];
    }

    function lockedOf(address voter, uint256 price) external view returns (uint256) {
        return voterPriceStake[voter][price];
    }

    function withdrawnOf(address voter) external view returns (uint256) {
        return voterTotalWithdrawn[voter];
    }

    function candidatePricesList() external view returns (uint256[] memory) {
        return candidatePrices;
    }

    function candidatePricesCount() external view returns (uint256) {
        return candidatePrices.length;
    }
}
