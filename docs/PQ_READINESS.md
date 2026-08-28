# Preparing the Stellar Price Oracle for the Quantum Era

Post-quantum functionality is gated by `PQ_CRYPTO_ENABLED` and is disabled by default. The default scheme is Dilithium, with Falcon and SPHINCS+ supported as alternate scheme identifiers for clients that need smaller signatures or conservative hash-based signatures.

Hybrid signatures are encoded as `ed25519_signature || pq_signature || pq_scheme_id`. Verifiers keep accepting legacy Ed25519 signatures, and hybrid verifiers accept a message when either the Ed25519 or PQ branch validates. This preserves existing clients while allowing staged migration.

Key migration protocol:

1. Generate a PQ key pair.
2. Submit PQ public key registration signed by the current Ed25519 admin key.
3. Wait the configured cooldown, defaulting to seven days.
4. Activate the PQ admin key alongside the Ed25519 admin key.
5. After a second cooldown, optionally revoke the Ed25519 key.

Recommended schemes:

- Dilithium: default general-purpose signatures.
- Falcon: smaller signatures where payload size is constrained.
- SPHINCS+: conservative stateless hash-based signatures where size is acceptable.

Hybrid TLS is represented by the API policy module and requires `PQ_TLS_ENABLED=true`, TLS 1.3, X25519, ML-KEM, and Node linked against OpenSSL 3.x provider support or a BoringSSL build with experimental PQ support.

Threat monitoring uses `PQ_THREAT_FEED_URL` and `PQ_THREAT_ALERT_THRESHOLD`. When the observed level meets or exceeds the threshold, migration is mandatory.
