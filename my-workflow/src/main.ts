/**
 * Sevn Assurance CRE Workflow
 *
 * A Chainlink CRE workflow that independently verifies the financial
 * reconciliation between Sevn (internal ledger) and Stripe (payment
 * processor), uses Google Gemini AI to classify risk, and publishes
 * an immutable attestation on-chain.
 *
 * Steps:
 *  1. Fetch Sevn truth      — HTTP → revenue, tokens, wallet liability
 *  2. Fetch Stripe truth    — HTTP → gross, refunds, fees, chargebacks
 *  3a. EVM Read (Sepolia)   — previous attestation for delta analysis
 *  3b. EVM Read (Polygon)   — on-chain ERC-1155 token supply
 *  4. Compute               — three-way reconciliation, match rates, hash
 *  5. AI Risk               — HTTP → Gemini classifies risk level
 *  6. EVM Write             — publish attestation on-chain
 *
 * Each DON node executes this workflow independently.
 * Consensus ensures all nodes agree on the result before
 * the attestation is committed on-chain.
 */

import {
  cre,
  Runner,
  type Runtime,
  type HTTPSendRequester,
  ok,
  text,
  consensusIdenticalAggregation,
  encodeCallMsg,
  prepareReportRequest,
  LAST_FINALIZED_BLOCK_NUMBER,
  getNetwork,
  bytesToHex,
} from "@chainlink/cre-sdk";
import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  zeroAddress,
} from "viem";
import { z } from "zod";

// ── Types ───────────────────────────────────────────────────────────────────

interface SevnTruth {
  source: string;
  date: string;
  ccRevenue: number;
  giftCardRevenue: number;
  payoutRevenue: number;
  promoRevenue: number;
  giveawayRevenue: number;
  totalRevenue: number;
  tokensSold: number;
  transactionCount: number;
  walletLiability: number;
  dataHash: string;
}

interface StripeTruth {
  source: string;
  date: string;
  grossCollected: number;
  totalRefunds: number;
  totalFees: number;
  netAfterFees: number;
  chargeCount: number;
  chargebackTotal: number;
  chargebackCount: number;
  dataHash: string;
}

interface AIResponse {
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
}

// ── Configuration Schema ────────────────────────────────────────────────────

const configSchema = z.object({
  schedule: z.string(),
  sevnTruthUrl: z.string(),
  stripeTruthUrl: z.string(),
  geminiApiUrl: z.string(),
  attestationContract: z.string(),
  chainSelectorName: z.string(),
  polygonChainSelectorName: z.string(),
  tokenContractAddress: z.string(),
  sevnWalletAddress: z.string(),
  tokenIds: z.array(z.string()),
});

type Config = z.infer<typeof configSchema>;

// ── Contract ABIs ───────────────────────────────────────────────────────────

/** SevnTranche1155 — balanceOf + getMetadata (custom ERC-1155) */
const ERC1155_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getMetadata",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "uint256" }],
    outputs: [
      {
        name: "metadata",
        type: "tuple",
        components: [
          { name: "startTime", type: "uint256" },
          { name: "endTime", type: "uint256" },
          { name: "entityId", type: "uint256" },
          { name: "totalTokens", type: "uint256" },
          { name: "burnt", type: "bool" },
        ],
      },
    ],
  },
] as const;

