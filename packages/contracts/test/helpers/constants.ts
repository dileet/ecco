import { parseEther, keccak256, toBytes } from "viem";

export const MAX_SUPPLY = parseEther("1000000000");
export const MIN_STAKE_TO_WORK = parseEther("100");
export const MIN_STAKE_TO_RATE = parseEther("10");
export const UNSTAKE_COOLDOWN = 7n * 24n * 60n * 60n;

export const HALVING_THRESHOLDS = [5_000_000n, 15_000_000n, 35_000_000n, 75_000_000n];
export const REWARD_PER_EPOCH = [
  parseEther("1"),
  parseEther("0.5"),
  parseEther("0.25"),
  parseEther("0.125"),
  parseEther("0.0625"),
];

export const VOTING_DELAY = 7200;
export const VOTING_PERIOD = 50400;
export const PROPOSAL_THRESHOLD = parseEther("100000");
export const QUORUM_PERCENT = 4n;
export const TIMELOCK_MIN_DELAY = 86400n;

export const FEE_PERCENT = 10n;
export const TREASURY_SHARE = 50n;
export const BURN_SHARE = 15n;
export const STAKER_SHARE = 35n;

export const generateJobId = (index: number): `0x${string}` =>
  keccak256(toBytes(`job-${index}`));

export const generatePaymentId = (index: number): `0x${string}` =>
  keccak256(toBytes(`payment-${index}`));

export const generatePeerId = (address: string): `0x${string}` =>
  keccak256(toBytes(address));
