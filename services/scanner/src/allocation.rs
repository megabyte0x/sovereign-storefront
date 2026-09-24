#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllocationIdentity(String);

impl AllocationIdentity {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedAllocations {
    a: AllocationIdentity,
    b: AllocationIdentity,
}

impl PersistedAllocations {
    pub fn new(a: AllocationIdentity, b: AllocationIdentity) -> Self {
        Self { a, b }
    }
}

pub fn validate_distinct_persisted_allocations(
    allocations: &PersistedAllocations,
) -> Result<(), &'static str> {
    if allocations.a.is_empty() || allocations.b.is_empty() {
        return Err("persisted allocation identity is empty");
    }
    if allocations.a == allocations.b {
        return Err("external allocations are not distinct");
    }
    Ok(())
}
