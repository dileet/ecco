import { describe, it } from "node:test";
import { expect } from "chai";
import { parseEther, zeroAddress } from "viem";
import { deployEccoTokenFixture, getNetworkHelpers } from "./helpers/fixtures";
import { MAX_SUPPLY } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("EccoToken", () => {
  describe("Deployment", () => {
    it("should set correct owner", async () => {
      const { eccoToken, owner } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      expect((await eccoToken.read.owner()).toLowerCase()).to.equal(
        owner.account.address.toLowerCase()
      );
    });

    it("should have correct MAX_SUPPLY constant", async () => {
      const { eccoToken } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      expect(await eccoToken.read.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
    });
  });

  describe("Minting", () => {
    it("should allow owner to mint tokens", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);

      expect(await eccoToken.read.balanceOf([user1.account.address])).to.equal(amount);
      expect(await eccoToken.read.totalSupply()).to.equal(amount);
    });

    it("should reject mint from non-owner", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      try {
        await eccoToken.write.mint([user2.account.address, amount], {
          account: user1.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });

    it("should allow minting up to MAX_SUPPLY", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);

      await eccoToken.write.mint([user1.account.address, MAX_SUPPLY]);

      expect(await eccoToken.read.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("should reject minting that exceeds MAX_SUPPLY", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);

      await eccoToken.write.mint([user1.account.address, MAX_SUPPLY]);

      try {
        await eccoToken.write.mint([user1.account.address, 1n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/max supply exceeded/);
      }
    });
  });

  describe("ERC20 Transfers", () => {
    it("should transfer tokens between accounts", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.transfer([user2.account.address, amount], {
        account: user1.account,
      });

      expect(await eccoToken.read.balanceOf([user1.account.address])).to.equal(0n);
      expect(await eccoToken.read.balanceOf([user2.account.address])).to.equal(amount);
    });

    it("should fail transfer when sender has insufficient balance", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      try {
        await eccoToken.write.transfer([user2.account.address, amount], {
          account: user1.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/ERC20InsufficientBalance/);
      }
    });
  });

  describe("ERC20 Approvals", () => {
    it("should approve tokens for delegated transfer", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.approve([user2.account.address, amount], {
        account: user1.account,
      });

      expect(
        await eccoToken.read.allowance([user1.account.address, user2.account.address])
      ).to.equal(amount);
    });

    it("should transfer tokens via transferFrom", async () => {
      const { eccoToken, user1, user2, user3 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.approve([user2.account.address, amount], {
        account: user1.account,
      });
      await eccoToken.write.transferFrom(
        [user1.account.address, user3.account.address, amount],
        { account: user2.account }
      );

      expect(await eccoToken.read.balanceOf([user3.account.address])).to.equal(amount);
    });

    it("should fail transferFrom when allowance is exceeded", async () => {
      const { eccoToken, user1, user2, user3 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.approve([user2.account.address, amount / 2n], {
        account: user1.account,
      });

      try {
        await eccoToken.write.transferFrom(
          [user1.account.address, user3.account.address, amount],
          { account: user2.account }
        );
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/ERC20InsufficientAllowance/);
      }
    });
  });

  describe("ERC20Burnable", () => {
    it("should allow token holders to burn their tokens", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.burn([amount / 2n], { account: user1.account });

      expect(await eccoToken.read.balanceOf([user1.account.address])).to.equal(amount / 2n);
      expect(await eccoToken.read.totalSupply()).to.equal(amount / 2n);
    });

    it("should allow burning via burnFrom with approval", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.approve([user2.account.address, amount], {
        account: user1.account,
      });
      await eccoToken.write.burnFrom([user1.account.address, amount / 2n], {
        account: user2.account,
      });

      expect(await eccoToken.read.balanceOf([user1.account.address])).to.equal(amount / 2n);
    });

    it("should reject burnFrom without approval", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);

      try {
        await eccoToken.write.burnFrom([user1.account.address, amount], {
          account: user2.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/ERC20InsufficientAllowance/);
      }
    });
  });

  describe("ERC20Votes", () => {
    it("should allow delegation to self", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.delegate([user1.account.address], {
        account: user1.account,
      });

      expect(await eccoToken.read.getVotes([user1.account.address])).to.equal(amount);
    });

    it("should allow delegation to another address", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.delegate([user2.account.address], {
        account: user1.account,
      });

      expect(await eccoToken.read.getVotes([user2.account.address])).to.equal(amount);
      expect(await eccoToken.read.getVotes([user1.account.address])).to.equal(0n);
    });

    it("should update votes when tokens are transferred", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);
      await eccoToken.write.delegate([user1.account.address], {
        account: user1.account,
      });
      await eccoToken.write.delegate([user2.account.address], {
        account: user2.account,
      });

      await eccoToken.write.transfer([user2.account.address, amount / 2n], {
        account: user1.account,
      });

      expect(await eccoToken.read.getVotes([user1.account.address])).to.equal(amount / 2n);
      expect(await eccoToken.read.getVotes([user2.account.address])).to.equal(amount / 2n);
    });

    it("should return current delegate", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);

      await eccoToken.write.delegate([user2.account.address], {
        account: user1.account,
      });

      expect(
        (await eccoToken.read.delegates([user1.account.address])).toLowerCase()
      ).to.equal(user2.account.address.toLowerCase());
    });

    it("should track votes via checkpoints", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);
      const amount = parseEther("1000");

      await eccoToken.write.mint([user1.account.address, amount]);

      expect(await eccoToken.read.getVotes([user1.account.address])).to.equal(0n);

      await eccoToken.write.delegate([user1.account.address], {
        account: user1.account,
      });

      expect(await eccoToken.read.getVotes([user1.account.address])).to.equal(amount);

      const checkpoints = await eccoToken.read.numCheckpoints([user1.account.address]);
      expect(checkpoints > 0n).to.equal(true);
    });
  });

  describe("Ownership", () => {
    it("should allow owner to transfer ownership", async () => {
      const { eccoToken, user1 } = await loadFixtureWithHelpers(deployEccoTokenFixture);

      await eccoToken.write.transferOwnership([user1.account.address]);

      expect(
        (await eccoToken.read.owner()).toLowerCase()
      ).to.equal(user1.account.address.toLowerCase());
    });

    it("should reject ownership transfer by non-owner", async () => {
      const { eccoToken, user1, user2 } = await loadFixtureWithHelpers(deployEccoTokenFixture);

      try {
        await eccoToken.write.transferOwnership([user2.account.address], {
          account: user1.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });

    it("should allow owner to renounce ownership", async () => {
      const { eccoToken } = await loadFixtureWithHelpers(deployEccoTokenFixture);

      await eccoToken.write.renounceOwnership();

      expect(
        (await eccoToken.read.owner()).toLowerCase()
      ).to.equal(zeroAddress.toLowerCase());
    });
  });
});
