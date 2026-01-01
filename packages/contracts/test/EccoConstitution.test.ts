import { describe, it } from "node:test";
import { expect } from "chai";
import { deployConstitutionFixture, getNetworkHelpers } from "./helpers/fixtures";
import { INITIAL_CONSTITUTION_ITEMS } from "./helpers/constants";

async function loadFixtureWithHelpers<T>(fixture: () => Promise<T>): Promise<T> {
  const networkHelpers = await getNetworkHelpers();
  return networkHelpers.loadFixture(fixture);
}

describe("EccoConstitution", () => {
  describe("Deployment", () => {
    it("should set correct owner", async () => {
      const { eccoConstitution, owner } = await loadFixtureWithHelpers(deployConstitutionFixture);
      expect((await eccoConstitution.read.owner()).toLowerCase()).to.equal(
        owner.account.address.toLowerCase()
      );
    });

    it("should set initial items", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const items = await eccoConstitution.read.getAllItems();
      expect(items.length).to.equal(INITIAL_CONSTITUTION_ITEMS.length);
      for (let i = 0; i < items.length; i++) {
        expect(items[i]).to.equal(INITIAL_CONSTITUTION_ITEMS[i]);
      }
    });

    it("should have correct item count", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      expect(await eccoConstitution.read.getItemCount()).to.equal(BigInt(INITIAL_CONSTITUTION_ITEMS.length));
    });

    it("should mark initial items as existing content", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      for (const item of INITIAL_CONSTITUTION_ITEMS) {
        expect(await eccoConstitution.read.contentExists([item])).to.equal(true);
      }
    });
  });

  describe("Adding Items", () => {
    it("should allow owner to add items", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const newItem = "New constitution rule";

      await eccoConstitution.write.addItem([newItem]);

      const items = await eccoConstitution.read.getAllItems();
      expect(items[items.length - 1]).to.equal(newItem);
    });

    it("should return the index of newly added item", async () => {
      const { eccoConstitution, publicClient } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const newItem = "New constitution rule";

      const hash = await eccoConstitution.write.addItem([newItem]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const itemCount = await eccoConstitution.read.getItemCount();
      expect(itemCount).to.equal(BigInt(INITIAL_CONSTITUTION_ITEMS.length + 1));
    });

    it("should reject adding items from non-owner", async () => {
      const { eccoConstitution, user1 } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem(["New rule"], {
          account: user1.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });

    it("should reject empty content", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem([""]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Empty content/);
      }
    });

    it("should reject whitespace-only content", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem(["   "]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Empty content/);
      }
    });

    it("should reject tabs and newlines only", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem(["\t\n\r"]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Empty content/);
      }
    });

    it("should reject zero-width space unicode", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem(["\u200B"]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Empty content/);
      }
    });

    it("should reject non-breaking space unicode", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem(["\u00A0"]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Empty content/);
      }
    });

    it("should reject BOM character", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem(["\uFEFF"]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Empty content/);
      }
    });

    it("should accept content with leading/trailing whitespace", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const content = "  Valid content with spaces  ";

      await eccoConstitution.write.addItem([content]);

      const items = await eccoConstitution.read.getAllItems();
      expect(items[items.length - 1]).to.equal(content);
    });

    it("should reject duplicate content", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.addItem([INITIAL_CONSTITUTION_ITEMS[0]]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Duplicate content/);
      }
    });

    it("should emit ItemAdded event", async () => {
      const { eccoConstitution, publicClient } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const newItem = "New constitution rule";

      const hash = await eccoConstitution.write.addItem([newItem]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const logs = receipt.logs;
      expect(logs.length).to.be.greaterThan(0);
    });
  });

  describe("Removing Items", () => {
    it("should allow owner to remove items", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const initialCount = await eccoConstitution.read.getItemCount();

      await eccoConstitution.write.removeItem([0n]);

      const newCount = await eccoConstitution.read.getItemCount();
      expect(newCount).to.equal(initialCount - 1n);
    });

    it("should compact array after removal (swap with last)", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const lastItem = INITIAL_CONSTITUTION_ITEMS[INITIAL_CONSTITUTION_ITEMS.length - 1];

      await eccoConstitution.write.removeItem([0n]);

      const itemAtZero = await eccoConstitution.read.getItem([0n]);
      expect(itemAtZero).to.equal(lastItem);
    });

    it("should clear content existence after removal", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const removedItem = INITIAL_CONSTITUTION_ITEMS[0];

      await eccoConstitution.write.removeItem([0n]);

      expect(await eccoConstitution.read.contentExists([removedItem])).to.equal(false);
    });

    it("should allow re-adding removed content", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const removedItem = INITIAL_CONSTITUTION_ITEMS[0];

      await eccoConstitution.write.removeItem([0n]);
      await eccoConstitution.write.addItem([removedItem]);

      expect(await eccoConstitution.read.contentExists([removedItem])).to.equal(true);
    });

    it("should reject removing items from non-owner", async () => {
      const { eccoConstitution, user1 } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.removeItem([0n], {
          account: user1.account,
        });
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/OwnableUnauthorizedAccount/);
      }
    });

    it("should reject invalid index", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.write.removeItem([100n]);
        expect.fail("Expected transaction to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid index/);
      }
    });

    it("should emit ItemRemoved event", async () => {
      const { eccoConstitution, publicClient } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const hash = await eccoConstitution.write.removeItem([0n]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      const logs = receipt.logs;
      expect(logs.length).to.be.greaterThan(0);
    });

    it("should emit ItemMoved event when swapping during removal", async () => {
      const { eccoConstitution, publicClient } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const hash = await eccoConstitution.write.removeItem([0n]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      expect(receipt.logs.length).to.equal(2);
    });

    it("should not emit ItemMoved event when removing last item", async () => {
      const { eccoConstitution, publicClient } = await loadFixtureWithHelpers(deployConstitutionFixture);
      const lastIndex = BigInt(INITIAL_CONSTITUTION_ITEMS.length - 1);

      const hash = await eccoConstitution.write.removeItem([lastIndex]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      expect(receipt.logs.length).to.equal(1);
    });
  });

  describe("View Functions", () => {
    it("should get item by index", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      for (let i = 0; i < INITIAL_CONSTITUTION_ITEMS.length; i++) {
        const item = await eccoConstitution.read.getItem([BigInt(i)]);
        expect(item).to.equal(INITIAL_CONSTITUTION_ITEMS[i]);
      }
    });

    it("should reject getItem with invalid index", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.read.getItem([100n]);
        expect.fail("Expected read to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid index/);
      }
    });

    it("should get item ID by index", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      for (let i = 0; i < INITIAL_CONSTITUTION_ITEMS.length; i++) {
        const itemId = await eccoConstitution.read.getItemId([BigInt(i)]);
        expect(itemId).to.equal(BigInt(i));
      }
    });

    it("should reject getItemId with invalid index", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      try {
        await eccoConstitution.read.getItemId([100n]);
        expect.fail("Expected read to revert");
      } catch (error) {
        expect(String(error)).to.match(/Invalid index/);
      }
    });

    it("should get all items", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const items = await eccoConstitution.read.getAllItems();

      expect(items.length).to.equal(INITIAL_CONSTITUTION_ITEMS.length);
    });

    it("should get all item IDs", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const itemIds = await eccoConstitution.read.getAllItemIds();

      expect(itemIds.length).to.equal(INITIAL_CONSTITUTION_ITEMS.length);
      for (let i = 0; i < itemIds.length; i++) {
        expect(itemIds[i]).to.equal(BigInt(i));
      }
    });

    it("should get item count", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const count = await eccoConstitution.read.getItemCount();

      expect(count).to.equal(BigInt(INITIAL_CONSTITUTION_ITEMS.length));
    });

    it("should check content exists", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      expect(await eccoConstitution.read.contentExists([INITIAL_CONSTITUTION_ITEMS[0]])).to.equal(true);
      expect(await eccoConstitution.read.contentExists(["Non-existent content"])).to.equal(false);
    });

    it("should get items paginated", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const items = await eccoConstitution.read.getItemsPaginated([0n, 2n]);
      expect(items.length).to.equal(2);
      expect(items[0]).to.equal(INITIAL_CONSTITUTION_ITEMS[0]);
      expect(items[1]).to.equal(INITIAL_CONSTITUTION_ITEMS[1]);
    });

    it("should get items paginated with offset", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const items = await eccoConstitution.read.getItemsPaginated([1n, 2n]);
      expect(items.length).to.equal(2);
      expect(items[0]).to.equal(INITIAL_CONSTITUTION_ITEMS[1]);
      expect(items[1]).to.equal(INITIAL_CONSTITUTION_ITEMS[2]);
    });

    it("should return empty array when offset exceeds length", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const items = await eccoConstitution.read.getItemsPaginated([100n, 10n]);
      expect(items.length).to.equal(0);
    });

    it("should return remaining items when limit exceeds available", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const items = await eccoConstitution.read.getItemsPaginated([0n, 100n]);
      expect(items.length).to.equal(INITIAL_CONSTITUTION_ITEMS.length);
    });

    it("should get item IDs paginated", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const itemIds = await eccoConstitution.read.getItemIdsPaginated([0n, 2n]);
      expect(itemIds.length).to.equal(2);
      expect(itemIds[0]).to.equal(0n);
      expect(itemIds[1]).to.equal(1n);
    });

    it("should get item IDs paginated with offset", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const itemIds = await eccoConstitution.read.getItemIdsPaginated([1n, 2n]);
      expect(itemIds.length).to.equal(2);
      expect(itemIds[0]).to.equal(1n);
      expect(itemIds[1]).to.equal(2n);
    });

    it("should return empty array for item IDs when offset exceeds length", async () => {
      const { eccoConstitution } = await loadFixtureWithHelpers(deployConstitutionFixture);

      const itemIds = await eccoConstitution.read.getItemIdsPaginated([100n, 10n]);
      expect(itemIds.length).to.equal(0);
    });
  });

  describe("Ownership", () => {
    it("should allow owner to transfer ownership", async () => {
      const { eccoConstitution, user1 } = await loadFixtureWithHelpers(deployConstitutionFixture);

      await eccoConstitution.write.transferOwnership([user1.account.address]);

      expect(
        (await eccoConstitution.read.owner()).toLowerCase()
      ).to.equal(user1.account.address.toLowerCase());
    });

    it("should allow new owner to add items", async () => {
      const { eccoConstitution, user1 } = await loadFixtureWithHelpers(deployConstitutionFixture);

      await eccoConstitution.write.transferOwnership([user1.account.address]);
      await eccoConstitution.write.addItem(["New rule from new owner"], {
        account: user1.account,
      });

      const count = await eccoConstitution.read.getItemCount();
      expect(count).to.equal(BigInt(INITIAL_CONSTITUTION_ITEMS.length + 1));
    });
  });
});
