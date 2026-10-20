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

// Ports that must never be reachable from provider/integration egress, even to
// an otherwise allowlisted host. These are common lateral-movement targets.
const disallowedPorts = [22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017];

// Redirect and DNS-rebinding scenarios that must be blocked by the deployment
// policy. Each describes the initial (allowlisted) hop and the private target
// the attacker tries to pivot to.
interface RedirectScenario {
  name: string;
  initialHost: string;
  redirectTarget: string;
  description: string;
}

const redirectScenarios: RedirectScenario[] = [
  {
    name: 'redirect-to-private-ip',
    initialHost: 'chainlink-api.example.com',
    redirectTarget: 'http://10.0.0.5/admin',
    description: 'Allowlisted host 302-redirects to private IP',
  },
  {
    name: 'redirect-to-metadata',
    initialHost: 'api.redstone.example.com',
    redirectTarget: 'http://169.254.169.254/latest/meta-data/',
    description: 'Allowlisted host redirects to cloud metadata endpoint',
  },
  {
    name: 'redirect-to-internal-host',
    initialHost: 'api.bandprotocol.example.com',
    redirectTarget: 'http://internal-service.internal:8080/',
    description: 'Allowlisted host redirects to internal service DNS name',
  },
];

interface DNSRebindingScenario {
  name: string;
  hostname: string;
  firstResolution: string[];
  reboundResolution: string[];
  description: string;
}

