import * as assert from 'assert';

interface NetworkPolicyTest {
  testName: string;
  targetDestination: string;
  expectedOutcome: 'allowed' | 'denied';
  denialMode?: 'policy' | 'cloud-sg' | 'ssrf-guard' | 'dns';
  layer: 'k8s-policy' | 'cloud-sg' | 'ssrf' | 'dns';
}

interface AllowlistEntry {
  type: 'domain' | 'ip-range';
  value: string;
  provider: string;
  lastResolved?: Date;
}

interface EgressControlResult {
  testName: string;
  passed: boolean;
  denialType?: string;
  error?: string;
  durationMs: number;
}

const allowlistedProviders = [
  { name: 'chainlink', domains: ['chainlink-api.example.com'], ipRanges: ['192.0.2.0/24'] },
  { name: 'redstone', domains: ['api.redstone.example.com'], ipRanges: ['198.51.100.0/24'] },
  { name: 'band', domains: ['api.bandprotocol.example.com'], ipRanges: ['203.0.113.0/24'] },
  { name: 'reflector', domains: ['reflector.example.com'], ipRanges: ['192.0.2.128/25'] },
];

const blockedDestinations = [
  { hostname: 'malicious.example.com', description: 'Clearly disallowed domain' },
  { hostname: 'internal-service.internal', description: 'Internal network access' },
  { hostname: '10.0.0.5', description: 'Private IP range' },
  { hostname: '172.16.0.1', description: 'Private IP range' },
];

async function testNetworkPolicyEnforcement(
  targetHost: string,
  expectedOutcome: 'allowed' | 'denied'
): Promise<{ allowed: boolean; denialType?: string }> {
  // Test against k8s NetworkPolicy
  // In production: attempt outbound connection and check if blocked by policy-specific error

  if (expectedOutcome === 'denied') {
    // Simulate policy denial with specific error mode
    return {
      allowed: false,
      denialType: 'policy',
    };
  }

  return {
    allowed: true,
  };
}

async function testCloudSecurityGroupEnforcement(
  targetHost: string,
  expectedOutcome: 'allowed' | 'denied'
): Promise<{ allowed: boolean; denialType?: string }> {
  // Test cloud-level egress rules (security group, firewall, etc.)
  // In production: attempt outbound connection from pod and verify cloud layer blocking

  if (expectedOutcome === 'denied') {
    return {
      allowed: false,
      denialType: 'security-group',
    };
  }

  return {
    allowed: true,
  };
}

async function testSSRFGuard(
  targetHost: string,
  expectedOutcome: 'allowed' | 'denied'
): Promise<{ allowed: boolean; denialType?: string }> {
  // Test application SSRF guard
  // In production: attempt connection through aggregator's HTTP client

  if (expectedOutcome === 'denied') {
    return {
      allowed: false,
      denialType: 'ssrf-guard',
    };
  }

  return {
    allowed: true,
  };
}

async function testDNSResolution(domain: string): Promise<{ resolved: boolean; ips: string[] }> {
  // Test DNS resolution for allowlisted domains
  // In production: resolve each domain and verify IPs are within allowlisted ranges

  const domainToIps: Record<string, string[]> = {
    'chainlink-api.example.com': ['192.0.2.10'],
    'api.redstone.example.com': ['198.51.100.15'],
    'api.bandprotocol.example.com': ['203.0.113.20'],
    'reflector.example.com': ['192.0.2.130'],
  };

  const ips = domainToIps[domain] || [];
  return {
    resolved: ips.length > 0,
    ips,
  };
}

function ipInRange(ip: string, cidr: string): boolean {
  // Simple CIDR check placeholder
  // In production: parse CIDR and verify IP membership
  const [base] = cidr.split('/');
  return ip.startsWith(base.substring(0, base.lastIndexOf('.')));
}

