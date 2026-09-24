#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eligibility {
    Ineligible,
    Eligible,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptObservation {
    allocation: String,
    amount_zat: u64,
    confirmations_until_spendable: u32,
    output_id: String,
    mined_block_identity: Option<String>,
}

impl ReceiptObservation {
    pub fn new(
        allocation: impl Into<String>,
        amount_zat: u64,
        confirmations_until_spendable: u32,
        output_id: impl Into<String>,
    ) -> Self {
        Self {
            allocation: allocation.into(),
            amount_zat,
            confirmations_until_spendable,
            output_id: output_id.into(),
            mined_block_identity: None,
        }
    }

    pub fn with_mined_block(
        allocation: impl Into<String>,
        amount_zat: u64,
        confirmations_until_spendable: u32,
        output_id: impl Into<String>,
        mined_block_identity: impl Into<String>,
    ) -> Self {
        Self {
            allocation: allocation.into(),
            amount_zat,
            confirmations_until_spendable,
            output_id: output_id.into(),
            mined_block_identity: Some(mined_block_identity.into()),
        }
    }

    pub fn eligibility(&self) -> Eligibility {
        if self.confirmations_until_spendable == 0 {
            Eligibility::Eligible
        } else {
            Eligibility::Ineligible
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptTransition {
    before: ReceiptObservation,
    after: ReceiptObservation,
}

impl ReceiptTransition {
    pub fn new(before: ReceiptObservation, after: ReceiptObservation) -> Self {
        Self { before, after }
    }
}

pub fn validate_receipt_transition(transition: &ReceiptTransition) -> Result<(), &'static str> {
    if transition.before.allocation != transition.after.allocation
        || transition.before.amount_zat != transition.after.amount_zat
        || transition.before.output_id != transition.after.output_id
        || (transition.before.mined_block_identity.is_some()
            && transition.before.mined_block_identity != transition.after.mined_block_identity)
    {
        return Err("receipt identity changed across restart");
    }
    if transition.before.eligibility() != Eligibility::Ineligible
        || transition.after.eligibility() != Eligibility::Eligible
    {
        return Err("receipt did not cross the eligibility boundary");
    }
    Ok(())
}

/// Fails closed unless a received Orchard note has the allocation's canonical receiver bytes.
pub fn validate_orchard_receiver_identity(
    allocated_receiver_hex: &str,
    actual_owned_note_receiver: [u8; 43],
) -> Result<(), &'static str> {
    if allocated_receiver_hex != hex::encode(actual_owned_note_receiver) {
        return Err("owned Orchard note receiver does not match allocation");
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub struct ReceiptSet(Vec<ReceiptObservation>);

impl ReceiptSet {
    pub fn new(receipts: Vec<ReceiptObservation>) -> Self {
        Self(receipts)
    }
}

pub fn ensure_allocation_has_no_receipt(
    receipts: &ReceiptSet,
    allocation: &str,
) -> Result<(), &'static str> {
    if receipts
        .0
        .iter()
        .any(|receipt| receipt.allocation == allocation)
    {
        return Err("unexpected receipt for allocation");
    }
    Ok(())
}
