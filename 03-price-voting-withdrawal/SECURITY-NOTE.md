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

### D. Documented Deterministic Tie-Breaking Rule

- **The Rule**: If two or more candidate prices share the maximum positive weight at the close of voting (or during active voting when evaluating leader / tie status), the contract declares a **tie** (`isTie() == true`).
- **Outcome**: A tie means no consensus was reached among token holders. Under this rule, `winningPrice()` and `currentTokenPrice()` resolve strictly to `0`, and `leader()` returns price `0` with the shared weight. An election also resolves to `0` if no votes were cast. Only an outright, unique highest-weighted price wins.
- **Consistency**: This rule is enforced consistently across live leader views (`leader()`, `isTie()`), internal calculation (`_calculateLeader()`), and final settlement (`finalize()`).

### E. Bounded Iterations and Gas Safety (SWC-128 Mitigation)

To prevent denial-of-service (DoS) via gas exhaustion through unbounded voter activity, the contract enforces strict upper bounds:

1. **`MAX_CANDIDATE_PRICES = 250`**:
   - The total number of distinct candidate prices is capped at 250.
   - Any attempt to introduce a new price beyond this threshold reverts with `MaxCandidatePricesReached`.
   - Consequently, the `_calculateLeader()` loop executed during `finalize()` is strictly bounded by 250 iterations, consuming less than 2% of the block gas limit under EVM Cancun.
2. **`MAX_VOTER_PRICES = 50` & Dynamic Array Pruning**:
   - A single voter cannot maintain active stakes in more than 50 distinct prices (`MaxVoterPricesReached`).
   - The contract uses an internal index mapping `voterPriceIndex` to perform $O(1)$ swap-and-pop removal whenever a voter's balance in a price reaches 0, keeping the voter's active price list compact.
   - Calling `withdrawAll()` iterates at most 50 elements and immediately deletes the array (`delete voterPricesList[msg.sender]`).
3. **Explicit Batch Withdrawal `withdraw(uint256[] calldata prices)`**:
   - Callers can also supply a custom array of prices to withdraw in explicit, caller-bounded batches.

### F. Trade-offs and Efficiency

- **Simplicity & Safety**: Eliminates the overhead and security risks of complex doubly linked lists or dynamic on-chain sorted trees in Solidity.
- **Gas Predictability**: Both candidate prices and voter prices have compile-time upper bounds, preventing griefing or DoS attacks.
- **Checks-Effects-Interactions**: All accounting updates (reducing voter stakes and total locked balances) occur before external ERC-20 transfers, protecting against reentrancy.
