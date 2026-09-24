use serde_json::{Map, Value};
use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};

const MAX_MONEY_ZAT: u128 = 2_100_000_000_000_000;
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SAFE_PROTOCOL_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ENCRYPTED_ENVELOPE_BYTES: u64 = 65_536;
const FIXTURE_PURPOSE: &str =
    "non-production protocol compatibility vector; contains no wallet material";

fn object<'a>(value: &'a Value, field: &str) -> &'a Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{field} must be an object"))
}

fn exact(value: &Value, field: &str, expected: &[&str]) {
    let row = object(value, field);
    assert_eq!(row.len(), expected.len(), "{field} property count");
    for key in expected {
        assert!(row.contains_key(*key), "{field} missing {key}");
    }
    assert!(
        row.keys().all(|key| expected.contains(&key.as_str())),
        "{field} extra property"
    );
}

fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("{field} must be a string"))
}

fn bounded(value: &Value, field: &str, max: usize) -> String {
    let text = string(value, field);
    assert!(
        !text.is_empty() && text.chars().count() <= max,
        "{field} bounds"
    );
    text.to_owned()
}

fn uint(value: &Value, field: &str) -> u64 {
    let parsed = value
        .as_u64()
        .unwrap_or_else(|| panic!("{field} must be an integer"));
    assert!(
        parsed <= MAX_SAFE_PROTOCOL_INTEGER,
        "{field} safe integer bound"
    );
    parsed
}

fn boolean(value: &Value, field: &str) -> bool {
    value
        .as_bool()
        .unwrap_or_else(|| panic!("{field} must be a boolean"))
}

fn hex(value: &Value, field: &str, bytes: usize) -> String {
    let text = string(value, field);
    assert_eq!(text.len(), bytes * 2, "{field} length");
    assert!(
        text.bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')),
        "{field} canonical lowercase hex"
    );
    text.to_owned()
}

fn amount(value: &Value, field: &str) -> String {
    let text = string(value, field);
    assert!(text.len() <= 16, "{field} length");
    assert!(
        !text.starts_with('0') && text.bytes().all(|byte| byte.is_ascii_digit()),
        "{field} canonical positive decimal"
    );
    let parsed = text
        .parse::<u128>()
        .unwrap_or_else(|_| panic!("{field} amount"));
    assert!(
        parsed > 0 && parsed <= MAX_MONEY_ZAT,
        "{field} monetary bound"
    );
    text.to_owned()
}

fn generation(value: &Value, field: &str) -> String {
    let text = bounded(value, field, 256);
    assert!(
        !text.starts_with('0') && text.bytes().all(|byte| byte.is_ascii_digit()),
        "{field} generation"
    );
    text
}

fn network(value: &Value, field: &str) -> String {
    let text = string(value, field);
    assert!(matches!(text, "test" | "regtest"), "{field} network");
    text.to_owned()
}

fn chain(value: &Value, field: &str) -> (String, String, String) {
    exact(
        value,
        field,
        &["network", "genesisHash", "consensusFingerprint"],
    );
    let row = object(value, field);
    (
        network(&row["network"], &format!("{field}.network")),
        hex(&row["genesisHash"], &format!("{field}.genesisHash"), 32),
        hex(
            &row["consensusFingerprint"],
            &format!("{field}.consensusFingerprint"),
            32,
        ),
    )
}

