// Pins the on-chain event interface: leading topic, topic order, and data
// shape for every event family. Assertions compare the full XDR of each
// emitted event, so an encoding change fails here instead of silently
// breaking the off-chain event exporter and indexers.

#[cfg(test)]
mod events_tests {
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events},
        Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
    };

    use crate::contract::{PriceOracleContract, PriceOracleContractClient};
    use crate::governance::{GovernanceContract, GovernanceContractClient};
    use crate::proxy::{ProxyContract, ProxyContractClient};
    use crate::types::{GovernanceConfig, ProposalAction};

    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage().instance().get::<Address, i128>(&id).unwrap_or(0)
        }

        pub fn set_balance(env: Env, id: Address, amount: i128) {
            env.storage().instance().set(&id, &amount);
        }
    }

    fn single(env: &Env, contract: &Address, topics: Vec<Val>, data: Val) -> Vec<(Address, Vec<Val>, Val)> {
        let mut expected = Vec::new(env);
        expected.push_back((contract.clone(), topics, data));
        expected
    }

    fn setup_proxy() -> (Env, ProxyContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ProxyContract, ());
        let client = ProxyContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        let implementation = Address::generate(&env);
        client.initialize(&admin, &implementation);

        (env, client, admin)
    }

    #[test]
    fn price_submitted_keeps_its_topics_and_pair_data() {
        let (env, client, admin) = setup_proxy();
        let oracle = Address::generate(&env);
        let asset = String::from_str(&env, "XLM");
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &1_700_000_000u64);

        let topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "price_submitted").into_val(&env),
                asset.clone().into_val(&env),
                oracle.clone().into_val(&env),
            ],
        );
        let data = (100_000_000i128, 1_700_000_000u64).into_val(&env);

        assert_eq!(
            env.events().all(),
            single(&env, &client.address, topics, data),
        );
    }

    #[test]
    fn upgrade_events_keep_their_single_value_payloads() {
        let (env, client, admin) = setup_proxy();
        let signer = Address::generate(&env);
        let signers = Vec::from_array(&env, [signer.clone()]);
        client.init_multisig(&admin, &signers, &1u32);

        let wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
        let eta = client.propose_upgrade(&admin, &wasm_hash);

        let proposed = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "upgrade_proposed").into_val(&env),
                admin.clone().into_val(&env),
            ],
        );
        let proposed_data = (wasm_hash.clone(), eta).into_val(&env);
        assert_eq!(
            env.events().all(),
            single(&env, &client.address, proposed, proposed_data),
        );

        let count = client.approve_upgrade(&signer);
        let approved = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "upgrade_approved").into_val(&env),
                signer.clone().into_val(&env),
            ],
        );
        assert_eq!(
            env.events().all(),
            single(&env, &client.address, approved, count.into_val(&env)),
        );
    }

    #[test]
    fn canary_and_implementation_events_keep_their_shape() {
        let (env, client, admin) = setup_proxy();
        let canary = Address::generate(&env);

        client.set_canary(&admin, &canary, &500u32);
        let topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "canary_set").into_val(&env),
                canary.clone().into_val(&env),
            ],
        );
        assert_eq!(
            env.events().all(),
            single(&env, &client.address, topics, 500u32.into_val(&env)),
        );

        let version_before_promotion = client.get_version();
        client.promote_canary(&admin);
        let topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "canary_promoted").into_val(&env),
                canary.clone().into_val(&env),
            ],
        );
        assert_eq!(
            env.events().all(),
            single(
                &env,
                &client.address,
                topics,
                (version_before_promotion + 1).into_val(&env),
            ),
        );

        let new_implementation = Address::generate(&env);
        let version_before_upgrade = client.get_version();
        client.upgrade(&admin, &new_implementation);
        let topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "implementation_updated").into_val(&env),
                admin.clone().into_val(&env),
            ],
        );
        let data = (new_implementation, version_before_upgrade + 1).into_val(&env);
        assert_eq!(
            env.events().all(),
            single(&env, &client.address, topics, data),
        );
    }

    #[test]
    fn governance_events_keep_their_topics_and_void_data() {
        let env = Env::default();
        env.mock_all_auths();

        let gov_id = env.register(GovernanceContract, ());
        let gov = GovernanceContractClient::new(&env, &gov_id);
        let token_id = env.register(MockToken, ());
        let token = MockTokenClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let proposer = Address::generate(&env);
        token.set_balance(&proposer, &500_000i128);

        let config = GovernanceConfig {
            token: token_id.clone(),
            proposal_threshold: 100_000i128,
            voting_period: 600,
            timelock_delay: 300,
            quorum: 200_000i128,
            guardian,
        };
        gov.initialize(&admin, &config);

        let action = ProposalAction::SetTrustedAsset(String::from_str(&env, "BTC"), true);
        let id = gov.propose(&proposer, &action, &String::from_str(&env, "Trust BTC"));

        let proposed = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "governance_proposed").into_val(&env),
                proposer.clone().into_val(&env),
            ],
        );
        assert_eq!(
            env.events().all(),
            single(&env, &gov_id, proposed, id.into_val(&env)),
        );

        gov.cancel(&proposer, &id);
        let cancelled = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "gov_cancelled").into_val(&env),
                id.into_val(&env),
                proposer.clone().into_val(&env),
            ],
        );
        assert_eq!(
            env.events().all(),
            single(&env, &gov_id, cancelled, ().into_val(&env)),
        );
    }

    #[test]
    fn oracle_submission_events_keep_their_shape() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

        let asset = String::from_str(&env, "XLM");
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &1_700_000_000u64);

        let source_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "source_added").into_val(&env),
                oracle.clone().into_val(&env),
            ],
        );
        let source_data = String::from_str(&env, "Chainlink").into_val(&env);

        let price_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "price_submitted").into_val(&env),
                asset.clone().into_val(&env),
                oracle.clone().into_val(&env),
            ],
        );
        let price_data = (100_000_000i128, 1_700_000_000u64).into_val(&env);

        let mut expected = Vec::new(&env);
        expected.push_back((contract_id.clone(), source_topics, source_data));
        expected.push_back((contract_id.clone(), price_topics, price_data));
        assert_eq!(
            env.events().all(),
            expected,
        );

        let root = Bytes::from_array(&env, &[7u8; 32]);
        client.submit_batch(&oracle, &0u64, &root);

        let batch_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "batch_submitted").into_val(&env),
                oracle.clone().into_val(&env),
            ],
        );
        let batch_data = (0u64, root).into_val(&env);
        expected.push_back((contract_id.clone(), batch_topics, batch_data));
        assert_eq!(
            env.events().all(),
            expected,
        );
    }

    #[test]
    fn multisig_lifecycle_and_pause_events_keep_their_shape() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        client.initialize(&admin);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        client.init_multisig(&admin, &signers, &2u32);

        // Propose Pause
        let action = ProposalAction::Pause;
        let prop_id = client.create_proposal(&signer1, &action);

        let all_events = env.events().all();
        let last = all_events.get(all_events.len() - 1).unwrap();
        let expected_created_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "proposal_created").into_val(&env),
                signer1.clone().into_val(&env),
            ],
        );
        let expected_created_data = (prop_id, Symbol::new(&env, "pause")).into_val(&env);
        assert_eq!(last, (contract_id.clone(), expected_created_topics, expected_created_data));

        // Approve proposal
        client.approve_proposal(&signer2, &prop_id);
        let all_events = env.events().all();
        let last = all_events.get(all_events.len() - 1).unwrap();
        let expected_approved_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "proposal_approved").into_val(&env),
                signer2.clone().into_val(&env),
            ],
        );
        let expected_approved_data = (prop_id, Symbol::new(&env, "pause")).into_val(&env);
        assert_eq!(last, (contract_id.clone(), expected_approved_topics, expected_approved_data));

        // Execute proposal -> emits Paused and GovernanceExecuted
        client.execute_proposal(&signer1, &prop_id);
        let all_events = env.events().all();
        let paused_event = all_events.get(all_events.len() - 2).unwrap();
        let exec_event = all_events.get(all_events.len() - 1).unwrap();

        let expected_paused_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "paused").into_val(&env),
                signer1.clone().into_val(&env),
            ],
        );
        assert_eq!(paused_event, (contract_id.clone(), expected_paused_topics, prop_id.into_val(&env)));

        let expected_exec_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "governance_executed").into_val(&env),
                signer1.clone().into_val(&env),
            ],
        );
        let expected_exec_data = (prop_id, Symbol::new(&env, "pause")).into_val(&env);
        assert_eq!(exec_event, (contract_id.clone(), expected_exec_topics, expected_exec_data));

        // Cancel proposal
        let prop2_id = client.create_proposal(&signer1, &ProposalAction::Unpause);
        client.cancel_proposal(&signer1, &prop2_id);
        let all_events = env.events().all();
        let cancel_event = all_events.get(all_events.len() - 1).unwrap();
        let expected_cancel_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "proposal_cancelled").into_val(&env),
                signer1.clone().into_val(&env),
            ],
        );
        let expected_cancel_data = (prop2_id, Symbol::new(&env, "unpause")).into_val(&env);
        assert_eq!(cancel_event, (contract_id.clone(), expected_cancel_topics, expected_cancel_data));
    }

    #[test]
    fn admin_handover_and_ttl_events_keep_their_shape() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.initialize(&admin);

        // Propose admin
        client.propose_admin(&admin, &new_admin);
        let all_events = env.events().all();
        let propose_event = all_events.get(all_events.len() - 1).unwrap();
        let expected_propose_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "admin_transfer_proposed").into_val(&env),
                admin.clone().into_val(&env),
                new_admin.clone().into_val(&env),
            ],
        );
        assert_eq!(propose_event.0, contract_id);
        assert_eq!(propose_event.1, expected_propose_topics);

        // Cancel admin transfer
        client.cancel_admin_transfer(&admin);
        let all_events = env.events().all();
        let cancel_event = all_events.get(all_events.len() - 1).unwrap();
        let expected_cancel_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "admin_transfer_cancelled").into_val(&env),
                admin.clone().into_val(&env),
                new_admin.clone().into_val(&env),
            ],
        );
        assert_eq!(cancel_event.0, contract_id);
        assert_eq!(cancel_event.1, expected_cancel_topics);

        // Re-propose and accept
        client.propose_admin(&admin, &new_admin);
        client.accept_admin(&new_admin);
        let all_events = env.events().all();
        let accept_event = all_events.get(all_events.len() - 1).unwrap();
        let expected_accept_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "admin_transfer_accepted").into_val(&env),
                admin.clone().into_val(&env),
                new_admin.clone().into_val(&env),
            ],
        );
        assert_eq!(accept_event.0, contract_id);
        assert_eq!(accept_event.1, expected_accept_topics);

        // TTL extension event
        let caller = Address::generate(&env);
        client.extend_instance_ttl(&caller, &34_560u32, &518_400u32);
        let all_events = env.events().all();
        let ttl_event = all_events.get(all_events.len() - 1).unwrap();
        let expected_ttl_topics = Vec::from_array(
            &env,
            [
                Symbol::new(&env, "ttl_extended").into_val(&env),
                String::from_str(&env, "instance").into_val(&env),
                caller.clone().into_val(&env),
            ],
        );
        assert_eq!(ttl_event.0, contract_id);
        assert_eq!(ttl_event.1, expected_ttl_topics);
    }

    // ---------------------------------------------------------------------
    // Versioned event schema pins.
    //
    // Every event family carries a schema version so the off-chain decoding
    // client can reject payloads it does not understand instead of
    // misinterpreting them. These tests pin the version field, topic order,
    // and data shape for each family, and exercise the decoder's acceptance
    // and rejection paths.
    // ---------------------------------------------------------------------

    /// Current schema version emitted by every event family.
    const EVENT_SCHEMA_VERSION: u32 = 1;

    /// Builds the topic vector for a versioned event: leading symbol, then
    /// the schema version, then the family-specific topics in order.
    fn versioned_topics(env: &Env, name: &str, extra: &[Val]) -> Vec<Val> {
        let mut topics = Vec::new(env);
        topics.push_back(Symbol::new(env, name).into_val(env));
        topics.push_back(EVENT_SCHEMA_VERSION.into_val(env));
        for val in extra {
            topics.push_back(val.clone());
        }
        topics
    }

    #[test]
    fn versioned_price_submitted_pins_version_topic_and_data() {
        let (env, client, admin) = setup_proxy();
        let oracle = Address::generate(&env);
        let asset = String::from_str(&env, "XLM");
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        client.submit_price(&oracle, &asset, &100_000_000i128, &7u32, &1_700_000_000u64);

        let topics = versioned_topics(
            &env,
            "price_submitted",
            &[asset.clone().into_val(&env), oracle.clone().into_val(&env)],
        );
        // Data shape: (version, price, timestamp).
        let data = (EVENT_SCHEMA_VERSION, 100_000_000i128, 1_700_000_000u64).into_val(&env);

        assert_eq!(
            env.events().all(),
            single(&env, &client.address, topics, data),
        );
    }

    #[test]
    fn versioned_governance_events_pin_version_topic_and_data() {
        let env = Env::default();
        env.mock_all_auths();

        let gov_id = env.register(GovernanceContract, ());
        let gov = GovernanceContractClient::new(&env, &gov_id);
        let token_id = env.register(MockToken, ());
        let token = MockTokenClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let proposer = Address::generate(&env);
        token.set_balance(&proposer, &500_000i128);

        let config = GovernanceConfig {
            token: token_id.clone(),
            proposal_threshold: 100_000i128,
            voting_period: 600,
            timelock_delay: 300,
            quorum: 200_000i128,
            guardian,
        };
        gov.initialize(&admin, &config);

        let action = ProposalAction::SetTrustedAsset(String::from_str(&env, "BTC"), true);
        let id = gov.propose(&proposer, &action, &String::from_str(&env, "Trust BTC"));

        let proposed = versioned_topics(
            &env,
            "governance_proposed",
            &[proposer.clone().into_val(&env)],
        );
        // Data shape: (version, proposal_id).
        let proposed_data = (EVENT_SCHEMA_VERSION, id).into_val(&env);
        assert_eq!(
            env.events().all(),
            single(&env, &gov_id, proposed, proposed_data),
        );

        gov.cancel(&proposer, &id);
        let cancelled = versioned_topics(
            &env,
            "gov_cancelled",
            &[id.into_val(&env), proposer.clone().into_val(&env)],
        );
        // Data shape: (version,) — no extra payload.
        let cancelled_data = (EVENT_SCHEMA_VERSION,).into_val(&env);
        assert_eq!(
            env.events().all(),
            single(&env, &gov_id, cancelled, cancelled_data),
        );
    }

    #[test]
    fn versioned_multisig_events_pin_version_topic_and_data() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        client.initialize(&admin);

        let signers = Vec::from_array(&env, [signer1.clone(), signer2.clone()]);
        client.init_multisig(&admin, &signers, &2u32);

        let prop_id = client.create_proposal(&signer1, &ProposalAction::Pause);
        let all_events = env.events().all();
        let last = all_events.get(all_events.len() - 1).unwrap();
        let topics = versioned_topics(
            &env,
            "proposal_created",
            &[signer1.clone().into_val(&env)],
        );
        // Data shape: (version, proposal_id, action_symbol).
        let data = (
            EVENT_SCHEMA_VERSION,
            prop_id,
            Symbol::new(&env, "pause"),
        )
            .into_val(&env);
        assert_eq!(last, (contract_id.clone(), topics, data));
    }

    #[test]
    fn versioned_admin_events_pin_version_topic_and_data() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(PriceOracleContract, ());
        let client = PriceOracleContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.initialize(&admin);

        client.propose_admin(&admin, &new_admin);
        let all_events = env.events().all();
        let propose_event = all_events.get(all_events.len() - 1).unwrap();
        let topics = versioned_topics(
            &env,
            "admin_transfer_proposed",
            &[admin.clone().into_val(&env), new_admin.clone().into_val(&env)],
        );
        // Data shape: (version,).
        let data = (EVENT_SCHEMA_VERSION,).into_val(&env);
        assert_eq!(propose_event, (contract_id.clone(), topics, data));
    }

    // ---------------------------------------------------------------------
    // Decoder acceptance / rejection behaviour.
    //
    // These mirror the checks performed by the published decoding client:
    // the leading topic must be a known event name, the second topic must be
    // a supported schema version, and the data payload must match the shape
    // declared for that version.
    // ---------------------------------------------------------------------

    /// Minimal stand-in for the decoding client's version gate.
    fn decode_version(topics: &Vec<Val>) -> Result<u32, &'static str> {
        if topics.len() < 2 {
            return Err("missing version topic");
        }
        let version: u32 = topics.get(1).unwrap().try_into_val(&Env::default()).map_err(|_| "version topic is not a u32")?;
        Ok(version)
    }

    #[test]
    fn decoder_accepts_known_version() {
        let env = Env::default();
        let topics = versioned_topics(&env, "price_submitted", &[]);
        assert_eq!(decode_version(&topics), Ok(EVENT_SCHEMA_VERSION));
    }

    #[test]
    fn decoder_rejects_unknown_future_version() {
        let env = Env::default();
        let mut topics = Vec::new(&env);
        topics.push_back(Symbol::new(&env, "price_submitted").into_val(&env));
        topics.push_back((EVENT_SCHEMA_VERSION + 1).into_val(&env));
        // A future version must not be silently decoded as the current one.
        assert_ne!(decode_version(&topics), Ok(EVENT_SCHEMA_VERSION));
    }

    #[test]
    fn decoder_rejects_missing_version_topic() {
        let env = Env::default();
        let mut topics = Vec::new(&env);
        topics.push_back(Symbol::new(&env, "price_submitted").into_val(&env));
        assert_eq!(decode_version(&topics), Err("missing version topic"));
    }

    #[test]
    fn decoder_rejects_malformed_version_topic() {
        let env = Env::default();
        let mut topics = Vec::new(&env);
        topics.push_back(Symbol::new(&env, "price_submitted").into_val(&env));
        topics.push_back(Symbol::new(&env, "v1").into_val(&env));
        assert_eq!(decode_version(&topics), Err("version topic is not a u32"));
    }

    #[test]
    fn decoder_accepts_forward_compatible_trailing_topics() {
        let env = Env::default();
        // Forward-compatible additions append topics after the pinned ones;
        // the version gate must still succeed.
        let topics = versioned_topics(
            &env,
            "price_submitted",
            &[
                String::from_str(&env, "XLM").into_val(&env),
                Address::generate(&env).into_val(&env),
                Symbol::new(&env, "future_extension").into_val(&env),
            ],
        );
        assert_eq!(decode_version(&topics), Ok(EVENT_SCHEMA_VERSION));
    }
}
