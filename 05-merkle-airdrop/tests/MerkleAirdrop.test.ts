import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, getAddress } from "viem";
import { MerkleTree, type AirdropEntry } from "./merkle.ts";
import { signAirdropClaim } from "./signatures.ts";

const { viem } = await network.connect();

describe("MerkleAirdrop", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, signer, dave, eve] = await viem.getWalletClients();

    const entries: AirdropEntry[] = [
      { account: getAddress(alice.account.address), amount: parseEther("100") },
      { account: getAddress(bob.account.address), amount: parseEther("200") },
      { account: getAddress(carol.account.address), amount: parseEther("300") },
      { account: getAddress(eve.account.address), amount: parseEther("50") },
    ];
    const tree = new MerkleTree(entries);

    const token = await viem.deployContract("Token", [
      "Redduck Token",
      "RDDK",
      parseEther("100000000000000"),
    ]);
    const airdrop = await viem.deployContract("MerkleAirdrop", [
      token.address,
      tree.root,
      signer.account.address,
    ]);

    await token.write.transfer([airdrop.address, parseEther("100000000000000")], {
      account: deployer.account,
    });

    return { entries, tree, token, airdrop, deployer, alice, bob, carol, signer, dave, eve };
  }

  // Starter happy-path tests
  it("lets an eligible account claim its allocation with a Merkle proof", async function () {
    const { entries, tree, token, airdrop, alice } = await deployFixture();

    const proof = tree.getProof(0);
    const { account, amount } = entries[0];

    await airdrop.write.claim([amount, proof], { account: alice.account });

    assert.equal((await token.read.balanceOf([account])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([account])) as boolean, true);
  });

  it("lets an authorized account claim with an admin signature (not on the Merkle list)", async function () {
    const { token, airdrop, signer, dave } = await deployFixture();

    const daveAddr = getAddress(dave.account.address);
    const amount = parseEther("50");

    const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount);

    await airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account });

    assert.equal((await token.read.balanceOf([daveAddr])) as bigint, amount);
    assert.equal((await airdrop.read.hasClaimed([daveAddr])) as boolean, true);
  });

  describe("Merkle proof verification and failures", function () {
    it("emits Claimed event on successful Merkle claim", async function () {
      const { entries, tree, airdrop, alice } = await deployFixture();

      const proof = tree.getProof(0);
      const { account, amount } = entries[0];

      await viem.assertions.emitWithArgs(
        airdrop.write.claim([amount, proof], { account: alice.account }),
        airdrop,
        "Claimed",
        [account, amount],
      );
    });

    it("reverts with AlreadyClaimed if an account attempts to claim twice via Merkle proof", async function () {
      const { entries, tree, airdrop, alice } = await deployFixture();

      const proof = tree.getProof(0);
      const { amount } = entries[0];

      await airdrop.write.claim([amount, proof], { account: alice.account });

      await assert.rejects(
        airdrop.write.claim([amount, proof], { account: alice.account }),
        /AlreadyClaimed/,
      );
    });

    it("reverts with InvalidProof if proof is used by another account", async function () {
      const { entries, tree, airdrop, dave } = await deployFixture();

      // Alice's proof used by Dave (who is not on the list)
      const proof = tree.getProof(0);
      const { amount } = entries[0];

      await assert.rejects(
        airdrop.write.claim([amount, proof], { account: dave.account }),
        /InvalidProof/,
      );
    });

    it("reverts with InvalidProof if claimed amount differs from leaf amount", async function () {
      const { tree, airdrop, alice } = await deployFixture();

      const proof = tree.getProof(0);
      const tamperedAmount = parseEther("101");

      await assert.rejects(
        airdrop.write.claim([tamperedAmount, proof], { account: alice.account }),
        /InvalidProof/,
      );
    });

    it("reverts with InvalidProof if proof elements are corrupted", async function () {
      const { entries, tree, airdrop, alice } = await deployFixture();

      const proof = tree.getProof(0);
      proof[0] = "0x0000000000000000000000000000000000000000000000000000000000000001";
      const { amount } = entries[0];

      await assert.rejects(
        airdrop.write.claim([amount, proof], { account: alice.account }),
        /InvalidProof/,
      );
    });

    it("reverts with InvalidProof if an empty proof is provided", async function () {
      const { entries, airdrop, alice } = await deployFixture();
      const { amount } = entries[0];

      await assert.rejects(
        airdrop.write.claim([amount, []], { account: alice.account }),
        /InvalidProof/,
      );
    });

    it("supports multiple eligible accounts claiming independently", async function () {
      const { entries, tree, token, airdrop, alice, bob, carol } = await deployFixture();

      await airdrop.write.claim([entries[0].amount, tree.getProof(0)], { account: alice.account });
      await airdrop.write.claim([entries[1].amount, tree.getProof(1)], { account: bob.account });
      await airdrop.write.claim([entries[2].amount, tree.getProof(2)], { account: carol.account });

      assert.equal(await token.read.balanceOf([entries[0].account]), entries[0].amount);
      assert.equal(await token.read.balanceOf([entries[1].account]), entries[1].amount);
      assert.equal(await token.read.balanceOf([entries[2].account]), entries[2].amount);
    });
  });

  describe("signature verification and failure modes", function () {
    it("emits Claimed event on successful signature claim", async function () {
      const { airdrop, signer, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

      await viem.assertions.emitWithArgs(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        airdrop,
        "Claimed",
        [daveAddr, amount],
      );
    });

    it("reverts with AlreadyClaimed if an account attempts to claim twice with signature", async function () {
      const { airdrop, signer, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

      await airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account });

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /AlreadyClaimed/,
      );
    });

    it("reverts with InvalidSignature when signature comes from an untrusted signer", async function () {
      const { airdrop, eve, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      // Eve (not the authorized signer) signs the authorization
      const { v, r, s } = await signAirdropClaim(eve, daveAddr, amount, airdrop.address);

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature when another caller attempts to use someone else's signature", async function () {
      const { airdrop, signer, dave, carol } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      // Signature produced for Dave
      const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

      // Carol attempts to call claimWithSignature with Dave's signature
      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, s], { account: carol.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature if amount is tampered with", async function () {
      const { airdrop, signer, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const authorizedAmount = parseEther("50");
      const tamperedAmount = parseEther("500");

      const { v, r, s } = await signAirdropClaim(
        signer,
        daveAddr,
        authorizedAmount,
        airdrop.address,
      );

      await assert.rejects(
        airdrop.write.claimWithSignature([tamperedAmount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature when replaying a signature against another airdrop deployment", async function () {
      const { token, tree, signer, dave } = await deployFixture();

      // Deploy second airdrop contract
      const airdrop1 = await viem.deployContract("MerkleAirdrop", [
        token.address,
        tree.root,
        signer.account.address,
      ]);
      const airdrop2 = await viem.deployContract("MerkleAirdrop", [
        token.address,
        tree.root,
        signer.account.address,
      ]);

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");

      // Signature specifically authorizing airdrop1
      const { v, r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop1.address);

      // Attempting to replay that signature against airdrop2 must fail
      await assert.rejects(
        airdrop2.write.claimWithSignature([amount, v, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature if v is neither 27 nor 28", async function () {
      const { airdrop, signer, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      const { r, s } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, 29, r, s], { account: dave.account }),
        /InvalidSignature/,
      );
    });

    it("reverts with InvalidSignature if s is malleable (upper half of secp256k1 curve)", async function () {
      const { airdrop, signer, dave } = await deployFixture();

      const daveAddr = getAddress(dave.account.address);
      const amount = parseEther("50");
      const { v, r } = await signAirdropClaim(signer, daveAddr, amount, airdrop.address);

      // Malleable s (greater than curve order N / 2)
      const invalidS =
        "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1" as const;

      await assert.rejects(
        airdrop.write.claimWithSignature([amount, v, r, invalidS], { account: dave.account }),
        /InvalidSignature/,
      );
    });
  });

  describe("shared hasClaimed invariant across both paths", function () {
    it("an account that claims via Merkle proof cannot claim via signature", async function () {
      const { entries, tree, airdrop, alice, signer } = await deployFixture();

      const aliceAddr = getAddress(alice.account.address);
      const merkleAmount = entries[0].amount;
      const sigAmount = parseEther("50");

      // Alice claims her Merkle allocation
      await airdrop.write.claim([merkleAmount, tree.getProof(0)], { account: alice.account });
      assert.equal(await airdrop.read.hasClaimed([aliceAddr]), true);

      // Alice now attempts to claim via signature
      const { v, r, s } = await signAirdropClaim(signer, aliceAddr, sigAmount, airdrop.address);
      await assert.rejects(
        airdrop.write.claimWithSignature([sigAmount, v, r, s], { account: alice.account }),
        /AlreadyClaimed/,
      );
    });

    it("an account that claims via signature cannot claim via Merkle proof", async function () {
      const { entries, tree, airdrop, alice, signer } = await deployFixture();

      const aliceAddr = getAddress(alice.account.address);
      const sigAmount = parseEther("50");
      const merkleAmount = entries[0].amount;

      // Alice claims via signature first
      const { v, r, s } = await signAirdropClaim(signer, aliceAddr, sigAmount, airdrop.address);
      await airdrop.write.claimWithSignature([sigAmount, v, r, s], { account: alice.account });
      assert.equal(await airdrop.read.hasClaimed([aliceAddr]), true);

      // Alice now attempts to claim via Merkle proof
      await assert.rejects(
        airdrop.write.claim([merkleAmount, tree.getProof(0)], { account: alice.account }),
        /AlreadyClaimed/,
      );
    });
  });
});
