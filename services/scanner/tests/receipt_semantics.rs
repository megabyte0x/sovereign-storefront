use sovereign_storefront_scanner::receipt::{
    Eligibility, ReceiptObservation, ReceiptSet, ReceiptTransition,
    ensure_allocation_has_no_receipt, validate_orchard_receiver_identity,
    validate_receipt_transition,
};

#[test]
fn receipt_requires_the_exact_canonical_orchard_receiver_bytes() {
    let allocated_receiver = [0x41; 43];
    let actual_owned_note_receiver = [0x41; 43];
    let different_owned_note_receiver = [0x42; 43];
    let allocated_receiver_hex = hex::encode(allocated_receiver);

    assert_eq!(
        validate_orchard_receiver_identity(&allocated_receiver_hex, actual_owned_note_receiver),
        Ok(())
    );
    assert!(
        validate_orchard_receiver_identity(&allocated_receiver_hex, different_owned_note_receiver)
            .is_err()
    );
}

#[test]
fn receipt_becomes_eligible_only_at_the_ten_confirmation_boundary() {
    let before = ReceiptObservation::new("allocation-a", 100_000_000, 1, "opaque-output-id");
    let after = ReceiptObservation::new("allocation-a", 100_000_000, 0, "opaque-output-id");

    assert_eq!(before.eligibility(), Eligibility::Ineligible);
    assert_eq!(after.eligibility(), Eligibility::Eligible);
    assert_eq!(
        validate_receipt_transition(&ReceiptTransition::new(before, after)),
        Ok(())
    );
}

#[test]
fn receipt_transition_rejects_same_height_reorg_with_stale_wallet_identity() {
    let before = ReceiptObservation::with_mined_block(
        "allocation-a",
        100_000_000,
        1,
        "opaque-output-id",
        "canonical-block-a",
    );
    let reorged = ReceiptObservation::with_mined_block(
        "allocation-a",
        100_000_000,
        0,
        "opaque-output-id",
        "canonical-block-b",
    );

    assert!(validate_receipt_transition(&ReceiptTransition::new(before, reorged)).is_err());
}

#[test]
fn receipt_transition_rejects_a_missing_allocation_b_and_changed_output_identity() {
    let before = ReceiptObservation::new("allocation-a", 100_000_000, 1, "opaque-output-id");
    let different_output =
        ReceiptObservation::new("allocation-a", 100_000_000, 0, "other-output-id");
    let receipts = ReceiptSet::new(vec![before.clone()]);

    assert!(ensure_allocation_has_no_receipt(&receipts, "allocation-b").is_ok());
    assert!(
        validate_receipt_transition(&ReceiptTransition::new(before, different_output)).is_err()
    );
}
