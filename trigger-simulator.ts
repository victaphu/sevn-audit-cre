/**
 * Local Log-Trigger Simulator
 *
 * Watches Sepolia for AuditRequested events from AuditGate.sol,
 * then triggers `cre workflow simulate --broadcast` which runs the
 * full CRE workflow and writes the attestation on-chain via the
 * KeystoneForwarder → AuditAttestation.onReport() path.
 *
 * This simulates what a CRE LogTrigger would do in production.
 *
 * Usage:
 *   bun run trigger-simulator.ts          # listen for events
 *   bun run trigger-simulator.ts --now    # run immediately (no event needed)
 *
 * Requires:
 *   - .env with AUDIT_GATE_ADDRESS, CRE_RPC_URL_SEPOLIA
 *   - CRE CLI installed and authenticated (cre login)
 */

import { ethers } from "ethers";
import { execSync } from "child_process";
import { config } from "dotenv";
import { resolve } from "path";

config(); // load .env

// ── Configuration ─────────────────────────────────────────────────────────────

const RPC_URL = process.env.CRE_RPC_URL_SEPOLIA || "https://sepolia.gateway.tenderly.co";
const AUDIT_GATE_ADDRESS = process.env.AUDIT_GATE_ADDRESS!;

const AUDIT_GATE_ABI = [
  "event AuditRequested(address indexed requester, uint256 timestamp, uint256 nullifierHash)",
];

// Absolute path to the workflow directory (where workflow.yaml lives)
const WORKFLOW_DIR = resolve(__dirname, "my-workflow");

// ── Run CRE workflow with --broadcast ─────────────────────────────────────────

function runWorkflow() {
  console.log("[CRE] Running: cre workflow simulate --broadcast -T staging-settings -R .\n");
  try {
    const output = execSync(
      "cre workflow simulate --broadcast -T staging-settings -R .",
      {
        cwd: WORKFLOW_DIR,
        encoding: "utf-8",
        timeout: 180_000, // 3 min
        env: { ...process.env, HOME: process.env.HOME },
      },
    );
    console.log(output);
    console.log("[CRE] Workflow completed — attestation written on-chain via onReport().");
  } catch (err: any) {
    // execSync throws on non-zero exit; stdout/stderr still useful
    console.error("[CRE] Workflow failed:");
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    throw err;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const immediateMode = process.argv.includes("--now");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const gate = new ethers.Contract(AUDIT_GATE_ADDRESS, AUDIT_GATE_ABI, provider);
  const network = await provider.getNetwork();

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Sevn Assurance — Log-Trigger Simulator");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Mode:      ${immediateMode ? "Immediate (--now)" : "Event listener"}`);
  console.log(`  Chain:     Sepolia (${network.chainId})`);
  console.log(`  AuditGate: ${AUDIT_GATE_ADDRESS}`);
  console.log(`  Workflow:  ${WORKFLOW_DIR}`);
  console.log("═══════════════════════════════════════════════════════\n");

  if (immediateMode) {
    console.log("Running workflow immediately...\n");
    runWorkflow();
    return;
  }

  // Event listener: watch for AuditRequested, run workflow on each event
  console.log("Listening for AuditRequested events...");
  console.log("(Click 'Verify & Audit' or 'Dev Audit' in the frontend to trigger)\n");

  gate.on("AuditRequested", async (requester: string, timestamp: bigint, nullifierHash: bigint) => {
    console.log("────────────────────────────────────────────────────");
    console.log("AuditRequested event detected!");
    console.log(`  Requester:     ${requester}`);
    console.log(`  Timestamp:     ${new Date(Number(timestamp) * 1000).toISOString()}`);
    console.log(`  NullifierHash: ${nullifierHash}`);
    console.log("────────────────────────────────────────────────────\n");

    try {
      runWorkflow();
      console.log("\nListening for next event...\n");
    } catch (err: any) {
      console.error("Workflow failed:", err.message ?? err);
      console.error("Continuing to listen...\n");
    }
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
}

main().catch(console.error);
