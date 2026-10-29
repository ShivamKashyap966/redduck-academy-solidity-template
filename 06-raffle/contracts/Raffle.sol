// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

/// @title Chainlink VRF and Price Feed Weighted Raffle
/// @notice Players deposit an ERC-20 token; each deposit is weighted by its USD valuation
///         at entry time. After drawTime, Chainlink VRF selects a winner proportionally.
contract Raffle is VRFConsumerBaseV2Plus {
    struct Entry {
        address player;
        uint256 amount;
        uint256 weight;
        uint256 cumulativeWeight;
    }

    IERC20 public immutable token;
    AggregatorV3Interface public immutable priceFeed;
    uint256 public immutable drawTime;

    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32 public immutable callbackGasLimit;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant NUM_WORDS = 1;

    uint256 public constant MAX_PRICE_AGE = 1 hours;

    uint256 public totalWeight;
    uint256 public totalDeposited;
    uint256 public requestId;
    uint256 public randomWord;
    address public winner;

    bool public drawRequested;
    bool public randomnessFulfilled;
    bool public isClaimed;

    Entry[] private entries;

    error RaffleClosed();
    error DrawAlreadyRequested();
    error DrawNotRequested();
    error RandomnessNotFulfilled();
    error NoDeposits();
    error ZeroAmount();
    error InvalidPrice();
    error StalePrice();
    error InvalidClaim();
    error AlreadyClaimed();
    error InvalidRequestId();

    event Deposited(address indexed who, uint256 amount, uint256 weight);
    event DrawRequested(uint256 requestId);
    event WinnerPicked(address indexed winner);
    event Claimed(address indexed winner, uint256 amount);

    constructor(
        IERC20 _token,
        AggregatorV3Interface _priceFeed,
        uint256 _drawTime,
        address _coordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit
    ) VRFConsumerBaseV2Plus(_coordinator) {
        token = _token;
        priceFeed = _priceFeed;
        drawTime = _drawTime;
        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
    }

    /// @notice Join the raffle by depositing tokens while it is open.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= drawTime) revert RaffleClosed();
        if (drawRequested) revert RaffleClosed();

        (uint80 roundId, int256 price, , uint256 updatedAt, uint80 answeredInRound) = priceFeed.latestRoundData();

        if (price <= 0) revert InvalidPrice();
        if (updatedAt == 0 || answeredInRound < roundId) revert InvalidPrice();
        if (block.timestamp > updatedAt && block.timestamp - updatedAt > MAX_PRICE_AGE) {
            revert StalePrice();
        }

        uint8 feedDecimals = priceFeed.decimals();
        uint256 weight = _calculateUSDWeight(amount, uint256(price), feedDecimals);
        if (weight == 0) revert ZeroAmount();

        totalWeight += weight;
        totalDeposited += amount;
        entries.push(Entry({player: msg.sender, amount: amount, weight: weight, cumulativeWeight: totalWeight}));

        token.transferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount, weight);
    }

    /// @notice Request randomness from Chainlink VRF to pick the winner.
    function drawWinner() external returns (uint256) {
        if (block.timestamp < drawTime) revert RaffleClosed();
        if (entries.length == 0) revert NoDeposits();
        if (drawRequested) revert DrawAlreadyRequested();

        drawRequested = true;

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
            })
        );

        emit DrawRequested(requestId);
        return requestId;
    }

    /// @notice Chainlink VRF callback that delivers the random word.
    function fulfillRandomWords(uint256 _requestId, uint256[] calldata randomWords) internal override {
        if (_requestId != requestId) revert InvalidRequestId();
        randomWord = randomWords[0];
        randomnessFulfilled = true;
    }

    /// @notice Winner claims the entire prize pool by verifying their winning entry index.
    function claim(uint256 entryIndex) external {
        if (!randomnessFulfilled) revert InvalidClaim();
        if (isClaimed) revert InvalidClaim();
        if (entryIndex >= entries.length) revert InvalidClaim();

        Entry memory entry = entries[entryIndex];
        if (entry.player != msg.sender) revert InvalidClaim();

        uint256 winningPoint = randomWord % totalWeight;

        if (entryIndex == 0) {
            if (winningPoint >= entry.cumulativeWeight) revert InvalidClaim();
        } else {
            uint256 previousCumulative = entries[entryIndex - 1].cumulativeWeight;
            if (winningPoint < previousCumulative || winningPoint >= entry.cumulativeWeight) {
                revert InvalidClaim();
            }
        }

        isClaimed = true;
        winner = msg.sender;

        uint256 prize = token.balanceOf(address(this));
        token.transfer(msg.sender, prize);

        emit WinnerPicked(msg.sender);
        emit Claimed(msg.sender, prize);
    }

    /// @dev Computes USD weight normalized to 18 decimals from deposit amount and oracle price.
    function _calculateUSDWeight(uint256 amount, uint256 price, uint8 feedDecimals) internal view returns (uint256) {
        uint8 tokenDecimals = 18;
        try IERC20Metadata(address(token)).decimals() returns (uint8 d) {
            tokenDecimals = d;
        } catch {}

        if (tokenDecimals <= 18) {
            return (amount * price * (10 ** (18 - tokenDecimals))) / (10 ** feedDecimals);
        } else {
            return (amount * price) / (10 ** (feedDecimals + tokenDecimals - 18));
        }
    }

    function entriesCount() external view returns (uint256) {
        return entries.length;
    }

    function getEntry(
        uint256 index
    ) external view returns (address player, uint256 amount, uint256 weight, uint256 cumulativeWeight) {
        if (index >= entries.length) revert InvalidClaim();
        Entry memory e = entries[index];
        return (e.player, e.amount, e.weight, e.cumulativeWeight);
    }

    function totalDeposits() external view returns (uint256) {
        return totalDeposited;
    }

    function totalTokens() external view returns (uint256) {
        return totalDeposited;
    }

    function getWinner() external view returns (address) {
        return winner;
    }
}
