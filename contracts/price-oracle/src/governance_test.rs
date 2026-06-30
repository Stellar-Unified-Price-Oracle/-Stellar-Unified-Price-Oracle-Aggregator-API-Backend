#[cfg(test)]
mod governance_tests {
    use soroban_sdk::{testutils::Address as TestAddress, Address, Env, String};

    use crate::governance::{GovernanceContract, GovernanceContractClient};
    use crate::types::{GovernanceConfig, ProposalAction, ProposalStatus};

    // ── Mock token ────────────────────────────────────────────────────────────
    //
    // The governance contract calls a SEP-41 token's `balance` method via
    // `#[contractclient]`.  We register a trivial stub here so tests can
    // control per-account balances without a real token deployment.

    mod mock_token {
        use soroban_sdk::{contract, contractimpl, Address, Env};

        #[contract]
        pub struct MockToken;

        #[contractimpl]
        impl MockToken {
            pub fn balance(env: Env, id: Address) -> i128 {
                env.storage()
                    .instance()
                    .get::<Address, i128>(&id)
                    .unwrap_or(0)
            }

            pub fn set_balance(env: Env, id: Address, amount: i128) {
                env.storage().instance().set(&id, &amount);
            }
        }
    }

    use mock_token::{MockToken, MockTokenClient};

    // ── Test context ──────────────────────────────────────────────────────────

    struct Ctx {
        env: Env,
        gov: GovernanceContractClient<'static>,
        token: MockTokenClient<'static>,
        admin: Address,
        guardian: Address,
        proposer: Address,
        voter_a: Address,
        voter_b: Address,
    }

