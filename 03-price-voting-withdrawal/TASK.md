# Task: PriceVoting with mid-voting withdrawal

Build a smart contract that lets token holders vote on a new price for their token, with the new ability to withdraw locked tokens at any time during voting. The contract design is entirely up to you.

## What you're using

The ERC-20 token from your previous capstone task, the same one used in the previous voting task. Copy the contract file into `contracts/Token.sol`. The voting contract treats it as a generic ERC-20.

You can reuse the structure of your previous PriceVoting contract as a starting point. The lock/vote bookkeeping is largely the same. The interesting redesign is in how you handle the leader question in the presence of withdrawals.

## What changes from the previous task

Three things:

1. **Mid-voting withdrawal is allowed.** A voter can withdraw their previously locked tokens at any time, including during the voting period. They get back exactly the tokens they put in.

2. **The leader no longer needs to be tracked at every moment.** You can drop that requirement, but the leader should be available after finalizing.

3. **Almost nothing about the contract's shape is prescribed.** You decide the function signatures, the events, the errors, the storage layout, the resolution mechanism, and whether there's a separate settlement step after voting ends. Pick whatever makes your design work.

## Required behavior

These are the only constraints. The contract must produce these behaviors. How it does so is up to you.

### Voting

During the voting period, anyone holding the token can lock tokens behind a price of their choosing. After voting ends, no new votes can be cast. Voters can vote multiple times during the period for the same price or different prices.

### Withdrawal

A voter can withdraw previously locked tokens at any time, before or after the voting period ends. They cannot withdraw more than they have locked.

### Winning price

After voting ends, the contract must expose a way to read the final winning price. This is the leader at the end, accounting for all votes and withdrawals that happened during the period.

If your design uses a settlement step, for example a claim-and-challenge mechanism that resolves after voting ends, document its required call order in a comment at the top of your contract.

## What you decide

Everything not listed above. In particular:

- The names and signatures of vote, withdraw, leader, winner, and any other functions.
- The internal data structures and storage layout.
- The event names and arguments.
- The error names.

## Reflection

After your contract works, write a short note, either in a markdown file or as comments at the top of your contract, answering:

**What implementation strategy did you pick for handling withdrawal-induced leader changes, and why?** What would go wrong with the simpler pattern from the previous task in your design?

This reflection is part of the review.
