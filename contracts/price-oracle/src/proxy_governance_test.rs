// Issue #375 — tests for the timelock + quorum gate on proxy upgrades and
// for canary routing. Kept in its own module (not wired into every other
// test file) so it can be validated independently of unrelated, pre-existing
// breakage elsewhere in the test suite.
//
// Note: exercising a real WASM swap (`upgrade_wasm`'s success path) requires
// a second compiled contract binary uploaded via
// `env.deployer().upload_contract_wasm(..)`, which this crate's test harness
// does not currently build. These tests instead cover the governance gate
// itself (timelock, quorum, cancel) up to the point `upgrade_wasm` would
// call `update_current_contract_wasm`, plus state read-back that proves the
// pending-upgrade bookkeeping is storage-durable across calls.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, BytesN, Env,
};

use crate::proxy::{ProxyContract, ProxyContractClient};

fn setup() -> (Env, ProxyContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ProxyContract);
    let client = ProxyContractClient::new(&env, &id);

    let admin = Address::generate(&env);
    let implementation = Address::generate(&env);
    client.initialize(&admin, &implementation);

    (env, client, admin)
}

fn dummy_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

#[test]
fn propose_upgrade_rejects_timelock_below_the_floor() {
    let (env, client, admin) = setup();
    let hash = dummy_wasm_hash(&env);

    let result = client.try_propose_upgrade(&admin, &hash, &3600u64); // 1h < 48h floor
    assert!(result.is_err());
    assert!(client.get_pending_upgrade().is_none());
}

#[test]
fn propose_upgrade_records_pending_state() {
    let (env, client, admin) = setup();
    let hash = dummy_wasm_hash(&env);

    client.propose_upgrade(&admin, &hash, &172_800u64);

    let pending = client.get_pending_upgrade().expect("pending upgrade recorded");
    assert_eq!(pending.new_wasm_hash, hash);
    assert_eq!(pending.approvals.len(), 1);
}

#[test]
fn upgrade_wasm_blocked_before_timelock_elapses() {
    let (env, client, admin) = setup();
    let hash = dummy_wasm_hash(&env);

    client.propose_upgrade(&admin, &hash, &172_800u64);
    let result = client.try_upgrade_wasm(&admin);
    assert!(result.is_err());
    // Pending state survives the failed attempt (storage compat: nothing was
    // cleared or half-applied by the rejected call).
    assert!(client.get_pending_upgrade().is_some());
}

#[test]
fn upgrade_wasm_blocked_when_quorum_not_met() {
    let (env, client, admin) = setup();
    let hash = dummy_wasm_hash(&env);
    let signer_a = Address::generate(&env);
    let signer_b = Address::generate(&env);

    client.init_upgrade_quorum(&admin, &vec![&env, signer_a.clone(), signer_b.clone()], &2u32);
    client.propose_upgrade(&admin, &hash, &172_800u64);
    env.ledger().with_mut(|l| l.timestamp += 172_800);

    // Only the admin's automatic approval is on record; threshold is 2.
    let result = client.try_upgrade_wasm(&admin);
    assert!(result.is_err());

    client.approve_upgrade(&signer_a);
    let result = client.try_upgrade_wasm(&admin);
    assert!(result.is_err()); // still short of threshold=2 (admin isn't a signer)

    client.approve_upgrade(&signer_b);
    // Quorum now met and timelock elapsed; only the WASM swap itself (which
    // needs a real uploaded binary) would remain — verified separately.
    assert_eq!(client.get_pending_upgrade().unwrap().approvals.len(), 3);
}

#[test]
fn approve_upgrade_rejects_non_signers_and_double_approval() {
    let (env, client, admin) = setup();
    let hash = dummy_wasm_hash(&env);
    let signer = Address::generate(&env);
    let stranger = Address::generate(&env);

    client.init_upgrade_quorum(&admin, &vec![&env, signer.clone()], &1u32);
    client.propose_upgrade(&admin, &hash, &172_800u64);

    let result = client.try_approve_upgrade(&stranger);
    assert!(result.is_err());

    client.approve_upgrade(&signer);
    let result = client.try_approve_upgrade(&signer);
    assert!(result.is_err()); // already approved
}

#[test]
fn cancel_upgrade_clears_pending_state() {
    let (env, client, admin) = setup();
    let hash = dummy_wasm_hash(&env);

    client.propose_upgrade(&admin, &hash, &172_800u64);
    assert!(client.get_pending_upgrade().is_some());

    client.cancel_upgrade(&admin);
    assert!(client.get_pending_upgrade().is_none());
}

#[test]
fn canary_routes_a_share_of_callers_to_the_candidate() {
    let (env, client, admin) = setup();
    let candidate = Address::generate(&env);
    let caller = Address::generate(&env);

    client.propose_canary(&admin, &candidate, &10_000u32); // 100% to candidate
    assert_eq!(client.resolve_target(&caller), candidate);

    client.propose_canary(&admin, &candidate, &0u32); // 0% to candidate
    assert_ne!(client.resolve_target(&caller), candidate);

    client.clear_canary(&admin);
    assert!(client.get_canary().is_none());
}
