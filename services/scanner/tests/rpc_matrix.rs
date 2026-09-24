use std::{future::pending, time::Duration};

use sovereign_storefront_scanner::rpc::{REQUIRED_CALLS, within_rpc_deadline};

#[test]
fn qualification_requires_each_lightwalletd_call_used_by_the_scanner_path() {
    assert_eq!(
        REQUIRED_CALLS,
        [
            "latest_block",
            "tree_state",
            "compact_block",
            "orchard_subtree_roots",
            "ironwood_subtree_roots",
            "full_transaction",
            "lightwalletd_status",
        ]
    );
}

#[tokio::test]
async fn rpc_deadline_aborts_a_hanging_transport_operation() {
    let result = within_rpc_deadline("latest_block", Duration::from_millis(1), pending::<()>());

    assert!(
        matches!(result.await, Err(error) if error.call == "latest_block" && error.kind == "deadline_exceeded")
    );
}
