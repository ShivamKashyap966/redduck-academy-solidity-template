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
///
/// TIE-BREAKING RULE:
/// If two or more candidate prices share the maximum positive weight at the
/// close of voting (or during active voting when checking leader/isTie), a tie
/// is declared. Under this contract's tie-breaking rule, a tie means no single
/// price achieved consensus. Therefore, the winning price resolves to 0
/// (`finalWinningPrice = 0`), and `leader()` returns price 0. If no votes are
/// cast, the winning price is also 0. Only an outright unique highest-weighted
/// price wins.
///
/// BOUNDED ITERATION GUARANTEE:
/// 1. `candidatePrices` is capped by `MAX_CANDIDATE_PRICES` (250). New candidate
///    prices beyond this limit revert with `MaxCandidatePricesReached`, ensuring
///    that `_calculateLeader()` and `finalize()` loops are strictly bounded and
///    can never exceed the block gas limit.
/// 2. `voterPricesList` is capped by `MAX_VOTER_PRICES` (50) per voter and kept
///    compact by pruning positions on full withdrawal. Thus `withdrawAll()` is
///    strictly bounded and safe against DoS.
contract PriceVotingWithdrawal {
    IERC20 private immutable tokenContract;
    uint256 private immutable votingEndTimestamp;

    // Safety bounds against unbounded iteration (SWC-128)
    uint256 public constant MAX_CANDIDATE_PRICES = 250;
    uint256 public constant MAX_VOTER_PRICES = 50;

    // Accounting
    mapping(uint256 => uint256) private priceWeight;
    mapping(address => mapping(uint256 => uint256)) private voterPriceStake;
    mapping(address => uint256) private voterTotalLocked;
    mapping(address => uint256) private voterTotalWithdrawn;

    // Candidate prices tracking (bounded by MAX_CANDIDATE_PRICES)
    uint256[] private candidatePrices;
    mapping(uint256 => bool) private priceSeen;

    // Per-voter prices tracking (bounded by MAX_VOTER_PRICES, compacted on withdrawal)
    mapping(address => uint256[]) private voterPricesList;
    mapping(address => mapping(uint256 => uint256)) private voterPriceIndex; // 1-based index (0 = not present)

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
    error MaxCandidatePricesReached();
    error MaxVoterPricesReached();

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
            if (candidatePrices.length >= MAX_CANDIDATE_PRICES) revert MaxCandidatePricesReached();
            priceSeen[price] = true;
            candidatePrices.push(price);
        }
        if (voterPriceIndex[msg.sender][price] == 0) {
            if (voterPricesList[msg.sender].length >= MAX_VOTER_PRICES) revert MaxVoterPricesReached();
            voterPricesList[msg.sender].push(price);
            voterPriceIndex[msg.sender][price] = voterPricesList[msg.sender].length;
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
        uint256 newStake = userStake - amount;
        voterPriceStake[msg.sender][price] = newStake;
        voterTotalLocked[msg.sender] -= amount;
        voterTotalWithdrawn[msg.sender] += amount;

        // Prune empty position from voterPricesList using swap-and-pop to keep list compact
        if (newStake == 0) {
            uint256 idx = voterPriceIndex[msg.sender][price];
            if (idx > 0) {
                uint256 lastIdx = voterPricesList[msg.sender].length;
                if (idx != lastIdx) {
                    uint256 lastPrice = voterPricesList[msg.sender][lastIdx - 1];
                    voterPricesList[msg.sender][idx - 1] = lastPrice;
                    voterPriceIndex[msg.sender][lastPrice] = idx;
                }
                voterPricesList[msg.sender].pop();
                voterPriceIndex[msg.sender][price] = 0;
            }
        }

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

    /// @notice Withdraw all tokens locked by the caller across an explicit list of prices.
    /// @dev Bounded by caller-supplied calldata array length.
    function withdraw(uint256[] calldata prices) external {
        uint256 total;
        for (uint256 i = 0; i < prices.length; i++) {
            uint256 p = prices[i];
            uint256 stake = voterPriceStake[msg.sender][p];
            if (stake > 0) {
                voterPriceStake[msg.sender][p] = 0;
                total += stake;
                if (block.timestamp < votingEndTimestamp) {
                    priceWeight[p] -= stake;
                }
                emit Withdrawn(msg.sender, p, stake);

                uint256 idx = voterPriceIndex[msg.sender][p];
                if (idx > 0) {
                    uint256 lastIdx = voterPricesList[msg.sender].length;
                    if (idx != lastIdx) {
                        uint256 lastPrice = voterPricesList[msg.sender][lastIdx - 1];
                        voterPricesList[msg.sender][idx - 1] = lastPrice;
                        voterPriceIndex[msg.sender][lastPrice] = idx;
                    }
                    voterPricesList[msg.sender].pop();
                    voterPriceIndex[msg.sender][p] = 0;
                }
            }
        }
        if (total == 0) revert NothingToWithdraw();

        voterTotalLocked[msg.sender] -= total;
        voterTotalWithdrawn[msg.sender] += total;

        try tokenContract.transfer(msg.sender, total) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            revert TransferFailed();
        }

        emit Claimed(msg.sender, total);
    }

    /// @notice Withdraw all tokens locked by the caller across all prices.
    /// @dev Iteration is strictly bounded by MAX_VOTER_PRICES.
    function withdrawAll() public {
        uint256 total = voterTotalLocked[msg.sender];
        if (total == 0) revert NothingToWithdraw();

        uint256[] storage prices = voterPricesList[msg.sender];
        uint256 len = prices.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 p = prices[i];
            uint256 stake = voterPriceStake[msg.sender][p];
            if (stake > 0) {
                voterPriceStake[msg.sender][p] = 0;
                if (block.timestamp < votingEndTimestamp) {
                    priceWeight[p] -= stake;
                }
                emit Withdrawn(msg.sender, p, stake);
            }
            voterPriceIndex[msg.sender][p] = 0;
        }
        delete voterPricesList[msg.sender];

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
    /// @dev Tie-breaking rule: If two or more prices tie for the highest positive weight,
    ///      or if no votes were cast, the winning price is set to 0 (no consensus reached).
    ///      Only an outright unique highest-weighted price wins.
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
    ///      Tie-breaking rule: Sets tie = true if two or more prices share maxWeight > 0.
    ///      Loop is strictly bounded by MAX_CANDIDATE_PRICES (250).
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

    /// @notice Returns the current leading price and its accumulated weight.
    /// @dev Tie-breaking rule: Returns (0, maxWeight) if multiple prices share the top weight.
    function leader() public view returns (uint256 price, uint256 weight) {
        (uint256 bestPrice, uint256 maxWeight, bool tie) = _calculateLeader();
        if (tie) {
            return (0, maxWeight);
        }
        return (bestPrice, maxWeight);
    }

    /// @notice Returns whether there is currently a tie for the top price.
    function isTie() public view returns (bool) {
        (, , bool tie) = _calculateLeader();
        return tie;
    }

    /// @notice Returns the finalized winning token price.
    /// @dev Tie-breaking rule: Returns 0 if not finalized, if tied, or if no votes were cast.
    function currentTokenPrice() external view returns (uint256) {
        return finalWinningPrice;
    }

    /// @notice Returns the finalized winning token price.
    /// @dev Tie-breaking rule: Returns 0 if not finalized, if tied, or if no votes were cast.
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
