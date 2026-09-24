//! Canonical v1 chain-consensus fingerprint and its live lightwalletd check.
//!
//! `ChainIdentity.consensusFingerprint` is lowercase hex SHA-256 over the
//! UTF-8 preimage below. Every name in `ActivationHeights::CANONICAL_ORDER`
//! appears exactly once, in that protocol order, as a base-10 height or
//! `none` for an upgrade the node does not schedule:
//!
//! ```text
//! sovereign-storefront.consensus-fingerprint.v1\n
//! network=<regtest|test>\n
//! overwinter=<height>\n ... nu6-3=<height|none>\n
//! ```
//!
//! A new upgrade name is a new fingerprint version, never an ignored field.

use sha2::{Digest, Sha256};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, NetworkUpgrade, Parameters},
    local_consensus::LocalNetwork,
};

use crate::config::ActivationHeights;

pub const FINGERPRINT_DOMAIN: &str = "sovereign-storefront.consensus-fingerprint.v1";

/// Returns the exact bytes hashed by `consensus_fingerprint`.
pub fn fingerprint_preimage(
    network: &str,
    activations: &ActivationHeights,
) -> Result<String, &'static str> {
    if network != "regtest" && network != "test" {
        return Err("scanner network is not permitted");
    }
    let mut preimage = format!("{FINGERPRINT_DOMAIN}\nnetwork={network}\n");
    for name in ActivationHeights::CANONICAL_ORDER {
        match activations.value(name).ok_or("missing activation")? {
            Some(height) => preimage.push_str(&format!("{name}={height}\n")),
            None => preimage.push_str(&format!("{name}=none\n")),
        }
    }
    Ok(preimage)
}

/// Derives the chain identity's consensus fingerprint from a validated schedule.
pub fn consensus_fingerprint(
    network: &str,
    activations: &ActivationHeights,
) -> Result<String, &'static str> {
    let preimage = fingerprint_preimage(network, activations)?;
    Ok(hex::encode(Sha256::digest(preimage.as_bytes())))
}

/// Checks the consensus facts lightwalletd itself reports against the
/// configured parameters: the Sapling activation height and the branch ID in
/// force at lightwalletd's reported tip. The node's chain label is not used;
/// local regtest backends may report it as `test`.
pub fn verify_lightd_consensus(
    params: &LocalNetwork,
    sapling_activation_height: u64,
    consensus_branch_id: &str,
    block_height: u64,
) -> Result<(), &'static str> {
    let configured_sapling = params
        .activation_height(NetworkUpgrade::Sapling)
        .map(|height| u64::from(u32::from(height)));
    if configured_sapling != Some(sapling_activation_height) {
        return Err("lightwalletd Sapling activation does not match configuration");
    }
    if consensus_branch_id.len() != 8 {
        return Err("lightwalletd consensus branch is invalid");
    }
    let reported = u32::from_str_radix(consensus_branch_id, 16)
        .map_err(|_| "lightwalletd consensus branch is invalid")?;
    let height = u32::try_from(block_height).map_err(|_| "lightwalletd tip is invalid")?;
    let expected = u32::from(BranchId::for_height(params, BlockHeight::from_u32(height)));
    if reported != expected {
        return Err("lightwalletd consensus branch does not match configuration");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::verify_lightd_consensus;
    use crate::config::ActivationHeights;

    fn params(nu6: Option<u32>) -> zcash_protocol::local_consensus::LocalNetwork {
        ActivationHeights::from_runtime_values([
            ("overwinter", Some(1)),
            ("sapling", Some(1)),
            ("blossom", Some(1)),
            ("heartwood", Some(1)),
            ("canopy", Some(1)),
            ("nu5", Some(1)),
            ("nu6", nu6),
            ("nu6-1", None),
            ("nu6-2", None),
            ("nu6-3", None),
        ])
        .expect("valid schedule")
        .local_network()
    }

    #[test]
    fn matching_lightwalletd_consensus_is_accepted_in_either_hex_case() {
        // 0xc8e71055 is the pinned library's NU6 branch ID.
        verify_lightd_consensus(&params(Some(1)), 1, "c8e71055", 120).expect("lowercase");
        verify_lightd_consensus(&params(Some(1)), 1, "C8E71055", 120).expect("uppercase");
    }

    #[test]
    fn a_later_configured_upgrade_is_checked_at_the_reported_tip() {
        // 0xc2d6d0b4 is NU5; NU6 is scheduled above this tip.
        verify_lightd_consensus(&params(Some(200)), 1, "c2d6d0b4", 120).expect("nu5 at tip");
        assert!(verify_lightd_consensus(&params(Some(200)), 1, "c8e71055", 120).is_err());
    }

    #[test]
    fn mismatched_or_malformed_lightwalletd_consensus_fails_closed() {
        let params = params(Some(1));
        assert!(verify_lightd_consensus(&params, 2, "c8e71055", 120).is_err());
        assert!(verify_lightd_consensus(&params, 1, "c2d6d0b4", 120).is_err());
        assert!(verify_lightd_consensus(&params, 1, "", 120).is_err());
        assert!(verify_lightd_consensus(&params, 1, "0xc8e710", 120).is_err());
        assert!(verify_lightd_consensus(&params, 1, "c8e71055", u64::MAX).is_err());
    }
}
