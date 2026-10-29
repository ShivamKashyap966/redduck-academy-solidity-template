import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem } = await network.connect();

describe("Pair (pull-based AMM)", function () {
  async function deployFixture() {
    const [deployer, alice, bob] = await viem.getWalletClients();

    const tokenA = await viem.deployContract("Token", ["Token A", "AAA", parseEther("1000000")]);
    const tokenB = await viem.deployContract("Token", ["Token B", "BBB", parseEther("1000000")]);

    const pair = await viem.deployContract("Pair", [tokenA.address, tokenB.address]);

    for (const w of [alice, bob]) {
      await tokenA.write.transfer([w.account.address, parseEther("100000")]);
      await tokenB.write.transfer([w.account.address, parseEther("100000")]);
    }

    for (const w of [deployer, alice, bob]) {
      await tokenA.write.approve([pair.address, parseEther("1000000")], { account: w.account });
      await tokenB.write.approve([pair.address, parseEther("1000000")], { account: w.account });
    }

    return { pair, tokenA, tokenB, deployer, alice, bob };
  }

  // Starter test: one swap end-to-end. Preserved exactly as required by TASK.md.
  it("a swap charges the 0.3% fee, moves the price, and does not let k decrease", async function () {
    const { pair, tokenA, alice } = await deployFixture();

    await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

    const r0Before = (await pair.read.reserve0()) as bigint;
    const r1Before = (await pair.read.reserve1()) as bigint;
    const kBefore = r0Before * r1Before;

    const amountIn = parseEther("100");
    const expectedOut = (await pair.read.getAmountOut([amountIn, r0Before, r1Before])) as bigint;

    await pair.write.swap([tokenA.address, amountIn, 0n], { account: alice.account });

    const r0After = (await pair.read.reserve0()) as bigint;
    const r1After = (await pair.read.reserve1()) as bigint;

    assert.equal(r0After, r0Before + amountIn);
    assert.equal(r1After, r1Before - expectedOut);
    assert.ok(
      expectedOut > parseEther("90") && expectedOut < parseEther("91"),
      `got ${expectedOut}`,
    );
    assert.ok(r0After * r1After > kBefore, "k must not decrease across a swap");
  });

  describe("getAmountOut", function () {
    it("computes exact output for given inputs and reserves", async function () {
      const { pair } = await deployFixture();

      const rIn = parseEther("1000");
      const rOut = parseEther("2000");
      const aIn = parseEther("10");

      // dy = (10e18 * 997 * 2000e18) / (1000e18 * 1000 + 10e18 * 997)
      const expected = (aIn * 997n * rOut) / (rIn * 1000n + aIn * 997n);
      const out = (await pair.read.getAmountOut([aIn, rIn, rOut])) as bigint;

      assert.equal(out, expected);
    });

    it("reverts with InsufficientAmount when amountIn is 0", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(
        pair.read.getAmountOut([0n, parseEther("1000"), parseEther("1000")]),
        /InsufficientAmount/,
      );
    });

    it("reverts with InsufficientLiquidity when either reserve is 0", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(
        pair.read.getAmountOut([parseEther("10"), 0n, parseEther("1000")]),
        /InsufficientLiquidity/,
      );
      await assert.rejects(
        pair.read.getAmountOut([parseEther("10"), parseEther("1000"), 0n]),
        /InsufficientLiquidity/,
      );
    });
  });

  describe("addLiquidity", function () {
    it("mints LP tokens to first depositor and locks MINIMUM_LIQUIDITY permanently", async function () {
      const { pair, deployer } = await deployFixture();

      const amount0 = parseEther("1000");
      const amount1 = parseEther("4000");
      // sqrt(1000e18 * 4000e18) = 2000e18
      const expectedTotalLiquidity = parseEther("2000");
      const minLiquidity = (await pair.read.MINIMUM_LIQUIDITY()) as bigint;
      const expectedUserLiquidity = expectedTotalLiquidity - minLiquidity;
      const deadAddress = (await pair.read.DEAD_ADDRESS()) as `0x${string}`;

      await viem.assertions.emitWithArgs(
        pair.write.addLiquidity([amount0, amount1]),
        pair,
        "LiquidityAdded",
        [getAddress(deployer.account.address), amount0, amount1, expectedUserLiquidity],
      );

      assert.equal(await pair.read.reserve0(), amount0);
      assert.equal(await pair.read.reserve1(), amount1);
      assert.equal(await pair.read.totalSupply(), expectedTotalLiquidity);
      assert.equal(await pair.read.balanceOf([deployer.account.address]), expectedUserLiquidity);
      assert.equal(await pair.read.balanceOf([deadAddress]), minLiquidity);
    });

    it("subsequent depositor receives proportional LP tokens when depositing in ratio", async function () {
      const { pair, deployer, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);
      const initialTotalSupply = (await pair.read.totalSupply()) as bigint;

      // Alice deposits 500 of each (50% of existing pool)
      await pair.write.addLiquidity([parseEther("500"), parseEther("500")], {
        account: alice.account,
      });

      const aliceExpectedLp = (parseEther("500") * initialTotalSupply) / parseEther("1000");
      assert.equal(await pair.read.balanceOf([alice.account.address]), aliceExpectedLp);
      assert.equal(await pair.read.reserve0(), parseEther("1500"));
      assert.equal(await pair.read.reserve1(), parseEther("1500"));
      assert.equal(await pair.read.totalSupply(), initialTotalSupply + aliceExpectedLp);
    });

    it("subsequent depositor depositing out of ratio receives LP determined by the smaller side", async function () {
      const { pair, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);
      const initialTotalSupply = (await pair.read.totalSupply()) as bigint;

      // Alice deposits 600 of token0 and 400 of token1 (smaller side is 400)
      await pair.write.addLiquidity([parseEther("600"), parseEther("400")], {
        account: alice.account,
      });

      const expectedLp = (parseEther("400") * initialTotalSupply) / parseEther("1000");
      assert.equal(await pair.read.balanceOf([alice.account.address]), expectedLp);
      // Reserves increase by the full deposited amounts (excess 200 is forfeited)
      assert.equal(await pair.read.reserve0(), parseEther("1600"));
      assert.equal(await pair.read.reserve1(), parseEther("1400"));
    });

    it("reverts with InsufficientAmount if either deposit amount is 0", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(pair.write.addLiquidity([0n, parseEther("100")]), /InsufficientAmount/);
      await assert.rejects(pair.write.addLiquidity([parseEther("100"), 0n]), /InsufficientAmount/);
    });

    it("reverts with InsufficientLiquidity on first deposit if initial liquidity <= MINIMUM_LIQUIDITY", async function () {
      const { pair } = await deployFixture();

      // sqrt(1000 * 1000) = 1000 <= MINIMUM_LIQUIDITY (1000)
      await assert.rejects(pair.write.addLiquidity([1000n, 1000n]), /InsufficientLiquidity/);
    });

    it("reverts with InsufficientLiquidity on subsequent deposit if computed LP is 0", async function () {
      const { pair, alice } = await deployFixture();

      // Pool with reserve1 > totalSupply:
      // sqrt(1000e18 * 4000e18) = 2000e18 totalSupply vs 4000e18 reserve1
      await pair.write.addLiquidity([parseEther("1000"), parseEther("4000")]);

      // 1 wei of token1 relative to 4000e18 reserve1 and 2000e18 totalSupply:
      // (1 * 2000e18) / 4000e18 = 0 LP
      await assert.rejects(
        pair.write.addLiquidity([1n, 1n], { account: alice.account }),
        /InsufficientLiquidity/,
      );
    });
  });

  describe("removeLiquidity", function () {
    it("burns LP tokens and returns proportional amounts of both underlying tokens", async function () {
      const { pair, tokenA, tokenB, deployer } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("2000")]);

      const minLiquidity = (await pair.read.MINIMUM_LIQUIDITY()) as bigint;
      const userLp = (await pair.read.balanceOf([deployer.account.address])) as bigint;
      const initialBalA = (await tokenA.read.balanceOf([deployer.account.address])) as bigint;
      const initialBalB = (await tokenB.read.balanceOf([deployer.account.address])) as bigint;

      const expectedAmount0 = (userLp * parseEther("1000")) / (userLp + minLiquidity);
      const expectedAmount1 = (userLp * parseEther("2000")) / (userLp + minLiquidity);

      await viem.assertions.emitWithArgs(
        pair.write.removeLiquidity([userLp]),
        pair,
        "LiquidityRemoved",
        [getAddress(deployer.account.address), expectedAmount0, expectedAmount1, userLp],
      );

      assert.equal(await pair.read.balanceOf([deployer.account.address]), 0n);
      assert.equal(await pair.read.totalSupply(), minLiquidity);
      assert.equal(
        await tokenA.read.balanceOf([deployer.account.address]),
        initialBalA + expectedAmount0,
      );
      assert.equal(
        await tokenB.read.balanceOf([deployer.account.address]),
        initialBalB + expectedAmount1,
      );
      assert.equal(await pair.read.reserve0(), parseEther("1000") - expectedAmount0);
      assert.equal(await pair.read.reserve1(), parseEther("2000") - expectedAmount1);
    });

    it("supports partial liquidity removal by multiple providers", async function () {
      const { pair, deployer, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);
      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")], {
        account: alice.account,
      });

      const aliceLp = (await pair.read.balanceOf([alice.account.address])) as bigint;
      const halfLp = aliceLp / 2n;

      await pair.write.removeLiquidity([halfLp], { account: alice.account });

      assert.equal(await pair.read.balanceOf([alice.account.address]), aliceLp - halfLp);
      // Alice still has remaining LP tokens and pool still has reserves
      assert.ok((await pair.read.reserve0()) > parseEther("1400"));
      assert.ok((await pair.read.reserve1()) > parseEther("1400"));
    });

    it("reverts with InsufficientAmount when liquidity to remove is 0", async function () {
      const { pair } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      await assert.rejects(pair.write.removeLiquidity([0n]), /InsufficientAmount/);
    });

    it("reverts with InsufficientLiquidity when pool has no supply", async function () {
      const { pair } = await deployFixture();

      await assert.rejects(pair.write.removeLiquidity([parseEther("1")]), /InsufficientLiquidity/);
    });
  });

  describe("swap", function () {
    it("swaps tokenB for tokenA (reverse direction) charging 0.3% fee and growing k", async function () {
      const { pair, tokenA, tokenB, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("2000"), parseEther("1000")]);

      const r0Before = (await pair.read.reserve0()) as bigint;
      const r1Before = (await pair.read.reserve1()) as bigint;
      const kBefore = r0Before * r1Before;

      const amountInB = parseEther("100");
      const expectedOutA = (await pair.read.getAmountOut([
        amountInB,
        r1Before,
        r0Before,
      ])) as bigint;
      const aliceBalABefore = (await tokenA.read.balanceOf([alice.account.address])) as bigint;

      await viem.assertions.emitWithArgs(
        pair.write.swap([tokenB.address, amountInB, 0n], { account: alice.account }),
        pair,
        "Swapped",
        [getAddress(alice.account.address), getAddress(tokenB.address), amountInB, expectedOutA],
      );

      const r0After = (await pair.read.reserve0()) as bigint;
      const r1After = (await pair.read.reserve1()) as bigint;

      assert.equal(r1After, r1Before + amountInB);
      assert.equal(r0After, r0Before - expectedOutA);
      assert.equal(
        await tokenA.read.balanceOf([alice.account.address]),
        aliceBalABefore + expectedOutA,
      );
      assert.ok(r0After * r1After > kBefore, "k must strictly grow due to 0.3% fee");
    });

    it("reverts with InsufficientOutput when minAmountOut exceeds actual output (slippage protection)", async function () {
      const { pair, tokenA, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      const amountIn = parseEther("10");
      const actualOut = (await pair.read.getAmountOut([
        amountIn,
        parseEther("1000"),
        parseEther("1000"),
      ])) as bigint;

      // Ask for more than actual output
      await assert.rejects(
        pair.write.swap([tokenA.address, amountIn, actualOut + 1n], { account: alice.account }),
        /InsufficientOutput/,
      );

      // Asking for exact output succeeds
      await pair.write.swap([tokenA.address, amountIn, actualOut], { account: alice.account });
    });

    it("reverts with InvalidToken when tokenIn is not token0 or token1", async function () {
      const { pair, alice } = await deployFixture();

      const rogueToken = await viem.deployContract("Token", [
        "Rogue",
        "ROG",
        parseEther("1000000"),
      ]);

      await assert.rejects(
        pair.write.swap([rogueToken.address, parseEther("10"), 0n], { account: alice.account }),
        /InvalidToken/,
      );
    });

    it("reverts with InsufficientLiquidity when pool has no reserves", async function () {
      const { pair, tokenA, alice } = await deployFixture();

      await assert.rejects(
        pair.write.swap([tokenA.address, parseEther("10"), 0n], { account: alice.account }),
        /InsufficientLiquidity/,
      );
    });

    it("reverts when caller has insufficient allowance for input token", async function () {
      const { pair, tokenA } = await deployFixture();

      const [unapprovedUser] = (await viem.getWalletClients()).slice(3);
      await tokenA.write.transfer([unapprovedUser.account.address, parseEther("100")]);
      // unapprovedUser holds tokens but hasn't approved the pair

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      await assert.rejects(
        pair.write.swap([tokenA.address, parseEther("10"), 0n], {
          account: unapprovedUser.account,
        }),
      );
    });

    it("reverts when caller has insufficient balance for input token", async function () {
      const { pair, tokenA, alice } = await deployFixture();

      await pair.write.addLiquidity([parseEther("1000"), parseEther("1000")]);

      // Alice owns 100,000 tokens, tries to swap 200,000
      await assert.rejects(
        pair.write.swap([tokenA.address, parseEther("200000"), 0n], { account: alice.account }),
      );
    });
  });

  describe("constant-product invariant across multiple swaps", function () {
    it("preserves or grows k across sequential bidirectional swaps", async function () {
      const { pair, tokenA, tokenB, alice, bob } = await deployFixture();

      await pair.write.addLiquidity([parseEther("5000"), parseEther("5000")]);

      let prevK =
        ((await pair.read.reserve0()) as bigint) * ((await pair.read.reserve1()) as bigint);

      // Alice swaps A for B
      await pair.write.swap([tokenA.address, parseEther("50"), 0n], { account: alice.account });
      let currK =
        ((await pair.read.reserve0()) as bigint) * ((await pair.read.reserve1()) as bigint);
      assert.ok(currK > prevK, "k grew on first swap");
      prevK = currK;

      // Bob swaps B for A
      await pair.write.swap([tokenB.address, parseEther("80"), 0n], { account: bob.account });
      currK = ((await pair.read.reserve0()) as bigint) * ((await pair.read.reserve1()) as bigint);
      assert.ok(currK > prevK, "k grew on second swap");
      prevK = currK;

      // Alice swaps A for B again
      await pair.write.swap([tokenA.address, parseEther("120"), 0n], { account: alice.account });
      currK = ((await pair.read.reserve0()) as bigint) * ((await pair.read.reserve1()) as bigint);
      assert.ok(currK > prevK, "k grew on third swap");
    });
  });

  describe("reserves sync with actual token balances", function () {
    it("keeps reserves in sync with actual token balances after addLiquidity, swap, removeLiquidity, and sync", async function () {
      const { pair, tokenA, tokenB, deployer, alice } = await deployFixture();

      // After addLiquidity
      await pair.write.addLiquidity([parseEther("1000"), parseEther("2000")]);
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));

      // After swap
      await pair.write.swap([tokenA.address, parseEther("100"), 0n], { account: alice.account });
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));

      // After removeLiquidity
      const deployerLP = (await pair.read.balanceOf([deployer.account.address])) as bigint;
      await pair.write.removeLiquidity([deployerLP / 2n]);
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));

      // Sync reconciles direct token donation
      await tokenA.write.transfer([pair.address, parseEther("50")]);
      assert.notEqual(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      await pair.write.sync();
      assert.equal(await pair.read.reserve0(), await tokenA.read.balanceOf([pair.address]));
      assert.equal(await pair.read.reserve1(), await tokenB.read.balanceOf([pair.address]));
    });
  });
});
