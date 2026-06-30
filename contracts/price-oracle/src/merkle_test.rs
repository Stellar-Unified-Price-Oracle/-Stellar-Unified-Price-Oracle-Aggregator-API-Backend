#[cfg(test)]
mod merkle_tests {
    use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, String, Vec};

    use crate::contract::{PriceOracleContract, PriceOracleContractClient};
    use crate::merkle::{compute_root, hash_leaf, verify_proof};
    use crate::types::{BatchPriceEntry, MerkleProof};

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, PriceOracleContractClient<'static>, Address, Address) {
        let env = Env::default();
        let id = env.register_contract(None, PriceOracleContract);
        let client = PriceOracleContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));
        (env, client, admin, oracle)
    }

    fn make_entry(env: &Env, asset: &str, price: i128, source: &Address) -> BatchPriceEntry {
        BatchPriceEntry {
            asset: String::from_str(env, asset),
            price,
            decimals: 7u32,
            timestamp: 1_000_000u64,
            source: source.clone(),
        }
    }

    /// Build a Merkle tree from leaves and return (root, proof_for_index).
    /// Mirrors the TypeScript MerkleTree.build() logic.
    fn build_tree(env: &Env, leaves: Vec<Bytes>) -> (Bytes, Vec<Vec<Bytes>>) {
        let mut levels: soroban_sdk::Vec<Vec<Bytes>> = soroban_sdk::Vec::new(env);
        levels.push_back(leaves.clone());

        let mut current = leaves;
        while current.len() > 1 {
            let len = current.len();
            let mut next: Vec<Bytes> = Vec::new(env);
            let mut i = 0u32;
            while i < len {
                let left = current.get(i).unwrap();
                let right = if i + 1 < len {
                    current.get(i + 1).unwrap()
                } else {
                    left.clone()
                };
                let mut buf = Bytes::new(env);
                buf.append(&left);
                buf.append(&right);
                next.push_back(env.crypto().sha256(&buf).into());
                i += 2;
            }
            levels.push_back(next.clone());
            current = next;
        }

        let root = current.get(0).unwrap();

        // Build proofs for each leaf
        let leaf_count = levels.get(0).unwrap().len();
        let mut all_proofs: Vec<Vec<Bytes>> = Vec::new(env);

        for leaf_idx in 0..leaf_count {
            let mut siblings: Vec<Bytes> = Vec::new(env);
            let mut idx = leaf_idx;
            for lvl in 0..levels.len() - 1 {
                let level_nodes = levels.get(lvl).unwrap();
                let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
                let sibling = if sibling_idx < level_nodes.len() {
                    level_nodes.get(sibling_idx).unwrap()
                } else {
                    level_nodes.get(idx).unwrap()
                };
                siblings.push_back(sibling);
                idx /= 2;
            }
            all_proofs.push_back(siblings);
        }

        (root, all_proofs)
    }

    // ── Unit: hash_leaf ───────────────────────────────────────────────────────

    #[test]
    fn test_hash_leaf_deterministic() {
        let env = Env::default();
        let source = Address::generate(&env);
        let entry = make_entry(&env, "XLM", 100_000_000, &source);
        let h1 = hash_leaf(&env, &entry);
        let h2 = hash_leaf(&env, &entry);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 32);
    }

    #[test]
    fn test_hash_leaf_differs_for_different_assets() {
        let env = Env::default();
        let source = Address::generate(&env);
        let e1 = make_entry(&env, "XLM", 100_000_000, &source);
        let e2 = make_entry(&env, "BTC", 100_000_000, &source);
        assert_ne!(hash_leaf(&env, &e1), hash_leaf(&env, &e2));
    }

    #[test]
    fn test_hash_leaf_differs_for_different_prices() {
        let env = Env::default();
        let source = Address::generate(&env);
        let e1 = make_entry(&env, "XLM", 1, &source);
        let e2 = make_entry(&env, "XLM", 2, &source);
        assert_ne!(hash_leaf(&env, &e1), hash_leaf(&env, &e2));
    }

    // ── Unit: verify_proof (single leaf = root) ───────────────────────────────

    #[test]
    fn test_verify_proof_single_leaf() {
        let env = Env::default();
        let source = Address::generate(&env);
        let entry = make_entry(&env, "XLM", 100_000_000, &source);

        let root = hash_leaf(&env, &entry);
        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        assert!(verify_proof(&env, &entry, proof.leaf_index, &proof.siblings, &root));
    }

    #[test]
    fn test_verify_proof_two_leaves() {
        let env = Env::default();
        let source = Address::generate(&env);

        let e0 = make_entry(&env, "XLM", 100_000_000, &source);
        let e1 = make_entry(&env, "BTC", 50_000_000_000, &source);

        let h0 = hash_leaf(&env, &e0);
        let h1 = hash_leaf(&env, &e1);

        let mut buf = Bytes::new(&env);
        buf.append(&h0);
        buf.append(&h1);
        let root: Bytes = env.crypto().sha256(&buf).into();

        // Proof for leaf 0: sibling is h1
        let mut siblings0: Vec<Bytes> = Vec::new(&env);
        siblings0.push_back(h1.clone());
        assert!(verify_proof(&env, &e0, 0, &siblings0, &root));

        // Proof for leaf 1: sibling is h0
        let mut siblings1: Vec<Bytes> = Vec::new(&env);
        siblings1.push_back(h0.clone());
        assert!(verify_proof(&env, &e1, 1, &siblings1, &root));
    }

    #[test]
    fn test_verify_proof_rejects_wrong_entry() {
        let env = Env::default();
        let source = Address::generate(&env);

        let e0 = make_entry(&env, "XLM", 100_000_000, &source);
        let e1 = make_entry(&env, "BTC", 50_000_000_000, &source);
        let impostor = make_entry(&env, "XLM", 999, &source);

        let h0 = hash_leaf(&env, &e0);
        let h1 = hash_leaf(&env, &e1);

        let mut buf = Bytes::new(&env);
        buf.append(&h0);
        buf.append(&h1);
        let root: Bytes = env.crypto().sha256(&buf).into();

        let mut siblings: Vec<Bytes> = Vec::new(&env);
        siblings.push_back(h1.clone());

        // Should fail because impostor != e0
        assert!(!verify_proof(&env, &impostor, 0, &siblings, &root));
    }

    #[test]
    fn test_verify_proof_rejects_wrong_root() {
        let env = Env::default();
        let source = Address::generate(&env);
        let entry = make_entry(&env, "XLM", 100_000_000, &source);

        let wrong_root = Bytes::from_array(&env, &[0u8; 32]);
        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        assert!(!verify_proof(&env, &entry, proof.leaf_index, &proof.siblings, &wrong_root));
    }

    // ── Unit: compute_root ────────────────────────────────────────────────────

    #[test]
    fn test_compute_root_single_leaf() {
        let env = Env::default();
        let source = Address::generate(&env);
        let entry = make_entry(&env, "XLM", 1, &source);

        let h = hash_leaf(&env, &entry);
        let mut leaves: Vec<Bytes> = Vec::new(&env);
        leaves.push_back(h.clone());

        let root = compute_root(&env, leaves);
        assert_eq!(root, h);
    }

    #[test]
    fn test_compute_root_two_leaves_matches_manual() {
        let env = Env::default();
        let source = Address::generate(&env);
        let e0 = make_entry(&env, "XLM", 1, &source);
        let e1 = make_entry(&env, "BTC", 2, &source);

        let h0 = hash_leaf(&env, &e0);
        let h1 = hash_leaf(&env, &e1);

        let mut buf = Bytes::new(&env);
        buf.append(&h0);
        buf.append(&h1);
        let expected: Bytes = env.crypto().sha256(&buf).into();

        let mut leaves: Vec<Bytes> = Vec::new(&env);
        leaves.push_back(h0);
        leaves.push_back(h1);

        assert_eq!(compute_root(&env, leaves), expected);
    }

    // ── Integration: submit_batch + apply_batch_entry ─────────────────────────

    #[test]
    fn test_submit_and_apply_single_entry_batch() {
        let (env, client, _admin, oracle) = setup();

        let entry = make_entry(&env, "XLM", 100_000_000, &oracle);
        let leaf = hash_leaf(&env, &entry);

        // Root of single-leaf tree is the leaf itself
        let root = leaf.clone();

        let nonce = client.get_batch_nonce();
        assert_eq!(nonce, 0u64);

        client.submit_batch(&oracle, &nonce, &root);
        assert_eq!(client.get_batch_nonce(), 1u64);

        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        let dp = client.apply_batch_entry(&nonce, &entry, &proof);
        assert_eq!(dp.price, 100_000_000);
        assert_eq!(dp.asset, String::from_str(&env, "XLM"));

        let stored = client.get_price(&String::from_str(&env, "XLM")).unwrap();
        assert_eq!(stored.price, 100_000_000);
    }

    #[test]
    fn test_submit_and_apply_multi_entry_batch() {
        let (env, client, _admin, oracle) = setup();

        let entries = [
            make_entry(&env, "XLM", 100_000_000, &oracle),
            make_entry(&env, "BTC", 50_000_000_000, &oracle),
            make_entry(&env, "ETH", 3_000_000_000, &oracle),
        ];

        // Build leaves
        let mut leaves: Vec<Bytes> = Vec::new(&env);
        for e in &entries {
            leaves.push_back(hash_leaf(&env, e));
        }

        let (root, proofs) = build_tree(&env, leaves);

        let nonce = client.get_batch_nonce();
        client.submit_batch(&oracle, &nonce, &root);

        for (i, e) in entries.iter().enumerate() {
            let proof = MerkleProof {
                leaf_index: i as u32,
                siblings: proofs[i as u32].clone(),
            };
            let dp = client.apply_batch_entry(&nonce, e, &proof);
            assert_eq!(dp.asset, e.asset);
            assert_eq!(dp.price, e.price);
        }

        // Verify all prices stored
        assert_eq!(
            client.get_price(&String::from_str(&env, "XLM")).unwrap().price,
            100_000_000
        );
        assert_eq!(
            client.get_price(&String::from_str(&env, "BTC")).unwrap().price,
            50_000_000_000
        );
        assert_eq!(
            client.get_price(&String::from_str(&env, "ETH")).unwrap().price,
            3_000_000_000
        );
    }

    #[test]
    fn test_verify_batch_proof_returns_true_for_valid_proof() {
        let (env, client, _admin, oracle) = setup();

        let entry = make_entry(&env, "XLM", 100_000_000, &oracle);
        let root = hash_leaf(&env, &entry);
        let nonce = client.get_batch_nonce();
        client.submit_batch(&oracle, &nonce, &root);

        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        assert!(client.verify_batch_proof(&nonce, &entry, &proof));
    }

    #[test]
    fn test_verify_batch_proof_returns_false_for_invalid_proof() {
        let (env, client, _admin, oracle) = setup();

        let entry = make_entry(&env, "XLM", 100_000_000, &oracle);
        let root = hash_leaf(&env, &entry);
        let nonce = client.get_batch_nonce();
        client.submit_batch(&oracle, &nonce, &root);

        let bad_entry = make_entry(&env, "XLM", 999, &oracle);
        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        assert!(!client.verify_batch_proof(&nonce, &bad_entry, &proof));
    }

    // ── Replay protection ─────────────────────────────────────────────────────

    #[test]
    fn test_wrong_nonce_rejected() {
        let (env, client, _admin, oracle) = setup();

        let entry = make_entry(&env, "XLM", 100_000_000, &oracle);
        let root = hash_leaf(&env, &entry);

        // nonce should be 0 but we pass 1
        let result = client.try_submit_batch(&oracle, &1u64, &root);
        assert!(result.is_err());
    }

    #[test]
    fn test_nonce_increments_after_each_batch() {
        let (env, client, _admin, oracle) = setup();

        for expected_nonce in 0u64..3 {
            assert_eq!(client.get_batch_nonce(), expected_nonce);
            let entry = make_entry(&env, "XLM", expected_nonce as i128, &oracle);
            let root = hash_leaf(&env, &entry);
            client.submit_batch(&oracle, &expected_nonce, &root);
        }
        assert_eq!(client.get_batch_nonce(), 3u64);
    }

    #[test]
    fn test_apply_entry_against_old_nonce_root_succeeds() {
        let (env, client, _admin, oracle) = setup();

        // Batch 0
        let entry0 = make_entry(&env, "XLM", 100, &oracle);
        let root0 = hash_leaf(&env, &entry0);
        let nonce0 = client.get_batch_nonce();
        client.submit_batch(&oracle, &nonce0, &root0);

        // Batch 1
        let entry1 = make_entry(&env, "BTC", 200, &oracle);
        let root1 = hash_leaf(&env, &entry1);
        let nonce1 = client.get_batch_nonce();
        client.submit_batch(&oracle, &nonce1, &root1);

        // Apply from batch 0 is still valid (roots are stored permanently)
        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };
        let dp = client.apply_batch_entry(&nonce0, &entry0, &proof);
        assert_eq!(dp.price, 100);
    }

    // ── Unauthorized rejection ────────────────────────────────────────────────

    #[test]
    fn test_unauthorized_source_cannot_submit_batch() {
        let (env, client, _admin, _oracle) = setup();

        let rogue = Address::generate(&env);
        let root = Bytes::from_array(&env, &[1u8; 32]);
        let result = client.try_submit_batch(&rogue, &0u64, &root);
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_root_length_rejected() {
        let (env, client, _admin, oracle) = setup();

        // Root must be exactly 32 bytes
        let bad_root = Bytes::from_array(&env, &[0u8; 16]);
        let result = client.try_submit_batch(&oracle, &0u64, &bad_root);
        assert!(result.is_err());
    }

    #[test]
    fn test_apply_entry_with_no_committed_root_rejected() {
        let (env, client, _admin, oracle) = setup();

        let entry = make_entry(&env, "XLM", 100, &oracle);
        let proof = MerkleProof {
            leaf_index: 0,
            siblings: Vec::new(&env),
        };

        // nonce 0 has no committed root yet
        let result = client.try_apply_batch_entry(&0u64, &entry, &proof);
        assert!(result.is_err());
    }

    #[test]
    fn test_apply_with_wrong_proof_rejected() {
        let (env, client, _admin, oracle) = setup();

        let entry = make_entry(&env, "XLM", 100_000_000, &oracle);
        let root = hash_leaf(&env, &entry);
        let nonce = client.get_batch_nonce();
        client.submit_batch(&oracle, &nonce, &root);

        // Wrong sibling corrupts the proof
        let mut bad_siblings: Vec<Bytes> = Vec::new(&env);
        bad_siblings.push_back(Bytes::from_array(&env, &[0xffu8; 32]));

        let bad_proof = MerkleProof {
            leaf_index: 0,
            siblings: bad_siblings,
        };

        let result = client.try_apply_batch_entry(&nonce, &entry, &bad_proof);
        assert!(result.is_err());
    }

    // ── Gas benchmark: batch vs individual ───────────────────────────────────

    #[test]
    fn bench_individual_vs_batch_5_assets() {
        let env = Env::default();
        let id = env.register_contract(None, PriceOracleContract);
        let client = PriceOracleContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        client.add_oracle_source(&admin, &oracle, &String::from_str(&env, "Chainlink"));

        let assets = ["XLM", "BTC", "ETH", "USDC", "USDT"];

        // Measure individual submissions
        env.budget().reset_default();
        for asset in &assets {
            let _ = client.try_submit_price(
                &oracle,
                &String::from_str(&env, asset),
                &1_000_000i128,
                &7u32,
                &0u64,
            );
        }
        let individual_cpu = env.budget().cpu_instruction_count();
        let individual_mem = env.budget().memory_bytes_count();

        // Reset and measure batch submission
        let env2 = Env::default();
        let id2 = env2.register_contract(None, PriceOracleContract);
        let client2 = PriceOracleContractClient::new(&env2, &id2);
        let admin2 = Address::generate(&env2);
        let oracle2 = Address::generate(&env2);
        client2.initialize(&admin2);
        client2.add_oracle_source(&admin2, &oracle2, &String::from_str(&env2, "Chainlink"));

        let entries: Vec<BatchPriceEntry> = {
            let mut v = soroban_sdk::Vec::new(&env2);
            for asset in &assets {
                v.push_back(make_entry(&env2, asset, 1_000_000, &oracle2));
            }
            v
        };

        let mut leaves: soroban_sdk::Vec<Bytes> = soroban_sdk::Vec::new(&env2);
        for i in 0..entries.len() {
            leaves.push_back(hash_leaf(&env2, &entries.get(i).unwrap()));
        }
        let (root, proofs) = build_tree(&env2, leaves);
        let nonce = client2.get_batch_nonce();

        env2.budget().reset_default();
        client2.submit_batch(&oracle2, &nonce, &root);
        for i in 0..entries.len() {
            let proof = MerkleProof {
                leaf_index: i,
                siblings: proofs.get(i).unwrap(),
            };
            let _ = client2.try_apply_batch_entry(&nonce, &entries.get(i).unwrap(), &proof);
        }
        let batch_cpu = env2.budget().cpu_instruction_count();
        let batch_mem = env2.budget().memory_bytes_count();

        println!(
            "\n[BENCH] 5-asset individual: cpu={individual_cpu}, mem={individual_mem}"
        );
        println!("[BENCH] 5-asset batch:      cpu={batch_cpu}, mem={batch_mem}");
        println!(
            "[BENCH] CPU saving: {}%",
            if individual_cpu > 0 {
                (100u64.saturating_sub(batch_cpu * 100 / individual_cpu))
            } else {
                0
            }
        );
    }
}