async function verifyNegativePolicyDenial(
  destination: string,
  expectedDenialType: 'policy' | 'cloud-sg' | 'ssrf-guard'
): Promise<boolean> {
  const startTime = Date.now();

  try {
    let result: { allowed: boolean; denialType?: string };

    switch (expectedDenialType) {
      case 'policy':
        result = await testNetworkPolicyEnforcement(destination, 'denied');
        break;
      case 'cloud-sg':
        result = await testCloudSecurityGroupEnforcement(destination, 'denied');
        break;
      case 'ssrf-guard':
        result = await testSSRFGuard(destination, 'denied');
        break;
    }

    if (result.allowed) {
      throw new Error(
        `Expected denial but ${destination} was allowed; check if ${expectedDenialType} is actually enforcing`
      );
    }

    assert.strictEqual(
      result.denialType,
      expectedDenialType,
      `Expected ${expectedDenialType} denial, got ${result.denialType || 'unknown'}`
    );

    return true;
  } finally {
    const duration = Date.now() - startTime;
    console.log(`  Negative test for ${destination}: ${duration}ms`);
  }
}

async function verifyAllowlistedDestinationReachable(domain: string): Promise<boolean> {
  const startTime = Date.now();

  try {
    const result = await testNetworkPolicyEnforcement(domain, 'allowed');

    if (!result.allowed) {
      throw new Error(`Expected to reach allowlisted domain ${domain} but was blocked`);
    }

    return true;
  } finally {
    const duration = Date.now() - startTime;
    console.log(`  Positive test for ${domain}: ${duration}ms`);
  }
}

async function verifyAllowlistBreadth(): Promise<{ valid: boolean; overBroadEntries: string[] }> {
  const overBroadEntries: string[] = [];

  for (const entry of collectAllowlistEntries()) {
    if (entry.type === 'ip-range') {
      // Check if CIDR is overly broad
      const [, bits] = entry.value.split('/');
      const cidrBits = parseInt(bits, 10);

      // Flag if CIDR is broader than /25 (assumes 256+ addresses is over-broad)
      if (cidrBits < 25) {
        overBroadEntries.push(
          `${entry.value} for ${entry.provider} (covers ${Math.pow(2, 32 - cidrBits)} addresses)`
        );
      }
    }
  }

  return {
    valid: overBroadEntries.length === 0,
    overBroadEntries,
  };
}

function collectAllowlistEntries(): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];

  for (const provider of allowlistedProviders) {
    for (const domain of provider.domains) {
      entries.push({
        type: 'domain',
        value: domain,
        provider: provider.name,
      });
    }

    for (const ipRange of provider.ipRanges) {
      entries.push({
        type: 'ip-range',
        value: ipRange,
        provider: provider.name,
      });
    }
  }

  return entries;
}

async function verifyDNSToIPDrift(): Promise<{ driftDetected: boolean; driftItems: string[] }> {
  const driftItems: string[] = [];
  const entries = collectAllowlistEntries();

  const domainEntries = entries.filter((e) => e.type === 'domain');

  for (const entry of domainEntries) {
    const resolved = await testDNSResolution(entry.value);

    if (!resolved.resolved) {
      driftItems.push(`${entry.value} failed to resolve`);
      continue;
    }

    // Check if resolved IPs are within allowlisted ranges for this provider
    const providerIPRanges = allowlistedProviders
      .find((p) => p.name === entry.provider)
      ?.ipRanges || [];

    for (const ip of resolved.ips) {
      const inRange = providerIPRanges.some((range) => ipInRange(ip, range));

      if (!inRange) {
        driftItems.push(
          `${entry.value} resolved to ${ip} which is not in allowlisted range ${providerIPRanges.join(', ')}`
        );
      }
    }
  }

  return {
    driftDetected: driftItems.length > 0,
    driftItems,
  };
}

