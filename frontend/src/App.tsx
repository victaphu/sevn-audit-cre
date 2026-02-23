import { useState, useEffect, useCallback, type CSSProperties } from "react";
import { IDKitWidget, ISuccessResult, VerificationLevel } from "@worldcoin/idkit";
import { ethers } from "ethers";

// ── Configuration ───────────────────────────────────────────────────────────

const WORLD_APP_ID = import.meta.env.VITE_WORLD_APP_ID || "app_staging_demo";
const WORLD_ACTION = import.meta.env.VITE_WORLD_ACTION || "request audit";
const ATTESTATION_ADDRESS = import.meta.env.VITE_ATTESTATION_ADDRESS || "";
const AUDIT_GATE_ADDRESS = import.meta.env.VITE_AUDIT_GATE_ADDRESS || "";

// ── ABIs ────────────────────────────────────────────────────────────────────

const ATTESTATION_ABI = [
  "function reportCount() view returns (uint256)",
  "function latestReportHash() view returns (bytes32)",
  "function latestTimestamp() view returns (uint256)",
  "event ReportPublished(uint256 indexed timestamp, bytes32 indexed reportHash, bytes report)",
];

// ABI parameter types matching encodeAbiParameters() in the CRE workflow's main.ts
const REPORT_DECODE_TYPES = [
  "uint256", // periodDate
  "uint256", // sevnTotalRevenue
  "uint256", // stripeNetAfterFees
  "uint256", // tokensSold
  "uint256", // matchRateBps
  "uint256", // chargebackTotal
  "uint256", // walletLiability
  "bytes32", // sevnDataHash
  "bytes32", // stripeDataHash
  "bytes32", // reconciliationHash
  "uint256", // onChainTokenSupply
  "uint256", // onChainTokensTransferred
  "uint256", // tokenMatchRateBps
  "uint256", // stripeFees
  "uint256", // giveawayCost
  "uint256", // ccRevenue
  "uint256", // giftCardRevenue
  "string",  // aiRiskLevel
  "string",  // aiSummary
];

const AUDIT_GATE_ABI = [
  "function requestAudit(uint256 root, uint256 nullifierHash, uint256[8] proof) external",
  "function requestAuditDev() external",
  "event AuditRequested(address indexed requester, uint256 timestamp, uint256 nullifierHash)",
];

// ── Types ───────────────────────────────────────────────────────────────────

