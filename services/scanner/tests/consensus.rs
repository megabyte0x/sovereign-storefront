//! Deterministic cross-language vectors for the v1 consensus fingerprint.
//! They are not live-chain evidence.

use std::collections::BTreeMap;

use sovereign_storefront_scanner::{
    config::ActivationHeights,
    consensus::{FINGERPRINT_DOMAIN, consensus_fingerprint, fingerprint_preimage},
};

fn vectors() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../protocol/fixtures/consensus-fingerprint-v1.json"
    ))
    .expect("fingerprint vectors are JSON")
}

fn derive(case: &serde_json::Value) -> Result<(String, String), &'static str> {
    let activations: BTreeMap<String, Option<u32>> =
        serde_json::from_value(case["activations"].clone())
            .map_err(|_| "activation heights are not unsigned 32-bit integers or null")?;
    let heights = ActivationHeights::from_config(&activations)?;
    let network = case["network"].as_str().expect("vector network");
    Ok((
        fingerprint_preimage(network, &heights)?,
        consensus_fingerprint(network, &heights)?,
    ))
}

#[test]
fn vector_domain_and_order_match_the_implementation() {
    let vectors = vectors();
    assert_eq!(vectors["domain"], FINGERPRINT_DOMAIN);
    assert_eq!(
        vectors["order"],
        serde_json::json!(ActivationHeights::CANONICAL_ORDER)
    );
}

#[test]
fn valid_vectors_produce_the_exact_preimage_and_digest() {
    for case in vectors()["valid"].as_array().expect("valid vectors") {
        let (preimage, digest) = derive(case).unwrap_or_else(|error| {
            panic!("{} must be accepted: {error}", case["name"]);
        });
        assert_eq!(preimage, case["preimage"], "{}", case["name"]);
        assert_eq!(digest, case["consensusFingerprint"], "{}", case["name"]);
    }
}

#[test]
fn invalid_vectors_are_rejected_instead_of_fingerprinted() {
    for case in vectors()["invalid"].as_array().expect("invalid vectors") {
        assert!(derive(case).is_err(), "{} must be rejected", case["name"]);
    }
}
