# Reflection: Handling Withdrawal-Induced Leader Changes

This document addresses the reflection prompt for `03-price-voting-withdrawal`:

1. **What implementation strategy did you pick for handling withdrawal-induced leader changes, and why?**
2. **What would go wrong with the simpler pattern from the previous task in your design?**

---

## 1. What would go wrong with the simpler pattern from the previous task

In `02-price-voting`, locked tokens could not be withdrawn mid-voting. Because of that restriction:

- Every vote operation strictly incremented a price's accumulated weight (`priceWeight[price] += amount`).
- Weights were monotonically increasing.
- Under monotonic growth, the contract only needed to keep track of a single `leadingPrice` and `leadingWeight`. Whenever a price received new votes pushing its total strictly above `leadingWeight`, that price took the lead.
- The contract never needed to remember the runner-up (2nd place) or any historical ranking because a price's weight could never decrease.

### Why this breaks once mid-voting withdrawals are introduced:

When voters can withdraw their locked tokens during the voting period:

- Voting weight can decrease (`priceWeight[price] -= amount`).
- If the current leader experiences a withdrawal, its weight drops.
- **Under the simple two-variable pattern (`leadingPrice`, `leadingWeight`), the contract cannot know which candidate price becomes the new leader.** The identity and weight of the second-highest (or third-highest) candidate price are completely lost.
- Furthermore, a withdrawal could cause the leader's weight to drop exactly to the weight of another candidate price, creating a tie, or drop below multiple other prices. A single leader storage variable cannot recover the true state of the election without inspecting other candidates.

---

## 2. The implementation strategy chosen and why

To handle dynamic weight increases and decreases cleanly, our contract implements the following architecture:

### A. Candidate Price Enumeration & Mapping

- We record each unique price that receives a vote in an enumerable array: `uint256[] private candidatePrices`.
- A lookup mapping `mapping(uint256 => bool) private priceSeen` ensures distinct prices are added in $O(1)$ without duplication.
- Active voting power is stored in `mapping(uint256 => uint256) private priceWeight`.
- Per-voter stakes per price are stored in `mapping(address => mapping(uint256 => uint256)) private voterPriceStake`, allowing voters to withdraw partial or full stakes from specific prices.

### B. Dynamic Leader Resolution (`_calculateLeader`)

- Rather than caching a fragile leader pointer that would need complex re-sorting on every withdrawal, the contract resolves the leader dynamically via `_calculateLeader()`.
- It iterates over `candidatePrices` to find the price with the strictly maximum weight.
- If two or more prices share the maximum positive weight, `tie` is flagged as `true`.
- For off-chain readers and UI, `leader()` and `isTie()` provide instant, zero-gas visibility into the current race.

### C. Freezing the Election Tally at Voting End

- A critical accounting boundary exists at `votingEnd`:
  - **During active voting (`block.timestamp < votingEnd`)**: A withdrawal reduces `priceWeight[price]`, immediately freeing the voter's tokens and updating the race. The voter gives up their vote.
  - **After voting has ended (`block.timestamp >= votingEnd`)**: The voting window is closed. Voters are entitled to withdraw their locked principal back to their wallets, but withdrawals past the deadline do not alter the historical `priceWeight` tally.
- When `finalize()` is called (post-deadline), it evaluates the leader from the votes held through the deadline. If there is an outright leader, `finalWinningPrice` is saved; if there is a tie or zero votes, it settles at 0.

### D. Trade-offs and Efficiency

- **Simplicity & Safety**: Eliminates the overhead and security risks of complex doubly linked lists or dynamic on-chain sorted trees in Solidity.
- **Gas Predictability**: Token price elections typically involve a small set of discrete target prices (rarely exceeding dozens of candidates). An $O(N)$ pass over candidate prices at finalization is gas-efficient and robust.
- **Checks-Effects-Interactions**: All accounting updates (reducing voter stakes and total locked balances) occur before external ERC-20 transfers, protecting against reentrancy.
