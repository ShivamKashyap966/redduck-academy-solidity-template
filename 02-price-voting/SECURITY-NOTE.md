# Security note: why locked tokens cannot be withdrawn before `votingEnd`

This is the assignment reflection for `02-price-voting`. It answers: **what would
break if voters could withdraw their locked tokens during the voting period,
before `votingEnd`?**

## The invariant that would break

The contract keeps two mappings that are supposed to describe the same reality:

- `lockedOf(voter)` (`lockedBalance`) — tokens a voter currently has locked,
- `weightOf(price)` (`priceWeight`) — voting power accumulated per price.

Voting tokens are held by the contract, and by design

```
sum(priceWeight) == sum(lockedBalance) == token.balanceOf(PriceVoting)
```

holds at every point after `votingEnd` — and would hold _during_ voting too if
the only way tokens enter is `vote` and the only way they leave is `claim`
(after the deadline). **If `withdraw` existed and ran before `votingEnd`, only
`lockedBalance` would be decremented; `priceWeight` would stay exactly as it
was cast.** That is the inconsistent state variable: `priceWeight` would keep
counting tokens that are no longer locked (and no longer in the contract), so
the two sums diverge and the first equality above becomes false.

`weightOf` is a tally of _votes_, not of _holdings_, and a tally you can pull
your stake out of is no longer a tally of anything real.

## Concrete exploits this enables

1. **Re-voting with the same tokens (double counting).**
   A holder of 100 tokens could `vote(100 → priceA, 100)`, withdraw the 100,
   then `vote(100 → priceB, 100)`, and repeat for any number of prices. One
   balance produces weight on every price simultaneously — `priceWeight` sums
   to `N × 100` while the contract holds (and `lockedBalance` sums to) only
   `100`. Every weight is inflated; none reflects real stake.

2. **Cost-free, last-minute manipulation.**
   Votes only carry weight because the tokens are at risk until the result is
   known. With early withdrawal, an attacker could watch `leader()`, buy a
   temporary lead for a chosen price, withdraw immediately (before anyone
   reacts or the deadline hits), and repeat — moving `leadingPrice` at zero
   economic cost, possibly right up to `votingEnd`.

3. **Wrong winner in `finalize()`.**
   `finalize()` stores `leadingPrice` into `currentTokenPrice` based purely on
   `priceWeight`/`leader()`. If that weight can outlive the withdrawal, the
   "winning price" can be set by tokens that were never actually committed —
   the result is decided by weight the contract does not hold, and `claim()`
   afterwards would try to return tokens to voters whose `lockedBalance` says
   they have nothing (or vice versa — the accounting simply no longer closes).

## Why blocking withdrawals fixes it

During the voting period every token counted in `priceWeight` is physically
held by the contract and can only leave through `claim()` after `votingEnd`
(with `lockedBalance` zeroed first, checks-effects-interactions). The voter's
capital stays at risk for the whole decision window, so weight can only be
bought by locking value, exactly once per unit of tokens. The lesson's next
task (`03-price-voting-withdrawal`) solves the _need_ for withdrawal
differently — by reducing the weight when tokens leave, so the two mappings
stay in sync instead of being frozen apart.
