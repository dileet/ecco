import { network } from "hardhat";
import { formatEther, parseEther } from "viem";

const AGENT_WALLET = "0x2Eb06551CE34Bc96397E4f02560ED7758255d6DD";
const AMOUNT = parseEther("1000");

async function main() {
  const connection = await network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const eccoToken = await viem.getContractAt("EccoToken", "0x65304eef504ae67f821b42fd20e0e47dd5613c4d");

  const deployerBalance = await eccoToken.read.balanceOf([deployer.account.address]) as bigint;
  console.log("Deployer balance:", formatEther(deployerBalance), "ECCO");

  console.log(`Transferring ${formatEther(AMOUNT)} ECCO to agent ${AGENT_WALLET}...`);
  const hash = await eccoToken.write.transfer([AGENT_WALLET, AMOUNT]);
  console.log("TX Hash:", hash);

  console.log("Waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash });

  const agentBalance = await eccoToken.read.balanceOf([AGENT_WALLET]) as bigint;
  console.log("Agent balance:", formatEther(agentBalance), "ECCO");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
