# Task: PriceVoting contract

Build a smart contract that lets token holders vote on a new price for their token. Write a test suite that verifies the contract behaves correctly.

## What you're using

The ERC-20 token from your previous capstone task. Copy the contract file into `contracts/Token.sol` of your Hardhat project. You don't need to modify it. The voting contract will treat it as a generic ERC-20 and interact through the standard interface.

## The voting flow

1. The contract is deployed with a reference to the token and a voting end timestamp.
2. While the voting period is active, anyone who holds the token can call `vote(price, amount)`. The contract pulls `amount` tokens from the voter via `transferFrom` and records the vote.
3. A voter can call `vote` as many times as they want during the period. They can vote for the same price multiple times, which stacks their weight on that price, or for different prices, which splits their stake across the prices they chose.
4. After the voting period ends, anyone can call `finalize()` once. This sets `currentTokenPrice` to whichever price accumulated the most weight and emits a `PriceFinalized` event.
5. After the voting period ends, voters call `claim()` to receive back all the tokens they locked during voting.

## Required interface

Your contract must expose at least the following. The student designs the internal storage layout. The public interface is what tests will call.

```solidity
// Read functions
function token() external view returns (IERC20);
function votingEnd() external view returns (uint256);
function weightOf(uint256 price) external view returns (uint256);
function lockedOf(address voter) external view returns (uint256);
function leader() external view returns (uint256 price, uint256 weight);
function currentTokenPrice() external view returns (uint256);
function finalized() external view returns (bool);

// Write functions
function vote(uint256 price, uint256 amount) external;
function finalize() external;
function claim() external;

// Events
event Voted(address indexed voter, uint256 indexed price, uint256 amount);
event PriceFinalized(uint256 indexed price, uint256 weight);
event Claimed(address indexed voter, uint256 amount);

// Custom errors
error VotingEnded();
error VotingActive();
error AlreadyFinalized();
error ZeroAmount();
error NothingToClaim();
error TransferFailed();
```

You may add more state variables or events if you find them useful. The fields above are the minimum.

## Edge cases

If `finalize()` is called and no votes were cast or there is a tie, the price should not be changed.

## Testing requirements

Write a test file `test/PriceVoting.ts` covering these scenarios. Some starter tests are provided. You'll add the rest.

### Scenarios you must cover

1. A single vote sets the leading price and weight correctly.
2. Two voters voting for the same price stack the weight on that price.
3. Two voters voting for different prices: the one with more total weight wins.
4. A single voter calling `vote` twice for different prices: their lockedBalance grows correctly, each price has the right weight.
5. The leading price updates correctly when a new vote pushes a different price above the current leader.
6. The leading price does NOT update on a tie.
7. `vote` reverts when called after `votingEnd`.
8. `vote` reverts when called with `amount == 0`.
9. `vote` reverts when the voter has not approved the contract for enough tokens.
10. `finalize` reverts when called before `votingEnd`.
11. `finalize` reverts when called twice.
12. `finalize` correctly sets `currentTokenPrice` and `finalized` and emits `PriceFinalized`.
13. `finalize` with no votes succeeds and `currentTokenPrice` stays at 0.
14. `finalize` with a tie succeeds and `currentTokenPrice` stays at 0.
15. `claim` reverts when called before `votingEnd`.
16. `claim` reverts when the caller has nothing locked.
17. `claim` returns the correct amount and zeros out the voter's locked balance.
18. A voter cannot claim twice.

## Out of scope

Don't worry about these for this task:

- Mid-voting withdrawal. You cannot withdraw while voting is active. That's deliberate. We'll explore why in a later lesson.
- Quorum requirements. Any vote count is valid.
- Minimum vote sizes beyond `> 0`
- Multiple voting rounds. One round per deployed contract.
- Gas optimization

## Reflection

After your contract and tests pass, take 5 minutes to write a short note, either in a markdown file or as comments at the top of your contract, answering: **what would break if voters could withdraw their locked tokens DURING the voting period, before `votingEnd`?** Be specific about which state variable would go wrong and why. This question sets up the next lesson, which is about solving exactly this problem.