const ATTESTATION_ABI = [
  {
    name: "getLatest",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "timestamp", type: "uint256" },
          { name: "periodDate", type: "uint256" },
          { name: "sevnTotalRevenue", type: "uint256" },
          { name: "stripeNetAfterFees", type: "uint256" },
          { name: "tokensSold", type: "uint256" },
          { name: "matchRateBps", type: "uint256" },
          { name: "chargebackTotal", type: "uint256" },
          { name: "walletLiability", type: "uint256" },
          { name: "sevnDataHash", type: "bytes32" },
          { name: "stripeDataHash", type: "bytes32" },
          { name: "reconciliationHash", type: "bytes32" },
          { name: "onChainTokenSupply", type: "uint256" },
          { name: "onChainTokensTransferred", type: "uint256" },
          { name: "tokenMatchRateBps", type: "uint256" },
          { name: "aiRiskLevel", type: "string" },
          { name: "aiSummary", type: "string" },
          { name: "attestedBy", type: "address" },
        ],
      },
    ],
  },
  {
    name: "submitAttestation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "periodDate", type: "uint256" },
      { name: "sevnTotalRevenue", type: "uint256" },
      { name: "stripeNetAfterFees", type: "uint256" },
      { name: "tokensSold", type: "uint256" },
      { name: "matchRateBps", type: "uint256" },
      { name: "chargebackTotal", type: "uint256" },
      { name: "walletLiability", type: "uint256" },
      { name: "sevnDataHash", type: "bytes32" },
      { name: "stripeDataHash", type: "bytes32" },
      { name: "reconciliationHash", type: "bytes32" },
      { name: "onChainTokenSupply", type: "uint256" },
      { name: "onChainTokensTransferred", type: "uint256" },
      { name: "tokenMatchRateBps", type: "uint256" },
      { name: "aiRiskLevel", type: "string" },
      { name: "aiSummary", type: "string" },
    ],
    outputs: [],
  },
] as const;

// ── Utilities ───────────────────────────────────────────────────────────────

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function toDateInt(dateStr: string): number {
  return parseInt(dateStr.replace(/-/g, ""), 10);
}

function simpleHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }
  return "0x" + Math.abs(hash).toString(16).padStart(64, "0");
}

/** Base64 encode a string (ASCII only — keep prompts ASCII-safe) */
function toBase64(str: string): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes.push(code < 128 ? code : 63); // replace non-ASCII with '?'
  }
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
    result += i + 2 < bytes.length ? chars[c & 63] : "=";
  }
  return result;
}

/** Call Gemini AI and return the raw text response */
const fetchGeminiResponse = (
  sendRequester: HTTPSendRequester,
  params: { url: string; body: string; apiKey: string },
): string => {
  const response = sendRequester
    .sendRequest({
      url: params.url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": params.apiKey,
      },
      body: toBase64(params.body),
    })
    .result();

  if (!ok(response)) {
    return `ERROR:${response.statusCode}`;
  }

  const raw = text(response);
  try {
    const data = JSON.parse(raw);
    const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return aiText.trim();
  } catch {
    // If wrapper parse fails, try to extract text directly
    const match = raw.match(/"text"\s*:\s*"([^"]+)"/);
    return match ? match[1].trim() : raw.slice(0, 200);
  }
};

// ── HTTP Fetch Functions (executed per-node, consensus on return value) ──────

/** Fetch JSON from any API endpoint, return raw text for consensus */
const fetchApiText = (
  sendRequester: HTTPSendRequester,
  params: { url: string; authToken: string },
): string => {
  const headers: Record<string, string> = {};
  if (params.authToken) {
    headers["Authorization"] = `Bearer ${params.authToken}`;
  }
  const response = sendRequester
    .sendRequest({ url: params.url, method: "GET", headers })
    .result();
  if (!ok(response)) {
    throw new Error(`API ${params.url} returned ${response.statusCode}`);
  }
  return text(response);
};

// ── Workflow Handler ────────────────────────────────────────────────────────

