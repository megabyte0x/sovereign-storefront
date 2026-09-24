use sovereign_storefront_scanner::config::ActivationHeights;

#[test]
fn observed_unactivated_future_upgrades_remain_unactivated_in_scanner_parameters() {
    let activations = ActivationHeights::from_runtime_values([
        ("overwinter", Some(1)),
        ("sapling", Some(1)),
        ("blossom", Some(1)),
        ("heartwood", Some(1)),
        ("canopy", Some(1)),
        ("nu5", Some(1)),
        ("nu6", Some(1)),
        ("nu6-1", None),
        ("nu6-2", None),
        ("nu6-3", None),
    ])
    .expect("complete observed activation data");

    assert_eq!(activations.value("nu6-1"), Some(None));
    assert_eq!(activations.value("nu6-2"), Some(None));
    assert_eq!(activations.value("nu6-3"), Some(None));
}

#[test]
fn missing_required_activation_is_rejected_instead_of_defaulted() {
    let result = ActivationHeights::from_runtime_values([
        ("overwinter", Some(1)),
        ("sapling", Some(1)),
        ("blossom", Some(1)),
        ("heartwood", Some(1)),
        ("canopy", Some(1)),
        ("nu5", Some(1)),
        ("not-nu6", None),
        ("nu6-1", None),
        ("nu6-2", None),
        ("nu6-3", None),
    ]);

    assert!(
        result.is_err(),
        "missing nu6 must not receive a default activation"
    );
}
