fn pow10(n: u32) -> Option<i128> {
    if n > 38 { return None; }
    10_i128.checked_pow(n)
}

fn convert(amount: i128, amount_decimals: u32, rate: i128, rate_decimals: u32, output_decimals: u32) -> Option<i128> {
    let exponent = output_decimals as i64 - amount_decimals as i64 - rate_decimals as i64;
    let mut numerator = amount.checked_mul(rate)?;
    let denominator;
    if exponent >= 0 {
        numerator = numerator.checked_mul(pow10(exponent as u32)?)?;
        denominator = 1;
    } else {
        denominator = pow10((-exponent) as u32)?;
    }
    let quotient = numerator.checked_div(denominator)?;
    let remainder = numerator.checked_rem(denominator)?;
    if remainder != 0 && remainder.unsigned_abs() >= (denominator as u128 + 1) / 2 {
        quotient.checked_add(if numerator < 0 { -1 } else { 1 })
    } else {
        Some(quotient)
    }
}

#[test]
fn shared_price_arithmetic_vectors_match_and_overflow_is_rejected() {
    let vectors = include_str!("../../../verification/fixtures/price-arithmetic-vectors.tsv");
    for line in vectors.lines().filter(|line| !line.is_empty() && !line.starts_with('#')) {
        let fields: std::vec::Vec<&str> = line.split_whitespace().collect();
        let actual = convert(fields[1].parse().unwrap(), fields[2].parse().unwrap(), fields[3].parse().unwrap(), fields[4].parse().unwrap(), fields[5].parse().unwrap());
        assert_eq!(actual, Some(fields[6].parse().unwrap()), "vector {}", fields[0]);
    }
    assert_eq!(convert(i128::MAX, 0, 10, 0, 1), None);
    assert_eq!(pow10(39), None);
}
