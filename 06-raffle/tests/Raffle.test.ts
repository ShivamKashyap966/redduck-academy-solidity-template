import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, getAddress } from "viem";

const { viem, networkHelpers } = await network.connect();

const KEY_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const CALLBACK_GAS = 500_000;

// Starter test: the happy path end to end — two deposits, time travel to the
// deadline, a forced VRF response, and a claim. It fails until deposit,
// drawWinner, fulfillRandomWords, and claim work. Don't edit it. Add tests for
// the failure modes and the weighted-pick boundaries in a separate file.
describe("Raffle", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const btc = await viem.deployContract("Token", ["Bitcoin", "BTC", parseEther("1000000")]);
    const feed = await viem.deployContract("PriceFeedMock", [8, 60_000n * 10n ** 8n]);

    const coord = await viem.deployContract("VRFCoordinatorMock", [
      10n ** 17n,
      10n ** 9n,
      10n ** 15n,
    ]);

    await coord.write.createSubscription();
    const [created] = await coord.getEvents.SubscriptionCreated({}, { fromBlock: 0n });
    const subId = created.args.subId as bigint;
    await coord.write.fundSubscription([subId, parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const drawTime = BigInt(now + 600);

    const raffle = await viem.deployContract("Raffle", [
      btc.address,
      feed.address,
      drawTime,
      coord.address,
      subId,
      KEY_HASH,
      CALLBACK_GAS,
    ]);
    await coord.write.addConsumer([subId, raffle.address]);

    for (const w of [alice, bob, carol]) {
      await btc.write.transfer([w.account.address, parseEther("100")]);
      await btc.write.approve([raffle.address, parseEther("100")], { account: w.account });
    }

    return { btc, feed, coord, raffle, subId, drawTime, deployer, alice, bob, carol };
  }

  it("runs the full raffle: deposit, draw, weighted winner, claim", async function () {
    const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

    // Entry 0: alice (weight 1 BTC). Entry 1: bob (weight 3 BTC).
    await raffle.write.deposit([parseEther("1")], { account: alice.account });
    await raffle.write.deposit([parseEther("3")], { account: bob.account });

    await networkHelpers.time.increaseTo(drawTime);
    await raffle.write.drawWinner();

    const requestId = (await raffle.read.requestId()) as bigint;
    const totalWeight = (await raffle.read.totalWeight()) as bigint;

    // A random word at the top of the range lands in bob's entry (index 1).
    await coord.write.fulfillRandomWordsWithOverride([
      requestId,
      raffle.address,
      [totalWeight - 1n],
    ]);

    const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
    await raffle.write.claim([1n], { account: bob.account });
    const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

    assert.equal(after - before, parseEther("4"));
  });

  describe("deposit & entry-time pricing", function () {
    it("preserves entry-time valuation when the price feed moves later", async function () {
      const { feed, raffle, alice, bob } = await deployFixture();

      // Alice enters when BTC is $60,000 -> 1 BTC = $60,000 weight
      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      const [alicePlayer, aliceAmt, aliceWeight] = await raffle.read.getEntry([0n]);
      assert.equal(aliceWeight, 60_000n * parseEther("1"));

      // Price jumps to $120,000
      await feed.write.updateAnswer([120_000n * 10n ** 8n]);

      // Bob enters when BTC is $120,000 -> 1 BTC = $120,000 weight
      await raffle.write.deposit([parseEther("1")], { account: bob.account });
      const [bobPlayer, bobAmt, bobWeight] = await raffle.read.getEntry([1n]);
      assert.equal(bobWeight, 120_000n * parseEther("1"));

      // Alice's entry-time weight remains completely unchanged
      const [, , aliceWeightAfter] = await raffle.read.getEntry([0n]);
      assert.equal(aliceWeightAfter, 60_000n * parseEther("1"));
      assert.equal(await raffle.read.totalWeight(), 180_000n * parseEther("1"));
    });

    it("emits Deposited event with player, amount, and weight", async function () {
      const { raffle, alice } = await deployFixture();

      const expectedWeight = 60_000n * parseEther("1");
      await viem.assertions.emitWithArgs(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        raffle,
        "Deposited",
        [getAddress(alice.account.address), parseEther("1"), expectedWeight],
      );
    });

    it("maintains running total of deposited tokens", async function () {
      const { raffle, alice, bob } = await deployFixture();
      assert.equal(await raffle.read.totalDeposited(), 0n);
      assert.equal(await raffle.read.totalDeposits(), 0n);

      await raffle.write.deposit([parseEther("2")], { account: alice.account });
      assert.equal(await raffle.read.totalDeposited(), parseEther("2"));
      assert.equal(await raffle.read.totalDeposits(), parseEther("2"));

      await raffle.write.deposit([parseEther("5")], { account: bob.account });
      assert.equal(await raffle.read.totalDeposited(), parseEther("7"));
      assert.equal(await raffle.read.totalDeposits(), parseEther("7"));
    });

    it("reverts deposit when amount is 0", async function () {
      const { raffle, alice } = await deployFixture();

      await assert.rejects(raffle.write.deposit([0n], { account: alice.account }), /ZeroAmount/);
    });

    it("reverts deposit after deadline has passed", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await networkHelpers.time.increaseTo(drawTime);

      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /RaffleClosed/,
      );
    });

    it("reverts deposit once drawWinner has been requested", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();

      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /RaffleClosed/,
      );
    });

    it("reverts deposit when price feed reports non-positive price", async function () {
      const { feed, raffle, alice } = await deployFixture();

      await feed.write.updateAnswer([0n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );

      await feed.write.updateAnswer([-100n]);
      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /InvalidPrice/,
      );
    });

    it("reverts deposit when price feed data is stale (older than MAX_PRICE_AGE)", async function () {
      const { feed, raffle, alice } = await deployFixture();

      const now = await networkHelpers.time.latest();
      // Price updated 2 hours ago (> 1 hour MAX_PRICE_AGE)
      await feed.write.updateRoundData([1n, 60_000n * 10n ** 8n, BigInt(now - 7200), 1n]);

      await assert.rejects(
        raffle.write.deposit([parseEther("1")], { account: alice.account }),
        /StalePrice/,
      );
    });
  });

  describe("drawWinner & VRF lifecycle", function () {
    it("reverts drawWinner before drawTime", async function () {
      const { raffle, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });

      await assert.rejects(raffle.write.drawWinner(), /RaffleClosed/);
    });

    it("reverts drawWinner when no deposits have been made", async function () {
      const { raffle, drawTime } = await deployFixture();

      await networkHelpers.time.increaseTo(drawTime);

      await assert.rejects(raffle.write.drawWinner(), /NoDeposits/);
    });

    it("reverts drawWinner if called twice", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();

      await assert.rejects(raffle.write.drawWinner(), /DrawAlreadyRequested/);
    });

    it("tracks requestId and emits DrawRequested", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);

      await viem.assertions.emitWithArgs(raffle.write.drawWinner(), raffle, "DrawRequested", [1n]);
      assert.equal(await raffle.read.requestId(), 1n);
      assert.equal(await raffle.read.drawRequested(), true);
      assert.equal(await raffle.read.randomnessFulfilled(), false);
    });

    it("rejects unauthorized fulfillment calls not coming from the VRF coordinator", async function () {
      const { raffle, drawTime, alice, deployer } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();

      // Deployer directly calling rawFulfillRandomWords must revert
      await assert.rejects(
        raffle.write.rawFulfillRandomWords([1n, [12345n]], { account: deployer.account }),
        /OnlyCoordinatorCanFulfill/,
      );
    });
  });

  describe("weighted winner selection boundaries", function () {
    it("selects Entry 0 when random word lands at the very bottom (0)", async function () {
      const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Random word 0 lands in Entry 0 (Alice)
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [0n]]);

      const before = (await btc.read.balanceOf([alice.account.address])) as bigint;
      await raffle.write.claim([0n], { account: alice.account });
      const after = (await btc.read.balanceOf([alice.account.address])) as bigint;

      assert.equal(after - before, parseEther("4"));
    });

    it("selects Entry 1 when random word lands on the exact boundary (Alice weight)", async function () {
      const { btc, coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      const [, , aliceWeight] = await raffle.read.getEntry([0n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Random word equal to aliceWeight lands at the first point of Entry 1 (Bob)
      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [aliceWeight]]);

      const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
      await raffle.write.claim([1n], { account: bob.account });
      const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

      assert.equal(after - before, parseEther("4"));
    });

    it("supports 3 players and correctly resolves middle entry", async function () {
      const { btc, coord, raffle, drawTime, alice, bob, carol } = await deployFixture();

      // Alice: 1 BTC ($60k), Bob: 2 BTC ($120k), Carol: 3 BTC ($180k). Total = $360k
      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("2")], { account: bob.account });
      await raffle.write.deposit([parseEther("3")], { account: carol.account });

      const [, , aliceWeight] = await raffle.read.getEntry([0n]);

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Random word lands right in Bob's range
      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [aliceWeight + 100n],
      ]);

      const before = (await btc.read.balanceOf([bob.account.address])) as bigint;
      await raffle.write.claim([1n], { account: bob.account });
      const after = (await btc.read.balanceOf([bob.account.address])) as bigint;

      assert.equal(after - before, parseEther("6"));
    });
  });

  describe("claim verification & security", function () {
    it("reverts claim before randomness is fulfilled", async function () {
      const { raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();

      await assert.rejects(raffle.write.claim([0n], { account: alice.account }), /InvalidClaim/);
    });

    it("reverts claim when non-winning entry index is submitted", async function () {
      const { coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Random word lands in Bob's entry (1)
      const totalWeight = (await raffle.read.totalWeight()) as bigint;
      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [totalWeight - 1n],
      ]);

      // Alice tries to claim entry 0 (which did not win)
      await assert.rejects(raffle.write.claim([0n], { account: alice.account }), /InvalidClaim/);
    });

    it("reverts claim when caller attempts to claim someone else's winning entry", async function () {
      const { coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await raffle.write.deposit([parseEther("3")], { account: bob.account });

      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      // Random word lands in Bob's entry (1)
      const totalWeight = (await raffle.read.totalWeight()) as bigint;
      await coord.write.fulfillRandomWordsWithOverride([
        requestId,
        raffle.address,
        [totalWeight - 1n],
      ]);

      // Alice tries to call claim(1) for Bob's winning entry
      await assert.rejects(raffle.write.claim([1n], { account: alice.account }), /InvalidClaim/);
    });

    it("reverts claim when entryIndex is out of bounds", async function () {
      const { coord, raffle, drawTime, alice, bob } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [0n]]);

      await assert.rejects(raffle.write.claim([999n], { account: alice.account }), /InvalidClaim/);
    });

    it("reverts duplicate claims after prize has been paid out", async function () {
      const { coord, raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [0n]]);

      // First claim succeeds
      await raffle.write.claim([0n], { account: alice.account });

      // Second claim must revert
      await assert.rejects(raffle.write.claim([0n], { account: alice.account }), /InvalidClaim/);
    });

    it("persists the winning address in state variable on claim", async function () {
      const { coord, raffle, drawTime, alice } = await deployFixture();

      await raffle.write.deposit([parseEther("1")], { account: alice.account });
      await networkHelpers.time.increaseTo(drawTime);
      await raffle.write.drawWinner();
      const requestId = (await raffle.read.requestId()) as bigint;

      await coord.write.fulfillRandomWordsWithOverride([requestId, raffle.address, [0n]]);

      assert.equal(await raffle.read.winner(), "0x0000000000000000000000000000000000000000");
      assert.equal(await raffle.read.getWinner(), "0x0000000000000000000000000000000000000000");

      await raffle.write.claim([0n], { account: alice.account });

      assert.equal(getAddress(await raffle.read.winner()), getAddress(alice.account.address));
      assert.equal(getAddress(await raffle.read.getWinner()), getAddress(alice.account.address));
    });
  });
});