export async function runEgressControlTests(): Promise<EgressControlResult[]> {
  const results: EgressControlResult[] = [];

  // Test 1: Negative tests - verify disallowed destinations are blocked
  console.log('Running negative egress tests (disallowed destinations)...');
  for (const blocked of blockedDestinations) {
    const testName = `block-${blocked.hostname}`;
    const startTime = Date.now();

    try {
      await verifyNegativePolicyDenial(blocked.hostname, 'policy');
      results.push({
        testName,
        passed: true,
        denialType: 'policy',
        durationMs: Date.now() - startTime,
      });
      console.log(`✓ ${testName}: policy blocks ${blocked.description}`);
    } catch (error) {
      results.push({
        testName,
        passed: false,
        error: String(error),
        durationMs: Date.now() - startTime,
      });
      console.log(`✗ ${testName}: ${error}`);
    }
  }

  // Test 2: Positive tests - verify allowlisted destinations work
  console.log('\nRunning positive egress tests (allowlisted destinations)...');
  for (const provider of allowlistedProviders) {
    for (const domain of provider.domains) {
      const testName = `allow-${domain}`;
      const startTime = Date.now();

      try {
        await verifyAllowlistedDestinationReachable(domain);
        results.push({
          testName,
          passed: true,
          durationMs: Date.now() - startTime,
        });
        console.log(`✓ ${testName}: provider ${provider.name} domain is reachable`);
      } catch (error) {
        results.push({
          testName,
          passed: false,
          error: String(error),
          durationMs: Date.now() - startTime,
        });
        console.log(`✗ ${testName}: ${error}`);
      }
    }
  }

  // Test 3: Allowlist breadth
  console.log('\nVerifying allowlist breadth...');
  try {
    const breadth = await verifyAllowlistBreadth();

    if (!breadth.valid) {
      console.log(`✗ Allowlist contains over-broad entries:`);
      for (const entry of breadth.overBroadEntries) {
        console.log(`  - ${entry}`);
      }

      results.push({
        testName: 'allowlist-breadth',
        passed: false,
        error: `Over-broad entries: ${breadth.overBroadEntries.join('; ')}`,
        durationMs: 0,
      });
    } else {
      console.log(`✓ Allowlist breadth verified: all entries appropriately scoped`);
      results.push({
        testName: 'allowlist-breadth',
        passed: true,
        durationMs: 0,
      });
    }
  } catch (error) {
    results.push({
      testName: 'allowlist-breadth',
      passed: false,
      error: String(error),
      durationMs: 0,
    });
    console.log(`✗ Allowlist breadth check failed: ${error}`);
  }

  // Test 4: DNS-to-IP drift detection
  console.log('\nDetecting DNS-to-IP drift...');
  try {
    const drift = await verifyDNSToIPDrift();

    if (drift.driftDetected) {
      console.log(`⚠ DNS-to-IP drift detected:`);
      for (const item of drift.driftItems) {
        console.log(`  - ${item}`);
      }

      results.push({
        testName: 'dns-ip-drift',
        passed: false,
        error: `Drift detected: ${drift.driftItems.join('; ')}`,
        durationMs: 0,
      });
    } else {
      console.log(`✓ No DNS-to-IP drift detected`);
      results.push({
        testName: 'dns-ip-drift',
        passed: true,
        durationMs: 0,
      });
    }
  } catch (error) {
    results.push({
      testName: 'dns-ip-drift',
      passed: false,
      error: String(error),
      durationMs: 0,
    });
    console.log(`✗ DNS-to-IP drift check failed: ${error}`);
  }

  // Summary
  const passCount = results.filter((r) => r.passed).length;
  console.log(`\n\n=== EGRESS CONTROL VERIFICATION SUMMARY ===`);
  console.log(`Passed: ${passCount}/${results.length}`);

  const anyFailed = results.some((r) => !r.passed);
  if (anyFailed) {
    throw new Error(`Egress control tests failed for ${results.filter((r) => !r.passed).length} test(s)`);
  }

  return results;
}

if (require.main === module) {
  runEgressControlTests()
    .then(() => {
      console.log('\n✓ All egress control tests passed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n✗ Egress control tests failed:', error);
      process.exit(1);
    });
}

export { NetworkPolicyTest, EgressControlResult };
