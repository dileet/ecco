import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const CONTRACTS = [
  "EccoToken",
  "AgentStakeRegistry",
  "FeeCollector",
  "WorkRewards",
  "EccoGovernor",
  "EccoTimelock",
  "EccoConstitution",
];

const ARTIFACTS_DIR = join(import.meta.dir, "../artifacts");
const OUTPUT_DIR = join(import.meta.dir, "../dist");

function findArtifactPath(contract: string): string | null {
  const target = `${contract}.json`;
  const stack = [ARTIFACTS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === target) {
        return fullPath;
      }
    }
  }
  return null;
}

function generateAbis() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const exports: string[] = [];

  for (const contract of CONTRACTS) {
    const artifactPath = findArtifactPath(contract);

    if (!artifactPath || !existsSync(artifactPath)) {
      console.error(`Artifact not found for ${contract}`);
      console.error("Run 'bun run compile' first");
      process.exit(1);
    }

    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
    const abi = artifact.abi;

    const constName = `${contract.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_ABI`;
    exports.push(`export const ${constName} = ${JSON.stringify(abi, null, 2)} as const;`);

    console.log(`Generated ABI for ${contract}`);
  }

  const output = `// Auto-generated - do not edit manually
// Run 'bun run generate-abis' to regenerate

${exports.join("\n\n")}
`;

  writeFileSync(join(OUTPUT_DIR, "abis.ts"), output);
  console.log(`\nWritten to ${join(OUTPUT_DIR, "abis.ts")}`);

  const indexContent = `export * from "./abis";
export * from "../addresses";
`;
  writeFileSync(join(OUTPUT_DIR, "index.ts"), indexContent);
  console.log(`Written to ${join(OUTPUT_DIR, "index.ts")}`);
}

generateAbis();
