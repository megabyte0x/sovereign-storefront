use sovereign_storefront_scanner::allocation::{
    AllocationIdentity, PersistedAllocations, validate_distinct_persisted_allocations,
};

#[test]
fn two_wallet_persisted_external_allocations_must_remain_distinct() {
    let allocations = PersistedAllocations::new(
        AllocationIdentity::new("allocation-a"),
        AllocationIdentity::new("allocation-b"),
    );

    assert_eq!(
        validate_distinct_persisted_allocations(&allocations),
        Ok(())
    );
}

#[test]
fn allocation_validation_rejects_reusing_one_persisted_identity_for_both_invoices() {
    let allocations = PersistedAllocations::new(
        AllocationIdentity::new("allocation-a"),
        AllocationIdentity::new("allocation-a"),
    );

    assert!(validate_distinct_persisted_allocations(&allocations).is_err());
}
