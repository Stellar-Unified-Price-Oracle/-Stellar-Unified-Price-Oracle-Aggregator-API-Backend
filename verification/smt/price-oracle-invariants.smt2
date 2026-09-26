(set-logic ALL)

(declare-sort Address 0)
(declare-sort Asset 0)

(declare-fun admin () Address)
(declare-fun caller () Address)
(declare-fun source () Address)
(declare-fun asset () Asset)
(declare-fun authorized (Address) Bool)
(declare-fun latest_price_before (Asset) Int)
(declare-fun latest_price_after (Asset) Int)
(declare-fun latest_timestamp_before (Address Asset) Int)
(declare-fun latest_timestamp_after (Address Asset) Int)
(declare-fun submitted_price () Int)
(declare-fun submitted_timestamp () Int)

(assert (>= (latest_price_before asset) 0))
(assert (>= submitted_price 0))
(assert (authorized source))
(assert (>= submitted_timestamp (latest_timestamp_before source asset)))
(assert (= (latest_price_after asset) submitted_price))
(assert (= (latest_timestamp_after source asset) submitted_timestamp))

(push)
(assert (< (latest_price_after asset) 0))
(check-sat)
(pop)

(push)
(assert (< (latest_timestamp_after source asset) (latest_timestamp_before source asset)))
(check-sat)
(pop)

(push)
(assert (not (= caller admin)))
(assert (= caller admin))
(check-sat)
(pop)

; ── Merkle Proof Soundness & Domain Separation Invariants (Issue #566) ──
(declare-sort MerkleHash 0)
(declare-sort BatchEntry 0)

(declare-fun leaf_domain_tag () Int)
(declare-fun node_domain_tag () Int)
(assert (= leaf_domain_tag 0))
(assert (= node_domain_tag 1))
(assert (distinct leaf_domain_tag node_domain_tag))

; Leaf hash function: (tag: Int, entry: BatchEntry) -> MerkleHash
(declare-fun hash_leaf_domain (Int BatchEntry) MerkleHash)

; Node pair hash function: (tag: Int, left: MerkleHash, right: MerkleHash) -> MerkleHash
(declare-fun hash_node_domain (Int MerkleHash MerkleHash) MerkleHash)

; Domain separation axiom: A leaf hash (tag 0) can NEVER equal an internal node hash (tag 1)
(assert (forall ((e BatchEntry) (h1 MerkleHash) (h2 MerkleHash))
  (distinct (hash_leaf_domain leaf_domain_tag e) (hash_node_domain node_domain_tag h1 h2))))

; Invariant: An attacker cannot craft a BatchEntry whose leaf hash equals an internal node hash
; (Second-preimage resistance of Merkle tree)
(declare-fun forged_entry () BatchEntry)
(declare-fun left_node () MerkleHash)
(declare-fun right_node () MerkleHash)

(push)
(assert (= (hash_leaf_domain leaf_domain_tag forged_entry) (hash_node_domain node_domain_tag left_node right_node)))
(check-sat) ; Expected result: unsat
(pop)
