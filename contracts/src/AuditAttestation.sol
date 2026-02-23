// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AuditAttestation
 * @notice Consumer contract for Chainlink CRE reconciliation workflow.
 *
 * @dev Gas-efficient design: stores only a report hash + timestamp on-chain.
 *      The full ABI-encoded report payload is emitted in the ReportPublished event.
 *      Frontends decode the bytes using the same ABI parameter list as the CRE workflow.
 *
 *      Implements IReceiver so the Chainlink CRE KeystoneForwarder can deliver
 *      signed workflow reports via onReport(bytes metadata, bytes report).
 *
 *      Storage per report: ~3 SSTOREs (~60k gas first write, ~15k gas overwrites).
 *      Compare to previous struct-based approach (~500k gas) which caused OOG.
 *
 *      Report encoding: ABI-encoded attestation params (no function selector),
 *      matching encodeAbiParameters() output from the CRE workflow's main.ts:
 *        (uint256 periodDate, uint256 sevnTotalRevenue, uint256 stripeNetAfterFees,
 *         uint256 tokensSold, uint256 matchRateBps, uint256 chargebackTotal,
 *         uint256 walletLiability, bytes32 sevnDataHash, bytes32 stripeDataHash,
 *         bytes32 reconciliationHash, uint256 onChainTokenSupply,
 *         uint256 onChainTokensTransferred, uint256 tokenMatchRateBps,
 *         uint256 stripeFees, uint256 giveawayCost,
 *         uint256 ccRevenue, uint256 giftCardRevenue,
 *         string aiRiskLevel, string aiSummary)
 */
contract AuditAttestation {

    // ── State ────────────────────────────────────────────────────────────────

    /// @notice Hash of the latest report payload (for tamper detection).
    bytes32 public latestReportHash;

    /// @notice block.timestamp when the latest report was stored.
    uint256 public latestTimestamp;

    /// @notice Total number of reports received.
    uint256 public reportCount;

    address public owner;

    /// @notice Chainlink CRE KeystoneForwarder address.
    ///         When address(0): anyone may call onReport (open / hackathon mode).
    address public forwarder;

    // ── Events ───────────────────────────────────────────────────────────────

    /// @notice Emitted on every successful report delivery.
    /// @param  timestamp  block.timestamp of the report.
    /// @param  reportHash keccak256 of the raw report bytes (for on-chain tamper detection).
    /// @param  report     Full ABI-encoded attestation payload — decode client-side.
    event ReportPublished(
        uint256 indexed timestamp,
        bytes32 indexed reportHash,
        bytes          report
    );

    event ForwarderUpdated(address indexed previous, address indexed next);

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice Set the Chainlink CRE KeystoneForwarder address.
    ///         Pass address(0) to allow any caller (open / dev mode).
    function setForwarder(address _forwarder) external onlyOwner {
        emit ForwarderUpdated(forwarder, _forwarder);
        forwarder = _forwarder;
    }

    // ── IReceiver: CRE onReport callback ─────────────────────────────────────

    /// @notice Called by the Chainlink CRE KeystoneForwarder after DON consensus.
    /// @param  report ABI-encoded attestation parameters (no function selector).
    function onReport(bytes calldata /* metadata */, bytes calldata report) external {
        if (forwarder != address(0)) {
            require(msg.sender == forwarder, "Only forwarder");
        }

        bytes32 h = keccak256(report);
        latestReportHash = h;
        latestTimestamp  = block.timestamp;
        reportCount++;

        emit ReportPublished(block.timestamp, h, report);
    }
}
