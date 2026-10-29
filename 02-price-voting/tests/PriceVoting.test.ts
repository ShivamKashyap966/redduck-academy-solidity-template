import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, maxUint256, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

// Starter tests. These two show the deploy/vote pattern and pass once the
// contract is implemented. Add the rest of the scenarios listed in TASK.md
// (weight stacking, leader updates, ties, the finalize/claim rules, and the
// revert cases) in this file.
describe("PriceVoting", function () {
  async function deployVotingFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVoting", [token.address, votingEnd]);

    // give voters some tokens and approve the voting contract
    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], { account: w.account });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  // Move the chain to strictly past votingEnd so finalize/claim become valid.
  async function passDeadline() {
    await networkHelpers.time.increase(ONE_DAY);
  }

  describe("deployment & setup", function () {
    it("deploys the token with its metadata and full supply", async function () {
      const { token, deployer } = await networkHelpers.loadFixture(deployVotingFixture);

      assert.equal(await token.read.name(), "Vote Token");
      assert.equal(await token.read.symbol(), "VOTE");
      assert.equal(await token.read.totalSupply(), parseEther("1000000"));
      // fixture funds alice/bob/carol with 1000 each; the rest stays with the deployer
      assert.equal(await token.read.balanceOf([deployer.account.address]), parseEther("997000"));
    });

    it("stores the token reference and the voting deadline", async function () {
      const { token, voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);

      assert.equal(getAddress(await voting.read.token()), getAddress(token.address));
      assert.equal(await voting.read.votingEnd(), votingEnd);
    });

    it("starts with no votes, no leader, no price, and not finalized", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 0n);
      assert.equal(leadWeight, 0n);
      assert.equal(await voting.read.weightOf([1n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
      assert.equal(await voting.read.finalized(), false);
    });
  });

  describe("vote", function () {
    it("records a single vote", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
    });

    it("emits Voted", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );
    });

    it("stacks weight when two voters back the same price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([100n, parseEther("70")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("120"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([bob.account.address]), parseEther("70"));

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("120"));
    });

    it("splits one voter's stake across prices and grows their locked balance", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("40"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("60"));
      // her wallet gave up exactly the locked amount; supply is unchanged
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("900"));
      assert.equal(await token.read.totalSupply(), parseEther("1000000"));
    });

    it("supports arbitrary uint256 prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);
      const hugePrice = 2n ** 255n + 123456789n;

      await voting.write.vote([hugePrice, parseEther("100")], { account: alice.account });
      await voting.write.vote([maxUint256, parseEther("50")], { account: bob.account });

      assert.equal(await voting.read.weightOf([hugePrice]), parseEther("100"));
      assert.equal(await voting.read.weightOf([maxUint256]), parseEther("50"));

      // the huge price has more weight, so it must win after the deadline
      await passDeadline();
      await voting.write.finalize();
      assert.equal(await voting.read.currentTokenPrice(), hugePrice);
    });

    it("reverts when called after votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await passDeadline();

      await assert.rejects(
        voting.write.vote([100n, parseEther("1")], { account: alice.account }),
        /VotingEnded/,
      );
    });

    it("reverts when called exactly at votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.setNextBlockTimestamp(Number(votingEnd));

      await assert.rejects(
        voting.write.vote([100n, parseEther("1")], { account: alice.account }),
        /VotingEnded/,
      );
    });

    it("reverts with an amount of zero", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(voting.write.vote([100n, 0n], { account: alice.account }), /ZeroAmount/);
    });

    it("reverts when the caller has not approved enough tokens", async function () {
      const { voting, deployer } = await networkHelpers.loadFixture(deployVotingFixture);

      // the deployer holds plenty of tokens but never approved the contract
      await assert.rejects(
        voting.write.vote([100n, parseEther("1")], { account: deployer.account }),
        /TransferFailed/,
      );
      assert.equal(await voting.read.weightOf([100n]), 0n);
    });

    it("reverts when the voter's token balance is insufficient", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      // alice approves far more than she owns (1000 tokens) ...
      await token.write.approve([voting.address, parseEther("1000000")], {
        account: alice.account,
      });

      // ... so the allowance check passes but her balance cannot cover it
      await assert.rejects(
        voting.write.vote([100n, parseEther("1001")], { account: alice.account }),
        /TransferFailed/,
      );
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
    });
  });

  describe("leader", function () {
    it("gives the lead to the price with more total weight", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("300")], { account: bob.account });

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("300"));
    });

    it("updates the leader when a new vote overtakes it", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      let [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("50"));

      await voting.write.vote([200n, parseEther("60")], { account: bob.account });

      [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("60"));
    });

    it("does not update the leader on a tie", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("50"));
      // both prices really do hold the same weight
      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("50"));
    });
  });

  describe("finalize", function () {
    it("reverts when called before votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(voting.write.finalize(), /VotingActive/);
      assert.equal(await voting.read.finalized(), false);
    });

    it("reverts when called twice", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await passDeadline();
      await voting.write.finalize();

      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });

    it("sets the winning price, marks finalized, and emits PriceFinalized", async function () {
      const { voting, alice, bob, carol } = await networkHelpers.loadFixture(deployVotingFixture);

      // 100 collects 100 + 50 = 150; 200 collects 300 and wins
      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("300")], { account: bob.account });
      await voting.write.vote([100n, parseEther("50")], { account: carol.account });
      await passDeadline();

      await viem.assertions.emitWithArgs(voting.write.finalize(), voting, "PriceFinalized", [
        200n,
        parseEther("300"),
      ]);

      assert.equal(await voting.read.currentTokenPrice(), 200n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("works exactly at votingEnd", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);

      await networkHelpers.time.setNextBlockTimestamp(Number(votingEnd));
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("succeeds with no votes and leaves the price at 0", async function () {
      const { voting } = await networkHelpers.loadFixture(deployVotingFixture);

      await passDeadline();
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("succeeds on a tie and leaves the price at 0", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });
      await passDeadline();
      await voting.write.finalize();

      assert.equal(await voting.read.finalized(), true);
      assert.equal(await voting.read.currentTokenPrice(), 0n);
    });

    it("uses vote-time weights even if everyone claimed first", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await passDeadline();

      // claims do not erase the recorded weights — they are a vote tally
      await voting.write.claim({ account: alice.account });
      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 100n);
      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 100n);
      assert.equal(leadWeight, parseEther("50"));
    });
  });

  describe("claim", function () {
    it("reverts during the voting period — no mid-voting withdrawal", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(voting.write.claim({ account: alice.account }), /VotingActive/);
      // the tokens are still locked after the failed withdrawal
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
    });

    it("reverts when the caller has nothing locked", async function () {
      const { voting, bob } = await networkHelpers.loadFixture(deployVotingFixture);

      await passDeadline();

      await assert.rejects(voting.write.claim({ account: bob.account }), /NothingToClaim/);
    });

    it("returns the locked tokens, zeros the balance, and emits Claimed", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("950"));
      await passDeadline();

      await viem.assertions.emitWithArgs(
        voting.write.claim({ account: alice.account }),
        voting,
        "Claimed",
        [getAddress(alice.account.address), parseEther("50")],
      );

      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      // she was the only voter, so the contract is empty again
      assert.equal(await token.read.balanceOf([voting.address]), 0n);
    });

    it("cannot claim twice", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await passDeadline();
      await voting.write.claim({ account: alice.account });

      await assert.rejects(voting.write.claim({ account: alice.account }), /NothingToClaim/);
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
    });
  });
});