fn revision(value: &Value, field: &str) -> (u64, String) {
    exact(value, field, &["height", "hash"]);
    let row = object(value, field);
    (
        uint(&row["height"], &format!("{field}.height")),
        hex(&row["hash"], &format!("{field}.hash"), 32),
    )
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct ReceiptIdentity {
    output_id: String,
    txid: String,
    pool: String,
    output_index: u64,
}

fn receipt(value: &Value, index: usize, account_id: &str) -> ReceiptIdentity {
    let field = format!("snapshot.receipts.{index}");
    exact(
        value,
        &field,
        &[
            "outputId",
            "txid",
            "pool",
            "outputIndex",
            "accountId",
            "scope",
            "receiverHex",
            "amountZat",
            "firstSeenAt",
            "mined",
            "canonical",
        ],
    );
    let row = object(value, &field);
    let output_id = bounded(&row["outputId"], &format!("{field}.outputId"), 256);
    let txid = hex(&row["txid"], &format!("{field}.txid"), 32);
    assert_eq!(string(&row["pool"], &format!("{field}.pool")), "orchard");
    let output_index = uint(&row["outputIndex"], &format!("{field}.outputIndex"));
    assert_eq!(
        bounded(&row["accountId"], &format!("{field}.accountId"), 256),
        account_id,
        "receipt account binding"
    );
    assert!(
        matches!(
            string(&row["scope"], &format!("{field}.scope")),
            "external" | "internal"
        ),
        "receipt scope"
    );
    hex(&row["receiverHex"], &format!("{field}.receiverHex"), 43);
    amount(&row["amountZat"], &format!("{field}.amountZat"));
    uint(&row["firstSeenAt"], &format!("{field}.firstSeenAt"));
    if !row["mined"].is_null() {
        revision(&row["mined"], &format!("{field}.mined"));
    }
    boolean(&row["canonical"], &format!("{field}.canonical"));
    ReceiptIdentity {
        output_id,
        txid,
        pool: "orchard".to_owned(),
        output_index,
    }
}

fn snapshot(
    value: &Value,
) -> (
    String,
    String,
    (String, String, String),
    String,
    Vec<ReceiptIdentity>,
) {
    assert!(
        serde_json::to_vec(value).unwrap().len() <= MAX_SNAPSHOT_BYTES,
        "snapshot byte bound"
    );
    exact(
        value,
        "snapshot",
        &[
            "version",
            "sourceId",
            "generation",
            "chain",
            "accountId",
            "tip",
            "scanned",
            "checkedAt",
            "caughtUp",
            "complete",
            "health",
            "receipts",
        ],
    );
    let row = object(value, "snapshot");
    assert_eq!(row["version"], 1, "snapshot version");
    let source_id = bounded(&row["sourceId"], "snapshot.sourceId", 256);
    let generation = generation(&row["generation"], "snapshot.generation");
    let chain = chain(&row["chain"], "snapshot.chain");
    let account_id = bounded(&row["accountId"], "snapshot.accountId", 256);
    revision(&row["tip"], "snapshot.tip");
    revision(&row["scanned"], "snapshot.scanned");
    uint(&row["checkedAt"], "snapshot.checkedAt");
    boolean(&row["caughtUp"], "snapshot.caughtUp");
    boolean(&row["complete"], "snapshot.complete");
    assert!(
        matches!(
            string(&row["health"], "snapshot.health"),
            "ready" | "syncing" | "unavailable"
        ),
        "snapshot health"
    );
    let values = row["receipts"].as_array().expect("snapshot receipts array");
    assert!(values.len() <= 10_000, "snapshot receipt bound");
    let mut output_ids = HashSet::new();
    let mut identities = HashSet::new();
    let receipts = values
        .iter()
        .enumerate()
        .map(|(index, value)| receipt(value, index, &account_id))
        .collect::<Vec<_>>();
    for receipt in &receipts {
        assert!(
            output_ids.insert(receipt.output_id.clone()),
            "unique output identity"
        );
        assert!(
            identities.insert((
                receipt.txid.clone(),
                receipt.pool.clone(),
                receipt.output_index
            )),
            "unique receipt identity"
        );
    }
    (source_id, generation, chain, account_id, receipts)
}

fn allocation(value: &Value) -> (String, (String, String, String), String, String) {
    exact(
        value,
        "allocation",
        &[
            "allocationId",
            "chain",
            "accountId",
            "amountZat",
            "expiresAt",
            "destination",
            "receiver",
            "paymentUri",
        ],
    );
    let row = object(value, "allocation");
    bounded(&row["allocationId"], "allocation.allocationId", 256);
    let chain = chain(&row["chain"], "allocation.chain");
    let account_id = bounded(&row["accountId"], "allocation.accountId", 256);
    let amount = amount(&row["amountZat"], "allocation.amountZat");
    uint(&row["expiresAt"], "allocation.expiresAt");
    bounded(&row["destination"], "allocation.destination", 4096);
    exact(
        &row["receiver"],
        "allocation.receiver",
        &[
            "accountId",
            "scope",
            "pool",
            "diversifierIndex",
            "receiverHex",
        ],
    );
    let receiver = object(&row["receiver"], "allocation.receiver");
    assert_eq!(
        bounded(&receiver["accountId"], "allocation.receiver.accountId", 256),
        account_id,
        "allocation receiver account binding"
    );
    assert_eq!(receiver["scope"], "external", "allocation receiver scope");
    assert_eq!(receiver["pool"], "orchard", "allocation receiver pool");
    hex(
        &receiver["diversifierIndex"],
        "allocation.receiver.diversifierIndex",
        11,
    );
    hex(
        &receiver["receiverHex"],
        "allocation.receiver.receiverHex",
        43,
    );
    let uri = bounded(&row["paymentUri"], "allocation.paymentUri", 4096);
    assert!(uri.starts_with("zcash:"), "allocation payment URI");
    (account_id, chain, amount, uri)
}

fn product(value: &Value) -> (String, String) {
    exact(
        value,
        "product",
        &[
            "version",
            "amountZat",
            "network",
            "ciphertextCid",
            "ciphertextDigest",
        ],
    );
    let row = object(value, "product");
    bounded(&row["version"], "product.version", 256);
    let amount = amount(&row["amountZat"], "product.amountZat");
    let network = network(&row["network"], "product.network");
    bounded(&row["ciphertextCid"], "product.ciphertextCid", 4096);
    hex(&row["ciphertextDigest"], "product.ciphertextDigest", 32);
    (network, amount)
}

fn observation(value: &Value) -> ReceiptIdentity {
    exact(
        value,
        "observation",
        &[
            "outputId",
            "sourceId",
            "generation",
            "chainNetwork",
            "txid",
            "pool",
            "outputIndex",
        ],
    );
    let row = object(value, "observation");
    let output_id = bounded(&row["outputId"], "observation.outputId", 256);
    bounded(&row["sourceId"], "observation.sourceId", 256);
    generation(&row["generation"], "observation.generation");
    network(&row["chainNetwork"], "observation.chainNetwork");
    let txid = hex(&row["txid"], "observation.txid", 32);
    assert_eq!(row["pool"], "orchard", "observation pool");
    let output_index = uint(&row["outputIndex"], "observation.outputIndex");
    ReceiptIdentity {
        output_id,
        txid,
        pool: "orchard".to_owned(),
        output_index,
    }
}

fn package(value: &Value) {
    exact(
        value,
        "preparedPackage",
        &[
            "orderId",
            "productVersion",
            "buyerKeyId",
            "packageId",
            "encryptedEnvelopeBytes",
        ],
    );
    let row = object(value, "preparedPackage");
    bounded(&row["orderId"], "preparedPackage.orderId", 256);
    bounded(
        &row["productVersion"],
        "preparedPackage.productVersion",
        256,
    );
    bounded(&row["buyerKeyId"], "preparedPackage.buyerKeyId", 256);
    hex(&row["packageId"], "preparedPackage.packageId", 32);
    let length = uint(
        &row["encryptedEnvelopeBytes"],
        "preparedPackage.encryptedEnvelopeBytes",
    );
    assert!(
        length > 0 && length <= MAX_ENCRYPTED_ENVELOPE_BYTES,
        "package body bound"
    );
}

fn negative_cases<'a>(value: &'a Value, field: &str) -> Vec<(&'a str, &'a Value)> {
    let values = value.as_array().expect("negative cases array");
    assert!(!values.is_empty() && values.len() <= 32, "{field} bounds");
    values
        .iter()
        .enumerate()
        .map(|(index, case)| {
            exact(case, &format!("{field}.{index}"), &["name", "candidate"]);
            let row = object(case, &format!("{field}.{index}"));
            let candidate = object(&row["candidate"], &format!("{field}.{index}.candidate"));
            assert!(!candidate.is_empty(), "{field}.{index} candidate");
            (
                string(&row["name"], &format!("{field}.{index}.name")),
                &row["candidate"],
            )
        })
        .collect()
}

