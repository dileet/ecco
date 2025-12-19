import hre from "hardhat";

export async function mineBlocks(count: number): Promise<void> {
  const { networkHelpers } = await hre.network.connect();
  await networkHelpers.mine(count);
}

export async function increaseTime(seconds: bigint): Promise<void> {
  const { networkHelpers } = await hre.network.connect();
  await networkHelpers.time.increase(Number(seconds));
}

export async function getBlockTimestamp(): Promise<bigint> {
  const { networkHelpers } = await hre.network.connect();
  const timestamp = await networkHelpers.time.latest();
  return BigInt(timestamp);
}

export async function setNextBlockTimestamp(timestamp: bigint): Promise<void> {
  const connection = await hre.network.connect();
  const provider = connection.provider;
  await provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
}