interface Attestation {
  timestamp: bigint;
  periodDate: bigint;
  sevnTotalRevenue: bigint;
  stripeNetAfterFees: bigint;
  tokensSold: bigint;
  matchRateBps: bigint;
  chargebackTotal: bigint;
  walletLiability: bigint;
  sevnDataHash: string;
  stripeDataHash: string;
  reconciliationHash: string;
  onChainTokenSupply: bigint;
  onChainTokensTransferred: bigint;
  tokenMatchRateBps: bigint;
  stripeFees: bigint;
  giveawayCost: bigint;
  ccRevenue: bigint;
  giftCardRevenue: bigint;
  aiRiskLevel: string;
  aiSummary: string;
  reportHash: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCents(cents: bigint): string {
  return `$${(Number(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2 })}`;
}

function formatBps(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function formatDate(dateInt: bigint): string {
  const s = dateInt.toString();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function formatTimestamp(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function riskConfig(level: string): {
  color: string;
  bg: string;
  border: string;
  label: string;
  icon: string;
} {
  switch (level) {
    case "LOW":
      return {
        color: "var(--cl-green)",
        bg: "var(--cl-green-bg)",
        border: "var(--cl-green-border)",
        label: "LOW RISK",
        icon: "\u2713",
      };
    case "MEDIUM":
      return {
        color: "var(--cl-amber)",
        bg: "var(--cl-amber-bg)",
        border: "var(--cl-amber-border)",
        label: "MEDIUM RISK",
        icon: "\u26A0",
      };
    case "HIGH":
      return {
        color: "var(--cl-red)",
        bg: "var(--cl-red-bg)",
        border: "var(--cl-red-border)",
        label: "HIGH RISK",
        icon: "\u2716",
      };
    default:
      return {
        color: "var(--cl-text-muted)",
        bg: "var(--cl-surface-elevated)",
        border: "var(--cl-border)",
        label: "PENDING",
        icon: "\u2015",
      };
  }
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = {
  shell: {
    minHeight: "100vh",
    background: "var(--cl-bg)",
    position: "relative" as const,
  },

  // Soft blue gradient wash at top
  heroGradient: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    height: "480px",
    background:
      "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(55, 91, 210, 0.07) 0%, transparent 100%)",
    pointerEvents: "none" as const,
    zIndex: 0,
  },

  // Subtle dot grid
  dotGrid: {
    position: "fixed" as const,
    inset: 0,
    backgroundImage:
      "radial-gradient(circle, rgba(55, 91, 210, 0.06) 1px, transparent 1px)",
    backgroundSize: "24px 24px",
    pointerEvents: "none" as const,
    zIndex: 0,
  },

  container: {
    position: "relative" as const,
    zIndex: 1,
    maxWidth: 1040,
    margin: "0 auto",
    padding: "0 clamp(1rem, 3vw, 3rem)",
  },

  // ── Nav ──
  nav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 0",
    marginBottom: 8,
    animation: "fadeIn 0.5s ease-out",
  } satisfies CSSProperties,

  logoGroup: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  logoHex: {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: "linear-gradient(135deg, #375bd2, #4a6ee0)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: 14,
    fontWeight: 800,
    letterSpacing: -0.5,
    boxShadow: "var(--cl-shadow-blue)",
  },

  logoLabel: {
    fontSize: 15,
    fontWeight: 700,
    color: "var(--cl-navy)",
    letterSpacing: "-0.01em",
  },

  navRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  chainPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 12px",
    borderRadius: 100,
    background: "var(--cl-white)",
    border: "1px solid var(--cl-border)",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--cl-text-secondary)",
    letterSpacing: "0.03em",
    boxShadow: "var(--cl-shadow-sm)",
  },

  liveDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--cl-green)",
    position: "relative" as const,
  },

  // ── Hero ──
  hero: {
    textAlign: "center" as const,
    padding: "clamp(2rem, 5vw, 4.5rem) 0 clamp(2rem, 4vw, 3.5rem)",
    animation: "fadeInUp 0.6s ease-out",
  },

  heroChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 16px",
    borderRadius: 100,
    background: "var(--cl-white)",
    border: "1px solid var(--cl-border)",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--cl-blue)",
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
    marginBottom: 20,
    boxShadow: "var(--cl-shadow-sm)",
  },

  heroTitle: {
    fontSize: "clamp(2rem, 4vw + 0.5rem, 3.25rem)",
    fontWeight: 800,
    color: "var(--cl-navy)",
    lineHeight: 1.12,
    letterSpacing: "-0.03em",
    marginBottom: 16,
  },

  heroSub: {
    fontSize: "clamp(0.9rem, 1vw + 0.5rem, 1.1rem)",
    fontWeight: 400,
    color: "var(--cl-text-secondary)",
    lineHeight: 1.6,
    maxWidth: 580,
    margin: "0 auto",
  },

  // ── Workflow Pipeline ──
  pipeline: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    marginBottom: "clamp(2rem, 3.5vw, 3rem)",
    animation: "fadeInUp 0.7s ease-out 0.1s both",
    background: "var(--cl-white)",
    borderRadius: 14,
    border: "1px solid var(--cl-border)",
    padding: "6px",
    boxShadow: "var(--cl-shadow-md)",
    overflow: "hidden" as const,
  } satisfies CSSProperties,

  pipeStep: (active: boolean, isFirst: boolean, isLast: boolean) => ({
    flex: 1,
    padding: "14px 6px",
    textAlign: "center" as const,
    background: active ? "var(--cl-blue)" : "transparent",
    borderRadius: isFirst ? "10px 4px 4px 10px" : isLast ? "4px 10px 10px 4px" : 4,
    transition: "all 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
    cursor: "default",
    position: "relative" as const,
    animation: active ? "step-pulse 2s ease-in-out infinite" : "none",
  }),

  pipeNum: (active: boolean) => ({
    fontSize: 10,
    fontWeight: 700,
    color: active ? "rgba(255,255,255,0.7)" : "var(--cl-blue)",
    letterSpacing: "0.08em",
    marginBottom: 2,
    fontFamily: "'IBM Plex Mono', monospace",
  }),

  pipeLabel: (active: boolean) => ({
    fontSize: 10,
    fontWeight: 600,
    color: active ? "#fff" : "var(--cl-text-tertiary)",
    lineHeight: 1.3,
    letterSpacing: "0.01em",
  }),

  // ── Cards ──
  card: {
    background: "var(--cl-white)",
    borderRadius: 14,
    border: "1px solid var(--cl-border)",
    boxShadow: "var(--cl-shadow-md)",
    overflow: "hidden" as const,
    marginBottom: "clamp(1.25rem, 2.5vw, 2rem)",
    animation: "fadeInUp 0.7s ease-out 0.2s both",
  },

  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderBottom: "1px solid var(--cl-border-light)",
  },

  cardTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--cl-text-primary)",
    letterSpacing: "0.02em",
    textTransform: "uppercase" as const,
  },

  cardMeta: {
    fontSize: 11,
    fontWeight: 500,
    color: "var(--cl-text-muted)",
    fontFamily: "'IBM Plex Mono', monospace",
  },

  // ── Request Audit ──
  requestBody: {
    display: "flex",
    alignItems: "center",
    gap: "clamp(1rem, 2.5vw, 2rem)",
    padding: "clamp(1.25rem, 2.5vw, 2rem) 24px",
  } satisfies CSSProperties,

  requestInfo: {
    flex: 1,
  },

  requestTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--cl-navy)",
    marginBottom: 6,
    letterSpacing: "-0.01em",
  },

  requestDesc: {
    fontSize: 13,
    fontWeight: 400,
    color: "var(--cl-text-secondary)",
    lineHeight: 1.55,
  },

  auditBtn: (disabled: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 28px",
    borderRadius: 10,
    border: "none",
    background: disabled
      ? "var(--cl-surface-elevated)"
      : "linear-gradient(135deg, #375bd2, #4a6ee0)",
    color: disabled ? "var(--cl-text-muted)" : "#fff",
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    letterSpacing: "0.02em",
    transition: "all 0.2s ease",
    whiteSpace: "nowrap" as const,
    boxShadow: disabled ? "none" : "var(--cl-shadow-blue)",
    fontFamily: "'Manrope', sans-serif",
  }),

  txLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
    padding: "6px 12px",
    borderRadius: 6,
    background: "var(--cl-green-bg)",
    border: "1px solid var(--cl-green-border)",
    fontSize: 11,
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 500,
    color: "var(--cl-green)",
    textDecoration: "none",
  },

  errorMsg: {
    marginTop: 12,
    padding: "8px 14px",
    borderRadius: 8,
    background: "var(--cl-red-bg)",
    border: "1px solid var(--cl-red-border)",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--cl-red)",
  },

  // ── Risk Banner ──
  riskBanner: (level: string) => {
    const cfg = riskConfig(level);
    return {
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 24px",
      background: cfg.bg,
      borderBottom: `1px solid ${cfg.border}`,
    };
  },

  riskBadge: (level: string) => {
    const cfg = riskConfig(level);
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "5px 14px",
      borderRadius: 6,
      background: cfg.color,
      color: "#fff",
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: "0.1em",
      whiteSpace: "nowrap" as const,
    };
  },

  riskSummary: {
    fontSize: 13,
    fontWeight: 400,
    color: "var(--cl-text-secondary)",
    lineHeight: 1.5,
    flex: 1,
  },

  // ── Metrics ──
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 0,
  },

  metric: (isLastRow: boolean, isRight: boolean) => ({
    padding: "20px 24px",
    borderBottom: isLastRow ? "none" : "1px solid var(--cl-border-light)",
    borderRight: isRight ? "none" : "1px solid var(--cl-border-light)",
  }),

  metricLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: "var(--cl-text-muted)",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    marginBottom: 6,
  },

  metricValue: (highlight?: boolean) => ({
    fontSize: 19,
    fontWeight: 700,
    color: highlight ? "var(--cl-blue)" : "var(--cl-navy)",
    fontFamily: "'IBM Plex Mono', monospace",
    letterSpacing: "-0.02em",
  }),

  metricSub: {
    fontSize: 10,
    fontWeight: 500,
    color: "var(--cl-text-muted)",
    marginTop: 4,
    fontFamily: "'IBM Plex Mono', monospace",
  },

  // ── Hashes ──
  hashTray: {
    padding: "14px 24px",
    borderTop: "1px solid var(--cl-border-light)",
    background: "var(--cl-bg-warm)",
  },

  hashRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "5px 0",
  },

  hashLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: "var(--cl-text-muted)",
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    width: 110,
    flexShrink: 0,
  },

  hashValue: {
    fontSize: 11,
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 400,
    color: "var(--cl-text-tertiary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },

  // ── Empty State ──
  emptyState: {
    textAlign: "center" as const,
    padding: "clamp(2.5rem, 5vw, 4rem) 20px",
  },

  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    background: "var(--cl-surface-elevated)",
    border: "1px solid var(--cl-border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 16px",
    fontSize: 22,
  },

  // ── Footer ──
  footer: {
    padding: "clamp(2rem, 4vw, 3rem) 0",
    borderTop: "1px solid var(--cl-border)",
    marginTop: "clamp(1rem, 3vw, 2rem)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    animation: "fadeIn 0.7s ease-out 0.4s both",
  } satisfies CSSProperties,

  footerTags: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  footerTag: {
    padding: "4px 10px",
    borderRadius: 6,
    background: "var(--cl-blue-wash)",
    border: "1px solid var(--cl-blue-pale)",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--cl-blue)",
    letterSpacing: "0.03em",
  },

  footerText: {
    fontSize: 11,
    fontWeight: 500,
    color: "var(--cl-text-muted)",
  },

  loadingShimmer: {
    height: 200,
    borderRadius: 8,
    margin: 24,
    background:
      "linear-gradient(90deg, var(--cl-surface-elevated) 25%, var(--cl-bg-warm) 50%, var(--cl-surface-elevated) 75%)",
    backgroundSize: "200% 100%",
    animation: "shimmer 1.8s ease-in-out infinite",
  },

  // ── Infrastructure ──
  infraGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 0,
  } satisfies CSSProperties,

  infraCell: (isRight: boolean) => ({
    padding: "18px 24px",
    borderRight: isRight ? "none" : "1px solid var(--cl-border-light)",
  }),

  infraLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: "var(--cl-text-muted)",
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    marginBottom: 10,
  },

  infraItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },

  infraIcon: {
    width: 20,
    height: 20,
    borderRadius: 5,
    background: "var(--cl-surface-elevated)",
    border: "1px solid var(--cl-border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  infraLink: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--cl-blue)",
    textDecoration: "none",
    fontFamily: "'IBM Plex Mono', monospace",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },

  infraText: {
    fontSize: 10,
    fontWeight: 500,
    color: "var(--cl-text-tertiary)",
    fontFamily: "'IBM Plex Mono', monospace",
  },
};

