# Task: Chainlink raffle

Build a raffle where players deposit a token, the deposit's USD value at entry time determines win probability, and a Chainlink VRF draw picks the winner after a deadline.

## Background

This task combines the two Chainlink primitives from the recent lectures. A price feed values each deposit in USD at the moment it's made, so deposits in a volatile token are weighted fairly regardless of price movement during the raffle. VRF picks the winner once the entry window closes, so the result is verifiably random and cannot be influenced by validators.

Randomness arrives asynchronously. The function that requests a random number returns immediately, and the VRF coordinator calls back some blocks later with the result. Anything that depends on the random value happens at or after that callback, not in the original user transaction.

## Architecture

`contracts/Raffle.sol` is the on-chain contract. Players deposit, anyone triggers the draw after the deadline, and the winner claims the prize pool.

`contracts/mocks/Mocks.sol` exposes `VRFCoordinatorMock` and `PriceFeedMock` so tests can drive Chainlink behavior locally. No subscription, no testnet, no live LINK required.

`contracts/Token.sol` is the generic ERC-20 used for the deposit token.

## On-chain behavior

### `deposit(uint256 amount)`

A player joins the raffle by depositing a positive amount of the deposit token while the raffle is open. Their chance of winning is proportional to the USD value of their deposit, valued at the moment of the deposit using the current price feed. Once recorded, this value never changes for them, even if the token price moves later.

The raffle stops accepting deposits when the deadline passes, and also stops once a draw has been requested. The contract should not act on prices that are missing, non-positive, or too old to trust.

### `drawWinner() → uint256`

Anyone may call this once the deadline has passed and at least one deposit has been recorded. It triggers a single random-word request through VRF using the parameters stored at construction, and the returned request identifier should be tracked for matching against the callback. The draw can only happen once.

### `fulfillRandomWords(uint256 _requestId, uint256[] calldata randomWords)`

The VRF callback. The contract receives the random word generated for the earlier request. The implementation should confirm the request identifier matches the one stored and record the value. No other work belongs here. No transfers, no loops over entries, no settlement logic. The callback runs under a gas limit and must succeed for the result to be delivered at all.

### `claim(uint256 entryIndex)`

After the random word has arrived, the winner claims the prize. The caller supplies `entryIndex` and the contract verifies that this index identifies a winning entry belonging to `msg.sender`. If verification fails, the call reverts with `InvalidClaim`. The prize can only be claimed once.

How the caller determines the right index is up to them. The contract's job is to verify, not to search.

## Constraints

The contract may not import any library that solves the weighted-draw or random-selection problem. The data structure and verification logic are yours to design.

## Tests

`tests/Raffle.test.ts` already contains a starter happy-path test (two deposits → time travel to deadline → forced VRF response → claim). It fails until the four functions work. Keep this test unchanged.
 
Add all further tests to this **same file**, after the existing one. Cover the failure modes and the edge cases at the boundaries of the weighted pick.
