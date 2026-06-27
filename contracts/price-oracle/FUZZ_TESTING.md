# Soroban Contract Fuzz Testing Guide

This document describes the comprehensive fuzz testing suite for the Price Oracle smart contract, covering critical edge cases, boundary conditions, and concurrent submission scenarios.

## Running Fuzz Tests

```bash
cd contracts/price-oracle
cargo test fuzz_ --lib
```

## Test Coverage

### 1. Price Submission Boundary Tests (`submit_price` function)

#### `fuzz_submit_price_boundary_i128_max`
- **Purpose**: Test maximum i128 value submission
- **Coverage**: Overflow protection at maximum boundary
- **Edge Case**: `i128::MAX` (9,223,372,036,854,775,807)

#### `fuzz_submit_price_boundary_i128_min`
- **Purpose**: Test near-minimum i128 value submission
- **Coverage**: Underflow protection at minimum boundary
- **Edge Case**: `i128::MIN + 1` (-9,223,372,036,854,775,807)

#### `fuzz_submit_price_zero`
- **Purpose**: Test zero price submission
- **Coverage**: Zero value handling (edge case for mathematical operations)
- **Expected Behavior**: Stores and retrieves zero price correctly

#### `fuzz_submit_price_negative`
- **Purpose**: Test negative price submission
- **Coverage**: Negative value handling
- **Edge Case**: Negative prices like -1,000,000

#### `fuzz_submit_price_large_decimals`
- **Purpose**: Test maximum decimal precision
- **Coverage**: Decimal field boundary conditions
- **Edge Case**: `u32::MAX` (4,294,967,295) decimals

### 2. Oracle Source Management Tests (`add_oracle_source` function)

#### `fuzz_add_oracle_source_duplicate_address`
- **Purpose**: Test adding a source that already exists
- **Coverage**: Duplicate address handling
- **Expected Behavior**: Allows readdition of the same source (idempotent)

#### `fuzz_add_oracle_source_same_address_twice`
- **Purpose**: Verify same address can be added twice with different names
- **Coverage**: Source management without blocking duplicates
- **Expected Behavior**: Both additions succeed

### 3. Price History Retrieval Tests (`get_price_history` function)

#### `fuzz_get_price_history_zero_limit`
- **Purpose**: Test retrieval with zero limit parameter
- **Coverage**: Out-of-bounds limit handling (lower bound)
- **Expected Behavior**: Returns empty vector

#### `fuzz_get_price_history_max_limit`
- **Purpose**: Test retrieval with maximum u32 limit
- **Coverage**: Out-of-bounds limit handling (upper bound)
- **Edge Case**: `u32::MAX` (4,294,967,295) limit value
- **Expected Behavior**: Returns all available history (capped at stored entries)

#### `fuzz_get_price_history_limit_exceeds_entries`
- **Purpose**: Test when limit exceeds actual history entries
- **Coverage**: Graceful handling of over-requesting
- **Scenario**: Request 1000 entries but only 5 exist
- **Expected Behavior**: Returns only the 5 available entries

#### `fuzz_get_price_history_limit_one`
- **Purpose**: Test single entry retrieval from large history
- **Coverage**: Boundary case of minimal retrieval
- **Scenario**: 20 entries submitted, limit=1
- **Expected Behavior**: Returns only the latest entry

### 4. Sequential Consistency Tests

#### `fuzz_sequential_price_submissions_consistency`
- **Purpose**: Test multiple price submissions in sequence for consistency
- **Coverage**: 
  - Large positive values
  - Very large positive values (i128::MAX / 2)
  - Negative values
  - Zero values
- **Entries Tested**: 7 different price values
- **Expected Behavior**: All prices stored correctly, latest price matches last submission

### 5. Concurrent Submission Tests

#### `fuzz_multiple_sources_concurrent_submissions`
- **Purpose**: Test concurrent submissions from multiple oracle sources
- **Coverage**: Race conditions and concurrent state modifications
- **Scenario**: Three oracle sources submit prices within 2 timestamp units
- **Expected Behavior**: All three submissions succeed and history contains all 3 entries

### 6. Timestamp Edge Cases

#### `fuzz_price_submission_timestamp_edge_cases`
- **Purpose**: Test timestamp boundary values
- **Coverage**:
  - Zero timestamp (0)
  - Minimal timestamp (1)
  - Mid-range timestamp (u64::MAX / 2)
  - Maximum timestamp (u64::MAX - 1)
- **Expected Behavior**: All timestamps accepted and stored correctly

### 7. Asset Name Validation

#### `fuzz_large_asset_name`
- **Purpose**: Test handling of long asset names
- **Coverage**: String length and encoding edge cases
- **Asset Name**: "VERYLONGASSETNAMETHATSHOULDSTILLWORK123456"
- **Expected Behavior**: Long names accepted and stored correctly

## Vulnerabilities Tested

### Overflow/Underflow Protection
- ✅ i128 maximum boundary testing
- ✅ i128 minimum boundary testing
- ✅ Negative number handling

### Out-of-Bounds Conditions
- ✅ Zero limit parameter (below minimum valid)
- ✅ u32::MAX limit parameter (above practical maximum)
- ✅ Limit exceeding stored entries

### Replay/Duplicate Attack Prevention
- ✅ Duplicate source additions
- ✅ Multiple submissions from same source
- ✅ Concurrent submissions from different sources

### State Consistency
- ✅ Sequential consistency under various price values
- ✅ History ordering and completeness
- ✅ Latest price accuracy after multiple updates

### Type Safety
- ✅ Large decimal values (u32::MAX)
- ✅ Large asset name strings
- ✅ Timestamp boundary values

## Test Execution Time

All fuzz tests execute quickly (< 1 second total), allowing them to run in CI/CD pipelines without performance degradation. The tests do not require external randomization and use deterministic edge cases for reproducible results.

## Adding New Fuzz Tests

When adding new fuzz tests:

1. Create a function prefixed with `fuzz_` for clear identification
2. Add `#[test]` attribute
3. Use `setup_fuzz()` or create a custom environment
4. Test specific boundary conditions or edge cases
5. Include clear assertions for expected behavior
6. Document the test purpose and coverage in comments

Example:
```rust
#[test]
fn fuzz_specific_edge_case() {
    let (env, client, admin, oracle) = setup_fuzz();
    
    // Test implementation
    let result = client.try_submit_price(...);
    assert!(result.is_ok());
}
```

## Continuous Integration

These fuzz tests are integrated into the CI/CD pipeline and run automatically on every commit. All tests must pass before merging to main.
