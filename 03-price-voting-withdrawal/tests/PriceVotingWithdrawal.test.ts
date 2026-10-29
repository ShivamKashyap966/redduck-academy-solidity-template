import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, maxUint256, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVotingWithdrawal", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVotingWithdrawal", [token.address, votingEnd]);

    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  async function passDeadline() {
    await networkHelpers.time.increase(ONE_DAY);
  }

  describe("deployment & setup", function () {
    it("deploys the token with its metadata and full supply", async function () {
      const { token, deployer } = await networkHelpers.loadFixture(deployFixture);

      assert.equal(await token.read.name(), "Vote Token");
      assert.equal(await token.read.symbol(), "VOTE");
      assert.equal(await token.read.totalSupply(), parseEther("1000000"));
      assert.equal(await token.read.balanceOf([deployer.account.address]), parseEther("997000"));
    });

    it("stores the token reference and the voting deadline", async function () {
      const { token, voting, votingEnd } = await networkHelpers.loadFixture(deployFixture);

      assert.equal(getAddress(await voting.read.token()), getAddress(token.address));
      assert.equal(await voting.read.votingEnd(), votingEnd);
    });

    it("starts with no votes, no leader, no price, and not finalized", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 0n);
      assert.equal(leadWeight, 0n);
      assert.equal(await voting.read.isTie(), false);
      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await voting.read.withdrawnOf([alice.account.address]), 0n);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
      assert.equal(await voting.read.finalized(), false);
      assert.equal(await voting.read.candidatePricesCount(), 0n);
    });
  });

  describe("vote", function () {
    it("records a single vote and emits Voted", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), parseEther("50"));
    });

    it("stacks weight when two voters back the same price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([100n, parseEther("70")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("120"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([bob.account.address]), parseEther("70"));

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("120"));
    });

    it("splits one voter's stake across prices and tracks per-price and total locks", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), parseEther("40"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 200n]), parseEther("60"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("40"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("60"));

      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("900"));
    });

    it("supports arbitrary uint256 prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);
      const hugePrice = 2n ** 255n + 99999n;

      await voting.write.vote([hugePrice, parseEther("100")], { account: alice.account });
      await voting.write.vote([maxUint256, parseEther("50")], { account: bob.account });

      assert.equal(await voting.read.weightOf([hugePrice]), parseEther("100"));
      assert.equal(await voting.read.weightOf([maxUint256]), parseEther("50"));

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, hugePrice);
      assert.equal(leadWeight, parseEther("100"));
    });

    it("reverts when called after votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await passDeadline();

      await assert.rejects(
        voting.write.vote([100n, parseEther("1")], { account: alice.account }),
        /VotingEnded/,
      );
    });

    it("reverts when called exactly at votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await networkHelpers.time.setNextBlockTimestamp(Number(votingEnd));

      await assert.rejects(
        voting.write.vote([100n, parseEther("1")], { account: alice.account }),
        /VotingEnded/,
      );
    });

    it("reverts with an amount of zero", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(voting.write.vote([100n, 0n], { account: alice.account }), /ZeroAmount/);
    });

    it("reverts when allowance is insufficient", async function () {
      const { voting, deployer } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(
        voting.write.vote([100n, parseEther("1")], { account: deployer.account }),
        /TransferFailed/,
      );
    });

    it("reverts when balance is insufficient", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await token.write.approve([voting.address, parseEther("1000000")], {
        account: alice.account,
      });

      await assert.rejects(
        voting.write.vote([100n, parseEther("1001")], { account: alice.account }),
        /TransferFailed/,
      );
    });
  });

  describe("withdrawal during voting", function () {
    it("allows withdrawing partial locked tokens from a price", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("950"));

      await viem.assertions.emitWithArgs(
        voting.write.withdraw([100n, parseEther("20")], { account: alice.account }),
        voting,
        "Withdrawn",
        [getAddress(alice.account.address), 100n, parseEther("20")],
      );

      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("970"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("30"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), parseEther("30"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("30"));
      assert.equal(await voting.read.withdrawnOf([alice.account.address]), parseEther("20"));
    });

    it("allows withdrawing all locked tokens from a price using the single-arg overload", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await voting.write.withdraw([100n], { account: alice.account });

      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), 0n);
      assert.equal(await voting.read.weightOf([100n]), 0n);
    });

    it("allows a voter to withdraw from Price A and vote for Price B (shifting vote)", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      // Alice votes 100 on price 100
      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      assert.equal(await voting.read.weightOf([100n]), parseEther("100"));

      let [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("100"));

      // Alice withdraws 100 from price 100
      await voting.write.withdraw([100n, parseEther("100")], { account: alice.account });
      assert.equal(await voting.read.weightOf([100n]), 0n);

      // Now alice uses her returned tokens to vote for price 200
      await voting.write.vote([200n, parseEther("100")], { account: alice.account });
      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.weightOf([200n]), parseEther("100"));

      [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("100"));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("900"));
    });

    it("withdrawAll clears all positions across multiple prices", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("30")], { account: alice.account });
      await voting.write.vote([200n, parseEther("70")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("900"));

      await voting.write.withdrawAll({ account: alice.account });

      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address, 200n]), 0n);
      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.weightOf([200n]), 0n);
    });

    it("allows batch withdrawal using withdraw(uint256[] calldata prices)", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("30")], { account: alice.account });
      await voting.write.vote([200n, parseEther("40")], { account: alice.account });
      await voting.write.vote([300n, parseEther("50")], { account: alice.account });

      // Withdraw only prices 100 and 300
      await voting.write.withdraw([[100n, 300n]], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address, 100n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address, 200n]), parseEther("40"));
      assert.equal(await voting.read.lockedOf([alice.account.address, 300n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("40"));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("960"));
    });

    it("enforces MAX_VOTER_PRICES bound per voter", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      // Approve more tokens to cast 51 votes of 1 token each
      await token.write.approve([voting.address, parseEther("100")], { account: alice.account });

      for (let i = 1n; i <= 50n; i++) {
        await voting.write.vote([i, parseEther("1")], { account: alice.account });
      }

      // 51st distinct price should revert with MaxVoterPricesReached
      await assert.rejects(
        voting.write.vote([51n, parseEther("1")], { account: alice.account }),
        /MaxVoterPricesReached/,
      );
    });

    it("reverts withdrawing zero amount", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(
        voting.write.withdraw([100n, 0n], { account: alice.account }),
        /ZeroAmount/,
      );
    });

    it("reverts withdrawing more than locked on a price", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(
        voting.write.withdraw([100n, parseEther("51")], { account: alice.account }),
        /InsufficientLockedBalance/,
      );
    });

    it("reverts withdrawing from a price never voted on", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(
        voting.write.withdraw([999n, parseEther("1")], { account: alice.account }),
        /InsufficientLockedBalance/,
      );
    });

    it("reverts withdrawAll when caller has nothing locked", async function () {
      const { voting, bob } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(voting.write.withdrawAll({ account: bob.account }), /NothingToWithdraw/);
    });
  });

  describe("leader dynamics with withdrawals", function () {
    it("updates the leader when the leader price experiences a withdrawal", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      // Alice votes 100 on price 100
      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      // Bob votes 80 on price 200
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });

      let [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("100"));

      // Alice withdraws 40 from price 100; price 100 drops to 60. Price 200 (80) takes the lead!
      await voting.write.withdraw([100n, parseEther("40")], { account: alice.account });

      [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("80"));
      assert.equal(await voting.read.isTie(), false);
    });

    it("detects a tie when withdrawal causes the leader to drop to the runner-up's weight", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("70")], { account: bob.account });

      // Alice withdraws 30 from price 100; both 100 and 200 are now at 70 weight!
      await voting.write.withdraw([100n, parseEther("30")], { account: alice.account });

      assert.equal(await voting.read.isTie(), true);
      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 0n);
      assert.equal(leadWeight, parseEther("70"));
    });

    it("breaks a tie when subsequent vote or withdrawal occurs", async function () {
      const { voting, alice, bob, carol } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });
      assert.equal(await voting.read.isTie(), true);

      // Carol casts 10 on price 200 -> breaks the tie!
      await voting.write.vote([200n, parseEther("10")], { account: carol.account });
      assert.equal(await voting.read.isTie(), false);

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("60"));
    });

    it("resets leader to 0 when all voters withdraw", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      let [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("50"));

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });
      [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 0n);
      assert.equal(leadWeight, 0n);
      assert.equal(await voting.read.isTie(), false);
    });
  });

  describe("finalize and post-deadline behavior", function () {
    it("reverts finalize when called before votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(voting.write.finalize(), /VotingActive/);
      assert.equal(await voting.read.finalized(), false);
    });

    it("reverts finalize when called twice", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await passDeadline();
      await voting.write.finalize();

      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });

    it("finalizes with an outright winner, emits PriceFinalized, and sets currentTokenPrice", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });
      await passDeadline();

      await viem.assertions.emitWithArgs(voting.write.finalize(), voting, "PriceFinalized", [
        200n,
        parseEther("80"),
      ]);

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 200n);
      assert.equal(await voting.read.winningPrice(), 200n);
    });

    it("asserts the final winning price after a mid-voting partial withdrawal causes another price to overtake the leader", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      // Alice votes 50 for price 100
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      // Bob votes 80 for price 200, making price 200 the initial leader
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });

      const [leadBefore, weightBefore] = await voting.read.leader();
      assert.equal(leadBefore, 200n);
      assert.equal(weightBefore, parseEther("80"));

      // Bob withdraws 40 from price 200 during active voting, dropping its weight to 40
      await voting.write.withdraw([200n, parseEther("40")], { account: bob.account });

      // Alice's price 100 (weight 50) now overtakes Bob's price 200 (weight 40)
      const [leadAfter, weightAfter] = await voting.read.leader();
      assert.equal(leadAfter, 100n);
      assert.equal(weightAfter, parseEther("50"));

      // Voting period concludes
      await passDeadline();

      // Finalize the election
      await viem.assertions.emitWithArgs(voting.write.finalize(), voting, "PriceFinalized", [
        100n,
        parseEther("50"),
      ]);

      // Assert winningPrice and currentTokenPrice reflect the overtaken winner (price 100)
      assert.equal(await voting.read.winningPrice(), 100n);
      assert.equal(await voting.read.currentTokenPrice(), 100n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("asserts the final winning price after a mid-voting withdrawAll causes the runner-up to win", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      // Alice votes 60 for price 150
      await voting.write.vote([150n, parseEther("60")], { account: alice.account });
      // Bob votes 100 for price 300, leading the race
      await voting.write.vote([300n, parseEther("100")], { account: bob.account });

      // Bob changes his mind and withdraws all his tokens during voting
      await voting.write.withdrawAll({ account: bob.account });

      // Price 150 is now the lone active leader
      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 150n);
      assert.equal(leadWeight, parseEther("60"));

      // Pass deadline and finalize
      await passDeadline();
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 150n);
      assert.equal(await voting.read.currentTokenPrice(), 150n);
    });

    it("finalizes with 0 when there are no votes", async function () {
      const { voting } = await networkHelpers.loadFixture(deployFixture);

      await passDeadline();
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("finalizes with 0 when there is a tie", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });
      await passDeadline();

      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("allows post-votingEnd withdrawals and preserves the winning election result", async function () {
      const { token, voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await passDeadline();

      // Alice withdraws her tokens after deadline has passed
      await voting.write.withdraw([100n, parseEther("100")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);

      // Finalize should still reflect the election winner from the voting period!
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 100n);
    });

    it("allows claim() after votingEnd as an alias to withdrawAll()", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await passDeadline();

      await voting.write.claim({ account: alice.account });

      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);

      await assert.rejects(voting.write.claim({ account: alice.account }), /NothingToClaim/);
    });
  });
});
