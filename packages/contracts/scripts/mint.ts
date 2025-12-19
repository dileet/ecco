import { network } from "hardhat";
import { formatEther, parseEther } from "viem";

async function main() {
  const connection = await network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();

  const eccoToken = await viem.getContractAt("EccoToken", "0x65304eef504ae67f821b42fd20e0e47dd5613c4d");

  const balanceBefore = await eccoToken.read.balanceOf([deployer.account.address]);
  console.log("Balance before:", formatEther(balanceBefore), "ECCO");

  console.log("Minting 1,000,000 ECCO to", deployer.account.address);
  await eccoToken.write.mint([deployer.account.address, parseEther("1000000")]);

  const balanceAfter = await eccoToken.read.balanceOf([deployer.account.address]);
  console.log("Balance after:", formatEther(balanceAfter), "ECCO");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