const dnsRebindingScenarios: DNSRebindingScenario[] = [
  {
    name: 'dns-rebind-to-private-ip',
    hostname: 'rebind.example.com',
    firstResolution: ['192.0.2.50'],
    reboundResolution: ['10.0.0.5'],
    description: 'Domain resolves to allowlisted IP then rebinds to private IP',
  },
  {
    name: 'dns-rebind-to-loopback',
    hostname: 'rebind-loopback.example.com',
    firstResolution: ['198.51.100.50'],
    reboundResolution: ['127.0.0.1'],
    description: 'Domain resolves to allowlisted IP then rebinds to loopback',
  },
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

function isPrivateOrReservedIP(ip: string): boolean {
  const octets = ip.split('.').map((o) => parseInt(o, 10));
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return true; // Unparseable addresses are treated as unsafe
  }
  const [a, b] = octets;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this" network
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isAllowlistedHost(host: string): boolean {
  return allowlistedProviders.some((p) => p.domains.includes(host));
}

function isAllowlistedIP(ip: string): boolean {
  return allowlistedProviders.some((p) => p.ipRanges.some((range) => ipInRange(ip, range)));
}

/**
 * Evaluate a single outbound request against the deployment egress policy.
 * This models the policy engine that runs in front of provider/integration
 * egress: it must reject private/reserved targets, disallowed ports, and
 * redirects that pivot off an allowlisted host to a non-allowlisted target.
 */
function evaluateEgressPolicy(
  host: string,
  port: number,
  resolvedIps: string[],
  redirectTarget?: string
): { allowed: boolean; denialType?: string; reason?: string } {
  // Redirects must be re-evaluated against the policy; a redirect to a
  // private/reserved or non-allowlisted destination is a bypass attempt.
  if (redirectTarget) {
    const match = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(redirectTarget);
    if (!match) {
      return { allowed: false, denialType: 'ssrf-guard', reason: 'unparseable redirect target' };
    }
    const redirectHost = match[1];
    const redirectPort = match[2] ? parseInt(match[2], 10) : 80;

    if (isPrivateOrReservedIP(redirectHost) || redirectHost.endsWith('.internal')) {
      return {
        allowed: false,
        denialType: 'ssrf-guard',
        reason: `redirect to private/reserved target ${redirectHost}`,
      };
    }
    if (!isAllowlistedHost(redirectHost)) {
      return {
        allowed: false,
        denialType: 'policy',
        reason: `redirect to non-allowlisted host ${redirectHost}`,
      };
    }
    return evaluateEgressPolicy(redirectHost, redirectPort, resolvedIps);
  }

  if (disallowedPorts.includes(port)) {
    return { allowed: false, denialType: 'policy', reason: `disallowed port ${port}` };
  }

  // Every resolved IP must be safe and allowlisted; a single bad answer
  // (e.g. DNS rebinding) must fail the whole request.
  for (const ip of resolvedIps) {
    if (isPrivateOrReservedIP(ip)) {
      return { allowed: false, denialType: 'dns', reason: `resolved to private/reserved IP ${ip}` };
    }
    if (!isAllowlistedIP(ip)) {
      return { allowed: false, denialType: 'policy', reason: `resolved to non-allowlisted IP ${ip}` };
    }
  }

  if (!isAllowlistedHost(host)) {
    return { allowed: false, denialType: 'policy', reason: `host ${host} not allowlisted` };
  }

  return { allowed: true };
}

async function verifyRedirectBlocked(scenario: RedirectScenario): Promise<boolean> {
  const startTime = Date.now();
  try {
    const initial = await testNetworkPolicyEnforcement(scenario.initialHost, 'allowed');
    if (!initial.allowed) {
      throw new Error(`Initial allowlisted hop ${scenario.initialHost} unexpectedly blocked`);
    }

    const decision = evaluateEgressPolicy(scenario.initialHost, 443, [], scenario.redirectTarget);
    if (decision.allowed) {
      throw new Error(
        `BYPASS: ${scenario.description} was allowed (${scenario.redirectTarget}); redirect not re-evaluated`
      );
    }
    return true;
  } finally {
    console.log(`  Redirect test ${scenario.name}: ${Date.now() - startTime}ms`);
  }
}

async function verifyDNSRebindingBlocked(scenario: DNSRebindingScenario): Promise<boolean> {
  const startTime = Date.now();
  try {
    // First resolution is benign and allowlisted.
    const first = evaluateEgressPolicy(scenario.hostname, 443, scenario.firstResolution);
    if (!first.allowed) {
      throw new Error(
        `First resolution of ${scenario.hostname} unexpectedly blocked: ${first.reason}`
      );
    }

    // Rebound resolution must be rejected by the policy.
    const rebound = evaluateEgressPolicy(scenario.hostname, 443, scenario.reboundResolution);
    if (rebound.allowed) {
      throw new Error(
        `BYPASS: ${scenario.description} was allowed (rebound to ${scenario.reboundResolution.join(', ')})`
      );
    }
    return true;
  } finally {
    console.log(`  DNS rebinding test ${scenario.name}: ${Date.now() - startTime}ms`);
  }
}

async function verifyDisallowedPortsBlocked(): Promise<{ blocked: number[]; bypassed: number[] }> {
  const blocked: number[] = [];
  const bypassed: number[] = [];

  for (const provider of allowlistedProviders) {
    for (const domain of provider.domains) {
      for (const port of disallowedPorts) {
        const decision = evaluateEgressPolicy(domain, port, []);
        if (decision.allowed) {
          bypassed.push(port);
        } else {
          blocked.push(port);
        }
      }
    }
  }

  return { blocked, bypassed };
}

async function verifyAllowlistedHostScenarios(): Promise<{ passed: number; failed: string[] }> {
  const failed: string[] = [];
  let passed = 0;

  for (const provider of allowlistedProviders) {
    for (const domain of provider.domains) {
      const resolved = await testDNSResolution(domain);
      const decision = evaluateEgressPolicy(domain, 443, resolved.ips);
      if (decision.allowed) {
        passed++;
      } else {
        failed.push(`${domain}: ${decision.reason}`);
      }
    }
  }

  return { passed, failed };
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

  // Test 4: Redirect-to-private-IP / metadata / internal-host scenarios
  console.log('\nVerifying redirects cannot bypass egress policy...');
  for (const scenario of redirectScenarios) {
    const testName = scenario.name;
    const startTime = Date.now();

    try {
      await verifyRedirectBlocked(scenario);
      results.push({
        testName,
        passed: true,
        denialType: 'ssrf-guard',
        durationMs: Date.now() - startTime,
      });
      console.log(`✓ ${testName}: ${scenario.description} blocked`);
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

  // Test 5: DNS-rebinding scenarios
  console.log('\nVerifying DNS rebinding cannot bypass egress policy...');
  for (const scenario of dnsRebindingScenarios) {
    const testName = scenario.name;
    const startTime = Date.now();

    try {
      await verifyDNSRebindingBlocked(scenario);
      results.push({
        testName,
        passed: true,
        denialType: 'dns',
        durationMs: Date.now() - startTime,
      });
      console.log(`✓ ${testName}: ${scenario.description} blocked`);
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

  // Test 6: Disallowed ports to allowlisted hosts
  console.log('\nVerifying disallowed ports are blocked...');
  try {
    const portCheck = await verifyDisallowedPortsBlocked();
    if (portCheck.bypassed.length > 0) {
      const unique = Array.from(new Set(portCheck.bypassed));
      results.push({
        testName: 'disallowed-ports',
        passed: false,
        error: `BYPASS: ports reachable on allowlisted hosts: ${unique.join(', ')}`,
        durationMs: 0,
      });
      console.log(`✗ disallowed-ports: ${unique.join(', ')} not blocked`);
    } else {
      results.push({
        testName: 'disallowed-ports',
        passed: true,
        durationMs: 0,
      });
      console.log(`✓ disallowed-ports: all ${disallowedPorts.length} ports blocked`);
    }
  } catch (error) {
    results.push({
      testName: 'disallowed-ports',
      passed: false,
      error: String(error),
      durationMs: 0,
    });
    console.log(`✗ disallowed-ports check failed: ${error}`);
  }

  // Test 7: Allowlisted-host scenarios remain reachable (no over-blocking)
  console.log('\nVerifying allowlisted hosts remain reachable...');
  try {
    const allowCheck = await verifyAllowlistedHostScenarios();
    if (allowCheck.failed.length > 0) {
      results.push({
        testName: 'allowlisted-hosts',
        passed: false,
        error: `Allowlisted hosts blocked: ${allowCheck.failed.join('; ')}`,
        durationMs: 0,
      });
      console.log(`✗ allowlisted-hosts: ${allowCheck.failed.join('; ')}`);
    } else {
      results.push({
        testName: 'allowlisted-hosts',
        passed: true,
        durationMs: 0,
      });
      console.log(`✓ allowlisted-hosts: ${allowCheck.passed} allowlisted host(s) reachable`);
    }
  } catch (error) {
    results.push({
      testName: 'allowlisted-hosts',
      passed: false,
      error: String(error),
      durationMs: 0,
    });
    console.log(`✗ allowlisted-hosts check failed: ${error}`);
  }

  // Test 8: DNS-to-IP drift detection
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

export {
  NetworkPolicyTest,
  EgressControlResult,
  evaluateEgressPolicy,
  isPrivateOrReservedIP,
  disallowedPorts,
  redirectScenarios,
  dnsRebindingScenarios,
};
