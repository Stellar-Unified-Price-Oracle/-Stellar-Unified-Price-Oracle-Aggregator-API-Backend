#[cfg(test)]
mod proxy_tests {
    use soroban_sdk::testutils::{Address as TestAddress, Ledger};
    use soroban_sdk::{Address, BytesN, Env, String, Vec};

    use crate::proxy::{ProxyContract, ProxyContractClient};

    fn setup() -> (Env, ProxyContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ProxyContract);
        let client = ProxyContractClient::new(&env, &contract_id);

        let admin = <Address as TestAddress>::generate(&env);
        let implementation = <Address as TestAddress>::generate(&env);
        client.initialize(&admin, &implementation);

        (env, client, admin, implementation)
    }

    fn hash(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    // Issue #375 — a WASM upgrade cannot execute before the timelock ETA
    // elapses, even once quorum approvals are in.
    #[test]
    fn execute_upgrade_fails_before_timelock() {
        let (env, client, admin, _impl) = setup();
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(admin.clone());
        client.init_multisig(&admin, &signers, &1u32);

        let new_hash = hash(&env, 1);
        client.propose_upgrade(&admin, &new_hash);
        client.approve_upgrade(&admin);

        assert!(client.try_execute_upgrade(&admin).is_err());
    }

    // Issue #375 — execute_upgrade also rejects a caller before quorum is
    // reached, independent of the timelock.
    #[test]
    fn execute_upgrade_fails_before_quorum() {
        let (env, client, admin, _impl) = setup();
        let signer_two = <Address as TestAddress>::generate(&env);
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(admin.clone());
        signers.push_back(signer_two);
        client.init_multisig(&admin, &signers, &2u32);

        let new_hash = hash(&env, 1);
        client.propose_upgrade(&admin, &new_hash);
        client.approve_upgrade(&admin); // only 1 of 2 required approvals

        env.ledger().with_mut(|l| l.timestamp += 172_800);

        assert!(client.try_execute_upgrade(&admin).is_err());
    }

    // Issue #375 — quorum + timelock bookkeeping is satisfied once enough
    // signers approve and the delay elapses; oracle storage untouched by the
    // pending-upgrade queue (state-migration compatibility).
    #[test]
    fn upgrade_quorum_and_timelock_bookkeeping() {
        let (env, client, admin, _impl) = setup();
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(admin.clone());
        client.init_multisig(&admin, &signers, &1u32);

        let asset = String::from_str(&env, "XLM");
        let oracle = <Address as TestAddress>::generate(&env);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &0u64);

        let new_hash = hash(&env, 2);
        let eta = client.propose_upgrade(&admin, &new_hash);
        client.approve_upgrade(&admin);

        assert_eq!(client.get_upgrade_approval_count(), 1);
        assert_eq!(client.get_pending_upgrade_eta(), Some(eta));

        env.ledger().with_mut(|l| l.timestamp += 172_800);
        assert!(env.ledger().timestamp() >= eta);

        // Oracle state stored under unrelated keys is unaffected by the
        // pending-upgrade queue living alongside it in the same instance.
        let price = client.get_price(&asset).expect("price preserved");
        assert_eq!(price.price, 100_000_000);
    }

    // Issue #375 — cancelling a pending upgrade clears it so execute fails.
    #[test]
    fn cancel_upgrade_clears_pending_state() {
        let (env, client, admin, _impl) = setup();
        let new_hash = hash(&env, 3);
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(admin.clone());
        client.init_multisig(&admin, &signers, &1u32);

        client.propose_upgrade(&admin, &new_hash);
        assert!(client.get_pending_upgrade().is_some());

        client.cancel_upgrade(&admin);
        assert!(client.get_pending_upgrade().is_none());
        assert!(client.try_execute_upgrade(&admin).is_err());
    }

    // Issue #375 — canary registration is tracked separately from the
    // canonical implementation until explicitly promoted.
    #[test]
    fn canary_registration_and_promotion() {
        let (env, client, admin, _impl) = setup();
        let canary = <Address as TestAddress>::generate(&env);

        client.set_canary(&admin, &canary, &500u32); // 5% traffic share
        let (registered, bps) = client.get_canary().expect("canary registered");
        assert_eq!(registered, canary);
        assert_eq!(bps, 500u32);

        client.promote_canary(&admin);
        assert_eq!(client.get_implementation(), Some(canary));
        assert!(client.get_canary().is_none());
    }
}