fn protocol(value: &Value) {
    exact(
        value,
        "protocol vector",
        &[
            "version",
            "fixturePurpose",
            "identity",
            "product",
            "snapshot",
            "allocation",
            "observation",
            "preparedPackage",
            "negative",
        ],
    );
    let row = object(value, "protocol vector");
    assert_eq!(row["version"], 1, "protocol version");
    assert_eq!(
        string(&row["fixturePurpose"], "fixture purpose"),
        FIXTURE_PURPOSE
    );
    assert!(
        !value.to_string().contains("UFVK"),
        "fixture wallet material"
    );

    exact(
        &row["identity"],
        "identity",
        &[
            "network",
            "genesisHash",
            "consensusFingerprint",
            "accountId",
        ],
    );
    let identity = object(&row["identity"], "identity");
    let identity_chain = chain(
        &serde_json::json!({
            "network": identity["network"],
            "genesisHash": identity["genesisHash"],
            "consensusFingerprint": identity["consensusFingerprint"],
        }),
        "identity",
    );
    let identity_account = bounded(&identity["accountId"], "identity.accountId", 256);
    let (product_network, product_amount) = product(&row["product"]);
    let (source_id, generation, snapshot_chain, snapshot_account, receipts) =
        snapshot(&row["snapshot"]);
    let (allocation_account, allocation_chain, allocation_amount, _) =
        allocation(&row["allocation"]);
    let observed = observation(&row["observation"]);
    package(&row["preparedPackage"]);

    assert_eq!(product_network, identity_chain.0, "product network binding");
    assert_eq!(snapshot_chain, identity_chain, "snapshot chain binding");
    assert_eq!(allocation_chain, identity_chain, "allocation chain binding");
    assert_eq!(
        snapshot_account, identity_account,
        "snapshot account binding"
    );
    assert_eq!(
        allocation_account, identity_account,
        "allocation account binding"
    );
    assert_eq!(product_amount, allocation_amount, "product amount binding");
    assert!(
        receipts.contains(&observed),
        "observation receipt identity binding"
    );
    let observation_row = object(&row["observation"], "observation");
    assert_eq!(
        observation_row["sourceId"], source_id,
        "observation source binding"
    );
    assert_eq!(
        observation_row["generation"], generation,
        "observation generation binding"
    );
    assert_eq!(
        observation_row["chainNetwork"], identity_chain.0,
        "observation network binding"
    );

    exact(
        &row["negative"],
        "negative",
        &["snapshots", "allocations", "vectors"],
    );
    negative_cases(&row["negative"]["snapshots"], "negative.snapshots");
    negative_cases(&row["negative"]["allocations"], "negative.allocations");
    negative_cases(&row["negative"]["vectors"], "negative.vectors");
}