const onTrigger = (runtime: Runtime<Config>) => {
  const config = runtime.config;
  const httpClient = new cre.capabilities.HTTPClient();

  // Read CRE API key for authenticating with Sevn truth endpoints
  const creApiKeySecret = runtime.getSecret({ id: "cre_api_key" }).result();
  const creApiKey = String((creApiKeySecret as { value?: string }).value ?? "");

  // ── Step 1: Fetch Sevn truth ─────────────────────────────────────────────
  runtime.log("[Step 1] Fetching Sevn internal truth...");

  const sevnText = httpClient
    .sendRequest(runtime, fetchApiText, consensusIdenticalAggregation())
    ({ url: config.sevnTruthUrl, authToken: creApiKey })
    .result();

  const sevn: SevnTruth = JSON.parse(sevnText);
  runtime.log(
    `[Step 1] Sevn: $${sevn.totalRevenue.toFixed(2)} revenue, ${sevn.tokensSold} tokens`,
  );

  // ── Step 2: Fetch Stripe truth ──────────────────────────────────────────
  runtime.log("[Step 2] Fetching Stripe truth...");

  const stripeText = httpClient
    .sendRequest(runtime, fetchApiText, consensusIdenticalAggregation())
    ({ url: config.stripeTruthUrl, authToken: creApiKey })
    .result();

  const stripe: StripeTruth = JSON.parse(stripeText);
  runtime.log(
    `[Step 2] Stripe: $${stripe.grossCollected.toFixed(2)} gross, $${stripe.netAfterFees.toFixed(2)} net`,
  );

  // ── Step 3: EVM Read — previous attestation ─────────────────────────────
  runtime.log("[Step 3] Reading previous attestation from chain...");

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);

  const evmClient = new cre.capabilities.EVMClient(
    network.chainSelector.selector,
  );

  let previousRevenue: number | null = null;
  try {
    const callData = encodeFunctionData({
      abi: ATTESTATION_ABI,
      functionName: "getLatest",
    });

    const evmResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: config.attestationContract as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const decoded = decodeFunctionResult({
      abi: ATTESTATION_ABI,
      functionName: "getLatest",
      data: bytesToHex(evmResult.data),
    });

    // decoded is the Attestation struct — sevnTotalRevenue is field index 2
    const attestation = decoded as {
      sevnTotalRevenue: bigint;
      matchRateBps: bigint;
    };
    previousRevenue = Number(attestation.sevnTotalRevenue);
    runtime.log(
      `[Step 3] Previous revenue: $${(previousRevenue / 100).toFixed(2)}`,
    );
  } catch {
    runtime.log("[Step 3a] No previous attestation found (first run)");
  }

  // ── Step 3b: EVM Read — Polygon ERC-1155 token supply ─────────────────
  runtime.log("[Step 3b] Reading ERC-1155 token data from Polygon...");

  let onChainTokenSupply = 0;
  let sevnWalletBalance = 0;

  try {
    const polygonNetwork = getNetwork({
      chainFamily: "evm",
      chainSelectorName: config.polygonChainSelectorName,
      isTestnet: false,
    });
    if (!polygonNetwork)
      throw new Error(`Network not found: ${config.polygonChainSelectorName}`);

    const polygonClient = new cre.capabilities.EVMClient(
      polygonNetwork.chainSelector.selector,
    );

    for (const tokenId of config.tokenIds) {
      // getMetadata(id) — returns struct with totalTokens (minted supply)
      const metaCallData = encodeFunctionData({
        abi: ERC1155_ABI,
        functionName: "getMetadata",
        args: [BigInt(tokenId)],
      });

      const metaResult = polygonClient
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: config.tokenContractAddress as Address,
            data: metaCallData,
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result();

      const metadata = decodeFunctionResult({
        abi: ERC1155_ABI,
        functionName: "getMetadata",
        data: bytesToHex(metaResult.data),
      }) as { startTime: bigint; endTime: bigint; entityId: bigint; totalTokens: bigint; burnt: boolean };
      onChainTokenSupply += Number(metadata.totalTokens);

      // balanceOf(sevnWallet, id) — how many tokens Sevn still holds
      const balCallData = encodeFunctionData({
        abi: ERC1155_ABI,
        functionName: "balanceOf",
        args: [config.sevnWalletAddress as Address, BigInt(tokenId)],
      });

      const balResult = polygonClient
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: config.tokenContractAddress as Address,
            data: balCallData,
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result();

      const balance = decodeFunctionResult({
        abi: ERC1155_ABI,
        functionName: "balanceOf",
        data: bytesToHex(balResult.data),
      });
      sevnWalletBalance += Number(balance);
    }

    runtime.log(
      `[Step 3b] On-chain: ${onChainTokenSupply} total minted, Sevn wallet holds ${sevnWalletBalance}, transferred ${onChainTokenSupply - sevnWalletBalance}`,
    );
  } catch {
    runtime.log("[Step 3b] Polygon read failed — token data unavailable");
  }

  // Tokens transferred = totalMinted - sevnWalletBalance
  const onChainTokensTransferred = onChainTokenSupply - sevnWalletBalance;

  // ── Step 4: Compute reconciliation ──────────────────────────────────────
  runtime.log("[Step 4] Computing reconciliation...");

  // Revenue match: Sevn CC revenue vs Stripe gross minus refunds
  const sevnCcCents = toCents(sevn.ccRevenue);
  const stripeNetPreFees =
    toCents(stripe.grossCollected) - toCents(stripe.totalRefunds);
  const ccDelta = Math.abs(sevnCcCents - stripeNetPreFees);
  const matchRateBps =
    stripeNetPreFees > 0
      ? Math.round(
          ((stripeNetPreFees - ccDelta) / stripeNetPreFees) * 10000,
        )
      : sevnCcCents === 0
        ? 10000
        : 0;

  // Cost breakdown: giveaways are a cost, Stripe fees are a cost
  const giveawayCostCents = toCents(sevn.giveawayRevenue);
  const stripeFeesCents = toCents(stripe.totalFees);
  const chargebackCents = toCents(stripe.chargebackTotal);
  const totalCostsCents = giveawayCostCents + stripeFeesCents + chargebackCents;
  const netRevenueCents = toCents(sevn.totalRevenue) - totalCostsCents;

  runtime.log(`[Step 4] Costs: giveaways $${(giveawayCostCents / 100).toFixed(2)}, Stripe fees $${(stripeFeesCents / 100).toFixed(2)}, chargebacks $${(chargebackCents / 100).toFixed(2)}`);
  runtime.log(`[Step 4] Net revenue after costs: $${(netRevenueCents / 100).toFixed(2)}`);

  // Token match: Sevn claims tokensSold vs on-chain transferred (totalMinted - sevnBalance)
  const claimedTokens = Math.round(sevn.tokensSold);
  const tokenMatchRateBps =
    claimedTokens === 0 && onChainTokensTransferred === 0
      ? 10000
      : Math.round(
          (Math.min(claimedTokens, onChainTokensTransferred) /
            Math.max(claimedTokens, onChainTokensTransferred)) *
            10000,
        );

  const reconciliationHash = simpleHash(
    JSON.stringify({
      sevn,
      stripe,
      matchRateBps,
      tokenMatchRateBps,
      onChainTokenSupply,
      onChainTokensTransferred,
      computedAt: runtime.now().toISOString(),
    }),
  );

  runtime.log(`[Step 4] Revenue match: ${(matchRateBps / 100).toFixed(2)}%`);
  runtime.log(`[Step 4] Token match: ${(tokenMatchRateBps / 100).toFixed(2)}% (${claimedTokens} claimed vs ${onChainTokensTransferred} on-chain)`);

  // ── Step 5: AI-enhanced risk classification via Gemini ──────────────────
  // Risk level is computed deterministically (required for DON consensus).
  // Gemini AI enriches the summary with contextual analysis.
  runtime.log("[Step 5] Computing risk classification + AI analysis...");

  const chargebackRate = toCents(stripe.grossCollected) > 0
    ? toCents(stripe.chargebackTotal) / toCents(stripe.grossCollected)
    : 0;

  // Deterministic risk level (all nodes agree)
  let riskLevel: string;
  let fallbackSummary: string;
  if (
    matchRateBps >= 9900 &&
    tokenMatchRateBps >= 9900 &&
    chargebackRate < 0.01
  ) {
    riskLevel = "LOW";
    fallbackSummary = `Three-way reconciliation passed. Revenue match ${(matchRateBps / 100).toFixed(2)}%, token match ${(tokenMatchRateBps / 100).toFixed(2)}%, chargebacks ${(chargebackRate * 100).toFixed(2)}%. No anomalies detected.`;
  } else if (matchRateBps >= 9500 && tokenMatchRateBps >= 9500 && chargebackRate < 0.03) {
    riskLevel = "MEDIUM";
    fallbackSummary = `Revenue match ${(matchRateBps / 100).toFixed(2)}%, token match ${(tokenMatchRateBps / 100).toFixed(2)}%, chargebacks ${(chargebackRate * 100).toFixed(2)}%. Minor discrepancies detected, manual review recommended.`;
  } else {
    riskLevel = "HIGH";
    fallbackSummary = `Revenue match ${(matchRateBps / 100).toFixed(2)}%, token match ${(tokenMatchRateBps / 100).toFixed(2)}%, chargebacks ${(chargebackRate * 100).toFixed(2)}%. Significant discrepancy detected between data sources.`;
  }

  // Gemini AI summary (best-effort, falls back to rule-based)
  let aiSummary = fallbackSummary;
  try {
    const geminiKey = runtime.getSecret({ id: "gemini_api_key" }).result();
    const apiKey = String((geminiKey as { value?: string }).value ?? "");

    const prompt = `Audit: Sevn revenue $${sevn.totalRevenue.toFixed(2)}, Stripe net $${stripe.netAfterFees.toFixed(2)}, match ${(matchRateBps / 100).toFixed(2)}%, tokens ${sevn.tokensSold} sold vs ${onChainTokensTransferred} on-chain (${(tokenMatchRateBps / 100).toFixed(2)}%), chargebacks $${stripe.chargebackTotal.toFixed(2)}. Risk: ${riskLevel}. Write 1 sentence explaining why.`;

    const geminiBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const geminiText = httpClient
      .sendRequest(
        runtime,
        fetchGeminiResponse,
        consensusIdenticalAggregation(),
      )({ url: config.geminiApiUrl, body: geminiBody, apiKey })
      .result();

    runtime.log(`[Step 5] Gemini AI: ${geminiText}`);
    if (!geminiText.startsWith("ERROR:") && geminiText.length > 10) {
      aiSummary = geminiText.slice(0, 200);
    }
  } catch (e: any) {
    runtime.log(`[Step 5] Gemini failed, using rule-based: ${e?.message ?? String(e)}`);
  }

  const aiResult: AIResponse = { riskLevel: riskLevel as AIResponse["riskLevel"], summary: aiSummary };
  runtime.log(`[Step 5] Risk: ${aiResult.riskLevel}`);
  runtime.log(`[Step 5] Summary: ${aiResult.summary}`);

  // ── Step 6: EVM Write — publish attestation on-chain ────────────────────
  runtime.log("[Step 6] Publishing attestation on-chain...");

  const periodDate = toDateInt(sevn.date);

  // Encode as plain ABI params (no function selector) so AuditAttestation.onReport
  // can decode directly with abi.decode(report, (uint256 x13, bytes32 x3, string x2)).
  const writeData = encodeAbiParameters(
    [
      { name: "periodDate",               type: "uint256" },
      { name: "sevnTotalRevenue",          type: "uint256" },
      { name: "stripeNetAfterFees",       type: "uint256" },
      { name: "tokensSold",               type: "uint256" },
      { name: "matchRateBps",             type: "uint256" },
      { name: "chargebackTotal",          type: "uint256" },
      { name: "walletLiability",          type: "uint256" },
      { name: "sevnDataHash",              type: "bytes32" },
      { name: "stripeDataHash",           type: "bytes32" },
      { name: "reconciliationHash",       type: "bytes32" },
      { name: "onChainTokenSupply",       type: "uint256" },
      { name: "onChainTokensTransferred", type: "uint256" },
      { name: "tokenMatchRateBps",        type: "uint256" },
      { name: "stripeFees",               type: "uint256" },
      { name: "giveawayCost",             type: "uint256" },
      { name: "ccRevenue",                type: "uint256" },
      { name: "giftCardRevenue",          type: "uint256" },
      { name: "aiRiskLevel",              type: "string"  },
      { name: "aiSummary",                type: "string"  },
    ],
    [
      BigInt(periodDate),
      BigInt(toCents(sevn.totalRevenue)),
      BigInt(toCents(stripe.netAfterFees)),
      BigInt(Math.round(sevn.tokensSold)),
      BigInt(matchRateBps),
      BigInt(toCents(stripe.chargebackTotal)),
      BigInt(toCents(sevn.walletLiability)),
      `0x${sevn.dataHash.padStart(64, "0")}` as `0x${string}`,
      `0x${stripe.dataHash.padStart(64, "0")}` as `0x${string}`,
      reconciliationHash as `0x${string}`,
      BigInt(onChainTokenSupply),
      BigInt(onChainTokensTransferred),
      BigInt(tokenMatchRateBps),
      BigInt(stripeFeesCents),
      BigInt(giveawayCostCents),
      BigInt(toCents(sevn.ccRevenue)),
      BigInt(toCents(sevn.giftCardRevenue)),
      aiResult.riskLevel,
      aiResult.summary,
    ],
  );

  runtime.log("[Step 6] EVM write details:");
  runtime.log(`  Chain selector: ${config.chainSelectorName}`);
  runtime.log(`  Receiver:       ${config.attestationContract}`);
  runtime.log(`  Payload bytes:  ${writeData.length / 2 - 1}`);

  const report = runtime
    .report(prepareReportRequest(writeData))
    .result();

  const result = evmClient
    .writeReport(runtime, {
      receiver: config.attestationContract,
      report,
    })
    .result();

  const txHash = bytesToHex(result.txHash || new Uint8Array(32))
  runtime.log("[Step 6] Attestation published!");
  runtime.log(`  Contract called:  ${config.attestationContract}`);
  runtime.log(`  Tx hash:          ${txHash}`);
  runtime.log(`  View on Etherscan: https://sepolia.etherscan.io/tx/${txHash}`);
  
  runtime.log("═══════════════════════════════════════════════════════");
  runtime.log("  THREE-WAY RECONCILIATION ATTESTATION SUMMARY");
  runtime.log("═══════════════════════════════════════════════════════");
  runtime.log(`  Period:              ${periodDate}`);
  runtime.log(`  Sevn Revenue:         $${sevn.totalRevenue.toFixed(2)}`);
  runtime.log(`  CC Revenue:          $${sevn.ccRevenue.toFixed(2)}`);
  runtime.log(`  Gift Card Revenue:   $${sevn.giftCardRevenue.toFixed(2)}`);
  runtime.log(`  Stripe Net:          $${stripe.netAfterFees.toFixed(2)}`);
  runtime.log(`  Revenue Match:       ${(matchRateBps / 100).toFixed(2)}%`);
  runtime.log(`  Giveaway Cost:       $${sevn.giveawayRevenue.toFixed(2)}`);
  runtime.log(`  Stripe Fees:         $${stripe.totalFees.toFixed(2)}`);
  runtime.log(`  Chargebacks:         $${stripe.chargebackTotal.toFixed(2)}`);
  runtime.log(`  Net After Costs:     $${(netRevenueCents / 100).toFixed(2)}`);
  runtime.log(`  Tokens Claimed:      ${claimedTokens}`);
  runtime.log(`  On-Chain Minted:     ${onChainTokenSupply}`);
  runtime.log(`  On-Chain Transferred:${onChainTokensTransferred}`);
  runtime.log(`  Sevn Wallet Balance:  ${sevnWalletBalance}`);
  runtime.log(`  Token Match:         ${(tokenMatchRateBps / 100).toFixed(2)}%`);
  runtime.log(`  AI Risk Level:       ${aiResult.riskLevel}`);
  runtime.log(`  AI Summary:          ${aiResult.summary}`);
  runtime.log("═══════════════════════════════════════════════════════");

  return {
    periodDate,
    matchRateBps,
    tokenMatchRateBps,
    onChainTokenSupply,
    onChainTokensTransferred,
    riskLevel: aiResult.riskLevel,
    summary: aiResult.summary,
  };
};

// ── Workflow Init ────────────────────────────────────────────────────────────

// Production: LogTrigger watches for AuditRequested events from AuditGate.sol.
// The DON automatically executes the workflow when a verified human requests an audit.
//
// const initWorkflow = (config: Config) => {
//   const evmClient = new cre.capabilities.EVMClient(
//     getNetwork(config.chainSelectorName),
//   );
//   const trigger = evmClient.logTrigger({
//     contractAddress: config.attestationContract, // AuditGate address in production
//     eventSignature: "AuditRequested(address,uint256,uint256)",
//     lookbackBlocks: 200,
//     pollFrequency: "15s",
//   });
//   return [cre.handler(trigger, onTrigger)];
// };
//
// For hackathon simulation, we use a cron trigger (CRE CLI doesn't support
// LogTrigger in simulate mode). A local trigger-simulator.ts script bridges
// the gap by watching for events and invoking the CRE CLI.

const initWorkflow = (config: Config) => {
  const cronCapability = new cre.capabilities.CronCapability();
  const trigger = cronCapability.trigger({ schedule: config.schedule });
  return [cre.handler(trigger, onTrigger)];
};

// ── Entry Point ─────────────────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

await main();