    fn setup() -> Ctx {
        let env = Env::default();

        let gov_id = env.register_contract(None, GovernanceContract);
        let token_id = env.register_contract(None, MockToken);

        let gov = GovernanceContractClient::new(&env, &gov_id);
        let token = MockTokenClient::new(&env, &token_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter_a = Address::generate(&env);
        let voter_b = Address::generate(&env);

        token.set_balance(&proposer, &1_000_000i128);
        token.set_balance(&voter_a, &500_000i128);
        token.set_balance(&voter_b, &300_000i128);

        Ctx { env, gov, token, admin, guardian, proposer, voter_a, voter_b }
    }

    fn default_config(token: Address, guardian: Address) -> GovernanceConfig {
        GovernanceConfig {
            token,
            proposal_threshold: 100_000i128,
            voting_period: 600,
            timelock_delay: 300,
            quorum: 200_000i128,
            guardian,
        }
    }

    fn init(ctx: &Ctx) {
        let cfg = default_config(ctx.token.address.clone(), ctx.guardian.clone());
        ctx.gov.initialize(&ctx.admin, &cfg);
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_succeeds() {
        let ctx = setup();
        let cfg = default_config(ctx.token.address.clone(), ctx.guardian.clone());
        assert!(ctx.gov.try_initialize(&ctx.admin, &cfg).is_ok());

        let stored = ctx.gov.get_governance_config().unwrap();
        assert_eq!(stored.quorum, 200_000i128);
        assert_eq!(stored.voting_period, 600u64);
    }

    #[test]
    fn test_double_initialize_rejected() {
        let ctx = setup();
        init(&ctx);
        let cfg = default_config(ctx.token.address.clone(), ctx.guardian.clone());
        assert!(ctx.gov.try_initialize(&ctx.admin, &cfg).is_err());
    }

    #[test]
    fn test_invalid_config_rejected() {
        let ctx = setup();
        let bad_cfg = GovernanceConfig {
            token: ctx.token.address.clone(),
            proposal_threshold: 100_000i128,
            voting_period: 0, // invalid
            timelock_delay: 300,
            quorum: 200_000i128,
            guardian: ctx.guardian.clone(),
        };
        assert!(ctx.gov.try_initialize(&ctx.admin, &bad_cfg).is_err());
    }

    // ── Proposal creation ─────────────────────────────────────────────────────

    #[test]
    fn test_propose_succeeds() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust XLM"),
        );
        assert_eq!(id, 1u32);
        assert_eq!(ctx.gov.proposal_count(), 1u32);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Active));
        assert_eq!(p.votes_for, 0);
    }

    #[test]
    fn test_propose_below_threshold_rejected() {
        let ctx = setup();
        init(&ctx);

        let poor = Address::generate(&ctx.env);
        ctx.token.set_balance(&poor, &50_000i128); // below 100_000 threshold

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "BTC"),
            true,
        );
        assert!(ctx.gov.try_propose(
            &poor,
            &action,
            &String::from_str(&ctx.env, "Trust BTC"),
        ).is_err());
    }

    #[test]
    fn test_propose_before_init_rejected() {
        let ctx = setup();
        // governance not initialised

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        assert!(ctx.gov.try_propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust XLM"),
        ).is_err());
    }

    #[test]
    fn test_proposal_count_increments() {
        let ctx = setup();
        init(&ctx);

        assert_eq!(ctx.gov.proposal_count(), 0u32);

        for i in 0u32..3 {
            let action = ProposalAction::SetTrustedAsset(
                String::from_str(&ctx.env, "XLM"),
                i % 2 == 0,
            );
            ctx.gov.propose(
                &ctx.proposer,
                &action,
                &String::from_str(&ctx.env, "p"),
            );
        }
        assert_eq!(ctx.gov.proposal_count(), 3u32);
    }

    // ── Voting ────────────────────────────────────────────────────────────────

    #[test]
    fn test_vote_for_and_against_recorded() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "ETH"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust ETH"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        ctx.gov.vote(&ctx.voter_b, &id, &false);

        assert!(ctx.gov.has_voted(&id, &ctx.voter_a));
        assert!(ctx.gov.has_voted(&id, &ctx.voter_b));
        assert!(!ctx.gov.has_voted(&id, &ctx.admin));

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert_eq!(p.votes_for, 500_000i128);
        assert_eq!(p.votes_against, 300_000i128);
    }

    #[test]
    fn test_double_vote_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "ETH"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust ETH"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        assert!(ctx.gov.try_vote(&ctx.voter_a, &id, &false).is_err());
    }

    #[test]
    fn test_vote_after_window_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "USDC"),
            false,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Untrust USDC"),
        );

        // Advance past voting_end (600 s)
        ctx.env.ledger().with_mut(|l| l.timestamp += 700);

        assert!(ctx.gov.try_vote(&ctx.voter_a, &id, &true).is_err());
    }

    #[test]
    fn test_vote_on_nonexistent_proposal_rejected() {
        let ctx = setup();
        init(&ctx);
        assert!(ctx.gov.try_vote(&ctx.voter_a, &999u32, &true).is_err());
    }

    // ── Queuing ───────────────────────────────────────────────────────────────

    #[test]
    fn test_queue_passes_after_voting_with_quorum() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust XLM"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true); // 500_000 > quorum of 200_000
        ctx.env.ledger().with_mut(|l| l.timestamp += 700);

        ctx.gov.queue(&id);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Queued));
    }

    #[test]
    fn test_queue_defeated_when_against_wins() {
        let ctx = setup();
        init(&ctx);

        ctx.token.set_balance(&ctx.voter_b, &700_000i128);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust XLM"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);   // 500_000 for
        ctx.gov.vote(&ctx.voter_b, &id, &false);  // 700_000 against
        ctx.env.ledger().with_mut(|l| l.timestamp += 700);

        assert!(ctx.gov.try_queue(&id).is_err());

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Defeated));
    }

    #[test]
    fn test_queue_quorum_not_met_defeated() {
        let ctx = setup();
        let cfg = GovernanceConfig {
            token: ctx.token.address.clone(),
            proposal_threshold: 100_000i128,
            voting_period: 600,
            timelock_delay: 300,
            quorum: 2_000_000i128, // very high
            guardian: ctx.guardian.clone(),
        };
        ctx.gov.initialize(&ctx.admin, &cfg);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "BTC"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust BTC"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true); // only 500_000
        ctx.env.ledger().with_mut(|l| l.timestamp += 700);

        assert!(ctx.gov.try_queue(&id).is_err());

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Defeated));
    }

    // ── Execution ─────────────────────────────────────────────────────────────

    #[test]
    fn test_execute_before_timelock_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "BTC"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust BTC"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        ctx.env.ledger().with_mut(|l| l.timestamp += 700); // past voting, not past timelock
        ctx.gov.queue(&id);

        // 700 s elapsed, execution_time = voting_period(600) + timelock_delay(300) = 900 s
        assert!(ctx.gov.try_execute(&id).is_err());
    }

    #[test]
    fn test_execute_after_timelock_succeeds() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "BTC"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust BTC"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        ctx.env.ledger().with_mut(|l| l.timestamp += 700);
        ctx.gov.queue(&id);
        ctx.env.ledger().with_mut(|l| l.timestamp += 300); // total 1000 s > 900

        ctx.gov.execute(&id);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Executed));
    }

    #[test]
    fn test_lazy_execution_without_explicit_queue() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "ETH"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust ETH"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        // Advance past both voting_end and timelock in one jump.
        ctx.env.ledger().with_mut(|l| l.timestamp += 1000);

        // execute() should resolve Active→Queued internally then execute.
        ctx.gov.execute(&id);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Executed));
    }

    #[test]
    fn test_execute_twice_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "USDT"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Trust USDT"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        ctx.env.ledger().with_mut(|l| l.timestamp += 1000);
        ctx.gov.execute(&id);

        assert!(ctx.gov.try_execute(&id).is_err());
    }

    #[test]
    fn test_update_governance_config_via_proposal() {
        let ctx = setup();
        init(&ctx);

        let new_cfg = GovernanceConfig {
            token: ctx.token.address.clone(),
            proposal_threshold: 50_000i128,
            voting_period: 1200,
            timelock_delay: 600,
            quorum: 100_000i128,
            guardian: ctx.guardian.clone(),
        };

        let action = ProposalAction::UpdateGovernanceConfig(new_cfg);
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Lower threshold"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        ctx.env.ledger().with_mut(|l| l.timestamp += 1000);
        ctx.gov.execute(&id);

        let stored = ctx.gov.get_governance_config().unwrap();
        assert_eq!(stored.proposal_threshold, 50_000i128);
        assert_eq!(stored.voting_period, 1200u64);
    }

    // ── Cancellation ──────────────────────────────────────────────────────────

    #[test]
    fn test_cancel_by_proposer() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "USDT"),
            false,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "p"),
        );

        ctx.gov.cancel(&ctx.proposer, &id);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Cancelled));
    }

    #[test]
    fn test_cancel_by_admin() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "USDT"),
            false,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "p"),
        );

        ctx.gov.cancel(&ctx.admin, &id);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Cancelled));
    }

    #[test]
    fn test_cancel_by_stranger_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "p"),
        );

        let stranger = Address::generate(&ctx.env);
        assert!(ctx.gov.try_cancel(&stranger, &id).is_err());
    }

    #[test]
    fn test_cancel_executed_proposal_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "p"),
        );

        ctx.gov.vote(&ctx.voter_a, &id, &true);
        ctx.env.ledger().with_mut(|l| l.timestamp += 1000);
        ctx.gov.execute(&id);

        assert!(ctx.gov.try_cancel(&ctx.admin, &id).is_err());
    }

    // ── Emergency override ────────────────────────────────────────────────────

    #[test]
    fn test_emergency_execute_skips_timelock() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "BTC"),
            false,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Emergency"),
        );

        // No time advance, no voting — guardian executes immediately.
        ctx.gov.emergency_execute(&ctx.guardian, &id);

        let p = ctx.gov.get_proposal(&id).unwrap();
        assert!(matches!(p.status, ProposalStatus::Executed));
    }

    #[test]
    fn test_emergency_execute_non_guardian_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "ETH"),
            false,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Emergency ETH"),
        );

        let impostor = Address::generate(&ctx.env);
        assert!(ctx.gov.try_emergency_execute(&impostor, &id).is_err());
    }

    #[test]
    fn test_emergency_execute_already_executed_rejected() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "ETH"),
            false,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "Emergency ETH"),
        );

        ctx.gov.emergency_execute(&ctx.guardian, &id);
        assert!(ctx.gov.try_emergency_execute(&ctx.guardian, &id).is_err());
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    #[test]
    fn test_get_nonexistent_proposal_returns_none() {
        let ctx = setup();
        init(&ctx);
        assert!(ctx.gov.get_proposal(&999u32).is_none());
    }

    #[test]
    fn test_has_voted_returns_false_before_voting() {
        let ctx = setup();
        init(&ctx);

        let action = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let id = ctx.gov.propose(
            &ctx.proposer,
            &action,
            &String::from_str(&ctx.env, "p"),
        );

        assert!(!ctx.gov.has_voted(&id, &ctx.voter_a));
    }

    #[test]
    fn test_multiple_proposals_independent() {
        let ctx = setup();
        init(&ctx);

        let action_a = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "XLM"),
            true,
        );
        let action_b = ProposalAction::SetTrustedAsset(
            String::from_str(&ctx.env, "BTC"),
            true,
        );

        let id_a = ctx.gov.propose(
            &ctx.proposer,
            &action_a,
            &String::from_str(&ctx.env, "Trust XLM"),
        );
        let id_b = ctx.gov.propose(
            &ctx.proposer,
            &action_b,
            &String::from_str(&ctx.env, "Trust BTC"),
        );

        ctx.gov.vote(&ctx.voter_a, &id_a, &true);
        // voter_a has NOT voted on id_b
        assert!(ctx.gov.has_voted(&id_a, &ctx.voter_a));
        assert!(!ctx.gov.has_voted(&id_b, &ctx.voter_a));

        let pa = ctx.gov.get_proposal(&id_a).unwrap();
        let pb = ctx.gov.get_proposal(&id_b).unwrap();
        assert_eq!(pa.votes_for, 500_000i128);
        assert_eq!(pb.votes_for, 0i128);
    }
}
