# 01 — Token

## Context

The academy is launching its own token. Future lessons will deploy it in worked
examples: a staking contract that pays rewards in this token, a vesting schedule
for the team, a DEX where it trades against ETH. Before any of that can happen,
the token itself has to exist. That's what you're building now.

Call it whatever you want. The name and symbol are constructor parameters.

## What to do

Fill in the bodies of `contracts/Token.sol` so every test in `tests/` passes.
The starter file already contains:

- The `IERC20` interface the contract inherits from (`contracts/IERC20.sol`).
- The function signatures you need to implement.
- A constructor that takes `name`, `symbol`, and `initialSupply`.

The tests are the spec. Every behavior the contract must exhibit is encoded in a
test. The contract is small — around 80-120 lines depending on how concise your
code is.

> **Note on the tests.** For this task the test suite (`tests/Token.test.ts`)
> is pre-defined — you only need to make it pass. Starting with the next
> capstone, you'll be expected to design and write your own tests as part of
> the assignment. Pay attention to how this suite is structured; you'll be
> writing one of your own soon.

## What you're implementing

The standard ERC-20 surface:

**State**

- `name()` — token name, set in the constructor.
- `symbol()` — token symbol, set in the constructor.
- `decimals()` — fixed at `18`.
- `totalSupply()` — total tokens in existence.
- `balanceOf(address)` — balance of an account.
- `allowance(address owner, address spender)` — remaining tokens `spender` may
  pull from `owner`.

**Mutations**

- `transfer(address to, uint256 value)` — move tokens from `msg.sender` to `to`.
- `approve(address spender, uint256 value)` — set `spender`'s allowance over
  `msg.sender`'s balance to `value`.
- `transferFrom(address from, address to, uint256 value)` — move tokens from
  `from` to `to`, consuming allowance held by `msg.sender`.

**Events**

- `Transfer(address indexed from, address indexed to, uint256 value)` — emitted
  on every transfer.
- `Approval(address indexed owner, address indexed spender, uint256 value)` —
  emitted on every approval.

**Errors**

Use custom errors for revert reasons. The test suite checks revert reasons by
name, so use exactly these:

- `InsufficientBalance`
- `InsufficientAllowance`
- `TransferToZeroAddress`
- `ApproveToZeroAddress`

## Constructor

```solidity
constructor(string memory name_, string memory symbol_, uint256 initialSupply)
```

## The one rule

**Don't look up someone else's implementation.** Not OpenZeppelin, not Solmate,
not Solady, not a tutorial blog. Not "just to understand the structure." Not
for five seconds while you're stuck.

The reason isn't moral. It's that every line you copy from an existing
implementation is a line you don't understand. When you later have to debug a
token contract in production, modify one for a specific use case, or audit one
written by someone else, you'll need to actually know how every piece works.
The OpenZeppelin implementation is excellent code. It's also written by people
who already understood the standard before they wrote it. You're trying to
become one of those people. Copying skips the only step that matters.

Everything you need is in the tests and in this course's prior lessons. The
Solidity documentation is fine. The academy chat is fine when you're truly
stuck. Someone else's contract is not.

## Running

```sh
npm run compile:01-token
npm run test:01-token
```