fn merged_vector(vector: &Value, patch: &Value) -> Value {
    let mut candidate = vector.clone();
    let target = candidate.as_object_mut().expect("vector object");
    for (key, value) in object(patch, "vector patch") {
        target.insert(key.clone(), value.clone());
    }
    candidate
}

#[test]
fn validates_complete_v1_schema_vector_and_rejects_every_executable_negative_case() {
    let schema: Value =
        serde_json::from_str(include_str!("../protocol/schema.json")).expect("schema JSON");
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["$defs"]["amount"]["type"], "string");
    assert!(schema["$defs"]["amount"]["pattern"].is_string());
    assert!(schema["$defs"]["amount"].get("format").is_none());
    assert_eq!(
        schema["$defs"]["snapshot"]["x-maxUtf8Bytes"],
        MAX_SNAPSHOT_BYTES
    );
    for definition in [
        "fixtureIdentity",
        "chainIdentity",
        "receiver",
        "revision",
        "receipt",
        "snapshot",
        "allocation",
        "product",
        "observation",
        "preparedPackage",
        "negativeCase",
        "negative",
    ] {
        assert_eq!(
            schema["$defs"][definition]["additionalProperties"], false,
            "schema closes {definition}"
        );
    }

    let vector: Value =
        serde_json::from_str(include_str!("../protocol/fixtures/v1.json")).expect("fixture JSON");
    protocol(&vector);
    let oversized_snapshot = {
        let mut snapshot = vector["snapshot"].clone();
        snapshot["sourceId"] = Value::String("x".repeat(MAX_SNAPSHOT_BYTES));
        snapshot
    };
    assert!(catch_unwind(AssertUnwindSafe(|| snapshot(&oversized_snapshot))).is_err());
    let too_many_receipts = {
        let mut snapshot = vector["snapshot"].clone();
        let receipt = snapshot["receipts"][0].clone();
        snapshot["receipts"] = Value::Array(vec![receipt; 10_001]);
        snapshot
    };
    assert!(catch_unwind(AssertUnwindSafe(|| snapshot(&too_many_receipts))).is_err());
    let negative = object(&vector["negative"], "negative");

    let mut rejected = Vec::new();
    for (name, candidate) in negative_cases(&negative["snapshots"], "negative.snapshots") {
        assert!(
            catch_unwind(AssertUnwindSafe(|| snapshot(candidate))).is_err(),
            "negative snapshot {name} accepted"
        );
        rejected.push(name);
    }
    for (name, candidate) in negative_cases(&negative["allocations"], "negative.allocations") {
        assert!(
            catch_unwind(AssertUnwindSafe(|| allocation(candidate))).is_err(),
            "negative allocation {name} accepted"
        );
        rejected.push(name);
    }
    for (name, patch) in negative_cases(&negative["vectors"], "negative.vectors") {
        assert!(
            catch_unwind(AssertUnwindSafe(|| protocol(&merged_vector(
                &vector, patch
            ))))
            .is_err(),
            "negative vector {name} accepted"
        );
        rejected.push(name);
    }
    assert_eq!(
        rejected,
        vec![
            "snapshot-bad-generation",
            "snapshot-extra-property",
            "snapshot-non-boolean-canonical",
            "snapshot-duplicate-output-id",
            "allocation-over-money-bound",
            "allocation-noncanonical-receiver-hex",
            "allocation-account-binding",
            "vector-product-network-binding",
            "vector-observation-identity-binding",
            "vector-package-body-bound",
        ]
    );
}

#[test]
fn id256_and_text4096_count_unicode_scalars_like_json_schema() {
    let vector: Value =
        serde_json::from_str(include_str!("../protocol/fixtures/v1.json")).expect("fixture JSON");

    for (field, unit, limit) in [
        ("allocationId", "é", 256),
        ("allocationId", "😀", 256),
        ("destination", "é", 4096),
        ("destination", "😀", 4096),
    ] {
        let mut valid = vector["allocation"].clone();
        valid[field] = Value::String(unit.repeat(limit));
        assert!(
            catch_unwind(AssertUnwindSafe(|| allocation(&valid))).is_ok(),
            "{field} accepts {limit} Unicode scalars for {unit}"
        );

        let mut invalid = vector["allocation"].clone();
        invalid[field] = Value::String(unit.repeat(limit + 1));
        assert!(
            catch_unwind(AssertUnwindSafe(|| allocation(&invalid))).is_err(),
            "{field} rejects {} Unicode scalars for {unit}",
            limit + 1
        );
    }
}
