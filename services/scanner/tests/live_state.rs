use std::{future::pending, path::Path, time::Duration};

use sovereign_storefront_scanner::scan::{state_root_for, within_deadline};

#[test]
fn scanner_state_root_is_isolated_per_private_config_name() {
    let parent = Path::new("/private-runtime");
    let first = state_root_for(&parent.join("one.json")).expect("first state root");
    let second = state_root_for(&parent.join("two.json")).expect("second state root");

    assert_ne!(first, second);
    assert_eq!(first.parent(), Some(parent));
}

#[tokio::test]
async fn scanner_transport_deadline_aborts_a_hanging_operation() {
    assert_eq!(
        within_deadline(Duration::from_millis(1), pending::<()>()).await,
        Err("scanner stage timed out")
    );
}
