# Task: Constant-product AMM pair

You've seen the Uniswap V2 lecture. Now build a working prototype.

## Background

A V2 pool holds two ERC-20 tokens and a single math invariant: `x * y = k`. Anyone can swap one token for the other against the pool. Anyone can deposit both tokens to become a liquidity provider, receiving LP tokens that represent their share of the reserves.

Real V2 splits this across two contracts: a Pair (core) that holds funds and exposes a low-level push-style swap, and a Router (periphery) that handles user-friendly pulls and computes outputs. This task folds both layers into one. The pair pulls input tokens with `transferFrom` and computes outputs internally. No factory, no router, no flash swaps, no native ETH support.

The pair contract is itself an ERC-20. LP tokens are minted on deposit and burned on withdrawal.

## Architecture

`contracts/Pair.sol` is the on-chain contract. It inherits from OpenZeppelin's `ERC20`, where the inherited token is the LP token. The starter has state, errors, events, the constructor, and a few private math helpers. The four public functions are stubs you implement.

`contracts/Token.sol` is the generic ERC-20 used to instantiate the two pool tokens in tests.

## On-chain behavior

### `getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) → uint256`

Pure function. Returns how much of the output token a trader gets for `amountIn` of the input token, given the current reserves. The math must respect the constant-product invariant and charge a 0.3% fee on the input.

- If `amountIn == 0`, revert `InsufficientAmount`.
- If either reserve is 0, revert `InsufficientLiquidity`.
- The product of reserves (k) must not decrease across the corresponding swap. The fee makes k strictly grow.

### `addLiquidity(uint256 amount0, uint256 amount1) → uint256 liquidity`

The caller deposits both tokens and receives LP tokens in return.

- Pull `amount0` of `token0` and `amount1` of `token1` from the caller via `transferFrom`.
- Mint LP tokens to the caller.
- Update reserves to reflect the new balances.
- Emit `LiquidityAdded(msg.sender, amount0, amount1, liquidity)`.
- Revert `InsufficientAmount` if either `amount0` or `amount1` is 0.
- Revert `InsufficientLiquidity` if the computed LP amount is 0.

The amount of LP minted depends on whether the pool is fresh. When the pool is empty, the first depositor establishes the initial scale. When the pool already has reserves, later depositors must receive LP proportional to the smaller of their two deposits relative to the pool's existing ratio. Depositing out of ratio means the smaller side determines the mint, and the excess on the larger side is forfeited to the pool.

The first depositor must permanently lock `MINIMUM_LIQUIDITY` units of LP supply. Without this lock, the contract is vulnerable to the first-depositor inflation attack: an attacker deposits a tiny amount, then donates tokens directly to the contract to inflate the per-LP-token share, causing the next legitimate depositor's allocation to round to zero.

### `removeLiquidity(uint256 liquidity) → (uint256 amount0, uint256 amount1)`

The caller burns `liquidity` of their LP tokens and receives a proportional share of both reserves.

- Burn `liquidity` LP tokens from the caller.
- Transfer the proportional share of `token0` and `token1` to the caller.
- Update reserves.
- Emit `LiquidityRemoved(msg.sender, amount0, amount1, liquidity)`.

The amounts returned must be proportional to the caller's share of total LP supply.

### `swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) → uint256 amountOut`

A user swaps `amountIn` of `tokenIn` for the other token.

- If `tokenIn` is neither `token0` nor `token1`, revert `InvalidToken`.
- Compute the output via `getAmountOut`, using the reserves in the correct order for the swap direction.
- If the computed output is less than `minAmountOut`, revert `InsufficientOutput`.
- Pull `amountIn` of the input token from the caller.
- Transfer the output token to the caller.
- Update reserves.
- Emit `Swapped(msg.sender, tokenIn, amountIn, amountOut)`.

The `minAmountOut` parameter is the caller's slippage protection. Other transactions may move the pool between the moment the caller computed their expected output off chain and the moment their swap is mined.

## Constraints

The contract must not copy code from Uniswap V2's source. Derive the implementation from the V2 lecture and this spec. The starter has the imports and helpers you need.

## Tests

A starter test in `tests/Pair.test.ts` covers one swap end-to-end. It fails until `addLiquidity`, `swap`, and `getAmountOut` are implemented. Don't edit it.

Complete that file covering the other behaviors: first and subsequent liquidity provision, removal, slippage rejection, invalid-token rejection, the first-depositor lock, and any edge cases you find worth exercising.
