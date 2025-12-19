import { network } from "hardhat";
import { formatEther, parseEther } from "viem";

const AGENT_WALLET = "0x2Eb06551CE34Bc96397E4f02560ED7758255d6DD";
const AMOUNT = parseEther("0.1");

async function main() {
  const connection = await network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log(`Sending ${formatEther(AMOUNT)} MON to agent ${AGENT_WALLET}...`);

  const hash = await deployer.sendTransaction({
    to: AGENT_WALLET,
    value: AMOUNT,
  });
  console.log("TX Hash:", hash);

  console.log("Waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash });

  const balance = await publicClient.getBalance({ address: AGENT_WALLET });
  console.log("Agent MON balance:", formatEther(balance), "MON");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