// ── Workflow Steps ───────────────────────────────────────────────────────────

const WORKFLOW_STEPS = [
  { num: "01", label: "Fetch Sevn" },
  { num: "02", label: "Fetch Stripe" },
  { num: "3a", label: "Read Chain" },
  { num: "3b", label: "Read Polygon" },
  { num: "04", label: "Reconcile" },
  { num: "05", label: "AI Risk" },
  { num: "06", label: "Attest" },
];

// ── App ─────────────────────────────────────────────────────────────────────

// Approximate ms each CRE step takes in the real workflow
const STEP_DURATIONS = [3000, 3000, 3000, 3000, 2000, 8000, 8000];

export default function App() {
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [periodCount, setPeriodCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [creRunning, setCreRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(-1);
  const [walletAddress, setWalletAddress] = useState<string>("");

  const loadAttestation = useCallback(async () => {
    if (!ATTESTATION_ADDRESS) {
      setLoading(false);
      return;
    }
    try {
      const provider = new ethers.JsonRpcProvider(
        import.meta.env.VITE_RPC_URL || "https://sepolia.gateway.tenderly.co",
      );
      const contract = new ethers.Contract(ATTESTATION_ADDRESS, ATTESTATION_ABI, provider);
      const count = await contract.reportCount();
      setPeriodCount(Number(count));
      if (Number(count) > 0) {
        const events = await contract.queryFilter(contract.filters.ReportPublished(), -50000);
        if (events.length > 0) {
          const latest = events[events.length - 1] as ethers.EventLog;
          const reportBytes = latest.args.report as string;
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(REPORT_DECODE_TYPES, reportBytes);
          setAttestation({
            timestamp:                BigInt(latest.args.timestamp),
            periodDate:               decoded[0] as bigint,
            sevnTotalRevenue:          decoded[1] as bigint,
            stripeNetAfterFees:       decoded[2] as bigint,
            tokensSold:               decoded[3] as bigint,
            matchRateBps:             decoded[4] as bigint,
            chargebackTotal:          decoded[5] as bigint,
            walletLiability:          decoded[6] as bigint,
            sevnDataHash:              decoded[7] as string,
            stripeDataHash:           decoded[8] as string,
            reconciliationHash:       decoded[9] as string,
            onChainTokenSupply:       decoded[10] as bigint,
            onChainTokensTransferred: decoded[11] as bigint,
            tokenMatchRateBps:        decoded[12] as bigint,
            stripeFees:               decoded[13] as bigint,
            giveawayCost:             decoded[14] as bigint,
            ccRevenue:                decoded[15] as bigint,
            giftCardRevenue:          decoded[16] as bigint,
            aiRiskLevel:              decoded[17] as string,
            aiSummary:                decoded[18] as string,
            reportHash:               latest.args.reportHash as string,
          });
        }
      }
    } catch (err) {
      console.error("Failed to load attestation:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAttestation();
  }, [loadAttestation]);

  // One-shot forward progression matching approximate CRE workflow timing.
  // Steps play once in sequence; the last step stays highlighted until creRunning clears.
  useEffect(() => {
    if (!creRunning) {
      setActiveStep(-1);
      return;
    }
    setActiveStep(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let elapsed = 0;
    for (let i = 0; i < STEP_DURATIONS.length - 1; i++) {
      elapsed += STEP_DURATIONS[i];
      const next = i + 1;
      timers.push(setTimeout(() => setActiveStep(next), elapsed));
    }
    return () => timers.forEach(clearTimeout);
  }, [creRunning]);

  const SEPOLIA_CHAIN_ID = "0xaa36a7"; // 11155111
  const RPC_URL = import.meta.env.VITE_RPC_URL || "https://sepolia.gateway.tenderly.co";

  // Poll until a new attestation appears (period count increases), then stop CRE animation.
  const pollForAttestation = useCallback((prevCount: number) => {
    let attempts = 0;
    const check = async () => {
      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const contract = new ethers.Contract(ATTESTATION_ADDRESS, ATTESTATION_ABI, provider);
        const count = await contract.reportCount();
        if (Number(count) > prevCount) {
          await loadAttestation();
          setPeriodCount(Number(count));
          setCreRunning(false);
          return;
        }
      } catch { /* keep polling */ }
      if (++attempts < 24) setTimeout(check, 5000); // max ~2 min
      else setCreRunning(false);
    };
    setTimeout(check, 10000); // first check after 10s (CRE needs time to start)
  }, [RPC_URL, loadAttestation]);

  const connectWallet = async () => {
    if (!window.ethereum) throw new Error("MetaMask not found.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (accounts[0]) setWalletAddress(accounts[0]);
    return accounts[0] || "";
  };

  const ensureSepolia = async () => {
    if (!window.ethereum) throw new Error("MetaMask not found.");
    await connectWallet();
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_ID }] });
    } catch (switchErr: any) {
      if (switchErr.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: SEPOLIA_CHAIN_ID,
            chainName: "Sepolia Testnet",
            rpcUrls: [RPC_URL],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          }],
        });
      } else {
        throw switchErr;
      }
    }
  };

  const runDevAuditTx = async () => {
    if (!AUDIT_GATE_ADDRESS) throw new Error("Audit gate contract address not configured");
    await ensureSepolia();
    const provider = new ethers.BrowserProvider(window.ethereum!);
    const signer = await provider.getSigner();
    const contract = new ethers.Contract(AUDIT_GATE_ADDRESS, AUDIT_GATE_ABI, signer);
    const tx = await contract.requestAuditDev();
    setTxHash(tx.hash);
    await tx.wait();
  };

  const handleWorldIDSuccess = async (_result: ISuccessResult) => {
    setRequesting(true);
    setError(null);
    setTxHash(null);
    const prevCount = periodCount;
    try {
      await runDevAuditTx();
      setCreRunning(true);
      pollForAttestation(prevCount);
    } catch (err: any) {
      const msg = err?.shortMessage || err?.reason || err?.message || JSON.stringify(err);
      setError(msg);
    } finally {
      setRequesting(false);
    }
  };

  const handleDevAudit = async () => {
    setRequesting(true);
    setError(null);
    setTxHash(null);
    const prevCount = periodCount;
    try {
      await runDevAuditTx();
      setCreRunning(true);
      pollForAttestation(prevCount);
    } catch (err: any) {
      const msg = err?.shortMessage || err?.reason || err?.message || JSON.stringify(err);
      setError(msg);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div style={s.shell}>
      <div style={s.heroGradient} />
      <div style={s.dotGrid} />

      <div style={s.container}>
        {/* ── Nav ──────────────────────────────────────────────── */}
        <nav style={s.nav}>
          <div style={s.logoGroup}>
            <div style={s.logoHex}>B</div>
            <span style={s.logoLabel}>Sevn Assurance</span>
          </div>
          <div style={s.navRight}>
            <span style={s.chainPill}>
              <span style={s.liveDot}>
                <span
                  style={{
                    position: "absolute",
                    inset: -3,
                    borderRadius: "50%",
                    background: "var(--cl-green)",
                    animation: "pulse-ring 2s ease-out infinite",
                  }}
                />
              </span>
              Sepolia
            </span>
            <span style={s.chainPill}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-blue)" strokeWidth="2.5">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" />
              </svg>
              Polygon
            </span>
          </div>
        </nav>

        {/* ── Hero ─────────────────────────────────────────────── */}
        <header style={s.hero}>
          <div style={s.heroChip}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Chainlink CRE + World ID + Gemini AI
          </div>
          <h1 style={s.heroTitle}>
            Verifiable Financial<br />Reconciliation
          </h1>
          <p style={s.heroSub}>
            Three-way reconciliation across Sevn, Stripe, and Polygon &mdash;
            executed by Chainlink&rsquo;s decentralized oracle network, verified by
            zero-knowledge proof, classified by AI.
          </p>
        </header>

        {/* ── Workflow Pipeline ─────────────────────────────────── */}
        <div style={s.pipeline}>
          {WORKFLOW_STEPS.map((step, i) => (
            <div
              key={step.num}
              style={s.pipeStep(
                creRunning ? activeStep === i : false,
                i === 0,
                i === WORKFLOW_STEPS.length - 1,
              )}
            >
              <div style={s.pipeNum(creRunning ? activeStep === i : false)}>
                {step.num}
              </div>
              <div style={s.pipeLabel(creRunning ? activeStep === i : false)}>
                {step.label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Request Audit Card ────────────────────────────────── */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <span style={s.cardTitle}>Request Audit</span>
            <span style={s.cardMeta}>World ID Gated</span>
          </div>
          <div style={s.requestBody}>
            <div style={s.requestInfo}>
              <div style={s.requestTitle}>Trigger Reconciliation</div>
              <div style={s.requestDesc}>
                Verify your identity with World ID to trigger an independent
                on-chain audit. Only verified humans can request audits.
              </div>
              {txHash && (
                <a
                  href={`https://sepolia.etherscan.io/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={s.txLink}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {txHash.slice(0, 10)}...{txHash.slice(-6)}
                </a>
              )}
              {error && <div style={s.errorMsg}>{error}</div>}
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexDirection: "column" as const }}>
              <IDKitWidget
                app_id={WORLD_APP_ID as `app_${string}`}
                action={WORLD_ACTION}
                signal={walletAddress}
                verification_level={VerificationLevel.Orb}
                onSuccess={handleWorldIDSuccess}
              >
                {({ open }: { open: () => void }) => (
                  <button onClick={async () => { await connectWallet(); open(); }} disabled={requesting || creRunning} style={s.auditBtn(requesting || creRunning)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    {requesting ? "Submitting..." : creRunning ? "CRE Running..." : "Verify & Audit"}
                  </button>
                )}
              </IDKitWidget>
              <button
                onClick={handleDevAudit}
                disabled={requesting || creRunning}
                style={{
                  ...s.auditBtn(requesting || creRunning),
                  background: (requesting || creRunning) ? "var(--cl-surface-elevated)" : "linear-gradient(135deg, #e67e22, #f39c12)",
                  boxShadow: (requesting || creRunning) ? "none" : "0 2px 8px rgba(230, 126, 34, 0.25)",
                  fontSize: 11,
                  padding: "8px 20px",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" />
                </svg>
                {requesting ? "Submitting..." : creRunning ? "CRE Running..." : "Dev Audit (No World ID)"}
              </button>
            </div>
          </div>
        </div>

        {/* ── Attestation Card ──────────────────────────────────── */}
        <div style={{ ...s.card, animationDelay: "0.3s" }}>
          <div style={s.cardHeader}>
            <span style={s.cardTitle}>On-Chain Attestation</span>
            <span style={s.cardMeta}>
              {periodCount} record{periodCount !== 1 ? "s" : ""}
            </span>
          </div>

          {loading ? (
            <div style={s.loadingShimmer} />
          ) : !attestation ? (
            <div style={s.emptyState}>
              <div style={s.emptyIcon}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--cl-text-muted)" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
              </div>
              <p style={{ fontSize: 15, fontWeight: 600, color: "var(--cl-text-primary)", marginBottom: 6 }}>
                No attestations yet
              </p>
              <p style={{ fontSize: 13, color: "var(--cl-text-tertiary)" }}>
                Request an audit to generate the first on-chain record.
              </p>
            </div>
          ) : (
            <>
              {/* Risk Banner */}
              <div style={s.riskBanner(attestation.aiRiskLevel)}>
                <span style={s.riskBadge(attestation.aiRiskLevel)}>
                  {riskConfig(attestation.aiRiskLevel).label}
                </span>
                <span style={s.riskSummary}>{attestation.aiSummary}</span>
              </div>

              {/* Metrics Grid */}
              <div style={s.metricsGrid}>
                <Metric label="Period" value={formatDate(attestation.periodDate)} sub={formatTimestamp(attestation.timestamp)} isLastRow={false} isRight={false} />
                <Metric label="Revenue Match" value={formatBps(attestation.matchRateBps)} highlight isLastRow={false} isRight={false} />
                <Metric label="Sevn Revenue" value={formatCents(attestation.sevnTotalRevenue)} sub="All payment methods" isLastRow={false} isRight={false} />
                <Metric label="Net After Costs" value={formatCents(attestation.sevnTotalRevenue - attestation.stripeFees - attestation.giveawayCost)} sub="Sevn minus fees & giveaways" highlight isLastRow={false} isRight />
                <Metric label="Stripe Net" value={formatCents(attestation.stripeNetAfterFees)} sub="After fees & refunds" isLastRow={false} isRight={false} />
                <Metric label="Stripe Fees" value={formatCents(attestation.stripeFees)} sub="Processing costs" isLastRow={false} isRight={false} />
                <Metric label="Giveaway Cost" value={formatCents(attestation.giveawayCost)} sub="Sevn giveaways" isLastRow={false} isRight={false} />
                <Metric label="Token Match" value={formatBps(attestation.tokenMatchRateBps)} highlight sub="Sevn vs Polygon" isLastRow={false} isRight />
                <Metric label="CC Revenue" value={formatCents(attestation.ccRevenue)} sub="Credit card purchases" isLastRow={false} isRight={false} />
                <Metric label="Gift Card Revenue" value={formatCents(attestation.giftCardRevenue)} sub="Gift card purchases" isLastRow={false} isRight={false} />
                <Metric label="On-Chain Supply" value={Number(attestation.onChainTokenSupply).toLocaleString()} sub="ERC-1155 Polygon" isLastRow={false} isRight={false} />
                <Metric label="Transferred" value={Number(attestation.onChainTokensTransferred).toLocaleString()} sub="To customers" isLastRow={false} isRight />
                <Metric label="Tokens Claimed" value={Number(attestation.tokensSold).toLocaleString()} sub="Sevn ledger" isLastRow isRight={false} />
                <Metric label="" value="" isLastRow isRight={false} />
                <Metric label="" value="" isLastRow isRight={false} />
                <Metric label="" value="" isLastRow isRight />
              </div>

              {/* Hashes */}
              <div style={s.hashTray}>
                <div style={s.hashRow}>
                  <span style={s.hashLabel}>Sevn Hash</span>
                  <span style={s.hashValue}>{attestation.sevnDataHash}</span>
                </div>
                <div style={s.hashRow}>
                  <span style={s.hashLabel}>Stripe Hash</span>
                  <span style={s.hashValue}>{attestation.stripeDataHash}</span>
                </div>
                <div style={s.hashRow}>
                  <span style={s.hashLabel}>Reconciliation</span>
                  <span style={s.hashValue}>{attestation.reconciliationHash}</span>
                </div>
                <div style={s.hashRow}>
                  <span style={s.hashLabel}>Report Hash</span>
                  <span style={s.hashValue}>{attestation.reportHash}</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Infrastructure Card ────────────────────────────────── */}
        <div style={{ ...s.card, animationDelay: "0.4s" }}>
          <div style={s.cardHeader}>
            <span style={s.cardTitle}>Infrastructure</span>
            <span style={s.cardMeta}>On-Chain Transparency</span>
          </div>
          <div style={s.infraGrid}>
            {/* Contracts */}
            <div style={s.infraCell(false)}>
              <div style={s.infraLabel}>Smart Contracts</div>
              {ATTESTATION_ADDRESS && (
                <div style={s.infraItem}>
                  <div style={s.infraIcon}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-blue)" strokeWidth="2.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M3 9h18M9 21V9" />
                    </svg>
                  </div>
                  <div>
                    <a
                      href={`https://sepolia.etherscan.io/address/${ATTESTATION_ADDRESS}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={s.infraLink}
                    >
                      {ATTESTATION_ADDRESS.slice(0, 6)}...{ATTESTATION_ADDRESS.slice(-4)}
                    </a>
                    <div style={s.infraText}>AuditAttestation</div>
                  </div>
                </div>
              )}
              {AUDIT_GATE_ADDRESS && (
                <div style={s.infraItem}>
                  <div style={s.infraIcon}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-green)" strokeWidth="2.5">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </div>
                  <div>
                    <a
                      href={`https://sepolia.etherscan.io/address/${AUDIT_GATE_ADDRESS}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={s.infraLink}
                    >
                      {AUDIT_GATE_ADDRESS.slice(0, 6)}...{AUDIT_GATE_ADDRESS.slice(-4)}
                    </a>
                    <div style={s.infraText}>AuditGate (World ID)</div>
                  </div>
                </div>
              )}
            </div>

            {/* Data Sources */}
            <div style={s.infraCell(false)}>
              <div style={s.infraLabel}>Data Sources</div>
              <div style={s.infraItem}>
                <div style={s.infraIcon}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-amber)" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                </div>
                <div>
                  <a
                    href="https://btx-reconcile.vercel.app/api/cre/btx-truth"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={s.infraLink}
                  >
                    /api/cre/btx-truth
                  </a>
                  <div style={s.infraText}>Sevn Internal Ledger</div>
                </div>
              </div>
              <div style={s.infraItem}>
                <div style={s.infraIcon}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-blue-bright)" strokeWidth="2.5">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <path d="M2 10h20" />
                  </svg>
                </div>
                <div>
                  <a
                    href="https://btx-reconcile.vercel.app/api/cre/stripe-truth"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={s.infraLink}
                  >
                    /api/cre/stripe-truth
                  </a>
                  <div style={s.infraText}>Stripe Payments</div>
                </div>
              </div>
              <div style={s.infraItem}>
                <div style={s.infraIcon}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8247e5" strokeWidth="2.5">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" />
                  </svg>
                </div>
                <div>
                  <span style={{ ...s.infraLink, cursor: "default" }}>
                    ERC-1155 Token Supply
                  </span>
                  <div style={s.infraText}>Polygon Mainnet</div>
                </div>
              </div>
            </div>

            {/* Network Info */}
            <div style={s.infraCell(true)}>
              <div style={s.infraLabel}>Networks</div>
              <div style={s.infraItem}>
                <div style={s.infraIcon}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-navy)" strokeWidth="2.5">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                </div>
                <div>
                  <span style={{ ...s.infraLink, cursor: "default" }}>Ethereum Sepolia</span>
                  <div style={s.infraText}>Attestations + World ID</div>
                </div>
              </div>
              <div style={s.infraItem}>
                <div style={s.infraIcon}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8247e5" strokeWidth="2.5">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" />
                  </svg>
                </div>
                <div>
                  <span style={{ ...s.infraLink, cursor: "default" }}>Polygon Mainnet</span>
                  <div style={s.infraText}>ERC-1155 Token Data</div>
                </div>
              </div>
              <div style={s.infraItem}>
                <div style={s.infraIcon}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--cl-blue)" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </div>
                <div>
                  <span style={{ ...s.infraLink, cursor: "default" }}>Chainlink DON</span>
                  <div style={s.infraText}>CRE Workflow Executor</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Footer ────────────────────────────────────────────── */}
        <footer style={s.footer}>
          <div style={s.footerTags}>
            <span style={s.footerTag}>CRE</span>
            <span style={s.footerTag}>Polygon</span>
            <span style={s.footerTag}>World ID</span>
            <span style={s.footerTag}>Gemini AI</span>
          </div>
          <span style={s.footerText}>Convergence Hackathon 2026</span>
        </footer>
      </div>
    </div>
  );
}

// ── Components ──────────────────────────────────────────────────────────────

function Metric({
  label,
  value,
  sub,
  highlight,
  isLastRow,
  isRight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  isLastRow: boolean;
  isRight: boolean;
}) {
  return (
    <div style={s.metric(isLastRow, isRight)}>
      <div style={s.metricLabel}>{label}</div>
      <div style={s.metricValue(highlight)}>{value}</div>
      {sub && <div style={s.metricSub}>{sub}</div>}
    </div>
  );
}

// ── Window type ─────────────────────────────────────────────────────────────

declare global {
  interface Window {
    ethereum?: ethers.Eip1193Provider;
  }
}
